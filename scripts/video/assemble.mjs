/**
 * Cut the edit from the driver's marks — one clock, never by eye.
 *
 * Each line's audio plays over the footage between its own mark and the next. Where the app
 * took longer than the line, the footage is speed-ramped down to fit; where it was quicker,
 * the last frame is held. A span the machine spent thinking gets no narration at all.
 *
 * Captions are NOT burned in. They would duplicate the voice and be timed by a second clock
 * that drifts against it. A real .srt is emitted from these same durations instead.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TAKE = process.argv[2];
const OUT = process.argv[3] ?? join(TAKE, 'notch-zerops-demo.mp4');
if (!TAKE) { console.error('usage: assemble.mjs <take-dir> [out.mp4]'); process.exit(1); }

const BREATH = 0.45;          // the pause the driver already held after each line
const SILENT_CAP = 5.0;       // a "machine is thinking" span is never longer than this
const W = 1920, H = 1080;

const ff = (args) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
const probe = (f) => Number(execFileSync('ffprobe',
  ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());

const raw = join(TAKE, 'raw.mp4');
const rawDur = probe(raw);
const { marks } = JSON.parse(readFileSync(join(TAKE, 'marks.json'), 'utf8'));
const dur = Object.fromEntries(
  JSON.parse(readFileSync(join(HERE, 'audio', 'manifest.json'), 'utf8')).map((s) => [s.id, s.seconds]));

const work = join(TAKE, 'segments');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

/*
 * A mark may name its own source file.
 *
 * Two of the beats are `notch check` failing a build, which cannot be filmed inside the app
 * window because the entire point is that the gate runs without the app. They are a second
 * take against a real terminal, spliced in at the position their narration belongs. A beat's
 * span ends at the next mark FROM THE SAME SOURCE — otherwise the last app beat before the
 * splice would be measured against a timestamp in a different recording.
 */
const durOf = new Map([[raw, rawDur]]);
const sourceOf = (m) => m.source ?? raw;
for (const m of marks) if (!durOf.has(sourceOf(m))) durOf.set(sourceOf(m), probe(sourceOf(m)));

const plan = marks.map((m, i) => {
  const src = sourceOf(m);
  const start = m.atMs / 1000;
  const nextSame = marks.slice(i + 1).find((n) => sourceOf(n) === src);
  const end = nextSame === undefined ? durOf.get(src) : nextSame.atMs / 1000;
  const span = Math.max(0.1, end - start);
  const audio = m.silent ? 0 : (dur[m.id] ?? 0);
  const target = m.silent ? Math.min(span, SILENT_CAP) : audio + BREATH;
  return { ...m, src, start, end, span, audio, target };
});

console.log('id                span    audio   target  action');
const parts = [];
for (const [i, p] of plan.entries()) {
  const out = join(work, `${String(i).padStart(2, '0')}-${p.id}.mp4`);
  const speed = p.span / p.target;
  let vf = `scale=${W}:${H}:flags=lanczos,setsar=1`;
  let action;

  if (speed > 1.005) {
    // Longer than its line: ramp it down so the picture keeps up with the voice.
    vf = `setpts=PTS/${speed.toFixed(6)},${vf}`;
    action = `speed x${speed.toFixed(3)}`;
  } else {
    // Shorter: hold the last frame. CLAMPED AT ZERO — once pacing matches, this can land a
    // hair negative and ffmpeg rejects `tpad` outright with "Result too large".
    const pad = Math.max(0, p.target - p.span);
    if (pad > 0.02) {
      vf = `${vf},tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}`;
      action = `hold +${pad.toFixed(2)}s`;
    } else {
      action = 'as-is';
    }
  }
  console.log(
    `${p.id.padEnd(16)} ${p.span.toFixed(2).padStart(6)} ${p.audio.toFixed(2).padStart(7)} ` +
    `${p.target.toFixed(2).padStart(7)}  ${action}`);

  const base = ['-ss', p.start.toFixed(3), '-t', p.span.toFixed(3), '-i', p.src];
  if (p.audio > 0) {
    ff([
      ...base, '-i', join(HERE, 'audio', `${p.id}.wav`),
      '-vf', vf,
      // apad BEFORE shortest, or a clip whose narration is shorter than its footage gets cut
      // to the length of the voice.
      '-af', 'apad',
      '-shortest',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      out,
    ]);
  } else {
    ff([
      ...base, '-f', 'lavfi', '-t', p.target.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo',
      '-vf', vf, '-shortest',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      out,
    ]);
  }
  parts.push(out);
}

const list = join(work, 'concat.txt');
writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', OUT]);

/* ------------------------------------------------------------------ srt */

const srtTime = (s) => {
  const ms = Math.round(s * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
  const sec = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  return `${h}:${m}:${sec},${String(ms % 1000).padStart(3, '0')}`;
};
const texts = Object.fromEntries(
  JSON.parse(readFileSync(join(HERE, 'narration.json'), 'utf8')).segments.map((s) => [s.id, s.text]));

let t = 0, n = 0, srt = '';
for (const p of plan) {
  if (p.audio > 0) {
    n += 1;
    srt += `${n}\n${srtTime(t)} --> ${srtTime(t + p.audio)}\n${texts[p.id]}\n\n`;
  }
  t += p.target;
}
writeFileSync(OUT.replace(/\.mp4$/, '.srt'), srt);

const finalDur = probe(OUT);
console.log(`\n${OUT}`);
console.log(`duration ${finalDur.toFixed(1)}s (${(finalDur / 60).toFixed(2)} min), ${parts.length} segments`);
console.log(`subtitles ${OUT.replace(/\.mp4$/, '.srt')} (${n} cues)`);
