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
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ZeropsApiError, ZeropsClient, redactToken } from './zerops/api.js';
import { buildGraph, layout } from './zerops/graph.js';
import { computeDrift } from './zerops/drift.js';
import { SCAN_GLOBS, scanRepo, type RepoFile } from './repo/scan.js';
import { ServiceCatalog, buildImportYaml, safeHostname } from './zerops/catalog.js';
import type { ServiceType } from './repo/scan.js';

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
};

/**
 * The one piece of mutable state, and it is deliberately not persisted.
 *
 * A PAT written to disk is a PAT that outlives the session that needed it. The cost is
 * re-pasting after a restart; the benefit is that closing the app disposes of the credential.
 */
let client: ZeropsClient | null = null;

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
  services: Array<{ hostname: string; type: string; mode: 'HA' | 'NON_HA' }>;
  /** Requested types the platform has no equivalent for. Reported, never silently dropped. */
  unresolved: string[];
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
  body: { projectId?: unknown; types?: unknown; ha?: unknown },
): Promise<Plan | { error: string; message: string }> {
  const projectId = typeof body.projectId === 'string' ? body.projectId : '';
  const types = Array.isArray(body.types) ? body.types.filter((t): t is string => typeof t === 'string') : [];
  const ha = body.ha === true;
  if (projectId === '' || types.length === 0) {
    return { error: 'missing_params', message: 'projectId and a non-empty types[] are required.' };
  }

  const project = (await c.projects()).find((p) => p.id === projectId);
  if (project === undefined) return { error: 'no_such_project', message: `No project ${projectId} on this account.` };

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

  return { projectId, services, unresolved, yaml: buildImportYaml(services) };
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

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  if (!path.startsWith('/api/')) return serveStatic(res, path);

  try {
    switch (path) {
      /** Paste a token. Verified by a real API call, not by checking it is non-empty. */
      case '/api/session': {
        if (req.method === 'DELETE') {
          client = null;
          return sendJson(res, 200, { ok: true, message: 'token discarded' });
        }
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
        const body = (await readBody(req)) as { token?: unknown };
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        if (token === '') return sendJson(res, 400, { error: 'missing_token', message: 'A Zerops Personal Access Token is required.' });

        const candidate = new ZeropsClient(token);
        const v = await candidate.verify();
        if (!v.ok) {
          client = null;
          return sendJson(res, v.isAuthFailure ? 401 : 502, { error: 'token_rejected', message: v.reason });
        }
        client = candidate;
        return sendJson(res, 200, v);
      }

      case '/api/session/status': {
        if (client === null) return sendJson(res, 200, { connected: false });
        return sendJson(res, 200, { connected: true, ...(await client.verify()) });
      }

      case '/api/projects': {
        const c = requireClient(res);
        if (c === null) return;
        return sendJson(res, 200, { projects: await c.projects() });
      }

      /** The architecture, laid out and ready for React Flow. */
      case '/api/graph': {
        const c = requireClient(res);
        if (c === null) return;
        const projectId = url.searchParams.get('projectId');
        if (projectId === null) return sendJson(res, 400, { error: 'missing_projectId' });
        const project = (await c.projects()).find((p) => p.id === projectId);
        if (project === undefined) return sendJson(res, 404, { error: 'no_such_project', projectId });
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
        if (project === undefined) return sendJson(res, 404, { error: 'no_such_project', projectId });

        const files = await readRepo(dir);
        const required = scanRepo(files);
        const graph = buildGraph(project, await c.services(projectId));
        const drift = computeDrift(required, graph.nodes);
        return sendJson(res, 200, {
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
          return sendJson(res, 405, { error: 'method_not_allowed', note: 'POST -- this creates real services on your Zerops account' });
        }
        const c = requireClient(res);
        if (c === null) return;
        const body = (await readBody(req)) as { projectId?: unknown; types?: unknown; ha?: unknown };
        const plan = await buildPlan(c, body);
        if ('error' in plan) return sendJson(res, 400, plan);
        if (plan.services.length === 0) {
          return sendJson(res, 400, { error: 'nothing_to_do', message: 'No resolvable services were requested.' });
        }

        await c.importServices(plan.projectId, plan.yaml);
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

      default:
        return sendJson(res, 404, { error: 'not_found', path });
    }
  } catch (err) {
    sendError(res, err);
  }
}

export function startServer(port: number, host: string): Promise<void> {
  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => sendError(res, e));
  });
  return new Promise((ok) => {
    server.listen(port, host, () => {
      console.log(`[brain] http://${host}:${port}`);
      console.log('[brain] no token held yet -- paste one in the UI. It stays in memory and is never written to disk.');
      ok();
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
    client = new ZeropsClient(envToken.trim());
    console.log(`[brain] using ZEROPS_TOKEN from the environment (${redactToken(envToken.trim())})`);
  }
  await startServer(port, host);
}
