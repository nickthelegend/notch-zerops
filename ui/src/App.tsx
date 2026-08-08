/**
 * Brain — your Zerops architecture, drawn from your account, with the gaps marked.
 *
 * Three states and no fourth: no token, loading, or a graph. There is deliberately no
 * "empty" state that looks calm — an account with no services and an unreachable API must
 * never render the same way, so a failed call paints an error panel rather than an empty
 * canvas.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
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
}

const nodeTypes = { service: ServiceCard };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { cache: 'no-store', ...init });
  const body = await res.json().catch(() => ({ message: 'server sent something that is not JSON' }));
  if (!res.ok) throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`);
  return body as T;
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
    if (pid === '') return;
    setBusy(true); setError(null);
    try { setGraph(await api<Graph>(`/api/graph?projectId=${encodeURIComponent(pid)}`)); }
    catch (e) { setError((e as Error).message); setGraph(null); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { void loadGraph(projectId); }, [projectId, loadGraph]);

  const connect = async () => {
    setBusy(true); setError(null);
    try {
      const s = await api<{ email: string; projectCount: number; tokenHint: string }>('/api/session', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
      });
      setSession(s); setToken('');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const scan = async () => {
    if (dir.trim() === '' || projectId === '') return;
    setBusy(true); setError(null);
    try {
      const d = await api<DriftResp>(`/api/drift?projectId=${encodeURIComponent(projectId)}&dir=${encodeURIComponent(dir.trim())}`);
      setDrift(d); setGraph(d.graph);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

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
        </div>
      </header>

      {error !== null && <div className="banner err">{error}</div>}

      {counts !== undefined && (
        <div className="banner drift">
          <b>{counts['satisfied']} satisfied</b> · <b className="miss">{counts['missing']} missing</b> ·{' '}
          {counts['unreferenced']} unreferenced &nbsp;—&nbsp; scanned {drift?.scanned.join(', ') || 'nothing'} in {drift?.dir}
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
        {graph !== null && (
          <>
            <h3>{graph.projectName}</h3>
            <div className="muted">{graph.nodes.length} services · {graph.edges.length} connections</div>
            {graph.notes.map((n) => <div key={n} className="note">{n}</div>)}
          </>
        )}
        {drift !== null && (
          <>
            <h3>Drift</h3>
            {drift.note !== undefined && <div className="note">{drift.note}</div>}
            {drift.drift.items.map((i) => (
              <div key={i.status + i.type} className={`item ${i.status}`}>
                <div className="item-head">
                  <span className={`pill ${i.status}`}>{i.status}</span>
                  <b>{i.type}</b>
                  {i.required?.confidence === 'likely' && <span className="pill weak">low confidence</span>}
                </div>
                <div className="item-body">{i.summary}</div>
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
