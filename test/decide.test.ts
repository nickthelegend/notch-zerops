/**
 * The vote and the bounds.
 *
 * These two are the safety property of the whole swarm: an agent can say anything, and what
 * reaches the Zerops API has to be something a human would have signed off. So the tests here
 * are mostly adversarial — an agent that invents a verb, a panel that splits three ways, a
 * unanimous panel that wants forty containers.
 */
import { describe, expect, it } from 'vitest';

import { clamp, decide, parseProposal, rangeFor, type Proposal } from '../src/ops/decide.js';

const p = (lens: string, verb: Proposal['verb'], because = 'reason'): Proposal =>
  ({ agent: 'claude', lens, verb, because, confidence: 'medium', ms: 10 });

const BOUNDS = { floor: 1, ceiling: 4 };

describe('parseProposal', () => {
  it('reads the documented JSON shape', () => {
    const r = parseProposal('{"action":"scale_out","because":"p95 is 3s","confidence":"high"}');
    expect(r).toEqual({ verb: 'scale_out', because: 'p95 is 3s', confidence: 'high' });
  });

  it('digs the JSON out of prose and fences', () => {
    const r = parseProposal('Sure! Here you go:\n```json\n{"action":"hold","because":"quiet"}\n```\nHope that helps.');
    expect(r?.verb).toBe('hold');
  });

  it('accepts why/reason as aliases for because', () => {
    expect(parseProposal('{"verb":"scale_in","reason":"idle"}')?.because).toBe('idle');
  });

  it('normalises a verb written with a space or a dash', () => {
    expect(parseProposal('{"action":"scale out","because":"x"}')?.verb).toBe('scale_out');
    expect(parseProposal('{"action":"RAISE-CEILING","because":"x"}')?.verb).toBe('raise_ceiling');
  });

  it('refuses a verb nobody defined', () => {
    expect(parseProposal('{"action":"delete_database","because":"cheaper"}')).toBeNull();
    expect(parseProposal('{"action":"provision_gpu","because":"faster"}')).toBeNull();
  });

  it('falls back to a lone bare verb', () => {
    expect(parseProposal('I recommend scale_out here.')?.verb).toBe('scale_out');
  });

  it('refuses text that mentions two verbs, because that is genuinely ambiguous', () => {
    // Taking the first would invert this sentence's meaning.
    expect(parseProposal('scale_out would be wrong, so hold')).toBeNull();
  });

  it('refuses empty output', () => {
    expect(parseProposal('')).toBeNull();
    expect(parseProposal('   ')).toBeNull();
  });

  it('never returns an empty reason', () => {
    expect(parseProposal('{"action":"hold"}')?.because).toBe('No reason given.');
  });
});

describe('clamp', () => {
  it('holds the ceiling and says it did', () => {
    const r = clamp({ minContainers: 1, maxContainers: 40 }, BOUNDS);
    expect(r.range).toEqual({ minContainers: 1, maxContainers: 4 });
    expect(r.note).toContain('held at 4');
  });

  it('holds the floor and says it did', () => {
    const r = clamp({ minContainers: 0, maxContainers: 2 }, BOUNDS);
    expect(r.range.minContainers).toBe(1);
    expect(r.note).toContain('held at 1');
  });

  it('never lets min exceed max', () => {
    const r = clamp({ minContainers: 9, maxContainers: 2 }, BOUNDS);
    expect(r.range.minContainers).toBeLessThanOrEqual(r.range.maxContainers);
  });

  it('never returns zero containers even if the bounds are nonsense', () => {
    const r = clamp({ minContainers: 0, maxContainers: 0 }, { floor: 0, ceiling: 0 });
    expect(r.range.minContainers).toBeGreaterThanOrEqual(1);
  });

  it('survives a ceiling below the floor', () => {
    const r = clamp({ minContainers: 3, maxContainers: 3 }, { floor: 5, ceiling: 2 });
    expect(r.range.minContainers).toBeLessThanOrEqual(r.range.maxContainers);
    expect(r.range.minContainers).toBeGreaterThanOrEqual(1);
  });

  it('stays quiet when nothing had to be held', () => {
    expect(clamp({ minContainers: 1, maxContainers: 3 }, BOUNDS).note).toBeNull();
  });
});

describe('rangeFor', () => {
  const now = { minContainers: 1, maxContainers: 2 };
  it('scale_out raises the floor and drags the ceiling if it has to', () => {
    expect(rangeFor('scale_out', { minContainers: 2, maxContainers: 2 }))
      .toEqual({ minContainers: 3, maxContainers: 3 });
  });
  it('raise_ceiling touches only the maximum', () => {
    expect(rangeFor('raise_ceiling', now)).toEqual({ minContainers: 1, maxContainers: 3 });
  });
  it('hold means no range at all', () => {
    expect(rangeFor('hold', now)).toBeNull();
  });
});

describe('decide', () => {
  const now = { minContainers: 1, maxContainers: 2 };

  it('acts on a majority', () => {
    const d = decide([p('capacity', 'scale_out'), p('reliability', 'scale_out'), p('cost', 'hold')], now, BOUNDS);
    expect(d.verb).toBe('scale_out');
    expect(d.votes).toBe(2);
    expect(d.target).toEqual({ minContainers: 2, maxContainers: 2 });
  });

  it('holds a three-way split rather than letting one vote win', () => {
    const d = decide([p('capacity', 'scale_out'), p('cost', 'scale_in'), p('reliability', 'raise_ceiling')], now, BOUNDS);
    expect(d.verb).toBe('hold');
    expect(d.target).toBeNull();
    expect(d.rationale).toContain('split');
  });

  it('holds when nobody answered', () => {
    const d = decide([], now, BOUNDS);
    expect(d.verb).toBe('hold');
    expect(d.rationale).toContain('No agent answered');
  });

  it('holds on a two-two tie', () => {
    const d = decide(
      [p('a', 'scale_out'), p('b', 'scale_out'), p('c', 'hold'), p('d', 'hold')], now, BOUNDS);
    expect(d.verb).toBe('hold');
    expect(d.target).toBeNull();
  });

  it('reports the clamp when the panel wanted more than the ceiling', () => {
    const at = { minContainers: 4, maxContainers: 4 };
    const d = decide([p('a', 'scale_out'), p('b', 'scale_out'), p('c', 'scale_out')], at, BOUNDS);
    expect(d.target).toBeNull();
    expect(d.verb).toBe('hold');
    expect(d.rationale).toContain('no room to move');
  });

  it('will not scale below the floor', () => {
    const at = { minContainers: 1, maxContainers: 2 };
    const d = decide([p('a', 'scale_in'), p('b', 'scale_in'), p('c', 'scale_in')], at, BOUNDS);
    expect(d.target).toBeNull();
  });

  it('carries the winning agents’ reasoning into the rationale', () => {
    const d = decide(
      [p('capacity', 'scale_out', 'p95 hit 4s'), p('reliability', 'scale_out', 'one container is no redundancy'), p('cost', 'hold')],
      now, BOUNDS);
    expect(d.rationale).toContain('p95 hit 4s');
    expect(d.rationale).toContain('no redundancy');
  });

  it('keeps every proposal, including the losing ones', () => {
    const d = decide([p('a', 'scale_out'), p('b', 'scale_out'), p('c', 'scale_in', 'we are broke')], now, BOUNDS);
    expect(d.proposals).toHaveLength(3);
    expect(d.proposals.some((x) => x.because === 'we are broke')).toBe(true);
  });

  it('a unanimous hold is a hold, not a no-op accident', () => {
    const d = decide([p('a', 'hold'), p('b', 'hold'), p('c', 'hold')], now, BOUNDS);
    expect(d.verb).toBe('hold');
    expect(d.votes).toBe(3);
  });
});
