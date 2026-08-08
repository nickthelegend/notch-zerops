/**
 * Integration tests against a real Zerops account.
 *
 * These make real API calls and really change infrastructure, so they are OPT-IN: without
 * `NOTCH_LIVE_TOKEN` in the environment the whole file skips. A test suite that silently
 * resizes somebody's production service because they ran `npm test` would be indefensible.
 *
 * WHAT THEY EXIST TO CATCH is the class of bug that unit tests structurally cannot see: an
 * endpoint that accepts a well-formed request, returns 200, runs a real process to completion,
 * and changes nothing. Two of those have now been found in this project — `envVariables` in
 * the service import file, and the unwrapped body on the autoscaling endpoint. Both looked
 * like success from every angle except reading the value back.
 *
 * Every test restores what it changed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ZeropsClient } from '../src/zerops/api.js';
import * as journal from '../src/zerops/journal.js';

const TOKEN = process.env['NOTCH_LIVE_TOKEN'] ?? '';
const PROJECT = process.env['NOTCH_LIVE_PROJECT'] ?? 'acme-notes-live';
const live = TOKEN === '' ? describe.skip : describe;

live('against the live Zerops account', () => {
  let client: ZeropsClient;
  let serviceId = '';
  let original: { minContainers: number | null; maxContainers: number | null } = {
    minContainers: null, maxContainers: null,
  };

  beforeAll(async () => {
    client = new ZeropsClient(TOKEN);
    const project = (await client.projects()).find((p) => p.name === PROJECT);
    if (project === undefined) throw new Error(`no project named ${PROJECT} on this account`);
    const svc = (await client.services(project.id)).find((s) => s.serviceStackTypeId === 'nodejs');
    if (svc === undefined) throw new Error('no nodejs service in that project');
    serviceId = svc.id;
    original = (await client.autoscaling(serviceId)).current;
  }, 120_000);

  afterAll(async () => {
    // Put it back however the tests left it. A test that leaves an account scaled up is a bill.
    if (serviceId !== '' && original.minContainers !== null && original.maxContainers !== null) {
      await client.setContainerRange(serviceId, original).catch(() => null);
    }
  }, 120_000);

  it('reads the real containers that are running', async () => {
    const list = await client.containers(serviceId);
    expect(list.length).toBeGreaterThan(0);
    for (const c of list) {
      expect(c.id).not.toBe('');
      expect(c.hostname).toContain('zerops');
    }
  }, 60_000);

  it('reads an autoscaling policy with real numbers in it', async () => {
    const a = await client.autoscaling(serviceId);
    expect(a.current.minContainers).toBeGreaterThanOrEqual(1);
    expect(a.current.maxContainers).toBeGreaterThanOrEqual(a.current.minContainers ?? 1);
  }, 60_000);

  /**
   * The one that matters.
   *
   * A change WITHIN the plan's limits must actually move the effective policy — not just
   * return 200. This is the test that would have caught the unwrapped-body bug, which passed
   * every other check in the project.
   */
  it('really changes the container range, and the change is visible afterwards', async () => {
    const before = (await client.autoscaling(serviceId)).current;
    const max = before.maxContainers ?? 2;
    // Move the floor up to the existing ceiling: guaranteed inside the plan, since the plan
    // already permits that many.
    const want = { minContainers: max, maxContainers: max };

    const { processId } = await client.setContainerRange(serviceId, want);
    expect(processId).not.toBeNull();

    let landed = false;
    for (let i = 0; i < 20 && !landed; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      const now = (await client.autoscaling(serviceId)).current;
      landed = now.minContainers === want.minContainers && now.maxContainers === want.maxContainers;
    }
    expect(landed, 'the range Notch asked for never became the effective range').toBe(true);

    // and back
    await client.setContainerRange(serviceId, { minContainers: before.minContainers, maxContainers: max });
  }, 180_000);

  /**
   * The silent refusal, pinned down as a test so it cannot quietly start passing.
   *
   * On a LIGHT plan, asking for more containers than the plan allows returns 200, produces a
   * process, and that process reaches FINISHED with the range untouched. If Zerops ever starts
   * returning an error here that would be an improvement — and this test failing is how we
   * would find out, rather than by shipping a message that says "the platform caps it silently"
   * long after it stopped doing so.
   */
  it('is accepted-but-ignored when the range exceeds the plan', async () => {
    const before = (await client.autoscaling(serviceId)).current;
    const beyond = (before.maxContainers ?? 2) + 1;

    const { processId } = await client.setContainerRange(serviceId, {
      minContainers: before.minContainers, maxContainers: beyond,
    });
    expect(processId, 'the API refused outright, which would be new behaviour').not.toBeNull();

    // Wait out the process, then confirm nothing moved.
    for (let i = 0; i < 12; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      const p = await client.processStatus(processId as string).catch(() => ({ status: 'UNKNOWN' }));
      if (p.status === 'FINISHED' || p.status === 'FAILED') break;
    }
    const after = (await client.autoscaling(serviceId)).current;
    expect(after.maxContainers).toBe(before.maxContainers);
  }, 180_000);

  it('recorded every one of those calls in the action log', () => {
    const writes = journal.all().filter((a) => a.write);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some((a) => a.path.endsWith('/autoscaling'))).toBe(true);
    expect(writes.every((a) => a.summary !== '')).toBe(true);
    // and nothing in the log can carry the token
    expect(JSON.stringify(journal.all())).not.toContain(TOKEN);
  });
});
