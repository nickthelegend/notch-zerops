/**
 * The Electron shell, from the app's side.
 *
 * The same bundle runs in a browser and inside the desktop shell, so everything here is a
 * capability CHECK rather than a build flag: if the preload exposed a folder picker, the app
 * offers a button; if it did not, the app expects a typed path. There is no desktop-only
 * rendering path to keep in sync, and nothing here throws when the shell is absent.
 */

interface NotchNative {
  pickFolder: () => Promise<string | null>;
  saveYaml: (url: string) => Promise<string | null>;
}

const native = (): NotchNative | null => {
  const w = globalThis as unknown as { notchNative?: NotchNative };
  return typeof w.notchNative?.pickFolder === 'function' ? w.notchNative : null;
};

/** `darwin` | `win32` | `linux` inside the shell, `null` in a browser. */
export function electronPlatform(): string | null {
  if (typeof document === 'undefined') return null;
  return document.documentElement.getAttribute('data-electron');
}

export const canPickFolder = (): boolean => native() !== null;

/** Opens the OS directory chooser. Resolves to `null` if cancelled or not in the shell. */
export async function pickFolder(): Promise<string | null> {
  const n = native();
  if (n === null) return null;
  try { return await n.pickFolder(); } catch { return null; }
}

export const canSaveFile = (): boolean => typeof native()?.saveYaml === 'function';

/**
 * Save the exported yaml through the OS save dialog.
 *
 * Resolves to the chosen path, or `null` if cancelled. A browser cannot do this — it can only
 * push the file at the downloads folder and never tell you where it went.
 */
export async function saveYaml(url: string): Promise<string | null> {
  const n = native();
  if (n === null || typeof n.saveYaml !== 'function') return null;
  return n.saveYaml(url);
}

/**
 * Make the title strip draggable.
 *
 * `-webkit-app-region` is the only way to tell Electron which part of a frameless window moves
 * it, and it cannot be expressed as a React Native style — react-native-web drops properties
 * it does not recognise. So it goes in as a real stylesheet rule, once, and only when a shell
 * is actually present: in a browser this would make a strip of the page undraggable-but-odd
 * for no reason.
 */
export function installDragRegion(): void {
  if (typeof document === 'undefined') return;
  if (electronPlatform() === null) return;
  if (document.getElementById('notch-drag-style') !== null) return;
  const el = document.createElement('style');
  el.id = 'notch-drag-style';
  el.textContent =
    '[data-notch-drag]{-webkit-app-region:drag;}' +
    '[data-notch-drag] input,[data-notch-drag] button{-webkit-app-region:no-drag;}';
  document.head.appendChild(el);
}
