/**
 * Secrets that are already in the repository.
 *
 * Notch's whole argument is that it reads your code and tells you what the platform does not
 * know yet. The inverse is worth more: your code contains something the platform should have
 * generated, and now it is in git history where deleting it does nothing.
 *
 * TWO RULES SHAPE EVERY LINE BELOW.
 *
 * 1. A FINDING NEVER CONTAINS THE SECRET. Not the value, not a prefix of the value, not a
 *    masked version of it. A tool that reports "found AKIA1234…" has copied the credential
 *    into a log, a screenshot, a support ticket and a demo recording. What you need in order
 *    to act is the file, the line and what kind of thing it is — so that is all this returns.
 *    `Finding` has no field that could hold one, which is the only way to be sure.
 *
 * 2. TRACKED BY GIT IS THE WHOLE QUESTION. A `.env` sitting in a working directory is correct
 *    and normal; the same file committed is an incident. So findings are only raised against
 *    files `git ls-files` returns, and a repository that is not a git repository gets an
 *    honest "could not tell" rather than a clean bill of health.
 */
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface Finding {
  /** Repo-relative path. */
  path: string;
  /** 1-indexed. */
  line: number;
  /** Which detector fired, in words a human can act on. */
  rule: string;
  /** What to do about it. Always actionable, never "review this". */
  advice: string;
  severity: 'critical' | 'high' | 'medium';
  /**
   * The assignment's KEY, when the match was a `KEY=value` line. Never the value.
   * Keys are safe — Notch already prints them everywhere — and they make a finding findable.
   */
  key: string | null;
}

export interface HygieneReport {
  /** Null when this is not a git repository — see rule 2 above. */
  tracked: number | null;
  scanned: number;
  findings: Finding[];
  /** Said out loud when something limited the sweep. Never a silent truncation. */
  notes: string[];
}

interface Rule {
  id: string;
  re: RegExp;
  advice: string;
  severity: Finding['severity'];
}

/*
 * Prefix-anchored rules only.
 *
 * Every one of these matches an issuer's own documented key format, so a hit is a credential
 * or it is nothing — no entropy heuristics, no "looks random enough". A scanner that cries
 * wolf on a base64 asset gets switched off within a day, and a switched-off scanner finds
 * nothing at all.
 */
const RULES: readonly Rule[] = [
  { id: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/,
    advice: 'Deactivate it in IAM and issue a new one. Assume it is public.', severity: 'critical' },
  { id: 'GitHub personal access token', re: /\bghp_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
    advice: 'Revoke it at github.com/settings/tokens and issue a new one.', severity: 'critical' },
  { id: 'Stripe live secret key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/,
    advice: 'Roll it in the Stripe dashboard now — this one moves money.', severity: 'critical' },
  { id: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    advice: 'Revoke it in the Slack app config and reinstall the app.', severity: 'critical' },
  { id: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
    advice: 'Revoke it in the Anthropic console and issue a new one.', severity: 'critical' },
  { id: 'OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
    advice: 'Revoke it in the OpenAI dashboard and issue a new one.', severity: 'critical' },
  { id: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/,
    advice: 'Delete the key in Google Cloud credentials and issue a new one.', severity: 'critical' },
  { id: 'Private key block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    advice: 'Generate a new key pair and rotate everything that trusted this one.', severity: 'critical' },
  /*
   * Loopback is excluded, and the exclusion is the interesting part.
   *
   * `postgresql://postgres:brain@127.0.0.1:55432/brain` is a local development string. There
   * is no account behind it, nothing to revoke, and nobody it could leak to — flagging it
   * teaches people to scroll past this screen. Notch's own repository has two of these, which
   * is how the rule got written: the first run of this scanner reported its own author.
   *
   * A bare service host like `@db:5432` is NOT excluded. That is a password somebody chose and
   * will reuse, shared across everyone who can read the repo.
   */
  { id: 'Connection string with an inline password',
    re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s:/@]+:[^\s/@]+@(?!(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])[:/\s]|(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])$)/,
    advice: 'Move it to an env var. On Zerops the platform generates one — see the wiring block.',
    severity: 'high' },
  { id: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    advice: 'If it is a real session or service token, revoke the signing key.', severity: 'high' },
];

/** Placeholder values people commit on purpose. Not findings — flagging them trains the eye off. */
const PLACEHOLDER =
  /^(?:|["']?(?:changeme|change_me|your[-_a-z]*|xxx+|todo|none|null|undefined|example[-_a-z]*|placeholder|secret|password|test|dummy|fake|<[^>]*>|\$\{[^}]*\}|\.\.\.)["']?)$/i;

/** `KEY=value` in an env file, tolerating `export ` and quotes. */
const ASSIGN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

/** Names that mean "this value is a credential". Same vocabulary the provisioner uses. */
const SECRET_KEY = /(SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL|AUTH)/i;

/** Names that carry a credential-ish word but are public by definition. */
const PUBLIC_KEY_NAME = /(PUBLISHABLE|PUBLIC|_URL$|_HOST$|_PORT$|_USER$|_USERNAME$|CLIENT_ID)/i;

const isEnvFile = (p: string): boolean => {
  const name = p.split('/').pop() ?? p;
  return name === '.env' || name.startsWith('.env.');
};

/**
 * One file's findings.
 *
 * Exported so it can be tested on strings without a git repository or a disk — the detectors
 * are the part that has to be right, and they should be provable in isolation.
 */
export function scanContent(path: string, content: string): Finding[] {
  const out: Finding[] = [];
  const lines = content.split('\n');

  lines.forEach((raw, i) => {
    // A commented-out line is still a committed secret. `#` only skips the placeholder rule.
    const line = raw.length > 4096 ? raw.slice(0, 4096) : raw;
    const assign = ASSIGN.exec(line.replace(/^\s*#\s*/, ''));
    const key = assign?.[1] ?? null;
    const value = (assign?.[2] ?? '').replace(/^["']|["']$/g, '');

    for (const r of RULES) {
      if (!r.re.test(line)) continue;
      out.push({ path, line: i + 1, rule: r.id, advice: r.advice, severity: r.severity, key });
      return; // One finding per line: the same key matching two rules is one problem.
    }

    /*
     * The generic case, and the one that actually catches people: a credential-shaped NAME
     * with a real-looking value, in a file git is tracking. Deliberately narrow — env files
     * only, long values only, placeholders excluded — because this is the rule most likely to
     * be wrong, and a false positive here costs more than a miss.
     */
    if (
      key !== null && isEnvFile(path) &&
      SECRET_KEY.test(key) && !PUBLIC_KEY_NAME.test(key) &&
      value.length >= 16 && !PLACEHOLDER.test(value) && !/\s/.test(value)
    ) {
      out.push({
        path, line: i + 1, key,
        rule: 'Credential-shaped value in a committed env file',
        advice: `Remove ${key} from the file, rotate it, and let Zerops generate it as a secret.`,
        severity: 'critical',
      });
    }
  });

  return out;
}

/** Extensions worth reading. Everything else is either binary or not where secrets live. */
const READABLE = /\.(?:env[.a-z]*|json|ya?ml|toml|ini|cfg|conf|properties|tf|tfvars|sh|bash|zsh|js|cjs|mjs|jsx|ts|tsx|py|rb|go|rs|php|java|kt|cs|xml|md|txt|pem|key)$/i;

const MAX_FILES = 2000;
const MAX_BYTES = 512 * 1024;

/**
 * Sweep a repository for credentials git is already carrying.
 *
 * `git ls-files` is the source of truth — not a directory walk. A walk would report the
 * `.env` that is correctly ignored and miss the one committed under a name nobody expects,
 * which is exactly backwards.
 */
export async function sweep(dir: string): Promise<HygieneReport> {
  const notes: string[] = [];

  let tracked: string[];
  try {
    const { stdout } = await run('git', ['-C', dir, 'ls-files', '-z'], { maxBuffer: 32 * 1024 * 1024 });
    tracked = stdout.split('\0').filter((p) => p !== '');
  } catch {
    return {
      tracked: null, scanned: 0, findings: [],
      notes: ['Not a git repository, so Notch cannot tell which files are committed. ' +
              'A secret only matters here if git is carrying it.'],
    };
  }

  const candidates = tracked.filter((p) => READABLE.test(p) || isEnvFile(p));
  const capped = candidates.slice(0, MAX_FILES);
  if (candidates.length > capped.length) {
    notes.push(`Read the first ${MAX_FILES} of ${candidates.length} tracked text files. ` +
               'The rest were not looked at — this is a cap, not a clean result.');
  }

  const findings: Finding[] = [];
  let scanned = 0;
  let skippedBig = 0;

  for (const rel of capped) {
    const abs = join(dir, rel);
    try {
      const s = await stat(abs);
      if (!s.isFile()) continue;
      if (s.size > MAX_BYTES) { skippedBig += 1; continue; }
      findings.push(...scanContent(rel, await readFile(abs, 'utf8')));
      scanned += 1;
    } catch {
      // Tracked but unreadable — deleted from the working tree, or a permission problem.
      // Not a finding, and not worth a note per file.
    }
  }

  if (skippedBig > 0) {
    notes.push(`${skippedBig} tracked file(s) over ${MAX_BYTES / 1024}KB were not read.`);
  }

  const rank = { critical: 0, high: 1, medium: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.path.localeCompare(b.path) || a.line - b.line);

  return { tracked: tracked.length, scanned, findings, notes };
}
