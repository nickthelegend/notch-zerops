/**
 * Brain — your Zerops architecture, drawn from your account, with the gaps marked.
 *
 * Three states and no fourth: no token, loading, or a graph. There is deliberately no
 * "empty" state that looks calm — an account with no services and an unreachable API must
 * never render the same way, so a failed call paints an error panel rather than an empty
 * canvas.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, useReactFlow,
  type Edge, type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ServiceCard, type ServiceCardData } from './ServiceCard.tsx';
import './app.css';

interface ArchNode extends ServiceCardData {
  id: string;
  position: { x: number; y: number };
}
interface Graph {
  projectId: string; projectName: string; status: string;
  nodes: ArchNode[]; edges: { id: string; source: string; target: string }[]; notes: string[];
}
interface DriftItem {
  status: 'satisfied' | 'missing' | 'unreferenced';
  type: string; summary: string;
  required?: { role: string; confidence: string; evidence: { path: string; found: string; because: string }[] };
  deployed?: { name: string };
}
interface DriftResp {
  dir: string; scanned: string[]; drift: { items: DriftItem[]; counts: Record<string, number>; provisionable: DriftItem[]; notes: string[] };
  graph: Graph; note?: string;
  /** From the persisted log: how many scans have reported each type missing. */
  history?: { type: string; scans: number; firstSeen: string; lastSeen: string }[];
  historyNote?: string;
}
/** A previewed write, carrying the inputs it was built from so the confirm cannot drift. */
interface Plan {
  services: { hostname: string; type: string; mode: string }[];
  yaml: string;
  unresolved: string[];
  types: string[];
  ha: boolean;
}
interface HistoryResp {
  events: { id: string; ts: string; kind: string; actor: string | null; payload: Record<string, unknown> }[];
  byKind: { kind: string; count: number; lastAt: string }[];
}

const KIND_LABEL: Record<string, string> = {
  session_opened: 'connected', session_closed: 'disconnected', repo_scanned: 'scanned repo',
  provision_started: 'provision started', provision_succeeded: 'provisioned',
  provision_failed: 'provision failed', provision_blocked: 'blocked — another provision held the lock',
  yaml_exported: 'exported zerops.yaml', graph_read: 'read architecture',
};
const ago = (iso: string): string => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

const nodeTypes = { service: ServiceCard };

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 1.8;
/** Breathing room around the diagram, in screen pixels — not a fraction of anything. */
const FIT_PAD = 48;

/**
 * Frame the whole diagram, deterministically.
 *
 * React Flow's own `fitView` is not used here, and that is a deliberate choice made after
 * measuring it. The `fitView` prop fits ONCE at mount — this canvas mounts before the first
 * graph arrives and before the shell has settled its height, so that single fit is computed
 * against a container of the wrong size and never revisited. Measured on the real page: zoom
 * 0.2325 against a 314px-tall graph, because the canvas was 81px tall at the instant it
 * fitted. Every 190px service card rendered as a 44px chip: a correct graph drawn as
 * confetti.
 *
 * Calling `fitView()` imperatively afterwards did not fix it. The store sat at
 * `nodesInitialized: false` with `fitViewQueued: true` and a transform centred on a container
 * that no longer existed, leaving the graph pinned to the top-left corner of a canvas five
 * times its size — while every node in `nodeLookup` had correct `measured` dimensions and
 * handle bounds.
 *
 * So the arithmetic happens here instead. Bounding box of the measured nodes, one zoom that
 * makes it fit with a fixed pixel margin, one centred translation. Roughly ten lines, no
 * queue, no initialisation flag, and a result that can be predicted on paper and asserted
 * against the DOM — which is the only reason I trust it over the library's version.
 */
function FitView({ signature, of }: { signature: string; of: React.RefObject<HTMLDivElement | null> }) {
  const { setViewport, getViewport, getNodes } = useReactFlow();

  useEffect(() => {
    const el = of.current;
    if (el === null) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    /*
     * Apply, read back, and retry until it actually took.
     *
     * `setViewport` routes through React Flow's pan/zoom controller and, before that
     * controller is live, RETURNS SILENTLY WITHOUT DOING ANYTHING — no error, no warning, no
     * rejected promise. Measured directly: the fit computed the correct target, called
     * setViewport, and `getViewport()` still read {0,0,1} four hundred milliseconds later.
     * The graph sat in the corner because a function that looks like it worked did nothing.
     *
     * Gating on `panZoom !== null` did not help — it is already non-null at that point — so
     * there is no readiness flag here worth trusting. The only reliable signal that the
     * viewport moved is the viewport having moved. Hence: verify, and retry a bounded number
     * of times. `settled` stops the loop the instant it lands, so this cannot fight a user
     * who is panning.
     */
    const apply = (t: { x: number; y: number; zoom: number }, tries = 0): void => {
      if (settled) return;
      setViewport(t, { duration: tries === 0 ? 200 : 0 });
      timer = setTimeout(() => {
        const v = getViewport();
        if (Math.abs(v.x - t.x) < 1 && Math.abs(v.y - t.y) < 1 && Math.abs(v.zoom - t.zoom) < 0.01) {
          settled = true;
          return;
        }
        if (tries < 8) apply(t, tries + 1);
      }, tries === 0 ? 240 : 70);
    };

    const fit = (attempt = 0): void => {
      const ns = getNodes();
      if (ns.length === 0) return;

      /*
       * Sizes come from the rendered elements, not from `measured`.
       *
       * A first version fell back to a nominal 190x130 when `measured` was undefined, and the
       * result was a fit that was quietly 7px wrong because one card had not been measured at
       * the moment it ran. Seven pixels does not matter; fitting against a NUMBER I MADE UP
       * does, because when measurement is slower the same code silently misframes the whole
       * diagram. The DOM knows the real height. If it does not know it yet, wait for it.
       */
      const sized = ns.map((n) => {
        const e = el.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(n.id)}"]`);
        return { x: n.position.x, y: n.position.y, w: e?.offsetWidth ?? 0, h: e?.offsetHeight ?? 0 };
      });
      if (sized.some((s) => s.w === 0 || s.h === 0)) {
        if (attempt < 12) timer = setTimeout(() => fit(attempt + 1), 60);
        return;
      }

      const box = sized.reduce(
        (b, s) => ({
          minX: Math.min(b.minX, s.x), minY: Math.min(b.minY, s.y),
          maxX: Math.max(b.maxX, s.x + s.w), maxY: Math.max(b.maxY, s.y + s.h),
        }),
        { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
      );
      const bw = Math.max(1, box.maxX - box.minX);
      const bh = Math.max(1, box.maxY - box.minY);
      const { clientWidth: W, clientHeight: H } = el;
      if (W === 0 || H === 0) return;

      // Never magnify past 1: three services blown up to fill a 27-inch monitor looks broken
      // in the other direction.
      const zoom = Math.max(MIN_ZOOM, Math.min(1, (W - 2 * FIT_PAD) / bw, (H - 2 * FIT_PAD) / bh));
      apply({ x: (W - bw * zoom) / 2 - box.minX * zoom, y: (H - bh * zoom) / 2 - box.minY * zoom, zoom });
    };

    // Trailing edge only: during a window drag the observer fires every frame, and each fit
    // starts an animation that the next one interrupts.
    const schedule = (): void => { settled = false; clearTimeout(timer); timer = setTimeout(() => fit(), 90); };
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    schedule();
    return () => { clearTimeout(timer); ro.disconnect(); };
  }, [signature, of, getNodes, setViewport, getViewport]);

  return null;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { cache: 'no-store', ...init });
  } catch {
    // fetch only rejects when the request never completed: the server is down, or the machine
    // is offline. "Failed to fetch" tells a user nothing, so say which of those it is.
    throw new Error('Could not reach Brain on this machine. Is the server still running?');
  }
  const body = await res.json().catch(() => null) as { message?: string } | null;
  if (!res.ok) {
    // Never surface a bare status code. `HTTP 404` was what the UI actually showed when a
    // project id no longer resolved, which tells the user neither what failed nor what to do.
    throw new Error(body?.message ?? `The server rejected that request (HTTP ${res.status}) without saying why.`);
  }
  if (body === null) throw new Error('The server replied with something that was not JSON.');
  return body as unknown as T;
}

/** One line a human can read, from an event payload. Never raw JSON in the UI. */
function summarise(kind: string, p: Record<string, unknown>): string {
  const s = (k: string): string => (typeof p[k] === 'string' ? p[k] as string : '');
  const n = (k: string): number | null => (typeof p[k] === 'number' ? p[k] as number : null);
  switch (kind) {
    case 'repo_scanned': {
      const missing = Array.isArray(p['missing']) ? (p['missing'] as string[]) : [];
      const scanned = Array.isArray(p['scanned']) ? (p['scanned'] as string[]) : [];
      /*
       * "Nothing missing" and "nothing to read" are opposite findings, and this line used to
       * print the first for both. Scanning a directory with no manifests recorded
       * "/usr/share/dict — nothing missing" into the permanent log: a clean bill of health for
       * a place that was never examined. The drift panel already refuses to make that
       * conflation; the timeline was quietly making it anyway, and the timeline is the copy
       * that is still there tomorrow.
       */
      if (scanned.length === 0) return `${s('dir')} — no recognised manifests, so nothing to compare`;
      return missing.length === 0
        ? `${s('dir')} — everything the repo needs is deployed`
        : `${missing.length} missing (${missing.join(', ')}) in ${s('dir')}`;
    }
    case 'provision_succeeded': {
      const c = Array.isArray(p['created']) ? (p['created'] as { hostname: string }[]) : [];
      return `created ${c.map((x) => x.hostname).join(', ') || '(nothing)'}`;
    }
    case 'provision_failed': return `Zerops refused: ${s('error')}`;
    /*
     * These two carry internal identifiers — a lock key like `provision:<projectId>` and a
     * holder UUID. Both were being printed raw into a list a human reads. The holder is worth
     * keeping in short form, because "someone else" and "a specific other session" are
     * different facts, but the full lock key says nothing the row's own label does not.
     */
    case 'provision_blocked': {
      const who = s('heldBy');
      const short = who === '' ? 'another session' : `${who.slice(0, 11)}…`;
      return `${short} was already provisioning this project — this attempt was refused rather than colliding`;
    }
    case 'provision_started': return 'took the single-writer lock on this project';
    case 'session_opened': return `${s('email')} — ${n('projects') ?? 0} project(s)`;
    case 'yaml_exported': return `${n('services') ?? 0} service(s) written to zerops.yaml`;
    default: return Object.keys(p).slice(0, 4).join(', ') || '—';
  }
}

export default function App() {
  const [token, setToken] = useState('');
  const [session, setSession] = useState<{ email: string; projectCount: number; tokenHint: string } | null>(null);
  // `null` means "not fetched yet", which is a different thing from an account with no
  // projects. Conflating them flashed an "you have no projects" notice on every load.
  const [projects, setProjects] = useState<{ id: string; name: string; status: string }[] | null>(null);
  const [projectId, setProjectId] = useState('');
  const [graph, setGraph] = useState<Graph | null>(null);
  const [drift, setDrift] = useState<DriftResp | null>(null);
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [ha, setHa] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryResp | null>(null);
  const [tab, setTab] = useState<'drift' | 'timeline'>('drift');

  /**
   * In-flight guard, in a ref rather than in state.
   *
   * `setBusy(true)` does not take effect until React re-renders, so two clicks landing in the
   * same tick both pass a state-based check. Found by double-clicking "Confirm and create":
   * the first write succeeded and the second fired anyway, returning 502 because the
   * hostnames now existed -- while the UI showed success. Nothing was duplicated only
   * because Zerops rejected it, which is luck, not design. A ref updates synchronously, so
   * the second click cannot get past it.
   */
  const inFlight = useRef(false);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const guard = async (fn: () => Promise<void>): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try { await fn(); } finally { inFlight.current = false; setBusy(false); }
  };

  useEffect(() => {
    void api<{ connected: boolean; email?: string; projectCount?: number; tokenHint?: string }>('/api/session/status')
      .then((s) => { if (s.connected && s.email) setSession({ email: s.email, projectCount: s.projectCount ?? 0, tokenHint: s.tokenHint ?? '' }); })
      .catch(() => { /* not connected yet is the normal first state, not an error */ });
  }, []);

  useEffect(() => {
    if (session === null) return;
    void api<{ projects: NonNullable<typeof projects> }>('/api/projects')
      .then((r) => {
        setProjects(r.projects);
        // Functional update, so `projectId` need not be a dependency of this effect. It was,
        // and the result was that selecting the first project re-ran the effect and fetched
        // the list again -- two identical `/api/projects` calls on every load, each one a
        // real round-trip to Zerops, visible to anyone with the network tab open.
        setProjectId((cur) => (cur === '' ? r.projects[0]?.id ?? '' : cur));
      })
      .catch((e: Error) => setError(e.message));
  }, [session]);

  /**
   * A project change invalidates everything computed for the previous project.
   *
   * Without this, switching project kept the old drift on screen: the summary banner, the
   * evidence list, and — the reason this matters — a live "Provision 3 missing…" button. The
   * button reads the CURRENT `projectId` but the PREVIOUS project's missing list, so pressing
   * it creates one project's gaps inside another one. Verified in the browser before fixing:
   * after switching, the banner still read "1 satisfied · 3 missing" and the provision button
   * was still armed.
   *
   * Findings belong to the project they were computed from. When that changes, they are not
   * stale — they are wrong, and the honest thing is to show nothing until a new scan runs.
   */
  useEffect(() => {
    setDrift(null);
    setPlan(null);
    setCreated(null);
    setHistory(null);
    setError(null);
  }, [projectId]);

  const loadGraph = useCallback(async (pid: string) => {
    if (pid === '' || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try { setGraph(await api<Graph>(`/api/graph?projectId=${encodeURIComponent(pid)}`)); }
    catch (e) { setError((e as Error).message); setGraph(null); }
    finally { inFlight.current = false; setBusy(false); }
  }, []);

  useEffect(() => { void loadGraph(projectId); }, [projectId, loadGraph]);

  const connect = async () => guard(async () => {
    setError(null);
    try {
      const s = await api<{ email: string; projectCount: number; tokenHint: string }>('/api/session', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
      });
      setSession(s); setToken('');
    } catch (e) { setError((e as Error).message); }
  });

  /**
   * Hand the token back.
   *
   * `DELETE /api/session` existed from the start and nothing in the UI called it, so the only
   * way to dispose of a pasted credential was to stop the server. That makes a liar of the
   * promise on the gate screen — "held in memory for this session only" is not much of a
   * guarantee if the session cannot be ended. It also matters on a shared screen at a
   * conference stand, which is exactly where this gets demoed.
   */
  const disconnect = async () => guard(async () => {
    try { await api('/api/session', { method: 'DELETE' }); }
    catch { /* Whatever the server says, this browser is done with the token. */ }
    setSession(null); setProjects(null); setProjectId(''); setGraph(null);
    setDrift(null); setPlan(null); setCreated(null); setHistory(null); setError(null);
  });

  const loadHistory = async (pid: string) => {
    try { setHistory(await api<HistoryResp>(`/api/history?projectId=${encodeURIComponent(pid)}`)); }
    catch { /* history is a bonus view; failing to load it must not break the page */ }
  };

  const scan = async () => guard(async () => {
    if (dir.trim() === '' || projectId === '') return;
    // A new scan supersedes the previous one. Leaving the old "Created …" note and an open
    // preview on screen would attach them to findings they were not part of.
    setError(null); setCreated(null); setPlan(null);
    try {
      const d = await api<DriftResp>(`/api/drift?projectId=${encodeURIComponent(projectId)}&dir=${encodeURIComponent(dir.trim())}`);
      setDrift(d); setGraph(d.graph);
      await loadHistory(projectId);
    } catch (e) { setError((e as Error).message); }
  });

  const missingTypes = useMemo(
    () => (drift?.drift.provisionable ?? []).map((i) => i.type),
    [drift],
  );

  /**
   * Ask what WOULD be created, before anything is.
   *
   * A button that provisions real infrastructure should never be the first time you learn
   * what it provisions, so the exact import file is shown first. The plan and the write share
   * one server-side builder, so the preview cannot drift from what actually gets sent.
   */
  const preview = async () => guard(async () => {
    setError(null); setCreated(null);
    try {
      const p = await api<Omit<Plan, 'types' | 'ha'>>('/api/provision/plan', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, types: missingTypes, ha }),
      });
      /*
       * The plan captures the inputs it was built from.
       *
       * `ha` and the missing list are both live state, and the HA checkbox stays clickable
       * while the preview is on screen. Reading them again at confirm time meant you could
       * preview NON_HA, tick the box, confirm, and get HA services — the write silently
       * differing from the file you were shown. The preview is a promise about what happens
       * next, so it has to carry its own inputs.
       */
      setPlan({ ...p, ha, types: missingTypes });
    } catch (e) { setError((e as Error).message); }
  });

  const provision = async () => guard(async () => {
    setError(null);
    if (plan === null) return;
    try {
      const r = await api<{ created: { hostname: string }[]; graph: Graph | null; note: string }>('/api/provision', {
        // From the plan, never from live state — see the comment in `preview`.
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, types: plan.types, ha: plan.ha }),
      });
      setCreated(`Created ${r.created.map((c) => c.hostname).join(', ')}. ${r.note}`);
      setPlan(null);
      if (r.graph !== null) setGraph(r.graph);
      // Re-scan so the ghosts disappear for the right reason -- because the services now
      // exist, re-read from the platform, not because the UI hid them optimistically.
      // Re-read via the same endpoint rather than the guard, since we already hold it.
      if (dir.trim() !== '') {
        const d = await api<DriftResp>(`/api/drift?projectId=${encodeURIComponent(projectId)}&dir=${encodeURIComponent(dir.trim())}`);
        setDrift(d); setGraph(d.graph);
      }
      await loadHistory(projectId);
    } catch (e) { setError((e as Error).message); }
  });

  /**
   * Missing services become GHOST nodes on the same canvas.
   *
   * Putting them in the diagram rather than in a list beside it is the whole idea: the gap
   * between your repo and your infrastructure is a shape, and a shape is easier to act on
   * than a bullet point. They are visibly dashed and labelled `missing` so nobody can mistake
   * one for something that is running.
   */
  const { nodes, edges } = useMemo(() => {
    if (graph === null) return { nodes: [] as Node[], edges: [] as Edge[] };
    const real: Node[] = graph.nodes.map((n) => ({
      id: n.id, type: 'service', position: n.position, data: { ...n, ghost: false } satisfies ServiceCardData,
    }));
    const missing = drift?.drift.items.filter((i) => i.status === 'missing') ?? [];
    const ghostY = Math.max(0, ...graph.nodes.map((n) => n.position.y)) + 190;
    const ghosts: Node[] = missing.map((m, i) => ({
      id: `ghost-${m.type}`,
      type: 'service',
      position: { x: i * 240, y: ghostY },
      data: {
        name: m.type, typeName: m.type, kind: 'unknown', status: 'NOT PROVISIONED',
        containers: null, ha: false, publicHttp: false, ports: [], system: false,
        ghost: true, reason: m.summary, confidence: m.required?.confidence ?? 'strong',
      } satisfies ServiceCardData,
    }));
    return {
      nodes: [...real, ...ghosts],
      edges: graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, animated: true })),
    };
  }, [graph, drift]);

  if (session === null) {
    return (
      <div className="gate">
        <div className="gate-card">
          <h1>Brain</h1>
          <p className="sub">Your Zerops architecture, drawn from your account — with the gaps marked.</p>
          <label htmlFor="tok">Zerops Personal Access Token</label>
          <input id="tok" type="password" value={token} placeholder="paste it here"
            onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void connect(); }} />
          <button disabled={busy || token.trim() === ''} onClick={() => void connect()}>
            {busy ? 'checking with Zerops…' : 'Connect'}
          </button>
          {error !== null && <div className="err">{error}</div>}
          <p className="fine">
            Verified by a real API call, not by checking it looks like a token. It is held in
            memory for this session only — never written to disk, never logged, never sent
            anywhere but Zerops.
          </p>
        </div>
      </div>
    );
  }

  const counts = drift?.drift.counts;

  return (
    <div className="app">
      <header>
        <div>
          <span className="brand">Brain</span>
          <span className="who">{session.email} · token {session.tokenHint}</span>
        </div>
        <div className="controls">
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects === null
              ? <option value="">loading projects…</option>
              : projects.length === 0
                ? <option value="">no projects on this account</option>
                : projects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.status})</option>)}
          </select>
          <input className="dir" placeholder="/path/to/your/repo" value={dir} onChange={(e) => setDir(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void scan(); }} />
          <button onClick={() => void scan()} disabled={busy || dir.trim() === ''}>Scan repo for drift</button>
          <button onClick={() => void loadGraph(projectId)} disabled={busy}>Refresh</button>
          {/* A plain link, not a fetch: the browser's own download handling is more reliable
              than reconstructing a Blob, and it works even if JS is mid-render. */}
          <a
            className={`btn ${dir.trim() === '' ? 'off' : ''}`}
            href={dir.trim() === '' ? undefined : `/api/export?projectId=${encodeURIComponent(projectId)}&dir=${encodeURIComponent(dir.trim())}&ha=${ha}`}
            download="zerops.yaml"
            title="Download a committable zerops.yaml for what this repo needs"
          >Export zerops.yaml</a>
          <button onClick={() => void disconnect()} disabled={busy}
            title="Discard the token from the server's memory and return to the gate">Disconnect</button>
        </div>
      </header>

      {error !== null && <div className="banner err">{error}</div>}

      {/* An account with nothing in it is a real answer, and it needs saying out loud —
          otherwise the dropdown is simply empty and every control below does nothing. */}
      {projects !== null && projects.length === 0 && (
        <div className="banner">
          This account has no projects yet. Create one in the Zerops GUI, then press Refresh.
          Brain reads and extends projects — it does not create them.
        </div>
      )}

      {counts !== undefined && (
        <div className="banner drift">
          <b>{counts['satisfied']} satisfied</b> · <b className="miss">{counts['missing']} missing</b> ·{' '}
          {counts['unreferenced']} unreferenced &nbsp;—&nbsp; scanned {drift?.scanned.join(', ') || 'nothing'} in {drift?.dir}
          {missingTypes.length > 0 && (
            <span className="prov">
              <label title="Meilisearch and some others only ship single-container; HA is skipped where the platform has no HA version.">
                <input type="checkbox" checked={ha} onChange={(e) => setHa(e.target.checked)} /> HA where available
              </label>
              <button className="primary" disabled={busy} onClick={() => void preview()}>
                Provision {missingTypes.length} missing…
              </button>
            </span>
          )}
        </div>
      )}

      {created !== null && <div className="banner ok">{created}</div>}

      {plan !== null && (
        <div className="banner plan">
          <div className="plan-head">
            <b>This will create {plan.services.length} real service(s) on your Zerops account.</b>
            <span>
              <button className="primary" disabled={busy || plan.services.length === 0} onClick={() => void provision()}>
                {busy ? 'creating…' : 'Confirm and create'}
              </button>
              <button disabled={busy} onClick={() => setPlan(null)}>Cancel</button>
            </span>
          </div>
          <pre>{plan.yaml || '(nothing resolvable)'}</pre>
          {plan.unresolved.length > 0 && (
            <div className="warn">
              No Zerops service type matches: {plan.unresolved.join(', ')}. These are skipped rather than guessed at.
            </div>
          )}
        </div>
      )}

      <div className="main">
      <div className="canvas" ref={canvasRef}>
        <ReactFlowProvider>
          {/* No `fitView` prop: FitView below owns framing entirely. See its comment. */}
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes}
            proOptions={{ hideAttribution: false }} minZoom={MIN_ZOOM} maxZoom={MAX_ZOOM}>
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            <Controls />
          </ReactFlow>
          <FitView signature={nodes.map((n) => n.id).join('|')} of={canvasRef} />
        </ReactFlowProvider>
      </div>

      <aside>
        <div className="tabs">
          <button className={tab === 'drift' ? 'on' : ''} onClick={() => setTab('drift')}>Drift</button>
          <button className={tab === 'timeline' ? 'on' : ''}
            onClick={() => { setTab('timeline'); void loadHistory(projectId); }}>
            Timeline{history !== null ? ` (${history.events.length})` : ''}
          </button>
        </div>

        {tab === 'timeline' && (
          <>
            <h3>What Brain has done here</h3>
            <div className="muted">
              Read from Postgres, not from this tab&apos;s memory — it survives a refresh and a
              server restart.
            </div>
            {history === null || history.events.length === 0 ? (
              <div className="note">
                Nothing recorded for this project yet. Scan a repo or provision something and it
                will appear here.
              </div>
            ) : (
              <div className="timeline">
                {history.events.map((e) => (
                  <div key={e.id} className={`ev-row ${e.kind}`}>
                    <div className="ev-top">
                      <b>{KIND_LABEL[e.kind] ?? e.kind}</b>
                      <span className="muted">{ago(e.ts)}</span>
                    </div>
                    <div className="ev-detail">{summarise(e.kind, e.payload)}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'drift' && graph !== null && (
          <>
            <h3>{graph.projectName}</h3>
            <div className="muted">{graph.nodes.length} services · {graph.edges.length} connections</div>
            {graph.notes.map((n) => <div key={n} className="note">{n}</div>)}
          </>
        )}
        {tab === 'drift' && drift !== null && (
          <>
            <h3>Drift</h3>
            {drift.historyNote !== undefined && <div className="note warnnote">{drift.historyNote}</div>}
            {drift.note !== undefined && <div className="note">{drift.note}</div>}
            {drift.drift.items.map((i) => (
              <div key={i.status + i.type} className={`item ${i.status}`}>
                <div className="item-head">
                  <span className={`pill ${i.status}`}>{i.status}</span>
                  <b>{i.type}</b>
                  {i.required?.confidence === 'likely' && <span className="pill weak">low confidence</span>}
                </div>
                <div className="item-body">{i.summary}</div>
                {/* The one thing a live view cannot say. */}
                {(() => {
                  const h = drift.history?.find((x) => x.type === i.type);
                  return h !== undefined && h.scans > 1 && i.status === 'missing'
                    ? <div className="streak">Missing across {h.scans} scans — first seen {ago(h.firstSeen)}.</div>
                    : null;
                })()}
                {i.required?.evidence.map((e) => (
                  <div key={e.path + e.found} className="ev">
                    <code>{e.found}</code> in <code>{e.path}</code>
                  </div>
                ))}
              </div>
            ))}
            {drift.drift.notes.map((n) => <div key={n} className="note">{n}</div>)}
          </>
        )}
      </aside>
      </div>
    </div>
  );
}
