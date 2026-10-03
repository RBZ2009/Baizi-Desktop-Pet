/**
 * Responsibility: Expose the dialogue management bridge without Node access in the page.
 * Implementation: 1. Allow fixed IPC operations. 2. Return public settings, never stored credentials.
 */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dialogue', {
  getSettings: () => ipcRenderer.invoke('gateway-settings-get'),
  saveSettings: settings => ipcRenderer.invoke('gateway-settings-save', settings),
  status: () => ipcRenderer.invoke('gateway-status'),
  manage: (action, payload) => ipcRenderer.invoke('gateway-manage', { action, payload }),
  openLink: url => ipcRenderer.invoke('dialogue-open-link', url),
  workspace: (action, payload) => ipcRenderer.invoke(`workspace-${action}`, payload),
});
