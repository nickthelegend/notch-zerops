/**
 * Repo scanning and drift.
 *
 * A drift report is an ACCUSATION — "you are missing a database" — so these tests are mostly
 * about not crying wolf. The expensive failures here are not crashes; they are a confident,
 * wrong sentence that sends someone to provision a second Postgres they already had.
 */
import { describe, expect, it } from 'vitest';

import { scanRepo, type RepoFile } from '../src/repo/scan.js';
import { computeDrift, satisfies } from '../src/zerops/drift.js';
import { toNode } from '../src/zerops/graph.js';
import { ZServiceSchema } from '../src/zerops/api.js';

const f = (path: string, content: string): RepoFile => ({ path, content });

const node = (name: string, typeId: string, over: Record<string, unknown> = {}) =>
  toNode(ZServiceSchema.parse({
    id: `id-${name}`, name, status: 'ACTIVE', projectId: 'p1',
    serviceStackTypeId: typeId, ports: [], connectedStacks: [],
    coreService: { currentActiveContainerCount: 1 },
    ...over,
  }));

/* -------------------------------------------------------------------------- */

describe('scanRepo', () => {
  it('finds the runtime from the manifest', () => {
    const r = scanRepo([f('package.json', '{}')]);
    expect(r.find((x) => x.type === 'nodejs')?.role).toBe('runtime');
  });

  it('infers Postgres from a real client dependency, and cites it', () => {
    const r = scanRepo([f('package.json', JSON.stringify({ dependencies: { pg: '^8.0.0' } }))]);
    const pg = r.find((x) => x.type === 'postgresql');
    expect(pg?.confidence).toBe('strong');
    // The citation is the feature. Without it the tool is just asserting.
    expect(pg?.evidence[0]?.found).toBe('pg');
    expect(pg?.evidence[0]?.path).toBe('package.json');
  });

  it('reads every dependency field, not just `dependencies`', () => {
    const r = scanRepo([f('package.json', JSON.stringify({ devDependencies: { ioredis: '^5' } }))]);
    expect(r.some((x) => x.type === 'valkey')).toBe(true);
  });

  it('matches package names exactly, never by substring', () => {
    // `pg-boss` is a job queue, not the `pg` driver. Substring matching would claim Postgres
    // from any package whose name merely contains "pg".
    const r = scanRepo([f('package.json', JSON.stringify({ dependencies: { 'pg-boss': '^9' } }))]);
    expect(r.some((x) => x.type === 'postgresql')).toBe(false);
  });

  it('treats an env var name as weaker evidence than a dependency', () => {
    // A DATABASE_URL may point at a database this project does not own. Acting on it with
    // full confidence would tell someone to provision a duplicate.
    const r = scanRepo([f('.env.example', 'DATABASE_URL=postgres://x\n')]);
    expect(r.find((x) => x.type === 'postgresql')?.confidence).toBe('likely');
  });

  it('upgrades to strong when code evidence appears alongside a weak hint', () => {
    const r = scanRepo([
      f('.env.example', 'DATABASE_URL=postgres://x\n'),
      f('package.json', JSON.stringify({ dependencies: { pg: '^8' } })),
    ]);
    const pg = r.find((x) => x.type === 'postgresql');
    expect(pg?.confidence).toBe('strong');
    expect(pg?.evidence.length).toBeGreaterThan(1);
  });

  it('reads Python requirements, ignoring version pins and comments', () => {
    const r = scanRepo([f('requirements.txt', '# db\npsycopg2-binary==2.9.9\nqdrant-client>=1.7\n')]);
    expect(r.some((x) => x.type === 'postgresql')).toBe(true);
    expect(r.some((x) => x.type === 'qdrant')).toBe(true);
    expect(r.some((x) => x.type === 'python')).toBe(true);
  });

  it('survives an unparseable package.json without losing the runtime', () => {
    // A broken manifest is a broken repo, not a repo with no dependencies -- and it must not
    // throw, or one bad file takes down the whole scan.
    const r = scanRepo([f('package.json', '{ this is not json')]);
    expect(r.some((x) => x.type === 'nodejs')).toBe(true);
  });

  it('never reports the same evidence twice', () => {
    const r = scanRepo([f('package.json', JSON.stringify({ dependencies: { pg: '^8' }, devDependencies: { pg: '^8' } }))]);
    expect(r.find((x) => x.type === 'postgresql')?.evidence).toHaveLength(1);
  });

  it('returns nothing for a repo with no manifests', () => {
    expect(scanRepo([f('README.md', '# hello')])).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe('satisfies', () => {
  it('matches on type, ignoring the version suffix', () => {
    expect(satisfies('postgresql@16', 'postgresql')).toBe(true);
  });

  it('accepts Valkey for a Redis client, because they speak the same protocol', () => {
    // Zerops documents Redis/KeyDB as the legacy path to Valkey. Reporting "Redis missing"
    // on a project running Valkey would be a false alarm on the platform's own advice.
    expect(satisfies('valkey@7', 'valkey')).toBe(true);
    expect(satisfies('keydb@6', 'valkey')).toBe(true);
  });

  it('accepts a generic container for a runtime requirement', () => {
    expect(satisfies('ubuntu', 'nodejs')).toBe(true);
  });

  it('does not accept a database for a different database', () => {
    expect(satisfies('mariadb@11', 'postgresql')).toBe(false);
  });

  it('does not accept a generic container for a database', () => {
    // An Ubuntu box could in principle host Postgres, but Zerops did not provision one and
    // pretending otherwise would hide a genuinely missing managed service.
    expect(satisfies('ubuntu', 'postgresql')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('computeDrift', () => {
  it('matches by TYPE, not by name — a Postgres called `bananas` still counts', () => {
    // The false alarm this prevents: Zerops service names are arbitrary, so name matching
    // would report Postgres missing on a project that obviously has it.
    const req = scanRepo([f('package.json', JSON.stringify({ dependencies: { pg: '^8' } }))]);
    const d = computeDrift(req, [node('bananas', 'postgresql@16')]);
    // Assert on the type under test, not the total: a package.json also implies a `nodejs`
    // runtime, which is legitimately missing here and would make a count assertion pass or
    // fail for a reason that has nothing to do with name-vs-type matching.
    expect(d.items.find((i) => i.type === 'postgresql')?.status).toBe('satisfied');
    expect(d.items.find((i) => i.type === 'postgresql')?.deployed?.name).toBe('bananas');
  });

  it('reports a genuinely absent dependency as missing, and quotes the evidence', () => {
    const req = scanRepo([f('package.json', JSON.stringify({ dependencies: { '@qdrant/js-client-rest': '^1' } }))]);
    const d = computeDrift(req, [node('db', 'postgresql@16')]);
    const q = d.items.find((i) => i.type === 'qdrant');
    expect(q?.status).toBe('missing');
    expect(q?.summary).toContain('package.json');
  });

  it('hedges a missing service that was only inferred from an env var', () => {
    const req = scanRepo([f('.env.example', 'REDIS_URL=redis://x\n')]);
    const d = computeDrift(req, []);
    const item = d.items.find((i) => i.type === 'valkey');
    expect(item?.status).toBe('missing');
    // It must invite a check rather than issue an instruction.
    expect(item?.summary).toContain('outside this project');
  });

  it('does not report Zerops system services as unreferenced', () => {
    // core and zcp appear on every project. Flagging them would make the report noise.
    const d = computeDrift([], [node('core', 'core', { isSystem: true }), node('zcp', 'zcp', { isSystem: true })]);
    expect(d.counts.unreferenced).toBe(0);
  });

  it('words an unreferenced service as a fact, never as waste', () => {
    const d = computeDrift([], [node('cache', 'valkey@7')]);
    const item = d.items.find((i) => i.status === 'unreferenced');
    expect(item?.summary).toContain('often deliberate');
    expect(item?.summary).not.toMatch(/waste|unused|remove|delete/i);
  });

  it('flags a satisfied service that has never actually been deployed', () => {
    // "The service exists" and "the service is running" are different claims, and a green
    // tick on a service with no containers would be the wrong one.
    const req = scanRepo([f('package.json', JSON.stringify({ dependencies: { pg: '^8' } }))]);
    const d = computeDrift(req, [node('db', 'postgresql@16', { coreService: { currentActiveContainerCount: null }, status: 'READY_TO_DEPLOY' })]);
    expect(d.items.find((i) => i.type === 'postgresql')?.summary).toContain('never been deployed');
  });

  it('one deployed service cannot satisfy two requirements', () => {
    const req = scanRepo([f('package.json', JSON.stringify({ dependencies: { pg: '^8', mysql2: '^3' } }))]);
    const d = computeDrift(req, [node('db', 'postgresql@16')]);
    // postgresql is covered; mariadb is not, even though a database is deployed. (nodejs is
    // also missing here, which is why this checks the two database types by name.)
    expect(d.items.find((i) => i.type === 'postgresql')?.status).toBe('satisfied');
    expect(d.items.find((i) => i.type === 'mariadb')?.status).toBe('missing');
    expect(d.counts.satisfied).toBe(1);
  });

  it('orders provisioning so dependencies come before runtimes', () => {
    // A runtime that boots before its database exists just crash-loops. The button must not
    // create that situation.
    const req = scanRepo([
      f('package.json', JSON.stringify({ dependencies: { pg: '^8', '@qdrant/js-client-rest': '^1' } })),
    ]);
    const d = computeDrift(req, []);
    const roles = d.provisionable.map((i) => i.required?.role);
    expect(roles.indexOf('runtime')).toBe(roles.length - 1);
  });

  it('says so plainly when nothing is missing', () => {
    const req = scanRepo([f('package.json', JSON.stringify({ dependencies: { pg: '^8' } }))]);
    const d = computeDrift(req, [node('db', 'postgresql@16'), node('app', 'nodejs@22')]);
    expect(d.counts.missing).toBe(0);
    expect(d.notes.join(' ')).toContain('already running');
  });
});
