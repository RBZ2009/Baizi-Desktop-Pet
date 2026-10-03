/**
 * Responsibility: Bridge pet rendering to trusted Electron controls and dialogue events.
 * Implementation: 1. Expose fixed IPC methods. 2. Return unsubscribe callbacks. 3. Keep Node and credentials private.
 */
const { contextBridge, ipcRenderer } = require('electron');

// Expose bounded desktop controls; provider credentials never cross this bridge.
contextBridge.exposeInMainWorld('desktopPet', {
  getPosition: () => ipcRenderer.invoke('pet-get-position'),
  getCursorPoint: () => ipcRenderer.invoke('pet-get-cursor-point'),
  setPosition: (x, y) => ipcRenderer.send('pet-set-position', x, y),
  showContextMenu: () => ipcRenderer.send('pet-show-context-menu'),
  close: () => ipcRenderer.send('pet-close'),
  onBehaviorStyleChanged: (callback) => {
    const handler = (_event, style) => callback(style);
    ipcRenderer.on('pet-behavior-style-changed', handler);
    return () => ipcRenderer.removeListener('pet-behavior-style-changed', handler);
  },
  getPauseState: () => ipcRenderer.invoke('pet-get-pause-state'),
  togglePause: () => ipcRenderer.invoke('pet-toggle-pause'),
  onPauseChanged: (callback) => {
    const handler = (_event, paused) => callback(paused);
    ipcRenderer.on('pet-pause-changed', handler);
    return () => ipcRenderer.removeListener('pet-pause-changed', handler);
  },
  getSizeMode: () => ipcRenderer.invoke('pet-get-size-mode'),
  onSizeChanged: (callback) => {
    const handler = (_event, mode) => callback(mode);
    ipcRenderer.on('pet-size-changed', handler);
    return () => ipcRenderer.removeListener('pet-size-changed', handler);
  },
  setChatPanelVisible: visible => ipcRenderer.invoke('pet-set-chat-panel-visible', !!visible),
  onChatPanelVisibility: callback => {
    const handler = (_event, visible) => callback(visible);
    ipcRenderer.on('pet-chat-panel-visibility', handler);
    return () => ipcRenderer.removeListener('pet-chat-panel-visibility', handler);
  },
  setChatWindowSize: (width, height) => ipcRenderer.send('pet-chat-window-resize', { width, height }),
  onChatWindowAnchor: callback => {
    const handler = (_event, anchor) => callback(anchor);
    ipcRenderer.on('pet-chat-window-anchor', handler);
    return () => ipcRenderer.removeListener('pet-chat-window-anchor', handler);
  },
  getBreathingMode: () => ipcRenderer.invoke('pet-get-breathing-mode'),
  onBreathingModeChanged: (callback) => {
    const handler = (_event, mode) => callback(mode);
    ipcRenderer.on('pet-breathing-mode-changed', handler);
    return () => ipcRenderer.removeListener('pet-breathing-mode-changed', handler);
  },
  getSizeScaleOverrides: () => ipcRenderer.invoke('pet-get-size-scale-overrides'),
  cancelChat: () => ipcRenderer.send('pet-chat-cancel'),
  openDialogueSettings: () => ipcRenderer.invoke('gateway-open'),
  onSpeechStatus: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('pet-speech-status', handler);
    return () => ipcRenderer.removeListener('pet-speech-status', handler);
  },
  chatQueryStream: (requestId, prompt) => ipcRenderer.send('pet-chat-query-stream', { requestId, prompt }),
  onChatStream: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('pet-chat-stream', handler);
    return () => ipcRenderer.removeListener('pet-chat-stream', handler);
  },
  setSpeechText: (text) => ipcRenderer.send('speech-set-text', text),
  hideSpeech: () => ipcRenderer.send('speech-hide'),
  getDialogueSettings: () => ipcRenderer.invoke('pet-get-dialogue-settings'),
  getShowPetBounds: () => ipcRenderer.invoke('pet-get-show-pet-bounds'),
  onShowPetBoundsChanged: (callback) => {
    const handler = (_event, show) => callback(show);
    ipcRenderer.on('pet-show-pet-bounds-changed', handler);
    return () => ipcRenderer.removeListener('pet-show-pet-bounds-changed', handler);
  }
});
