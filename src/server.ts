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
import { SCAN_GLOBS, findSecretNames, scanRepo, type RepoFile } from './repo/scan.js';
import { ServiceCatalog, buildImportYaml, safeHostname, type ImportService } from './zerops/catalog.js';
import type { ServiceType } from './repo/scan.js';
import { read as readEvents, record, stats, unresolvedDrift } from './db/events.js';
import { AgentError, ask, available, brief } from './agents.js';
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
let client: ZeropsClient | null = null;

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

function requireClient(res: ServerResponse): ZeropsClient | null {
  if (client === null) {
    sendJson(res, 401, { error: 'no_session', message: 'Paste a Zerops Personal Access Token first.' });
    return null;
  }
  return client;
}

/** A malformed request body is the CLIENT's mistake, so it must not surface as a 500. */
class BadRequest extends Error {
  constructor(message: string) { super(message); this.name = 'BadRequest'; }
  static is(e: unknown): e is BadRequest { return e instanceof Error && e.name === 'BadRequest'; }
}

const MAX_BODY_BYTES = 256 * 1024;

/** Service types that RUN the application, as opposed to backing it. */
const RUNTIME_TYPES = ['nodejs', 'python', 'go', 'php', 'dotnet', 'rust', 'java', 'bun', 'deno', 'elixir', 'ruby'];

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
  const runtime = services.find((s) => RUNTIME_TYPES.some((r) => s.type.startsWith(r)));
  if (runtime !== undefined) {
    if (secrets.length > 0) runtime.secrets = secrets;
    runtime.publicUrl = true;
  }

  return { projectId, services, unresolved, secrets, yaml: buildImportYaml(services) };
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
          installClient(null);
          await record({ kind: 'session_closed', payload: {} });
          return sendJson(res, 200, { ok: true, message: 'token discarded' });
        }
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed', message: 'Use POST to open a session, or DELETE to close one.' });
        const body = (await readBody(req)) as { token?: unknown };
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        if (token === '') return sendJson(res, 400, { error: 'missing_token', message: 'A Zerops Personal Access Token is required.' });

        const candidate = new ZeropsClient(token);
        const v = await candidate.verify();
        if (!v.ok) {
          installClient(null);
          return sendJson(res, v.isAuthFailure ? 401 : 502, { error: 'token_rejected', message: v.reason });
        }
        installClient(candidate);
        await record({ kind: 'session_opened', payload: { email: v.email, projects: v.projectCount } });
        return sendJson(res, 200, v);
      }

      case '/api/session/status': {
        if (client === null) return sendJson(res, 200, { connected: false });
        const v = await client.verify();
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
            installClient(null);
            await record({ kind: 'session_closed', payload: { reason: 'token rejected by Zerops' } });
            return sendJson(res, 200, { connected: false, reason: v.reason });
          }
          return sendJson(res, 200, { connected: true, degraded: true, reason: v.reason });
        }
        return sendJson(res, 200, { connected: true, ...v });
      }

      case '/api/projects': {
        const c = requireClient(res);
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
        const c = requireClient(res);
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
        const c = requireClient(res);
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
      case '/api/drift': {
        const c = requireClient(res);
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
        const history = logged.persisted ? await unresolvedDrift(projectId).catch(() => []) : [];
        return sendJson(res, 200, {
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
        const c = requireClient(res);
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
        const c = requireClient(res);
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
        const c = requireClient(res);
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
        const c = requireClient(res);
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
        const runtimeHost = resolved.find((r) => RUNTIME_TYPES.some((t) => r.type.startsWith(t)))?.hostname;

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
export function installClient(c: ZeropsClient | null): void {
  client = c;
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
    installClient(new ZeropsClient(envToken.trim()));
    console.log(`[brain] using ZEROPS_TOKEN from the environment (${redactToken(envToken.trim())})`);
  }
  // Schema first: the event log is part of the product, not an optional extra, and a
  // half-migrated database would fail on the first scan rather than at boot.
  await migrate();
  await startServer(port, host);
}
