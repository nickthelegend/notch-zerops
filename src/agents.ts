/**
 * The coding agents already on this machine, pointed at your infrastructure.
 *
 * This is the part of Notch that was always the point: it is mission control for the agents
 * you already run, not another chatbot. There is no API key here and none is wanted — Claude
 * Code, Codex, OpenCode and Gemini are installed, authenticated, and paid for; Notch spawns
 * them, hands them the truth about your Zerops account, and shows you what they said.
 *
 * WHAT THE AGENT IS GIVEN. Not a vague "you are a helpful assistant": the actual services in
 * the project, the actual gaps the scanner found, and the file and line of evidence behind
 * each one. An agent asked "why does this need Qdrant" can answer from the same evidence the
 * UI shows, instead of guessing from the name.
 *
 * WHAT THE AGENT CANNOT DO. It cannot write. Every mutating path in this app — provisioning,
 * export — is behind a preview the human confirms, and an agent that could bypass that would
 * make the preview a decoration. So this returns prose, and the buttons stay where they are.
 * That is a deliberate limit, and it is the honest place for the line today.
 *
 * The prompt is passed as an ARGV ELEMENT, never interpolated into a shell string, so nothing
 * a user types can become a command.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface AgentSpec {
  id: string;
  label: string;
  bin: string;
  /** Arguments before the prompt. The prompt is appended as one argv element. */
  args: readonly string[];
}

/**
 * `codex exec` refuses to run outside a trusted git repo unless told not to check, and reads
 * stdin when it thinks there is more input — so its stdin is closed below.
 */
export const AGENTS: readonly AgentSpec[] = [
  { id: 'claude', label: 'Claude Code', bin: 'claude', args: ['-p'] },
  { id: 'codex', label: 'Codex', bin: 'codex', args: ['exec', '--skip-git-repo-check'] },
  { id: 'opencode', label: 'OpenCode', bin: 'opencode', args: ['run'] },
  { id: 'gemini', label: 'Gemini', bin: 'gemini', args: ['-p'] },
];

const which = (bin: string): string | null => {
  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    if (dir === '') continue;
    const p = `${dir}/${bin}`;
    if (existsSync(p)) return p;
  }
  return null;
};

/** Which agents are actually installed. Reported honestly rather than offered and then failing. */
export function available(): Array<{ id: string; label: string; path: string }> {
  return AGENTS.flatMap((a) => {
    const p = which(a.bin);
    return p === null ? [] : [{ id: a.id, label: a.label, path: p }];
  });
}

export interface AskResult {
  agent: string;
  reply: string;
  ms: number;
  exitCode: number | null;
}

export class AgentError extends Error {
  constructor(message: string, readonly detail = '') { super(message); this.name = 'AgentError'; }
  static is(e: unknown): e is AgentError { return e instanceof Error && e.name === 'AgentError'; }
}

/**
 * Run one turn.
 *
 * @param cwd Where the agent runs. The scanned repository when there is one, so the agent can
 *   read the very files the evidence cites — that is most of why a local CLI beats an API call.
 */
export function ask(
  agentId: string,
  prompt: string,
  cwd: string,
  timeoutMs = 120_000,
): Promise<AskResult> {
  const spec = AGENTS.find((a) => a.id === agentId);
  if (spec === undefined) throw new AgentError(`Unknown agent "${agentId}".`);
  const bin = which(spec.bin);
  if (bin === null) {
    throw new AgentError(
      `${spec.label} is not installed on this machine.`,
      `Looked for "${spec.bin}" on PATH.`);
  }

  const dir = cwd !== '' && existsSync(cwd) ? cwd : process.cwd();
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...spec.args, prompt], {
      cwd: dir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],       // stdin closed: codex waits on it otherwise
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new AgentError(
        `${spec.label} did not answer within ${Math.round(timeoutMs / 1000)}s.`,
        out.slice(-400)));
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new AgentError(`Could not start ${spec.label}.`, String(e)));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const reply = out.trim();
      if (reply === '') {
        reject(new AgentError(
          `${spec.label} exited without saying anything (code ${code}).`,
          err.trim().slice(-400)));
        return;
      }
      resolve({ agent: spec.label, reply, ms: Date.now() - started, exitCode: code });
    });
  });
}

/* -------------------------------------------------------------------------- */

export interface Brief {
  projectName: string;
  projectStatus: string;
  services: Array<{ name: string; type: string; status: string }>;
  missing: Array<{ type: string; why: string; evidence: string[] }>;
  satisfied: string[];
  dir: string;
  scanned: string[];
}

/**
 * The state of the account, as text an agent can reason about.
 *
 * Facts only, and every gap carries the evidence that produced it. The instruction not to
 * invent services matters: asked about infrastructure, a model will happily list plausible
 * ones, and a confident answer about a service you do not have is worse than no answer.
 */
export function brief(b: Brief): string {
  const lines: string[] = [
    'You are answering inside Notch, a tool that compares a git repository against the',
    'infrastructure actually deployed on Zerops. Everything below was read from the live',
    'Zerops API and from the repository on this machine a moment ago. It is ground truth.',
    '',
    `PROJECT: ${b.projectName} (${b.projectStatus})`,
  ];

  lines.push('', 'DEPLOYED SERVICES:');
  if (b.services.length === 0) lines.push('  (none — the project is empty)');
  for (const s of b.services) lines.push(`  - ${s.name}: ${s.type}, ${s.status}`);

  lines.push('', `REPOSITORY: ${b.dir || '(not scanned yet)'}`);
  if (b.scanned.length > 0) lines.push(`  manifests read: ${b.scanned.join(', ')}`);

  if (b.satisfied.length > 0) {
    lines.push('', `SATISFIED (repo needs it, project has it): ${b.satisfied.join(', ')}`);
  }

  lines.push('', 'MISSING (the repo needs it, the project does not have it):');
  if (b.missing.length === 0) lines.push('  (nothing)');
  for (const m of b.missing) {
    lines.push(`  - ${m.type}: ${m.why}`);
    for (const e of m.evidence) lines.push(`      evidence: ${e}`);
  }

  lines.push(
    '',
    'RULES:',
    '  - Answer only from the facts above and from files in this repository.',
    '  - Never invent a service, a version, or a connection that is not listed.',
    '  - If the facts do not answer the question, say so and say what you would need.',
    '  - You cannot change anything. Provisioning is behind a preview the human confirms.',
    '  - Be brief. This is shown in a narrow sidebar.',
    '',
  );
  return lines.join('\n');
}
