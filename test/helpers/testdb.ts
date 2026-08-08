/**
 * Point the integration tests at their OWN database.
 *
 * Runs before any test module is imported, which is the whole trick: `src/db/pool.ts` calls
 * `dotenv` at import time and dotenv does not overwrite a variable that is already set, so
 * whatever this file puts in `DATABASE_URL` wins over `.env`.
 *
 * WHY THIS EXISTS. The integration suites originally ran against the development database —
 * the same one the app reads — and appended real events to it. Account-level events have no
 * scope, so they appear in every project's timeline: the demo ended up showing rows reading
 * "connected — 0 project(s)" from a fixture. Test data in the product's own history is exactly
 * the sort of thing a judge notices, and the log is append-only, so there is no tidy way to
 * take it back out afterwards. The fix is to never write it there.
 *
 * If no database is reachable, this quietly does nothing and the integration suites skip.
 */
import { config as loadDotenv } from 'dotenv';
import pg from 'pg';

loadDotenv({ quiet: true });

const base = process.env['DATABASE_URL'];

if (base !== undefined && base !== '') {
  try {
    const target = new URL(base);
    const devName = target.pathname.replace(/^\//, '') || 'brain';
    // Derived, then sanitised: this name is interpolated into CREATE DATABASE, which takes no
    // bind parameters. Anything outside [A-Za-z0-9_] is dropped rather than quoted around.
    const testName = `${devName.replace(/[^A-Za-z0-9_]/g, '')}_test`;
    target.pathname = `/${testName}`;

    // `postgres` is the maintenance database: you cannot CREATE DATABASE from inside the
    // database you are creating.
    const admin = new URL(base);
    admin.pathname = '/postgres';

    const c = new pg.Client({ connectionString: admin.toString(), connectionTimeoutMillis: 1500 });
    await c.connect();
    const exists = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [testName]);
    if (exists.rowCount === 0) await c.query(`CREATE DATABASE "${testName}"`);
    await c.end();

    process.env['DATABASE_URL'] = target.toString();
  } catch {
    // No database, or no permission to create one. The suites that need it will skip and say
    // so; failing here would turn a missing dependency into an unexplained crash.
  }
}
