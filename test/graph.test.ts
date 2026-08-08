/**
 * The architecture graph.
 *
 * This is the function that decides what the picture SAYS about someone's infrastructure, so
 * the tests are about honesty rather than shape. A diagram that quietly claims a service is
 * highly available, or draws a connection the platform has no record of, is worse than no
 * diagram — it is confidently wrong in a way a judge can catch by clicking through to the
 * Zerops GUI.
 *
 * The fixtures are trimmed from real `/service-stack/search` responses from a live account,
 * including the awkward parts: `mode: null` and a missing container count on a service that
 * has never deployed.
 */
import { describe, expect, it } from 'vitest';

import { ZServiceSchema, ZProjectSchema, type ZService } from '../src/zerops/api.js';
import { buildGraph, classify, layout, toEdges, toNode } from '../src/zerops/graph.js';

const project = ZProjectSchema.parse({ id: 'p1', name: 'test', status: 'ACTIVE' });

/** Parsed through the real schema, so a fixture cannot describe a payload the API rejects. */
function svc(over: Record<string, unknown>): ZService {
  return ZServiceSchema.parse({
    id: 's1',
    name: 'svc',
    status: 'ACTIVE',
    projectId: 'p1',
    serviceStackTypeId: 'nodejs@22',
    ports: [],
    connectedStacks: [],
    ...over,
  });
}

describe('classify', () => {
  it('maps the managed services Zerops actually offers', () => {
    expect(classify('postgresql@16')).toBe('database');
    expect(classify('valkey@7')).toBe('cache');
    expect(classify('qdrant@1')).toBe('search');
    expect(classify('nats@2')).toBe('queue');
    expect(classify('objectstorage')).toBe('storage');
    expect(classify('nodejs@22')).toBe('runtime');
    expect(classify('zcp')).toBe('system');
  });

  it('matches on prefix, because type ids carry versions', () => {
    expect(classify('postgresql@16')).toBe(classify('postgresql@14'));
  });

  it('keeps an unknown type as unknown rather than dropping it', () => {
    // The failure mode this guards: a Zerops release adds a service type, this list is stale,
    // and the diagram silently omits part of someone's infrastructure. Unknown still draws.
    expect(classify('some-future-service@1')).toBe('unknown');
  });

  it('falls back to the platform category only as a last resort', () => {
    expect(classify('totally-unrecognised', 'CORE')).toBe('system');
    expect(classify('totally-unrecognised', 'USER')).toBe('unknown');
  });
});

describe('toNode: what the card is allowed to claim', () => {
  it('a never-deployed service has null containers, not zero and not one', () => {
    // Straight from the live account: `ubuntu` in status READY_TO_DEPLOY has no coreService
    // container count at all. Rendering that as 1 would draw a box for a process that has
    // never existed.
    const n = toNode(svc({ name: 'ubuntu', status: 'READY_TO_DEPLOY', serviceStackTypeId: 'ubuntu', mode: null }));
    expect(n.containers).toBeNull();
    expect(n.containers).not.toBe(0);
    expect(n.containers).not.toBe(1);
  });

  it('a deployed service reports its real container count', () => {
    const n = toNode(svc({ coreService: { currentActiveContainerCount: 4 } }));
    expect(n.containers).toBe(4);
  });

  it('zero containers is preserved as zero, distinct from never-deployed', () => {
    // "Deployed but scaled to nothing" and "never deployed" are different problems.
    const n = toNode(svc({ coreService: { currentActiveContainerCount: 0 } }));
    expect(n.containers).toBe(0);
    expect(n.containers).not.toBeNull();
  });

  it('HA is read from mode, never inferred from container count', () => {
    // The trap: a single-mode service can briefly run several containers during a deploy.
    // Inferring HA from that would put an HA badge on something that is not HA.
    const many = toNode(svc({ mode: 'single', coreService: { currentActiveContainerCount: 3 } }));
    expect(many.ha).toBe(false);

    const ha = toNode(svc({ mode: 'HA', coreService: { currentActiveContainerCount: 3 } }));
    expect(ha.ha).toBe(true);
  });

  it('mode null is not HA', () => {
    expect(toNode(svc({ mode: null })).ha).toBe(false);
  });

  it('public reachability is true if EITHER http routing or a subdomain is on', () => {
    expect(toNode(svc({ hasPublicHttpRoutingAccess: true, subdomainAccess: false })).publicHttp).toBe(true);
    expect(toNode(svc({ hasPublicHttpRoutingAccess: false, subdomainAccess: true })).publicHttp).toBe(true);
    expect(toNode(svc({ hasPublicHttpRoutingAccess: false, subdomainAccess: false })).publicHttp).toBe(false);
  });

  it('carries ports through, as observed on the live zcp service', () => {
    const n = toNode(svc({ ports: [{ port: 8080, protocol: 'tcp', scheme: 'http', httpRouting: true }] }));
    expect(n.ports).toEqual([8080]);
  });

  it('prefers the platform label but never renders undefined', () => {
    expect(toNode(svc({ serviceStackTypeInfo: { serviceStackTypeName: 'PostgreSQL' } })).typeName).toBe('PostgreSQL');
    expect(toNode(svc({ serviceStackTypeId: 'weird@1' })).typeName).toBe('weird@1');
  });
});

describe('toEdges: only relationships the platform reports', () => {
  it('draws nothing when connectedStacks is empty', () => {
    // An `app` and a `db` in one project are NOT necessarily wired together. Guessing would
    // invent a relationship Zerops has no record of.
    const services = [svc({ id: 'a', name: 'app' }), svc({ id: 'b', name: 'db', serviceStackTypeId: 'postgresql@16' })];
    expect(toEdges(services).edges).toEqual([]);
  });

  it('accepts an id string or an {id} object', () => {
    const services = [svc({ id: 'a', connectedStacks: ['b'] }), svc({ id: 'b', connectedStacks: [{ id: 'a' }] })];
    expect(toEdges(services).edges).toHaveLength(1);
  });

  it('deduplicates a reciprocal connection into one wire', () => {
    const services = [svc({ id: 'a', connectedStacks: ['b'] }), svc({ id: 'b', connectedStacks: ['a'] })];
    const { edges } = toEdges(services);
    expect(edges).toHaveLength(1);
  });

  it('counts an edge to a service this project does not list, and does not draw it', () => {
    const services = [svc({ id: 'a', connectedStacks: ['ghost'] })];
    const { edges, unreadable } = toEdges(services);
    expect(edges).toEqual([]);
    expect(unreadable).toBe(1);
  });

  it('counts an unrecognised shape rather than guessing at it', () => {
    const services = [svc({ id: 'a', connectedStacks: [{ notAnId: true }, 42] })];
    expect(toEdges(services).unreadable).toBe(2);
  });
});

describe('buildGraph: the notes are part of the answer', () => {
  it('says so when there are services but no connections', () => {
    // An architecture diagram with no lines looks broken. Usually it is not, and the picture
    // has to explain itself rather than leave the viewer to assume a bug.
    const g = buildGraph(project, [svc({ id: 'a' }), svc({ id: 'b', name: 'db' })]);
    expect(g.edges).toEqual([]);
    expect(g.notes.join(' ')).toContain('no connections');
    expect(g.notes.join(' ')).toContain('Nothing is inferred');
  });

  it('names the services that have never been deployed', () => {
    const g = buildGraph(project, [
      svc({ id: 'a', name: 'ubuntu', status: 'READY_TO_DEPLOY' }),
      svc({ id: 'b', name: 'api', coreService: { currentActiveContainerCount: 2 } }),
    ]);
    expect(g.notes.join(' ')).toContain('ubuntu');
    expect(g.notes.join(' ')).not.toContain('api');
  });

  it('does not count system services as undeployed noise', () => {
    // core and zcp are Zerops' own; reporting them as "you forgot to deploy this" would be
    // noise the user cannot act on.
    const g = buildGraph(project, [svc({ id: 'c', name: 'core', serviceStackTypeId: 'core', isSystem: true })]);
    expect(g.notes.join(' ')).not.toContain('never been deployed');
  });

  it('keeps every service, including unknown types', () => {
    const g = buildGraph(project, [svc({ id: 'x', serviceStackTypeId: 'brand-new-thing@1' })]);
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0]?.kind).toBe('unknown');
  });
});

describe('layout', () => {
  it('puts runtimes above stateful services above platform services', () => {
    const nodes = [
      toNode(svc({ id: 'db', name: 'db', serviceStackTypeId: 'postgresql@16' })),
      toNode(svc({ id: 'app', name: 'app', serviceStackTypeId: 'nodejs@22' })),
      toNode(svc({ id: 'core', name: 'core', serviceStackTypeId: 'core', isSystem: true })),
    ];
    const pos = Object.fromEntries(layout(nodes).map((n) => [n.id, n.position.y]));
    expect(pos['app']).toBeLessThan(pos['db'] ?? 0);
    expect(pos['db']).toBeLessThan(pos['core'] ?? 0);
  });

  it('is stable across calls, so the diagram does not reshuffle on every poll', () => {
    // A correct graph whose boxes jump every refresh is unreadable. Order inside a row is
    // by name, not by whatever order the API happened to return.
    const nodes = [
      toNode(svc({ id: '1', name: 'zeta', serviceStackTypeId: 'nodejs@22' })),
      toNode(svc({ id: '2', name: 'alpha', serviceStackTypeId: 'nodejs@22' })),
    ];
    const a = layout(nodes).map((n) => n.name);
    const b = layout([...nodes].reverse()).map((n) => n.name);
    expect(a).toEqual(b);
    expect(a[0]).toBe('alpha');
  });

  it('does not overlap two nodes in the same tier', () => {
    const nodes = ['a', 'b', 'c'].map((n) => toNode(svc({ id: n, name: n, serviceStackTypeId: 'nodejs@22' })));
    const xs = layout(nodes).map((n) => n.position.x);
    expect(new Set(xs).size).toBe(3);
  });
});

describe('layout: empty tiers collapse', () => {
  it('does not leave a gap for a tier nothing occupies', () => {
    // Tier numbers are a priority ordering, not coordinates. A project with only runtimes
    // and platform services was rendering with a 510px hole, which made fitView zoom out
    // until every card was unreadable -- a correct graph shown as confetti.
    const nodes = [
      toNode(svc({ id: 'app', name: 'app', serviceStackTypeId: 'nodejs@22' })),
      toNode(svc({ id: 'core', name: 'core', serviceStackTypeId: 'core', isSystem: true })),
    ];
    const ys = layout(nodes, { rowHeight: 100 }).map((n) => n.position.y).sort((a, b) => a - b);
    expect(ys).toEqual([0, 100]);
  });

  it('still orders the occupied rows by tier', () => {
    const nodes = [
      toNode(svc({ id: 'core', name: 'core', serviceStackTypeId: 'core', isSystem: true })),
      toNode(svc({ id: 'db', name: 'db', serviceStackTypeId: 'postgresql@16' })),
    ];
    const pos = Object.fromEntries(layout(nodes).map((n) => [n.id, n.position.y]));
    expect(pos['db']).toBeLessThan(pos['core'] ?? 0);
  });
});
