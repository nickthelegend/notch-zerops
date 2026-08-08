// Marks the page as running inside the Electron shell (with the platform), so the app can
// adopt native desktop chrome — a draggable title strip and macOS traffic-light clearance.
// CommonJS so it loads in a sandboxed preload.
const { contextBridge, ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', function () {
  try {
    document.documentElement.setAttribute('data-electron', process.platform);
  } catch (e) {
    /* non-fatal: the app works without native chrome hints */
  }
});

// The one native affordance the browser cannot offer: a real folder picker for the repo to
// scan. Deliberately the whole surface — no fs, no shell, no ipc passthrough.
contextBridge.exposeInMainWorld('notchNative', {
  pickFolder: function () {
    return ipcRenderer.invoke('notch:pick-folder');
  },
  saveYaml: function (url) {
    return ipcRenderer.invoke('notch:save-yaml', url);
  },
});
