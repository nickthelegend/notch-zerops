/**
 * Apply the schema. Idempotent, and safe to run on every boot.
 *
 * On Zerops the database is a managed service that may be reachable a moment after the app
 * container starts, so this retries rather than crash-looping the whole service on a race
 * it will win in two seconds.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { StoreUnreachable, closePool, pingStore, redactUrl, resolveDatabaseUrl, withClient } from './pool.js';

// fileURLToPath, not .pathname -- a path containing a space would percent-encode.
const SCHEMA = resolve(fileURLToPath(new URL('.', import.meta.url)), 'schema.sql');

/** Drops the tables an earlier design created, so a live database matches the schema file. */
const CUT_TABLES = ['memories', 'tickets'];

/**
 * Column reconciliation, and this exists because of a real bug rather than as belt-and-braces.
 *
 * `CREATE TABLE IF NOT EXISTS` matches on NAME, not definition. An earlier version of this
 * schema gave `brain_events` an `agent_id` column; renaming it to `actor` in schema.sql
 * changed nothing on a database that already had the table, and the mismatch surfaced only at
 * runtime as `column "actor" of relation "brain_events" does not exist` -- from inside the
 * event writer, which by design swallows its own failures. So the log silently stopped
 * recording while every page still looked fine.
 *
 * The lesson is that a schema file alone is not a migration. Anything that must exist on an
 * ALREADY-CREATED table has to be stated separately and idempotently.
 */
const COLUMNS: ReadonlyArray<readonly [table: string, column: string, definition: string]> = [
  ['brain_events', 'scope', 'TEXT'],
  ['brain_events', 'actor', 'TEXT'],
  ['brain_events', 'payload', "JSONB NOT NULL DEFAULT '{}'::JSONB"],
];

export async function migrate(attempts = 10): Promise<void> {
  const sql = await readFile(SCHEMA, 'utf8');

  for (let i = 1; i <= attempts; i += 1) {
    try {
      const ping = await pingStore();
      console.log(`[migrate] ${ping.serverVersion} at ${ping.url} (${ping.roundTripMs.toFixed(1)}ms)`);
      await withClient(async (c) => {
        await c.query(sql);
        // Cutting a feature means cutting its tables too, or the next reader has to work out
        // which half of the schema is real.
        for (const t of CUT_TABLES) await c.query(`DROP TABLE IF EXISTS ${t}`);
        // Table/column names here are literals from the list above, never caller input.
        for (const [table, column, def] of COLUMNS) {
          await c.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${def}`);
        }
      });
      const tables = await withClient((c) =>
        c.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1",
        ));
      console.log(`[migrate] tables: ${tables.rows.map((r) => r.table_name).join(', ')}`);
      // Print the columns the writer depends on, so a drift like the agent_id/actor one is
      // visible at boot rather than discovered later from a swallowed insert failure.
      const cols = await withClient((c) =>
        c.query<{ column_name: string }>(
          "SELECT column_name FROM information_schema.columns WHERE table_name='brain_events' ORDER BY ordinal_position",
        ));
      console.log(`[migrate] brain_events columns: ${cols.rows.map((r) => r.column_name).join(', ')}`);
      return;
    } catch (err) {
      if (!StoreUnreachable.is(err) || i === attempts) throw err;
      console.log(`[migrate] ${redactUrl(resolveDatabaseUrl())} not ready (attempt ${i}/${attempts}); retrying in 2s`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

function isEntryPoint(): boolean {
  const a = process.argv[1];
  if (a === undefined) return false;
  try { return resolve(fileURLToPath(import.meta.url)) === resolve(a); } catch { return false; }
}

if (isEntryPoint()) {
  try { await migrate(); } finally { await closePool().catch(() => {}); }
}
