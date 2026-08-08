/**
 * The detectors, in isolation.
 *
 * Two properties matter more than coverage here. First, that a finding NEVER carries the
 * secret — there is a test that walks every field of every finding and fails if the credential
 * appears in any of them, because "we redact it" is a claim worth enforcing rather than
 * asserting. Second, that the placeholder cases stay quiet: a scanner that fires on
 * `PASSWORD=changeme` gets ignored, and an ignored scanner is worse than none.
 */
import { describe, expect, it } from 'vitest';

import { scanContent } from '../src/repo/secrets.js';

/* Fabricated, correctly-shaped, and not valid anywhere. */
const AWS = 'AKIA' + 'QYLPO4EXAMPLE123';
const GH = 'ghp_' + 'a'.repeat(36);
const STRIPE = 'sk_live_' + 'b'.repeat(24);
const ANTHROPIC = 'sk-ant-' + 'c'.repeat(40);
const GOOGLE = 'AIza' + 'd'.repeat(35);
const SLACK = 'xoxb-' + '1234567890-abcdefghij';

describe('scanContent', () => {
  it('finds an AWS key in any file type', () => {
    const f = scanContent('deploy/setup.sh', `export AWS_ACCESS_KEY_ID=${AWS}\n`);
    expect(f).toHaveLength(1);
    expect(f[0]?.rule).toBe('AWS access key id');
    expect(f[0]?.severity).toBe('critical');
    expect(f[0]?.key).toBe('AWS_ACCESS_KEY_ID');
    expect(f[0]?.line).toBe(1);
  });

  it.each([
    ['GitHub personal access token', `TOKEN=${GH}`],
    ['Stripe live secret key', `STRIPE_SECRET_KEY=${STRIPE}`],
    ['Anthropic API key', `ANTHROPIC_API_KEY=${ANTHROPIC}`],
    ['Google API key', `MAPS=${GOOGLE}`],
    ['Slack token', `SLACK_BOT_TOKEN=${SLACK}`],
  ])('recognises a %s', (rule, line) => {
    const f = scanContent('.env', line);
    expect(f[0]?.rule).toBe(rule);
  });

  it('reports the line number, not just the file', () => {
    const f = scanContent('.env', `A=1\nB=2\nSECRET_TOKEN=${GH}\n`);
    expect(f[0]?.line).toBe(3);
  });

  it('never puts the secret in any field of the finding', () => {
    const secrets = [AWS, GH, STRIPE, ANTHROPIC, GOOGLE, SLACK];
    const body = secrets.map((s, i) => `KEY_${i}=${s}`).join('\n');
    const findings = scanContent('.env', body);
    expect(findings.length).toBe(secrets.length);
    const serialised = JSON.stringify(findings);
    for (const s of secrets) expect(serialised).not.toContain(s);
    // Not even a chunk of one.
    for (const s of secrets) expect(serialised).not.toContain(s.slice(-12));
  });

  it('catches a credential-shaped value in an env file with no known prefix', () => {
    const f = scanContent('.env', 'SESSION_SECRET=8f3aa1cd94be40729ab55e17c0d3f0a1');
    expect(f).toHaveLength(1);
    expect(f[0]?.rule).toBe('Credential-shaped value in a committed env file');
    expect(f[0]?.advice).toContain('SESSION_SECRET');
  });

  it('leaves placeholders alone', () => {
    const body = [
      'SESSION_SECRET=changeme',
      'API_TOKEN=your-token-here',
      'DB_PASSWORD=<your password>',
      'JWT_SECRET=${JWT_SECRET}',
      'AUTH_TOKEN=xxxxxxxxxxxxxxxxxx',
      'SECRET_KEY=',
    ].join('\n');
    expect(scanContent('.env.example', body)).toEqual([]);
  });

  it('does not flag a short value, which cannot be a real key', () => {
    expect(scanContent('.env', 'API_TOKEN=abc123')).toEqual([]);
  });

  it('does not flag names that are public by definition', () => {
    const body = [
      'STRIPE_PUBLISHABLE_KEY=pk_test_51H8sldkfjaldkfjaldkfjalskdjf',
      'DATABASE_URL=postgres://localhost:5432/app',
      'AUTH_CLIENT_ID=904ab3ef8812f0a94bb1e0cc7712aa41',
    ].join('\n');
    expect(scanContent('.env', body)).toEqual([]);
  });

  it('applies the generic rule only to env files', () => {
    const line = 'SESSION_SECRET=8f3aa1cd94be40729ab55e17c0d3f0a1';
    expect(scanContent('.env.production', line)).toHaveLength(1);
    expect(scanContent('src/config.ts', line)).toEqual([]);
  });

  it('flags a connection string that carries its own password', () => {
    const f = scanContent('docker-compose.yml', 'DATABASE_URL: postgres://app:hunter2@db:5432/app');
    expect(f[0]?.rule).toBe('Connection string with an inline password');
    expect(JSON.stringify(f)).not.toContain('hunter2');
  });

  it('leaves a passwordless connection string alone', () => {
    expect(scanContent('.env', 'DATABASE_URL=postgres://db:5432/app')).toEqual([]);
  });

  it.each([
    'postgresql://postgres:brain@127.0.0.1:55432/brain',
    'postgres://user:devpass@localhost:5432/app',
    'redis://default:devpass@127.0.0.1:6379',
  ])('leaves a loopback development string alone: %s', (url) => {
    expect(scanContent('.env.example', `DATABASE_URL=${url}`)).toEqual([]);
  });

  it('still flags an inline password on a non-loopback host', () => {
    const f = scanContent('.env', 'DATABASE_URL=postgres://app:hunter2@db.internal:5432/app');
    expect(f[0]?.rule).toBe('Connection string with an inline password');
  });

  it('still reports a commented-out secret, because git kept it', () => {
    const f = scanContent('.env', `# AWS_SECRET=${AWS}`);
    expect(f).toHaveLength(1);
    expect(f[0]?.key).toBe('AWS_SECRET');
  });

  it('reports one finding per line even when two rules could match', () => {
    expect(scanContent('.env', `GITHUB_TOKEN=${GH}`)).toHaveLength(1);
  });

  it('finds a private key block', () => {
    const f = scanContent('keys/id_rsa', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1r\n');
    expect(f[0]?.rule).toBe('Private key block');
    expect(f[0]?.key).toBeNull();
  });

  it('gives every finding advice that says what to do', () => {
    const f = scanContent('.env', `A=${AWS}\nB=${STRIPE}`);
    for (const x of f) expect(x.advice.length).toBeGreaterThan(20);
  });
});
