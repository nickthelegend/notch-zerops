/**
 * The CI beats: `notch check` failing a build, in a real terminal.
 *
 * These two lines cannot be recorded inside the app window — the whole point is that the gate
 * runs WITHOUT the app — so they are a second take against a real Terminal window, cropped to
 * it the same way. Nothing is typed by hand and nothing is staged: the window is opened with
 * the command already in it, the command really runs against the real account, and the exit
 * code you see is the one it returned.
 *
 * The two takes are spliced by `assemble.mjs`, which reads a `source` on each mark.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = process.argv[2] ?? join(HERE, 'out', 'terminal');
const BEATS = ['15-ci', '16-ci2'];
const BREATH = 0.45;

const TOKEN = process.env['ZEROPS_TOKEN'] ?? '';
const PROJECT = process.env['DEMO_PROJECT_CI'] ?? 'test';
if (TOKEN === '') { console.error('set ZEROPS_TOKEN'); process.exit(1); }

mkdirSync(OUT, { recursive: true });
const durations = Object.fromEntries(
  JSON.parse(readFileSync(join(HERE, 'audio', 'manifest.json'), 'utf8')).map((s) => [s.id, s.seconds]));
const need = BEATS.reduce((n, b) => n + (durations[b] ?? 0) + BREATH, 0);

/**
 * Window bounds from Quartz, never from AppleScript.
 *
 * Asking AppleScript to resize Terminal needs Automation permission, and the consent dialog
 * opens ON TOP of the window being recorded — the first attempt captured the prompt itself,
 * over an unresized window, over the app behind it. Reading the window list needs no such
 * permission, and the window is sized by the shell from inside instead.
 */
const PY = process.env['DEMO_PYTHON']
  ?? '/tmp/claude-501/-Volumes-Extreme-SSD-Projects-wemakedevs/9450471a-cfcc-4f79-a7e0-84ef3e84ef16/scratchpad/venv-cursor/bin/python';

function terminalBounds() {
  const out = execFileSync(PY, ['-c', `
import Quartz, json
ws = Quartz.CGWindowListCopyWindowInfo(
    Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
    Quartz.kCGNullWindowID)
t = [w for w in ws if w.get('kCGWindowOwnerName') == 'Terminal' and w.get('kCGWindowLayer') == 0]
t.sort(key=lambda w: -w['kCGWindowBounds']['Width'] * w['kCGWindowBounds']['Height'])
print(json.dumps(dict(t[0]['kCGWindowBounds'])) if t else 'null')
`], { encoding: 'utf8' }).trim();
  return out === 'null' ? null : JSON.parse(out);
}

/*
 * A .command file opened with `open`, not AppleScript's `do script`.
 *
 * `do script` needs Automation permission for Terminal and hangs on the consent prompt — the
 * first attempt died with AppleEvent timeout -1712 having already opened the window. `open`
 * needs no such permission: the file is executable, Terminal runs it because that is what a
 * .command file is for, and the command is the real one.
 */
const script = join(OUT, 'run-check.command');
writeFileSync(script, [
  '#!/bin/bash',
  `cd '${ROOT.replace(/'/g, "'\\''")}'`,
  // Resize from INSIDE the shell. The xterm control sequence Terminal.app honours, so the
  // window becomes frame-sized without anything asking permission to control it.
  `printf '\\e[8;42;150t'`,
  'sleep 0.4',
  'clear',
  `printf '$ notch check --project ${PROJECT} --dir ./demo\\n\\n'`,
  `ZEROPS_TOKEN='${TOKEN}' npm run -s check -- --project ${PROJECT} --dir ./demo`,
  `printf '\\nexit code: %s\\n' "$?"`,
  '',
].join('\n'), { mode: 0o700 });

console.log('opening Terminal…');
execFileSync('open', ['-a', 'Terminal', script]);
await sleep(4500);                    // launch, resize, and get the command running

/*
 * Front it again, and CHECK that it is in front.
 *
 * Quartz reports where a window is, not what is on top of it. A take cropped to Terminal's
 * bounds while Terminal sat behind the editor recorded the editor perfectly — right rectangle,
 * wrong window, and nothing in the log said so. Focus can move between opening the window and
 * starting the encoder, so it is re-fronted here and the stacking order is verified.
 */
const frontApp = () => execFileSync(PY, ['-c', `
import Quartz
ws = Quartz.CGWindowListCopyWindowInfo(
    Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
    Quartz.kCGNullWindowID)
top = [w for w in ws if w.get('kCGWindowLayer') == 0]
print(top[0].get('kCGWindowOwnerName') if top else 'none')
`], { encoding: 'utf8' }).trim();

/*
 * Front it, and keep fronting it until it stays.
 *
 * Whatever is driving this script is itself an app with focus, and it takes focus back within a
 * second or so of `open`. A single attempt loses that race roughly every other run, and losing
 * it silently produced forty seconds of somebody's editor in the middle of the finished cut.
 */
let front = '';
for (let i = 0; i < 6; i += 1) {
  execFileSync('open', ['-a', 'Terminal']);
  await sleep(1500);
  front = frontApp();
  if (front === 'Terminal') break;
}
if (front !== 'Terminal') {
  console.error(`refusing to record: "${front}" keeps taking focus from Terminal; the crop would capture it.`);
  process.exit(2);
}
// A floating recorder bar draws over everything, including this.
try { execFileSync('pkill', ['-x', 'TapRecord']); } catch { /* not running */ }

const b = terminalBounds();
if (b === null) { console.error('no Terminal window on screen'); process.exit(2); }
const crop = {
  x: Math.round(b.X), y: Math.round(b.Y),
  w: Math.round(b.Width) - (Math.round(b.Width) % 2),
  h: Math.round(b.Height) - (Math.round(b.Height) % 2),
};
console.log('crop', JSON.stringify(crop), `— recording ${need.toFixed(1)}s`);

const ff = spawn('ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'avfoundation', '-capture_cursor', '0', '-framerate', '30', '-i', '0:none',
  '-vf', `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`,
  '-t', String(Math.ceil(need + 2)),
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
  join(OUT, 'raw.mp4'),
], { stdio: ['pipe', 'ignore', 'inherit'] });

await new Promise((ok) => ff.on('exit', ok));

// Marks relative to THIS take, each naming its own source file.
let at = 0;
const marks = BEATS.map((id) => {
  const m = { id, atMs: Math.round(at * 1000), source: join(OUT, 'raw.mp4') };
  at += (durations[id] ?? 0) + BREATH;
  return m;
});
writeFileSync(join(OUT, 'marks.json'), JSON.stringify({ crop, marks }, null, 1));
console.log(`done -> ${join(OUT, 'raw.mp4')}`);
