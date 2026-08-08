/**
 * The board — a real node canvas.
 *
 * React Flow, rendered as DOM inside the react-native-web tree. That is only possible because
 * this ships as a desktop app in Electron; the trade was made deliberately when the target
 * became desktop-only. What it buys is everything hand-rolled dragging could not: pan the
 * whole canvas, zoom, fit, marquee-select, real edge routing with handles, and nodes that
 * behave the way every node editor behaves — so nobody has to learn this one.
 *
 * WHAT THE BOARD SAYS THAT A LIST CANNOT:
 *
 *   Gaps are drawn beside the services they are missing from, dashed. A project with holes in
 *   it looks like a project with holes in it, and the shape of the gap is the finding.
 *
 *   Edges come from the REPOSITORY, not from Zerops. Zerops learns about a connection when
 *   somebody wires one; the code knows on the first commit. Every edge is labelled with the
 *   import that proves it, so the diagram makes an argument rather than decorating one.
 *
 *   The repository is a node too, because the relationship between a repo and the
 *   infrastructure it expects is what the whole app is about.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import {
  Background, BackgroundVariant, Controls, Handle, MiniMap, Position, ReactFlow,
  ReactFlowProvider, applyNodeChanges, useReactFlow,
  type Edge, type Node, type NodeChange, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { T } from './theme';
import type { ArchNode, Graph, Wiring } from './api';

export interface Ghost { type: string; reason: string; confidence: string }

export interface Board {
  graph: Graph;
  ghosts: Ghost[];
  repo: { dir: string; scanned: string[]; satisfied: number; missing: number } | null;
  wiring: Wiring | null;
  /** Services added by hand on the canvas, folded into the same provision plan. */
  added: string[];
}

/* ----------------------------------------------------------------- tokens */

const KIND = {
  runtime: { glyph: '▶', tint: '#a78bfa' },
  database: { glyph: '▤', tint: '#67e8f9' },
  cache: { glyph: '◈', tint: '#f59e0b' },
  search: { glyph: '◎', tint: '#22c55e' },
  queue: { glyph: '◇', tint: '#e879f9' },
  storage: { glyph: '▦', tint: '#3b82f6' },
  system: { glyph: '⚙', tint: '#888888' },
  unknown: { glyph: '◻', tint: '#888888' },
} as const;
const kindOf = (k: string) => KIND[k as keyof typeof KIND] ?? KIND.unknown;

const statusTint = (s: string): string => {
  if (s === 'ACTIVE' || s === 'RUNNING') return T.ok;
  if (s.includes('FAIL') || s.includes('ERROR')) return T.err;
  if (s.startsWith('READY') || s === 'NEW' || s.includes('CREAT')) return T.warn;
  return T.dim;
};

const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

const card: React.CSSProperties = {
  width: 178, boxSizing: 'border-box', borderRadius: 14, padding: 12,
  background: T.panel, border: `1px solid ${T.line}`,
  boxShadow: '0 6px 18px rgba(0,0,0,.45)', fontFamily: SANS,
};

/* ------------------------------------------------------------------ nodes */

function ServiceNode({ data }: NodeProps) {
  const n = data['node'] as ArchNode;
  const k = kindOf(n.kind);
  return (
    <div style={{ ...card, ...(n.system ? { background: T.raised } : {}) }}>
      <Handle type="target" position={Position.Left} style={{ background: T.line2, width: 7, height: 7 }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: k.tint, fontSize: 14 }}>{k.glyph}</span>
        <span style={{ color: T.faint, fontFamily: T.mono, fontSize: 10 }}>
          {n.containers === null ? '—' : `×${n.containers}`}
        </span>
      </div>
      <div style={{ color: T.text, fontWeight: 700, fontSize: 13.5, marginTop: 8 }}>{n.name}</div>
      <div style={{ color: T.faint, fontSize: 10.5 }}>{n.typeName}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 8 }}>
        <span style={{ width: 6, height: 6, borderRadius: 3, background: statusTint(n.status) }} />
        <span style={{ color: statusTint(n.status), fontFamily: T.mono, fontSize: 9, letterSpacing: 0.4 }}>{n.status}</span>
        {n.ha && <span style={{ color: T.ok, fontFamily: T.mono, fontSize: 9 }}>HA</span>}
        {n.publicHttp && <span style={{ color: T.accentBlue, fontFamily: T.mono, fontSize: 9 }}>www</span>}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: T.line2, width: 7, height: 7 }} />
    </div>
  );
}

function GhostNode({ data }: NodeProps) {
  const g = data['ghost'] as Ghost;
  const added = data['added'] === true;
  const weak = g.confidence === 'likely';
  const tint = added ? T.primary : weak ? T.warn : T.err;
  return (
    <div style={{ ...card, background: 'transparent', border: `1px dashed ${tint}`, boxShadow: 'none' }}>
      <Handle type="target" position={Position.Left} style={{ background: tint, width: 7, height: 7 }} />
      <div style={{ color: tint, fontSize: 14 }}>◌</div>
      <div style={{ color: T.text, fontWeight: 700, fontSize: 13.5, marginTop: 8 }}>{g.type}</div>
      <div style={{ color: tint, fontSize: 10.5 }}>{added ? 'added by you' : weak ? 'maybe missing' : 'missing'}</div>
      <div style={{ color: T.faint, fontFamily: T.mono, fontSize: 9, letterSpacing: 0.4, marginTop: 8 }}>
        NOT PROVISIONED
      </div>
    </div>
  );
}

function RepoNode({ data }: NodeProps) {
  const r = data['repo'] as NonNullable<Board['repo']>;
  const leaf = r.dir.split('/').filter(Boolean).pop() ?? r.dir;
  return (
    <div style={{ ...card, width: 232 }}>
      <div style={{ color: T.faint, fontFamily: T.mono, fontSize: 9, letterSpacing: 0.6 }}>REPOSITORY</div>
      <div style={{ color: T.text, fontWeight: 700, fontSize: 14, marginTop: 4 }}>{leaf}</div>
      <div style={{ color: T.faint, fontFamily: T.mono, fontSize: 10, marginTop: 2 }}>
        {r.scanned.join(' · ') || 'no manifests'}
      </div>
      <div style={{ height: 1, background: T.line, margin: '10px 0' }} />
      <div style={{ display: 'flex', gap: 14, fontSize: 11.5 }}>
        <span style={{ color: T.dim }}>● {r.satisfied} satisfied</span>
        <span style={{ color: r.missing > 0 ? T.err : T.dim }}>● {r.missing} missing</span>
      </div>
      <Handle type="source" position={Position.Right} style={{ background: T.line2, width: 7, height: 7 }} />
    </div>
  );
}

const nodeTypes = { service: ServiceNode, ghost: GhostNode, repo: RepoNode };

/* --------------------------------------------------------------- palette */

/** What you can add by hand — the same closed vocabulary the agent proposes from. */
const PALETTE: ReadonlyArray<{
  group: string;
  items: ReadonlyArray<{ type: string; label: string; note: string; kind: keyof typeof KIND }>;
}> = [
  { group: 'Runtimes', items: [
    { type: 'nodejs', label: 'Node.js', note: 'Runs your JavaScript or TypeScript app', kind: 'runtime' },
    { type: 'python', label: 'Python', note: 'Runs a Python app', kind: 'runtime' },
    { type: 'go', label: 'Go', note: 'Runs a compiled Go binary', kind: 'runtime' },
    { type: 'php', label: 'PHP', note: 'Runs a PHP app', kind: 'runtime' },
    { type: 'rust', label: 'Rust', note: 'Runs a compiled Rust binary', kind: 'runtime' },
    { type: 'static', label: 'Static', note: 'Serves built files, no runtime', kind: 'runtime' },
  ] },
  { group: 'Databases', items: [
    { type: 'postgresql', label: 'PostgreSQL', note: 'Relational database', kind: 'database' },
    { type: 'mariadb', label: 'MariaDB', note: 'MySQL-compatible database', kind: 'database' },
    { type: 'clickhouse', label: 'ClickHouse', note: 'Columnar analytics database', kind: 'database' },
  ] },
  { group: 'Cache & search', items: [
    { type: 'valkey', label: 'Valkey', note: 'Redis-compatible cache and sessions', kind: 'cache' },
    { type: 'meilisearch', label: 'Meilisearch', note: 'Full-text search', kind: 'search' },
    { type: 'typesense', label: 'Typesense', note: 'Typo-tolerant search', kind: 'search' },
    { type: 'elasticsearch', label: 'Elasticsearch', note: 'Search and log analytics', kind: 'search' },
    { type: 'qdrant', label: 'Qdrant', note: 'Vector database for embeddings', kind: 'search' },
  ] },
  { group: 'Messaging & storage', items: [
    { type: 'nats', label: 'NATS', note: 'Message queue for background jobs', kind: 'queue' },
    { type: 'kafka', label: 'Kafka', note: 'Event streaming', kind: 'queue' },
    { type: 'objectstorage', label: 'Object storage', note: 'S3-compatible buckets', kind: 'storage' },
  ] },
];

function AddPalette({
  onAdd, onClose, existing,
}: { onAdd: (type: string) => void; onClose: () => void; existing: ReadonlySet<string> }) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const groups = PALETTE
    .map((g) => ({
      ...g,
      items: g.items.filter((i) => needle === ''
        || i.label.toLowerCase().includes(needle)
        || i.type.includes(needle)
        || i.note.toLowerCase().includes(needle)),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <div style={{
      position: 'absolute', left: 60, top: 16, zIndex: 20, width: 340, maxHeight: '78%',
      display: 'flex', flexDirection: 'column',
      background: '#161616', border: `1px solid ${T.line}`, borderRadius: 14,
      boxShadow: '0 24px 60px rgba(0,0,0,.6)', overflow: 'hidden', fontFamily: SANS,
    }}>
      <div style={{ padding: '14px 16px 10px' }}>
        <div style={{ color: T.text, fontWeight: 700, fontSize: 14 }}>Add a service</div>
        <div style={{ color: T.faint, fontSize: 11.5, lineHeight: 1.5, marginTop: 3 }}>
          Click to place it on the board. Nothing is created until you confirm the import file.
        </div>
      </div>
      <div style={{ padding: '0 12px 10px' }}>
        <input
          autoFocus value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search services…"
          style={{
            width: '100%', boxSizing: 'border-box', background: T.raised, color: T.text,
            border: `1px solid ${T.line}`, borderRadius: 8, padding: '9px 11px', fontSize: 13, outline: 'none',
          }}
        />
      </div>
      <div style={{ overflowY: 'auto', padding: '0 8px 10px' }}>
        {groups.length === 0 && (
          <div style={{ color: T.faint, fontSize: 12.5, padding: '10px 8px' }}>
            Nothing matches “{q}”. Zerops has no service by that name.
          </div>
        )}
        {groups.map((g) => (
          <div key={g.group}>
            <div style={{ color: T.faint, fontFamily: T.mono, fontSize: 9.5, letterSpacing: 0.7, padding: '10px 8px 6px' }}>
              {g.group.toUpperCase()} ({g.items.length})
            </div>
            {g.items.map((i) => {
              const already = existing.has(i.type);
              return (
                <div
                  key={i.type}
                  onClick={() => { if (!already) { onAdd(i.type); onClose(); } }}
                  onMouseEnter={(e) => { if (!already) e.currentTarget.style.background = T.raised; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  style={{
                    display: 'flex', gap: 11, alignItems: 'center', padding: 8,
                    borderRadius: 9, cursor: already ? 'default' : 'pointer', opacity: already ? 0.45 : 1,
                  }}
                >
                  <span style={{
                    width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                    background: `${kindOf(i.kind).tint}1f`, color: kindOf(i.kind).tint,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
                  }}>{kindOf(i.kind).glyph}</span>
                  <span style={{ minWidth: 0 }}>
                    <div style={{ color: T.text, fontSize: 13, fontWeight: 600 }}>
                      {i.label}{already ? ' · already here' : ''}
                    </div>
                    <div style={{
                      color: T.faint, fontSize: 11, whiteSpace: 'nowrap',
                      overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{i.note}</div>
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div
        onClick={onClose}
        style={{ borderTop: `1px solid ${T.line}`, padding: '9px 16px', color: T.faint, fontSize: 11.5, cursor: 'pointer' }}
      >
        Close
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- left rail */

type Tool = 'select' | 'pan';

/** Rail glyphs, drawn — 16px line art at a single 1.7 weight so the column reads as one set. */
function RailIcon({ name }: { name: 'cursor' | 'hand' | 'plus' | 'zoomIn' | 'zoomOut' | 'fit' }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return (
    <svg width={16} height={16} viewBox="0 0 20 20" aria-hidden>
      {name === 'cursor' && <path {...p} d="M4 3 L4 15.5 L7.6 12.2 L10 17 L12.2 15.9 L9.9 11.2 L14.6 11 Z" />}
      {name === 'hand' && (
        <path {...p} d="M7 9.5V4.6a1.1 1.1 0 0 1 2.2 0v4.2m0-.6V3.6a1.1 1.1 0 0 1 2.2 0v5m0-.8V5.1a1.1 1.1 0 0 1 2.2 0v6.3c0 3.1-2 5.3-4.8 5.3-2.4 0-3.7-1.2-5-3.6L2.8 11c-.5-.9.6-2 1.6-1.3L7 12" />
      )}
      {name === 'plus' && <path {...p} d="M10 4.5v11M4.5 10h11" />}
      {name === 'zoomIn' && <><circle {...p} cx="8.8" cy="8.8" r="5.3" /><path {...p} d="M12.7 12.7 17 17M6.8 8.8h4M8.8 6.8v4" /></>}
      {name === 'zoomOut' && <><circle {...p} cx="8.8" cy="8.8" r="5.3" /><path {...p} d="M12.7 12.7 17 17M6.8 8.8h4" /></>}
      {name === 'fit' && <path {...p} d="M3 7V3.8A.8.8 0 0 1 3.8 3H7m6 0h3.2a.8.8 0 0 1 .8.8V7m0 6v3.2a.8.8 0 0 1-.8.8H13M7 17H3.8a.8.8 0 0 1-.8-.8V13" />}
    </svg>
  );
}

/* ------------------------------------------------------------------ board */

const COL = 250;
const ROW = 150;

interface CanvasProps {
  board: Board;
  onAdd: (t: string) => void;
  /** The board's one primary action: turn everything dashed into an import file. */
  onProvision: () => void;
  busy: boolean;
}

function Inner({ board, onAdd, onProvision, busy }: CanvasProps) {
  const { graph, ghosts, repo, wiring, added } = board;
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [tool, setTool] = useState<Tool>('select');

  /**
   * Saved positions win, so an arrangement survives a rescan and a restart.
   *
   * Read SYNCHRONOUSLY, not in an effect: the layout has to be in hand before the first
   * `initial` is computed, and an effect runs after it. Done the other way the saved
   * arrangement is ignored on load and only reappears if something later happens to
   * invalidate the memo — which is the kind of bug that looks like flakiness.
   */
  const saved = useRef<{ pid: string; at: Record<string, { x: number; y: number }> }>({ pid: '', at: {} });
  if (saved.current.pid !== graph.projectId) {
    let at: Record<string, { x: number; y: number }> = {};
    try {
      const raw = globalThis.localStorage?.getItem(`notch.flow.${graph.projectId}`);
      if (raw !== null && raw !== undefined) at = JSON.parse(raw) as typeof at;
    } catch { at = {}; }
    saved.current = { pid: graph.projectId, at };
  }

  const initial = useMemo<Node[]>(() => {
    const out: Node[] = [];
    const at = (id: string, x: number, y: number) => saved.current.at[id] ?? { x, y };
    if (repo !== null) out.push({ id: 'repo', type: 'repo', position: at('repo', 0, 200), data: { repo } });

    const runtimeIdx = graph.nodes.findIndex((n) => n.kind === 'runtime');
    let row = 0;
    graph.nodes.forEach((n, i) => {
      const isRuntime = i === runtimeIdx;
      const x = isRuntime ? 340 : 340 + COL;
      const y = isRuntime ? 200 : row++ * ROW;
      out.push({ id: `s:${n.id}`, type: 'service', position: at(`s:${n.id}`, x, y), data: { node: n } });
    });
    ghosts.forEach((g) => out.push({
      id: `g:${g.type}`, type: 'ghost',
      position: at(`g:${g.type}`, 340 + COL, row++ * ROW),
      data: { ghost: g, added: added.includes(g.type) },
    }));
    return out;
  }, [graph, ghosts, repo, added]);

  const [nodes, setNodes] = useState<Node[]>(initial);
  useEffect(() => { setNodes(initial); }, [initial]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((cur) => {
      const next = applyNodeChanges(changes, cur);
      // Remember the arrangement, but only once a drag has FINISHED: a drag fires dozens of
      // changes a second and localStorage is synchronous.
      if (changes.some((c) => c.type === 'position' && c.dragging === false)) {
        const map: Record<string, { x: number; y: number }> = {};
        for (const n of next) map[n.id] = n.position;
        saved.current = { pid: graph.projectId, at: map };
        try {
          globalThis.localStorage?.setItem(`notch.flow.${graph.projectId}`, JSON.stringify(map));
        } catch { /* private mode */ }
      }
      return next;
    });
  }, [graph.projectId]);

  const edges = useMemo<Edge[]>(() => {
    const out: Edge[] = [];
    const idFor = (type: string): string | null => {
      const t = type.toLowerCase();
      const svc = graph.nodes.find((n) => {
        const k = n.typeName.toLowerCase().replace(/[^a-z0-9]/g, '');
        return k.includes(t) || t.includes(k) || n.name.toLowerCase() === t;
      });
      if (svc !== undefined) return `s:${svc.id}`;
      const gh = ghosts.find((g) => g.type.toLowerCase() === t);
      return gh === undefined ? null : `g:${gh.type}`;
    };

    const rt = wiring?.runtime === undefined || wiring?.runtime === null ? null : idFor(wiring.runtime);
    if (repo !== null && rt !== null) {
      out.push({
        id: 'repo->runtime', source: 'repo', target: rt, animated: true,
        style: { stroke: repo.missing > 0 ? T.err : T.ok, strokeWidth: 1.6 },
        label: 'scanned', labelStyle: { fill: T.faint, fontSize: 10 }, labelBgStyle: { fill: T.bg },
      });
    }
    for (const e of wiring?.edges ?? []) {
      const to = idFor(e.to);
      if (rt === null || to === null || to === rt) continue;
      out.push({
        id: `w:${e.to}`, source: rt, target: to, animated: e.deployed,
        style: {
          stroke: !e.deployed ? T.err : e.confidence === 'likely' ? T.warn : T.thread,
          strokeWidth: 1.4, strokeDasharray: e.deployed ? undefined : '5 4',
        },
        label: e.found,
        labelStyle: { fill: T.faint, fontSize: 9.5, fontFamily: T.mono },
        labelBgStyle: { fill: T.bg, fillOpacity: 0.85 },
      });
    }
    return out;
  }, [graph.nodes, ghosts, repo, wiring]);

  const existing = useMemo(
    () => new Set([...graph.nodes.map((n) => n.typeName.toLowerCase()), ...ghosts.map((g) => g.type)]),
    [graph.nodes, ghosts]);

  const btn = (on: boolean): React.CSSProperties => ({
    width: 34, height: 34, borderRadius: 9, display: 'flex', alignItems: 'center',
    justifyContent: 'center', border: `1px solid ${on ? T.bright : T.line}`,
    background: on ? T.bright : T.panel, color: on ? T.onBright : T.dim, cursor: 'pointer',
  });

  return (
    <div style={{ position: 'absolute', inset: 0, background: T.bg }}>
      {/*
        Four rules React Flow's own stylesheet owns and this palette needs back: a tile that
        lifts while you hold it, a marquee in Notch violet rather than the default blue, a
        selected tile ringed instead of recoloured, and a grab cursor over empty canvas so the
        pan tool looks like what it does.
      */}
      <style>{`
        .react-flow__node { transition: box-shadow 140ms ease, transform 60ms ease; }
        .react-flow__node.dragging > div {
          box-shadow: 0 18px 40px rgba(0,0,0,.65) !important;
          transform: scale(1.02);
        }
        .react-flow__node.selected > div { border-color: ${T.primary} !important; }
        .react-flow__selection {
          background: ${T.primary}1a; border: 1px solid ${T.primary};
        }
        .react-flow__pane.draggable { cursor: grab; }
        .react-flow__pane.dragging { cursor: grabbing; }
      `}</style>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={1.8}
        proOptions={{ hideAttribution: true }}
        /*
         * Two drag meanings, one gesture, so the tool has to say which. In select, dragging
         * empty canvas draws a marquee and the middle button still pans; in pan, dragging
         * anywhere moves the board. Nodes drag in both — that never becomes modal.
         */
        panOnDrag={tool === 'pan' ? true : [1, 2]}
        selectionOnDrag={tool === 'select'}
        onDoubleClick={() => setPaletteOpen(true)}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.6} color="#303030" />
      </ReactFlow>

      {/* The rail: what to add, how to point, how to frame. */}
      <div style={{
        position: 'absolute', left: 12, top: 16, display: 'flex',
        flexDirection: 'column', gap: 6, zIndex: 15,
      }}>
        <div title="Add a service" onClick={() => setPaletteOpen((v) => !v)} style={btn(paletteOpen)}>
          <RailIcon name="plus" />
        </div>
        <div style={{ height: 7 }} />
        <div title="Select" onClick={() => setTool('select')} style={btn(tool === 'select')}>
          <RailIcon name="cursor" />
        </div>
        <div title="Pan" onClick={() => setTool('pan')} style={btn(tool === 'pan')}>
          <RailIcon name="hand" />
        </div>
        <div style={{ height: 7 }} />
        <div title="Zoom in" onClick={() => void zoomIn({ duration: 160 })} style={btn(false)}>
          <RailIcon name="zoomIn" />
        </div>
        <div title="Zoom out" onClick={() => void zoomOut({ duration: 160 })} style={btn(false)}>
          <RailIcon name="zoomOut" />
        </div>
        <div title="Fit to view" onClick={() => void fitView({ padding: 0.25, duration: 250 })} style={btn(false)}>
          <RailIcon name="fit" />
        </div>
      </div>

      {paletteOpen && <AddPalette existing={existing} onClose={() => setPaletteOpen(false)} onAdd={onAdd} />}

      {/* Which project you are looking at, without stealing a header row from the canvas. */}
      <div style={{
        position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 12,
        display: 'flex', alignItems: 'center', gap: 9, padding: '7px 14px',
        background: T.panel, border: `1px solid ${T.line}`, borderRadius: 999,
        boxShadow: '0 8px 24px rgba(0,0,0,.5)', fontFamily: SANS, pointerEvents: 'none',
      }}>
        <span style={{ width: 6, height: 6, borderRadius: 3, background: statusTint(graph.status) }} />
        <span style={{ color: T.text, fontSize: 12.5, fontWeight: 600 }}>{graph.projectName}</span>
        <span style={{ color: T.faint, fontFamily: T.mono, fontSize: 10.5 }}>
          {graph.nodes.length} live{ghosts.length > 0 ? ` · ${ghosts.length} missing` : ''}
        </span>
      </div>

      {/* One primary action, and only when there is something to act on. */}
      {ghosts.length > 0 && (
        <div
          onClick={() => { if (!busy) onProvision(); }}
          style={{
            position: 'absolute', right: 18, bottom: 18, zIndex: 12,
            padding: '11px 18px', borderRadius: 11, cursor: busy ? 'default' : 'pointer',
            background: busy ? T.raised : T.bright, color: busy ? T.dim : T.onBright,
            fontFamily: SANS, fontSize: 13, fontWeight: 700,
            boxShadow: '0 10px 30px rgba(0,0,0,.55)',
          }}
        >
          {busy ? 'Working…' : `Provision ${ghosts.length} service${ghosts.length === 1 ? '' : 's'}`}
        </div>
      )}

      {/*
        Nothing scanned yet: say what to do next.

        Centred only when the canvas is genuinely empty. With services on the board it moves to
        the corner, because an instruction printed across the diagram is worse than no
        instruction — it reads as a caption on the tiles it is covering.
      */}
      {repo === null && ghosts.length === 0 && (nodes.length === 0 ? (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'center', pointerEvents: 'none',
        }}>
          <div style={{ textAlign: 'center', color: T.faint, fontSize: 13, lineHeight: 1.6, maxWidth: 380, fontFamily: SANS }}>
            <div style={{ color: T.dim, fontSize: 14, marginBottom: 6 }}>This project is empty.</div>
            Scan a repository to see what its code needs, or press + to place a service by hand.
          </div>
        </div>
      ) : (
        <div style={{
          position: 'absolute', left: 58, bottom: 18, maxWidth: 320, zIndex: 12,
          padding: '10px 13px', background: T.panel, border: `1px solid ${T.line}`,
          borderRadius: 11, color: T.faint, fontSize: 12, lineHeight: 1.55, fontFamily: SANS,
          pointerEvents: 'none',
        }}>
          <span style={{ color: T.dim }}>Everything already in this project.</span> Scan a
          repository to see what it needs and this has not got.
        </div>
      ))}
    </div>
  );
}

/**
 * The canvas fills whatever it is dropped into.
 *
 * React Flow measures its own container and refuses to lay out inside one with no height —
 * it renders, silently, at zero pixels. So the flex slot is claimed by a react-native View
 * and the DOM canvas is pinned to its box, rather than trusting `height: 100%` to resolve
 * through the react-native-web tree.
 */
export function ArchCanvas(props: CanvasProps) {
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <ReactFlowProvider>
        <Inner {...props} />
      </ReactFlowProvider>
    </View>
  );
}
