#!/usr/bin/env python3
"""
Drive the real Notch desktop app with the real macOS cursor, on the narration's clock.

WHY NOT A SCREEN-RECORDER MACRO, AND WHY NOT SYNTHETIC CLICKS:

  * The cursor is the OS cursor, moved with CoreGraphics events, so a screen recording
    captures it exactly as a viewer would see it — no drawn-on pointer, no overlay.
  * Targets are resolved by asking the running page where its elements ARE (over CDP) rather
    than by hard-coding pixels, so a re-layout does not silently produce a video of the cursor
    clicking empty space.
  * Waits are predicates against the live app and the live daemon (`until(...)`), never fixed
    sleeps, so a slow Zerops response makes the pause longer instead of producing footage of a
    half-rendered screen.

TIMING. Each beat is given the exact duration of its narration segment, read from the audio
manifest. Work inside a beat (typing, waiting for the API) is subtracted from that budget and
the remainder is spent holding still, so the finished video lines up with the voice track
without anything being sped up or cut.
"""
import json
import math
import subprocess
import sys
import time
from pathlib import Path

import Quartz
import websocket

HERE = Path(__file__).resolve().parent
AUDIO = HERE / "audio"
DAEMON = "http://127.0.0.1:7799"
CDP_LIST = "http://127.0.0.1:9222/json/list"

REPO = "/Volumes/Extreme SSD/Projects/wemakedevs/notch-zerops/demo"
PROJECT_NAME = sys.argv[1] if len(sys.argv) > 1 else "acme-notes-demo"
TOKEN = __import__("os").environ.get("ZEROPS_TOKEN", "")
if TOKEN == "":
    sys.exit("set ZEROPS_TOKEN")

DUR = {s["id"]: s["seconds"] for s in json.loads((AUDIO / "manifest.json").read_text())}
MARKS = []
T0 = None

# ---------------------------------------------------------------- CDP

def cdp_connect():
    import urllib.request
    raw = json.loads(urllib.request.urlopen(CDP_LIST).read())
    page = next(t for t in raw if t["type"] == "page")
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], suppress_origin=True)
    return ws

WS = cdp_connect()
_seq = [0]

def ev(expr):
    """Evaluate in the page, return the JSON value."""
    _seq[0] += 1
    WS.send(json.dumps({
        "id": _seq[0], "method": "Runtime.evaluate",
        "params": {"expression": expr, "returnByValue": True, "awaitPromise": True},
    }))
    while True:
        msg = json.loads(WS.recv())
        if msg.get("id") == _seq[0]:
            if "error" in msg:
                raise RuntimeError(msg["error"])
            r = msg["result"]
            if r.get("exceptionDetails"):
                raise RuntimeError(r["exceptionDetails"].get("text", "page threw"))
            return r["result"].get("value")

def until(expr, what, timeout=90):
    """Wait for a real predicate in the page. Never a fixed sleep."""
    end = time.time() + timeout
    while time.time() < end:
        try:
            if ev(expr) is True:
                return
        except Exception:
            pass
        time.sleep(0.25)
    raise TimeoutError(f"timed out waiting for {what}")

# ---------------------------------------------------------- window / cursor

def window_origin():
    wins = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
        Quartz.kCGNullWindowID)
    for w in wins:
        if w.get("kCGWindowOwnerName") == "Electron":
            b = w["kCGWindowBounds"]
            return b["X"], b["Y"], b["Width"], b["Height"]
    raise RuntimeError("the Notch window is not on screen")

WX, WY, WW, WH = window_origin()
inner_w = ev("window.innerWidth")
inner_h = ev("window.innerHeight")
# hiddenInset keeps the web contents flush with the window frame; assert rather than assume,
# because a mismatch would put every click a fixed distance from where it looks like it is.
if abs(inner_w - WW) > 2:
    sys.exit(f"content width {inner_w} != window width {WW}; coordinate mapping would be wrong")
CONTENT_DY = WH - inner_h

def to_screen(x, y):
    return WX + x, WY + CONTENT_DY + y

def cursor_now():
    e = Quartz.CGEventCreate(None)
    p = Quartz.CGEventGetLocation(e)
    return p.x, p.y

def post(kind, x, y):
    e = Quartz.CGEventCreateMouseEvent(None, kind, (x, y), Quartz.kCGMouseButtonLeft)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)

def glide(x, y, seconds=0.55):
    """Ease the cursor across, so the recording reads as a hand rather than a teleport."""
    sx, sy = cursor_now()
    steps = max(2, int(seconds * 60))
    for i in range(1, steps + 1):
        t = i / steps
        e = 1 - pow(1 - t, 3)          # ease-out cubic
        post(Quartz.kCGEventMouseMoved, sx + (x - sx) * e, sy + (y - sy) * e)
        time.sleep(seconds / steps)

def click_at(x, y, settle=0.35):
    glide(x, y)
    time.sleep(0.12)
    post(Quartz.kCGEventLeftMouseDown, x, y)
    time.sleep(0.06)
    post(Quartz.kCGEventLeftMouseUp, x, y)
    time.sleep(settle)

def rect(js_selector_expr):
    """Centre of an element, in screen points. Raises if it is not on screen."""
    r = ev(f"(()=>{{const e={js_selector_expr}; if(!e) return null; const r=e.getBoundingClientRect();"
           f"return r.width>0&&r.height>0?{{x:r.x+r.width/2,y:r.y+r.height/2}}:null;}})()")
    if r is None:
        raise RuntimeError(f"element not on screen: {js_selector_expr}")
    return to_screen(r["x"], r["y"])

def by_text(text, tag="div,span"):
    """Notch renders buttons as Views, so target by their text, deepest node wins."""
    t = json.dumps(text)
    return (f"[...document.querySelectorAll({json.dumps(tag)})]"
            f".filter(e=>e.textContent.trim()==={t}&&e.children.length===0).pop()")

def click_text(text, settle=0.35):
    x, y = rect(by_text(text))
    click_at(x, y, settle)

def type_text(s, cps=26):
    """Type with the real keyboard, at a speed a human could read along with."""
    for ch in s:
        e_dn = Quartz.CGEventCreateKeyboardEvent(None, 0, True)
        Quartz.CGEventKeyboardSetUnicodeString(e_dn, len(ch), ch)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, e_dn)
        e_up = Quartz.CGEventCreateKeyboardEvent(None, 0, False)
        Quartz.CGEventKeyboardSetUnicodeString(e_up, len(ch), ch)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, e_up)
        time.sleep(1.0 / cps)

KEY = {"return": 36, "g": 5, "escape": 53}

def key(name, cmd=False, shift=False):
    flags = 0
    if cmd:
        flags |= Quartz.kCGEventFlagMaskCommand
    if shift:
        flags |= Quartz.kCGEventFlagMaskShift
    for down in (True, False):
        e = Quartz.CGEventCreateKeyboardEvent(None, KEY[name], down)
        Quartz.CGEventSetFlags(e, flags)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)
        time.sleep(0.05)

# ---------------------------------------------------------------- beats

def beat(seg_id):
    """Open a beat: record its offset from the start of the recording."""
    global T0
    now = time.time()
    if T0 is None:
        T0 = now
    MARKS.append({"id": seg_id, "at": round(now - T0, 3), "seconds": DUR[seg_id]})
    print(f"[{now - T0:7.2f}] {seg_id}  ({DUR[seg_id]}s)", flush=True)
    return now

def hold(started, seg_id, extra=0.0):
    """Spend whatever is left of this beat's narration budget holding still."""
    target = DUR[seg_id] + extra
    left = target - (time.time() - started)
    if left > 0:
        time.sleep(left)

def drift(x, y, seconds):
    """A small idle wander, so a long hold does not look like a frozen frame."""
    end = time.time() + seconds
    i = 0
    while time.time() < end:
        post(Quartz.kCGEventMouseMoved, x + 9 * math.sin(i / 7), y + 6 * math.cos(i / 9))
        time.sleep(1 / 30)
        i += 1

# =================================================================== script

print(f"window {WW}x{WH} at ({WX},{WY}); content offset {CONTENT_DY}px", flush=True)

# --- 01 intro: the gate, untouched.
t = beat("01-intro")
cx, cy = to_screen(inner_w * 0.5, inner_h * 0.62)
glide(cx, cy, 1.2)
drift(cx, cy, max(0.0, DUR["01-intro"] - 2.0))
hold(t, "01-intro")

# --- 02 token
t = beat("02-token")
x, y = rect("document.querySelector('input')")
click_at(x, y)
type_text(TOKEN, cps=34)
hold(t, "02-token")

# --- 03 connect
t = beat("03-connected")
click_text("Connect")
until("!!document.querySelector('input.dir, input[placeholder*=\"/path\"]')"
      "|| /niveshgajengi|token/.test(document.body.innerText)", "the dashboard")
time.sleep(1.0)
hx, hy = to_screen(inner_w * 0.5, 120)
drift(hx, hy, 2.0)
hold(t, "03-connected")

# --- 04 create a project
t = beat("04-create")
click_text("New project", settle=0.8)
until(f"document.body.innerText.includes('CREATE AN EMPTY PROJECT')", "the create form")
x, y = rect("[...document.querySelectorAll('input')].find(i=>(i.placeholder||'').includes('project name'))")
click_at(x, y)
type_text(PROJECT_NAME)
time.sleep(0.4)
click_text("Create", settle=1.0)
until(f"document.body.innerText.includes({json.dumps(PROJECT_NAME)})", "the new project", timeout=120)
hold(t, "04-create")

# --- 05 native folder picker
t = beat("05-picker")
click_text("Choose…", settle=1.6)
key("g", cmd=True, shift=True)          # "Go to the folder" in the macOS open panel
time.sleep(0.9)
type_text(REPO, cps=40)
time.sleep(0.6)
key("return")
time.sleep(1.1)
key("return")                            # confirm Open
until("(()=>{const i=[...document.querySelectorAll('input')]"
      ".find(i=>(i.placeholder||'').includes('/path'));return !!i&&i.value.length>0;})()",
      "the chosen folder to land in the field", timeout=60)
hold(t, "05-picker")

# --- 06 scan
t = beat("06-scan")
click_text("Scan repo", settle=0.5)
until("/\\d+ missing|MISSING/.test(document.body.innerText)", "the scan", timeout=120)
ax, ay = to_screen(inner_w * 0.45, inner_h * 0.5)
glide(ax, ay, 0.8)
hold(t, "06-scan")

# --- 07 the ghosts on the canvas
t = beat("07-ghosts")
drift(ax, ay, DUR["07-ghosts"] - 1.0)
hold(t, "07-ghosts")

# --- 08 evidence
t = beat("08-evidence")
click_text("Drift (7)", settle=0.8)
sx, sy = to_screen(inner_w * 0.5, inner_h * 0.62)
glide(sx, sy, 0.7)
for _ in range(3):
    e = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, 1, -3)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)
    time.sleep(0.5)
hold(t, "08-evidence")

# --- 09 the streak line
t = beat("09-history")
for _ in range(2):
    e = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, 1, -2)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)
    time.sleep(0.6)
drift(sx, sy, 4.0)
hold(t, "09-history")

# --- 10 the plan
t = beat("10-plan")
for _ in range(6):
    e = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, 1, 4)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)
    time.sleep(0.15)
time.sleep(0.5)
click_text("Provision 7 missing…", settle=1.0)
until("document.body.innerText.includes('THIS WILL CREATE')", "the import file", timeout=120)
hold(t, "10-plan")

# --- 11 the secrets
t = beat("11-secrets")
ev("(()=>{const p=[...document.querySelectorAll('div')].find(e=>e.textContent.startsWith('services:')&&!e.children.length);"
   "let el=p;while(el&&el.scrollHeight<=el.clientHeight+4)el=el.parentElement;if(el)el.scrollTop=el.scrollHeight;})()")
px, py = to_screen(inner_w * 0.5, inner_h * 0.25)
glide(px, py, 0.9)
drift(px, py, DUR["11-secrets"] - 3.0)
hold(t, "11-secrets")

# --- 12 provision for real
t = beat("12-provision")
click_text("Confirm and create", settle=0.5)
hold(t, "12-provision")

# --- 13 the result
t = beat("13-after")
until("document.body.innerText.includes('Zerops accepted the import')", "Zerops to accept the import", timeout=240)
time.sleep(0.8)
hold(t, "13-after")

# --- 14 architecture, re-read
t = beat("14-arch")
click_text("Architecture", settle=0.8)
gx, gy = to_screen(inner_w * 0.42, inner_h * 0.5)
glide(gx, gy, 0.9)
drift(gx, gy, DUR["14-arch"] - 3.0)
hold(t, "14-arch")

# --- 15 timeline
t = beat("15-timeline")
tl = ev("(()=>{const b=[...document.querySelectorAll('div,span')]"
        ".filter(e=>/^Timeline \\(\\d+\\)$/.test(e.textContent.trim())&&!e.children.length).pop();"
        "return b?b.textContent.trim():null;})()")
click_text(tl, settle=0.9)
lx, ly = to_screen(inner_w * 0.5, inner_h * 0.45)
glide(lx, ly, 0.8)
for _ in range(2):
    e = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, 1, -2)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)
    time.sleep(0.7)
drift(lx, ly, 5.0)
hold(t, "15-timeline")

# --- 16 export, through a real save dialog
t = beat("16-export")
click_text("Export yaml", settle=1.8)
key("return")                            # accept the default filename
until("document.body.innerText.includes('Wrote ')", "the file to be written", timeout=60)
time.sleep(1.0)
hold(t, "16-export")

# --- 17 close
t = beat("17-close")
click_text("Architecture", settle=0.8)
drift(gx, gy, DUR["17-close"] - 2.0)
hold(t, "17-close")

(HERE / "marks.json").write_text(json.dumps(MARKS, indent=1))
print(f"\ndone: {time.time() - T0:.1f}s of footage; marks written to {HERE / 'marks.json'}", flush=True)
