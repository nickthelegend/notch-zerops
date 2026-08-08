/**
 * The boundary where an agent's output meets the planner.
 *
 * This is the only place in the app where a language model's text influences what gets built
 * on somebody's account, so it is forgiving about SHAPE — models wrap JSON in fences and
 * preamble however firmly you ask them not to — and completely unforgiving about CONTENT. A
 * type that is not in the vocabulary must never reach the planner, however plausible it looks.
 */
import { describe, expect, it } from 'vitest';

import { parseProposal, proposeInstruction, brief } from '../src/agents.js';
import { SERVICE_TYPES } from '../src/repo/scan.js';

const VOCAB = SERVICE_TYPES;

describe('parseProposal', () => {
  it('reads a clean proposal', () => {
    const p = parseProposal('{"services":[{"type":"postgresql","why":"pg is imported"}]}', VOCAB);
    expect(p.types).toEqual(['postgresql']);
    expect(p.why['postgresql']).toBe('pg is imported');
  });

  it('digs the JSON out of prose and fences', () => {
    // What models actually do, regardless of instructions.
    const text = 'Sure! Here is the proposal:\n```json\n{"services":[{"type":"valkey","why":"ioredis"}]}\n```\nHope that helps.';
    expect(parseProposal(text, VOCAB).types).toEqual(['valkey']);
  });

  it('DISCARDS a type outside the vocabulary and reports it', () => {
    // The load-bearing test. `mongodb` is a real database and not a Zerops service type; if it
    // reached the planner it would become a request the platform rejects, or worse.
    const p = parseProposal('{"services":[{"type":"mongodb"},{"type":"postgresql"}]}', VOCAB);
    expect(p.types).toEqual(['postgresql']);
    expect(p.rejected).toEqual(['mongodb']);
  });

  it('never lets an injected instruction become a type', () => {
    const p = parseProposal('{"services":[{"type":"postgresql; DROP TABLE brain_events"}]}', VOCAB);
    expect(p.types).toEqual([]);
    expect(p.rejected).toHaveLength(1);
  });

  it('accepts an empty list as a real answer', () => {
    const p = parseProposal('{"services":[]}', VOCAB);
    expect(p.types).toEqual([]);
    expect(p.rejected).toEqual([]);
  });

  it('normalises case and drops duplicates', () => {
    const p = parseProposal('{"services":[{"type":"PostgreSQL"},{"type":"postgresql"}]}', VOCAB);
    expect(p.types).toEqual(['postgresql']);
  });

  it('throws a NAMED error when there is no JSON at all', () => {
    expect(() => parseProposal('I think you should add Postgres.', VOCAB))
      .toThrow(/did not reply with a proposal/);
  });

  it('throws when the JSON is malformed rather than guessing', () => {
    expect(() => parseProposal('{"services":[{"type":]}', VOCAB)).toThrow(/not valid JSON/);
  });

  it('throws when there is no services list', () => {
    expect(() => parseProposal('{"answer":"postgresql"}', VOCAB)).toThrow(/no `services` list/);
  });

  it('survives a null or non-object entry', () => {
    const p = parseProposal('{"services":[null,{"type":"nats"},42]}', VOCAB);
    expect(p.types).toEqual(['nats']);
  });
});

describe('proposeInstruction', () => {
  it('states the closed vocabulary, so the agent is not guessing at it', () => {
    const s = proposeInstruction(VOCAB);
    expect(s).toContain('postgresql');
    expect(s).toContain('discarded');
  });
});

describe('brief', () => {
  const base = {
    projectName: 'prod', projectStatus: 'ACTIVE',
    services: [{ name: 'db', type: 'PostgreSQL', status: 'ACTIVE' }],
    missing: [{ type: 'valkey', why: 'ioredis is imported', evidence: ['ioredis in package.json'] }],
    satisfied: ['postgresql'], dir: '/repo', scanned: ['package.json'],
  };

  it('carries the evidence, not just the finding', () => {
    // An agent asked "why" should answer from the same line the UI shows, not from what a repo
    // like this usually needs.
    expect(brief(base)).toContain('ioredis in package.json');
  });

  it('tells the agent it cannot act', () => {
    expect(brief(base)).toContain('cannot change anything');
  });

  it('forbids inventing services', () => {
    expect(brief(base)).toMatch(/Never invent a service/);
  });

  it('says so plainly when a project is empty', () => {
    expect(brief({ ...base, services: [] })).toContain('the project is empty');
  });
});
