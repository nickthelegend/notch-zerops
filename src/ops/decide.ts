/**
 * What an agent is allowed to decide, and what happens when three of them disagree.
 *
 * The interesting claim this project makes is that an agent can hold an OPINION about
 * infrastructure — not fill in a template, but weigh a real signal and choose. The risk that
 * comes with that claim is obvious: an LLM handed a production account will eventually propose
 * something imaginative. Everything in this file exists to make the opinion real and the blast
 * radius small at the same time.
 *
 * THREE RULES.
 *
 *   1. CLOSED VOCABULARY. An agent picks from four verbs. It cannot invent `delete_database`,
 *      because there is nothing to parse it into — an unrecognised verb is discarded and
 *      recorded as discarded, never guessed at.
 *
 *   2. BOUNDS ARE APPLIED AFTER THE VOTE, NOT REQUESTED FROM THE AGENT. Asking a model to stay
 *      under a ceiling is a request. `clamp` is a guarantee, and it runs on the winning
 *      proposal regardless of what any agent said.
 *
 *   3. A TIE HOLDS. Doing nothing is always available and always safe; when the panel does not
 *      agree, that is information, and the correct response to it is to wait for a clearer
 *      signal rather than to break the tie with a coin.
 */

/** The four verbs. Anything else an agent says is not an action. */
export const VERBS = ['scale_out', 'scale_in', 'raise_ceiling', 'hold'] as const;
export type Verb = (typeof VERBS)[number];

export interface Proposal {
  agent: string;
  /** The lens this agent was asked to argue from. */
  lens: string;
  verb: Verb;
  /** Why, in the agent's own words. This is the output the demo is actually about. */
  because: string;
  /** How sure it is. Used only to order the reasoning on screen, never to break a tie. */
  confidence: 'high' | 'medium' | 'low';
  ms: number;
}

export interface Bounds {
  /** Never go below this many containers, whatever anyone argues. */
  floor: number;
  /** Never go above this many. The cost ceiling, and the one that matters. */
  ceiling: number;
}

export interface Decision {
  verb: Verb;
  /** How many agents wanted this. */
  votes: number;
  of: number;
  proposals: Proposal[];
  /** The container range this resolves to, already clamped. Null when nothing changes. */
  target: { minContainers: number; maxContainers: number } | null;
  /** Plain-English account of what was decided and why — including why it was NOT something. */
  rationale: string;
  /** Set when the bounds overrode what the panel wanted. Always surfaced, never silent. */
  clampNote: string | null;
}

/**
 * Read an agent's answer.
 *
 * Forgiving about shape, strict about vocabulary — the same stance the provisioning proposal
 * parser takes. Models wrap JSON in prose, in fences, in an apology; none of that is worth
 * failing over. What is worth failing over is a verb nobody defined.
 */
export function parseProposal(raw: string): { verb: Verb; because: string; confidence: Proposal['confidence'] } | null {
  const text = raw.trim();
  if (text === '') return null;

  // Prefer a JSON object if there is one anywhere in the output.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      const verb = String(o['action'] ?? o['verb'] ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
      if ((VERBS as readonly string[]).includes(verb)) {
        const because = String(o['because'] ?? o['why'] ?? o['reason'] ?? '').trim();
        const conf = String(o['confidence'] ?? 'medium').trim().toLowerCase();
        return {
          verb: verb as Verb,
          because: because === '' ? 'No reason given.' : because,
          confidence: conf === 'high' || conf === 'low' ? conf : 'medium',
        };
      }
    } catch { /* fall through to the bare-verb path */ }
  }

  /*
   * No usable JSON. Look for a verb on its own — but only ONE. Output that mentions two
   * different verbs ("scale_out would be wrong, so hold") is genuinely ambiguous, and picking
   * whichever appears first would invert that example's meaning.
   */
  const found = VERBS.filter((v) => new RegExp(`\\b${v}\\b`, 'i').test(text));
  if (found.length !== 1) return null;
  const verb = found[0] as Verb;
  return { verb, because: text.slice(0, 400), confidence: 'low' };
}

/** Keep a container range inside the bounds, and say so when it had to. */
export function clamp(
  want: { minContainers: number; maxContainers: number },
  bounds: Bounds,
): { range: { minContainers: number; maxContainers: number }; note: string | null } {
  const floor = Math.max(1, Math.floor(bounds.floor));
  const ceiling = Math.max(floor, Math.floor(bounds.ceiling));

  const max = Math.min(Math.max(Math.round(want.maxContainers), floor), ceiling);
  const min = Math.min(Math.max(Math.round(want.minContainers), floor), max);

  const notes: string[] = [];
  if (Math.round(want.maxContainers) > ceiling) {
    notes.push(`the panel wanted a ceiling of ${Math.round(want.maxContainers)}, held at ${ceiling}`);
  }
  if (Math.round(want.minContainers) < floor) {
    notes.push(`the panel wanted a floor of ${Math.round(want.minContainers)}, held at ${floor}`);
  }
  return { range: { minContainers: min, maxContainers: max }, note: notes.length === 0 ? null : notes.join('; ') };
}

/**
 * Turn a verb into the range it means, given where the service is now.
 *
 * `raise_ceiling` moves only the maximum — it gives the platform room to scale without forcing
 * it to, which is the cheap version of scale_out and usually the right first move.
 */
export function rangeFor(
  verb: Verb,
  now: { minContainers: number; maxContainers: number },
): { minContainers: number; maxContainers: number } | null {
  switch (verb) {
    case 'scale_out':
      return { minContainers: now.minContainers + 1, maxContainers: Math.max(now.maxContainers, now.minContainers + 1) };
    case 'scale_in':
      return { minContainers: now.minContainers - 1, maxContainers: now.maxContainers };
    case 'raise_ceiling':
      return { minContainers: now.minContainers, maxContainers: now.maxContainers + 1 };
    case 'hold':
      return null;
  }
}

/**
 * The vote.
 *
 * A strict majority is required to act. With three agents that means two must agree; with a
 * two-two split nothing happens. Deliberately not "most votes wins": on a panel of three where
 * every agent says something different, the plurality is one vote, and one agent's opinion is
 * not a mandate to resize somebody's production service.
 */
export function decide(
  proposals: readonly Proposal[],
  now: { minContainers: number; maxContainers: number },
  bounds: Bounds,
): Decision {
  const of = proposals.length;
  const tally = new Map<Verb, number>();
  for (const p of proposals) tally.set(p.verb, (tally.get(p.verb) ?? 0) + 1);

  let winner: Verb = 'hold';
  let votes = tally.get('hold') ?? 0;
  for (const [verb, n] of tally) {
    if (n > votes || (n === votes && verb === 'hold')) { winner = verb; votes = n; }
  }

  const majority = of === 0 ? 1 : Math.floor(of / 2) + 1;
  const reasons = proposals.filter((p) => p.verb === winner).map((p) => `${p.lens}: ${p.because}`);

  if (of === 0) {
    return {
      verb: 'hold', votes: 0, of: 0, proposals: [], target: null, clampNote: null,
      rationale: 'No agent answered, so nothing was changed. Holding is the only safe reading of silence.',
    };
  }

  if (votes < majority) {
    const split = [...tally.entries()].map(([v, n]) => `${n}×${v}`).join(', ');
    return {
      verb: 'hold', votes, of, proposals: [...proposals], target: null, clampNote: null,
      rationale: `The panel split (${split}) and no option reached ${majority} of ${of}. ` +
                 'A tie holds: disagreement is a reason to wait for a clearer signal, not to pick one.',
    };
  }

  const want = rangeFor(winner, now);
  if (want === null) {
    return {
      verb: 'hold', votes, of, proposals: [...proposals], target: null, clampNote: null,
      rationale: `${votes} of ${of} agents said hold. ${reasons[0] ?? ''}`.trim(),
    };
  }

  const { range, note } = clamp(want, bounds);
  const unchanged = range.minContainers === now.minContainers && range.maxContainers === now.maxContainers;

  return {
    verb: unchanged ? 'hold' : winner,
    votes, of, proposals: [...proposals],
    target: unchanged ? null : range,
    clampNote: note,
    rationale: unchanged
      ? `${votes} of ${of} agents said ${winner}, but the bounds leave no room to move ` +
        `(already ${now.minContainers}–${now.maxContainers}). Nothing changed.`
      : `${votes} of ${of} agents said ${winner}: ${range.minContainers}–${range.maxContainers} containers ` +
        `(was ${now.minContainers}–${now.maxContainers}). ${reasons.join(' · ')}`,
  };
}
