/** A frame from the middle of every beat, laid out as a contact sheet with its id burned on. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TAKE = 'out', VIDEO = join(TAKE, 'notch-zerops-demo.mp4');
const BREATH = 0.45, SILENT_CAP = 5.0;
const dur = Object.fromEntries(JSON.parse(readFileSync('audio/manifest.json', 'utf8')).map((s) => [s.id, s.seconds]));
const { marks } = JSON.parse(readFileSync(join(TAKE, 'marks.json'), 'utf8'));
const rawDur = Number(execFileSync('ffprobe', ['-v','error','-show_entries','format=duration','-of','csv=p=0', join(TAKE,'raw.mp4')]).toString().trim());

const beats = [{ id: 'intro', target: 34.53 }];
marks.forEach((m, i) => {
  const end = i + 1 < marks.length ? marks[i + 1].atMs / 1000 : rawDur;
  const full = Math.max(0.1, end - m.atMs / 1000);
  beats.push({ id: m.id, target: m.silent ? Math.min(full, SILENT_CAP) : (dur[m.id] ?? 0) + BREATH });
});
beats.push({ id: 'outro', target: 13.33 });

const work = '/tmp/contact'; rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });
let t = 0; const tiles = [];
for (const [i, b] of beats.entries()) {
  const at = t + b.target / 2;
  const f = join(work, `${String(i).padStart(2,'0')}.png`);
  execFileSync('ffmpeg', ['-v','error','-ss', at.toFixed(2), '-i', VIDEO, '-frames:v','1',
    '-vf', 'scale=560:-1', '-y', f]);
  console.log(`${String(i).padStart(2,'0')}  ${b.id.padEnd(16)} @${Math.round(at)}s`);
  tiles.push(f); t += b.target;
}
const list = join(work, 'list.txt');
execFileSync('bash', ['-c', `printf '%s\\n' ${tiles.map((x)=>`'${x}'`).join(' ')} > ${list}`]);
execFileSync('ffmpeg', ['-v','error','-f','image2','-pattern_type','glob','-i', join(work,'*.png'),
  '-filter_complex', `tile=4x6:margin=8:padding=6:color=#101010`, '-frames:v','1','-y', join(TAKE,'contact.png')]);
console.log(`${tiles.length} beats -> ${join(TAKE,'contact.png')}`);
