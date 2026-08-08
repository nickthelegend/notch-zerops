/**
 * The edges — read out of the code, not out of the platform.
 *
 * The architecture board was drawing boxes with nothing between them, and the app was honest
 * about why: "Zerops reports no connections between these services yet." That is true and it is
 * also the wrong source to ask. Zerops learns about a connection when somebody wires one. The
 * repository knows on the first commit — a file that imports `pg` is a file that is going to
 * talk to Postgres, whether or not anyone has told the platform.
 *
 * So the edges come from the same evidence the drift report already collects. Every edge names
 * the line that produced it, which means the diagram makes an argument rather than a
 * decoration: not "these things are near each other" but "this runtime talks to this database,
 * and here is the import that says so".
 *
 * AND THE GAP IS THE POINT. When the code describes six connections and the platform has zero
 * configured, that difference is a finding no single side can see. It is reported here rather
 * than left for someone to notice.
 */
import type { Requirement } from '../repo/scan.js';
import type { ArchNode } from './graph.js';

export interface WiringEdge {
  /** Service TYPE at each end, not a node id — a type is what both sides agree on. */
  from: string;
  to: string;
  /** The line of code that proves this edge exists. */
  because: string;
  /** Where that line lives. */
  path: string;
  /** The literal token found, e.g. `ioredis`. */
  found: string;
  /** Weak when inferred from an env var name alone. */
  confidence: 'strong' | 'likely';
  /** Whether the far end is actually deployed. */
  deployed: boolean;
}

export interface Wiring {
  /** The runtime everything hangs off, or `null` when the repo has no deployable. */
  runtime: string | null;
  edges: WiringEdge[];
  /** Connections Zerops itself has configured. */
  platformEdgeCount: number;
  /** One sentence about the difference, or `null` when there is nothing to say. */
  note: string | null;
}

/**
 * Derive the edges.
 *
 * @param required  What the repository asked for, with its evidence.
 * @param nodes     What is actually deployed.
 * @param platformEdges How many connections Zerops has configured.
 */
export function deriveWiring(
  required: readonly Requirement[],
  nodes: readonly ArchNode[],
  platformEdges: number,
): Wiring {
  /*
   * The runtime is the anchor. A repo with no runtime manifest — a library, a set of
   * migrations — has dependencies but nothing that talks to them, and inventing a centre for
   * that graph would be drawing a relationship nobody claimed.
   */
  const runtime = required.find((r) => r.role === 'runtime')?.type ?? null;
  if (runtime === null) {
    return {
      runtime: null,
      edges: [],
      platformEdgeCount: platformEdges,
      note: required.length === 0
        ? null
        : 'No runtime in this repository, so nothing here is the thing that talks to the rest. Dependencies are listed without edges.',
    };
  }

  const deployedTypes = new Set(
    nodes.flatMap((n) => [n.typeName.toLowerCase().replace(/[^a-z0-9]/g, ''), n.name.toLowerCase()]),
  );
  const isDeployed = (type: string): boolean =>
    [...deployedTypes].some((d) => d.includes(type) || type.includes(d));

  const edges: WiringEdge[] = [];
  for (const r of required) {
    if (r.role === 'runtime') continue;
    // The strongest piece of evidence is the one worth putting on the edge: an import beats an
    // env var name, and the first is already the strongest by the scanner's ordering.
    const e = r.evidence[0];
    if (e === undefined) continue;
    edges.push({
      from: runtime,
      to: r.type,
      because: e.because,
      path: e.path,
      found: e.found,
      confidence: r.confidence,
      deployed: isDeployed(r.type),
    });
  }

  let note: string | null = null;
  if (edges.length > 0 && platformEdges === 0) {
    note =
      `Your code makes ${edges.length} connection(s); Zerops has none configured on this ` +
      `project. Every one of these is something the app will try to reach at runtime.`;
  } else if (edges.length > platformEdges && platformEdges > 0) {
    note = `Your code makes ${edges.length} connection(s); ${platformEdges} are configured on the platform.`;
  }

  return { runtime, edges, platformEdgeCount: platformEdges, note };
}
