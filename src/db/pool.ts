/**
 * Postgres access.
 *
 * On Zerops the database is a managed service on the project's private network, reached by
 * hostname (`db:5432`). Zerops injects its credentials as environment variables using the
 * `servicehostname_ENVKEY` pattern, so this file never hand-manages a password — it reads a
 * connection string that the platform assembled.
 *
 * A failure to reach the database is a NAMED outcome rather than an empty result. The history
 * is the half of this app a live view cannot give you, and "the event store is unreachable"
 * and "nothing has happened here yet" are opposite facts. Returning the second when the first
 * is true would report a project as untouched precisely when we cannot see what was done to
 * it — so every read throws `StoreUnreachable` rather than quietly returning no rows.
 */
import { config as loadDotenv } from 'dotenv';
import pg from 'pg';
import type { PoolClient } from 'pg';

loadDotenv({ quiet: true });

const { Pool } = pg;

/** The memory store could not be reached. Never conflated with "nothing remembered". */
export class StoreUnreachable extends Error {
  readonly url: string;

  constructor(message: string, options: { url: string; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StoreUnreachable';
    this.url = options.url;
  }

  static is(err: unknown): err is StoreUnreachable {
    return err instanceof StoreUnreachable || (err instanceof Error && err.name === 'StoreUnreachable');
  }
}

const CONNECT_TIMEOUT_MS = 5_000;
const STATEMENT_TIMEOUT_MS = 15_000;

/** Socket-level failures and the Postgres SQLSTATE classes that mean the connection is gone. */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND',
  '08000', '08001', '08003', '08004', '08006', '08P01',
  '57P01', // admin_shutdown — what a restarting Zerops container looks like from here
  '57P03', // cannot_connect_now — still starting
]);

function isConnectionFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) return true;
  if (err.message.includes('timeout exceeded when trying to connect')) return true;
  if (err instanceof AggregateError) return err.errors.some(isConnectionFailure);
  return false;
}

export function resolveDatabaseUrl(): string {
  // Bracket access because noPropertyAccessFromIndexSignature is on, and that rule earns its
  // keep for env vars specifically: a typo'd process.env.DATABSE_URL is silently undefined.
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is not set. Locally, copy .env.example to .env. On Zerops, reference the ' +
        'database service with the servicehostname_ENVKEY pattern rather than hardcoding a password.',
    );
  }
  return url;
}

/** Strip credentials before a connection string goes anywhere near a log line. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    if (parsed.searchParams.has('password')) parsed.searchParams.set('password', '***');
    return parsed.toString();
  } catch {
    return '<unparseable DATABASE_URL>';
  }
}

let pool: pg.Pool | undefined;
let poolUrl: string | undefined;
let injectedPool: pg.Pool | undefined;

/** Test seam. Nothing in src/ calls this. */
export function setPoolForTests(replacement: pg.Pool | undefined): void {
  injectedPool = replacement;
}

export function getPool(): pg.Pool {
  if (injectedPool) return injectedPool;
  const url = resolveDatabaseUrl();
  if (pool && poolUrl === url) return pool;
  if (pool && poolUrl !== url) {
    void pool.end().catch(() => {});
    pool = undefined;
  }

  const created = new Pool({
    connectionString: url,
    max: 8,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: 10_000,
    application_name: 'brain',
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });

  /*
   * Load-bearing on a platform that restarts containers.
   *
   * pg.Pool emits 'error' on IDLE clients when the server closes a connection — which is
   * exactly what a Zerops deploy, scale or restart of the database service looks like from
   * here. An 'error' with no listener is an unhandled EventEmitter error and takes the whole
   * process down, so without this the MCP server would reliably die from routine platform
   * operations. Swallowed here; the next borrow reconnects and real failures still surface
   * through withClient.
   */
  created.on('error', (err) => {
    console.error(`[db] idle client error against ${redactUrl(url)}: ${err.message}`);
  });

  pool = created;
  poolUrl = url;
  return created;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const closing = pool;
  pool = undefined;
  poolUrl = undefined;
  await closing.end();
}

/**
 * Borrow a client, run `fn`, always give it back.
 *
 * Error translation is asymmetric on purpose: connection failures become `StoreUnreachable`
 * so callers can degrade loudly, while SQL errors propagate untouched because those are our
 * bugs and dressing them up as infrastructure problems sends debugging the wrong way.
 */
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const url = redactUrl(resolveDatabaseUrl());
  const p = getPool();

  let client: PoolClient;
  try {
    client = await p.connect();
  } catch (cause) {
    throw new StoreUnreachable(`could not open a connection to ${url}`, { url, cause });
  }

  let destroy = false;
  try {
    return await fn(client);
  } catch (err) {
    if (isConnectionFailure(err)) {
      destroy = true;
      throw new StoreUnreachable(`lost connection to ${url} mid-query`, { url, cause: err });
    }
    throw err;
  } finally {
    client.release(destroy);
  }
}

export interface StorePing {
  reachable: true;
  roundTripMs: number;
  serverVersion: string;
  now: Date;
  url: string;
}

/** @throws {StoreUnreachable} — never returns `{ reachable: false }`. */
export async function pingStore(): Promise<StorePing> {
  const url = redactUrl(resolveDatabaseUrl());
  const t0 = performance.now();
  return withClient(async (client) => {
    const res = await client.query<{ v: string; now: Date }>('SELECT version() AS v, now() AS now');
    const row = res.rows[0];
    if (!row) throw new Error('SELECT version() returned no rows');
    return {
      reachable: true as const,
      roundTripMs: performance.now() - t0,
      serverVersion: row.v.split(' ').slice(0, 2).join(' '),
      now: row.now,
      url,
    };
  });
}
