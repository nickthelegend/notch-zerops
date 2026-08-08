/**
 * The HTTP layer, end to end.
 *
 * A real `http.Server` on a real port, a real Postgres behind it, and a real `ZeropsClient`
 * whose `fetch` is scripted. Nothing inside the app is stubbed — the routing, body parsing,
 * error mapping, drift computation, plan building and the provisioning lock all execute. Only
 * the far side of the network is scripted, because a test suite must not create infrastructure
 * on somebody's account, and because the failure modes worth pinning here (a project that
 * vanished, a rejected import, two writers at once) are awkward to arrange on a live account
 * and trivial to arrange on a scripted one.
 *
 * `installClient` is the seam. `ZeropsClient` already accepts its own `fetch`, so a session
 * against a scripted Zerops is constructible without a token and without the network.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { Server } from 'node:http';

import { installClient, startServer } from '../src/server.js';
import { ZeropsClient } from '../src/zerops/api.js';
import { closePool } from '../src/db/pool.js';
import { describeIfDb, uniqueId } from './helpers/db.js';

const PROJECT = uniqueId('srv').replace(/[^a-zA-Z0-9]/g, '');

const USER = { id: 'u1', email: 'tester@example.test', clientUserList: [{ clientId: 'C1' }] };
const PROJECTS = [{ id: PROJECT, name: 'audit-fixture', status: 'ACTIVE', clientId: 'C1' }];
const SERVICES = [
  {
    id: 's1', name: 'app', status: 'ACTIVE', projectId: PROJECT, serviceStackTypeId: 'nodejs',
    mode: 'NON_HA', ports: [], connectedStacks: [],
    serviceStackTypeInfo: { serviceStackTypeName: 'Node.js', serviceStackTypeCategory: 'USER' },
  },
];
const TYPES = [
  { id: 'postgresql', name: 'PostgreSQL', serviceStackTypeVersionList: [{ name: 'postgresql:single@16' }] },
  { id: 'nodejs', name: 'Node.js', serviceStackTypeVersionList: [{ name: 'nodejs@22' }] },
];

/** Scripted Zerops. `onImport` lets one test make the write slow, and another make it fail. */
function zerops(opts: { onImport?: () => Promise<{ status?: number; body: unknown }> } = {}) {
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').replace('/api/rest/public', '');
    calls.push(path);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

    if (path === '/user/info') return json(USER);
    if (path === '/project/search') return json({ items: PROJECTS });
    if (path === '/service-stack/search') return json({ items: SERVICES });
    if (path === '/service-stack-type/search') return json({ items: TYPES });
    if (path.endsWith('/service-stack/import')) {
      if (opts.onImport !== undefined) {
        const r = await opts.onImport();
        return json(r.body, r.status ?? 200);
      }
      return json({ ok: true });
    }
    return json({ error: { message: `unscripted ${path}` } }, 404);
  }) as unknown as typeof fetch;

  return { client: new ZeropsClient('tok_testtest', 'https://api.example.test/api/rest/public', impl), calls };
}

let server: Server;
let base: string;

const get = (p: string) => fetch(`${base}${p}`);
const post = (p: string, body?: unknown, raw?: string) => {
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Spread rather than `body: undefined` — with exactOptionalPropertyTypes an explicit
    // undefined is not the same as an absent property.
    ...(payload === undefined ? {} : { body: payload }),
  });
};

describeIfDb('HTTP API (real server, real Postgres, scripted Zerops)', () => {
  beforeAll(async () => {
    server = await startServer(0, '127.0.0.1', { quiet: true });
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('server did not bind a port');
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => {
    installClient(null);
    await new Promise<void>((ok) => server.close(() => { ok(); }));
    await closePool();
  });
  beforeEach(() => { installClient(null); });

  /* ---------------------------------------------------------------- session */

  it('reports no session before a token is given', async () => {
    const res = await get('/api/session/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
  });

  it('refuses the real endpoints with a sentence, not a bare 401', async () => {
    const res = await get('/api/projects');
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('no_session');
    expect(body.message).toMatch(/Personal Access Token/);
  });

  it('rejects a GET on the session endpoint with a usable message', async () => {
    const res = await get('/api/session');
    expect(res.status).toBe(405);
    expect((await res.json() as { message: string }).message).toMatch(/POST/);
  });

  it('turns malformed JSON into a 400, never a 500', async () => {
    const res = await post('/api/session', undefined, '{ this is not json');
    expect(res.status).toBe(400);
    expect((await res.json() as { message: string }).message).toMatch(/not valid JSON/);
  });

  it('asks for a token rather than trying an empty one', async () => {
    const res = await post('/api/session', { token: '   ' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('missing_token');
  });

  it('caps the request body instead of reading it all into memory', async () => {
    const res = await post('/api/session', undefined, JSON.stringify({ token: 'x'.repeat(300 * 1024) }));
    expect(res.status).toBe(400);
    expect((await res.json() as { message: string }).message).toMatch(/too large/);
  });

  it('DELETE discards the credential', async () => {
    installClient(zerops().client);
    expect((await (await get('/api/session/status')).json() as { connected: boolean }).connected).toBe(true);

    const res = await fetch(`${base}/api/session`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await (await get('/api/session/status')).json()).toEqual({ connected: false });
  });

  it('drops a token Zerops has started rejecting, and returns to no-session', async () => {
    // An auth failure means the credential is genuinely dead: keeping it would leave the UI on
    // a dashboard it can no longer refresh.
    const impl = (async () => new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), { status: 401 })) as unknown as typeof fetch;
    installClient(new ZeropsClient('tok_dead', 'https://api.example.test/api/rest/public', impl));

    const body = await (await get('/api/session/status')).json() as { connected: boolean; reason?: string };
    expect(body.connected).toBe(false);
    expect(body.reason).toMatch(/rejected/);
  });

  it('KEEPS a token when Zerops is merely unreachable', async () => {
    // The opposite case, and the reason the two are distinguished: throwing away a working
    // credential because the network hiccuped would be a worse bug than the one it fixes.
    const impl = (async () => new Response(JSON.stringify({ error: { message: 'upstream down' } }), { status: 503 })) as unknown as typeof fetch;
    installClient(new ZeropsClient('tok_ok', 'https://api.example.test/api/rest/public', impl));

    const body = await (await get('/api/session/status')).json() as { connected: boolean; degraded?: boolean };
    expect(body.connected).toBe(true);
    expect(body.degraded).toBe(true);
  });

  /* ------------------------------------------------------------------ graph */

  it('serves the architecture graph, laid out', async () => {
    installClient(zerops().client);
    const res = await get(`/api/graph?projectId=${PROJECT}`);
    expect(res.status).toBe(200);
    const g = await res.json() as { nodes: { position: { x: number; y: number } }[]; projectName: string };
    expect(g.projectName).toBe('audit-fixture');
    expect(g.nodes[0]?.position).toEqual({ x: 0, y: 0 });
  });

  it('says which project is missing, in a sentence', async () => {
    installClient(zerops().client);
    const res = await get('/api/graph?projectId=GONE');
    expect(res.status).toBe(404);
    // The bare "HTTP 404" the UI used to show came from this body having no message at all.
    expect((await res.json() as { message: string }).message).toMatch(/not on this account/);
  });

  it('asks for a projectId rather than guessing one', async () => {
    installClient(zerops().client);
    const res = await get('/api/graph');
    expect(res.status).toBe(400);
    expect((await res.json() as { message: string }).message).toBeTruthy();
  });

  /* ------------------------------------------------------------------ drift */

  it('computes drift for a real directory and records the scan', async () => {
    installClient(zerops().client);
    const res = await get(`/api/drift?projectId=${PROJECT}&dir=${encodeURIComponent(process.cwd())}`);
    expect(res.status).toBe(200);
    const d = await res.json() as { scanned: string[]; drift: { counts: Record<string, number> }; history: unknown[] };
    expect(d.scanned).toContain('package.json');
    expect(typeof d.drift.counts['missing']).toBe('number');
    expect(Array.isArray(d.history)).toBe(true);
  });

  it('refuses a directory that is not on this machine', async () => {
    installClient(zerops().client);
    const res = await get(`/api/drift?projectId=${PROJECT}&dir=${encodeURIComponent('/no/such/dir/anywhere')}`);
    expect(res.status).toBe(400);
    expect((await res.json() as { message: string }).message).toMatch(/does not exist/);
  });

  it('says "nothing to read" rather than "nothing needed" for an empty directory', async () => {
    installClient(zerops().client);
    const res = await get(`/api/drift?projectId=${PROJECT}&dir=${encodeURIComponent('/usr/share/dict')}`);
    const d = await res.json() as { scanned: string[]; note?: string };
    expect(d.scanned).toEqual([]);
    // The distinction the whole tool rests on.
    expect(d.note).toMatch(/not the same as/);
  });

  /* -------------------------------------------------------------- provision */

  it('previews the exact import file without writing anything', async () => {
    const z = zerops();
    installClient(z.client);
    const res = await post('/api/provision/plan', { projectId: PROJECT, types: ['postgresql'], ha: false });
    expect(res.status).toBe(200);
    const plan = await res.json() as { yaml: string; services: unknown[] };
    expect(plan.yaml).toContain('type: postgresql@16');
    expect(plan.yaml).toContain('mode: NON_HA');
    expect(z.calls.some((c) => c.endsWith('/service-stack/import'))).toBe(false);
  });

  it('reports a type the platform has no equivalent for instead of dropping it', async () => {
    installClient(zerops().client);
    const res = await post('/api/provision/plan', { projectId: PROJECT, types: ['nonesuch'], ha: false });
    const plan = await res.json() as { unresolved: string[] };
    expect(plan.unresolved).toContain('nonesuch');
  });

  it('refuses to provision with GET', async () => {
    installClient(zerops().client);
    const res = await get('/api/provision');
    expect(res.status).toBe(405);
    expect((await res.json() as { message: string }).message).toMatch(/real services/);
  });

  it('requires a project and a non-empty type list', async () => {
    installClient(zerops().client);
    expect((await post('/api/provision', { projectId: PROJECT, types: [] })).status).toBe(400);
    expect((await post('/api/provision', { types: ['postgresql'] })).status).toBe(400);
  });

  it('provisions, and re-reads the graph from the platform afterwards', async () => {
    const z = zerops();
    installClient(z.client);
    const res = await post('/api/provision', { projectId: PROJECT, types: ['postgresql'], ha: false });
    expect(res.status).toBe(200);
    const body = await res.json() as { created: { hostname: string }[]; graph: unknown };
    expect(body.created[0]?.hostname).toBe('postgresql');
    // Accepting an import is not the same as the services existing.
    expect(z.calls.filter((c) => c === '/service-stack/search').length).toBeGreaterThan(1);
    expect(body.graph).not.toBeNull();
  });

  it('surfaces a rejected import as a 502 carrying the platform reason', async () => {
    installClient(zerops({
      onImport: () => Promise.resolve({
        status: 400,
        body: { error: { message: 'Project has already serviceStack with the same name' } },
      }),
    }).client);

    const res = await post('/api/provision', { projectId: PROJECT, types: ['postgresql'], ha: false });
    // 502, not 400: from the browser's point of view the UPSTREAM refused. Passing Zerops'
    // own status through would make this look like our own validation rejecting the user.
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('zerops_api_error');
    expect(body.message).toMatch(/already serviceStack with the same name/);
  });

  it('records a refused import rather than losing it, and frees the lock', async () => {
    // The write failed, but it was still attempted, and the next caller must not be blocked
    // by a lock the failing request forgot to release.
    installClient(zerops({
      onImport: () => Promise.resolve({ status: 400, body: { error: { message: 'nope' } } }),
    }).client);
    await post('/api/provision', { projectId: PROJECT, types: ['postgresql'], ha: false });

    const h = await (await get(`/api/history?projectId=${PROJECT}`)).json() as { events: { kind: string }[] };
    expect(h.events.some((e) => e.kind === 'provision_failed')).toBe(true);

    // Lock released in `finally`: a following provision succeeds rather than hitting 409.
    installClient(zerops().client);
    const after = await post('/api/provision', { projectId: PROJECT, types: ['postgresql'], ha: false });
    expect(after.status).toBe(200);
  });

  it('lets exactly ONE of two simultaneous provisions through', async () => {
    /*
     * The lock doing its job, over HTTP. Both requests are issued before either resolves; the
     * import is held open long enough to guarantee the overlap. The loser must get a clean 409
     * naming the holder — not a raw "Project has already serviceStack with the same name" from
     * Zerops after a partial apply.
     */
    let release: (() => void) | undefined;
    const held = new Promise<void>((ok) => { release = ok; });
    installClient(zerops({ onImport: async () => { await held; return { body: { ok: true } }; } }).client);

    const a = post('/api/provision', { projectId: PROJECT, types: ['postgresql'], ha: false });
    const b = post('/api/provision', { projectId: PROJECT, types: ['postgresql'], ha: false });
    // Give the second request time to reach the lock while the first still holds it.
    await new Promise((r) => setTimeout(r, 250));
    release?.();

    const [ra, rb] = await Promise.all([a, b]);
    const codes = [ra.status, rb.status].sort();
    expect(codes).toEqual([200, 409]);

    const loser = ra.status === 409 ? ra : rb;
    const body = await loser.json() as { error: string; heldBy: string; message: string };
    expect(body.error).toBe('provision_in_progress');
    expect(body.heldBy).toMatch(/^ui:/);
    expect(body.message).toMatch(/Another provision is already running/);
  });

  /* ----------------------------------------------------------------- export */

  it('exports a committable zerops.yaml with the evidence as comments', async () => {
    installClient(zerops().client);
    const res = await get(`/api/export?projectId=${PROJECT}&dir=${encodeURIComponent(process.cwd())}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/yaml/);
    expect(res.headers.get('content-disposition')).toMatch(/filename="zerops\.yaml"/);

    const yaml = await res.text();
    expect(yaml).toMatch(/^# zerops\.yaml/);
    expect(yaml).toContain('services:');
    // Each service carries WHY it is there, so a reviewer needs no app open.
    expect(yaml).toMatch(/# .+\n {2}- hostname: /);
  });

  it('requires both a project and a directory to export', async () => {
    installClient(zerops().client);
    expect((await get('/api/export?projectId=x')).status).toBe(400);
  });

  /* ---------------------------------------------------------------- history */

  it('serves the persisted history without needing a Zerops session', async () => {
    // History is local. Requiring a live token to read what already happened would make the
    // record unavailable exactly when the platform is down.
    const res = await get(`/api/history?projectId=${PROJECT}`);
    expect(res.status).toBe(200);
    const h = await res.json() as { events: unknown[]; byKind: unknown[] };
    expect(Array.isArray(h.events)).toBe(true);
    expect(Array.isArray(h.byKind)).toBe(true);
  });

  it('has recorded the scans and provisions this suite performed', async () => {
    const h = await (await get(`/api/history?projectId=${PROJECT}`)).json() as { events: { kind: string }[] };
    const kinds = new Set(h.events.map((e) => e.kind));
    expect(kinds.has('repo_scanned')).toBe(true);
    expect(kinds.has('provision_succeeded')).toBe(true);
    // Including the contention, which is the interesting one.
    expect(kinds.has('provision_blocked')).toBe(true);
  });

  /* ------------------------------------------------------------------ misc */

  it('serves the built UI at the root', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('never serves a file from outside the web directory', async () => {
    /*
     * Three spellings of the same attempt. A plain `..` is normalised away by URL parsing
     * before it is ever sent, so on its own it proves nothing about the guard; the encoded
     * forms survive to the server. What is asserted is the outcome that matters — no request
     * shape returns the contents of a file above the web root.
     */
    for (const path of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json']) {
      const res = await fetch(`${base}${path}`, { redirect: 'manual' });
      const text = await res.text();
      expect(res.status, `${path} should not have succeeded`).not.toBe(200);
      expect(text).not.toContain('"dependencies"');
      expect(text).not.toContain('notch-zerops-brain');
    }
  });

  it('names an unknown endpoint instead of returning a blank 404', async () => {
    const res = await get('/api/nope');
    expect(res.status).toBe(404);
    expect((await res.json() as { message: string }).message).toMatch(/No such endpoint/);
  });

  it('never puts the token in a response', async () => {
    installClient(zerops().client);
    const text = await (await get('/api/session/status')).text();
    expect(text).not.toContain('tok_testtest');
    expect(text).toContain('tok_…test');
  });
});
