/**
 * A panel of agents that argues about your infrastructure and then changes it.
 *
 * This is the part of Notch that is not a linter. Everywhere else the app reads your code and
 * reports a fact; here it watches a live service under real load, asks several agents what to
 * do about it, and — when they agree and you have armed it — makes the call to Zerops that
 * resizes the thing.
 *
 * WHY A PANEL AND NOT ONE AGENT. Scaling is a trade, not a calculation. More containers is
 * better availability and a bigger bill; fewer is cheaper and closer to the edge. A single
 * model asked "should I scale?" optimises whichever side of that trade its prompt happened to
 * emphasise, and does it invisibly. Three agents each given ONE side to argue produces the
 * trade explicitly: you can read the capacity argument, the cost argument and the reliability
 * argument, and see which one won. That transcript is the actual product.
 *
 * WHY IT IS DISARMED BY DEFAULT. Because it spends money. An armed swarm left running against
 * a real account is a standing instruction to a language model to buy compute. Disarmed, it
 * does every part of the work — observes, argues, decides, writes down what it WOULD do — and
 * stops at the last step. Arming it is a deliberate act with a hard ceiling attached.
 */
import { ask } from '../agents.js';
import type { ZeropsClient } from '../zerops/api.js';
import { observe, type Signals } from './signals.js';
import { decide, parseProposal, VERBS, type Bounds, type Decision, type Proposal } from './decide.js';

/**
 * The lenses.
 *
 * Each agent is told to argue ONE side honestly, not to be balanced. Balance is what the vote
 * is for; an agent asked to weigh everything produces the same hedged paragraph every time and
 * the panel becomes three copies of one opinion.
 */
export const LENSES: ReadonlyArray<{ id: string; brief: string }> = [
  {
    id: 'capacity',
    brief: 'You care about whether the service can serve the traffic it is getting. ' +
           'Slow responses and failed requests are your problem. You are not responsible for the bill.',
  },
  {
    id: 'cost',
    brief: 'You care about not paying for containers that are doing nothing. ' +
           'Idle capacity is your problem. Someone else is arguing for headroom; you do not have to.',
  },
  {
    id: 'reliability',
    brief: 'You care about surviving the failure of a single container, and about not thrashing. ' +
           'A service on one container has no redundancy. Frequent resizing is itself a risk.',
  },
];

export interface CycleOptions {
  service: { id: string; name: string };
  url: string | null;
  bounds: Bounds;
  /** Which agent CLIs to use, one per lens. Cycled if fewer agents than lenses. */
  agents: readonly string[];
  cwd: string;
  /** Nothing is applied unless this is true. */
  armed: boolean;
  load?: { count?: number; concurrency?: number };
  timeoutMs?: number;
}

export interface Cycle {
  startedAt: string;
  signals: Signals;
  decision: Decision;
  /** What actually happened at Zerops. Null when disarmed or when the decision was to hold. */
  applied: {
    processId: string | null;
    from: { minContainers: number | null; maxContainers: number | null };
    to: { minContainers: number; maxContainers: number };
    verified: boolean;
    note: string;
  } | null;
  /** Agents that answered with something unusable. Recorded, never guessed at. */
  discarded: Array<{ agent: string; lens: string; reason: string }>;
  ms: number;
}

/** The prompt one agent sees. Numbers only — no interpretation, that is its job. */
export function promptFor(lens: { id: string; brief: string }, s: Signals, bounds: Bounds): string {
  const n = (v: number | null, unit = ''): string => (v === null ? 'not measured' : `${Math.round(v)}${unit}`);
  const pct = (v: number | null): string => (v === null ? 'not measured' : `${Math.round(v * 100)}%`);

  return [
    `You are one of three advisors deciding whether to resize a running service on Zerops.`,
    `Your lens: ${lens.brief}`,
    '',
    `SERVICE: ${s.service.name}`,
    `Containers running now: ${s.containers.active} active of ${s.containers.total}`,
    `Allowed range right now: ${s.policy.minContainers ?? '?'} to ${s.policy.maxContainers ?? '?'} containers`,
    `Hard limits you cannot exceed: ${bounds.floor} to ${bounds.ceiling} containers`,
    '',
    'MEASURED LOAD' + (s.load.url === null ? ' — none, this service has no public URL' : ''),
    `  requests sent: ${s.load.samples}`,
    `  median response: ${n(s.load.p50, 'ms')}`,
    `  95th percentile: ${n(s.load.p95, 'ms')}`,
    `  slowest: ${n(s.load.slowest, 'ms')}`,
    `  failed: ${pct(s.load.errorRate)}`,
    `  throughput: ${s.load.throughput === null ? 'not measured' : `${s.load.throughput.toFixed(1)}/s`}`,
    ...(s.notes.length === 0 ? [] : ['', 'NOTES', ...s.notes.map((x) => `  ${x}`)]),
    '',
    `Choose exactly one action from this list and nothing else: ${VERBS.join(', ')}.`,
    '  scale_out     — run one more container from now on',
    '  scale_in      — run one fewer',
    '  raise_ceiling — allow one more, without requiring it',
    '  hold          — change nothing',
    '',
    'A number that says "not measured" is genuinely unknown. Do not assume it is fine.',
    'Answer with only this JSON, no prose around it:',
    '{"action":"<one of the four>","because":"<one sentence, plain English>","confidence":"high|medium|low"}',
  ].join('\n');
}

/**
 * One full observe → argue → decide → (apply) → verify cycle.
 *
 * Agents run CONCURRENTLY and against the same snapshot. Sequentially they would each see a
 * slightly different world and the disagreement would partly be about time rather than about
 * judgement, which would make the transcript a lie.
 */
export async function cycle(client: ZeropsClient, opts: CycleOptions): Promise<Cycle> {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();

  const signals = await observe(client, opts.service, opts.url, opts.load ?? {});

  const discarded: Cycle['discarded'] = [];

  /*
   * Each lens gets a seat, and the seat is filled by whichever agent can actually fill it.
   *
   * The first version handed lens i to agent i and stopped. On this machine OpenCode exits 1
   * without a word, so the reliability seat was always empty — and a panel of two can only act
   * when it is unanimous, which quietly made the swarm far more conservative than designed.
   * A failed agent now falls through to the next one that is installed, so a broken CLI costs
   * a few seconds rather than a whole perspective.
   *
   * The rotation offset keeps the lenses on DIFFERENT agents where possible. Three seats filled
   * by the same model is one opinion asked three times, and the disagreement is the product.
   */
  const results = await Promise.all(LENSES.map(async (lens, i): Promise<Proposal | null> => {
    const pool = opts.agents.length === 0 ? [] :
      Array.from({ length: opts.agents.length }, (_, k) => opts.agents[(i + k) % opts.agents.length] as string);

    for (const agent of pool) {
      const at = Date.now();
      try {
        const r = await ask(agent, promptFor(lens, signals, opts.bounds), opts.cwd, opts.timeoutMs ?? 90_000);
        const parsed = parseProposal(r.reply);
        if (parsed === null) {
          discarded.push({ agent, lens: lens.id, reason: 'answered with no recognisable action' });
          continue;
        }
        return { agent, lens: lens.id, verb: parsed.verb, because: parsed.because, confidence: parsed.confidence, ms: Date.now() - at };
      } catch (e) {
        discarded.push({ agent, lens: lens.id, reason: (e as Error).message });
      }
    }
    return null;
  }));

  const proposals = results.filter((p): p is Proposal => p !== null);

  /*
   * The vote is taken against the EFFECTIVE range, with a fallback of 1–1.
   *
   * A service whose policy could not be read has an unknown range, and treating unknown as
   * "whatever the agents want" would let a failed GET authorise a resize.
   */
  const now = {
    minContainers: signals.policy.minContainers ?? 1,
    maxContainers: signals.policy.maxContainers ?? 1,
  };
  const decision = decide(proposals, now, opts.bounds);

  let applied: Cycle['applied'] = null;
  if (decision.target !== null) {
    if (!opts.armed) {
      applied = null;
    } else {
      const { processId } = await client.setContainerRange(opts.service.id, decision.target);
      /*
       * The PUT schedules the change; it does not perform it. Reading the service back straight
       * away returns the OLD values and would look like a silent failure, so the confirmation
       * waits for the platform to catch up — and distinguishes three genuinely different
       * outcomes rather than reporting "done" and hoping.
       */
      const outcome = await settled(client, opts.service.id, decision.target, processId);
      applied = {
        processId,
        from: signals.policy,
        to: decision.target,
        verified: outcome === 'applied',
        note: NOTE[outcome](decision.target),
      };
    }
  }

  return { startedAt, signals, decision, applied, discarded, ms: Date.now() - t0 };
}

export type Outcome = 'applied' | 'refused' | 'pending';

const NOTE: Record<Outcome, (t: { minContainers: number; maxContainers: number }) => string> = {
  applied: (t) => `Zerops now allows ${t.minContainers}–${t.maxContainers} containers.`,
  refused: (t) =>
    `Zerops accepted the change, ran it to completion, and left the range where it was. ` +
    `${t.minContainers}–${t.maxContainers} is beyond what this project's plan permits — ` +
    `the platform caps it silently rather than returning an error.`,
  pending: () =>
    'Zerops accepted the change but had not applied it yet when Notch stopped waiting. ' +
    'The process id is recorded; the range may still land.',
};

/**
 * Did it actually happen?
 *
 * Three outcomes, and telling them apart is the whole point. A 200 from the autoscaling
 * endpoint means the request was well-formed, nothing more — this was found the hard way:
 * asking for 2–3 containers on a LIGHT plan returns 200, creates a process, runs that process
 * to FINISHED, and leaves the range at 2–2. No error anywhere. A tool that reported that as
 * success would be lying in the most damaging possible place, because the next thing the user
 * does is stop worrying about capacity.
 *
 * So: if the value matches, it applied. If the platform says the operation FINISHED and the
 * value still has not moved, it was refused — say so, and say why it probably was. Only if the
 * process is genuinely still running do we report that we stopped waiting.
 */
async function settled(
  client: ZeropsClient,
  serviceId: string,
  want: { minContainers: number; maxContainers: number },
  processId: string | null,
  attempts = 16,
): Promise<Outcome> {
  let finished = false;
  for (let i = 0; i < attempts; i += 1) {
    // A real downward change landed in ~6s; the window is generous rather than tight.
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const a = await client.autoscaling(serviceId);
      if (a.current.minContainers === want.minContainers && a.current.maxContainers === want.maxContainers) {
        return 'applied';
      }
    } catch { /* transient; keep waiting */ }

    if (processId !== null && !finished) {
      try {
        const p = await client.processStatus(processId);
        // Give the platform two more polls after it claims to be done before calling it refused
        // — "FINISHED" and "visible on the read model" are not quite the same instant.
        if (p.status === 'FINISHED' || p.status === 'FAILED') finished = true;
      } catch { /* keep waiting */ }
    } else if (finished) {
      return 'refused';
    }
  }
  return finished ? 'refused' : 'pending';
}
