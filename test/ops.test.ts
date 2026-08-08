/**
 * Signals, the architect, and the action log.
 *
 * The signal tests care about one thing above accuracy: that an unmeasured number stays null.
 * Zero latency and zero errors are what a broken probe looks like, and they are also what a
 * perfect service looks like — an agent cannot tell those apart, so the code must.
 */
import { describe, expect, it, beforeEach } from 'vitest';

import { percentile, summarise } from '../src/ops/signals.js';
import { instruction, parseDesign } from '../src/ops/architect.js';
import * as journal from '../src/zerops/journal.js';

const VOCAB = ['postgresql', 'valkey', 'meilisearch', 'typesense', 'elasticsearch', 'qdrant',
  'clickhouse', 'nats', 'kafka', 'objectstorage', 'nodejs', 'python', 'go'];

describe('percentile', () => {
  it('is null for no samples, not zero', () => {
    expect(percentile([], 95)).toBeNull();
  });
  it('uses nearest-rank', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 100)).toBe(40);
  });
  it('handles a single sample', () => {
    expect(percentile([7], 95)).toBe(7);
  });
  it('does not care what order it was given', () => {
    expect(percentile([40, 10, 30, 20], 75)).toBe(percentile([10, 20, 30, 40], 75));
  });
});

describe('summarise', () => {
  it('leaves latency null when nothing succeeded, rather than reporting 0ms', () => {
    const s = summarise([{ status: 0, ms: 9000 }, { status: 500, ms: 12 }], 1000);
    expect(s.p50).toBeNull();
    expect(s.p95).toBeNull();
    expect(s.errorRate).toBe(1);
    expect(s.throughput).toBe(0);
  });

  it('counts a timeout as an error, not as a fast response', () => {
    const s = summarise([{ status: 200, ms: 100 }, { status: 0, ms: 10_000 }], 10_000);
    expect(s.errorRate).toBe(0.5);
    expect(s.p50).toBe(100);
    expect(s.slowest).toBe(100);
  });

  it('treats a 3xx as success — a redirect served the user', () => {
    expect(summarise([{ status: 301, ms: 20 }], 100).errorRate).toBe(0);
  });

  it('counts a 4xx as a failure', () => {
    expect(summarise([{ status: 404, ms: 20 }], 100).errorRate).toBe(1);
  });

  it('is null everywhere when there were no probes at all', () => {
    const s = summarise([], 0);
    expect(s.errorRate).toBeNull();
    expect(s.throughput).toBeNull();
    expect(s.samples).toBe(0);
  });

  it('computes throughput over wall time, not per request', () => {
    const probes = Array.from({ length: 10 }, () => ({ status: 200, ms: 50 }));
    expect(summarise(probes, 2000).throughput).toBe(5);
  });
});

describe('architect', () => {
  it('puts the whole vocabulary in the prompt so the agent cannot invent one', () => {
    const i = instruction('a chat app', VOCAB);
    for (const v of VOCAB) expect(i).toContain(v);
    expect(i).toContain('a chat app');
  });

  it('keeps the reasoning for each chosen service', () => {
    const d = parseDesign(JSON.stringify({
      understanding: 'A chat app with search',
      chosen: [{ type: 'postgresql', role: 'users and messages', because: 'relational, needs joins' }],
      rejected: [{ type: 'clickhouse', because: 'analytics scale is not implied here' }],
    }), VOCAB);
    expect(d.chosen[0]?.because).toBe('relational, needs joins');
    expect(d.rejected[0]?.because).toContain('analytics scale');
    expect(d.understanding).toBe('A chat app with search');
  });

  it('sends a service Zerops does not offer to unavailable, and does not fuzzy-match it', () => {
    const d = parseDesign(JSON.stringify({
      chosen: [{ type: 'dynamodb', because: 'nosql' }, { type: 'postgresql', because: 'relational' }],
    }), VOCAB);
    expect(d.unavailable).toEqual(['dynamodb']);
    expect(d.chosen.map((c) => c.type)).toEqual(['postgresql']);
  });

  it('drops a rejection of something it also chose, because that is a contradiction', () => {
    const d = parseDesign(JSON.stringify({
      chosen: [{ type: 'qdrant', because: 'semantic search' }],
      rejected: [{ type: 'qdrant', because: 'overkill' }],
    }), VOCAB);
    expect(d.chosen).toHaveLength(1);
    expect(d.rejected).toHaveLength(0);
  });

  it('tolerates bare strings instead of objects', () => {
    const d = parseDesign('{"chosen":["postgresql","valkey"]}', VOCAB);
    expect(d.chosen.map((c) => c.type)).toEqual(['postgresql', 'valkey']);
    expect(d.chosen[0]?.because).toBe('No reason given.');
  });

  it('de-duplicates a service named twice', () => {
    const d = parseDesign('{"chosen":[{"type":"nodejs"},{"type":"nodejs"}]}', VOCAB);
    expect(d.chosen).toHaveLength(1);
  });

  it('survives output that is not JSON at all', () => {
    const d = parseDesign('I would use Postgres and Redis probably', VOCAB);
    expect(d.chosen).toEqual([]);
    expect(d.rejected).toEqual([]);
  });

  it('digs the JSON out of a fenced block', () => {
    const d = parseDesign('```json\n{"chosen":[{"type":"nats","because":"jobs"}]}\n```', VOCAB);
    expect(d.chosen[0]?.type).toBe('nats');
  });
});

describe('journal', () => {
  beforeEach(() => journal.reset());

  it('does not call a search a write, even though it is a POST', () => {
    expect(journal.isWrite('POST', '/project/search')).toBe(false);
    expect(journal.isWrite('POST', '/service-stack/search')).toBe(false);
  });

  it('does call a real mutation a write', () => {
    expect(journal.isWrite('PUT', '/service-stack/abc/autoscaling')).toBe(true);
    expect(journal.isWrite('POST', '/client/x/project')).toBe(true);
    expect(journal.isWrite('DELETE', '/project/abc')).toBe(true);
  });

  it('never calls a GET a write', () => {
    expect(journal.isWrite('GET', '/service-stack/abc/container')).toBe(false);
  });

  it('describes calls in words rather than restating the URL', () => {
    expect(journal.describe('PUT', '/service-stack/abc/autoscaling')).toBe('Changed autoscaling limits on a service');
    expect(journal.describe('GET', '/service-stack/abc/container')).toBe('Read the running containers of a service');
    expect(journal.describe('GET', '/user/info')).toContain('token');
    expect(journal.describe('POST', '/service-stack-type/search')).toContain('catalogue');
  });

  it('hands back only what is new, so a poller does not re-read the buffer', () => {
    journal.record({ method: 'GET', path: '/a', status: 200, ms: 1, ok: true, bytes: 0, error: null });
    const first = journal.since(0);
    journal.record({ method: 'GET', path: '/b', status: 200, ms: 1, ok: true, bytes: 0, error: null });
    const next = journal.since(first[0]?.seq ?? 0);
    expect(next).toHaveLength(1);
    expect(next[0]?.path).toBe('/b');
  });

  it('counts writes and failures separately from the total', () => {
    journal.record({ method: 'POST', path: '/project/search', status: 200, ms: 5, ok: true, bytes: 0, error: null });
    journal.record({ method: 'PUT', path: '/service-stack/a/autoscaling', status: 200, ms: 5, ok: true, bytes: 0, error: null });
    journal.record({ method: 'GET', path: '/x', status: 500, ms: 5, ok: false, bytes: 0, error: 'boom' });
    const c = journal.counts();
    expect(c).toMatchObject({ total: 3, writes: 1, failed: 1 });
  });

  it('rolls rather than growing without limit', () => {
    for (let i = 0; i < 600; i += 1) {
      journal.record({ method: 'GET', path: `/x/${i}`, status: 200, ms: 1, ok: true, bytes: 0, error: null });
    }
    expect(journal.all().length).toBeLessThanOrEqual(500);
    // and it keeps the NEWEST, not the oldest
    expect(journal.all().at(-1)?.path).toBe('/x/599');
  });

  it('notifies a subscriber as calls happen', () => {
    const seen: string[] = [];
    const off = journal.subscribe((a) => seen.push(a.path));
    journal.record({ method: 'GET', path: '/live', status: 200, ms: 1, ok: true, bytes: 0, error: null });
    off();
    journal.record({ method: 'GET', path: '/after', status: 200, ms: 1, ok: true, bytes: 0, error: null });
    expect(seen).toEqual(['/live']);
  });
});
