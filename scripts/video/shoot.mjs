/**
 * Run one take.
 *
 * Resets the app to a clean start, injects the driver, starts a cropped screen capture, and
 * records the marks the driver emits. The recording is stopped by the driver FINISHING, not by
 * a fixed duration, so a slow provision produces a longer video rather than a truncated one.
 *
 * Dependency-free: Chrome DevTools Protocol over Node's built-in WebSocket.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ?? join(HERE, 'out');
const DAEMON = 'http://127.0.0.1:7799';
const CDP = 'http://127.0.0.1:9222';

/*
 * The crop rectangle is MEASURED, not assumed.
 *
 * The window was asked for (96,54) and macOS placed it at (96,30). Cropping to the requested
 * rectangle would have shifted every frame 24px down — the app's title strip sliced off the
 * top and a band of desktop along the bottom. The running window is the only authority on
 * where the running window is, so it is read from the page just before the capture starts.
 */
let CROP = null;
const TOKEN = process.env.ZEROPS_TOKEN ?? '';
const REPO = process.env.DEMO_REPO ?? '/Volumes/Extreme SSD/Projects/wemakedevs/notch-zerops/demo';
const PROJECT = process.env.DEMO_PROJECT ?? 'acme-notes-demo';
if (TOKEN === '') { console.error('set ZEROPS_TOKEN'); process.exit(1); }

mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ CDP */

async function page() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`${CDP}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('no debuggable page — is Electron running with --remote-debugging-port=9222?');
}

const target = await page();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('CDP connect failed')); });

let seq = 0;
const pending = new Map();
const marks = [];
let done = null;

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { ok, no } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? no(new Error(JSON.stringify(msg.error))) : ok(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const s = (msg.params.args ?? []).map((a) => a.value ?? '').join(' ');
    if (s.startsWith('DEMO_LINE ')) {
      const [, ms, id] = s.split(' ');
      marks.push({ id, atMs: Number(ms) });
      console.log(`  mark ${String(ms).padStart(7)}ms  ${id}`);
    } else if (s.startsWith('DEMO_DONE ')) {
      done = JSON.parse(s.slice('DEMO_DONE '.length));
    } else if (s.startsWith('DEMO_')) {
      console.log(`  ${s}`);
    }
  }
};

const cdp = (method, params = {}) => new Promise((ok, no) => {
  const id = (seq += 1);
  pending.set(id, { ok, no });
  ws.send(JSON.stringify({ id, method, params }));
});

const evaluate = async (expression, awaitPromise = false) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description ?? ''));
  return r.result?.value;
};

await cdp('Page.enable');
await cdp('Runtime.enable');

/* ------------------------------------------------- clean slate + inject */

console.log('resetting app state…');
await fetch(`${DAEMON}/api/session`, { method: 'DELETE' }).catch(() => {});
await cdp('Page.reload', { ignoreCache: true });
await sleep(3500);
await evaluate('document.readyState');
await evaluate(`(()=>{try{localStorage.clear();sessionStorage.clear();}catch(e){}})()`);

const geom = await evaluate(
  '({x: window.screenX, y: window.screenY, w: window.innerWidth, h: window.innerHeight,' +
  ' ow: window.outerWidth, oh: window.outerHeight, dpr: window.devicePixelRatio})',
);
// Even pixel dimensions: libx264 with yuv420p cannot encode an odd width or height.
CROP = {
  x: geom.x, y: geom.y,
  w: geom.w - (geom.w % 2), h: geom.h - (geom.h % 2),
};
console.log('window geometry:', JSON.stringify(geom), '-> crop', JSON.stringify(CROP));

const durations = Object.fromEntries(
  JSON.parse(readFileSync(join(HERE, 'audio', 'manifest.json'), 'utf8')).map((s) => [s.id, s.seconds]),
);
await evaluate(`window.__DEMO_CFG = ${JSON.stringify({ durations, token: TOKEN, repo: REPO, project: PROJECT })};`);
await evaluate(readFileSync(join(HERE, 'demo.js'), 'utf8'));
if ((await evaluate('typeof window.__demo')) !== 'object') throw new Error('driver did not install');
console.log('driver injected.');

/* -------------------------------------------------------------- preflight */

/**
 * Three checks, each of which has cost a take.
 *
 * A locked screen is the one that hurt: the driver talks to the renderer over CDP, which works
 * perfectly whether or not anything is on screen, so a full five-minute run completed with
 * every mark logged and `failure: null` — and every frame was the lock screen. The take looked
 * like a success in the log and was worthless on disk. Nothing downstream can detect that, so
 * it is checked here, up front, and again against the actual captured pixels.
 */
function sh(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8' }); } catch { return ''; }
}

/**
 * Is the screen locked?
 *
 * Read from ioreg rather than pyobjc, because the first version shelled out to `python3` and
 * a missing Quartz module would have made the check return "not locked" — a safety check that
 * fails open is worse than no check, since it also stops anyone looking for the real one.
 * ioreg is part of macOS and cannot be absent.
 *
 * Note the key has no space before `=` in ioreg's output (`CGSSessionScreenIsLocked"=Yes`),
 * which is exactly the sort of detail that makes a grep silently never match.
 */
function screenLocked() {
  const out = sh('ioreg', ['-n', 'Root', '-d1', '-r']);
  if (out === '') throw new Error('could not read ioreg to determine whether the screen is locked');
  return /CGSSessionScreenIsLocked"?\s*=\s*Yes/.test(out);
}

/** 8x8 grey fingerprint, so the captured frame can be compared with what the app is drawing. */
function fingerprint(file) {
  const raw = execFileSync('ffmpeg',
    ['-v', 'error', '-i', file, '-vf', 'scale=8:8,format=gray', '-f', 'rawvideo', '-'],
    { maxBuffer: 1 << 20 });
  return [...raw];
}

async function verifyCapture() {
  if (screenLocked()) {
    throw new Error(
      'the screen is LOCKED — a recording would capture the lock screen, not the app.\n' +
      '  Unlock the Mac and run this again. (The app itself is fine; CDP does not need the screen.)');
  }

  const probe = join(OUT, 'preflight.mp4');
  const shot = join(OUT, 'preflight-capture.png');
  const ref = join(OUT, 'preflight-app.png');

  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'avfoundation', '-capture_cursor', '0', '-framerate', '30', '-i', '0:none', '-t', '1.2',
    '-vf', `crop=${CROP.w}:${CROP.h}:${CROP.x}:${CROP.y}`, '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', probe], { stdio: 'inherit' });
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-sseof', '-0.5', '-i', probe, '-frames:v', '1', shot]);

  // What the app believes it is drawing, straight from the renderer.
  const png = (await cdp('Page.captureScreenshot', { format: 'png' })).data;
  writeFileSync(ref, Buffer.from(png, 'base64'));

  const a = fingerprint(shot);
  const b = fingerprint(ref);
  const mad = a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
  console.log(`preflight: captured-vs-rendered difference ${mad.toFixed(1)} (0 = identical)`);
  if (mad > 28) {
    throw new Error(
      `the capture does not show the app (difference ${mad.toFixed(1)}).\n` +
      `  Something is covering the window, or it is on another Space.\n` +
      `  Compare ${shot} with ${ref}.`);
  }
}

/* ---------------------------------------------------------------- record */

// Bring the window forward and keep the machine awake for the whole take.
sh('osascript', ['-e', 'tell application "Electron" to activate']);
await sleep(1200);
const awake = spawn('caffeinate', ['-dimsu'], { stdio: 'ignore', detached: false });

await verifyCapture();


const args = [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'avfoundation', '-capture_cursor', '0', '-framerate', '30', '-i', '0:none',
  // Cropped AT CAPTURE, so nothing outside the app window is ever written to disk.
  '-vf', `crop=${CROP.w}:${CROP.h}:${CROP.x}:${CROP.y}`,
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
  join(OUT, 'raw.mp4'),
];
console.log(`recording ${CROP.w}x${CROP.h} at (${CROP.x},${CROP.y})…`);
const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'inherit'] });
await sleep(2500);                       // let the encoder settle before beat one

const started = Date.now();
let failure = null;
try {
  await evaluate('window.__demo.run()', true);
} catch (err) {
  failure = String(err.message ?? err);
  console.error(`\nTAKE FAILED: ${failure}`);
}
const wall = Date.now() - started;

await sleep(1200);
ff.stdin.write('q');                     // graceful stop, so the file is finalised
await new Promise((ok) => ff.on('exit', ok));
try { awake.kill(); } catch { /* already gone */ }

writeFileSync(join(OUT, 'marks.json'), JSON.stringify({
  crop: CROP, wallMs: wall, failure, marks: done?.marks ?? marks,
}, null, 1));

console.log(`\ntake: ${(wall / 1000).toFixed(1)}s, ${marks.length} marks -> ${join(OUT, 'marks.json')}`);
if (failure !== null) process.exit(1);
