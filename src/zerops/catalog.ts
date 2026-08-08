/**
 * Which version of a managed service to actually ask for.
 *
 * This exists because the version you write in an import file is NOT the version the
 * platform stores, and guessing costs you a 400 that says "Service base not found" without
 * telling you what the right answer was.
 *
 * Internally Zerops names versions like `postgresql:ha@16`, `postgresql:single@16`,
 * `valkey:single@7.2`. The import YAML instead takes a bare `type: postgresql@16` plus a
 * separate `mode:`. So the import format is a projection of the internal one, and the only
 * part you have to get exactly right is the numeric version — which is where the trap is:
 * Valkey is `7.2`, not `7`, and asking for `valkey@7` fails.
 *
 * So the catalogue is READ FROM THE ACCOUNT, never hardcoded. A pinned table would be wrong
 * the first time Zerops ships Postgres 18, and it would be wrong silently — the failure
 * lands at provision time, in front of whoever is watching the demo.
 */
import type { ZeropsClient } from './api.js';
import type { ServiceType } from '../repo/scan.js';

export interface CatalogEntry {
  /** e.g. `postgresql` */
  typeId: string;
  /** e.g. `PostgreSQL` */
  name: string;
  /** Internal version names, e.g. `postgresql:single@16`. */
  versions: string[];
}

/** `postgresql:single@16` -> `{ base: 'postgresql', ha: false, version: '16' }` */
export function parseVersion(raw: string): { base: string; ha: boolean; version: string } | null {
  // Two observed shapes: `base:mode@version` for managed services, and `os/runtime@version`
  // for runtimes (`alpine/nodejs@22`). Only the first carries a mode.
  const managed = /^([a-z0-9-]+):(ha|single)@(.+)$/i.exec(raw);
  if (managed !== null) {
    return { base: managed[1] ?? '', ha: (managed[2] ?? '').toLowerCase() === 'ha', version: managed[3] ?? '' };
  }
  const runtime = /^(?:[a-z]+\/)?([a-z0-9-]+)@(.+)$/i.exec(raw);
  if (runtime !== null) return { base: runtime[1] ?? '', ha: false, version: runtime[2] ?? '' };
  return null;
}

/**
 * Compare two version strings the way a human means it: 1.20 is newer than 1.9.
 *
 * A plain string sort puts "1.9" after "1.20" and would pick a two-year-old Meilisearch as
 * "latest". Numeric-segment comparison, with non-numeric segments falling back to string
 * order so nothing throws on an unexpected shape.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = Number(pa[i] ?? 0);
    const nb = Number(pb[i] ?? 0);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      const c = (pa[i] ?? '').localeCompare(pb[i] ?? '');
      if (c !== 0) return c;
      continue;
    }
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * The newest version of `typeId`, and whether HA is even available for it.
 *
 * `haAvailable` matters: Meilisearch only ships `single`, so offering an HA toggle for it
 * would produce a request the platform rejects.
 */
export function pickVersion(entry: CatalogEntry, preferHa: boolean): { type: string; mode: 'HA' | 'NON_HA' } | null {
  const parsed = entry.versions.map(parseVersion).filter((v): v is NonNullable<typeof v> => v !== null);
  if (parsed.length === 0) return null;

  const haAvailable = parsed.some((v) => v.ha);
  const wantHa = preferHa && haAvailable;
  const candidates = parsed.filter((v) => v.ha === wantHa);
  const pool = candidates.length > 0 ? candidates : parsed;

  const newest = [...pool].sort((x, y) => compareVersions(y.version, x.version))[0];
  if (newest === undefined) return null;

  // The import file wants `base@version` and a separate mode -- not the internal
  // `base:mode@version` string, which it rejects.
  return { type: `${newest.base}@${newest.version}`, mode: wantHa ? 'HA' : 'NON_HA' };
}

/** Our internal `ServiceType` -> the Zerops `typeId` it corresponds to. */
const TYPE_MAP: Readonly<Record<string, string>> = {
  postgresql: 'postgresql', mariadb: 'mariadb', valkey: 'valkey',
  elasticsearch: 'elasticsearch', meilisearch: 'meilisearch', typesense: 'typesense',
  qdrant: 'qdrant', nats: 'nats', kafka: 'kafka', clickhouse: 'clickhouse',
  objectstorage: 'objectstorage',
  nodejs: 'nodejs', python: 'python', php: 'php', go: 'go', rust: 'rust',
  java: 'java', dotnet: 'dotnet', ruby: 'ruby', elixir: 'elixir', bun: 'bun',
  deno: 'deno', static: 'static',
};

export class ServiceCatalog {
  private entries: CatalogEntry[] | null = null;

  constructor(private readonly client: ZeropsClient) {}

  async load(): Promise<CatalogEntry[]> {
    if (this.entries !== null) return this.entries;
    this.entries = await this.client.serviceTypes();
    return this.entries;
  }

  async find(type: ServiceType): Promise<CatalogEntry | null> {
    const wanted = TYPE_MAP[type] ?? type;
    const all = await this.load();
    return all.find((e) => e.typeId.toLowerCase() === wanted.toLowerCase()) ?? null;
  }

  /**
   * Turn a required service into the exact `{type, mode}` an import file needs.
   *
   * Returns null rather than a guess when the platform has no such type -- provisioning
   * something that was never asked for is worse than reporting that we cannot.
   */
  async resolve(type: ServiceType, preferHa = false): Promise<{ type: string; mode: 'HA' | 'NON_HA' } | null> {
    const entry = await this.find(type);
    return entry === null ? null : pickVersion(entry, preferHa);
  }
}

/**
 * A hostname Zerops will accept.
 *
 * Documented limits: unique in the project, max 25 characters, lowercase a-z and 0-9 only.
 * A rejected hostname surfaces as a confusing validation error at import time, so it is
 * cleaned here where the rule can be stated.
 */
export function safeHostname(desired: string, taken: readonly string[] = []): string {
  const cleaned = desired.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 25) || 'svc';
  if (!taken.includes(cleaned)) return cleaned;
  for (let i = 2; i < 100; i += 1) {
    const suffix = String(i);
    const candidate = cleaned.slice(0, 25 - suffix.length) + suffix;
    if (!taken.includes(candidate)) return candidate;
  }
  return cleaned.slice(0, 22) + Date.now().toString().slice(-3);
}

/** Build the import YAML. Kept tiny and explicit -- no YAML library for four fields. */
export function buildImportYaml(services: ReadonlyArray<{ hostname: string; type: string; mode: 'HA' | 'NON_HA' }>): string {
  const lines = ['services:'];
  for (const s of services) {
    lines.push(`  - hostname: ${s.hostname}`);
    lines.push(`    type: ${s.type}`);
    lines.push(`    mode: ${s.mode}`);
  }
  return lines.join('\n') + '\n';
}
