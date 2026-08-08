/**
 * Edges read out of the code.
 *
 * The board was empty because it asked the platform, and the platform only knows about a
 * connection once somebody wires one. These tests pin the two things that make the derived
 * version trustworthy: every edge carries the line that produced it, and an edge is never
 * invented where the repo did not claim one.
 */
import { describe, expect, it } from 'vitest';

import { deriveWiring } from '../src/zerops/wiring.js';
import type { Requirement } from '../src/repo/scan.js';
import type { ArchNode } from '../src/zerops/graph.js';

const req = (type: string, role: 'runtime' | 'dependency', found = 'pg', confidence: 'strong' | 'likely' = 'strong'): Requirement =>
  ({ type, role, confidence, evidence: [{ path: 'package.json', found, because: `the code depends on \`${found}\`` }] } as Requirement);

const node = (name: string, typeName = name): ArchNode => ({
  id: name, name, typeId: name, typeName, version: '1', kind: 'database', status: 'ACTIVE',
  ha: false, containers: 1, publicHttp: false, ports: [], system: false,
} as unknown as ArchNode);

describe('deriveWiring', () => {
  it('hangs every dependency off the runtime', () => {
    const w = deriveWiring([req('nodejs', 'runtime'), req('postgresql', 'dependency'), req('valkey', 'dependency', 'ioredis')], [], 0);
    expect(w.runtime).toBe('nodejs');
    expect(w.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['nodejs->postgresql', 'nodejs->valkey']);
  });

  it('puts the proving line on the edge', () => {
    // An edge without its evidence is decoration; this is the whole reason to derive them.
    const w = deriveWiring([req('nodejs', 'runtime'), req('valkey', 'dependency', 'ioredis')], [], 0);
    expect(w.edges[0]?.found).toBe('ioredis');
    expect(w.edges[0]?.path).toBe('package.json');
  });

  it('draws NO edges when the repo has no runtime', () => {
    // A library has dependencies and nothing that talks to them. Inventing a centre would be
    // drawing a relationship nobody claimed.
    const w = deriveWiring([req('postgresql', 'dependency')], [], 0);
    expect(w.runtime).toBeNull();
    expect(w.edges).toEqual([]);
    expect(w.note).toMatch(/No runtime/);
  });

  it('says nothing at all about an empty repo', () => {
    expect(deriveWiring([], [], 0).note).toBeNull();
  });

  it('marks whether the far end is actually deployed', () => {
    const w = deriveWiring(
      [req('nodejs', 'runtime'), req('postgresql', 'dependency'), req('qdrant', 'dependency')],
      [node('postgresql', 'PostgreSQL')], 0);
    expect(w.edges.find((e) => e.to === 'postgresql')?.deployed).toBe(true);
    expect(w.edges.find((e) => e.to === 'qdrant')?.deployed).toBe(false);
  });

  it('reports the gap between code and platform', () => {
    const w = deriveWiring([req('nodejs', 'runtime'), req('postgresql', 'dependency')], [], 0);
    expect(w.note).toMatch(/1 connection\(s\); Zerops has none/);
  });

  it('says nothing when the platform already matches', () => {
    const w = deriveWiring([req('nodejs', 'runtime'), req('postgresql', 'dependency')], [], 1);
    expect(w.note).toBeNull();
  });

  it('carries low confidence through to the edge', () => {
    const w = deriveWiring(
      [req('nodejs', 'runtime'), req('nats', 'dependency', 'NATS_URL', 'likely')], [], 0);
    expect(w.edges[0]?.confidence).toBe('likely');
  });
});
