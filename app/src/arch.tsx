/**
 * The board: your account's projects, the services inside them, and the repository they were
 * measured against.
 *
 * The composition follows the Zerops architecture diagrams — projects as grouped containers
 * with a status pill, services as small tiles inside them, and curved connectors between the
 * thing that caused a change and the thing it changed. Rendered in graphite rather than on
 * white, because this is a tool that sits open next to an editor, not a diagram in a doc.
 *
 * TWO DECISIONS THAT ARE THE WHOLE POINT:
 *
 *   Gaps are drawn INSIDE the project they are missing from. An earlier version put ghosts in
 *   their own row underneath, which quietly said "here is a list of problems" — the same thing
 *   a sidebar already says. In place, a project with holes in it looks like a project with
 *   holes in it, and the shape of the gap is the finding.
 *
 *   The repository is a node on the board, not a text field somewhere else. What the graph is
 *   actually about is the relationship between a repo and the infrastructure it expects, so
 *   the repo is drawn, and the connector carries the verdict.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, ScrollView, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { T, radii } from './theme';
import type { ArchNode, Graph, Wiring } from './api';

export interface Ghost { type: string; reason: string; confidence: string }

export interface Board {
  graph: Graph;
  ghosts: Ghost[];
  /** The scanned repository, when there has been a scan. */
  repo: { dir: string; scanned: string[]; satisfied: number; missing: number } | null;
  /** Edges read out of the code. `null` before a scan. */
  wiring: Wiring | null;
}

/* ------------------------------------------------------------------ tiles */

const TILE_W = 108;
const TILE_H = 84;
const TILE_GAP = 12;
const PER_ROW = 4;

/**
 * A mark per service kind.
 *
 * Deliberately drawn from the same small vocabulary rather than emoji: emoji render at a
 * different weight on every platform and turn a technical board into a sticker sheet.
 */
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

function ServiceTile({ n }: { n: ArchNode }) {
  const k = kindOf(n.kind);
  return (
    <View
      style={{
        width: TILE_W, height: TILE_H,
        backgroundColor: T.panel,
        borderColor: T.line, borderWidth: 1, borderRadius: radii.card,
        padding: 10, justifyContent: 'space-between',
        // A real offset and blur. A zero-offset halo is decoration, not depth.
        shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: k.tint, fontSize: 13 }}>{k.glyph}</Text>
        {/* Container count as a fact, not a chart. `null` means never deployed. */}
        <Text style={{ color: T.faint, fontFamily: T.mono, fontSize: 9.5 }}>
          {n.containers === null ? '—' : `×${n.containers}`}
        </Text>
      </View>

      <View>
        <Text numberOfLines={1} style={{ color: T.text, fontWeight: '700', fontSize: 12.5 }}>{n.name}</Text>
        <Text numberOfLines={1} style={{ color: T.faint, fontSize: 10, marginTop: 1 }}>{n.typeName}</Text>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: statusTint(n.status) }} />
        <Text numberOfLines={1} style={{ color: statusTint(n.status), fontFamily: T.mono, fontSize: 8.5, letterSpacing: 0.4 }}>
          {n.status}
        </Text>
        {n.ha && <Text style={{ color: T.ok, fontFamily: T.mono, fontSize: 8.5 }}>HA</Text>}
        {n.publicHttp && <Text style={{ color: T.accentBlue, fontFamily: T.mono, fontSize: 8.5 }}>www</Text>}
      </View>
    </View>
  );
}

function GhostTile({ g }: { g: Ghost }) {
  const weak = g.confidence === 'likely';
  const tint = weak ? T.warn : T.err;
  return (
    <View
      style={{
        width: TILE_W, height: TILE_H,
        backgroundColor: 'transparent',
        borderColor: tint, borderWidth: 1, borderStyle: 'dashed', borderRadius: radii.card,
        padding: 10, justifyContent: 'space-between',
      }}
    >
      <Text style={{ color: tint, fontSize: 13 }}>◌</Text>
      <View>
        <Text numberOfLines={1} style={{ color: T.text, fontWeight: '700', fontSize: 12.5 }}>{g.type}</Text>
        <Text numberOfLines={1} style={{ color: tint, fontSize: 10, marginTop: 1 }}>
          {weak ? 'maybe missing' : 'missing'}
        </Text>
      </View>
      <Text style={{ color: T.faint, fontFamily: T.mono, fontSize: 8.5, letterSpacing: 0.4 }}>NOT PROVISIONED</Text>
    </View>
  );
}

/* -------------------------------------------------------------- container */

const PAD = 16;
const HEAD = 34;

const rowsFor = (count: number) => Math.max(1, Math.ceil(count / PER_ROW));
const gridHeight = (count: number) => rowsFor(count) * TILE_H + (rowsFor(count) - 1) * TILE_GAP;

/**
 * Border-box, and the two pixels are load-bearing.
 *
 * React Native measures `width` inclusive of padding AND border, so a container sized to
 * `padding + tiles` is 2px too narrow once its 1px border is charged to the same budget. At
 * four 108px tiles that left 466px of room for 468px of content: the fourth tile wrapped, the
 * grid needed a row it had not been given, and the last tile — always a ghost, always the
 * finding — hung outside the container's bottom edge.
 */
const BORDER = 1;

function projectSize(count: number) {
  const cols = Math.min(Math.max(count, 1), PER_ROW);
  return {
    w: BORDER * 2 + PAD * 2 + cols * TILE_W + (cols - 1) * TILE_GAP,
    h: BORDER * 2 + PAD * 2 + HEAD + gridHeight(count),
  };
}

/** Centre of tile `i` in the wrapped grid, relative to the container's padding box. */
const tileCentre = (i: number) => ({
  x: PAD + (i % PER_ROW) * (TILE_W + TILE_GAP) + TILE_W / 2,
  y: PAD + HEAD + Math.floor(i / PER_ROW) * (TILE_H + TILE_GAP) + TILE_H / 2,
});

/**
 * Where each tile sits, and the fact that you can move it.
 *
 * The grid is only a STARTING arrangement. Anybody reading an architecture diagram wants to
 * pull the thing they care about into the middle and push the noise to the edge, and a diagram
 * you cannot rearrange is a picture rather than a tool. So every tile is draggable, the edges
 * follow the tiles rather than the grid, and the arrangement is remembered per project — you
 * come back tomorrow to the layout you left.
 *
 * A movement THRESHOLD separates a drag from a click: without one, every press nudges a card a
 * pixel or two and the board slowly falls out of alignment just from being used.
 */
const DRAG_THRESHOLD = 3;

interface Tile {
  key: string;
  kind: 'service' | 'ghost';
  node?: ArchNode;
  ghost?: Ghost;
  /** What `wiring` calls this, so an edge can find its tile. */
  type: string;
}

function layoutKey(projectId: string): string {
  return `notch.layout.${projectId}`;
}

function loadLayout(projectId: string): Record<string, XY> {
  try {
    const raw = globalThis.localStorage?.getItem(layoutKey(projectId));
    return raw === null || raw === undefined ? {} : JSON.parse(raw) as Record<string, XY>;
  } catch { return {}; }
}

function saveLayout(projectId: string, pos: Record<string, XY>): void {
  try { globalThis.localStorage?.setItem(layoutKey(projectId), JSON.stringify(pos)); } catch { /* private mode */ }
}

interface XY { x: number; y: number }

function DraggableTile({
  tile, at, onMove, onGrab, onDrop,
}: {
  tile: Tile; at: XY;
  onMove: (k: string, p: XY) => void;
  onGrab: (k: string) => void;
  onDrop: () => void;
}) {
  /*
   * The responder is created ONCE and reads everything through refs.
   *
   * A first version rebuilt it with `useMemo` whenever the tile's position changed — which is
   * every frame of a drag. Each rebuild handed react-native-web a different responder object
   * mid-gesture, the gesture was dropped after the first move, and a 260px drag moved the card
   * 19px. Gesture handlers have to outlive the values they act on.
   */
  const atRef = useRef(at);
  atRef.current = at;
  const origin = useRef<XY>(at);
  const cb = useRef({ onMove, onGrab, onDrop });
  cb.current = { onMove, onGrab, onDrop };

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    // Claim the gesture only once it is actually a drag, so a tap stays a tap.
    onMoveShouldSetPanResponder: (_e, g) =>
      Math.abs(g.dx) > DRAG_THRESHOLD || Math.abs(g.dy) > DRAG_THRESHOLD,
    onPanResponderGrant: () => { origin.current = atRef.current; cb.current.onGrab(tile.key); },
    onPanResponderMove: (_e, g) => {
      // Clamped at zero: a tile dragged past the top-left would sit outside the container and
      // become unreachable, since the canvas only scrolls in the positive direction.
      cb.current.onMove(tile.key, {
        x: Math.max(0, origin.current.x + g.dx),
        y: Math.max(0, origin.current.y + g.dy),
      });
    },
    onPanResponderRelease: () => cb.current.onDrop(),
    onPanResponderTerminate: () => cb.current.onDrop(),
    onPanResponderTerminationRequest: () => false,
  })).current;

  return (
    <View
      {...pan.panHandlers}
      style={{ position: 'absolute', left: at.x, top: at.y, cursor: 'grab' } as object}
    >
      {tile.kind === 'service' && tile.node !== undefined
        ? <ServiceTile n={tile.node} />
        : tile.ghost !== undefined ? <GhostTile g={tile.ghost} /> : null}
    </View>
  );
}

function ProjectGroup({
  projectId, name, status, nodes, ghosts, wiring, onSize,
}: {
  projectId: string; name: string; status: string;
  nodes: ArchNode[]; ghosts: Ghost[]; wiring: Wiring | null;
  /** The container tells the canvas how big it has become, so nothing gets clipped. */
  onSize: (s: { w: number; h: number }) => void;
}) {
  const tint = statusTint(status);

  const tiles: Tile[] = useMemo(() => [
    ...nodes.map((n) => ({
      key: `s:${n.id}`, kind: 'service' as const, node: n,
      type: n.typeName.toLowerCase().replace(/[^a-z0-9]/g, ''),
    })),
    ...ghosts.map((g) => ({ key: `g:${g.type}`, kind: 'ghost' as const, ghost: g, type: g.type.toLowerCase() })),
  ], [nodes, ghosts]);

  /*
   * Saved positions win; anything new falls into the next free grid slot. A service
   * provisioned after you arranged the board should appear somewhere sensible without
   * disturbing the arrangement you made.
   */
  const [pos, setPos] = useState<Record<string, XY>>({});
  const [dragging, setDragging] = useState<string | null>(null);

  useEffect(() => {
    const saved = loadLayout(projectId);
    setPos(() => {
      const next: Record<string, XY> = {};
      tiles.forEach((t, i) => { next[t.key] = saved[t.key] ?? tileCentre(i); });
      return next;
    });
  }, [projectId, tiles]);

  const move = useCallback((k: string, p: XY) => {
    setPos((cur) => ({ ...cur, [k]: p }));
  }, []);

  // Written on release rather than on every frame: a drag fires dozens of updates a second and
  // localStorage is synchronous.
  useEffect(() => {
    if (dragging !== null || Object.keys(pos).length === 0) return;
    saveLayout(projectId, pos);
  }, [dragging, pos, projectId]);

  const reset = () => {
    const next: Record<string, XY> = {};
    tiles.forEach((t, i) => { next[t.key] = tileCentre(i); });
    setPos(next);
    saveLayout(projectId, next);
  };

  const centreOf = (k: string): XY => {
    const p = pos[k] ?? { x: 0, y: 0 };
    return { x: p.x + TILE_W / 2, y: p.y + TILE_H / 2 };
  };

  const byType = (type: string): Tile | undefined => {
    const t = type.toLowerCase();
    return tiles.find((x) => x.type.includes(t) || t.includes(x.type));
  };

  const runtimeTile = wiring?.runtime === undefined || wiring?.runtime === null ? undefined : byType(wiring.runtime);
  const wires = runtimeTile === undefined || wiring === null ? [] : wiring.edges.flatMap((e) => {
    const target = byType(e.to);
    if (target === undefined || target.key === runtimeTile.key) return [];
    return [{
      key: `${e.from}-${e.to}`,
      a: centreOf(runtimeTile.key), b: centreOf(target.key),
      colour: !e.deployed ? T.err : e.confidence === 'likely' ? T.warn : T.thread,
      dashed: !e.deployed,
    }];
  });

  // The container grows to hold wherever the tiles have been put.
  const extent = Object.values(pos).reduce(
    (m, p) => ({ w: Math.max(m.w, p.x + TILE_W), h: Math.max(m.h, p.y + TILE_H) }),
    { w: TILE_W, h: TILE_H });
  /*
   * No padding on the container, because the tiles are absolutely positioned.
   *
   * React Native lays absolute children out against the PADDING box, so a container with
   * `padding: 16` shifted every tile another 16px in — the coordinates already include it, and
   * the bottom row hung outside the border. The header carries its own padding instead and the
   * tile coordinates are the single source of position.
   */
  const width = extent.w + PAD + BORDER * 2;
  // Bottom room equal to the left inset, so the last row is not shaved by the border.
  const height = extent.h + PAD * 2 + BORDER * 2;

  /*
   * Tell the canvas how big this got.
   *
   * react-native-web puts `overflow: hidden` on every View, and the canvas above was sized
   * from the ORIGINAL grid — so the moment a tile was dragged past the starting bounds the
   * container was silently cropped by its own parent. Dragging is the whole feature; the
   * canvas has to grow with it.
   */
  useEffect(() => { onSize({ w: width, h: height }); }, [width, height, onSize]);

  return (
    <View
      style={{
        width, height,
        backgroundColor: '#151515',
        borderColor: ghosts.length > 0 ? '#3a2328' : T.line,
        borderWidth: BORDER, borderRadius: 18,
      }}
    >
      <View style={{
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        height: HEAD, paddingHorizontal: PAD, paddingTop: PAD,
      }}>
        <Text style={{ color: T.text, fontWeight: '700', fontSize: 13.5 }}>{name}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text
            onPress={reset}
            style={{
              color: T.dim, fontFamily: T.mono, fontSize: 9.5, letterSpacing: 0.4,
              backgroundColor: T.raised, borderColor: T.line, borderWidth: 1,
              borderRadius: radii.pill, paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden',
            }}
          >
            TIDY UP
          </Text>
          {ghosts.length > 0 && (
            <View style={{ backgroundColor: '#2a1a1e', borderColor: '#4a2b32', borderWidth: 1, borderRadius: radii.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
              <Text style={{ color: T.err, fontFamily: T.mono, fontSize: 9.5, letterSpacing: 0.4 }}>
                {ghosts.length} MISSING
              </Text>
            </View>
          )}
          <View style={{ backgroundColor: T.raised, borderColor: T.line, borderWidth: 1, borderRadius: radii.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
            <Text style={{ color: tint, fontFamily: T.mono, fontSize: 9.5, letterSpacing: 0.4 }}>{status}</Text>
          </View>
        </View>
      </View>

      {/* Behind the cards, and following them: the edges the code claims. */}
      {wires.length > 0 && (
        <View pointerEvents="none" style={{ position: 'absolute', left: BORDER, top: BORDER }}>
          <Svg width={width} height={height}>
            {wires.map((w) => {
              const dx = Math.max(28, Math.abs(w.b.x - w.a.x) * 0.45);
              const d = `M ${w.a.x} ${w.a.y} C ${w.a.x + dx} ${w.a.y}, ${w.b.x - dx} ${w.b.y}, ${w.b.x} ${w.b.y}`;
              return (
                <Path key={w.key} d={d} stroke={w.colour} strokeWidth={1.4} fill="none"
                  opacity={w.dashed ? 0.55 : 0.75}
                  strokeDasharray={w.dashed ? '4 4' : undefined} strokeLinecap="round" />
              );
            })}
          </Svg>
        </View>
      )}

      <View style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}>
        {tiles.map((t) => (
          <DraggableTile
            key={t.key}
            tile={t}
            at={pos[t.key] ?? { x: 0, y: 0 }}
            onMove={move}
            onGrab={setDragging}
            onDrop={() => setDragging(null)}
          />
        ))}
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ board */

/**
 * The connector.
 *
 * A cubic bezier with horizontal control points, so it leaves one card and arrives at the
 * other travelling sideways — the shape a wire takes on a board, rather than a diagonal line
 * drawn between two points.
 */
function Connector({ from, to, tint }: { from: { x: number; y: number }; to: { x: number; y: number }; tint: string }) {
  const dx = Math.max(48, Math.abs(to.x - from.x) * 0.6);
  const d = `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
  return (
    <>
      <Path d={d} stroke={tint} strokeWidth={1.5} fill="none" strokeLinecap="round" opacity={0.75} />
      {/* Endpoints, so the wire reads as attached rather than passing behind. */}
      <Circle cx={from.x} cy={from.y} r={3} fill={tint} />
      <Circle cx={to.x} cy={to.y} r={3} fill={tint} />
    </>
  );
}

const REPO_W = 268;

export function ArchCanvas({ board }: { board: Board }) {
  const { graph, ghosts, repo } = board;

  // Starts as the grid's size and follows the container once tiles are moved.
  const [groupSize, setGroupSize] = useState(() => projectSize(graph.nodes.length + ghosts.length));
  const onSize = useCallback((s: { w: number; h: number }) => {
    setGroupSize((cur) => (cur.w === s.w && cur.h === s.h ? cur : s));
  }, []);

  const layout = useMemo(() => {
    const size = groupSize;
    const repoH = repo === null ? 0 : 116;
    const gapX = 96;

    // Repo on the left, the project it was measured against on the right. With no scan there
    // is nothing on the left and the project sits where the eye starts.
    const projX = repo === null ? 0 : REPO_W + gapX;
    const projY = 0;
    const repoY = Math.max(0, (size.h - repoH) / 2);

    return {
      size, repoH, projX, projY, repoY,
      width: projX + size.w,
      height: Math.max(size.h, repoY + repoH),
      // Connector endpoints: the right edge of the repo card, the left edge of the container.
      from: { x: REPO_W, y: repoY + repoH / 2 },
      to: { x: projX, y: projY + size.h / 2 },
    };
  }, [groupSize, repo]);

  const verdictTint = ghosts.length > 0 ? T.err : T.ok;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: T.bg }} contentContainerStyle={{ padding: 28 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ width: layout.width, height: layout.height }}>
          {repo !== null && (
            <>
              {/*
                An explicit pixel size on <Svg>, and a solid stroke.
                "100%" left the canvas zero-sized in react-native-svg's web build, and a
                `url(#…)` gradient reference did not resolve there either — between them the
                connector rendered as nothing at all, with no error. Concrete numbers and a
                plain colour draw.
              */}
              <View style={{ position: 'absolute', left: 0, top: 0 }} pointerEvents="none">
                <Svg width={layout.width} height={layout.height}>
                  <Connector from={layout.from} to={layout.to} tint={verdictTint} />
                </Svg>
              </View>

              <View style={{ position: 'absolute', left: 0, top: layout.repoY, width: REPO_W }}>
                <RepoCard repo={repo} missing={ghosts.length} />
              </View>
            </>
          )}

          <View style={{ position: 'absolute', left: layout.projX, top: layout.projY }}>
            <ProjectGroup
              projectId={graph.projectId}
              name={graph.projectName}
              status={graph.status}
              nodes={graph.nodes}
              ghosts={ghosts}
              wiring={board.wiring}
              onSize={onSize}
            />
          </View>
        </View>
      </ScrollView>
    </ScrollView>
  );
}

function RepoCard({ repo, missing }: { repo: NonNullable<Board['repo']>; missing: number }) {
  const leaf = repo.dir.split('/').filter(Boolean).pop() ?? repo.dir;
  return (
    <View
      style={{
        backgroundColor: T.panel, borderColor: T.line, borderWidth: 1, borderRadius: 18, padding: 14,
        shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 14, shadowOffset: { width: 0, height: 6 },
      }}
    >
      <Text style={{ color: T.faint, fontFamily: T.mono, fontSize: 9.5, letterSpacing: 0.6 }}>REPOSITORY</Text>
      <Text numberOfLines={1} style={{ color: T.text, fontWeight: '700', fontSize: 14, marginTop: 4 }}>{leaf}</Text>
      <Text numberOfLines={1} style={{ color: T.faint, fontFamily: T.mono, fontSize: 10, marginTop: 2 }}>
        {repo.scanned.join(' · ') || 'no manifests'}
      </Text>

      <View style={{ height: 1, backgroundColor: T.line, marginVertical: 10 }} />

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: T.ok }} />
          <Text style={{ color: T.dim, fontSize: 11.5 }}>{repo.satisfied} satisfied</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: missing > 0 ? T.err : T.faint }} />
          <Text style={{ color: missing > 0 ? T.err : T.dim, fontSize: 11.5 }}>{missing} missing</Text>
        </View>
      </View>
    </View>
  );
}
