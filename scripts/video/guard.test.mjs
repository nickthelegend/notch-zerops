/**
 * The verifier's own tests.
 *
 * Four takes were lost to a file that passed every check it had — because each check was
 * written after the failure it describes, so the next new failure mode always got through.
 * A browser window sat over the first four seconds of a DELIVERED cut and nothing objected.
 *
 * These fixtures are synthesised, so they run in a second and cannot rot: a Notch-like dark
 * frame, a never-painted frame, and a dark frame with a light-mode window pasted into each
 * edge. If `foreign()` ever stops catching one of those, this fails.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const W = join('/tmp', `guardtest-${process.pid}`);
rmSync(W, { recursive: true, force: true });
mkdirSync(W, { recursive: true });

/** Build a 320x180 PNG: dark ground, a strip of white text-ish pixels, plus an optional window. */
function frame(name, { ground = 0x11, textRow = true, window: win = null, blank = false } = {}) {
  const f = join(W, `${name}.png`);
  const filters = [`color=c=0x${ground.toString(16).repeat(3)}:s=320x180`];
  const inputs = ['-f', 'lavfi', '-i', filters[0]];
  let vf = 'null';
  if (!blank && textRow) {
    // A band of near-white pixels standing in for UI text on the dark ground.
    vf = 'drawbox=x=40:y=80:w=120:h=6:color=0xaaaaaa:t=fill';
  }
  if (win !== null) {
    const boxes = {
      l: 'drawbox=x=0:y=0:w=90:h=180:color=white:t=fill',
      r: 'drawbox=x=230:y=0:w=90:h=180:color=white:t=fill',
      t: 'drawbox=x=0:y=0:w=320:h=50:color=white:t=fill',
      b: 'drawbox=x=0:y=130:w=320:h=50:color=white:t=fill',
    };
    vf = vf === 'null' ? boxes[win] : `${vf},${boxes[win]}`;
  }
  execFileSync('ffmpeg', ['-v', 'error', ...inputs, '-vf', vf, '-frames:v', '1', '-y', f]);
  return f;
}

/* Reuse the verifier's own maths by importing nothing — call it as the tool, on a 1-frame mp4. */
const asVideo = (png) => {
  const mp4 = png.replace('.png', '.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-loop', '1', '-i', png, '-t', '3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-y', mp4]);
  return mp4;
};

const run = (mp4) => {
  try {
    execFileSync('node', ['verify.mjs', mp4, '1'], { encoding: 'utf8', stdio: 'pipe' });
    return { ok: true, out: '' };
  } catch (e) {
    return { ok: false, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
};

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!cond) failures += 1;
};

// A clean Notch-like frame must pass.
const clean = run(asVideo(frame('clean')));
check('a dark UI frame with light text passes', clean.ok);

// A never-painted frame must be caught as blank.
const blank = run(asVideo(frame('blank', { blank: true })));
check('a never-painted frame is caught', !blank.ok && /blank/.test(blank.out));

// A foreign window on any edge must be caught.
for (const side of ['l', 'r', 't', 'b']) {
  const r = run(asVideo(frame(`win-${side}`, { window: side })));
  check(`a light window on the ${side} edge is caught`, !r.ok && /another window/.test(r.out));
}

rmSync(W, { recursive: true, force: true });
console.log(failures === 0 ? '\nall guard tests pass' : `\n${failures} guard test(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
