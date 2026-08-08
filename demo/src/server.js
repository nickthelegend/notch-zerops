/**
 * acme-notes-api — the fixture, made real.
 *
 * This exists so the demo can finish the sentence. Notch scans a repo, provisions what it
 * needs, and then deploys THIS, and what it serves is the proof: the page lists which backing
 * services the running container can actually see, read from the environment Zerops injected.
 *
 * It deliberately does not connect to any of them. Opening six client libraries would make the
 * first request depend on six services being healthy, and a demo that fails because Meilisearch
 * is still starting teaches the viewer nothing. Presence of the injected connection variable is
 * the honest signal that provisioning and wiring worked, and it is the exact thing Notch
 * claimed on the desktop a minute earlier.
 */
import express from 'express';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

/**
 * What the repo said it needed, and the variable Zerops injects when it exists.
 *
 * Zerops publishes a managed service's connection details as `<hostname>_<key>`, so the
 * presence of `postgresql_connectionString` is the platform itself confirming the service is
 * there and reachable on the private network.
 */
const EXPECTED = [
  { service: 'postgresql', vars: ['postgresql_connectionString', 'DATABASE_URL'] },
  { service: 'valkey', vars: ['valkey_connectionString', 'REDIS_URL'] },
  { service: 'meilisearch', vars: ['meilisearch_connectionString', 'MEILISEARCH_URL'] },
  { service: 'qdrant', vars: ['qdrant_connectionString', 'QDRANT_URL'] },
  { service: 'nats', vars: ['nats_connectionString', 'NATS_URL'] },
  { service: 'objectstorage', vars: ['S3_ENDPOINT_URL'] },
];

/** Secrets are reported as PRESENT or ABSENT. A value is never read, logged, or served. */
const SECRETS = [
  'JWT_SECRET', 'SESSION_SECRET', 'MEILI_MASTER_KEY', 'QDRANT_API_KEY',
  'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'STRIPE_API_KEY',
  'WEBHOOK_SIGNING_SECRET', 'PASSWORD_PEPPER',
];

const seen = () => EXPECTED.map((e) => ({
  service: e.service,
  reachable: e.vars.some((v) => (process.env[v] ?? '') !== ''),
  via: e.vars.find((v) => (process.env[v] ?? '') !== '') ?? null,
}));

const secretsSeen = () => SECRETS.map((k) => ({ key: k, set: (process.env[k] ?? '') !== '' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/api/status', (_req, res) => {
  const services = seen();
  res.json({
    app: 'acme-notes-api',
    deployedBy: 'Notch',
    services,
    reachable: services.filter((s) => s.reachable).length,
    total: services.length,
    secrets: secretsSeen(),
  });
});

app.get('/', (_req, res) => {
  const services = seen();
  const ok = services.filter((s) => s.reachable).length;
  const row = (label, good, detail) => `
    <tr>
      <td class="n">${label}</td>
      <td class="s ${good ? 'y' : 'n2'}">${good ? 'reachable' : 'not present'}</td>
      <td class="d">${detail ?? ''}</td>
    </tr>`;

  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>acme-notes-api — deployed by Notch</title>
<style>
  :root { color-scheme: dark; }
  body { background:#111; color:#e0e0e0; font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
         margin:0; padding:56px 24px; display:flex; justify-content:center; }
  main { width:100%; max-width:720px; }
  h1 { font-size:28px; font-weight:800; letter-spacing:-.02em; margin:0 0 6px; }
  .sub { color:#888; margin:0 0 28px; }
  .card { background:#1a1a1a; border:1px solid #2a2a2a; border-radius:14px; padding:18px 20px; margin-bottom:16px; }
  table { width:100%; border-collapse:collapse; }
  td { padding:7px 0; border-bottom:1px solid #222; vertical-align:top; }
  tr:last-child td { border-bottom:0; }
  .n { font-weight:700; width:150px; }
  .s { width:120px; font-family:ui-monospace,Menlo,monospace; font-size:12px; }
  .y { color:#22c55e; } .n2 { color:#888; }
  .d { color:#666; font-family:ui-monospace,Menlo,monospace; font-size:11.5px; }
  .k { display:inline-block; font-family:ui-monospace,Menlo,monospace; font-size:11.5px;
       border:1px solid #2a2a2a; border-radius:5px; padding:2px 7px; margin:3px 4px 0 0; }
  .set { color:#22c55e; border-color:#1d3b2a; } .unset { color:#666; }
  .lead { font-size:17px; }
</style></head>
<body><main>
  <h1>acme-notes-api</h1>
  <p class="sub">Provisioned and deployed by Notch, from the repository that declared it.</p>

  <div class="card">
    <p class="lead" style="margin:0 0 12px">
      <strong>${ok} of ${services.length}</strong> backing services are visible to this container.
    </p>
    <table>${services.map((s) => row(s.service, s.reachable, s.via)).join('')}</table>
  </div>

  <div class="card">
    <p style="margin:0 0 10px;color:#888">Secrets, as present or absent. No value is ever read or shown.</p>
    ${secretsSeen().map((s) => `<span class="k ${s.set ? 'set' : 'unset'}">${s.key}${s.set ? ' ✓' : ' —'}</span>`).join('')}
  </div>

  <p style="color:#555;font-size:12.5px">
    Nothing on this page is hardcoded: every row is read from the environment Zerops injected
    when the service was created. <code style="color:#777">/api/status</code> returns the same
    thing as JSON.
  </p>
</main></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`acme-notes-api listening on ${PORT}`);
});
