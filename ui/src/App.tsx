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
  Background, BackgroundVariant, Controls, ReactFlow, type Edge, type Node,
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

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { cache: 'no-store', ...init });
  const body = await res.json().catch(() => ({ message: 'server sent something that is not JSON' }));
  if (!res.ok) throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`);
  return body as T;
}

/** One line a human can read, from an event payload. Never raw JSON in the UI. */
function summarise(kind: string, p: Record<string, unknown>): string {
  const s = (k: string): string => (typeof p[k] === 'string' ? p[k] as string : '');
  const n = (k: string): number | null => (typeof p[k] === 'number' ? p[k] as number : null);
  switch (kind) {
    case 'repo_scanned': {
      const missing = Array.isArray(p['missing']) ? (p['missing'] as string[]) : [];
      return missing.length === 0
        ? `${s('dir')} — nothing missing`
        : `${missing.length} missing (${missing.join(', ')}) in ${s('dir')}`;
    }
    case 'provision_succeeded': {
      const c = Array.isArray(p['created']) ? (p['created'] as { hostname: string }[]) : [];
      return `created ${c.map((x) => x.hostname).join(', ') || '(nothing)'}`;
    }
    case 'provision_failed': return `Zerops refused: ${s('error')}`;
    case 'provision_blocked': return `held by ${s('heldBy')} — this attempt was refused rather than colliding`;
    case 'provision_started': return s('resourceId') || 'lock taken';
    case 'session_opened': return `${s('email')} — ${n('projects') ?? 0} project(s)`;
    case 'yaml_exported': return `${n('services') ?? 0} service(s) written to zerops.yaml`;
    default: return Object.keys(p).slice(0, 4).join(', ') || '—';
  }
}

export default function App() {
  const [token, setToken] = useState('');
  const [session, setSession] = useState<{ email: string; projectCount: number; tokenHint: string } | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string; status: string }[]>([]);
  const [projectId, setProjectId] = useState('');
  const [graph, setGraph] = useState<Graph | null>(null);
  const [drift, setDrift] = useState<DriftResp | null>(null);
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ services: { hostname: string; type: string; mode: string }[]; yaml: string; unresolved: string[] } | null>(null);
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
    void api<{ projects: typeof projects }>('/api/projects')
      .then((r) => { setProjects(r.projects); if (r.projects[0] && projectId === '') setProjectId(r.projects[0].id); })
      .catch((e: Error) => setError(e.message));
  }, [session, projectId]);

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

  const loadHistory = async (pid: string) => {
    try { setHistory(await api<HistoryResp>(`/api/history?projectId=${encodeURIComponent(pid)}`)); }
    catch { /* history is a bonus view; failing to load it must not break the page */ }
  };

  const scan = async () => guard(async () => {
    if (dir.trim() === '' || projectId === '') return;
    setError(null);
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
      setPlan(await api('/api/provision/plan', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, types: missingTypes, ha }),
      }));
    } catch (e) { setError((e as Error).message); }
  });

  const provision = async () => guard(async () => {
    setError(null);
    try {
      const r = await api<{ created: { hostname: string }[]; graph: Graph | null; note: string }>('/api/provision', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, types: missingTypes, ha }),
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
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.status})</option>)}
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
        </div>
      </header>

      {error !== null && <div className="banner err">{error}</div>}

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

      <div className="canvas">
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView
          proOptions={{ hideAttribution: false }} minZoom={0.2}>
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <Controls />
        </ReactFlow>
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
            ) : history.events.map((e) => (
              <div key={e.id} className={`ev-row ${e.kind}`}>
                <div className="ev-top">
                  <b>{KIND_LABEL[e.kind] ?? e.kind}</b>
                  <span className="muted">{ago(e.ts)}</span>
                </div>
                <div className="ev-detail">{summarise(e.kind, e.payload)}</div>
              </div>
            ))}
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
  );
}
