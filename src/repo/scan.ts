/**
 * What does this repository actually need running?
 *
 * Pure: it takes files as `{path, content}` and returns requirements. No `fs`, so the whole
 * inference is testable without a fixture directory on disk, and the same function can later
 * scan a repo the desktop app has read, a git tree, or an upload.
 *
 * EVERY REQUIREMENT CITES ITS EVIDENCE. That is the difference between a tool and an oracle.
 * "You need PostgreSQL" invites an argument; "package.json depends on `pg`" ends one. A
 * recommendation a user cannot check is a recommendation they have to take on faith, and
 * infrastructure is exactly the wrong place to ask for faith.
 *
 * IT UNDER-CLAIMS ON PURPOSE. A dependency in `package.json` proves the code can talk to
 * Postgres; it does not prove Postgres should be provisioned inside this project rather than
 * being a managed database somewhere else. So these are `suggested`, with confidence, and
 * nothing here provisions anything by itself.
 */

/** A Zerops managed-service type this repo appears to need. */
export type ServiceType =
  | 'postgresql' | 'mariadb' | 'valkey' | 'elasticsearch' | 'meilisearch' | 'typesense'
  | 'qdrant' | 'nats' | 'kafka' | 'clickhouse' | 'objectstorage'
  | 'nodejs' | 'python' | 'php' | 'go' | 'rust' | 'java' | 'dotnet' | 'ruby' | 'elixir' | 'bun' | 'deno' | 'static';

export interface Evidence {
  /** The file that says so. */
  path: string;
  /** The literal thing found in it. */
  found: string;
  /** Why that implies the service, in one clause. */
  because: string;
}

export interface Requirement {
  type: ServiceType;
  /** Runtimes are what you deploy; the rest are what they talk to. */
  role: 'runtime' | 'dependency';
  /**
   * How sure. A direct client library is strong; an env var name is weaker, because
   * `DATABASE_URL` in a `.env.example` may point at something outside this project.
   */
  confidence: 'strong' | 'likely';
  evidence: Evidence[];
}

export interface RepoFile {
  path: string;
  content: string;
}

/* -------------------------------------------------------------------------- */
/* Signals                                                                     */
/* -------------------------------------------------------------------------- */

/** npm package -> the managed service it talks to. Matched exactly, never by substring. */
const NPM_DEPS: Readonly<Record<string, ServiceType>> = {
  pg: 'postgresql', 'pg-promise': 'postgresql', postgres: 'postgresql', 'node-postgres': 'postgresql',
  sequelize: 'postgresql', knex: 'postgresql', typeorm: 'postgresql', 'drizzle-orm': 'postgresql', prisma: 'postgresql',
  mysql: 'mariadb', mysql2: 'mariadb',
  redis: 'valkey', ioredis: 'valkey', '@redis/client': 'valkey',
  '@elastic/elasticsearch': 'elasticsearch',
  meilisearch: 'meilisearch',
  typesense: 'typesense',
  '@qdrant/js-client-rest': 'qdrant', '@qdrant/qdrant-js': 'qdrant',
  nats: 'nats',
  kafkajs: 'kafka', '@confluentinc/kafka-javascript': 'kafka',
  '@clickhouse/client': 'clickhouse',
  '@aws-sdk/client-s3': 'objectstorage', minio: 'objectstorage',
};

const PY_DEPS: Readonly<Record<string, ServiceType>> = {
  psycopg2: 'postgresql', 'psycopg2-binary': 'postgresql', psycopg: 'postgresql', asyncpg: 'postgresql',
  sqlalchemy: 'postgresql', django: 'postgresql',
  pymysql: 'mariadb', mysqlclient: 'mariadb',
  redis: 'valkey',
  elasticsearch: 'elasticsearch', meilisearch: 'meilisearch', typesense: 'typesense',
  'qdrant-client': 'qdrant',
  'nats-py': 'nats', 'kafka-python': 'kafka', confluentkafka: 'kafka',
  'clickhouse-driver': 'clickhouse', 'clickhouse-connect': 'clickhouse',
  boto3: 'objectstorage', minio: 'objectstorage',
};

/**
 * Env var name -> service. Weaker evidence by design: a `DATABASE_URL` in `.env.example`
 * might point at a database this project does not own.
 */
const ENV_HINTS: ReadonlyArray<readonly [RegExp, ServiceType, string]> = [
  [/^(DATABASE_URL|POSTGRES_[A-Z_]+|PG[A-Z]*)$/, 'postgresql', 'a Postgres connection variable'],
  [/^(MYSQL_[A-Z_]+|MARIADB_[A-Z_]+)$/, 'mariadb', 'a MySQL/MariaDB connection variable'],
  [/^(REDIS_URL|VALKEY_URL|REDIS_[A-Z_]+)$/, 'valkey', 'a Redis-protocol connection variable'],
  [/^(QDRANT_[A-Z_]+)$/, 'qdrant', 'a Qdrant connection variable'],
  [/^(NATS_[A-Z_]+)$/, 'nats', 'a NATS connection variable'],
  [/^(KAFKA_[A-Z_]+)$/, 'kafka', 'a Kafka connection variable'],
  [/^(ELASTIC(SEARCH)?_[A-Z_]+)$/, 'elasticsearch', 'an Elasticsearch connection variable'],
  [/^(MEILI(SEARCH)?_[A-Z_]+)$/, 'meilisearch', 'a Meilisearch connection variable'],
  [/^(TYPESENSE_[A-Z_]+)$/, 'typesense', 'a Typesense connection variable'],
  [/^(CLICKHOUSE_[A-Z_]+)$/, 'clickhouse', 'a ClickHouse connection variable'],
  [/^(S3_[A-Z_]+|AWS_S3_[A-Z_]+|MINIO_[A-Z_]+)$/, 'objectstorage', 'an S3-compatible storage variable'],
];

/** Manifest file -> the runtime that reads it. */
const RUNTIME_MANIFESTS: ReadonlyArray<readonly [string, ServiceType, string]> = [
  ['package.json', 'nodejs', 'a Node package manifest'],
  ['requirements.txt', 'python', 'a Python requirements file'],
  ['pyproject.toml', 'python', 'a Python project file'],
  ['Pipfile', 'python', 'a Pipenv file'],
  ['composer.json', 'php', 'a Composer manifest'],
  ['go.mod', 'go', 'a Go module file'],
  ['Cargo.toml', 'rust', 'a Cargo manifest'],
  ['pom.xml', 'java', 'a Maven POM'],
  ['build.gradle', 'java', 'a Gradle build file'],
  ['Gemfile', 'ruby', 'a Gemfile'],
  ['mix.exs', 'elixir', 'a Mix project file'],
  ['deno.json', 'deno', 'a Deno config'],
  ['bun.lockb', 'bun', 'a Bun lockfile'],
];

/* -------------------------------------------------------------------------- */

const base = (p: string): string => p.split('/').pop() ?? p;

function addEvidence(map: Map<ServiceType, Requirement>, type: ServiceType, role: Requirement['role'], confidence: Requirement['confidence'], ev: Evidence): void {
  const cur = map.get(type);
  if (cur === undefined) {
    map.set(type, { type, role, confidence, evidence: [ev] });
    return;
  }
  // Don't repeat the same finding from the same file twice.
  if (!cur.evidence.some((e) => e.path === ev.path && e.found === ev.found)) cur.evidence.push(ev);
  // Strong evidence anywhere upgrades the requirement: a client library beats a guess from
  // an env var name, and the stronger reason is the one worth showing.
  if (confidence === 'strong') cur.confidence = 'strong';
}

/** Dependency names out of a package.json, across every dependency field. */
function npmDeps(content: string): string[] {
  try {
    const pkg = JSON.parse(content) as Record<string, unknown>;
    const out: string[] = [];
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const d = pkg[field];
      if (d !== null && typeof d === 'object') out.push(...Object.keys(d as Record<string, unknown>));
    }
    return out;
  } catch {
    // A package.json that will not parse is a broken repo, not a repo with no dependencies.
    // Returning [] is the honest answer here; the caller still records the runtime.
    return [];
  }
}

/** Package names out of requirements.txt / pyproject / Pipfile, ignoring version pins. */
function pyDeps(content: string): string[] {
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map((l) => {
      const m = /^["']?([A-Za-z0-9_.-]+)/.exec(l);
      return (m?.[1] ?? '').toLowerCase();
    })
    .filter((s) => s !== '');
}

/** Variable names out of a dotenv-style file. Values are never read. */
function envNames(content: string): string[] {
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map((l) => (/^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1] ?? ''))
    .filter((s) => s !== '');
}

/**
 * Infer what this repo needs.
 *
 * Order matters only for readability of the result: runtimes first, then what they talk to.
 */
export function scanRepo(files: readonly RepoFile[]): Requirement[] {
  const found = new Map<ServiceType, Requirement>();

  for (const f of files) {
    const name = base(f.path);

    for (const [manifest, runtime, because] of RUNTIME_MANIFESTS) {
      if (name === manifest) {
        addEvidence(found, runtime, 'runtime', 'strong', { path: f.path, found: manifest, because });
      }
    }

    if (name === 'package.json') {
      for (const dep of npmDeps(f.content)) {
        const svc = NPM_DEPS[dep];
        if (svc !== undefined) {
          addEvidence(found, svc, 'dependency', 'strong', {
            path: f.path, found: dep, because: `the code depends on \`${dep}\`, a ${svc} client`,
          });
        }
      }
    }

    if (name === 'requirements.txt' || name === 'pyproject.toml' || name === 'Pipfile') {
      for (const dep of pyDeps(f.content)) {
        const svc = PY_DEPS[dep];
        if (svc !== undefined) {
          addEvidence(found, svc, 'dependency', 'strong', {
            path: f.path, found: dep, because: `the code depends on \`${dep}\`, a ${svc} client`,
          });
        }
      }
    }

    if (name === '.env' || name === '.env.example' || name.startsWith('.env.')) {
      for (const v of envNames(f.content)) {
        for (const [re, svc, because] of ENV_HINTS) {
          if (re.test(v)) {
            addEvidence(found, svc, 'dependency', 'likely', {
              path: f.path, found: v, because: `${because} (an env var name only suggests it -- it may point outside this project)`,
            });
          }
        }
      }
    }
  }

  const all = [...found.values()];
  return [
    ...all.filter((r) => r.role === 'runtime').sort((a, b) => a.type.localeCompare(b.type)),
    ...all.filter((r) => r.role === 'dependency').sort((a, b) => a.type.localeCompare(b.type)),
  ];
}

/**
 * Env var names that look like application secrets.
 *
 * NAMES ONLY. The value on the right of the `=` is never read, never returned, and never
 * leaves this machine. That is not fastidiousness: the whole point is to declare
 * `JWT_SECRET` as a secret on the new project, and the correct value for a fresh environment
 * is a NEW random one, not a copy of whatever is sitting in somebody's local `.env`. Copying
 * it would take a development credential and post it to a remote service.
 *
 * Connection strings are deliberately excluded. `DATABASE_URL` and friends are secrets, but
 * Zerops injects them itself once the database service exists — declaring our own would
 * shadow the platform's with a random string and break the app in a way that looks like a
 * connection bug.
 */
const SECRET_NAME =
  /(SECRET|PASSWORD|PASSWD|TOKEN|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|_SALT|JWT|SIGNING|PEPPER|_KEY$|_KEY_ID$)/i;

/**
 * A key that is meant to be seen. `STRIPE_PUBLISHABLE_KEY` ends in `_KEY` and belongs in the
 * client bundle; replacing it with a generated random string would break checkout in a way
 * that looks like a Stripe outage.
 */
const NOT_SECRET = /(PUBLIC|PUBLISHABLE)/i;

const PLATFORM_INJECTED = /(_URL|_URI|_HOST|_PORT|_DSN)$/i;

export function findSecretNames(files: readonly RepoFile[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    const name = base(f.path);
    if (name !== '.env' && name !== '.env.example' && !name.startsWith('.env.')) continue;
    for (const v of envNames(f.content)) {
      if (SECRET_NAME.test(v) && !NOT_SECRET.test(v) && !PLATFORM_INJECTED.test(v)) out.add(v);
    }
  }
  return [...out].sort();
}

/** Files worth reading. Keeps the desktop app from slurping node_modules off disk. */
export const SCAN_GLOBS: readonly string[] = [
  'package.json', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'composer.json',
  'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'Gemfile', 'mix.exs',
  'deno.json', 'bun.lockb', '.env', '.env.example',
];
