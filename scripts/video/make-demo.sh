#!/usr/bin/env bash
#
# One command: reset, record, cut.
#
#   ZEROPS_TOKEN=... ./scripts/video/make-demo.sh
#
# Requires an UNLOCKED screen — the recorder checks and refuses otherwise, because a locked
# Mac records the lock screen while the driver reports a perfect run.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${OUT_DIR:-$HERE/out}"
TAKE="$OUT/take"
: "${ZEROPS_TOKEN:?set ZEROPS_TOKEN}"
PROJECT="${DEMO_PROJECT:-acme-notes-demo}"

mkdir -p "$TAKE"

echo "==> deleting any previous '$PROJECT' so the take creates it live"
ZEROPS_TOKEN="$ZEROPS_TOKEN" node - <<'EOF'
const B='https://api.app-prg1.zerops.io/api/rest/public', T=process.env.ZEROPS_TOKEN;
const call=async(m,p,b)=>{const r=await fetch(B+p,{method:m,headers:{authorization:'Bearer '+T,accept:'application/json',...(b?{'content-type':'application/json'}:{})},...(b?{body:JSON.stringify(b)}:{})});return{s:r.status,t:await r.text()};};
const u=JSON.parse((await call('GET','/user/info')).t), cid=u.clientUserList[0].clientId;
const l=JSON.parse((await call('POST','/project/search',{search:[{name:'clientId',operator:'eq',value:cid}]})).t);
const name=process.env.DEMO_PROJECT||'acme-notes-demo';
for(const p of l.items) if(p.name===name) console.log('   deleted ->',(await call('DELETE','/project/'+p.id)).s);
process.exit(0);
EOF

echo "==> narration"
python3 "$HERE/tts.py" >/dev/null
python3 - <<EOF
import json;m=json.load(open("$HERE/audio/manifest.json"))
print(f"   {len(m)} lines, {sum(s['seconds'] for s in m):.1f}s of speech")
EOF

echo "==> launching the desktop app pinned to the recording geometry"
NOTCH_DEMO_SAVE_DIR="$OUT" ELECTRON_LOG="$OUT/electron.log" "$HERE/launch.sh"

echo "==> recording"
ZEROPS_TOKEN="$ZEROPS_TOKEN" DEMO_PROJECT="$PROJECT" node "$HERE/shoot.mjs" "$TAKE"

echo "==> cutting the edit from the marks"
node "$HERE/assemble.mjs" "$TAKE" "$OUT/notch-zerops-demo.mp4"

echo
echo "video : $OUT/notch-zerops-demo.mp4"
echo "subs  : $OUT/notch-zerops-demo.srt"
