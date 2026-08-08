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

export interface DriftResp {
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
}

export interface BrainEvent {
  id: string;
  ts: string;
  kind: string;
  actor: string | null;
  payload: Record<string, unknown>;
}

export interface Session { email: string; projectCount: number; tokenHint: string }
export interface Project { id: string; name: string; status: string }

/**
 * Every call goes through here so no screen has to think about error shapes.
 *
 * A non-2xx carries a `message` from the daemon; a bare status code is never shown, because
 * "HTTP 404" tells a user neither what failed nor what to do about it.
 */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { cache: 'no-store', ...init });
  } catch {
    throw new Error(`Could not reach the Brain daemon at ${BASE || 'this origin'}. Is it running?`);
  }
  const text = await res.text();
  let body: unknown = null;
  try { body = text === '' ? null : JSON.parse(text); } catch { body = null; }
  if (!res.ok) {
    const msg = (body as { message?: string } | null)?.message;
    throw new Error(msg ?? `The daemon rejected that request (HTTP ${res.status}) without saying why.`);
  }
  return body as T;
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
  /*
   * ABSOLUTE, always.
   *
   * Everything else here is fetched from the page, where a relative path is correct and
   * `BASE` is empty. This one is different: it is handed to the Electron main process, which
   * refuses anything that is not a daemon URL — and a bare `/api/export?…` is not one. The
   * export silently did nothing in the desktop build because of it, so the origin is
   * spelled out rather than inherited.
   */
  exportUrl: (projectId: string, dir: string, ha: boolean) =>
    `${BASE === '' ? globalThis.location.origin : BASE}` +
    `/api/export?projectId=${encodeURIComponent(projectId)}&dir=${encodeURIComponent(dir)}&ha=${ha}`,
};
