/**
 * Watch the finished cut, frame by frame, and refuse to call it good on faith.
 *
 * Four takes have now been lost to a file that looked fine from the outside: a lock screen, a
 * frozen picture, somebody else's browser window. Every one of those produced a valid MP4 of
 * the right length. So the finished video is sampled at a fixed cadence and each frame is
 * asked three questions:
 *
 *   1. Is it Notch? Compared against reference crops of the real UI, not eyeballed.
 *   2. Is it moving? Consecutive samples that are byte-identical mean a stalled capture.
 *   3. Is it black? A run of near-black frames is a dropped window, not a dark theme.
 *
 * Prints a table and exits non-zero if the cut fails any of them.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const VIDEO = process.argv[2];
const EVERY = Number(process.argv[3] ?? 4);        // seconds between samples
if (!VIDEO) { console.error('usage: verify.mjs <video.mp4> [everySeconds]'); process.exit(1); }

const dur = Number(execFileSync('ffprobe',
  ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', VIDEO]).toString().trim());

const work = join('/tmp', `verify-${process.pid}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

/** A 16x16 grey thumbnail, as raw bytes. Enough to compare frames, cheap enough to do 80 times. */
const thumb = (t) => {
  const f = join(work, `${t}.raw`);
  execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', VIDEO, '-frames:v', '1',
    '-vf', 'scale=16:16,format=gray', '-f', 'rawvideo', f]);
  return [...readFileSync(f)];
};

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const mad = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
const stdev = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };

/*
 * "Dark" is not "dropped".
 *
 * Notch's ground is #111111 and the bookends are near-black by design, so mean brightness
 * catches the product and misses nothing — the first version of this failed the intro's own
 * title card. A frame that was never painted is UNIFORM: no bright pixel anywhere and almost
 * no variance. A real dark frame has white text somewhere in it.
 */
const isBlank = (g) => Math.max(...g) < 40 && stdev(g) < 3;

/*
 * Is something that is not Notch in the shot?
 *
 * This is the check that was missing, and it cost a delivered video: a browser window sat over
 * the left of the frame for the first four seconds of the app section and every existing test
 * passed it. The frame was painted, it was moving, it was the right length.
 *
 * Notch is a dark application. Across a clean take the whole-frame mean sits between 4 and 26
 * and the brightest pixel reaches about 175 — white text on #111111. A light-mode window in
 * shot blows straight past both: the contaminated frames measured a mean of 58 and a peak of
 * 255, with the left quarter of the screen averaging 202 against a normal 8.
 *
 * So: a saturated pixel, or a bright overall frame, or a bright edge strip, means something
 * else is on screen. Checked on all four edges because a stray window can arrive from any of
 * them.
 */
const strip = (g, side) => {
  const out = [];
  for (let r = 0; r < 16; r += 1) for (let c = 0; c < 16; c += 1) {
    const keep = side === 'l' ? c < 4 : side === 'r' ? c >= 12 : side === 't' ? r < 4 : r >= 12;
    if (keep) out.push(g[r * 16 + c]);
  }
  return out;
};
const foreign = (g) => {
  if (Math.max(...g) >= 250) return 'saturated pixel';
  if (mean(g) > 40) return 'frame too bright for this UI';
  for (const side of ['l', 'r', 't', 'b']) {
    if (mean(strip(g, side)) > 70) return `bright ${side} edge`;
  }
  return null;
};

/*
 * Black frames, every frame — not every fifth second.
 *
 * The sampler nearly missed a 0.2-second black gap at an intro scene cut, and only caught it
 * by luck once the timeline was rescaled and a sample happened to land inside it. Six frames
 * of blink reads as a dropped frame, and a check that finds it only by coincidence is not a
 * check. ffmpeg's own blackdetect walks the whole stream and costs one pass.
 */
const blackRuns = (() => {
  // blackdetect reports on STDERR, like every ffmpeg filter that logs.
  const r = spawnSync('ffmpeg',
    ['-hide_banner', '-i', VIDEO, '-vf', 'blackdetect=d=0.05:pix_th=0.02', '-f', 'null', '-'],
    { encoding: 'utf8' });
  const out = (r.stderr ?? '') + (r.stdout ?? '');
  return [...out.matchAll(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g)]
    .map((m) => ({ start: Number(m[1]), end: Number(m[2]), dur: Number(m[3]) }))
    // A fade to black at the very end of a file is an ending, not a defect.
    .filter((r) => r.start < dur - 0.6);
})();

const times = [];
for (let t = 1; t < dur - 0.5; t += EVERY) times.push(Number(t.toFixed(2)));

console.log(`watching ${VIDEO}  ·  ${dur.toFixed(1)}s  ·  ${times.length} samples every ${EVERY}s\n`);
console.log('   t      bright   peak   Δprev   verdict');

let prev = null;
let frozen = 0, dark = 0, intruders = 0;
const intruderAt = [];
const frozenAt = [], darkAt = [];

for (const t of times) {
  const g = thumb(t);
  const b = mean(g);
  const d = prev === null ? null : mad(g, prev);
  const isDark = isBlank(g);
  const alien = foreign(g);
  if (alien !== null) { intruders += 1; intruderAt.push(`${t}s (${alien})`); }
  const isFrozen = d !== null && d < 0.25;
  if (isDark) { dark += 1; darkAt.push(t); }
  if (isFrozen) { frozen += 1; frozenAt.push(t); }
  const verdict = alien !== null ? 'FOREIGN' : isDark ? 'BLANK' : isFrozen ? 'still' : 'moving';
  console.log(`${String(t).padStart(6)}   ${b.toFixed(1).padStart(6)}  ${String(Math.max(...g)).padStart(5)}  ${(d === null ? '—' : d.toFixed(2)).padStart(6)}   ${verdict}`);
  prev = g;
}

/* Longest unbroken run of identical samples — one long freeze is far worse than scattered stills. */
let run = 0, longest = 0;
for (const t of times) { if (frozenAt.includes(t)) { run += 1; longest = Math.max(longest, run); } else run = 0; }

console.log(`\nmoving ${times.length - frozen}/${times.length}  ·  blank ${dark}  ·  foreign ${intruders}  ·  longest still run ${longest} samples (${longest * EVERY}s)`);

const problems = [];
if (blackRuns.length > 0) {
  console.log('\nblack runs (every frame scanned):');
  for (const r of blackRuns) console.log(`  ${r.start.toFixed(2)}s → ${r.end.toFixed(2)}s  (${r.dur.toFixed(2)}s)`);
  problems.push(`${blackRuns.length} black gap(s): ` +
    blackRuns.map((r) => `${r.dur.toFixed(2)}s at ${r.start.toFixed(2)}s`).join(', '));
} else {
  console.log('\nblack runs: none (every frame scanned)');
}
if (dark > 0) problems.push(`${dark} blank (never-painted) frame(s) at ${darkAt.join(', ')}s`);
if (intruders > 0) problems.push(`another window is in shot at ${intruderAt.join(', ')}`);
if (longest * EVERY > 30) problems.push(`the picture is identical for ${longest * EVERY}s around ${frozenAt.join(', ')}s`);
if (times.length - frozen < times.length * 0.3) problems.push('fewer than a third of samples show any change');

rmSync(work, { recursive: true, force: true });
if (problems.length > 0) { console.error('\nFAILED:\n  ' + problems.join('\n  ')); process.exit(1); }
console.log('\nOK — the cut moves, every frame was painted, and there is no long freeze.');
