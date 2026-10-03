/**
 * Responsibility: Expose only reply rendering and measurement events to the speech overlay.
 * Implementation: 1. Use fixed IPC channels. 2. Keep Node private. 3. Report bounded measurements to the main process.
 */
const { contextBridge, ipcRenderer } = require('electron');

// Subscribe to fixed incoming channels without exposing IPC event objects.
function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('speechOverlay', {
  onText: callback => subscribe('speech-set-text', callback),
  onPlacement: callback => subscribe('speech-placement', callback),
  onHide: callback => subscribe('speech-hide', callback),
  resize: (width, height) => ipcRenderer.send('speech-window-resize', { width, height }),
  hide: () => ipcRenderer.send('speech-hide'),
  openLink: url => ipcRenderer.invoke('dialogue-open-link', url)
});
