/**
 * The single-writer lock, against a real Postgres.
 *
 * This suite is deliberately not unit tests. The entire correctness argument for `acquire` is
 * that ONE `INSERT ... ON CONFLICT DO UPDATE ... WHERE` statement lets the database decide,
 * under the row lock it already holds, whether the lock was free. A stubbed pool would assert
 * that this file contains the SQL this file contains, and would have caught none of the bugs
 * that actually occurred here — the `excluded`-in-RETURNING 42P01, or a same-holder acquire
 * being (correctly) a renewal, which is what made the lock fail to block anything in the app.
 *
 * Timing here uses POSTGRES's clock throughout, never the test process's, for the same reason
 * the implementation does.
 */
import { afterAll, beforeEach, expect, it } from 'vitest';

import { LockManager, NotHolderError, type EventSink } from '../src/core/lock.js';
import { closePool, getPool } from '../src/db/pool.js';
import { describeIfDb, deleteLocksLike, uniqueId, withClient } from './helpers/db.js';

const PREFIX = uniqueId('lock');
const SCOPE = PREFIX;

// `agentId?: string | undefined`, not `agentId?: string`: under exactOptionalPropertyTypes
// those are different types, and the sink genuinely may hand over an absent agent.
interface Emitted { kind: string; agentId?: string | undefined; payload: Record<string, unknown> }

function manager(): { lm: LockManager; events: Emitted[] } {
  const events: Emitted[] = [];
  const sink: EventSink = async (e) => { events.push({ kind: e.kind, agentId: e.agentId, payload: e.payload }); };
  return { lm: new LockManager(getPool(), sink), events };
}

/** Push a lock's expiry into the past without waiting for it, using the database's clock. */
async function expire(resourceId: string): Promise<void> {
  await withClient((c) => c.query(
    `UPDATE locks SET expires_at = now() - INTERVAL '1 second' WHERE resource_id = $1 AND scope = $2`,
    [resourceId, SCOPE],
  ));
}

describeIfDb('LockManager (real Postgres)', () => {
  beforeEach(async () => { await deleteLocksLike(PREFIX); });
  afterAll(async () => { await deleteLocksLike(PREFIX); await closePool(); });

  it('grants a free lock and reports it as no takeover', async () => {
    const { lm, events } = manager();
    const r = `${PREFIX}:a`;
    const got = await lm.acquire(r, 'agent-1', { scope: SCOPE, ttlSec: 60 });

    expect(got.ok).toBe(true);
    expect(got.ok && got.lock.holder).toBe('agent-1');
    expect(got.ok && got.tookOverExpired).toBe(false);
    expect(events.map((e) => e.kind)).toEqual(['lock_acquired']);
  });

  it('refuses a second holder and names who has it', async () => {
    const { lm } = manager();
    const r = `${PREFIX}:b`;
    await lm.acquire(r, 'agent-1', { scope: SCOPE, ttlSec: 60 });
    const second = await lm.acquire(r, 'agent-2', { scope: SCOPE, ttlSec: 60 });

    expect(second.ok).toBe(false);
    expect(second.ok === false && second.heldBy).toBe('agent-1');
    // A loser that is not told when to come back can only busy-wait.
    expect(second.ok === false && second.availableInSec).toBeGreaterThan(0);
  });

  it('records contention as an event, so a refusal is visible afterwards', async () => {
    const { lm, events } = manager();
    const r = `${PREFIX}:c`;
    await lm.acquire(r, 'agent-1', { scope: SCOPE, ttlSec: 60 });
    await lm.acquire(r, 'agent-2', { scope: SCOPE, ttlSec: 60 });

    const contended = events.find((e) => e.kind === 'lock_contended');
    expect(contended).toBeDefined();
    expect(contended?.payload).toMatchObject({ heldBy: 'agent-1', wanted: 'agent-2' });
  });

  it('treats the SAME holder re-acquiring as a renewal, not a takeover', async () => {
    /*
     * This is correct behaviour and it is also the bug that made the lock useless in the app:
     * the holder was keyed on the browser's user-agent, so two simultaneous requests from one
     * browser had an identical holder, both "renewed", and both wrote to Zerops. The fix was
     * upstream — a per-request holder — not here. Pinned so nobody "fixes" the renewal.
     */
    const { lm } = manager();
    const r = `${PREFIX}:d`;
    const first = await lm.acquire(r, 'same', { scope: SCOPE, ttlSec: 60 });
    const again = await lm.acquire(r, 'same', { scope: SCOPE, ttlSec: 120 });

    expect(again.ok).toBe(true);
    expect(again.ok && again.tookOverExpired).toBe(false);
    // A renewal must actually extend the lease, or a long job dies holding nothing.
    expect(again.ok && first.ok && again.lock.expiresAt.getTime()).toBeGreaterThan(
      first.ok ? first.lock.expiresAt.getTime() : 0,
    );
  });

  it('lets an EXPIRED lock be taken over, and says whose it was', async () => {
    const { lm } = manager();
    const r = `${PREFIX}:e`;
    await lm.acquire(r, 'dead-container', { scope: SCOPE, ttlSec: 60 });
    await expire(r);

    const got = await lm.acquire(r, 'agent-2', { scope: SCOPE, ttlSec: 60 });
    expect(got.ok).toBe(true);
    expect(got.ok && got.tookOverExpired).toBe(true);
  });

  it('reports an expired lock as free, matching what acquire would do', async () => {
    const { lm } = manager();
    const r = `${PREFIX}:f`;
    await lm.acquire(r, 'agent-1', { scope: SCOPE, ttlSec: 60 });
    expect(await lm.status(r, SCOPE)).not.toBeNull();

    await expire(r);
    // If status said "held" while acquire would grant it, a poller would wait forever on a
    // container that no longer exists.
    expect(await lm.status(r, SCOPE)).toBeNull();
  });

  it('releases only your own lock', async () => {
    const { lm } = manager();
    const r = `${PREFIX}:g`;
    await lm.acquire(r, 'agent-1', { scope: SCOPE, ttlSec: 60 });

    expect(await lm.release(r, 'agent-2', SCOPE)).toBe(false);
    expect(await lm.status(r, SCOPE)).not.toBeNull();
    expect(await lm.release(r, 'agent-1', SCOPE)).toBe(true);
    expect(await lm.status(r, SCOPE)).toBeNull();
  });

  it('does not let a superseded holder release the new holder\'s lock', async () => {
    // The `holder = $3` predicate in the DELETE. Without it, an agent whose lock expired and
    // was taken over would free a lock somebody else is actively writing under.
    const { lm } = manager();
    const r = `${PREFIX}:h`;
    await lm.acquire(r, 'old', { scope: SCOPE, ttlSec: 60 });
    await expire(r);
    await lm.acquire(r, 'new', { scope: SCOPE, ttlSec: 60 });

    expect(await lm.release(r, 'old', SCOPE)).toBe(false);
    expect((await lm.status(r, SCOPE))?.holder).toBe('new');
  });

  it('lists live locks in a scope and omits expired ones', async () => {
    const { lm } = manager();
    await lm.acquire(`${PREFIX}:i1`, 'a', { scope: SCOPE, ttlSec: 60 });
    await lm.acquire(`${PREFIX}:i2`, 'b', { scope: SCOPE, ttlSec: 60 });
    await expire(`${PREFIX}:i2`);

    const live = await lm.list(SCOPE);
    expect(live.map((l) => l.resourceId)).toEqual([`${PREFIX}:i1`]);
  });

  it('keeps scopes independent', async () => {
    const { lm } = manager();
    const r = `${PREFIX}:j`;
    await lm.acquire(r, 'agent-1', { scope: SCOPE, ttlSec: 60 });
    const other = await lm.acquire(r, 'agent-2', { scope: `${SCOPE}:other`, ttlSec: 60 });
    expect(other.ok).toBe(true);
    await lm.release(r, 'agent-2', `${SCOPE}:other`);
  });

  it('assertHolder throws NotHolderError naming the real holder', async () => {
    const { lm } = manager();
    const r = `${PREFIX}:k`;
    await lm.acquire(r, 'agent-1', { scope: SCOPE, ttlSec: 60 });

    await expect(lm.assertHolder(r, 'agent-1', SCOPE)).resolves.toBeUndefined();
    await expect(lm.assertHolder(r, 'agent-2', SCOPE)).rejects.toThrow(NotHolderError);
    await lm.assertHolder(r, 'agent-2', SCOPE).catch((e: unknown) => {
      expect((e as NotHolderError).holder).toBe('agent-1');
    });
  });

  it('assertHolder reports "nobody" distinctly from "someone else"', async () => {
    const { lm } = manager();
    await lm.assertHolder(`${PREFIX}:free`, 'agent-1', SCOPE).catch((e: unknown) => {
      expect((e as NotHolderError).holder).toBeNull();
      expect((e as Error).message).toMatch(/no agent holds the lock/);
    });
  });

  it('clamps a silly TTL instead of accepting it', async () => {
    const { lm } = manager();
    const r = `${PREFIX}:ttl`;
    const got = await lm.acquire(r, 'agent-1', { scope: SCOPE, ttlSec: 999_999 });
    expect(got.ok).toBe(true);
    // Capped at an hour: a lock nobody can outlive is a wedged resource.
    const heldFor = got.ok ? got.lock.expiresAt.getTime() - got.lock.acquiredAt.getTime() : 0;
    expect(heldFor).toBeLessThanOrEqual(3600 * 1000 + 2000);
  });

  it('gives exactly ONE winner when twenty callers race for the same lock', async () => {
    /*
     * The reason this component exists. Twenty concurrent acquires, all issued before any of
     * them resolves, against one row. A read-modify-write would let several through; the
     * single-statement compare-and-swap cannot.
     */
    const { lm } = manager();
    const r = `${PREFIX}:race`;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => lm.acquire(r, `agent-${i}`, { scope: SCOPE, ttlSec: 60 })),
    );

    const winners = results.filter((x) => x.ok);
    expect(winners).toHaveLength(1);

    // And everybody who lost was told the same, correct name.
    const winner = winners[0];
    const winnerHolder = winner !== undefined && winner.ok ? winner.lock.holder : '';
    const losers = results.filter((x) => !x.ok);
    expect(losers).toHaveLength(19);
    expect(new Set(losers.map((l) => (l.ok ? '' : l.heldBy)))).toEqual(new Set([winnerHolder]));
  });

  it('serialises a race between two DIFFERENT resources without blocking either', async () => {
    const { lm } = manager();
    const [a, b] = await Promise.all([
      lm.acquire(`${PREFIX}:m1`, 'agent-1', { scope: SCOPE, ttlSec: 60 }),
      lm.acquire(`${PREFIX}:m2`, 'agent-2', { scope: SCOPE, ttlSec: 60 }),
    ]);
    expect(a.ok && b.ok).toBe(true);
  });
});
