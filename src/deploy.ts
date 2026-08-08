/**
 * Deployment — the half that was missing.
 *
 * Everything else in Notch stops at "the services exist". That is a project full of empty
 * containers, and the honest summary of it is "creates infrastructure", which is a much
 * weaker sentence than the one this app should be able to say. This closes it: the repository
 * that declared the services also gets pushed to the runtime that was created for it, and the
 * answer is a URL you can open.
 *
 * IT SHELLS OUT TO `zcli`, DELIBERATELY. Uploading a build is a multi-step dance — create an
 * app version, upload an archive, trigger the deploy, follow the pipeline — and Zerops already
 * ships the client that does it. Re-implementing that against an undocumented REST surface
 * would be a second, worse zcli that breaks the first time the protocol moves. Notch's value
 * is knowing WHAT to deploy and WHERE, not owning the transport.
 *
 * THE TOKEN IS PASSED IN THE ENVIRONMENT, never on the command line: an argv is world-readable
 * through `ps` for the lifetime of the process.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export class DeployError extends Error {
  constructor(message: string, readonly detail = '') { super(message); this.name = 'DeployError'; }
  static is(e: unknown): e is DeployError { return e instanceof Error && e.name === 'DeployError'; }
}

/** Where zcli lives, or `null` when it is not installed. */
export function zcliPath(): string | null {
  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    if (dir === '') continue;
    const p = join(dir, 'zcli');
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Is this repository deployable, and what would stop it?
 *
 * Answered before anything is uploaded, because the failure modes here are all knowable up
 * front and a four-minute build that dies on a missing file is the worst way to learn any of
 * them.
 */
export interface Readiness {
  ready: boolean;
  /** Named, actionable reasons. Empty when ready. */
  problems: string[];
  hasBuildFile: boolean;
}

export function readiness(dir: string): Readiness {
  const problems: string[] = [];
  const hasBuildFile = existsSync(join(dir, 'zerops.yml')) || existsSync(join(dir, 'zerops.yaml'));

  if (!existsSync(dir)) problems.push(`${dir} does not exist on this machine.`);
  if (zcliPath() === null) {
    problems.push('zcli is not installed. Zerops\' own client does the upload; install it with `npm i -g @zerops/zcli`.');
  }
  if (!hasBuildFile) {
    problems.push(
      'No zerops.yml in this repository. That is the BUILD file — how the code becomes a ' +
      'running container — and it is not the same as the zerops.yaml Notch exports, which ' +
      'lists services. Zerops cannot build without it.');
  }
  return { ready: problems.length === 0, problems, hasBuildFile };
}

export interface DeployResult {
  ok: boolean;
  /** Everything zcli said, in order. Shown as-is; a build log is the evidence. */
  log: string[];
  code: number | null;
  ms: number;
}

/**
 * Push the repository to a service.
 *
 * @param serviceId The runtime the code belongs on.
 * @param dir       The repository. zcli reads `zerops.yml` from here.
 * @param setup     Which `setup:` block in zerops.yml to use.
 * @param onLine    Called for each line as it arrives, so the UI can show a build happening
 *                  rather than a spinner that ends four minutes later.
 */
export function push(
  token: string,
  serviceId: string,
  dir: string,
  setup: string,
  onLine: (line: string) => void,
  timeoutMs = 900_000,
): Promise<DeployResult> {
  const bin = zcliPath();
  if (bin === null) throw new DeployError('zcli is not installed.');

  const started = Date.now();
  const log: string[] = [];

  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      ['push', '--service-id', serviceId, '--setup', setup, '--working-dir', dir, '--no-git'],
      {
        cwd: dir,
        // ZEROPS_TOKEN, not argv — an argument list is readable by any process on the machine.
        env: { ...process.env, ZEROPS_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const take = (chunk: Buffer): void => {
      for (const raw of chunk.toString().split('\n')) {
        const line = raw.replace(/\[[0-9;]*m/g, '').trimEnd();
        if (line.trim() === '') continue;
        log.push(line);
        onLine(line);
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new DeployError(
        `The deploy did not finish within ${Math.round(timeoutMs / 60000)} minutes.`,
        log.slice(-12).join('\n')));
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new DeployError('Could not start zcli.', String(e)));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, log, code, ms: Date.now() - started });
    });
  });
}
