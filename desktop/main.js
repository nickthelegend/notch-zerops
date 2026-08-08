/**
 * Notch desktop — an Electron shell around the Brain daemon's web app.
 *
 * Ported from `notch/desktop/main.js`: same chrome, same hidden-inset title bar, same
 * traffic-light inset, same "open external links in the real browser" rule. The difference is
 * what it boots — the Brain daemon rather than the Loom one — and that it waits for the
 * daemon's own health endpoint instead of minting a pairing token, because this daemon binds
 * to loopback and holds its credential in memory rather than pairing clients.
 *
 * The window loads the SAME url a browser would. There is no desktop-only rendering path, so
 * anything that works here works in a browser, and the shell stays thin enough to reason
 * about.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } from 'electron';

const here = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(here, 'preload.cjs');
const ROOT = path.resolve(here, '..');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 7799);
const URL_BASE = `http://${HOST}:${PORT}`;

/** Matches the app canvas (`T.bg`), so there is no white flash while the daemon starts. */
const BG = '#111111';

app.setName('Notch');

let win = null;
let daemon = null;

/** Is a daemon already answering? Then use it rather than starting a second one. */
async function alive() {
  try {
    const res = await fetch(`${URL_BASE}/api/session/status`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Start the daemon if nothing is on the port, and wait for it to answer.
 *
 * Started with `tsx` from the checkout. A packaged build would point at `dist/server.js`
 * instead; that path is not taken here because this app has not been packaged yet, and
 * writing the branch for it would be writing code nobody has run.
 */
async function startDaemon() {
  if (await alive()) return { started: false };

  const entry = path.join(ROOT, 'node_modules', '.bin', 'tsx');
  const server = path.join(ROOT, 'src', 'server.ts');
  if (!existsSync(entry)) throw new Error(`tsx not found at ${entry} — run npm install in ${ROOT}`);

  daemon = spawn(entry, [server], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST },
    stdio: 'inherit',
  });
  daemon.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`[notch] daemon exited with ${code}`);
  });

  for (let i = 0; i < 60; i += 1) {
    if (await alive()) return { started: true };
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the daemon did not answer on ${URL_BASE} within 30s`);
}

/**
 * Pin the window when recording.
 *
 * The capture is cropped to exactly this rectangle, so the frame contains the app and nothing
 * else — and nothing else on the machine is ever written to disk. A window the OS is free to
 * place would make the crop a guess.
 */
const num = (v) => (v === undefined || v === '' ? null : Number(v));
const FIXED = {
  w: num(process.env.NOTCH_WIN_W), h: num(process.env.NOTCH_WIN_H),
  x: num(process.env.NOTCH_WIN_X), y: num(process.env.NOTCH_WIN_Y),
};

async function createWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: FIXED.w ?? Math.min(1512, area.width),
    height: FIXED.h ?? Math.min(945, area.height),
    ...(FIXED.x !== null && FIXED.y !== null ? { x: FIXED.x, y: FIXED.y } : {}),
    ...(FIXED.w !== null ? { resizable: false } : {}),
    minWidth: 700,
    minHeight: 500,
    backgroundColor: BG,
    title: 'Notch',
    acceptFirstMouse: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 14 } } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: PRELOAD,
      /*
       * Chromium throttles timers and stops requestAnimationFrame entirely when a window is
       * occluded or loses focus. That is right for a background tab and wrong for this: the
       * architecture view is a live read of somebody's infrastructure, and it should not
       * quietly stop updating because another window was in front for a moment. It also hung a
       * recording take dead — an animation waiting on a frame that was never going to arrive.
       */
      backgroundThrottling: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost')) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  try {
    await startDaemon();
    await win.loadURL(URL_BASE);
  } catch (err) {
    // Say what failed and what to do about it. A blank window is the worst possible answer.
    await win.loadURL(
      'data:text/html,' +
        encodeURIComponent(
          `<body style="background:${BG};color:#e0e0e0;font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:48px">` +
            `<h2 style="font-weight:800;font-size:22px;margin:0 0 6px">Notch</h2>` +
            `<p style="color:#888">Could not start the Brain daemon.</p>` +
            `<pre style="color:#ef4444;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:12px 14px;white-space:pre-wrap">${String(err)}</pre>` +
            `<p style="color:#888">Build the web app first: <code style="background:#242424;border-radius:5px;padding:1px 6px">cd app &amp;&amp; npm run export</code></p></body>`,
        ),
    );
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
          { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
    ]),
  );
}

/**
 * The one native affordance a browser cannot offer: a real folder picker.
 *
 * Deliberately the entire native surface — no fs, no shell, no ipc passthrough. The renderer
 * only ever receives a path the user chose in the OS dialog themselves, and the browser build
 * simply types the path instead.
 */
/**
 * Save the generated `zerops.yaml` where the user chooses.
 *
 * A browser can only push a file at the downloads folder and never say where it landed. A
 * desktop app can ask. The renderer supplies the daemon URL to read and nothing else — the
 * destination comes from the OS dialog, so this cannot be pointed at an arbitrary path.
 */
ipcMain.handle('notch:save-yaml', async (_e, url) => {
  if (typeof url !== 'string' || !url.startsWith(URL_BASE)) throw new Error('refused: not a daemon url');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`the daemon returned ${res.status}`);
  const body = await res.text();

  const { writeFile } = await import('node:fs/promises');

  /*
   * A preset destination, used only when recording.
   *
   * A native Save panel is a window ABOVE this one: it would sit over the app for the rest of
   * the take and cover every scene after it. So during a recording the destination is set
   * ahead of time and the file is still genuinely written — the dialog is skipped, the write
   * is not.
   */
  const preset = process.env.NOTCH_DEMO_SAVE_DIR;
  if (typeof preset === 'string' && preset !== '') {
    const dest = path.join(preset, 'zerops.yaml');
    await writeFile(dest, body, 'utf8');
    return dest;
  }

  const parent = BrowserWindow.getFocusedWindow() ?? win;
  const opts = { title: 'Save zerops.yaml', defaultPath: 'zerops.yaml' };
  const r = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
  if (r.canceled || typeof r.filePath !== 'string') return null;

  await writeFile(r.filePath, body, 'utf8');
  return r.filePath;
});

ipcMain.handle('notch:pick-folder', async () => {
  const parent = BrowserWindow.getFocusedWindow() ?? win;
  const opts = { title: 'Choose the repository to scan', properties: ['openDirectory'] };
  const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
});

app.whenReady().then(() => {
  buildMenu();
  void createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

// The daemon is ours only if we started it; killing a pre-existing one would be rude.
app.on('will-quit', () => { if (daemon !== null) try { daemon.kill(); } catch { /* already gone */ } });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
