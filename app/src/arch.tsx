/**
 * The architecture, drawn.
 *
 * NO REACT FLOW. The web build of this project used it, and it cannot come across: React Flow
 * is a DOM library and this is the same React Native tree that runs on a phone. What it was
 * actually providing — tiered positions, compacted empty rows, stable ordering — is computed on
 * the server by `layout()` and arrives with the graph, so the loss is only the panning
 * chrome, not the picture.
 *
 * Cards are absolutely positioned at the coordinates the daemon supplies, inside a scroll view
 * that pans in both directions. Edges are hairlines rotated into place, which is the one honest
 * way to draw a diagonal without an SVG dependency.
 *
 * WHAT A CARD IS NOT ALLOWED TO IMPLY, kept from the web build because it is the point:
 * a service that has never deployed shows NO container glyphs and says so; the HA badge comes
 * only from the platform's own `mode`; and a ghost — something the repo needs and the project
 * does not have — is dashed and labelled so it cannot be mistaken for something running.
 */
import { ScrollView, Text, View } from 'react-native';

import { T, radii } from './theme';
import { Badge } from './components';
import type { ArchNode, Graph } from './api';

export const CARD_W = 190;

export interface Ghost {
  type: string;
  reason: string;
  confidence: string;
}

const KIND_GLYPH: Record<string, string> = {
  runtime: '▶', database: '▣', cache: '◈', search: '◎',
  queue: '◇', storage: '▤', system: '⚙', unknown: '◻',
};

const statusColor = (s: string): string => {
  if (s === 'ACTIVE' || s === 'RUNNING') return T.ok;
  if (s.startsWith('READY') || s === 'NEW' || s.includes('CREAT')) return T.warn;
  if (s.includes('FAIL') || s.includes('ERROR')) return T.err;
  return T.dim;
};

/** One running service. */
function ServiceCard({ n }: { n: ArchNode }) {
  return (
    <View
      style={{
        width: CARD_W,
        backgroundColor: n.system ? T.raised : T.panel,
        borderColor: T.line,
        borderWidth: 1,
        borderRadius: radii.card,
        padding: 12,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 20, marginBottom: 8, flexWrap: 'wrap' }}>
        {n.containers === null ? (
          // The honest empty state: a label, not zero silent glyphs.
          <Text style={{ color: T.err, fontFamily: T.mono, fontSize: 10 }}>not deployed</Text>
        ) : n.containers === 0 ? (
          <Text style={{ color: T.err, fontFamily: T.mono, fontSize: 10 }}>0 containers</Text>
        ) : (
          <>
            {Array.from({ length: Math.min(n.containers, 6) }, (_, i) => (
              <View key={i} style={{ width: 13, height: 17, borderWidth: 1, borderColor: T.faint, borderRadius: 3 }} />
            ))}
            {n.containers > 6 && (
              <Text style={{ color: T.dim, fontFamily: T.mono, fontSize: 10 }}>+{n.containers - 6}</Text>
            )}
          </>
        )}
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
        <Text style={{ color: T.dim, fontSize: 12 }}>{KIND_GLYPH[n.kind] ?? '◻'}</Text>
        <Text style={{ color: T.text, fontWeight: '700', fontSize: 14 }}>{n.name}</Text>
      </View>
      <Text style={{ color: T.dim, fontSize: 11.5, marginTop: 1 }}>{n.typeName}</Text>

      <View style={{ flexDirection: 'row', gap: 4, flexWrap: 'wrap', marginTop: 8 }}>
        {n.ha && <Badge text="HA" tint={T.ok} />}
        {n.publicHttp && <Badge text="public" tint={T.accentBlue} />}
        {n.ports.slice(0, 3).map((p) => <Badge key={p} text={`:${p}`} />)}
      </View>

      <Text style={{ color: statusColor(n.status), fontFamily: T.mono, fontSize: 9.5, marginTop: 8, letterSpacing: 0.5 }}>
        {n.status}
      </Text>
    </View>
  );
}

/** Something the repo asked for that the project has not got. */
function GhostCard({ g }: { g: Ghost }) {
  const weak = g.confidence === 'likely';
  return (
    <View
      style={{
        width: CARD_W,
        backgroundColor: 'transparent',
        borderColor: weak ? T.warn : T.err,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderRadius: radii.card,
        padding: 12,
      }}
    >
      <Text style={{ color: weak ? T.warn : T.err, fontFamily: T.mono, fontSize: 10, marginBottom: 8 }}>
        not provisioned
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
        <Text style={{ color: T.dim, fontSize: 12 }}>◻</Text>
        <Text style={{ color: T.text, fontWeight: '700', fontSize: 14 }}>{g.type}</Text>
      </View>
      <View style={{ flexDirection: 'row', marginTop: 8 }}>
        <Badge text={weak ? 'maybe missing' : 'missing'} tint={weak ? T.warn : T.err} />
      </View>
      <Text style={{ color: T.dim, fontSize: 10.5, marginTop: 8, lineHeight: 15 }}>{g.reason}</Text>
    </View>
  );
}

/** A hairline between two card centres. Rotation, because there is no SVG here. */
function Edge({ from, to }: { from: { x: number; y: number }; to: { x: number; y: number } }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return null;
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: from.x,
        top: from.y,
        width: len,
        height: 1,
        backgroundColor: T.line2,
        transform: [{ translateX: 0 }, { translateY: 0 }, { rotateZ: `${Math.atan2(dy, dx)}rad` }],
        transformOrigin: 'left center',
      }}
    />
  );
}

const CARD_H = 130;
const GHOSTS_PER_ROW = 4;

export function ArchCanvas({ graph, ghosts }: { graph: Graph; ghosts: Ghost[] }) {
  const maxY = graph.nodes.reduce((m, n) => Math.max(m, n.position.y), 0);
  const ghostTop = maxY + 190;

  const centre = (n: ArchNode) => ({ x: n.position.x + CARD_W / 2, y: n.position.y + CARD_H / 2 });
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  const width = Math.max(
    graph.nodes.reduce((m, n) => Math.max(m, n.position.x + CARD_W), 0),
    Math.min(ghosts.length, GHOSTS_PER_ROW) * 240,
  ) + 40;
  const height = ghostTop + Math.ceil(ghosts.length / GHOSTS_PER_ROW) * 200 + 40;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: T.bg }} contentContainerStyle={{ padding: 20 }}>
      <ScrollView horizontal contentContainerStyle={{ minWidth: width }}>
        <View style={{ width, height, position: 'relative' }}>
          {graph.edges.map((e) => {
            const a = byId.get(e.source);
            const b = byId.get(e.target);
            if (a === undefined || b === undefined) return null;
            return <Edge key={e.id} from={centre(a)} to={centre(b)} />;
          })}

          {graph.nodes.map((n) => (
            <View key={n.id} style={{ position: 'absolute', left: n.position.x, top: n.position.y }}>
              <ServiceCard n={n} />
            </View>
          ))}

          {ghosts.map((g, i) => (
            <View
              key={g.type}
              style={{
                position: 'absolute',
                left: (i % GHOSTS_PER_ROW) * 240,
                top: ghostTop + Math.floor(i / GHOSTS_PER_ROW) * 200,
              }}
            >
              <GhostCard g={g} />
            </View>
          ))}
        </View>
      </ScrollView>
    </ScrollView>
  );
}
