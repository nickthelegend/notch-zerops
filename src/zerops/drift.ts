/**
 * The gap between what a repository needs and what is actually running.
 *
 * This is the feature the whole product turns on. Zerops can already show you a list of your
 * services, and `graph.ts` can already draw them; neither can tell you that your code imports
 * `pg` and there is no Postgres anywhere in the project. That question is only answerable
 * with both halves in hand, and it is the one a developer actually has at 2am.
 *
 * Pure, for the same reason `graph.ts` is: it decides what the diagram accuses you of.
 *
 * THREE HONESTY RULES, because a drift report is an accusation and false ones are expensive:
 *
 *   A service is only MISSING if nothing plausibly satisfies it. Zerops names are arbitrary
 *   -- a Postgres service can be called `db`, `primary`, or `bananas` -- so matching is by
 *   service TYPE, never by name. Matching on name would report Postgres missing on a project
 *   that plainly has it.
 *
 *   EXTRA is not a fault, and is never worded as one. A service the repo does not reference
 *   is usually deliberate: a cache added by hand, a database shared with another app, a
 *   platform service. It is reported as unreferenced, not as waste.
 *
 *   A `likely` requirement never produces a MISSING at full confidence. An env var named
 *   `DATABASE_URL` might point at a database outside this project entirely, and telling
 *   someone to provision a second one would be actively harmful.
 */
import type { Requirement, ServiceType } from '../repo/scan.js';
import type { ArchNode } from './graph.js';

export type DriftStatus = 'satisfied' | 'missing' | 'unreferenced';

export interface DriftItem {
  status: DriftStatus;
  /** The service type in question. */
  type: string;
  /** Present when something is actually deployed for it. */
  deployed?: { id: string; name: string; status: string; containers: number | null };
  /** Present when the repo asked for it. */
  required?: Requirement;
  /** One sentence a human can act on. Never a bare status word. */
  summary: string;
}

export interface DriftReport {
  items: DriftItem[];
  counts: { satisfied: number; missing: number; unreferenced: number };
  /** Only the things worth provisioning, in the order worth doing them. */
  provisionable: DriftItem[];
  notes: string[];
}

/**
 * A deployed node satisfies a requirement when their TYPES agree.
 *
 * Zerops type ids carry versions (`postgresql@16`), so this compares prefixes. Valkey and
 * Redis are treated as interchangeable because they speak the same protocol and Zerops
 * documents KeyDB/Redis as the legacy path to Valkey -- a repo depending on `ioredis` is
 * genuinely satisfied by a Valkey service, and reporting otherwise would be a false alarm.
 */
export function satisfies(deployedTypeId: string, required: ServiceType): boolean {
  const d = deployedTypeId.toLowerCase();
  const r = required.toLowerCase();
  if (d.startsWith(r)) return true;

  const REDIS_FAMILY = ['valkey', 'keydb', 'redis'];
  if (REDIS_FAMILY.includes(r) && REDIS_FAMILY.some((x) => d.startsWith(x))) return true;

  // A repo's runtime requirement is satisfied by any runtime container that could host it.
  // `ubuntu` and `alpine` are general-purpose boxes on Zerops and can run anything.
  const GENERIC_RUNTIME = ['ubuntu', 'alpine'];
  const RUNTIMES: ServiceType[] = ['nodejs', 'python', 'php', 'go', 'rust', 'java', 'dotnet', 'ruby', 'elixir', 'bun', 'deno', 'static'];
  if (RUNTIMES.includes(required) && GENERIC_RUNTIME.some((x) => d.startsWith(x))) return true;

  return false;
}

export function computeDrift(required: readonly Requirement[], deployed: readonly ArchNode[]): DriftReport {
  const items: DriftItem[] = [];
  const claimed = new Set<string>();

  for (const req of required) {
    const match = deployed.find((n) => !claimed.has(n.id) && satisfies(n.typeId, req.type));
    if (match !== undefined) {
      claimed.add(match.id);
      items.push({
        status: 'satisfied',
        type: req.type,
        deployed: { id: match.id, name: match.name, status: match.status, containers: match.containers },
        required: req,
        summary:
          `\`${match.name}\` (${match.typeName}) covers this` +
          (match.containers === null
            ? ', but it has never been deployed -- the service exists on paper only.'
            : '.'),
      });
      continue;
    }

    const why = req.evidence[0];
    items.push({
      status: 'missing',
      type: req.type,
      required: req,
      summary:
        req.confidence === 'strong'
          ? `Nothing in this project provides ${req.type}, but ${why?.because ?? 'the repo needs it'} (${why?.path ?? 'unknown file'}).`
          : `No ${req.type} service here. ${why?.because ?? 'A config hint suggests one'} in ${why?.path ?? 'the repo'} -- it may well point at something outside this project, so check before provisioning.`,
    });
  }

  for (const node of deployed) {
    if (claimed.has(node.id)) continue;
    // Zerops' own services are not drift. Reporting `core` as unreferenced would be noise
    // on every single project.
    if (node.system) continue;
    items.push({
      status: 'unreferenced',
      type: node.typeId,
      deployed: { id: node.id, name: node.name, status: node.status, containers: node.containers },
      summary: `\`${node.name}\` (${node.typeName}) is running but nothing in the repo references it. That is often deliberate -- shared with another app, or added by hand.`,
    });
  }

  const counts = {
    satisfied: items.filter((i) => i.status === 'satisfied').length,
    missing: items.filter((i) => i.status === 'missing').length,
    unreferenced: items.filter((i) => i.status === 'unreferenced').length,
  };

  const notes: string[] = [];
  if (counts.missing === 0 && counts.satisfied > 0) {
    notes.push('Everything this repo appears to need is already running.');
  }
  const weak = items.filter((i) => i.status === 'missing' && i.required?.confidence === 'likely');
  if (weak.length > 0) {
    notes.push(`${weak.length} of the missing service(s) were inferred from configuration names rather than code, so they are lower confidence: ${weak.map((i) => i.type).join(', ')}.`);
  }
  if (counts.unreferenced > 0) {
    notes.push('Unreferenced services are listed for completeness, not as a problem to fix.');
  }

  return {
    items,
    counts,
    // Dependencies before runtimes: a runtime that boots before its database exists just
    // crash-loops, and the order the button provisions in should not create that.
    provisionable: items
      .filter((i) => i.status === 'missing')
      .sort((a, b) => {
        const rank = (i: DriftItem): number =>
          (i.required?.role === 'dependency' ? 0 : 1) * 10 + (i.required?.confidence === 'strong' ? 0 : 1);
        return rank(a) - rank(b);
      }),
    notes,
  };
}
