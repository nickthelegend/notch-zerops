/**
 * Every REST call Notch makes to Zerops, as it happens.
 *
 * The point is evidential. An app that draws infrastructure diagrams is indistinguishable, from
 * the outside, from an app that draws pictures — and "we really are talking to the platform" is
 * exactly the claim a demo cannot make by asserting it. So every request goes in here with its
 * method, its path, its status and how long it took, and the app can show the list.
 *
 * WHAT IS DELIBERATELY NOT RECORDED:
 *
 *   The token. It travels in a header and headers are never touched here, but the rule is
 *   written down because the obvious "improvement" to this file is to log the request for
 *   debugging, and that would put a bearer credential in a ring buffer the UI renders.
 *
 *   Request and response bodies. Only a byte count. An import file contains generator syntax
 *   rather than values today, but a body log is the kind of thing that is safe until the day
 *   somebody adds an endpoint where it is not.
 *
 * In memory, bounded, and lost on restart — on purpose. This is a transcript of what this
 * process did, not an audit trail; the durable record of anything that CHANGED infrastructure
 * is already written to Postgres by the caller that changed it.
 */

export interface Action {
  seq: number;
  ts: string;
  method: string;
  /** Path only — the base URL is constant and repeating it adds nothing. */
  path: string;
  status: number;
  ms: number;
  ok: boolean;
  /**
   * Did this change anything on the account?
   *
   * Not simply "is it a POST". Zerops does all of its reading through `POST /*​/search`, so
   * method alone would mark every list operation as a mutation and the log would be useless
   * for the one question it exists to answer.
   */
  write: boolean;
  /** A sentence a human can read without knowing the API. */
  summary: string;
  bytes: number;
  error: string | null;
}

const MAX = 500;

let seq = 0;
const entries: Action[] = [];
const listeners = new Set<(a: Action) => void>();

/** `/service-stack/abc123/autoscaling` → `['service-stack', 'abc123', 'autoscaling']` */
const parts = (path: string): string[] => path.split('?')[0]?.split('/').filter((s) => s !== '') ?? [];

/**
 * A human sentence for a REST call.
 *
 * Written as a lookup over the shapes this client actually uses rather than something clever
 * and general: there are fifteen of them, they are all known, and a generic path-to-prose
 * function would produce "Put service stack autoscaling" — which is just the URL with spaces.
 */
export function describe(method: string, path: string): string {
  const p = parts(path);
  const last = p[p.length - 1] ?? '';
  const head = p[0] ?? '';

  if (path.startsWith('/user/info')) return 'Checked who this token belongs to';
  if (last === 'search') {
    const what = head.replace(/-/g, ' ');
    return `Listed ${what === 'service stack type' ? 'the service catalogue' : `${what}s`}`;
  }
  if (head === 'project' && method === 'POST' && p.length === 1) return 'Created a project';
  if (head === 'client' && last === 'project' && method === 'POST') return 'Created a project';
  if (head === 'project' && method === 'DELETE') return 'Deleted a project';
  if (last === 'import' && method === 'POST') return 'Imported services from a yaml file';
  if (last === 'enable-subdomain-access') return 'Asked for a public subdomain';
  if (last === 'autoscaling' && method === 'PUT') return 'Changed autoscaling limits on a service';
  if (last === 'container' && method === 'GET') return 'Read the running containers of a service';
  if (head === 'process' && method === 'GET') return 'Checked whether a platform operation finished';
  if (head === 'service-stack' && method === 'DELETE') return 'Deleted a service';
  if (head === 'service-stack' && method === 'GET') return 'Read one service in full';

  return `${method} ${path}`;
}

/**
 * A write is a mutation, and `POST /…/search` is not one.
 *
 * Exported because this is the definition the UI filters on, and a second copy of the rule
 * living in a component is how the two drift apart.
 */
export function isWrite(method: string, path: string): boolean {
  if (method === 'GET') return false;
  if (parts(path).at(-1) === 'search') return false;
  return method === 'POST' || method === 'PUT' || method === 'DELETE';
}

export function record(e: Omit<Action, 'seq' | 'ts' | 'write' | 'summary'> & Partial<Pick<Action, 'summary'>>): Action {
  seq += 1;
  const action: Action = {
    seq,
    ts: new Date().toISOString(),
    write: isWrite(e.method, e.path),
    summary: e.summary ?? describe(e.method, e.path),
    ...e,
  };
  entries.push(action);
  if (entries.length > MAX) entries.splice(0, entries.length - MAX);
  for (const l of listeners) l(action);
  return action;
}

/** Everything after `sinceSeq`, so the UI can poll without re-reading the whole buffer. */
export function since(sinceSeq = 0): Action[] {
  return entries.filter((a) => a.seq > sinceSeq);
}

export function all(): readonly Action[] {
  return entries;
}

export function counts(): { total: number; writes: number; failed: number; ms: number } {
  return {
    total: entries.length,
    writes: entries.filter((a) => a.write).length,
    failed: entries.filter((a) => !a.ok).length,
    ms: entries.reduce((n, a) => n + a.ms, 0),
  };
}

export function subscribe(fn: (a: Action) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Tests only. Production never clears the log; it rolls. */
export function reset(): void {
  entries.length = 0;
  seq = 0;
  listeners.clear();
}
