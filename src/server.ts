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

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('request body was not JSON');
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
