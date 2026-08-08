/**
 * The Brain daemon, from the app's side.
 *
 * Same shape of relationship Notch's app has with the Notch daemon: the app holds no
 * credential of its own and never talks to a third party. The Zerops token lives in the
 * daemon's memory; this file only ever sees a redacted hint of it.
 *
 * `BASE` is empty when the app is served by the daemon itself (one origin, no CORS). During
 * development Expo serves on another port, so it points at the daemon explicitly.
 */
const DEV_DAEMON = 'http://127.0.0.1:7799';

/** Same-origin when the daemon serves the exported bundle; explicit while developing. */
export const BASE: string =
  typeof location !== 'undefined' && location.port === '7799' ? '' : DEV_DAEMON;

export interface ArchNode {
  id: string;
  name: string;
  typeName: string;
  kind: string;
  status: string;
  containers: number | null;
  ha: boolean;
  publicHttp: boolean;
  ports: number[];
  system: boolean;
  position: { x: number; y: number };
}

export interface Graph {
  projectId: string;
  projectName: string;
  status: string;
  nodes: ArchNode[];
  edges: Array<{ id: string; source: string; target: string }>;
  notes: string[];
}

export interface Evidence { path: string; found: string; because: string }

export interface DriftItem {
  status: 'satisfied' | 'missing' | 'unreferenced';
  type: string;
  summary: string;
  required?: { role: string; confidence: string; evidence: Evidence[] };
  deployed?: { name: string };
}

export interface ConfigDrift {
  missing: string[];
  present: string[];
  provided: Array<{ key: string; by: string }>;
}

export interface Difference {
  kind: 'only_in_a' | 'only_in_b' | 'version' | 'mode' | 'routing' | 'env_key';
  subject: string;
  a: string | null;
  b: string | null;
  severity: 'high' | 'medium' | 'low';
  detail: string;
}

export interface Comparison {
  a: string;
  b: string;
  differences: Difference[];
  identical: string[];
}

export interface WiringEdge {
  from: string;
  to: string;
  because: string;
  path: string;
  found: string;
  confidence: 'strong' | 'likely';
  deployed: boolean;
}

export interface Wiring {
  runtime: string | null;
  edges: WiringEdge[];
  platformEdgeCount: number;
  note: string | null;
}

export interface DriftResp {
  /** Edges read out of the code, with the line that proves each one. */
  wiring?: Wiring;
  /** Variables the repo reads that the project does not define. */
  config?: ConfigDrift;
  dir: string;
  scanned: string[];
  drift: {
    items: DriftItem[];
    counts: Record<string, number>;
    provisionable: DriftItem[];
    notes: string[];
  };
  graph: Graph;
  note?: string;
  history?: Array<{ type: string; scans: number; firstSeen: string; lastSeen: string }>;
  historyNote?: string;
}

export interface Plan {
  services: Array<{ hostname: string; type: string; mode: string }>;
  yaml: string;
  unresolved: string[];
  secrets: string[];
  /** Repo variable → service. What the app needs in its own zerops.yml to reach them. */
  wiring: Array<{ key: string; service: string }>;
  wiringSnippet: string;
}

export interface BrainEvent {
  id: string;
  ts: string;
  kind: string;
  actor: string | null;
  payload: Record<string, unknown>;
}

/**
 * A credential git is already carrying.
 *
 * There is deliberately no field on this type that could hold the secret itself — the daemon
 * has none to send. A finding is a location and a kind, which is everything you need to act
 * and nothing you would regret having on screen during a demo.
 */
export interface Finding {
  path: string;
  line: number;
  rule: string;
  advice: string;
  severity: 'critical' | 'high' | 'medium';
  key: string | null;
}

export interface Hygiene {
  /** Null when the directory is not a git repository — "could not tell", not "clean". */
  tracked: number | null;
  scanned: number;
  findings: Finding[];
  notes: string[];
}

/** One real REST call Notch made to Zerops. */
export interface Action {
  seq: number; ts: string; method: string; path: string; status: number;
  ms: number; ok: boolean; write: boolean; summary: string; bytes: number; error: string | null;
}

export interface Choice { type: string; role: string; because: string }
export interface Rejection { type: string; because: string }
export interface Design {
  chosen: Choice[]; rejected: Rejection[]; unavailable: string[];
  understanding: string; agent: string; ms: number;
}

export interface SwarmProposal {
  agent: string; lens: string; verb: string; because: string;
  confidence: 'high' | 'medium' | 'low'; ms: number;
}

export interface Cycle {
  startedAt: string;
  signals: {
    service: { id: string; name: string };
    containers: { total: number; active: number };
    policy: { minContainers: number | null; maxContainers: number | null };
    load: {
      url: string | null; samples: number; p50: number | null; p95: number | null;
      slowest: number | null; errorRate: number | null; throughput: number | null;
    };
    notes: string[];
  };
  decision: {
    verb: string; votes: number; of: number; proposals: SwarmProposal[];
    target: { minContainers: number; maxContainers: number } | null;
    rationale: string; clampNote: string | null;
  };
  applied: {
    processId: string | null;
    from: { minContainers: number | null; maxContainers: number | null };
    to: { minContainers: number; maxContainers: number };
    verified: boolean; note: string;
  } | null;
  discarded: Array<{ agent: string; lens: string; reason: string }>;
  ms: number;
}

export interface AgentInfo { id: string; label: string; path: string }
export interface Session { email: string; projectCount: number; tokenHint: string }
export interface Project { id: string; name: string; status: string }

/**
 * Is the daemon there at all?
 *
 * Distinct from `navigator.onLine`, which reports whether the machine has a network — and this
 * app's server is on loopback, so the machine can be offline with everything working, or fully
 * online with the daemon dead. Only one of those is worth a banner, so only one is watched.
 */
export type Reach = 'ok' | 'unreachable';
let reach: Reach = 'ok';
const watchers = new Set<(r: Reach) => void>();

export function onReachChange(fn: (r: Reach) => void): () => void {
  watchers.add(fn);
  fn(reach);
  return () => { watchers.delete(fn); };
}

function setReach(next: Reach): void {
  if (next === reach) return;
  reach = next;
  for (const w of watchers) w(next);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Which failures are worth trying again. A 400 will be a 400 next time too. */
const retriable = (status: number): boolean => status === 429 || status === 502 || status === 503 || status === 504;

/**
 * Every call goes through here so no screen has to think about error shapes.
 *
 * A non-2xx carries a `message` from the daemon; a bare status code is never shown, because
 * "HTTP 404" tells a user neither what failed nor what to do about it.
 *
 * RETRIES ARE ONLY FOR IDEMPOTENT READS. A GET that 502s is worth trying again; a POST is not,
 * because the daemon may well have created the thing before the connection dropped and a
 * second attempt would create it twice. Provisioning infrastructure is the specific case where
 * an automatic retry is the wrong instinct, so this refuses to have it.
 */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const idempotent = (init?.method ?? 'GET').toUpperCase() === 'GET';
  const attempts = idempotent ? 3 : 1;
  let lastMessage = '';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, { cache: 'no-store', ...init });
    } catch {
      if (attempt < attempts) { await sleep(attempt * 400); continue; }
      setReach('unreachable');
      throw new Error(`Could not reach the Brain daemon at ${BASE || 'this origin'}. Is it running?`);
    }

    const text = await res.text();
    let body: unknown = null;
    try { body = text === '' ? null : JSON.parse(text); } catch { body = null; }

    if (res.ok) { setReach('ok'); return body as T; }

    const msg = (body as { message?: string } | null)?.message;
    lastMessage = msg ?? `The daemon rejected that request (HTTP ${res.status}) without saying why.`;

    if (retriable(res.status) && attempt < attempts) {
      /*
       * Honour Retry-After when the far side sent one — Zerops does on a 429, and guessing a
       * shorter delay than it asked for is how a rate limit becomes a ban.
       */
      const after = Number(res.headers.get('retry-after') ?? '');
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 8000) : attempt * 700);
      continue;
    }
    // A reachable daemon that says no is not an outage.
    setReach('ok');
    throw new Error(lastMessage);
  }
  throw new Error(lastMessage);
}

const json = (b: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(b),
});

export const api = {
  status: () => call<{ connected: boolean; email?: string; projectCount?: number; tokenHint?: string; degraded?: boolean; reason?: string }>('/api/session/status'),
  connect: (token: string) => call<Session>('/api/session', json({ token })),
  disconnect: () => call<{ ok: boolean }>('/api/session', { method: 'DELETE' }),
  projects: () => call<{ projects: Project[] }>('/api/projects'),
  createProject: (name: string) => call<{ project: Project; note?: string }>('/api/project', json({ name, tags: ['notch'] })),
  graph: (projectId: string) => call<Graph>(`/api/graph?projectId=${encodeURIComponent(projectId)}`),
  drift: (projectId: string, dir: string) =>
    call<DriftResp>(`/api/drift?projectId=${encodeURIComponent(projectId)}&dir=${encodeURIComponent(dir)}`),
  plan: (projectId: string, types: string[], ha: boolean, dir: string) =>
    call<Plan>('/api/provision/plan', json({ projectId, types, ha, dir })),
  provision: (projectId: string, types: string[], ha: boolean, dir: string) =>
    call<{ created: Array<{ hostname: string }>; graph: Graph | null; note: string }>('/api/provision', json({ projectId, types, ha, dir })),
  history: (projectId: string) => call<{ events: BrainEvent[]; byKind: Array<{ kind: string; count: number }> }>(`/api/history?projectId=${encodeURIComponent(projectId)}`),
  compare: (a: string, b: string) =>
    call<Comparison>(`/api/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),
  /** Starts a deploy and returns at once; the build takes minutes. Poll `deployStatus`. */
  deploy: (projectId: string, dir: string, setup: string) =>
    call<{ runId: string; service: string }>('/api/deploy', json({ projectId, dir, setup })),
  deployStatus: (id: string, from: number) =>
    call<{
      lines: string[]; total: number; done: boolean; ok: boolean | null;
      url: string | null; note: string; health: { status: number; ms: number } | null;
    }>(`/api/deploy/status?id=${encodeURIComponent(id)}&from=${from}`),
  /** Local, and deliberately not gated on a Zerops session — see the route's own note. */
  hygiene: (dir: string) => call<Hygiene>(`/api/hygiene?dir=${encodeURIComponent(dir)}`),
  actions: (from: number) =>
    call<{ actions: Action[]; counts: { total: number; writes: number; failed: number; ms: number } }>(
      `/api/actions?from=${from}`),
  architect: (agent: string, description: string) =>
    call<Design>('/api/architect', json({ agent, description })),
  swarmCycle: (o: {
    projectId: string; serviceId: string; armed: boolean;
    floor: number; ceiling: number; requests: number; concurrency: number;
  }) => call<Cycle>('/api/swarm/cycle', json(o)),
  agents: () => call<{ agents: AgentInfo[] }>('/api/agents'),
  propose: (agent: string, projectId: string, dir: string, ha: boolean) =>
    call<{
      agent: string; ms: number;
      proposal: { types: string[]; why: Record<string, string>; rejected: string[] };
      plan: Plan | null;
      note?: string;
    }>('/api/chat/propose', json({ agent, projectId, dir, ha })),
  chat: (agent: string, prompt: string, projectId: string, dir: string) =>
    call<{ agent: string; reply: string; ms: number }>('/api/chat', json({ agent, prompt, projectId, dir })),
  /*
   * ABSOLUTE, always.
   *
   * Everything else here is fetched from the page, where a relative path is correct and
   * `BASE` is empty. This one is different: it is handed to the Electron main process, which
   * refuses anything that is not a daemon URL — and a bare `/api/export?…` is not one. The
   * export silently did nothing in the desktop build because of it, so the origin is
   * spelled out rather than inherited.
   */
  /** The board as a Mermaid block. Plain text on purpose — the next action is copy. */
  mermaid: (projectId: string, dir: string) =>
    fetch(`${BASE}/api/mermaid?projectId=${encodeURIComponent(projectId)}&dir=${encodeURIComponent(dir)}`,
      { cache: 'no-store' }).then(async (r) => {
      if (!r.ok) throw new Error(`Could not build the diagram (HTTP ${r.status}).`);
      return r.text();
    }),
  exportUrl: (projectId: string, dir: string, ha: boolean) =>
    `${BASE === '' ? globalThis.location.origin : BASE}` +
    `/api/export?projectId=${encodeURIComponent(projectId)}&dir=${encodeURIComponent(dir)}&ha=${ha}`,
};
