/**
 * The API the desktop app talks to.
 *
 * Thin: every endpoint is a call into the pure modules plus one Zerops request. Nothing is
 * cached, because the whole promise is "this is your infrastructure right now" and a stale
 * architecture diagram is worse than none.
 *
 * THE TOKEN NEVER LEAVES THIS PROCESS. It arrives once via `POST /api/session`, is held in
 * memory only, and is never written to disk, never logged, never returned. Every response
 * that mentions it shows `redactToken` output. That is the same rule the credential-broker
 * design had, kept after the rest of that design was cut.
 *
 * A dead Zerops API is a 502 with the reason, never `200 []`. An empty architecture and an
 * unreachable one look identical in a diagram, and only one of them means "you have no
 * services".
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ZeropsApiError, ZeropsClient, redactToken } from './zerops/api.js';
import { buildGraph, layout } from './zerops/graph.js';
import { computeDrift } from './zerops/drift.js';
import { compareConfig } from './zerops/config.js';
import { compareEnvironments, type EnvSnapshot } from './zerops/compare.js';
import { deriveWiring } from './zerops/wiring.js';
import { toMermaid } from './zerops/mermaid.js';
import { SCAN_GLOBS, findEnvNames, findSecretNames, scanRepo, type RepoFile } from './repo/scan.js';
import { sweep } from './repo/secrets.js';
import * as journal from './zerops/journal.js';
import { cycle, LENSES, type Cycle } from './ops/swarm.js';
import { design } from './ops/architect.js';
import { ServiceCatalog, buildImportYaml, safeHostname, wiringSnippet, type ImportService } from './zerops/catalog.js';
import type { ServiceType } from './repo/scan.js';
import { read as readEvents, record, stats, unresolvedDrift } from './db/events.js';
import { AgentError, ask, available, brief, parseProposal, proposeInstruction } from './agents.js';
import { DeployError, push, readiness, zcliPath } from './deploy.js';
import { SERVICE_TYPES } from './repo/scan.js';
import { LockManager } from './core/lock.js';
import { getPool } from './db/pool.js';
import { migrate } from './db/migrate.js';

// fileURLToPath, not .pathname: a repo path containing a space percent-encodes and then
// nothing resolves. Bitten by this twice on a sibling project.
const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB_DIR = resolve(HERE, '../web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  // The Expo web export ships these; without them the browser gets
  // application/octet-stream and refuses to render the icon or the fonts.
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

/**
 * The one piece of mutable state, and it is deliberately not persisted.
 *
 * A PAT written to disk is a PAT that outlives the session that needed it. The cost is
 * re-pasting after a restart; the benefit is that closing the app disposes of the credential.
 */
interface Session {
  client: ZeropsClient;
  /** Needed only by zcli, which is a separate process and takes it through `env`. */
  token: string;
  lastSeen: number;
}

/**
 * ONE SESSION PER VISITOR, not one per process.
 *
 * This started as a single module-level client, which is correct for a desktop app talking to
 * a daemon on loopback: there is exactly one human. The moment this same server is reachable
 * over the internet that design hands visitor A's Zerops credential to visitor B — an
 * account-level token that can create and delete infrastructure. So the token is keyed by an
 * opaque session id carried in an HttpOnly cookie, and `requireClient` can only ever reach
 * the session that presented it.
 *
 * Still memory-only and still discarded on restart. The cookie is not the credential; it is a
 * lookup key for a credential that never leaves this process.
 */
/*
 * Is this instance reachable from outside this machine?
 *
 * Set when the server is deployed. It tightens the cookie to Secure and — more importantly —
 * gates the endpoints that read and write the FILESYSTEM of the host. Scanning a repository
 * is exactly right on a desktop app pointed at your own checkout, and is a directory-traversal
 * oracle when the same code answers the public internet.
 */
const PUBLIC = process.env['NOTCH_PUBLIC'] === '1';

const sessions = new Map<string, Session>();
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 200;

const COOKIE = 'notch_sid';

function readSid(req: IncomingMessage): string | null {
  const raw = req.headers.cookie;
  if (raw === undefined) return null;
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE) return rest.join('=') || null;
  }
  return null;
}

/** Drop anything idle past the TTL, and never let the table grow without bound. */
function sweepSessions(): void {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.lastSeen > SESSION_TTL_MS) sessions.delete(id);
  while (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
    if (oldest === undefined) break;
    sessions.delete(oldest[0]);
  }
}

/**
 * Which session does this request belong to?
 *
 * One resolver, used by every path that touches a session — a second answer to "who is logged
 * in" is how a DELETE ends up clearing a different session than the one the next GET reads.
 *
 * The cookie-less fallback is what keeps the desktop app, curl and the test suite working:
 * they carry no cookies, and on loopback there is exactly one human anyway. It is refused
 * outright when this instance is public, because there the cookie is the ONLY thing separating
 * one visitor's Zerops credential from another's.
 */
function resolveSid(req: IncomingMessage): string | null {
  const fromCookie = readSid(req);
  if (fromCookie !== null) return fromCookie;
  return PUBLIC ? null : (sessions.has(TEST_SID) ? TEST_SID : null);
}

function currentSession(req: IncomingMessage): Session | null {
  sweepSessions();
  const sid = resolveSid(req);
  if (sid === null) return null;
  const s = sessions.get(sid);
  if (s === undefined) return null;
  s.lastSeen = Date.now();
  return s;
}


/**
 * The provisioning lock.
 *
 * Provisioning is the one action here that changes somebody's infrastructure, and it is
 * exactly the operation two people (or two agent sessions) can collide on: both scan, both
 * see Postgres missing, both click. Zerops would reject the second import on a hostname
 * clash, but only after having partially applied the first -- and neither caller would know
 * why. So a project-scoped lock is taken for the duration, and the loser is told who holds it
 * rather than being handed a confusing platform error.
 *
 * Events are published into the same append-only log the timeline reads, so a contention is
 * something you can see afterwards rather than something only the loser experienced.
 */
const locks = new LockManager(getPool(), async (e) => {
  await record({
    kind: e.kind === 'lock_contended' ? 'provision_blocked' : 'provision_started',
    scope: e.scope ?? null,
    actor: e.agentId ?? 'ui',
    payload: e.payload,
  });
});

/**
 * Deploys in flight.
 *
 * A build takes minutes. Answering the HTTP request only when it finishes means the UI has
 * nothing to show for those minutes but a spinner — and the build log is the most convincing
 * part of the whole demo, because it is unmistakably real work happening on somebody else's
 * computer. So the request returns an id immediately and the lines are collected here to be
 * polled.
 *
 * In memory ON PURPOSE, and not a database in disguise: this is the transcript of a process
 * that is still running. The OUTCOME — succeeded, failed, the URL, the tail of the log — is
 * written to Postgres like everything else, so nothing durable lives here. A daemon restart
 * loses an in-flight build's scrollback, which is exactly as much as it should lose.
 */
interface DeployRun {
  lines: string[];
  done: boolean;
  ok: boolean | null;
  url: string | null;
  note: string;
  health: { status: number; ms: number } | null;
  startedAt: number;
}
const deploys = new Map<string, DeployRun>();

/** Keep the map from growing forever in a long session. */
function reapDeploys(): void {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, run] of deploys) if (run.done && run.startedAt < cutoff) deploys.delete(id);
}

/**
 * Does the deployed thing actually answer?
 *
 * "Zerops accepted the deploy" and "the app is up" are different claims, and only one of them
 * is what anybody wanted. A container can start, pass its own health check and still serve a
 * 502 through the router while routing settles — so Notch asks the URL the same way a user
 * would, and retries for a while before giving up, because a cold start is not a failure.
 */
async function checkHealth(url: string, attempts = 20): Promise<{ status: number; ms: number } | null> {
  for (let i = 0; i < attempts; i += 1) {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
      if (r.status < 500) return { status: r.status, ms: Date.now() - t0 };
    } catch { /* not routing yet */ }
    await new Promise((ok) => setTimeout(ok, 3000));
  }
  return null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (BadRequest.is(err)) {
    return sendJson(res, 400, { error: 'bad_request', message: err.message });
  }
  if (ZeropsApiError.is(err)) {
    // 502 rather than passing Zerops' status through: from the browser's point of view the
    // upstream failed, and a 401 here would look like OUR auth rejected the user.
    return sendJson(res, err.isAuthFailure ? 401 : 502, {
      error: err.isAuthFailure ? 'token_rejected' : 'zerops_api_error',
      message: err.apiMessage,
      status: err.status,
      note: 'This is an answer from Zerops, not an empty account. Nothing here means "you have no services".',
    });
  }
  sendJson(res, 500, { error: 'internal', message: err instanceof Error ? err.message : String(err) });
}

/**
 * Refuse anything that reads or writes this machine's filesystem when we are public.
 *
 * Scanning a repository is the whole point of Notch on a desktop: you point it at your own
 * checkout and it reads your manifests. The identical code answering the open internet is a
 * directory-traversal oracle — `?dir=/etc` — and `zcli push` on a shared host would deploy
 * from whatever is lying around on it.
 *
 * So the hosted build serves the board, the drift you can compute from the API, the action
 * log, the environment diff and the autopilot signals, and it says plainly why the repo-facing
 * half is not available rather than half-working or silently returning nothing.
 */
function refuseIfPublic(res: ServerResponse, what: string): boolean {
  if (!PUBLIC) return false;
  sendJson(res, 403, {
    error: 'not_on_hosted',
    message: `${what} reads the filesystem of the machine Notch runs on, so it is disabled on ` +
             'the hosted demo. Run the desktop app against your own checkout for this — ' +
             'everything that talks to the Zerops API works here.',
  });
  return true;
}

function requireClient(req: IncomingMessage, res: ServerResponse): ZeropsClient | null {
  const s = currentSession(req);
  if (s === null) {
    sendJson(res, 401, { error: 'no_session', message: 'Paste a Zerops Personal Access Token first.' });
    return null;
  }
  return s.client;
}

/** A malformed request body is the CLIENT's mistake, so it must not surface as a 500. */
class BadRequest extends Error {
  constructor(message: string) { super(message); this.name = 'BadRequest'; }
  static is(e: unknown): e is BadRequest { return e instanceof Error && e.name === 'BadRequest'; }
}

const MAX_BODY_BYTES = 256 * 1024;

/** Service types that RUN the application, as opposed to backing it. */
const RUNTIME_TYPES = ['nodejs', 'python', 'go', 'php', 'dotnet', 'rust', 'java', 'bun', 'deno', 'elixir', 'ruby'];

/**
 * Is this import type a runtime?
 *
 * The OS PREFIX BREAKS A NAIVE CHECK, and it broke this one silently. Managed services import
 * as `postgresql@18`, but a runtime imports as `alpine/nodejs@24` — so `startsWith('nodejs')`
 * is false for every runtime Zerops actually accepts. The consequence was invisible: the
 * runtime was never found, so no public subdomain, no environment wiring and no secrets were
 * emitted, and the app deployed to a container that could not reach a single service
 * provisioned for it. The import succeeded every time.
 */
function isRuntimeType(type: string): boolean {
  const base = (type.includes('/') ? type.slice(type.indexOf('/') + 1) : type).toLowerCase();
  return RUNTIME_TYPES.some((r) => base.startsWith(r));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    size += buf.byteLength;
    // Bounded: without a cap, an unbounded body is a trivial way to exhaust memory, and
    // nothing this API accepts is anywhere near 256KB.
    if (size > MAX_BODY_BYTES) throw new BadRequest('request body too large');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequest('Request body was not valid JSON.');
  }
}

/** Read the scannable manifests out of a directory. The only filesystem read in the app. */
async function readRepo(dir: string): Promise<RepoFile[]> {
  const out: RepoFile[] = [];
  for (const g of SCAN_GLOBS) {
    const p = join(dir, g);
    if (!existsSync(p)) continue;
    try {
      out.push({ path: g, content: await readFile(p, 'utf8') });
    } catch {
      // A manifest we cannot read is not a manifest that says nothing; skip it rather than
      // let one unreadable file abort the scan.
    }
  }
  return out;
}

interface Plan {
  projectId: string;
  services: ImportService[];
  /** The repo variable → service mapping the app needs in its own zerops.yml. */
  wiring: Array<{ key: string; service: string }>;
  /** That mapping, rendered as a paste-ready `run.envVariables` block. */
  wiringSnippet: string;
  /** Requested types the platform has no equivalent for. Reported, never silently dropped. */
  unresolved: string[];
  /** Secret env var names found in the repo, declared on the runtime. Names only. */
  secrets: string[];
  yaml: string;
}

/**
 * Turn requested service types into the exact import file.
 *
 * Shared by the plan and the write, so the preview cannot drift from what actually gets
 * sent -- a preview that shows something other than what happens is worse than no preview.
 */
async function buildPlan(
  c: ZeropsClient,
  body: { projectId?: unknown; types?: unknown; ha?: unknown; dir?: unknown },
): Promise<Plan | { error: string; message: string }> {
  const projectId = typeof body.projectId === 'string' ? body.projectId : '';
  const types = Array.isArray(body.types) ? body.types.filter((t): t is string => typeof t === 'string') : [];
  const ha = body.ha === true;
  const dir = typeof body.dir === 'string' ? body.dir : '';
  if (projectId === '' || types.length === 0) {
    return { error: 'missing_params', message: 'projectId and a non-empty types[] are required.' };
  }

  const project = (await c.projects()).find((p) => p.id === projectId);
  if (project === undefined) return { error: 'no_such_project', message: `No project ${projectId} on this account.` };

  /*
   * Secrets ride on the RUNTIME, because that is the service that reads them. Declaring
   * `JWT_SECRET` on a Postgres container would create a real secret nothing can use.
   *
   * Only names are collected; Zerops generates the values during the import. See
   * `findSecretNames` for why copying local values would be the wrong thing to do.
   */
  const secrets = dir === '' || !existsSync(dir) ? [] : findSecretNames(await readRepo(dir));

  const catalog = new ServiceCatalog(c);
  const existing = (await c.services(projectId)).map((s) => s.name);
  const taken = [...existing];
  const services: Plan['services'] = [];
  const unresolved: string[] = [];

  for (const t of types) {
    const spec = await catalog.resolve(t as ServiceType, ha);
    if (spec === null) { unresolved.push(t); continue; }
    // Hostnames must be unique in a project, <=25 chars, [a-z0-9] only. Collisions are
    // resolved against services that already exist AND ones earlier in this same plan.
    const hostname = safeHostname(t, taken);
    taken.push(hostname);
    services.push({ hostname, ...spec });
  }

  // A runtime is what serves traffic and holds the app's secrets. `nodejs`, `python`, `go`…
  const runtime = services.find((s) => isRuntimeType(s.type));
  if (runtime !== undefined) {
    if (secrets.length > 0) runtime.secrets = secrets;
    runtime.publicUrl = true;

    /*
     * Wire the runtime to what is being created for it.
     *
     * `compareConfig` already works out which of the repo's connection variables a given
     * service answers — that is how it avoids reporting `DATABASE_URL` as missing on a project
     * with a database. The same mapping, pointed the other way, is the wiring: the app reads
     * `DATABASE_URL`, so `DATABASE_URL` is set to the new Postgres. Without it the deploy
     * succeeds and the application cannot reach a single service provisioned for it.
     */
    const hostnames = services.map((s) => s.hostname);
    const wanted = dir === '' || !existsSync(dir) ? [] : findEnvNames(await readRepo(dir));
    const provided = compareConfig(wanted, [], hostnames).provided;
    const env = provided
      .filter((pv) => hostnames.includes(pv.by))
      .map((pv) => ({ key: pv.key, service: pv.by }));
    if (env.length > 0) runtime.env = env;
  }

  /*
   * The wiring is REPORTED, not imported.
   *
   * `envVariables` in an import file is silently ignored, so emitting it there would show the
   * user a preview of something that will not happen. It belongs in the repository's own
   * `zerops.yml` under `run:` — so the exact block to paste is handed back instead.
   */
  const wiring = runtime?.env ?? [];
  return {
    projectId, services, unresolved, secrets,
    yaml: buildImportYaml(services),
    wiring: wiring.map((e) => ({ key: e.key, service: e.service })),
    wiringSnippet: wiringSnippet(wiring),
  };
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const target = resolve(join(WEB_DIR, normalize(rel)));
  if (!target.startsWith(WEB_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  try {
    const body = await readFile(target);
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'not_found', path: rel });
  }
}

/**
 * Only a page served from this machine may drive this API.
 *
 * The Expo dev server runs on its own port, so the app is cross-origin during development and
 * the browser needs to be told that is allowed. It is NOT told `*`. This daemon holds a live
 * Zerops token and can create billable infrastructure; a wildcard would let any website you
 * happen to have open issue provisioning requests against your account from your own browser.
 *
 * So the origin is reflected back only when it is loopback. Anything else gets no CORS header
 * at all, and the browser refuses the response on its own.
 */
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/;

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !LOCAL_ORIGIN.test(origin)) return;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!path.startsWith('/api/')) return serveStatic(res, path);

  try {
    switch (path) {
      /** Paste a token. Verified by a real API call, not by checking it is non-empty. */
      case '/api/session': {
        if (req.method === 'DELETE') {
          const sid = resolveSid(req);
          if (sid !== null) sessions.delete(sid);
          await record({ kind: 'session_closed', payload: {} });
          res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
          return sendJson(res, 200, { ok: true, message: 'token discarded' });
        }
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed', message: 'Use POST to open a session, or DELETE to close one.' });
        const body = (await readBody(req)) as { token?: unknown };
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        if (token === '') return sendJson(res, 400, { error: 'missing_token', message: 'A Zerops Personal Access Token is required.' });

        const candidate = new ZeropsClient(token);
        const v = await candidate.verify();
        if (!v.ok) {
          const stale = resolveSid(req);
          if (stale !== null) sessions.delete(stale);
          return sendJson(res, v.isAuthFailure ? 401 : 502, { error: 'token_rejected', message: v.reason });
        }
        /*
         * A fresh id per accepted token, from the CSPRNG. Not derived from the token, not
         * sequential, and not reused across logins — so the cookie reveals nothing about the
         * credential and a captured one dies with the session.
         */
        sweepSessions();
        const sid = randomUUID();
        const entry: Session = { client: candidate, token, lastSeen: Date.now() };
        sessions.set(sid, entry);
        // A caller that sends no cookie back (the desktop shell, curl, the tests) still needs
        // to find its session on the next request. Never in public mode — see resolveSid.
        if (!PUBLIC && readSid(req) === null) sessions.set(TEST_SID, entry);
        res.setHeader('set-cookie',
          `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}` +
          (PUBLIC ? '; Secure' : ''));
        await record({ kind: 'session_opened', payload: { email: v.email, projects: v.projectCount } });
        return sendJson(res, 200, v);
      }

      case '/api/session/status': {
        const mine = currentSession(req);
        if (mine === null) return sendJson(res, 200, { connected: false });
        const v = await mine.client.verify();
        /*
         * `{ connected: true, ok: false }` was the old answer here, which is a contradiction:
         * it reported a live session while also reporting that the token behind it does not
         * work. A revoked token would leave the UI sitting on a dashboard it could no longer
         * refresh.
         *
         * The distinction that matters is WHY verification failed. An auth failure means the
         * credential is genuinely dead -- drop it, so the app returns to the gate and asks for
         * a new one. Anything else (Zerops down, DNS, a 502) says nothing about the token, and
         * throwing away a working credential because the network hiccuped would be a worse
         * bug than the one being fixed. So that case stays connected and reports degradation.
         */
        if (!v.ok) {
          if (v.isAuthFailure) {
            const sid = resolveSid(req);
            if (sid !== null) sessions.delete(sid);
            await record({ kind: 'session_closed', payload: { reason: 'token rejected by Zerops' } });
            return sendJson(res, 200, { connected: false, reason: v.reason });
          }
          return sendJson(res, 200, { connected: true, degraded: true, reason: v.reason });
        }
        return sendJson(res, 200, { connected: true, ...v });
      }

      case '/api/projects': {
        const c = requireClient(req, res);
        if (c === null) return;
        return sendJson(res, 200, { projects: await c.projects() });
      }

      /**
       * Create an empty project.
       *
       * Deliberately ONE responsibility. It would be easy to accept a repo path here and
       * create-and-fill in a single call, and the result would be an action that provisions
       * infrastructure with no preview step. Creating the project is cheap and reversible;
       * filling it is neither. So this returns an empty project, and the existing
       * scan -> preview -> provision path fills it, with the import file shown first.
       *
       * This WRITES: a project is a real, billable object.
       */
      case '/api/project': {
        if (req.method !== 'POST') {
          return sendJson(res, 405, { error: 'method_not_allowed', message: 'POST -- this creates a real project on your Zerops account.' });
        }
        const c = requireClient(req, res);
        if (c === null) return;
        const body = (await readBody(req)) as { name?: unknown; tags?: unknown };
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name === '') {
          return sendJson(res, 400, { error: 'missing_name', message: 'A project name is required.' });
        }
        const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === 'string') : [];

        // Refused up front rather than letting Zerops reject it after the round trip, because
        // the platform's own message for a duplicate does not mention the name.
        if ((await c.projects()).some((p) => p.name === name)) {
          return sendJson(res, 409, { error: 'name_taken', message: `This account already has a project called "${name}".` });
        }

        const project = await c.createProject(name, tags);

        /*
         * Wait until the project is FINDABLE, not merely created.
         *
         * `/project/search` is eventually consistent: for a second or two after creation the
         * new project is not in the list yet. Returning immediately meant the UI selected it,
         * asked for its architecture, and got a 404 that renders as "that project is not on
         * this account any more" — the most alarming possible message about a project the user
         * had just successfully made. Observed on the very first real run of this endpoint.
         *
         * So "created" means "created and visible to the next read". If it never appears we
         * still return it, with a note, rather than pretend the creation failed — the project
         * does exist and inventing a failure would be worse than a slow success.
         */
        let visible = false;
        for (let i = 0; i < 12; i += 1) {
          if ((await c.projects()).some((p) => p.id === project.id)) { visible = true; break; }
          await new Promise((r) => setTimeout(r, 500));
        }

        await record({ kind: 'project_created', scope: project.id, payload: { name: project.name, tags } });
        return sendJson(res, 200, {
          project,
          ...(visible ? {} : {
            note: 'Zerops accepted the project but is not listing it yet. Press Refresh in a moment.',
          }),
        });
      }

      /** The architecture, laid out and ready for React Flow. */
      case '/api/graph': {
        const c = requireClient(req, res);
        if (c === null) return;
        const projectId = url.searchParams.get('projectId');
        if (projectId === null) {
          return sendJson(res, 400, { error: 'missing_projectId', message: 'Which project? A projectId is required.' });
        }
        const project = (await c.projects()).find((p) => p.id === projectId);
        // Every error body carries a `message`. Without one the UI has nothing to show but
        // the status code, and "HTTP 404" is what a user was actually shown here.
        if (project === undefined) {
          return sendJson(res, 404, {
            error: 'no_such_project',
            projectId,
            message: 'That project is not on this account any more. It may have been deleted, or this token may belong to a different account.',
          });
        }
        const graph = buildGraph(project, await c.services(projectId));
        return sendJson(res, 200, { ...graph, nodes: layout(graph.nodes) });
      }

      /** The whole point: repo requirements vs deployed reality. */
      /*
       * What git is already carrying.
       *
       * Deliberately NOT behind `requireClient`: this reads a directory on this machine and
       * talks to nobody. Gating a local security check on a cloud credential would mean the
       * one moment you most need it — before you have connected anything — is the one moment
       * it refuses to run.
       */
      case '/api/hygiene': {
        if (refuseIfPublic(res, 'The secret sweep')) return;
        const dir = url.searchParams.get('dir');
        if (dir === null || dir === '') {
          return sendJson(res, 400, { error: 'missing_params', message: 'dir is required' });
        }
        if (!existsSync(dir)) {
          return sendJson(res, 400, { error: 'no_such_dir', message: `${dir} does not exist on this machine` });
        }
        const report = await sweep(dir);
        /*
         * Recorded by COUNT and RULE, never by finding. The event log is a database row that
         * outlives the session; putting a file path and a line number in it would build a map
         * to the credential that survives the rotation.
         */
        await record({
          kind: 'hygiene_swept', actor: 'notch',
          payload: {
            dir,
            tracked: report.tracked,
            scanned: report.scanned,
            findings: report.findings.length,
            rules: [...new Set(report.findings.map((f) => f.rule))],
          },
        }).catch(() => null);
        return sendJson(res, 200, report);
      }

      /*
        * The board as text you can commit.
        *
        * A diagram inside a desktop app helps whoever has the app open; a Mermaid block in the
        * README helps the person who arrives in eight months, and GitHub renders it with
        * nothing installed. Served as text/plain so the browser shows it rather than
        * downloading it — the usual next action is to select it and paste.
        */
      case '/api/mermaid': {
        const c = requireClient(req, res);
        if (c === null) return;
        const projectId = url.searchParams.get('projectId');
        const dir = url.searchParams.get('dir') ?? '';
        if (projectId === null) {
          return sendJson(res, 400, { error: 'missing_params', message: 'projectId is required' });
        }
        const project = (await c.projects()).find((p) => p.id === projectId);
        if (project === undefined) {
          return sendJson(res, 404, { error: 'no_such_project', message: 'That project is not on this account any more.' });
        }
        const graph = buildGraph(project, await c.services(projectId));

        /*
         * A scan is optional here. Without one you still get the services that exist, which is
         * a useful diagram; with one you also get the gaps and the edges. Requiring a directory
         * would make the cheap version of this feature impossible.
         */
        let missing: string[] = [];
        let wiring: ReturnType<typeof deriveWiring> | null = null;
        let repo: { name: string; satisfied: number; missing: number } | null = null;
        if (dir !== '' && existsSync(dir)) {
          const files = await readRepo(dir);
          const required = scanRepo(files);
          const drift = computeDrift(required, graph.nodes);
          missing = drift.items.filter((i) => i.status === 'missing').map((i) => i.type);
          wiring = deriveWiring(required, graph.nodes, graph.edges.length);
          repo = {
            name: dir.split('/').filter(Boolean).pop() ?? dir,
            satisfied: drift.counts['satisfied'] ?? 0,
            missing: drift.counts['missing'] ?? 0,
          };
        }

        const text = toMermaid({
          projectName: graph.projectName,
          nodes: graph.nodes,
          missing,
          runtime: wiring?.runtime ?? null,
          edges: wiring?.edges ?? [],
          repo,
        });
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(text);
        return;
      }

      /*
       * Everything Notch has actually said to Zerops.
       *
       * The evidential endpoint. An app that draws infrastructure diagrams looks, from the
       * outside, exactly like an app that draws pictures — this is the difference, in the form
       * of a list of real requests with real status codes and real timings.
       */
      case '/api/actions': {
        const from = Number(url.searchParams.get('from') ?? '0');
        return sendJson(res, 200, {
          actions: journal.since(Number.isFinite(from) ? from : 0),
          counts: journal.counts(),
        });
      }

      /*
       * Plain English in, a service set with an argument out.
       */
      case '/api/architect': {
        const c = requireClient(req, res);
        if (c === null) return;
        const body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
        const agent = String(body['agent'] ?? '');
        const description = String(body['description'] ?? '').trim();
        if (agent === '' || description === '') {
          return sendJson(res, 400, { error: 'missing_params', message: 'agent and description are both required' });
        }
        /*
         * The vocabulary is the LIVE catalogue, not a constant. An agent that proposes a
         * service this account cannot actually create has proposed nothing, and the only way
         * to know which those are is to ask.
         */
        const vocabulary = (await c.serviceTypes()).map((t) => t.typeId);
        const d = await design(agent, description, vocabulary, process.cwd());
        await record({
          kind: 'agent_proposed', actor: agent,
          payload: {
            mode: 'architect', description,
            chosen: d.chosen.map((x) => x.type), rejected: d.rejected.map((x) => x.type),
            unavailable: d.unavailable,
          },
        }).catch(() => null);
        return sendJson(res, 200, d);
      }

      /* The lenses the panel argues from. Read by the UI so the list lives in one place. */
      case '/api/swarm/lenses': {
        return sendJson(res, 200, { lenses: LENSES });
      }

      /*
       * One observe → argue → decide → (apply) cycle.
       *
       * `armed` is required to be the literal boolean true. A truthy string is not consent to
       * spend money on somebody's account, and `"false"` is truthy.
       */
      case '/api/swarm/cycle': {
        const c = requireClient(req, res);
        if (c === null) return;
        const body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
        const projectId = String(body['projectId'] ?? '');
        const serviceId = String(body['serviceId'] ?? '');
        if (projectId === '' || serviceId === '') {
          return sendJson(res, 400, { error: 'missing_params', message: 'projectId and serviceId are both required' });
        }

        const services = await c.services(projectId);
        const svc = services.find((x) => x.id === serviceId);
        if (svc === undefined) {
          return sendJson(res, 404, { error: 'no_such_service', message: 'That service is not in this project.' });
        }

        const agents = available().map((a) => a.id);
        if (agents.length === 0) {
          return sendJson(res, 400, {
            error: 'no_agents',
            message: 'No agent CLIs are installed on this machine, so there is no panel to convene.',
          });
        }

        const port = svc.ports.find((p) => p.httpRouting === true)?.port ?? svc.ports[0]?.port ?? null;
        const liveUrl = port === null ? null : await c.publicUrl(projectId, svc.name, port).catch(() => null);

        /*
         * The ceiling is clamped SERVER-SIDE as well as in the decision layer. The client is
         * the thing an attacker or a bug controls; `ceiling: 9999` arriving in a request body
         * must not become 9999 containers.
         */
        const ceiling = Math.min(Math.max(Number(body['ceiling'] ?? 3), 1), 5);
        const floor = Math.min(Math.max(Number(body['floor'] ?? 1), 1), ceiling);
        const armed = body['armed'] === true;

        const run: Cycle = await cycle(c, {
          service: { id: svc.id, name: svc.name },
          url: liveUrl,
          bounds: { floor, ceiling },
          agents,
          cwd: process.cwd(),
          armed,
          load: {
            count: Math.min(Math.max(Number(body['requests'] ?? 24), 1), 200),
            concurrency: Math.min(Math.max(Number(body['concurrency'] ?? 6), 1), 20),
          },
        });

        await record({
          kind: run.applied === null ? 'swarm_decided' : 'swarm_applied',
          scope: projectId,
          actor: 'swarm',
          payload: {
            service: svc.name,
            armed,
            verb: run.decision.verb,
            votes: `${run.decision.votes}/${run.decision.of}`,
            rationale: run.decision.rationale,
            proposals: run.decision.proposals.map((p) => ({ lens: p.lens, agent: p.agent, verb: p.verb, because: p.because })),
            target: run.decision.target,
            processId: run.applied?.processId ?? null,
            verified: run.applied?.verified ?? null,
            p95: run.signals.load.p95,
            errorRate: run.signals.load.errorRate,
            containers: run.signals.containers.active,
          },
        }).catch(() => null);

        return sendJson(res, 200, run);
      }

      case '/api/drift': {
        if (refuseIfPublic(res, 'Scanning a repository')) return;
        const c = requireClient(req, res);
        if (c === null) return;
        const projectId = url.searchParams.get('projectId');
        const dir = url.searchParams.get('dir');
        if (projectId === null || dir === null) {
          return sendJson(res, 400, { error: 'missing_params', message: 'projectId and dir are both required' });
        }
        if (!existsSync(dir)) {
          return sendJson(res, 400, { error: 'no_such_dir', message: `${dir} does not exist on this machine` });
        }
        const project = (await c.projects()).find((p) => p.id === projectId);
        if (project === undefined) {
          return sendJson(res, 404, {
            error: 'no_such_project',
            projectId,
            message: 'That project is not on this account any more. It may have been deleted, or this token may belong to a different account.',
          });
        }

        const files = await readRepo(dir);
        const required = scanRepo(files);
        const graph = buildGraph(project, await c.services(projectId));
        const drift = computeDrift(required, graph.nodes);
        /*
         * `missing` is stored as a flat array of type names specifically so the history query
         * can unnest it. Recording the whole report instead would make "how long has qdrant
         * been missing" a JSON-shape archaeology problem rather than one GROUP BY.
         */
        const logged = await record({
          kind: 'repo_scanned',
          scope: projectId,
          payload: {
            dir,
            scanned: files.map((f) => f.path),
            missing: drift.items.filter((i) => i.status === 'missing').map((i) => i.type),
            satisfied: drift.counts.satisfied,
            unreferenced: drift.counts.unreferenced,
          },
        });
        /*
         * Config drift rides along with the service drift, because they are the same question
         * asked of two different layers and answering only the first is how an app gets
         * deployed with every service it needs and no way to authenticate.
         */
        const config = compareConfig(
          findSecretNames(files),
          project.envList.map((e) => e.key),
          [...graph.nodes.map((n) => n.name), ...graph.nodes.map((n) => n.typeName)],
        );

        // Edges the platform does not know about yet, read from the same evidence.
        const wiring = deriveWiring(required, graph.nodes, graph.edges.length);

        const history = logged.persisted ? await unresolvedDrift(projectId).catch(() => []) : [];
        return sendJson(res, 200, {
          wiring,
          config,
          history,
          ...(logged.persisted ? {} : { historyNote: `This scan was not recorded: ${logged.reason}. The findings below are still real; only the history is missing.` }),
          dir,
          scanned: files.map((f) => f.path),
          required,
          drift,
          graph: { ...graph, nodes: layout(graph.nodes) },
          // Said explicitly: an empty scan is a real answer, and it is not "you need nothing".
          ...(files.length === 0
            ? { note: `No recognised manifests in ${dir}. That is not the same as "this repo needs nothing" -- it means there was nothing here to read.` }
            : {}),
        });
      }

      /**
       * What WOULD be provisioned. Read-only, and it exists so nothing writes to an account
       * without the exact import file having been shown first. A button that creates real
       * infrastructure should never be the first time you learn what it creates.
       */
      case '/api/provision/plan': {
        const c = requireClient(req, res);
        if (c === null) return;
        const body = (await readBody(req)) as { projectId?: unknown; types?: unknown; ha?: unknown };
        const plan = await buildPlan(c, body);
        if ('error' in plan) return sendJson(res, 400, plan);
        return sendJson(res, 200, plan);
      }

      /** Creates real services that consume real account resources. POST, never GET. */
      case '/api/provision': {
        if (req.method !== 'POST') {
          return sendJson(res, 405, {
            error: 'method_not_allowed',
            message: 'Provisioning must be a POST -- it creates real services on your Zerops account.',
          });
        }
        const c = requireClient(req, res);
        if (c === null) return;
        const body = (await readBody(req)) as { projectId?: unknown; types?: unknown; ha?: unknown };
        const plan = await buildPlan(c, body);
        if ('error' in plan) return sendJson(res, 400, plan);
        if (plan.services.length === 0) {
          return sendJson(res, 400, { error: 'nothing_to_do', message: 'No resolvable services were requested.' });
        }

        /*
         * One writer per project. The TTL is short because an import is quick; if this
         * container dies mid-request the lock frees itself rather than wedging the project.
         */
        /*
         * The holder must be unique PER REQUEST, not per client.
         *
         * First attempt keyed this on the user-agent, and the lock then failed to block
         * anything: `acquire` treats a same-holder acquire as an idempotent renewal (which is
         * correct -- an agent re-acquiring its own lock should not deadlock itself), so two
         * simultaneous requests from one browser had an identical holder, both "renewed" the
         * same lock, and both called Zerops. The second came back with a raw
         * "Project has already serviceStack with the same name" instead of the clean 409 this
         * lock exists to produce. Two concurrent requests are two actors, whatever browser
         * they came from.
         */
        const holder = `ui:${randomUUID()}`;
        const got = await locks.acquire(`provision:${plan.projectId}`, holder, { scope: plan.projectId, ttlSec: 120 });
        if (!got.ok) {
          return sendJson(res, 409, {
            error: 'provision_in_progress',
            message: `Another provision is already running on this project (held by ${got.heldBy}). It frees itself in ${got.availableInSec}s.`,
            heldBy: got.heldBy,
            availableInSec: got.availableInSec,
          });
        }

        try {
          await c.importServices(plan.projectId, plan.yaml);
          await record({
            kind: 'provision_succeeded',
            scope: plan.projectId,
            payload: { created: plan.services, unresolved: plan.unresolved, yaml: plan.yaml },
          });
        } catch (err) {
          await record({
            kind: 'provision_failed',
            scope: plan.projectId,
            payload: { attempted: plan.services, error: err instanceof ZeropsApiError ? err.apiMessage : String(err) },
          });
          throw err;
        } finally {
          await locks.release(`provision:${plan.projectId}`, holder, plan.projectId);
        }

        // Re-read rather than assume: the import being accepted is not the same as the
        // services existing, and the UI should redraw from what the platform now reports.
        const project = (await c.projects()).find((x) => x.id === plan.projectId);
        const graph = project === undefined ? null : buildGraph(project, await c.services(plan.projectId));
        return sendJson(res, 200, {
          created: plan.services,
          yaml: plan.yaml,
          unresolved: plan.unresolved,
          graph: graph === null ? null : { ...graph, nodes: layout(graph.nodes) },
          note: 'Zerops accepted the import. New services start in CREATING and take a moment to become ACTIVE -- refresh to watch them settle.',
        });
      }

      /**
       * Hold two environments against each other.
       *
       * The view Zerops cannot give you, because Zerops shows one project at a time — and one
       * project at a time is precisely the view in which dev, stage and prod drift apart. The
       * comparison is pure and tested; this endpoint only fetches the two sides.
       */
      case '/api/compare': {
        const c = requireClient(req, res);
        if (c === null) return;
        const aId = url.searchParams.get('a');
        const bId = url.searchParams.get('b');
        if (aId === null || bId === null) {
          return sendJson(res, 400, { error: 'missing_params', message: 'Two project ids are required: ?a=…&b=…' });
        }
        if (aId === bId) {
          return sendJson(res, 400, { error: 'same_project', message: 'Pick two different projects.' });
        }

        const projects = await c.projects();
        const snapshot = async (id: string): Promise<EnvSnapshot | null> => {
          const p = projects.find((x) => x.id === id);
          if (p === undefined) return null;
          const g = buildGraph(p, await c.services(id));
          return {
            projectId: p.id,
            name: p.name,
            envKeys: p.envList.map((e) => e.key),
            services: g.nodes
              // System services exist on every project by construction; comparing them would
              // report `core` as identical every time and say nothing.
              .filter((n) => !n.system)
              .map((n) => ({
                name: n.name,
                type: n.typeName.toLowerCase().replace(/\s+/g, ''),
                version: n.version ?? '?',
                mode: n.ha ? 'HA' : n.containers === null ? null : 'NON_HA',
                publicHttp: n.publicHttp,
              })),
          };
        };

        const [a, b] = await Promise.all([snapshot(aId), snapshot(bId)]);
        if (a === null || b === null) {
          return sendJson(res, 404, { error: 'no_such_project', message: 'One of those projects is not on this account any more.' });
        }
        return sendJson(res, 200, compareEnvironments(a, b));
      }

      /**
       * Deploy the repository to its runtime, and hand back the URL.
       *
       * The step that turns "your project has six empty services" into "your app is running".
       * Streams zcli's own output as it happens — a build is four minutes of real work and a
       * spinner would be hiding the only interesting part.
       *
       * This WRITES, and it runs the build the repository committed. Notch chooses what and
       * where; `zerops.yml` decides how.
       */
      case '/api/deploy': {
        if (refuseIfPublic(res, 'Deploying with zcli')) return;
        if (req.method !== 'POST') {
          return sendJson(res, 405, { error: 'method_not_allowed', message: 'POST -- this deploys real code.' });
        }
        const c = requireClient(req, res);
        if (c === null) return;
        const body = (await readBody(req)) as { projectId?: unknown; serviceId?: unknown; dir?: unknown; setup?: unknown };
        const projectId = typeof body.projectId === 'string' ? body.projectId : '';
        const dir = typeof body.dir === 'string' ? body.dir : '';
        let serviceId = typeof body.serviceId === 'string' ? body.serviceId : '';
        const setup = typeof body.setup === 'string' && body.setup !== '' ? body.setup : 'nodejs';
        if (projectId === '' || dir === '') {
          return sendJson(res, 400, { error: 'missing_params', message: 'A project and a repository path are required.' });
        }

        const check = readiness(dir);
        if (!check.ready) {
          return sendJson(res, 400, { error: 'not_deployable', message: check.problems.join(' '), problems: check.problems });
        }

        const services = await c.services(projectId);
        // Default to the project's runtime: the thing code actually runs on. A database has
        // nothing to deploy to it, and picking one would produce a baffling platform error.
        if (serviceId === '') {
          const runtime = services.find((s) =>
            RUNTIME_TYPES.some((t) => s.serviceStackTypeId.toLowerCase().includes(t)));
          if (runtime === undefined) {
            return sendJson(res, 400, {
              error: 'no_runtime',
              message: 'This project has no runtime service to deploy onto. Provision one first.',
            });
          }
          serviceId = runtime.id;
        }
        const target = services.find((s) => s.id === serviceId);

        const tokenForCli = process.env['ZEROPS_TOKEN'] ?? currentSession(req)?.token ?? null;
        if (tokenForCli === null || tokenForCli === '') {
          return sendJson(res, 400, {
            error: 'no_token',
            message: 'The deploy runs through zcli, which needs the token in its environment.',
          });
        }

        await record({
          kind: 'deploy_started', scope: projectId,
          payload: { service: target?.name ?? serviceId, dir, setup },
        });

        // Answer now, work in the background: the log is the point and it takes minutes.
        reapDeploys();
        const runId = randomUUID();
        const run: DeployRun = {
          lines: [], done: false, ok: null, url: null, note: '', health: null, startedAt: Date.now(),
        };
        deploys.set(runId, run);

        const svcId = serviceId;
        void (async () => {
          try {
            const r = await push(tokenForCli, svcId, dir, setup, (line) => run.lines.push(line));

            let after = (await c.services(projectId)).find((s) => s.id === svcId);
            const servesHttp = after?.ports.some((x) => x.httpRouting === true) === true;
            if (r.ok && after !== undefined && servesHttp && after.subdomainAccess !== true) {
              run.lines.push('· asking Zerops for a public subdomain');
              await c.enableSubdomain(svcId).catch(() => null);
              await new Promise((ok) => setTimeout(ok, 2500));
              after = (await c.services(projectId)).find((s) => s.id === svcId);
            }

            const port = after?.ports.find((x) => x.httpRouting === true)?.port ?? after?.ports[0]?.port ?? 3000;
            const url = (after?.subdomainAccess === true || after?.hasPublicHttpRoutingAccess === true)
              && after !== undefined
              ? await c.publicUrl(projectId, after.name, port).catch(() => null)
              : null;
            run.url = url;

            // Deployed is not the same as up. Ask the URL the way a user would.
            if (r.ok && url !== null) {
              run.lines.push(`· checking ${url}`);
              run.health = await checkHealth(url);
              run.lines.push(run.health === null
                ? '· no answer yet — the router may still be settling'
                : `· answered HTTP ${run.health.status} in ${run.health.ms}ms`);
            }

            run.ok = r.ok;
            run.note = r.ok
              ? (url === null
                ? 'Deployed. This service has no public subdomain, so there is no address to open.'
                : run.health === null
                  ? 'Deployed. The address is live but has not answered yet — give it a moment and reload.'
                  : `Deployed and answering (HTTP ${run.health.status}).`)
              : 'Zerops rejected the build. The log above is what it said.';

            await record({
              kind: r.ok ? 'deploy_succeeded' : 'deploy_failed',
              scope: projectId,
              payload: {
                service: target?.name ?? svcId, ms: r.ms, code: r.code, url,
                health: run.health, tail: r.log.slice(-6),
              },
            });
          } catch (err) {
            run.ok = false;
            run.note = DeployError.is(err) ? err.message : String(err);
            if (DeployError.is(err) && err.detail !== '') run.lines.push(err.detail);
            await record({ kind: 'deploy_failed', scope: projectId, payload: { error: run.note } });
          } finally {
            run.done = true;
          }
        })();

        return sendJson(res, 202, { runId, service: target?.name ?? serviceId });
      }

      /** The transcript of a deploy in flight. Polled; `from` is the line already seen. */
      case '/api/deploy/status': {
        const id = url.searchParams.get('id');
        const from = Number(url.searchParams.get('from') ?? 0);
        if (id === null) return sendJson(res, 400, { error: 'missing_id', message: 'Which deploy?' });
        const run = deploys.get(id);
        if (run === undefined) {
          return sendJson(res, 404, {
            error: 'no_such_deploy',
            message: 'That deploy is not in flight. The daemon may have restarted; the timeline has the outcome.',
          });
        }
        return sendJson(res, 200, {
          lines: run.lines.slice(Number.isFinite(from) ? from : 0),
          total: run.lines.length,
          done: run.done,
          ok: run.ok,
          url: run.url,
          note: run.note,
          health: run.health,
        });
      }

      /** Which coding agents are installed on this machine. */
      case '/api/agents': {
        return sendJson(res, 200, { agents: available() });
      }

      /**
       * Ask one of them about this account's infrastructure.
       *
       * The agent is spawned locally and handed the live state — services, gaps, and the file
       * evidence behind each gap — so its answer is grounded in the same facts the UI shows
       * rather than in what a model assumes a repo like this usually needs.
       *
       * READ-ONLY BY CONSTRUCTION. Nothing here can provision; that stays behind the preview a
       * human confirms. The exchange is written to the same append-only log as everything
       * else, so "what did the agent tell me last Tuesday" has an answer.
       */
      case '/api/chat': {
        if (req.method !== 'POST') {
          return sendJson(res, 405, { error: 'method_not_allowed', message: 'POST a question.' });
        }
        const c = requireClient(req, res);
        if (c === null) return;
        const body = (await readBody(req)) as { agent?: unknown; prompt?: unknown; projectId?: unknown; dir?: unknown };
        const agent = typeof body.agent === 'string' ? body.agent : '';
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        const projectId = typeof body.projectId === 'string' ? body.projectId : '';
        const dir = typeof body.dir === 'string' ? body.dir : '';
        if (agent === '' || prompt === '') {
          return sendJson(res, 400, { error: 'missing_params', message: 'An agent and a question are required.' });
        }

        const project = (await c.projects()).find((p) => p.id === projectId);
        if (project === undefined) {
          return sendJson(res, 404, { error: 'no_such_project', message: 'Pick a project first.' });
        }
        const services = await c.services(projectId);
        const graph = buildGraph(project, services);

        const files = dir !== '' && existsSync(dir) ? await readRepo(dir) : [];
        const required = scanRepo(files);
        const drift = computeDrift(required, graph.nodes);

        const context = brief({
          projectName: project.name,
          projectStatus: project.status,
          services: graph.nodes.map((n) => ({ name: n.name, type: n.typeName, status: n.status })),
          missing: drift.items.filter((i) => i.status === 'missing').map((i) => ({
            type: i.type,
            why: i.summary,
            evidence: (i.required?.evidence ?? []).map((e) => `${e.found} in ${e.path}`),
          })),
          satisfied: drift.items.filter((i) => i.status === 'satisfied').map((i) => i.type),
          dir,
          scanned: files.map((f) => f.path),
        });

        try {
          const r = await ask(agent, `${context}\nQUESTION: ${prompt}\n`, dir);
          await record({
            kind: 'agent_answered',
            scope: projectId,
            actor: agent,
            payload: { prompt, agent: r.agent, ms: r.ms, chars: r.reply.length },
          });
          return sendJson(res, 200, r);
        } catch (err) {
          if (AgentError.is(err)) {
            return sendJson(res, 502, { error: 'agent_failed', message: err.message, detail: err.detail });
          }
          throw err;
        }
      }

      /**
       * Let an agent draft the fix — and nothing more than draft it.
       *
       * The agent returns a list of service types from a closed vocabulary. Those go through
       * the SAME planner the button uses, so versions come from the live catalogue and
       * hostnames from the collision-safe rules, and the result lands in the SAME preview that
       * still needs a human to confirm it. An agent cannot invent a version, cannot name a
       * service the platform does not have, and cannot cause a write.
       */
      case '/api/chat/propose': {
        if (req.method !== 'POST') {
          return sendJson(res, 405, { error: 'method_not_allowed', message: 'POST to ask for a proposal.' });
        }
        const c = requireClient(req, res);
        if (c === null) return;
        const body = (await readBody(req)) as { agent?: unknown; projectId?: unknown; dir?: unknown; ha?: unknown };
        const agent = typeof body.agent === 'string' ? body.agent : '';
        const projectId = typeof body.projectId === 'string' ? body.projectId : '';
        const dir = typeof body.dir === 'string' ? body.dir : '';
        if (agent === '' || projectId === '') {
          return sendJson(res, 400, { error: 'missing_params', message: 'An agent and a project are required.' });
        }

        const project = (await c.projects()).find((p) => p.id === projectId);
        if (project === undefined) return sendJson(res, 404, { error: 'no_such_project', message: 'Pick a project first.' });

        const graph = buildGraph(project, await c.services(projectId));
        const files = dir !== '' && existsSync(dir) ? await readRepo(dir) : [];
        const drift = computeDrift(scanRepo(files), graph.nodes);

        const context = brief({
          projectName: project.name,
          projectStatus: project.status,
          services: graph.nodes.map((n) => ({ name: n.name, type: n.typeName, status: n.status })),
          missing: drift.items.filter((i) => i.status === 'missing').map((i) => ({
            type: i.type, why: i.summary,
            evidence: (i.required?.evidence ?? []).map((e) => `${e.found} in ${e.path}`),
          })),
          satisfied: drift.items.filter((i) => i.status === 'satisfied').map((i) => i.type),
          dir,
          scanned: files.map((f) => f.path),
        });

        try {
          const r = await ask(agent, context + proposeInstruction(SERVICE_TYPES), dir, 180_000);
          const proposal = parseProposal(r.reply, SERVICE_TYPES);
          if (proposal.types.length === 0) {
            return sendJson(res, 200, {
              agent: r.agent, ms: r.ms, proposal,
              plan: null,
              note: `${r.agent} proposed nothing to add.`,
            });
          }

          // The same planner, the same preview, the same confirmation.
          const plan = await buildPlan(c, { projectId, types: proposal.types, ha: body.ha === true, dir });
          if ('error' in plan) return sendJson(res, 400, plan);

          await record({
            kind: 'agent_proposed',
            scope: projectId,
            actor: agent,
            payload: { types: proposal.types, rejected: proposal.rejected, agent: r.agent, ms: r.ms },
          });
          return sendJson(res, 200, { agent: r.agent, ms: r.ms, proposal, plan });
        } catch (err) {
          if (AgentError.is(err)) {
            return sendJson(res, 502, { error: 'agent_failed', message: err.message, detail: err.detail });
          }
          throw err;
        }
      }

      /** The persisted history. This is the half a live view cannot give you. */
      case '/api/history': {
        const scope = url.searchParams.get('projectId') ?? undefined;
        // Account-level events (connecting, disconnecting) are included: they are the context
        // for everything else in the list, and a strictly scoped read hid them entirely.
        const [events, byKind] = await Promise.all([
          readEvents(scope === undefined ? {} : { scope, limit: 100, includeAccountLevel: true }),
          stats(scope, { includeAccountLevel: true }),
        ]);
        return sendJson(res, 200, { events, byKind });
      }

      /**
       * Export a `zerops.yaml` for what the repo needs.
       *
       * Zerops' own workflow is an import file, so the most useful thing this app can hand
       * back is the file the developer should have had -- committable, reviewable in a pull
       * request, and usable with `zcli` or the GUI without Brain running at all.
       */
      case '/api/export': {
        if (refuseIfPublic(res, 'Exporting a yaml built from a local repo')) return;
        const c = requireClient(req, res);
        if (c === null) return;
        const dir = url.searchParams.get('dir');
        const projectId = url.searchParams.get('projectId');
        if (dir === null || projectId === null) return sendJson(res, 400, { error: 'missing_params', message: 'dir and projectId are required' });
        if (!existsSync(dir)) return sendJson(res, 400, { error: 'no_such_dir', message: `${dir} does not exist on this machine` });

        const files = await readRepo(dir);
        const required = scanRepo(files);
        const catalog = new ServiceCatalog(c);
        const ha = url.searchParams.get('ha') === 'true';

        const resolved: Array<{ hostname: string; type: string; mode: 'HA' | 'NON_HA'; why: string }> = [];
        const unresolved: string[] = [];
        const taken: string[] = [];
        for (const r of required) {
          const spec = await catalog.resolve(r.type, ha);
          if (spec === null) { unresolved.push(r.type); continue; }
          const hostname = safeHostname(r.type, taken);
          taken.push(hostname);
          resolved.push({ hostname, ...spec, why: r.evidence[0]?.because ?? 'required by this repo' });
        }

        // Comments carry the evidence into the file, so a reviewer reading the pull request
        // sees WHY each service is there without needing this app open.
        const header = [
          '# zerops.yaml -- generated by Brain from this repository.',
          `# Source: ${dir}`,
          `# Read from: ${files.map((f) => f.path).join(', ') || 'no recognised manifests'}`,
          '#',
          '# Every service below is here because something in the repo asked for it. The',
          '# reason is on the line above each one. Check them before importing -- an env var',
          '# name can point at a service that lives outside this project.',
          ...(unresolved.length > 0
            ? ['#', `# NOT INCLUDED (no matching Zerops service type): ${unresolved.join(', ')}`]
            : []),
          '',
        ].join('\n');

        /*
         * Secrets go on the runtime, as generator expressions rather than values. This file is
         * meant to be committed, so it must name what the app needs without containing any of
         * it -- Zerops evaluates `generateRandomString` on import.
         */
        const secretNames = findSecretNames(files);
        const runtimeHost = resolved.find((r) => isRuntimeType(r.type))?.hostname;

        const body = resolved.length === 0
          ? 'services: []\n'
          : 'services:\n' + resolved.map((r) => {
              const lines = [`  # ${r.why}`, `  - hostname: ${r.hostname}`, `    type: ${r.type}`, `    mode: ${r.mode}`];
              if (r.hostname === runtimeHost) {
                lines.push('    enableSubdomainAccess: true');
                if (secretNames.length > 0) {
                  lines.push('    envSecrets:');
                  for (const k of secretNames) lines.push(`      ${k}: <@generateRandomString(<32>)>`);
                }
              }
              return `${lines.join('\n')}\n`;
            }).join('');

        await record({ kind: 'yaml_exported', scope: projectId, payload: { dir, services: resolved.length, unresolved } });

        const yaml = header + body;
        res.writeHead(200, {
          'content-type': 'application/x-yaml; charset=utf-8',
          'content-disposition': 'attachment; filename="zerops.yaml"',
          'cache-control': 'no-store',
        });
        res.end(yaml);
        return;
      }

      default:
        return sendJson(res, 404, { error: 'not_found', path, message: `No such endpoint: ${path}` });
    }
  } catch (err) {
    sendError(res, err);
  }
}

/**
 * Install the credential this process holds. The ONE place that state changes.
 *
 * Both entry points into a session go through here — the `/api/session` endpoint and the
 * development `ZEROPS_TOKEN` path — so there is a single line to look at when asking "when can
 * this become non-null". It is exported because `ZeropsClient` takes its own `fetch`, which
 * makes a session against a scripted Zerops constructible without a network or a real token.
 */
/**
 * Tests reach in here rather than going through the token gate.
 *
 * Kept because the suites use it, but it now writes into the same session table everything
 * else reads from — a second code path for "who is logged in" is how the two drift apart.
 * The fixed id means a test client is found by a request carrying no cookie at all.
 */
export const TEST_SID = 'test-session';
export function installClient(c: ZeropsClient | null): void {
  if (c === null) sessions.delete(TEST_SID);
  else sessions.set(TEST_SID, { client: c, token: 'test', lastSeen: Date.now() });
}

/** Port 0 asks the OS for a free one; the caller reads it back off the returned server. */
export function startServer(port: number, host: string, opts: { quiet?: boolean } = {}): Promise<Server> {
  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => sendError(res, e));
  });
  return new Promise((ok) => {
    server.listen(port, host, () => {
      if (opts.quiet !== true) {
        console.log(`[brain] http://${host}:${port}`);
        console.log('[brain] no token held yet -- paste one in the UI. It stays in memory and is never written to disk.');
      }
      ok(server);
    });
  });
}

function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return resolve(fileURLToPath(import.meta.url)) === resolve(argv1);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const port = Number(process.env['PORT'] ?? 7799);
  const host = process.env['HOST'] ?? '127.0.0.1';
  // A token in the environment is a convenience for development only; the UI path never
  // needs it and the app does not persist one.
  const envToken = process.env['ZEROPS_TOKEN'];
  if (envToken !== undefined && envToken.trim() !== '') {
    if (PUBLIC) {
      /*
       * Refused, loudly, rather than ignored.
       *
       * `installClient` seeds the shared cookie-less session — exactly right on a desktop, and
       * on a public instance it would hand the operator's own account-level Zerops token to
       * every visitor who loaded the page. Whoever set this on a hosted deployment meant
       * something else, so say so instead of quietly doing the dangerous thing.
       */
      console.error('[brain] REFUSING ZEROPS_TOKEN: this instance is public (NOTCH_PUBLIC=1), ' +
                    'and an environment token would be shared with every visitor. ' +
                    'Visitors paste their own token; unset ZEROPS_TOKEN.');
    } else {
      installClient(new ZeropsClient(envToken.trim()));
      console.log(`[brain] using ZEROPS_TOKEN from the environment (${redactToken(envToken.trim())})`);
    }
  }
  // Schema first: the event log is part of the product, not an optional extra, and a
  // half-migrated database would fail on the first scan rather than at boot.
  await migrate();
  await startServer(port, host);
}
