#!/usr/bin/env python3
"""
Narration, spoken by Kokoro.

One WAV per segment rather than one long track, because the recording is driven by a real
cursor against a real API and the beats do not take a predictable amount of time. Segments are
placed onto the finished video at measured offsets afterwards (see mux.sh), so a slow Zerops
response stretches the pause before the next line instead of desynchronising everything after
it.

Model files are the ones already cached on this machine; nothing is downloaded.
"""
import json
import os
import sys
import wave
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

HERE = Path(__file__).resolve().parent
CACHE = Path.home() / ".cache" / "hyperframes" / "tts"
MODEL = CACHE / "models" / "kokoro-v1.0.onnx"
VOICES = CACHE / "voices" / "voices-v1.0.bin"

out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "audio"
out_dir.mkdir(parents=True, exist_ok=True)

for p in (MODEL, VOICES):
    if not p.exists():
        sys.exit(f"missing model file: {p}")

spec = json.loads((HERE / "narration.json").read_text())
kokoro = Kokoro(str(MODEL), str(VOICES))

manifest = []
total = 0.0
for seg in spec["segments"]:
    samples, rate = kokoro.create(seg["text"], voice=spec["voice"], speed=spec.get("speed", 1.0), lang="en-us")
    path = out_dir / f"{seg['id']}.wav"
    sf.write(path, samples, rate)
    dur = len(samples) / rate
    total += dur
    manifest.append({"id": seg["id"], "file": path.name, "seconds": round(dur, 2), "text": seg["text"]})
    print(f"{seg['id']:14s} {dur:6.2f}s  {path.name}")

(out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1))
print(f"\n{len(manifest)} segments, {total:.1f}s of speech ({total/60:.2f} min)")
print(f"manifest: {out_dir / 'manifest.json'}")
