/**
 * "I'm building a chat app with search and analytics" → a service list, with an argument.
 *
 * The generator that turns a sentence into a YAML file is a template with extra steps: every
 * one of them picks Postgres and Redis because every example picks Postgres and Redis. What is
 * actually hard — and what a person building something genuinely wants — is the CHOICE between
 * four search engines that all say "full-text search" on the tin.
 *
 * So the output that matters here is not `chosen`. It is `rejected`: the services the agent
 * considered and turned down, each with the reason. A proposal that cannot say why it picked
 * Meilisearch over Typesense has not made a decision, it has produced a default.
 *
 * THE VOCABULARY IS THE LIVE CATALOGUE. Not a hardcoded list — the service types actually
 * available on the account, read from the API. An agent that proposes something Zerops does
 * not offer has its suggestion discarded and recorded as discarded, which is a fact worth
 * seeing rather than an error worth hiding.
 */
import { ask } from '../agents.js';

export interface Choice {
  /** A Zerops service type id, e.g. `postgresql`. Guaranteed to be in the vocabulary. */
  type: string;
  /** What it is for in THIS application, in the agent's words. */
  role: string;
  because: string;
}

export interface Rejection {
  type: string;
  /** Why this one lost. The interesting half of the output. */
  because: string;
}

export interface Design {
  chosen: Choice[];
  rejected: Rejection[];
  /** Anything the agent named that Zerops does not offer. Reported, never quietly dropped. */
  unavailable: string[];
  /** The agent's one-line reading of what is being built. Shown back so a wrong read is visible. */
  understanding: string;
  agent: string;
  ms: number;
}

export function instruction(description: string, vocabulary: readonly string[]): string {
  return [
    'A developer described what they are building. Choose the backing services it needs.',
    '',
    'WHAT THEY SAID:',
    description.trim(),
    '',
    'You may only choose from these Zerops service types:',
    vocabulary.join(', '),
    '',
    'Rules:',
    '  - Choose the smallest set that genuinely serves what they described. Not the biggest.',
    '  - Where several services could do the same job, pick one and say why the others lose.',
    '    Search in particular: meilisearch, typesense, elasticsearch and qdrant are not',
    '    interchangeable, and "it does search" is not a reason.',
    '  - Do not add a cache, a queue or analytics unless what they described needs one.',
    '  - A runtime is required: pick the one matching the language they mentioned, or nodejs',
    '    if they did not say.',
    '',
    'Answer with only this JSON:',
    '{',
    '  "understanding": "<one sentence: what you think they are building>",',
    '  "chosen": [{"type":"<service>","role":"<what it does here>","because":"<why this one>"}],',
    '  "rejected": [{"type":"<service you considered>","because":"<why it lost>"}]',
    '}',
  ].join('\n');
}

/**
 * Read the agent's answer.
 *
 * Strict about the vocabulary and forgiving about everything else. A model that returns a
 * fenced block, a preamble, or `chosen` as an array of bare strings has still answered the
 * question; a model that returns `dynamodb` has not, and that entry goes to `unavailable`
 * rather than being silently discarded or fuzzily matched to something Zerops does have.
 */
export function parseDesign(raw: string, vocabulary: readonly string[]): Omit<Design, 'agent' | 'ms'> {
  const allowed = new Set(vocabulary.map((v) => v.toLowerCase()));
  const empty = { chosen: [], rejected: [], unavailable: [], understanding: '' };

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return empty;

  let o: Record<string, unknown>;
  try { o = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>; }
  catch { return empty; }

  const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

  const chosen: Choice[] = [];
  const unavailable: string[] = [];
  const seen = new Set<string>();

  for (const item of Array.isArray(o['chosen']) ? o['chosen'] : []) {
    // Tolerate both {type,role,because} and a bare string.
    const rec = typeof item === 'string' ? { type: item } : (item as Record<string, unknown>);
    const type = norm(rec['type'] ?? rec['service'] ?? rec['name']);
    if (type === '') continue;
    if (!allowed.has(type)) { if (!unavailable.includes(type)) unavailable.push(type); continue; }
    if (seen.has(type)) continue;
    seen.add(type);
    chosen.push({
      type,
      role: String(rec['role'] ?? '').trim() || 'not stated',
      because: String(rec['because'] ?? rec['why'] ?? rec['reason'] ?? '').trim() || 'No reason given.',
    });
  }

  const rejected: Rejection[] = [];
  for (const item of Array.isArray(o['rejected']) ? o['rejected'] : []) {
    const rec = typeof item === 'string' ? { type: item } : (item as Record<string, unknown>);
    const type = norm(rec['type'] ?? rec['service'] ?? rec['name']);
    // A rejection of something Zerops does not have is noise, and a rejection of something
    // it also chose is a contradiction; neither belongs on screen.
    if (type === '' || !allowed.has(type) || seen.has(type)) continue;
    if (rejected.some((r) => r.type === type)) continue;
    rejected.push({
      type,
      because: String(rec['because'] ?? rec['why'] ?? rec['reason'] ?? '').trim() || 'No reason given.',
    });
  }

  return {
    chosen, rejected, unavailable,
    understanding: String(o['understanding'] ?? '').trim(),
  };
}

export async function design(
  agentId: string,
  description: string,
  vocabulary: readonly string[],
  cwd: string,
  timeoutMs = 120_000,
): Promise<Design> {
  const t0 = Date.now();
  const r = await ask(agentId, instruction(description, vocabulary), cwd, timeoutMs);
  return { ...parseDesign(r.reply, vocabulary), agent: r.agent, ms: Date.now() - t0 };
}
