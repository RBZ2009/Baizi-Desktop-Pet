/**
 * Responsibility: Own gateway lifecycle, provider settings and encrypted credentials in Electron.
 * Implementation: 1. Start a utility process lazily. 2. Use authenticated loopback requests. 3. Atomically persist settings with safeStorage.
 */
const { app, utilityProcess, safeStorage, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { normalizeSettings, publicSettings } = require('./gateway/settings');
const { readSse } = require('./gateway/provider');
const { HttpVoiceProvider } = require('./gateway/voice/http-provider');

class GatewayManager {
  // Keep local files outside the install directory and preserve legacy history for migration.
  constructor(userData, legacyHistory = []) {
    this.dataDir = path.join(userData, 'gateway');
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.settingsPath = path.join(this.dataDir, 'settings.json');
    this.legacyHistory = legacyHistory;
    this.child = null;
    this.starting = null;
    this.port = null;
    this.token = randomBytes(32).toString('hex');
    this.settings = normalizeSettings();
    this.voiceControllers = new Map();
    this.settingsError = '';
    if (fs.existsSync(this.settingsPath)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
        saved.apiKey = saved.encryptedApiKey ? safeStorage.decryptString(Buffer.from(saved.encryptedApiKey, 'base64')) : '';
        saved.voiceApiKey = saved.encryptedVoiceApiKey ? safeStorage.decryptString(Buffer.from(saved.encryptedVoiceApiKey, 'base64')) : (saved.voiceApiKey || '');
        saved.voiceTranscriptionApiKey = saved.encryptedVoiceTranscriptionApiKey ? safeStorage.decryptString(Buffer.from(saved.encryptedVoiceTranscriptionApiKey, 'base64')) : (saved.voiceTranscriptionApiKey || '');
        saved.voiceSynthesisApiKey = saved.encryptedVoiceSynthesisApiKey ? safeStorage.decryptString(Buffer.from(saved.encryptedVoiceSynthesisApiKey, 'base64')) : (saved.voiceSynthesisApiKey || '');
        delete saved.encryptedApiKey;
        delete saved.encryptedVoiceApiKey;
        delete saved.encryptedVoiceTranscriptionApiKey;
        delete saved.encryptedVoiceSynthesisApiKey;
        this.settings = normalizeSettings(saved);
      } catch { this.settingsError = '无法读取已有模型设置或解密凭据，请重新保存设置。'; }
    }
  }

  // Return availability indicators while keeping the credential in the main process.
  getSettings() { return { ...publicSettings(this.settings), settingsError: this.settingsError }; }

  // Preserve a blank key input; clearing it requires an explicit action.
  async saveSettings(input) {
    const { clearApiKey, clearVoiceApiKey, clearVoiceTranscriptionApiKey, clearVoiceSynthesisApiKey, hasApiKey, hasVoiceApiKey, settingsError, ...values } = input;
    const next = normalizeSettings({ ...this.settings, ...values,
      apiKey: clearApiKey ? '' : (values.apiKey || this.settings.apiKey),
      voiceApiKey: clearVoiceApiKey ? '' : (values.voiceApiKey || this.settings.voiceApiKey),
      voiceTranscriptionApiKey: clearVoiceTranscriptionApiKey ? '' : (values.voiceTranscriptionApiKey || this.settings.voiceTranscriptionApiKey),
      voiceSynthesisApiKey: clearVoiceSynthesisApiKey ? '' : (values.voiceSynthesisApiKey || this.settings.voiceSynthesisApiKey) });
    const { apiKey, voiceApiKey, voiceTranscriptionApiKey, voiceSynthesisApiKey, ...saved } = next;
    if (apiKey) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，未保存 API Key。');
      saved.encryptedApiKey = safeStorage.encryptString(apiKey).toString('base64');
    }
    for (const [key, value] of Object.entries({ VoiceApiKey: voiceApiKey, VoiceTranscriptionApiKey: voiceTranscriptionApiKey, VoiceSynthesisApiKey: voiceSynthesisApiKey })) {
      if (!value) continue;
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，未保存语音 API Key。');
      saved[`encrypted${key}`] = safeStorage.encryptString(value).toString('base64');
    }
    const temporary = `${this.settingsPath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(saved, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.settingsPath);
    this.settings = next;
    this.settingsError = '';
    if (this.port || this.starting) await this.request('/configure', next);
    return this.getSettings();
  }

  // Transcribe one in-memory microphone recording without persisting or logging its contents.
  async transcribeAudio(audio, mimeType = 'audio/webm') {
    const voice = { ...this.settings.voice };
    if (!voice.inputEnabled) throw new Error('麦克风输入已关闭。');
    const contentType = String(mimeType).split(';')[0].trim();
    if (!voice.transcriptionEndpoint || !voice.transcriptionModel) throw new Error('请先在设置中配置转写地址和模型。');
    const provider = new HttpVoiceProvider({ settings: voice,
      transcriptionApiKey: this.settings.voiceTranscriptionApiKey || this.settings.voiceApiKey,
      synthesisApiKey: this.settings.voiceSynthesisApiKey || this.settings.voiceApiKey });
    return provider.transcribe(new Blob([audio], { type: contentType }), { signal: AbortSignal.timeout(60000) });
  }

  // Synthesize a response under a request-owned abort controller and publish only after completion.
  async synthesizeSpeech(requestId, text, signal) {
    this.cancelSpeech(requestId);
    const controller = new AbortController();
    this.voiceControllers.set(requestId, controller);
    try {
      const provider = new HttpVoiceProvider({ settings: this.settings.voice,
        synthesisApiKey: this.settings.voiceSynthesisApiKey || this.settings.voiceApiKey });
      const result = await provider.synthesize(text, { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
      return result;
    } finally {
      if (this.voiceControllers.get(requestId) === controller) this.voiceControllers.delete(requestId);
    }
  }

  // Cancel a pending request or active synthesis without affecting another reply.
  cancelSpeech(requestId) {
    const controller = this.voiceControllers.get(requestId);
    if (!controller) return false;
    controller.abort();
    this.voiceControllers.delete(requestId);
    return true;
  }

  // Recreate crashed gateways and fail a bounded startup instead of hanging the UI.
  async ensureStarted() {
    if (this.port) return;
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const child = utilityProcess.fork(path.join(__dirname, 'gateway/server.js'), [], { stdio: 'ignore', serviceName: '白子对话 Gateway' });
      this.child = child;
      const timer = setTimeout(() => { child.kill(); reject(new Error('本地对话服务启动超时。')); }, 15000);
      child.on('message', message => {
        if (message.type === 'ready') { clearTimeout(timer); this.port = message.port; resolve(); }
        if (message.type === 'error') { clearTimeout(timer); reject(new Error(message.error)); }
      });
      child.once('exit', () => {
        clearTimeout(timer);
        if (this.child === child) { this.port = null; this.child = null; }
        reject(new Error('本地对话服务已退出。'));
      });
      child.once('spawn', () => child.postMessage({ token: this.token, settings: this.settings, dataDir: this.dataDir, legacyHistory: this.legacyHistory,
        workspaceRoot: app.isPackaged ? app.getPath('userData') : __dirname }));
    });
    try { await this.starting; } finally { this.starting = null; }
  }

  // Only the main process can authenticate management requests to the gateway.
  async request(route, body) {
    await this.ensureStarted();
    const response = await fetch(`http://127.0.0.1:${this.port}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(route === '/test' ? this.settings.requestTimeoutMs + 2000 : 15000)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '本地服务请求失败。');
    return result;
  }

  // Relay framed events to one renderer; disconnecting the renderer cancels the provider.
  async chat(prompt, onEvent, signal) {
    await this.ensureStarted();
    const response = await fetch(`http://127.0.0.1:${this.port}/chat`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }), signal
    });
    if (!response.ok) throw new Error((await response.json()).error);
    for await (const data of readSse(response.body)) onEvent(JSON.parse(data));
  }

  // Open a sandboxed management UI with a dedicated preload bridge.
  openWindow() {
    const window = new BrowserWindow({ width: 780, height: 760, title: '白子 · 对话与记忆', autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'ui/dialogue-preload.js') } });
    window.loadFile(path.join(__dirname, 'ui/dialogue.html'));
  }

  // Stop the owned child on application exit.
  stop() { for (const controller of this.voiceControllers.values()) controller.abort(); this.voiceControllers.clear(); this.child?.kill(); this.port = null; this.child = null; }
}
module.exports = { GatewayManager };
