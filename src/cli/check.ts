#!/usr/bin/env node
/**
 * `notch check` — will this branch deploy?
 *
 * The same drift engine the desktop app uses, with no desktop, no database and no human. It
 * reads the repository at `--dir`, reads the target Zerops project over the API, and exits
 * non-zero when the code needs infrastructure the project does not have.
 *
 * THIS IS THE POINT OF THE WHOLE PROJECT. Everything else answers "what is missing right now,
 * because I clicked". This answers it on every pull request, before the merge, without anybody
 * remembering to look — which is the only version of the question that prevents the outage
 * rather than explaining it afterwards.
 *
 * EXIT CODES, because a CI gate is its exit code:
 *   0  the project can run this branch
 *   1  something the code needs is missing
 *   2  the check could not run (bad token, no such project, unreadable directory)
 *
 * A check that cannot run must NEVER exit 0. Reporting "all good" because the API was down
 * would make the gate worse than not having one.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ZeropsApiError, ZeropsClient } from '../zerops/api.js';
import { buildGraph } from '../zerops/graph.js';
import { computeDrift } from '../zerops/drift.js';
import { compareConfig } from '../zerops/config.js';
import { SCAN_GLOBS, findSecretNames, scanRepo, type RepoFile } from '../repo/scan.js';

interface Opts {
  dir: string;
  project: string;
  format: 'text' | 'github' | 'json';
  /** Also fail on requirements inferred only from an env var name. */
  strict: boolean;
}

const USAGE = `
notch check — fail a build when the code needs infrastructure the project does not have.

  notch check --project <name|id> [--dir .] [--format text|github|json] [--strict]

  ZEROPS_TOKEN must be set.

exit 0  the project can run this branch
exit 1  something the code needs is missing
exit 2  the check could not run
`;

function parse(argv: readonly string[]): Opts | null {
  const o: Opts = { dir: process.cwd(), project: '', format: 'text', strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = (): string => { i += 1; return argv[i] ?? ''; };
    if (a === '--dir') o.dir = resolve(next());
    else if (a === '--project') o.project = next();
    else if (a === '--format') o.format = next() as Opts['format'];
    else if (a === '--strict') o.strict = true;
    else if (a === '-h' || a === '--help') return null;
  }
  return o.project === '' ? null : o;
}

async function readRepo(dir: string): Promise<RepoFile[]> {
  const out: RepoFile[] = [];
  for (const g of SCAN_GLOBS) {
    const p = join(dir, g);
    if (!existsSync(p)) continue;
    try { out.push({ path: g, content: await readFile(p, 'utf8') }); } catch { /* unreadable: skip */ }
  }
  return out;
}

/** GitHub renders these as inline annotations on the run. */
const annotate = (level: 'error' | 'warning' | 'notice', file: string, msg: string): string =>
  `::${level} file=${file}::${msg.replace(/\n/g, ' ')}`;

async function main(): Promise<number> {
  const opts = parse(process.argv.slice(2));
  if (opts === null) { console.log(USAGE); return 2; }

  const token = process.env['ZEROPS_TOKEN'] ?? '';
  if (token.trim() === '') {
    console.error('notch check: ZEROPS_TOKEN is not set. Refusing to report success without looking.');
    return 2;
  }
  if (!existsSync(opts.dir)) {
    console.error(`notch check: ${opts.dir} does not exist.`);
    return 2;
  }

  const client = new ZeropsClient(token.trim());
  let projects;
  try {
    projects = await client.projects();
  } catch (err) {
    console.error(`notch check: could not reach Zerops — ${ZeropsApiError.is(err) ? err.apiMessage : String(err)}`);
    return 2;
  }

  const project = projects.find((p) => p.id === opts.project || p.name === opts.project);
  if (project === undefined) {
    console.error(
      `notch check: no project "${opts.project}" on this account. ` +
      `Found: ${projects.map((p) => p.name).join(', ') || '(none)'}`);
    return 2;
  }

  const services = await client.services(project.id);
  const graph = buildGraph(project, services);
  const files = await readRepo(opts.dir);
  const required = scanRepo(files);
  const drift = computeDrift(required, graph.nodes);

  const config = compareConfig(
    findSecretNames(files),
    project.envList.map((e) => e.key),
    [...graph.nodes.map((n) => n.name), ...graph.nodes.map((n) => n.typeName)],
  );

  const missing = drift.items.filter((i) =>
    i.status === 'missing' && (opts.strict || i.required?.confidence !== 'likely'));
  const soft = drift.items.filter((i) =>
    i.status === 'missing' && !opts.strict && i.required?.confidence === 'likely');

  const failed = missing.length > 0 || config.missing.length > 0;

  if (opts.format === 'json') {
    console.log(JSON.stringify({
      project: project.name, dir: opts.dir, scanned: files.map((f) => f.path),
      missing: missing.map((i) => ({ type: i.type, why: i.summary, evidence: i.required?.evidence ?? [] })),
      lowConfidence: soft.map((i) => i.type),
      configMissing: config.missing,
      satisfied: drift.items.filter((i) => i.status === 'satisfied').map((i) => i.type),
      ok: !failed,
    }, null, 2));
    return failed ? 1 : 0;
  }

  const md: string[] = [];
  const say = (s = '') => { md.push(s); if (opts.format === 'text') console.log(s); };

  say(`notch check — ${project.name}`);
  say(`read ${files.map((f) => f.path).join(', ') || 'no recognised manifests'} in ${opts.dir}`);
  say();

  if (files.length === 0) {
    say('No manifests to read here, so there is nothing to compare. That is not a pass.');
    if (opts.format === 'github') console.log(annotate('warning', 'package.json', 'notch check found no manifests to read'));
    return 2;
  }

  for (const i of missing) {
    const ev = i.required?.evidence ?? [];
    say(`MISSING  ${i.type} — ${i.summary}`);
    for (const e of ev) say(`         ${e.found} in ${e.path}`);
    if (opts.format === 'github') {
      console.log(annotate('error', ev[0]?.path ?? 'package.json',
        `${project.name} has no ${i.type}. ${i.summary}`));
    }
  }
  for (const k of config.missing) {
    say(`UNSET    ${k} — the repo reads it; ${project.name} does not define it`);
    if (opts.format === 'github') {
      console.log(annotate('error', '.env.example',
        `${k} is not set on ${project.name}. The deploy will succeed and the app will fail at runtime.`));
    }
  }
  for (const i of soft) {
    say(`maybe    ${i.type} — inferred from an env var name only (use --strict to fail on these)`);
    if (opts.format === 'github') {
      console.log(annotate('notice', i.required?.evidence[0]?.path ?? '.env.example',
        `${i.type} may be needed: ${i.summary}`));
    }
  }
  for (const g of config.provided) {
    say(`ok       ${g.key} — provided by the ${g.by} service`);
  }

  say();
  say(failed
    ? `FAIL — ${missing.length} service(s) and ${config.missing.length} variable(s) missing from ${project.name}.`
    : `PASS — ${project.name} can run this branch.`);

  if (opts.format === 'github') {
    // A file GitHub Actions can paste into the pull request as a comment.
    const summary = process.env['GITHUB_STEP_SUMMARY'];
    const body = [
      `## notch check — ${failed ? '❌ ' + project.name + ' cannot run this branch' : '✅ ' + project.name + ' can run this branch'}`,
      '',
      ...(missing.length > 0 ? ['| missing service | why | evidence |', '|---|---|---|',
        ...missing.map((i) => `| \`${i.type}\` | ${i.summary} | ${(i.required?.evidence ?? []).map((e) => `\`${e.found}\` in \`${e.path}\``).join('<br>')} |`), ''] : []),
      ...(config.missing.length > 0 ? ['| unset variable | consequence |', '|---|---|',
        ...config.missing.map((k) => `| \`${k}\` | build passes, app fails at runtime |`), ''] : []),
      `<sub>read ${files.map((f) => f.path).join(', ')} · compared against Zerops project \`${project.name}\`</sub>`,
    ].join('\n');
    if (summary !== undefined && summary !== '') {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(summary, body + '\n');
    }
    console.log(body);
  }

  return failed ? 1 : 0;
}

function isEntryPoint(): boolean {
  const a = process.argv[1];
  if (a === undefined) return false;
  try { return resolve(fileURLToPath(import.meta.url)) === resolve(a); } catch { return false; }
}

if (isEntryPoint()) {
  // A crash is a check that could not run, which is exit 2 — never a silent pass.
  main().then((code) => process.exit(code)).catch((err: unknown) => {
    console.error(`notch check: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });
}

export { compareConfig, main, parse };
