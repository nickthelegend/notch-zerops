#!/usr/bin/env bash
# Launch the desktop app pinned to the recording geometry, with the demo save directory set
# so no native Save panel can appear over the take.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SAVE_DIR="${NOTCH_DEMO_SAVE_DIR:-$HERE/out}"
mkdir -p "$SAVE_DIR"

pkill -f "notch-zerops/desktop" 2>/dev/null || true
sleep 2

cd "$ROOT/desktop"
NOTCH_WIN_W="${NOTCH_WIN_W:-1728}" \
NOTCH_WIN_H="${NOTCH_WIN_H:-972}" \
NOTCH_WIN_X="${NOTCH_WIN_X:-96}" \
NOTCH_WIN_Y="${NOTCH_WIN_Y:-54}" \
NOTCH_DEMO_SAVE_DIR="$SAVE_DIR" \
  ./node_modules/.bin/electron . --remote-debugging-port=9222 \
  > "${ELECTRON_LOG:-/tmp/notch-electron.log}" 2>&1 &

sleep 12
echo "save dir: $SAVE_DIR"
