/**
 * The exported diagram has to PARSE, and it has to keep the gaps.
 *
 * A Mermaid block that fails to render shows GitHub's error box instead of your architecture,
 * which is worse than no diagram at all — so the id-escaping cases are tested directly rather
 * than trusted. And the missing services must survive the translation: a picture that quietly
 * dropped them would be a nicer diagram and a worse document.
 */
import { describe, expect, it } from 'vitest';

import { toMermaid } from '../src/zerops/mermaid.js';
import type { ArchNode } from '../src/zerops/graph.js';

const node = (over: Partial<ArchNode>): ArchNode => ({
  id: 'x', name: 'app', typeId: 'nodejs', typeName: 'Node.js', version: '24',
  kind: 'runtime', status: 'ACTIVE', containers: 1, ha: false, publicHttp: false,
  ports: [], system: false, position: { x: 0, y: 0 },
  ...over,
} as ArchNode);

const base = {
  projectName: 'acme',
  nodes: [node({ id: 'a', name: 'app', kind: 'runtime' })],
  missing: ['postgresql'],
  runtime: 'nodejs',
  edges: [{ to: 'postgresql', found: 'pg', confidence: 'strong', deployed: false }],
  repo: { name: 'acme-api', satisfied: 1, missing: 1 },
};

describe('toMermaid', () => {
  it('opens with a flowchart directive', () => {
    expect(toMermaid(base).split('\n').find((l) => !l.startsWith('%%'))).toBe('flowchart LR');
  });

  it('keeps missing services in the diagram', () => {
    const out = toMermaid(base);
    expect(out).toContain('postgresql');
    expect(out).toContain('missing');
  });

  it('draws an underived connection dashed and a deployed one solid', () => {
    const dashed = toMermaid(base);
    expect(dashed).toContain('-.->|"pg"|');
    const solid = toMermaid({
      ...base,
      missing: [],
      nodes: [node({ id: 'a', name: 'app' }), node({ id: 'b', name: 'db', typeName: 'PostgreSQL', kind: 'database' })],
      edges: [{ to: 'postgresql', found: 'pg', confidence: 'strong', deployed: true }],
    });
    expect(solid).toContain('-->|"pg"|');
    expect(solid).not.toContain('-.->|"pg"|');
  });

  it('escapes ids that would end a Mermaid token', () => {
    const out = toMermaid({
      ...base,
      projectName: 'acme prod-1.2',
      nodes: [node({ id: 'a', name: 'my app.v2', kind: 'runtime' })],
      missing: [],
      edges: [],
    });
    // Ids appear bare; none may contain a space, dot or dash.
    for (const line of out.split('\n')) {
      const m = /^\s{2,4}([A-Za-z0-9_]+)\[/.exec(line);
      if (m !== null) expect(m[1]).toMatch(/^[A-Za-z0-9_]+$/);
    }
    expect(out).not.toMatch(/^\s+my app\.v2\[/m);
  });

  it('never emits a bare quote inside a label', () => {
    const out = toMermaid({ ...base, nodes: [node({ name: 'the "main" app' })] });
    const labels = out.match(/\["([^"]*)"\]/g) ?? [];
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) expect(l.slice(2, -2)).not.toContain('"');
  });

  it('omits the repo node when nothing was scanned', () => {
    const out = toMermaid({ ...base, repo: null });
    expect(out).not.toContain('scanned');
  });

  it('does not draw a self-edge when the target resolves to the runtime', () => {
    const out = toMermaid({
      ...base, missing: [],
      edges: [{ to: 'nodejs', found: 'self', confidence: 'strong', deployed: true }],
    });
    expect(out).not.toContain('|"self"|');
  });

  /*
   * The case the first real export failed on. Edge labels are npm package names taken straight
   * from a package.json, so a scoped one is the common case — and unquoted, Mermaid reads the
   * `@` as the start of a link id and refuses the whole diagram.
   */
  it('quotes an edge label so a scoped package name cannot end the token', () => {
    const out = toMermaid({
      ...base,
      edges: [{ to: 'postgresql', found: '@aws-sdk/client-s3', confidence: 'strong', deployed: false }],
    });
    expect(out).toContain('|"@aws-sdk/client-s3"|');
    expect(out).not.toContain('|@aws-sdk/client-s3|');
  });

  it('produces a graph with no unbalanced brackets', () => {
    const out = toMermaid(base);
    expect((out.match(/\[/g) ?? []).length).toBe((out.match(/\]/g) ?? []).length);
  });
});
