/**
 * The Zerops REST client.
 *
 * Everything asserted here is a shape the live API actually demanded, discovered by getting a
 * 400 and reading it. The three that cost the most time are the three most worth pinning:
 * listing is a POST to `/search`, every client-scoped search must carry `clientId` as a
 * `{name, operator, value}` triple rather than a flat field, and the ONE search that must NOT
 * carry it is the global service catalogue.
 *
 * `ZeropsClient` takes its own `fetch`, so all of this runs with no network and no token. The
 * stub records what was sent, because for this class the request is the behaviour — a test
 * that only checked the parsed response would pass while sending a body Zerops rejects.
 */
import { describe, expect, it } from 'vitest';

import { ZeropsApiError, ZeropsClient, redactToken } from '../src/zerops/api.js';

interface Sent { url: string; method: string; body: unknown; headers: Record<string, string> }

/** A fetch that answers from a routing table and records every request. */
function stub(routes: Record<string, { status?: number; body: unknown }>) {
  const sent: Sent[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const path = u.replace(/^https?:\/\/[^/]+/, '').replace('/api/rest/public', '');
    sent.push({
      url: path,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const hit = routes[path];
    if (hit === undefined) {
      return new Response(JSON.stringify({ error: { message: `no stub for ${path}` } }), { status: 404 });
    }
    return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, sent };
}

const USER = {
  id: 'u1',
  email: 'someone@example.com',
  clientUserList: [{ clientId: 'CLIENT_1', roleCode: 'OWNER' }],
};

const client = (routes: Parameters<typeof stub>[0], token = 'tok_abcdefgh') => {
  const s = stub(routes);
  return { c: new ZeropsClient(token, 'https://api.example.test/api/rest/public', s.impl), sent: s.sent };
};

describe('redactToken', () => {
  it('keeps enough to recognise a token and not enough to use it', () => {
    expect(redactToken('abcdefghijklmnop')).toBe('abcd…mnop');
  });

  it('reveals nothing at all from a short string', () => {
    // A short "token" is probably a typo, and echoing 8 characters of a real secret to be
    // helpful about a typo is a bad trade.
    expect(redactToken('abc')).toBe('***');
    expect(redactToken('12345678')).toBe('***');
  });
});

describe('constructor', () => {
  it('refuses an empty token rather than making a doomed request', () => {
    expect(() => new ZeropsClient('   ')).toThrow(/empty token/);
  });
});

describe('search shape', () => {
  it('sends clientId as a search TRIPLE, not a flat field', async () => {
    // The flat form `{clientId: "..."}` returns "clientId not defined", which reads like a
    // missing field and sends you looking in entirely the wrong place.
    const { c, sent } = client({
      '/user/info': { body: USER },
      '/project/search': { body: { items: [] } },
    });
    await c.projects();

    const search = sent.find((s) => s.url === '/project/search');
    expect(search?.method).toBe('POST');
    expect(search?.body).toEqual({ search: [{ name: 'clientId', operator: 'eq', value: 'CLIENT_1' }] });
  });

  it('lists projects with POST, because GET /project is a 404', async () => {
    const { c, sent } = client({
      '/user/info': { body: USER },
      '/project/search': { body: { items: [{ id: 'p1', name: 'test', status: 'ACTIVE' }] } },
    });
    const got = await c.projects();
    expect(got).toHaveLength(1);
    expect(got[0]?.name).toBe('test');
    expect(sent.every((s) => s.url !== '/project')).toBe(true);
  });

  it('keeps clientId OFF the global service catalogue', async () => {
    // `/service-stack-type/search` has no client column at all: adding the term fails with
    // "unknown search column 'clientId' for index 'servicestacktype'". A blanket injection
    // broke exactly this call.
    const { c, sent } = client({
      '/service-stack-type/search': { body: { items: [] } },
    });
    await c.serviceTypes();

    const search = sent.find((s) => s.url === '/service-stack-type/search');
    expect(search?.body).toEqual({ search: [] });
    // And it must not have needed the account at all to get there.
    expect(sent.some((s) => s.url === '/user/info')).toBe(false);
  });

  it('still scopes a service search by project AND client', async () => {
    const { c, sent } = client({
      '/user/info': { body: USER },
      '/service-stack/search': { body: { items: [] } },
    });
    await c.services('proj_9');

    expect(sent.find((s) => s.url === '/service-stack/search')?.body).toEqual({
      search: [
        { name: 'clientId', operator: 'eq', value: 'CLIENT_1' },
        { name: 'projectId', operator: 'eq', value: 'proj_9' },
      ],
    });
  });

  it('treats a response with no items as an empty list, not a crash', async () => {
    const { c } = client({ '/user/info': { body: USER }, '/project/search': { body: {} } });
    await expect(c.projects()).resolves.toEqual([]);
  });
});

describe('clientId', () => {
  it('resolves once and caches it', async () => {
    const { c, sent } = client({
      '/user/info': { body: USER },
      '/project/search': { body: { items: [] } },
      '/service-stack/search': { body: { items: [] } },
    });
    await c.projects();
    await c.services('p');
    await c.clientId();

    expect(sent.filter((s) => s.url === '/user/info')).toHaveLength(1);
  });

  it('says what is wrong when the token has no account behind it', async () => {
    const { c } = client({ '/user/info': { body: { ...USER, clientUserList: [] } } });
    await expect(c.clientId()).rejects.toThrow(/no client account/);
  });
});

describe('errors', () => {
  it('surfaces the API message rather than the status line', async () => {
    const { c } = client({
      '/user/info': { status: 400, body: { error: { message: 'Invalid user input: clientId not defined' } } },
    });
    await expect(c.user()).rejects.toThrow(/clientId not defined/);
  });

  it('marks 401 and 403 as auth failures, and 400 as not one', async () => {
    const auth = client({ '/user/info': { status: 401, body: { error: { message: 'nope' } } } });
    await auth.c.user().catch((e: unknown) => {
      expect(ZeropsApiError.is(e)).toBe(true);
      expect((e as ZeropsApiError).isAuthFailure).toBe(true);
    });

    const bad = client({ '/user/info': { status: 400, body: { error: { message: 'nope' } } } });
    await bad.c.user().catch((e: unknown) => {
      expect((e as ZeropsApiError).isAuthFailure).toBe(false);
    });
  });

  it('does not pretend an HTML error page is JSON', async () => {
    const impl = (async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })) as unknown as typeof fetch;
    const c = new ZeropsClient('tok_abcdefgh', 'https://api.example.test/api/rest/public', impl);
    await expect(c.user()).rejects.toThrow(/response was not JSON/);
  });

  it('carries the endpoint, so a failure names where it happened', async () => {
    const { c } = client({ '/user/info': { status: 500, body: { error: { message: 'boom' } } } });
    await c.user().catch((e: unknown) => {
      expect((e as ZeropsApiError).endpoint).toBe('/user/info');
      expect((e as ZeropsApiError).status).toBe(500);
    });
  });
});

describe('verify', () => {
  it('reports the account it can actually see', async () => {
    const { c } = client({
      '/user/info': { body: USER },
      '/project/search': { body: { items: [{ id: 'p1', name: 'a', status: 'ACTIVE' }, { id: 'p2', name: 'b', status: 'ACTIVE' }] } },
    });
    const v = await c.verify();
    expect(v).toMatchObject({ ok: true, email: 'someone@example.com', clientId: 'CLIENT_1', projectCount: 2 });
    // Never the token itself, even on the success path.
    expect(v.ok && v.tokenHint).toBe('tok_…efgh');
  });

  it('gives an actionable sentence for a rejected token', async () => {
    const { c } = client({ '/user/info': { status: 401, body: { error: { message: 'Unauthorized' } } } });
    const v = await c.verify();
    expect(v).toMatchObject({ ok: false, isAuthFailure: true });
    expect(v.ok === false && v.reason).toMatch(/Generate a new one in the Zerops GUI/);
  });

  it('distinguishes an unreachable Zerops from a bad token', async () => {
    // This distinction is load-bearing: the server drops the credential on an auth failure and
    // keeps it on anything else. Confusing the two throws away working tokens on a blip.
    const { c } = client({ '/user/info': { status: 503, body: { error: { message: 'upstream down' } } } });
    const v = await c.verify();
    expect(v).toMatchObject({ ok: false, isAuthFailure: false });
    expect(v.ok === false && v.reason).toMatch(/upstream down/);
  });

  it('does not throw when fetch itself rejects', async () => {
    const impl = (async () => { throw new TypeError('network down'); }) as unknown as typeof fetch;
    const c = new ZeropsClient('tok_abcdefgh', 'https://api.example.test/api/rest/public', impl);
    await expect(c.verify()).resolves.toMatchObject({ ok: false, isAuthFailure: false });
  });
});

describe('serviceTypes', () => {
  it('flattens the version list and drops entries with no id', async () => {
    const { c } = client({
      '/service-stack-type/search': {
        body: {
          items: [
            { id: 'postgresql', name: 'PostgreSQL', serviceStackTypeVersionList: [{ name: 'postgresql:single@16' }, { name: 'postgresql:ha@16' }] },
            { name: 'no id at all', serviceStackTypeVersionList: [] },
          ],
        },
      },
    });
    const got = await c.serviceTypes();
    expect(got).toEqual([{ typeId: 'postgresql', name: 'PostgreSQL', versions: ['postgresql:single@16', 'postgresql:ha@16'] }]);
  });
});

describe('writes', () => {
  it('imports to the per-project route, not the project-creating decoy', async () => {
    // `PUT /project/import` CREATES a project and answers "Project not found" whatever you
    // send it. The route that adds services to an existing project is this one.
    const { c, sent } = client({ '/project/p%201/service-stack/import': { body: { ok: true } } });
    await c.importServices('p 1', 'services:\n');

    const req = sent[0];
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe('/project/p%201/service-stack/import');
    expect(req?.body).toEqual({ yaml: 'services:\n' });
  });

  it('deletes one service by id, url-encoded', async () => {
    const { c, sent } = client({ '/service-stack/a%2Fb': { body: {} } });
    await c.deleteService('a/b');
    expect(sent[0]).toMatchObject({ method: 'DELETE', url: '/service-stack/a%2Fb' });
  });

  it('sends the bearer token and asks for JSON', async () => {
    const { c, sent } = client({ '/user/info': { body: USER } });
    await c.user();
    expect(sent[0]?.headers['authorization']).toBe('Bearer tok_abcdefgh');
    expect(sent[0]?.headers['accept']).toBe('application/json');
  });

  it('sets no content-type on a bodyless request', async () => {
    const { c, sent } = client({ '/user/info': { body: USER } });
    await c.user();
    expect(sent[0]?.headers['content-type']).toBeUndefined();
  });
});
