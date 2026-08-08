/**
 * Shared setup for the tests that need a real Postgres.
 *
 * These are integration tests on purpose. The lock is a compare-and-swap expressed entirely in
 * one SQL statement, and the event log's interesting query unnests JSONB — neither means
 * anything against a fake. Stubbing the database here would only assert that the strings in
 * this repo are the strings in this repo.
 *
 * The cost is needing the database from the README running. Rather than fail with a connection
 * error that reads like a broken test, these suites SKIP with a visible name, so a machine
 * without Docker gets a truthful "skipped" instead of a red suite.
 *
 * NOTHING HERE DELETES AN EVENT. `brain_events` is append-only, and `src/db/events.ts` says
 * out loud that no UPDATE or DELETE against it exists anywhere in this codebase — a test
 * helper tidying up after itself would make that sentence false. So event tests isolate
 * themselves with a unique scope per run and simply leave their rows behind. Locks are
 * different: deleting one is what `release` does, so cleaning those up is ordinary use.
 */
import { describe } from 'vitest';

import { withClient } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';

async function canReach(): Promise<boolean> {
  try {
    // One attempt, not migrate's ten: a test run should not sit for twenty seconds deciding
    // that a database nobody started is still not there.
    await withClient((c) => c.query('SELECT 1'));
    await migrate(1);
    return true;
  } catch {
    return false;
  }
}

export const dbReachable = await canReach();

/**
 * `describe`, unless there is no database — then a skip that still names itself in output.
 *
 * Annotated rather than inferred: `describe.skipIf` returns a type built from vitest internals
 * that cannot be named from here, and exporting the inferred value fails with TS4023.
 */
export const describeIfDb: typeof describe = describe.skipIf(!dbReachable) as typeof describe;

/**
 * A prefix unique to one run, so parallel test files cannot collide on a resource id or a
 * scope, and so assertions count only rows this run created.
 */
export function uniqueId(tag: string): string {
  return `test:${tag}:${process.pid}:${Math.floor(performance.now() * 1000)}`;
}

export async function deleteLocksLike(prefix: string): Promise<void> {
  await withClient((c) => c.query('DELETE FROM locks WHERE resource_id LIKE $1', [`${prefix}%`]));
}

export { withClient };
