/**
 * The append-only event log, against a real Postgres.
 *
 * Two claims in `src/db/events.ts` are load-bearing and neither can be checked without a
 * database:
 *
 *   1. `record` NEVER throws. A provision Zerops already accepted still happened; failing the
 *      request because the diary could not be written would be strictly worse than losing the
 *      diary entry. So it reports whether it persisted and the caller says so honestly.
 *   2. `read` never returns `[]` for "could not look". An empty history and an unreachable
 *      database are opposite facts, and conflating them reports a project as untouched exactly
 *      when we cannot see what was done to it.
 *
 * Claim 1 is tested by pointing the pool at a port with nothing on it — a real failure, not a
 * thrown fake — using the `setPoolForTests` seam the pool already exposes.
 *
 * NOTHING HERE DELETES A ROW. The log is append-only and says so; a test that tidied up after
 * itself would make that false. Each run uses its own scope instead.
 */
import { afterAll, expect, it } from 'vitest';
import pg from 'pg';

import { read, record, stats, unresolvedDrift } from '../src/db/events.js';
import { closePool, setPoolForTests } from '../src/db/pool.js';
import { describeIfDb, uniqueId } from './helpers/db.js';

const SCOPE = uniqueId('events');

describeIfDb('event log (real Postgres)', () => {
  afterAll(async () => { setPoolForTests(undefined); await closePool(); });

  it('round-trips an event', async () => {
    const wrote = await record({ kind: 'session_opened', scope: SCOPE, actor: 'test', payload: { email: 'a@b.c', projects: 2 } });
    expect(wrote.persisted).toBe(true);

    const got = await read({ scope: SCOPE });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: 'session_opened', scope: SCOPE, actor: 'test' });
    expect(got[0]?.payload).toEqual({ email: 'a@b.c', projects: 2 });
  });

  it('defaults the actor to the UI rather than leaving it null', async () => {
    await record({ kind: 'graph_read', scope: SCOPE, payload: {} });
    const got = await read({ scope: SCOPE, kinds: ['graph_read'] });
    expect(got[0]?.actor).toBe('ui');
  });

  it('returns an id that is a string, because a bigint does not fit a JS number', async () => {
    const wrote = await record({ kind: 'graph_read', scope: SCOPE, payload: {} });
    expect(wrote.persisted && typeof wrote.id).toBe('string');
  });

  it('reads newest first, and a LIMIT drops the OLDEST', async () => {
    const s = `${SCOPE}:order`;
    for (const n of [1, 2, 3]) await record({ kind: 'repo_scanned', scope: s, payload: { n, scanned: ['package.json'], missing: [] } });

    const all = await read({ scope: s });
    expect(all.map((e) => e.payload['n'])).toEqual([3, 2, 1]);

    // A truncated history that hides the most recent events is worse than useless.
    const limited = await read({ scope: s, limit: 2 });
    expect(limited.map((e) => e.payload['n'])).toEqual([3, 2]);
  });

  it('filters by kind', async () => {
    const s = `${SCOPE}:kinds`;
    await record({ kind: 'repo_scanned', scope: s, payload: { scanned: [], missing: [] } });
    await record({ kind: 'yaml_exported', scope: s, payload: {} });

    const got = await read({ scope: s, kinds: ['yaml_exported'] });
    expect(got.map((e) => e.kind)).toEqual(['yaml_exported']);
  });

  it('treats an EMPTY kinds array as matching nothing, not everything', async () => {
    // `kind = ANY(ARRAY[])` is the honest reading of "none of these kinds". Callers who want
    // no filter omit the option; silently widening an empty filter to "all" would be a
    // surprising way to leak other events into a view.
    const s = `${SCOPE}:emptykinds`;
    await record({ kind: 'repo_scanned', scope: s, payload: { scanned: [], missing: [] } });
    expect(await read({ scope: s, kinds: [] })).toEqual([]);
  });

  it('clamps an absurd limit instead of trying to serve it', async () => {
    await expect(read({ scope: SCOPE, limit: 10_000_000 })).resolves.toBeInstanceOf(Array);
    await expect(read({ scope: SCOPE, limit: -5 })).resolves.toBeInstanceOf(Array);
  });

  it('keeps scopes apart', async () => {
    const mine = `${SCOPE}:mine`;
    await record({ kind: 'graph_read', scope: mine, payload: {} });
    const other = await read({ scope: `${SCOPE}:not-mine` });
    expect(other).toEqual([]);
  });

  it('counts by kind with the most recent group first', async () => {
    const s = `${SCOPE}:stats`;
    await record({ kind: 'repo_scanned', scope: s, payload: { scanned: [], missing: [] } });
    await record({ kind: 'repo_scanned', scope: s, payload: { scanned: [], missing: [] } });
    await record({ kind: 'yaml_exported', scope: s, payload: {} });

    const byKind = await stats(s);
    expect(byKind.find((k) => k.kind === 'repo_scanned')?.count).toBe(2);
    expect(byKind.find((k) => k.kind === 'yaml_exported')?.count).toBe(1);
  });

  it('answers the one question a live view cannot: how many scans has this been missing', async () => {
    /*
     * The whole justification for keeping a database. "postgresql is missing" is a live fact;
     * "postgresql has been missing across three scans since Tuesday" requires having written
     * the earlier ones down.
     */
    const s = `${SCOPE}:drift`;
    await record({ kind: 'repo_scanned', scope: s, payload: { scanned: ['package.json'], missing: ['postgresql', 'qdrant'] } });
    await record({ kind: 'repo_scanned', scope: s, payload: { scanned: ['package.json'], missing: ['postgresql'] } });
    await record({ kind: 'repo_scanned', scope: s, payload: { scanned: ['package.json'], missing: ['postgresql'] } });

    const streaks = await unresolvedDrift(s);
    expect(streaks.find((d) => d.type === 'postgresql')?.scans).toBe(3);
    expect(streaks.find((d) => d.type === 'qdrant')?.scans).toBe(1);
    // Ordered by persistence, so the longest-standing gap leads.
    expect(streaks[0]?.type).toBe('postgresql');
  });

  it('survives a scan payload with no missing key at all', async () => {
    // COALESCE in the LATERAL join. An older row without the field must not abort the query
    // for every other row.
    const s = `${SCOPE}:nomissing`;
    await record({ kind: 'repo_scanned', scope: s, payload: { scanned: ['package.json'] } });
    await expect(unresolvedDrift(s)).resolves.toEqual([]);
  });

  it('ignores other event kinds when counting drift', async () => {
    const s = `${SCOPE}:onlyscans`;
    await record({ kind: 'provision_failed', scope: s, payload: { missing: ['postgresql'] } });
    expect(await unresolvedDrift(s)).toEqual([]);
  });

  it('records an account-level event with no scope', async () => {
    /*
     * This is the test that found the bug. `scope` was NOT NULL on any database created before
     * the column was relaxed, so every `session_opened` and `session_closed` was rejected — and
     * `record` swallows its own failures, so nothing ever surfaced it. Not one session event
     * had been written for the life of the app.
     */
    const wrote = await record({ kind: 'session_closed', payload: { reason: 'test' } });
    expect(wrote.persisted).toBe(true);
  });

  it('excludes account-level events from a strictly scoped read', async () => {
    const s = `${SCOPE}:strict`;
    await record({ kind: 'session_opened', payload: { email: 'a@b.c' } });
    await record({ kind: 'graph_read', scope: s, payload: {} });

    const strict = await read({ scope: s });
    expect(strict.map((e) => e.kind)).toEqual(['graph_read']);
  });

  it('includes them when the caller asks, because they are the context for the rest', async () => {
    const s = `${SCOPE}:withaccount`;
    await record({ kind: 'session_opened', payload: { email: 'ctx@example.test' } });
    await record({ kind: 'graph_read', scope: s, payload: {} });

    const kinds = (await read({ scope: s, includeAccountLevel: true })).map((e) => e.kind);
    expect(kinds).toContain('graph_read');
    expect(kinds).toContain('session_opened');
  });

  it('counts account-level events in stats only when asked', async () => {
    const s = `${SCOPE}:statsaccount`;
    await record({ kind: 'graph_read', scope: s, payload: {} });
    await record({ kind: 'session_opened', payload: {} });

    const strict = await stats(s);
    expect(strict.some((k) => k.kind === 'session_opened')).toBe(false);

    const withAccount = await stats(s, { includeAccountLevel: true });
    expect(withAccount.some((k) => k.kind === 'session_opened')).toBe(true);
  });
});

describeIfDb('when the database is gone', () => {
  afterAll(async () => { setPoolForTests(undefined); });

  it('record REPORTS the failure instead of throwing it', async () => {
    // Nothing is listening on this port. A real connection failure, not a thrown stub.
    setPoolForTests(new pg.Pool({ connectionString: 'postgresql://nobody@127.0.0.1:1/none', connectionTimeoutMillis: 400 }));

    const wrote = await record({ kind: 'provision_succeeded', scope: SCOPE, payload: {} });
    expect(wrote.persisted).toBe(false);
    expect(wrote.persisted === false && wrote.reason).toBeTruthy();
  });

  it('read THROWS rather than reporting an empty history', async () => {
    setPoolForTests(new pg.Pool({ connectionString: 'postgresql://nobody@127.0.0.1:1/none', connectionTimeoutMillis: 400 }));
    // "Nothing has happened here" and "I could not look" are opposite answers.
    await expect(read({ scope: SCOPE })).rejects.toThrow();
  });
});
