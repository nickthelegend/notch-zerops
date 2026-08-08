/**
 * What the infrastructure is actually doing, measured rather than assumed.
 *
 * The whole swarm rests on this file being honest. An agent handed invented numbers will
 * produce confident, well-reasoned, completely fictional scaling decisions — and they will
 * look exactly like good ones in a demo. So every field here comes from either a real HTTP
 * request to the deployed application or a real read from the Zerops API, and anything that
 * could not be measured is `null` rather than a default.
 *
 * NULL IS A LOAD-BEARING VALUE HERE. A service with no public URL has no latency, and zero is
 * a lie that reads as "extremely fast". The agents are told explicitly when a number is
 * missing, because "I could not see the latency" is a legitimate reason to refuse to act.
 */
import type { ZeropsClient } from '../zerops/api.js';

export interface Probe {
  status: number;
  ms: number;
}

export interface Signals {
  takenAt: string;
  service: { id: string; name: string };
  /** What is running right now, from the platform. */
  containers: { total: number; active: number };
  /** What the platform currently ALLOWS. */
  policy: { minContainers: number | null; maxContainers: number | null };
  /** Measured against the live URL. Null when there is no URL to measure. */
  load: {
    url: string | null;
    samples: number;
    p50: number | null;
    p95: number | null;
    slowest: number | null;
    errorRate: number | null;
    /** Successful responses per second, across the whole burst. */
    throughput: number | null;
  };
  /** Anything that stopped a measurement from happening. Never silently dropped. */
  notes: string[];
}

/** The nth percentile of a sorted-on-the-way-in sample, nearest-rank. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? null;
}

/**
 * Hit the URL `count` times with `concurrency` in flight and time every response.
 *
 * This is a real load generator, deliberately small. It exists so the signal MOVES during a
 * demo — a scaling agent that never sees load never makes a decision, and waiting for organic
 * traffic to a hackathon app is waiting forever. Bounded hard: a runaway loop here would be
 * pointed at somebody's live service.
 */
export async function burst(
  url: string,
  opts: { count?: number; concurrency?: number; timeoutMs?: number } = {},
): Promise<Probe[]> {
  const count = Math.min(Math.max(opts.count ?? 20, 1), 500);
  const concurrency = Math.min(Math.max(opts.concurrency ?? 5, 1), 50);
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const out: Probe[] = [];
  let issued = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (issued >= count) return;
      issued += 1;
      const t0 = Date.now();
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
        // Drain the body: without this the timing measures headers, not the response.
        await r.arrayBuffer();
        out.push({ status: r.status, ms: Date.now() - t0 });
      } catch {
        // 0 means "never answered" — a timeout and a refused connection are both total
        // failures from a user's point of view, and both belong in the error rate.
        out.push({ status: 0, ms: Date.now() - t0 });
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}

/** Turn raw probes into the summary the agents reason over. */
export function summarise(probes: readonly Probe[], wallMs: number): Signals['load'] {
  const ok = probes.filter((p) => p.status >= 200 && p.status < 400);
  const times = ok.map((p) => p.ms);
  return {
    url: null,
    samples: probes.length,
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    slowest: times.length === 0 ? null : Math.max(...times),
    errorRate: probes.length === 0 ? null : (probes.length - ok.length) / probes.length,
    throughput: wallMs <= 0 ? null : (ok.length / wallMs) * 1000,
  };
}

/**
 * One full observation: what is running, what is allowed, and how it is coping.
 *
 * The Zerops reads happen even when there is no URL to probe, because "how many containers are
 * up" is worth knowing on its own and a missing URL should not blind the whole cycle.
 */
export async function observe(
  client: ZeropsClient,
  service: { id: string; name: string },
  url: string | null,
  opts: { count?: number; concurrency?: number } = {},
): Promise<Signals> {
  const notes: string[] = [];

  let containers = { total: 0, active: 0 };
  try {
    const list = await client.containers(service.id);
    containers = { total: list.length, active: list.filter((c) => c.status === 'ACTIVE').length };
  } catch (e) {
    notes.push(`Could not read containers: ${(e as Error).message}`);
  }

  let policy: Signals['policy'] = { minContainers: null, maxContainers: null };
  try {
    policy = (await client.autoscaling(service.id)).current;
  } catch (e) {
    notes.push(`Could not read the autoscaling policy: ${(e as Error).message}`);
  }

  let load: Signals['load'] = {
    url: null, samples: 0, p50: null, p95: null, slowest: null, errorRate: null, throughput: null,
  };
  if (url === null || url === '') {
    notes.push('This service has no public URL, so no latency was measured. ' +
               'Scaling decisions here rest on container state alone.');
  } else {
    const t0 = Date.now();
    const probes = await burst(url, opts);
    load = { ...summarise(probes, Date.now() - t0), url };
    if (load.errorRate === 1) {
      notes.push(`Every one of the ${probes.length} requests failed. That is an outage, not load.`);
    }
  }

  return { takenAt: new Date().toISOString(), service, containers, policy, load, notes };
}
