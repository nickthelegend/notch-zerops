/**
 * Two environments, held against each other.
 *
 * Zerops shows you one project at a time, and one project at a time is exactly the view in
 * which dev, stage and prod drift apart without anyone noticing. Nobody deliberately gives
 * staging a single-node Valkey and production an HA one; it happens because they were created
 * months apart by different people, and nothing ever put them side by side.
 *
 * WHAT COUNTS AS A DIFFERENCE is deliberately narrow: presence, version, mode, public routing,
 * and which environment variable KEYS are defined. Container counts and statuses are excluded —
 * those legitimately differ between a staging box and production, and reporting them would
 * bury the three lines that matter under noise that is supposed to be there.
 *
 * Values are never compared, because values are never read. See `config.ts`.
 */

export interface EnvService {
  name: string;
  /** Base type without the version, e.g. `postgresql`. */
  type: string;
  version: string;
  /** `HA` | `NON_HA` | null when never deployed. */
  mode: string | null;
  publicHttp: boolean;
}

export interface EnvSnapshot {
  projectId: string;
  name: string;
  services: EnvService[];
  /** Env var names defined on the project. Names only. */
  envKeys: string[];
}

export type DiffKind = 'only_in_a' | 'only_in_b' | 'version' | 'mode' | 'routing' | 'env_key';

export interface Difference {
  kind: DiffKind;
  /** Service name, or the variable name for `env_key`. */
  subject: string;
  a: string | null;
  b: string | null;
  /** Whether this is the kind of difference that usually breaks something. */
  severity: 'high' | 'medium' | 'low';
  detail: string;
}

export interface Comparison {
  a: string;
  b: string;
  differences: Difference[];
  /** Services present in both, identical in every compared respect. */
  identical: string[];
}

/**
 * Match services by TYPE, not by name.
 *
 * `db` in staging and `postgresql` in production are the same thing wearing different
 * hostnames, and a name-based comparison would report both as missing from the other side —
 * two loud, wrong findings instead of one quiet correct one.
 */
const keyOf = (s: EnvService): string => s.type.toLowerCase();

export function compareEnvironments(a: EnvSnapshot, b: EnvSnapshot): Comparison {
  const differences: Difference[] = [];
  const identical: string[] = [];

  const byType = (list: EnvService[]) => {
    const m = new Map<string, EnvService>();
    for (const s of list) if (!m.has(keyOf(s))) m.set(keyOf(s), s);
    return m;
  };
  const ma = byType(a.services);
  const mb = byType(b.services);

  for (const [type, sa] of ma) {
    const sb = mb.get(type);
    if (sb === undefined) {
      differences.push({
        kind: 'only_in_a', subject: sa.name, a: `${sa.type}@${sa.version}`, b: null,
        severity: 'high',
        detail: `${b.name} has no ${sa.type}. Anything in ${a.name} that depends on it has no counterpart there.`,
      });
      continue;
    }

    let same = true;
    if (sa.version !== sb.version) {
      same = false;
      differences.push({
        kind: 'version', subject: sa.type, a: sa.version, b: sb.version,
        severity: 'medium',
        detail: `${a.name} runs ${sa.type} ${sa.version}; ${b.name} runs ${sb.version}. Behaviour tested against one is not guaranteed on the other.`,
      });
    }
    if ((sa.mode ?? 'none') !== (sb.mode ?? 'none')) {
      same = false;
      differences.push({
        kind: 'mode', subject: sa.type, a: sa.mode, b: sb.mode,
        severity: 'high',
        detail: `${sa.type} is ${sa.mode ?? 'not deployed'} in ${a.name} and ${sb.mode ?? 'not deployed'} in ${b.name}. Failover behaviour differs between the two.`,
      });
    }
    if (sa.publicHttp !== sb.publicHttp) {
      same = false;
      differences.push({
        kind: 'routing', subject: sa.type, a: String(sa.publicHttp), b: String(sb.publicHttp),
        severity: 'high',
        detail: `${sa.type} is ${sa.publicHttp ? 'reachable' : 'not reachable'} from the public internet in ${a.name}, and ${sb.publicHttp ? 'reachable' : 'not'} in ${b.name}.`,
      });
    }
    if (same) identical.push(sa.type);
  }

  for (const [type, sb] of mb) {
    if (ma.has(type)) continue;
    differences.push({
      kind: 'only_in_b', subject: sb.name, a: null, b: `${sb.type}@${sb.version}`,
      severity: 'high',
      detail: `${a.name} has no ${sb.type}, but ${b.name} does.`,
    });
  }

  // Env keys. Zerops sets the same handful on every project, so those are not drift.
  const SYSTEM = /^(zerops|storageCdnUrl|staticCdnUrl|apiCdnUrl|envIsolation|sshIsolation)/i;
  const ka = new Set(a.envKeys.filter((k) => !SYSTEM.test(k)));
  const kb = new Set(b.envKeys.filter((k) => !SYSTEM.test(k)));
  for (const k of [...ka].sort()) {
    if (!kb.has(k)) {
      differences.push({
        kind: 'env_key', subject: k, a: 'set', b: null, severity: 'medium',
        detail: `${k} is set on ${a.name} and not on ${b.name}. Code that reads it works in one and not the other.`,
      });
    }
  }
  for (const k of [...kb].sort()) {
    if (!ka.has(k)) {
      differences.push({
        kind: 'env_key', subject: k, a: null, b: 'set', severity: 'medium',
        detail: `${k} is set on ${b.name} and not on ${a.name}.`,
      });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 } as const;
  differences.sort((x, y) => rank[x.severity] - rank[y.severity] || x.subject.localeCompare(y.subject));

  return { a: a.name, b: b.name, differences, identical };
}
