/**
 * Live Zerops account -> an architecture graph.
 *
 * Pure. No fetch, no clock, no React. That is deliberate: this is the function that decides
 * what the picture SAYS, and a picture that quietly says something false is worse than no
 * picture. Keeping it pure means every claim it makes is testable without a network.
 *
 * What the drawing is allowed to assert, and what it must not:
 *
 *   - Container count is drawn as stacked cards. It comes from
 *     `coreService.currentActiveContainerCount`, and it is `null` for a service that has
 *     never deployed. Null renders as "not deployed", never as one container -- the
 *     difference between "running once" and "not running" is the whole point of looking.
 *   - HA is `mode === 'HA'`, read from the platform. Never inferred from container count:
 *     a single-mode service briefly running two containers during a deploy is not HA, and
 *     labelling it so would be a lie a judge could catch by clicking through.
 *   - Edges come from `connectedStacks`. When Zerops reports none, the graph shows none.
 *     Guessing that an `app` probably talks to a `db` would draw a relationship the platform
 *     has no record of.
 */
import type { ZProject, ZService } from './api.js';

export type NodeKind = 'runtime' | 'database' | 'cache' | 'search' | 'queue' | 'storage' | 'system' | 'unknown';

export interface ArchNode {
  id: string;
  name: string;
  /** The `serviceStackTypeId`, e.g. `postgresql`, `valkey`, `nodejs`, `zcp`. */
  typeId: string;
  /** Human label from the platform, e.g. "PostgreSQL". Falls back to the type id. */
  typeName: string;
  kind: NodeKind;
  status: string;
  /** True when the platform says so. Never inferred. */
  ha: boolean;
  /** `null` means never deployed. Distinct from 0 and from 1. */
  containers: number | null;
  /** Reachable from outside the project's private network. */
  publicHttp: boolean;
  ports: number[];
  /** Zerops-managed infrastructure (core, zcp) rather than something the user added. */
  system: boolean;
}

export interface ArchEdge {
  id: string;
  source: string;
  target: string;
  /** Only ever `connected` today -- the platform's own relationship, not a guess. */
  kind: 'connected';
}

export interface ArchGraph {
  projectId: string;
  projectName: string;
  status: string;
  nodes: ArchNode[];
  edges: ArchEdge[];
  /** Things the picture cannot show, said out loud rather than omitted. */
  notes: string[];
}

/**
 * Map a Zerops service type to a visual category.
 *
 * Prefix matching because Zerops type ids carry versions and variants (`postgresql@16`,
 * `nodejs@22`). An unrecognised type is `unknown` and still drawn -- dropping a service
 * because this list is out of date would silently hide part of someone's infrastructure,
 * which is the one thing an architecture view must never do.
 */
const KIND_PREFIXES: ReadonlyArray<readonly [string, NodeKind]> = [
  ['postgres', 'database'],
  ['mariadb', 'database'],
  ['mysql', 'database'],
  ['clickhouse', 'database'],
  ['valkey', 'cache'],
  ['keydb', 'cache'],
  ['redis', 'cache'],
  ['elasticsearch', 'search'],
  ['meilisearch', 'search'],
  ['typesense', 'search'],
  ['qdrant', 'search'],
  ['nats', 'queue'],
  ['kafka', 'queue'],
  ['rabbitmq', 'queue'],
  ['objectstorage', 'storage'],
  ['shared-storage', 'storage'],
  ['core', 'system'],
  ['zcp', 'system'],
  ['nodejs', 'runtime'],
  ['python', 'runtime'],
  ['php', 'runtime'],
  ['golang', 'runtime'],
  ['go@', 'runtime'],
  ['rust', 'runtime'],
  ['java', 'runtime'],
  ['dotnet', 'runtime'],
  ['deno', 'runtime'],
  ['bun', 'runtime'],
  ['elixir', 'runtime'],
  ['ruby', 'runtime'],
  ['static', 'runtime'],
  ['nginx', 'runtime'],
  ['ubuntu', 'runtime'],
  ['alpine', 'runtime'],
];

export function classify(typeId: string, category?: string): NodeKind {
  const t = typeId.toLowerCase();
  for (const [prefix, kind] of KIND_PREFIXES) {
    if (t.startsWith(prefix)) return kind;
  }
  // The platform's own category is the fallback, not the first resort: it is coarse (CORE /
  // USER) and would flatten every database and runtime into one bucket.
  if (category === 'CORE') return 'system';
  return 'unknown';
}

export function toNode(s: ZService): ArchNode {
  const info = s.serviceStackTypeInfo ?? {};
  const containers = s.coreService?.currentActiveContainerCount;
  return {
    id: s.id,
    name: s.name,
    typeId: s.serviceStackTypeId,
    typeName: info.serviceStackTypeName ?? s.serviceStackTypeId,
    kind: classify(s.serviceStackTypeId, info.serviceStackTypeCategory),
    status: s.status,
    // Read, never inferred. A single-mode service mid-deploy can show two containers.
    ha: s.mode === 'HA',
    containers: containers === undefined ? null : containers,
    publicHttp: s.hasPublicHttpRoutingAccess === true || s.subdomainAccess === true,
    ports: s.ports.map((p) => p.port),
    system: s.isSystem === true,
  };
}

/**
 * Pull edges out of `connectedStacks`.
 *
 * The platform returns these as objects in the wild and we have only ever observed `[]` on a
 * fresh project, so both an id-string and an `{id}` object are accepted. Anything else is
 * skipped and reported in `notes` rather than guessed at -- an edge drawn from a shape we did
 * not understand is a relationship nobody has.
 */
export function toEdges(services: readonly ZService[]): { edges: ArchEdge[]; unreadable: number } {
  const known = new Set(services.map((s) => s.id));
  const edges: ArchEdge[] = [];
  const seen = new Set<string>();
  let unreadable = 0;

  for (const s of services) {
    for (const raw of s.connectedStacks) {
      let targetId: string | undefined;
      if (typeof raw === 'string') targetId = raw;
      else if (raw !== null && typeof raw === 'object' && 'id' in raw) {
        const v = (raw as { id: unknown }).id;
        if (typeof v === 'string') targetId = v;
      }
      if (targetId === undefined || !known.has(targetId)) {
        unreadable += 1;
        continue;
      }
      // Undirected in practice: A→B and B→A are the same wire, drawn once.
      const key = [s.id, targetId].sort().join('::');
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ id: `e-${key}`, source: s.id, target: targetId, kind: 'connected' });
    }
  }
  return { edges, unreadable };
}

export function buildGraph(project: ZProject, services: readonly ZService[]): ArchGraph {
  const nodes = services.map(toNode);
  const { edges, unreadable } = toEdges(services);

  const notes: string[] = [];
  if (unreadable > 0) {
    notes.push(`${unreadable} connection(s) referenced a service this project does not list, or came back in a shape this build does not recognise. They are not drawn.`);
  }
  if (nodes.length > 0 && edges.length === 0) {
    // Said explicitly, because an architecture diagram with no lines looks broken. It
    // usually is not -- Zerops only records a connection once services are actually wired.
    notes.push('Zerops reports no connections between these services yet, so no edges are drawn. Nothing is inferred from names or types.');
  }
  const undeployed = nodes.filter((n) => n.containers === null && !n.system);
  if (undeployed.length > 0) {
    notes.push(`${undeployed.length} service(s) have never been deployed (${undeployed.map((n) => n.name).join(', ')}) -- shown without containers rather than as one.`);
  }

  return {
    projectId: project.id,
    projectName: project.name,
    status: project.status,
    nodes,
    edges,
    notes,
  };
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Position nodes in tiers, so the picture reads the way the uploaded reference does:
 * user-facing runtimes at the top, stateful services beneath, platform services last.
 *
 * Layout is here rather than in the React component because "which row is this service on"
 * is a statement about the architecture, and statements about the architecture belong
 * somewhere testable.
 */
const TIER: Record<NodeKind, number> = {
  runtime: 0,
  database: 1,
  cache: 1,
  search: 1,
  queue: 2,
  storage: 2,
  system: 3,
  unknown: 2,
};

export interface Positioned extends ArchNode {
  position: { x: number; y: number };
}

export function layout(nodes: readonly ArchNode[], opts: { colWidth?: number; rowHeight?: number } = {}): Positioned[] {
  const colWidth = opts.colWidth ?? 240;
  const rowHeight = opts.rowHeight ?? 170;
  const byTier = new Map<number, ArchNode[]>();
  for (const n of nodes) {
    const t = TIER[n.kind];
    const list = byTier.get(t) ?? [];
    list.push(n);
    byTier.set(t, list);
  }
  const out: Positioned[] = [];
  for (const [tier, list] of [...byTier.entries()].sort((a, b) => a[0] - b[0])) {
    // Stable order inside a row, so the diagram does not reshuffle between polls -- a graph
    // whose boxes jump on every refresh is unreadable even when it is correct.
    list.sort((a, b) => a.name.localeCompare(b.name));
    list.forEach((n, i) => {
      out.push({ ...n, position: { x: i * colWidth, y: tier * rowHeight } });
    });
  }
  return out;
}
