const { contextBridge, ipcRenderer } = require('electron');

// 目前只暴露一个占位 API，后续可扩展与主进程通信
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
  getBreathingMode: () => ipcRenderer.invoke('pet-get-breathing-mode'),
  onBreathingModeChanged: (callback) => {
    const handler = (_event, mode) => callback(mode);
    ipcRenderer.on('pet-breathing-mode-changed', handler);
    return () => ipcRenderer.removeListener('pet-breathing-mode-changed', handler);
  },
  getSizeScaleOverrides: () => ipcRenderer.invoke('pet-get-size-scale-overrides'),
  chatQuery: (text) => ipcRenderer.invoke('pet-chat-query', text),
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
  },
  synthesizeSpeech: (text) => ipcRenderer.invoke('pet-tts-synthesize', text)
});

