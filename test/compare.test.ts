/**
 * Comparing two environments.
 *
 * The whole value is in what it DOESN'T say. Staging and production legitimately differ in
 * container counts, in uptime, in hostnames chosen by whoever created them. If those show up
 * as findings, the three lines that actually matter — a different Valkey mode, a variable set
 * in one and not the other — are buried, and nobody reads the list twice.
 */
import { describe, expect, it } from 'vitest';

import { compareEnvironments, type EnvService, type EnvSnapshot } from '../src/zerops/compare.js';

const svc = (over: Partial<EnvService> & { type: string }): EnvService => ({
  name: over.type, version: '16', mode: 'NON_HA', publicHttp: false, ...over,
});

const snap = (name: string, services: EnvService[], envKeys: string[] = []): EnvSnapshot =>
  ({ projectId: name, name, services, envKeys });

describe('compareEnvironments', () => {
  it('finds nothing between two identical projects', () => {
    const a = snap('stage', [svc({ type: 'postgresql' })]);
    const b = snap('prod', [svc({ type: 'postgresql' })]);
    const c = compareEnvironments(a, b);
    expect(c.differences).toEqual([]);
    expect(c.identical).toEqual(['postgresql']);
  });

  it('matches by TYPE, not by hostname', () => {
    // `db` in staging and `postgresql` in production are the same service wearing different
    // names. Matching on the name would report two failures instead of zero.
    const a = snap('stage', [svc({ type: 'postgresql', name: 'db' })]);
    const b = snap('prod', [svc({ type: 'postgresql', name: 'postgresql' })]);
    expect(compareEnvironments(a, b).differences).toEqual([]);
  });

  it('reports a service one side does not have at all', () => {
    const a = snap('stage', [svc({ type: 'postgresql' }), svc({ type: 'valkey' })]);
    const b = snap('prod', [svc({ type: 'postgresql' })]);
    const d = compareEnvironments(a, b).differences;
    expect(d).toHaveLength(1);
    expect(d[0]?.kind).toBe('only_in_a');
    expect(d[0]?.severity).toBe('high');
  });

  it('flags a mode difference as high — failover behaviour is not a detail', () => {
    const a = snap('stage', [svc({ type: 'valkey', mode: 'NON_HA' })]);
    const b = snap('prod', [svc({ type: 'valkey', mode: 'HA' })]);
    const d = compareEnvironments(a, b).differences;
    expect(d[0]?.kind).toBe('mode');
    expect(d[0]?.severity).toBe('high');
    expect(d[0]?.detail).toContain('Failover');
  });

  it('flags a version difference, and does not call it high', () => {
    const a = snap('stage', [svc({ type: 'postgresql', version: '16' })]);
    const b = snap('prod', [svc({ type: 'postgresql', version: '18' })]);
    const d = compareEnvironments(a, b).differences;
    expect(d[0]?.kind).toBe('version');
    expect(d[0]?.severity).toBe('medium');
  });

  it('flags public routing, because one side being on the internet is not a detail either', () => {
    const a = snap('stage', [svc({ type: 'nodejs', publicHttp: false })]);
    const b = snap('prod', [svc({ type: 'nodejs', publicHttp: true })]);
    expect(compareEnvironments(a, b).differences[0]?.kind).toBe('routing');
  });

  it('reports an env key set on one side only, in both directions', () => {
    const a = snap('stage', [], ['STRIPE_KEY']);
    const b = snap('prod', [], ['SENTRY_DSN']);
    const kinds = compareEnvironments(a, b).differences.map((x) => `${x.kind}:${x.subject}`);
    expect(kinds).toContain('env_key:STRIPE_KEY');
    expect(kinds).toContain('env_key:SENTRY_DSN');
  });

  it('ignores the keys Zerops puts on every project', () => {
    // These are identical everywhere by construction; listing them is pure noise.
    const a = snap('stage', [], ['storageCdnUrl', 'zeropsSubdomainHost', 'REAL_ONE']);
    const b = snap('prod', [], []);
    const subjects = compareEnvironments(a, b).differences.map((d) => d.subject);
    expect(subjects).toEqual(['REAL_ONE']);
  });

  it('says nothing about container counts or status', () => {
    // Deliberately absent from EnvService: staging running one container and production three
    // is the correct state of the world, not drift.
    const a = snap('stage', [svc({ type: 'postgresql' })]);
    const b = snap('prod', [svc({ type: 'postgresql' })]);
    expect(compareEnvironments(a, b).differences).toEqual([]);
  });

  it('puts the dangerous differences first', () => {
    const a = snap('stage', [svc({ type: 'postgresql', version: '16' }), svc({ type: 'valkey', mode: 'NON_HA' })]);
    const b = snap('prod', [svc({ type: 'postgresql', version: '18' }), svc({ type: 'valkey', mode: 'HA' })]);
    const d = compareEnvironments(a, b).differences;
    expect(d[0]?.severity).toBe('high');
  });

  it('treats never-deployed as different from deployed', () => {
    const a = snap('stage', [svc({ type: 'nodejs', mode: null })]);
    const b = snap('prod', [svc({ type: 'nodejs', mode: 'NON_HA' })]);
    expect(compareEnvironments(a, b).differences[0]?.kind).toBe('mode');
  });
});
