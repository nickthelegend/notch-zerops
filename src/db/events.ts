/**
 * The event log — what Brain actually did, kept in Postgres.
 *
 * This is what makes the app more than a live view. A live view forgets: close the tab and
 * you lose the fact that `qdrant` has been flagged missing three days running, or that
 * somebody already provisioned Postgres into this project last week and then deleted it. The
 * interesting questions about infrastructure are historical.
 *
 * Append-only, and that is not decoration. Every row records something that HAPPENED --
 * a scan that found three gaps, an import Zerops accepted. Editing one would be editing the
 * past; a correction is a new row. There is no UPDATE or DELETE against `brain_events`
 * anywhere in this codebase.
 *
 * WRITING A RECORD MUST NEVER BREAK THE THING IT RECORDS. If the database is down, a
 * provision that Zerops already accepted still happened, and failing the request because we
 * could not write the diary would be strictly worse than losing the diary entry. So `record`
 * swallows its own failure and returns whether it persisted -- the caller reports that
 * honestly rather than pretending the write succeeded.
 */
import { StoreUnreachable, withClient } from './pool.js';

/**
 * Every kind of event this app emits. A closed union rather than free strings, so the
 * timeline cannot fill with typos that look like new event types.
 */
export const EVENT_KINDS = [
  'session_opened',
  'session_closed',
  'graph_read',
  'repo_scanned',
  'provision_planned',
  'provision_started',
  'provision_succeeded',
  'provision_failed',
  'provision_blocked',
  'yaml_exported',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface NewEvent {
  kind: EventKind;
  /** Zerops project id. `null` for account-level events. */
  scope?: string | null;
  /** `ui` for a human clicking, or a name for anything automated. */
  actor?: string;
  payload?: Record<string, unknown>;
}

export interface BrainEvent {
  id: string;
  ts: string;
  scope: string | null;
  kind: string;
  actor: string | null;
  payload: Record<string, unknown>;
}

export type RecordResult =
  | { persisted: true; id: string }
  /** The action still happened. Only the record of it did not. */
  | { persisted: false; reason: string };

const INSERT = `
  INSERT INTO brain_events (scope, kind, actor, payload)
  VALUES ($1, $2, $3, $4::JSONB)
  RETURNING id, ts
`;

/**
 * Append one event.
 *
 * Never throws. See the file header: the log is a witness, not a gatekeeper.
 */
export async function record(e: NewEvent): Promise<RecordResult> {
  try {
    const res = await withClient((c) =>
      c.query<{ id: string }>(INSERT, [
        e.scope ?? null,
        e.kind,
        e.actor ?? 'ui',
        JSON.stringify(e.payload ?? {}),
      ]));
    const row = res.rows[0];
    if (row === undefined) return { persisted: false, reason: 'INSERT ... RETURNING produced no row' };
    return { persisted: true, id: row.id };
  } catch (err) {
    const reason = StoreUnreachable.is(err)
      ? `the event store is unreachable (${err.message})`
      : err instanceof Error ? err.message : String(err);
    return { persisted: false, reason };
  }
}

export interface ReadOpts {
  /** Restrict to one project. Omit for everything, including account-level events. */
  scope?: string;
  /**
   * Also include account-level rows (`scope IS NULL`) alongside the project's own.
   *
   * Connecting and disconnecting belong to the account, not to any one project, so a strictly
   * scoped read excludes them — and the timeline, which is the only reader, is scoped. The
   * result was that session events were written and then visible nowhere at all. They are
   * context for everything that follows ("connected, then scanned, then provisioned"), so the
   * view that tells the story opts in.
   */
  includeAccountLevel?: boolean;
  kinds?: readonly EventKind[];
  limit?: number;
}

/**
 * Read the log, newest first.
 *
 * Newest-first because the question is nearly always "what just happened", and the LIMIT has
 * to drop the OLDEST rows rather than the newest -- a truncated history that hides the most
 * recent events is worse than useless.
 *
 * @throws {StoreUnreachable} — never returns `[]` for "could not look". An empty history and
 *   an unreachable database are opposite facts.
 */
export async function read(opts: ReadOpts = {}): Promise<BrainEvent[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const bind = (v: unknown): string => { params.push(v); return `$${params.length}`; };

  if (opts.scope !== undefined) {
    where.push(opts.includeAccountLevel === true
      ? `(scope = ${bind(opts.scope)} OR scope IS NULL)`
      : `scope = ${bind(opts.scope)}`);
  }
  if (opts.kinds !== undefined) {
    // An empty array must match nothing -- that is what `= ANY(ARRAY[])` means and it is the
    // honest reading of "none of these kinds". Callers wanting no filter pass undefined.
    where.push(`kind = ANY(${bind([...opts.kinds])}::TEXT[])`);
  }
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);

  const sql =
    `SELECT id, ts, scope, kind, actor, payload FROM brain_events` +
    (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY id DESC LIMIT ${bind(limit)}`;

  const res = await withClient((c) => c.query<{
    id: string; ts: Date; scope: string | null; kind: string; actor: string | null; payload: Record<string, unknown>;
  }>(sql, params));

  return res.rows.map((r) => ({
    // BIGSERIAL arrives as a string from node-pg because a bigint does not fit a JS number.
    // Kept as a string rather than coerced -- an id is a name, not a quantity.
    id: String(r.id),
    ts: r.ts.toISOString(),
    scope: r.scope,
    kind: r.kind,
    actor: r.actor,
    payload: r.payload,
  }));
}

export interface HistoryStat {
  kind: string;
  count: number;
  lastAt: string;
}

/**
 * How often each kind of thing has happened in a scope.
 *
 * The point of keeping history is being able to say "this is the third time" — a fact no
 * live view can produce.
 */
export async function stats(scope?: string, opts: { includeAccountLevel?: boolean } = {}): Promise<HistoryStat[]> {
  const filter = scope === undefined
    ? ''
    : opts.includeAccountLevel === true
      ? 'WHERE (scope = $1 OR scope IS NULL)'
      : 'WHERE scope = $1';
  const res = await withClient((c) =>
    c.query<{ kind: string; count: string; last_at: Date }>(
      `SELECT kind, count(*)::INT8 AS count, max(ts) AS last_at
       FROM brain_events ${filter}
       GROUP BY kind ORDER BY max(ts) DESC`,
      scope === undefined ? [] : [scope],
    ));
  return res.rows.map((r) => ({ kind: r.kind, count: Number(r.count), lastAt: r.last_at.toISOString() }));
}

/**
 * How long a service type has been missing, and how many scans have said so.
 *
 * This is the one query that justifies keeping a database at all. "postgresql is missing" is
 * a live fact anyone can compute; "postgresql has been missing across 6 scans since Tuesday"
 * requires having written the earlier ones down.
 */
export async function unresolvedDrift(scope: string): Promise<Array<{ type: string; scans: number; firstSeen: string; lastSeen: string }>> {
  const res = await withClient((c) =>
    c.query<{ type: string; scans: string; first_seen: Date; last_seen: Date }>(
      `SELECT m.type,
              count(*)::INT8       AS scans,
              min(e.ts)            AS first_seen,
              max(e.ts)            AS last_seen
       FROM brain_events e
       CROSS JOIN LATERAL jsonb_array_elements_text(
         COALESCE(e.payload->'missing', '[]'::JSONB)
       ) AS m(type)
       WHERE e.kind = 'repo_scanned' AND e.scope = $1
       GROUP BY m.type
       ORDER BY count(*) DESC, min(e.ts)`,
      [scope],
    ));
  return res.rows.map((r) => ({
    type: r.type,
    scans: Number(r.scans),
    firstSeen: r.first_seen.toISOString(),
    lastSeen: r.last_seen.toISOString(),
  }));
}
