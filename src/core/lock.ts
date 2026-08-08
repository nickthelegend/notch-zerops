/**
 * The baton, re-platformed: one writer per resource, arbitrated by Postgres.
 *
 * PROVENANCE. The protocol is ported from `src/core/baton.ts` in a prior personal project
 * (Notch) -- kept here alongside this file so the two can be read side by side. The rules are
 * unchanged: exactly one holder per resource, acquisition fails rather than queues when
 * contended, handoff is explicit, and every transition is an event in the log.
 *
 * WHAT HAD TO CHANGE, AND WHY IT IS THE WHOLE POINT OF THE PORT.
 *
 * The original stores the holder in a JSON file and mutates it like this:
 *
 *     const state = readProjectState(dir);      // <-- read
 *     if (state.holder && state.holder !== agentId) throw new NotHolderError(...);
 *     state.holder = agentId;                   // <-- modify
 *     writeProjectState(dir, state);            // <-- write
 *
 * That is a read-modify-write with nothing between the check and the set. One process on one
 * laptop, it is fine in practice: the window is microseconds and there is a single writer.
 * On Zerops it is a real bug. The MCP service can run several containers behind a load
 * balancer, all pointed at one Postgres, so two agents can be served by two containers that
 * both read `holder = NULL` and both write themselves in. Both then believe they hold the
 * write lock, which is precisely the collision this component exists to prevent -- and it
 * would fail silently, because both callers get a success.
 *
 * So acquisition here is ONE statement. `INSERT ... ON CONFLICT DO UPDATE ... WHERE` lets
 * Postgres decide, under the row lock it already takes, whether the lock was free or expired.
 * Exactly one caller gets a row back; everyone else gets zero rows and is told who holds it.
 * There is no window because there is no gap between the check and the set.
 *
 * TTL is new as well, and for the same environmental reason. A laptop process that dies
 * leaves a stale file a human can delete. A container that dies leaves a lock nobody can
 * release, and the resource is wedged until someone reaches for SQL. Every lock therefore
 * carries an expiry, and an expired lock is takeable by construction -- the same single
 * statement treats "free" and "expired" identically.
 */
import type { Pool } from 'pg';
import { DEFAULT_SCOPE, type BrainEvent } from '../types.js';

/** Attempted to act without the lock. Carries the actual holder so callers can wait on them. */
export class NotHolderError extends Error {
  constructor(
    readonly resourceId: string,
    readonly agentId: string,
    readonly holder: string | null,
  ) {
    super(
      holder === null
        ? `no agent holds the lock on "${resourceId}"`
        : `agent "${agentId}" does not hold the lock on "${resourceId}" (holder: "${holder}")`,
    );
    this.name = 'NotHolderError';
  }
}

export interface LockState {
  resourceId: string;
  scope: string;
  holder: string;
  acquiredAt: Date;
  expiresAt: Date;
}

export type AcquireResult =
  | { ok: true; lock: LockState; /** True when this call took over an expired lock. */ tookOverExpired: boolean }
  | { ok: false; heldBy: string; expiresAt: Date; /** Seconds until it frees itself. */ availableInSec: number };

/** Publishes an event. Injected so the lock manager owes nothing to a transport. */
export type EventSink = (e: { kind: BrainEvent['kind']; agentId?: string; scope?: string; payload: Record<string, unknown> }) => Promise<void>;

const DEFAULT_TTL_SEC = 300;

/**
 * ONE statement, and every clause in it is load-bearing.
 *
 * The `WHERE` on the `DO UPDATE` is what makes this a compare-and-swap rather than a
 * clobber: the row is only overwritten when the existing lock has expired, or when the same
 * agent is re-acquiring (idempotent renewal). Otherwise the conflict resolves to no update,
 * the CTE yields no rows, and the caller learns it lost.
 *
 * The `prior` CTE exists because `excluded` is NOT referenceable from `RETURNING` -- Postgres
 * exposes it only inside `DO UPDATE SET` and its `WHERE`, and it raises 42P01 otherwise
 * (found by running it, not by reading the manual). `RETURNING locks.holder` is no help
 * either: by then it is the NEW holder. Every CTE in one statement reads the same snapshot,
 * so `prior` sees the row as it was BEFORE the upsert, which is how "did I take over an
 * expired lock" gets answered without a second round trip and without leaving the
 * single-statement guarantee.
 *
 * `now()` throughout is POSTGRES's clock, never the caller's. Two containers with a few
 * hundred milliseconds of clock skew would otherwise disagree about whether a lock had
 * expired, and the whole guarantee would rest on NTP.
 */
const ACQUIRE_SQL = `
  WITH prior AS (
    SELECT holder AS prior_holder
    FROM locks
    WHERE resource_id = $1 AND scope = $2
  ), taken AS (
    INSERT INTO locks (resource_id, scope, holder, acquired_at, expires_at)
    VALUES ($1, $2, $3, now(), now() + ($4::INT * INTERVAL '1 second'))
    ON CONFLICT (resource_id, scope) DO UPDATE
      SET holder      = excluded.holder,
          acquired_at = now(),
          expires_at  = excluded.expires_at
      WHERE locks.expires_at <= now()
         OR locks.holder = excluded.holder
    RETURNING resource_id, scope, holder, acquired_at, expires_at
  )
  SELECT taken.*, prior.prior_holder
  FROM taken LEFT JOIN prior ON true
`;

interface LockRow {
  resource_id: string;
  scope: string;
  holder: string;
  acquired_at: Date;
  expires_at: Date;
  /** Who held it before this call. `null` when the lock did not exist. */
  prior_holder?: string | null;
}

const toState = (r: LockRow): LockState => ({
  resourceId: r.resource_id,
  scope: r.scope,
  holder: r.holder,
  acquiredAt: r.acquired_at,
  expiresAt: r.expires_at,
});

export class LockManager {
  constructor(
    private readonly pool: Pool,
    private readonly emit: EventSink,
  ) {}

  /**
   * Take the lock, or find out who has it.
   *
   * Never blocks and never queues. A caller that wants to wait polls `status` -- which keeps
   * the contention visible in the event log instead of hidden inside a held connection, and
   * means a crashed waiter cannot hold a database connection open.
   */
  async acquire(
    resourceId: string,
    agentId: string,
    opts: { scope?: string; ttlSec?: number } = {},
  ): Promise<AcquireResult> {
    const scope = opts.scope ?? DEFAULT_SCOPE;
    const ttl = Math.max(1, Math.min(opts.ttlSec ?? DEFAULT_TTL_SEC, 3600));

    const res = await this.pool.query<LockRow>(ACQUIRE_SQL, [resourceId, scope, agentId, ttl]);
    const row = res.rows[0];

    if (row !== undefined) {
      const lock = toState(row);
      // Took over only if somebody ELSE held it. A re-acquire by the same agent is a
      // renewal, and reporting that as a takeover would invent contention that never was.
      const prior = row.prior_holder ?? null;
      const tookOverExpired = prior !== null && prior !== agentId;
      await this.emit({
        kind: 'lock_acquired',
        agentId,
        scope,
        payload: {
          resourceId,
          expiresAt: lock.expiresAt.toISOString(),
          ttlSec: ttl,
          tookOverExpired,
          ...(tookOverExpired ? { tookFrom: prior } : {}),
        },
      });
      return { ok: true, lock, tookOverExpired };
    }

    // Lost. Read the winner so the caller is told WHO, not merely "no".
    const cur = await this.pool.query<LockRow>(
      'SELECT resource_id, scope, holder, acquired_at, expires_at FROM locks WHERE resource_id = $1 AND scope = $2',
      [resourceId, scope],
    );
    const held = cur.rows[0];
    if (held === undefined) {
      // The holder released in the gap between our failed insert and this read. Rare, and
      // retrying once is honest -- reporting "held by nobody" would be nonsense.
      return this.acquire(resourceId, agentId, opts);
    }
    const availableInSec = Math.max(0, Math.ceil((held.expires_at.getTime() - Date.now()) / 1000));

    // Contention is a first-class event. Without this the Observatory could only ever show
    // successful work, which is the least interesting half of a coordination story.
    await this.emit({
      kind: 'lock_contended',
      agentId,
      scope,
      payload: { resourceId, heldBy: held.holder, availableInSec, wanted: agentId },
    });

    return { ok: false, heldBy: held.holder, expiresAt: held.expires_at, availableInSec };
  }

  /**
   * Release, but only your own lock.
   *
   * The `holder = $3` predicate is the guard: without it, an agent whose lock had already
   * expired and been taken over would release the NEW holder's lock, handing the resource to
   * nobody while a third agent was mid-write.
   */
  async release(resourceId: string, agentId: string, scope = DEFAULT_SCOPE): Promise<boolean> {
    const res = await this.pool.query(
      'DELETE FROM locks WHERE resource_id = $1 AND scope = $2 AND holder = $3',
      [resourceId, scope, agentId],
    );
    const released = (res.rowCount ?? 0) > 0;
    if (released) {
      await this.emit({ kind: 'lock_released', agentId, scope, payload: { resourceId } });
    }
    return released;
  }

  /**
   * Who holds it, if anyone.
   *
   * Filters on `expires_at > now()` so an expired lock reads as free rather than as held by
   * a container that no longer exists -- the status a poller acts on has to match what
   * `acquire` would actually do.
   */
  async status(resourceId: string, scope = DEFAULT_SCOPE): Promise<LockState | null> {
    const res = await this.pool.query<LockRow>(
      `SELECT resource_id, scope, holder, acquired_at, expires_at
       FROM locks WHERE resource_id = $1 AND scope = $2 AND expires_at > now()`,
      [resourceId, scope],
    );
    const row = res.rows[0];
    return row === undefined ? null : toState(row);
  }

  /** Every live lock in a scope. What the Observatory renders. */
  async list(scope = DEFAULT_SCOPE): Promise<LockState[]> {
    const res = await this.pool.query<LockRow>(
      `SELECT resource_id, scope, holder, acquired_at, expires_at
       FROM locks WHERE scope = $1 AND expires_at > now() ORDER BY acquired_at`,
      [scope],
    );
    return res.rows.map(toState);
  }

  /** Throws unless `agentId` holds it right now. The guard tools call before acting. */
  async assertHolder(resourceId: string, agentId: string, scope = DEFAULT_SCOPE): Promise<void> {
    const cur = await this.status(resourceId, scope);
    if (cur === null || cur.holder !== agentId) {
      throw new NotHolderError(resourceId, agentId, cur?.holder ?? null);
    }
  }
}
