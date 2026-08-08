/**
 * The Zerops REST API, typed against what it actually returned rather than what a doc page
 * implied. Every shape here was read off a live response from a real account.
 *
 * THREE THINGS THE API DOES THAT YOU WOULD NOT GUESS, each found by getting a 400:
 *
 *   1. `GET /project` is 404. Listing is a POST to `/project/search`.
 *   2. Every search needs `clientId` -- including searches that already name a `projectId`,
 *      which uniquely determines the client. Omitting it is
 *      `Invalid user input: clientId not defined`.
 *   3. The filter is not `{clientId: "..."}`. It is a `search` array of
 *      `{name, operator, value}` triples. The flat form returns the same "clientId not
 *      defined" error, which reads like a missing field rather than a wrong shape and sends
 *      you looking in the wrong place.
 *
 * THE TOKEN. A Zerops Personal Access Token is account-level: it can manage every project the
 * account owns, not just one. It is read from the environment, never written to disk by this
 * code, and `redactToken` exists so it cannot reach a log line by accident.
 */
import { z } from 'zod';

export const ZEROPS_API_BASE = 'https://api.app-prg1.zerops.io/api/rest/public';

/** The Zerops API refused us. Carries the status so callers can tell auth from a bad shape. */
export class ZeropsApiError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    readonly apiMessage: string,
  ) {
    super(`Zerops API ${status} on ${endpoint}: ${apiMessage}`);
    this.name = 'ZeropsApiError';
  }

  /** The token is missing, wrong, or revoked -- distinct from a malformed request. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }

  static is(err: unknown): err is ZeropsApiError {
    return err instanceof ZeropsApiError || (err instanceof Error && err.name === 'ZeropsApiError');
  }
}

/** Never let a PAT reach a log, an error message, or the UI. */
export function redactToken(t: string): string {
  if (t.length <= 8) return '***';
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

/* -------------------------------------------------------------------------- */
/* Response shapes, parsed at the boundary                                     */
/* -------------------------------------------------------------------------- */

/**
 * Deliberately `.passthrough()`-shaped: we validate the fields we rely on and let the rest
 * through untouched. Zerops adds fields; a strict schema would turn every platform release
 * into an outage here, and we would learn nothing useful from rejecting a payload that
 * contains everything we asked for plus something new.
 */
export const ZUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string().optional(),
  clientUserList: z.array(z.object({
    clientId: z.string(),
    roleCode: z.string().optional(),
  })).default([]),
}).loose();
export type ZUser = z.infer<typeof ZUserSchema>;

/**
 * A project environment variable, reduced to what we are willing to hold.
 *
 * `content` IS in the API response and is deliberately not in this schema. Zod strips what it
 * does not describe, so the value is dropped at the boundary and cannot reach a log, the UI, a
 * timeline payload, or an agent prompt by accident. Everything this app does with environment
 * variables — comparing environments, spotting a key the repo needs and the project lacks —
 * needs the NAME and nothing else.
 */
export const ZEnvSchema = z.object({
  key: z.string(),
  sensitive: z.boolean().optional(),
  /** `SYSTEM` for the ones Zerops injects, otherwise user-set. */
  type: z.string().optional(),
});
export type ZEnv = z.infer<typeof ZEnvSchema>;

export const ZProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  clientId: z.string().optional(),
  description: z.string().nullable().optional(),
  envList: z.array(ZEnvSchema).default([]),
}).loose();
export type ZProject = z.infer<typeof ZProjectSchema>;

export const ZPortSchema = z.object({
  port: z.number(),
  protocol: z.string().optional(),
  scheme: z.string().nullable().optional(),
  httpRouting: z.boolean().optional(),
  portRouting: z.boolean().optional(),
}).loose();

export const ZServiceSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  projectId: z.string(),
  serviceStackTypeId: z.string(),
  /** `single` | `HA` | null. Null while a service has never been deployed. */
  mode: z.string().nullable().optional(),
  envList: z.array(ZEnvSchema).default([]),
  isSystem: z.boolean().optional(),
  ports: z.array(ZPortSchema).default([]),
  /** Ids of services this one is wired to. The edges of the architecture graph. */
  connectedStacks: z.array(z.unknown()).default([]),
  hasPublicHttpRoutingAccess: z.boolean().optional(),
  subdomainAccess: z.boolean().optional(),
  serviceStackTypeInfo: z.object({
    serviceStackTypeName: z.string().optional(),
    serviceStackTypeCategory: z.string().optional(),
    /** The internal version string, e.g. `valkey:single@7.2` or `alpine/nodejs@24`. */
    serviceStackTypeVersionName: z.string().optional(),
  }).loose().optional(),
  coreService: z.object({
    currentActiveContainerCount: z.number().nullable().optional(),
  }).loose().nullable().optional(),
  currentAutoscaling: z.object({
    horizontalAutoscaling: z.unknown().nullable().optional(),
    verticalAutoscaling: z.unknown().nullable().optional(),
  }).loose().nullable().optional(),
}).loose();
export type ZService = z.infer<typeof ZServiceSchema>;

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

export interface SearchTerm {
  name: string;
  operator: 'eq' | 'ne' | 'like';
  value: string;
}

export class ZeropsClient {
  private cachedClientId: string | null = null;

  constructor(
    private readonly token: string,
    private readonly base: string = ZEROPS_API_BASE,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (token.trim() === '') throw new Error('ZeropsClient: empty token');
  }

  /** For display. Never the token itself. */
  get tokenHint(): string {
    return redactToken(this.token);
  }

  private async call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text === '' ? {} : JSON.parse(text);
    } catch {
      throw new ZeropsApiError(res.status, path, `response was not JSON: ${text.slice(0, 120)}`);
    }

    if (!res.ok) {
      const msg =
        (parsed as { error?: { message?: string } }).error?.message ??
        `${res.statusText || 'request failed'}`;
      throw new ZeropsApiError(res.status, path, msg);
    }
    return parsed as T;
  }

  /**
   * The `search` array shape, which is the whole trick.
   *
   * `clientId` is injected by default, because forgetting it on a client-scoped index is the
   * most common way to get a 400 that names the wrong problem. But it is NOT universal, and
   * injecting it blindly is its own bug: `/service-stack-type/search` is a global catalogue
   * with no client column at all, and adding the term there fails with
   * "unknown search column 'clientId' for index 'servicestacktype'". Hence the opt-out.
   */
  private async search<T>(path: string, terms: SearchTerm[], opts: { clientScoped?: boolean } = {}): Promise<T[]> {
    const clientScoped = opts.clientScoped ?? true;
    let finalTerms = terms;
    if (clientScoped && !terms.some((t) => t.name === 'clientId')) {
      finalTerms = [{ name: 'clientId', operator: 'eq', value: await this.clientId() }, ...terms];
    }
    const res = await this.call<{ items?: T[] }>('POST', path, { search: finalTerms });
    return res.items ?? [];
  }

  async user(): Promise<ZUser> {
    return ZUserSchema.parse(await this.call('GET', '/user/info'));
  }

  /** The account this token belongs to. Resolved once; every search needs it. */
  async clientId(): Promise<string> {
    if (this.cachedClientId !== null) return this.cachedClientId;
    const u = await this.user();
    const first = u.clientUserList[0];
    if (first === undefined) {
      throw new Error('this token authenticates a user with no client account -- nothing to manage');
    }
    this.cachedClientId = first.clientId;
    return first.clientId;
  }

  async projects(): Promise<ZProject[]> {
    const raw = await this.search<unknown>('/project/search', []);
    return raw.map((r) => ZProjectSchema.parse(r));
  }

  /** The account's service catalogue, with the real internal version names. */
  async serviceTypes(): Promise<Array<{ typeId: string; name: string; versions: string[] }>> {
    // Global catalogue: not scoped to a client, and saying so is required rather than tidy.
    const raw = await this.search<Record<string, unknown>>('/service-stack-type/search', [], { clientScoped: false });
    return raw.map((t) => ({
      typeId: String(t['id'] ?? ''),
      name: String(t['name'] ?? ''),
      versions: Array.isArray(t['serviceStackTypeVersionList'])
        ? (t['serviceStackTypeVersionList'] as Array<{ name?: unknown }>).map((v) => String(v.name ?? '')).filter((v) => v !== '')
        : [],
    })).filter((t) => t.typeId !== '');
  }

  /**
   * Create an empty project.
   *
   * `POST /client/{clientId}/project`, found by probing — `POST /project` is a flat 404, and
   * `PUT /project/import` answers "Project not found" for every body you can construct,
   * including a well-formed `project:` block, because it imports INTO a project rather than
   * making one. The account id is in the path, not the body.
   *
   * `tagList` is required. Not optional-with-a-default — omitting it fails with
   * `{"tagList":["field is required"]}` even when `name` is present and valid, so an empty
   * array is sent explicitly rather than left out.
   *
   * This WRITES. A project is a real, billable object on the account.
   */
  async createProject(name: string, tagList: readonly string[] = []): Promise<ZProject> {
    const cid = await this.clientId();
    const raw = await this.call<unknown>('POST', `/client/${encodeURIComponent(cid)}/project`, {
      name,
      tagList: [...tagList],
    });
    return ZProjectSchema.parse(raw);
  }

  /** Delete a project and everything in it. Used to clean up after a demo. */
  async deleteProject(projectId: string): Promise<unknown> {
    return this.call('DELETE', `/project/${encodeURIComponent(projectId)}`);
  }

  /**
   * Add services to an EXISTING project, via an import file.
   *
   * `POST /project/{id}/service-stack/import`, found by probing: the documented path is the
   * `zcli project service-import` command and the REST route is not in the public reference.
   * `PUT /project/import` is the neighbouring route that CREATES a project and answers
   * "Project not found" no matter what you send it, which is a very effective decoy.
   *
   * This WRITES. It creates real services that consume real account resources.
   */
  async importServices(projectId: string, yaml: string): Promise<unknown> {
    return this.call('POST', `/project/${encodeURIComponent(projectId)}/service-stack/import`, { yaml });
  }

  /** Delete one service. Used to clean up after a provisioning test. */
  async deleteService(serviceId: string): Promise<unknown> {
    return this.call('DELETE', `/service-stack/${encodeURIComponent(serviceId)}`);
  }

  async services(projectId: string): Promise<ZService[]> {
    const raw = await this.search<unknown>('/service-stack/search', [
      { name: 'projectId', operator: 'eq', value: projectId },
    ]);
    return raw.map((r) => ZServiceSchema.parse(r));
  }

  /**
   * Does this token work, and what can it see?
   *
   * Answered by making a real call, not by checking the string is non-empty. This is what
   * the desktop app runs the moment a token is pasted, so the answer has to be the truth
   * rather than optimism.
   */
  async verify(): Promise<
    | { ok: true; email: string; clientId: string; projectCount: number; tokenHint: string }
    | { ok: false; reason: string; isAuthFailure: boolean }
  > {
    try {
      const u = await this.user();
      const cid = await this.clientId();
      const ps = await this.projects();
      return {
        ok: true,
        email: u.email,
        clientId: cid,
        projectCount: ps.length,
        tokenHint: this.tokenHint,
      };
    } catch (err) {
      if (ZeropsApiError.is(err)) {
        return {
          ok: false,
          isAuthFailure: err.isAuthFailure,
          reason: err.isAuthFailure
            ? 'That token was rejected. Generate a new one in the Zerops GUI under Access Token management.'
            : err.message,
        };
      }
      return {
        ok: false,
        isAuthFailure: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
