/**
 * Config drift: the outage that gets through every other check.
 *
 * A missing SERVICE fails loudly — the import is rejected, or the app cannot open a socket. A
 * missing ENVIRONMENT VARIABLE does not. The image builds, the container starts, health checks
 * pass, and the first request that needs `JWT_SECRET` throws. Nothing before that moment says
 * anything is wrong, which is why this is worth its own pass.
 *
 * NAMES ONLY, ON BOTH SIDES. The repo side comes from `.env` keys; the platform side comes from
 * the API with values stripped at the schema boundary. Nothing here reads, compares, stores or
 * prints a value — a tool that diffed secret values would be a tool that leaks them.
 *
 * PLATFORM-PROVIDED KEYS ARE NOT DRIFT. Zerops injects a connection string for every managed
 * service using `servicehostname_ENVKEY`, so a repo asking for `DATABASE_URL` is satisfied the
 * moment a database exists — reporting it as missing config would be a false alarm on the most
 * common variable there is.
 */

export interface ConfigDrift {
  /** Declared by the repo, absent from the project, and not something Zerops provides. */
  missing: string[];
  /** Declared by the repo and present on the project. */
  present: string[];
  /** Absent, but Zerops will inject it once the named service exists. */
  provided: Array<{ key: string; by: string }>;
}

/** Keys the platform supplies itself; asking for them is never a finding. */
const PLATFORM = /^(zerops|storageCdnUrl|staticCdnUrl|apiCdnUrl|envIsolation|sshIsolation|PATH|HOME|PORT|HOSTNAME)/i;

/**
 * Which deployed service, if any, will cause Zerops to inject this variable.
 *
 * Matched on the service name appearing in the key: a project with a `postgresql` service gets
 * `postgresql_connectionString` and friends, so a repo's `DATABASE_URL` is answered by the
 * database existing rather than by anyone setting a variable.
 */
const CONNECTION = /(_URL|_URI|_HOST|_PORT|_DSN|_CONNECTIONSTRING)$/i;

const FAMILY: ReadonlyArray<readonly [RegExp, string]> = [
  [/^DATABASE|^POSTGRES|^PG/i, 'postgresql'],
  [/^REDIS|^VALKEY/i, 'valkey'],
  [/^MEILI/i, 'meilisearch'],
  [/^QDRANT/i, 'qdrant'],
  [/^NATS/i, 'nats'],
  [/^S3|^MINIO|^OBJECT/i, 'objectstorage'],
];

/**
 * Compare what the repository asks for against what the project actually defines.
 *
 * @param wanted  Env var names read from the repo's `.env` files.
 * @param defined Env var names defined on the project (values already discarded).
 * @param services Hostnames/types of services deployed in the project.
 */
export function compareConfig(
  wanted: readonly string[],
  defined: readonly string[],
  services: readonly string[],
): ConfigDrift {
  const have = new Set(defined.map((k) => k.toLowerCase()));
  const svc = services.map((s) => s.toLowerCase());

  const missing: string[] = [];
  const present: string[] = [];
  const provided: Array<{ key: string; by: string }> = [];

  for (const key of [...new Set(wanted)].sort()) {
    if (have.has(key.toLowerCase()) || PLATFORM.test(key)) { present.push(key); continue; }

    if (CONNECTION.test(key)) {
      const fam = FAMILY.find(([re]) => re.test(key));
      const by = fam === undefined ? null : svc.find((s) => s.includes(fam[1]));
      if (by !== null && by !== undefined) { provided.push({ key, by }); continue; }
    }
    missing.push(key);
  }

  return { missing, present, provided };
}

/** One line a person can act on. Empty string when there is nothing to say. */
export function describeConfig(d: ConfigDrift): string {
  if (d.missing.length === 0) return '';
  return `${d.missing.length} variable(s) the repo reads are not set on this project: ` +
    `${d.missing.join(', ')}. The deploy will succeed and the app will fail at runtime.`;
}
