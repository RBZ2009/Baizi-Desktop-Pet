const { app, BrowserWindow, ipcMain, Menu, Tray, screen, nativeImage, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow;
let speechWindow = null;
let tray = null;
let isPaused = false;
let currentSizeMode = 'medium';

const sizePresets = {
  // small: 缩小窗口的同时，避免人物过小造成大面积空白可点击区
  small: { width: 132, height: 172, scale: 0.7 },
  medium: { width: 320, height: 420, scale: 1 },
  large: { width: 560, height: 840, scale: 1.5 }
};

const configPath = path.join(app.getPath('userData'), 'pet-config.json');
const defaultConfig = {
  autoLaunch: true,
  sizeMode: 'medium',
  breathingMode: 'subtle',
  behaviorStyle: 'balanced',
  showPetBounds: false,
  sizePresets: {
    small: { width: 132, height: 172 },
    medium: { width: 320, height: 420 },
    large: { width: 560, height: 840 }
  },
  sizeScaleOverrides: {
    small: 1,
    medium: 1,
    large: 1
  },
  chatHistory: [],
  coze: {
    endpoint: 'https://c8g6hqj92v.coze.site/stream_run',
    token: '',
    userId: '',
    password: '',
    sessionId: 'NTOkPVCF4uso9sYdEtzo6',
    projectId: 7614676808751104006,
    bubbleAnchorX: 0.56,
    bubbleAnchorY: 0.34,
    bubbleAutoClose: true,
    bubblePerCharMs: 180,
    charsPerLine: 15,
    timeZone: 8,
    aliyunApiKey: '',
    aliyunBaseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    aliyunRegion: 'beijing',
    aliyunTtsModel: 'qwen3-tts-flash',
    aliyunTtsVoice: 'Bella',
    aliyunTtsInstructions: '',
    aliyunOptimizeInstructions: true,
    ttsMuted: false
  }
};

function getCozeConfig() {
  const config = loadConfig();
  return {
    endpoint: config?.coze?.endpoint || defaultConfig.coze.endpoint,
    token: config?.coze?.token || process.env.DESKTOP_PET_COZE_TOKEN || '',
    userId: config?.coze?.userId || '',
    password: config?.coze?.password || '',
    sessionId: config?.coze?.sessionId || defaultConfig.coze.sessionId,
    projectId: config?.coze?.projectId || defaultConfig.coze.projectId,
    aliyunApiKey: config?.coze?.aliyunApiKey || '',
    aliyunBaseUrl: config?.coze?.aliyunBaseUrl || defaultConfig.coze.aliyunBaseUrl,
    aliyunRegion: config?.coze?.aliyunRegion || defaultConfig.coze.aliyunRegion,
    aliyunTtsModel: config?.coze?.aliyunTtsModel || defaultConfig.coze.aliyunTtsModel,
    aliyunTtsVoice: config?.coze?.aliyunTtsVoice || defaultConfig.coze.aliyunTtsVoice,
    aliyunTtsInstructions: config?.coze?.aliyunTtsInstructions || defaultConfig.coze.aliyunTtsInstructions,
    aliyunOptimizeInstructions: typeof config?.coze?.aliyunOptimizeInstructions === 'boolean'
      ? config.coze.aliyunOptimizeInstructions
      : defaultConfig.coze.aliyunOptimizeInstructions,
    ttsMuted: typeof config?.coze?.ttsMuted === 'boolean' ? config.coze.ttsMuted : defaultConfig.coze.ttsMuted
  };
}

function loadConfig() {
  try {
    if (!fs.existsSync(configPath)) return { ...defaultConfig };
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      ...defaultConfig,
      ...parsed
    };
  } catch (_) {
    return { ...defaultConfig };
  }
}

function saveConfig(config) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (_) {
    // ignore file errors
  }
}

function appendChatHistory(userText, assistantText) {
  const cfg = loadConfig();
  const history = Array.isArray(cfg.chatHistory) ? cfg.chatHistory : [];
  history.push({
    user: String(userText || '').trim(),
    assistant: String(assistantText || '').trim(),
    createdAt: Date.now()
  });
  const trimmed = history.slice(-20);
  saveConfig({ ...cfg, chatHistory: trimmed });
}


const ttsRealtimeState = {
  child: null,
  buffer: '',
  ended: false,
  lastSampleRate: 24000,
  requestId: null
};

let ttsFlowChild = null;

function parseTtsRealtimeLines(state, onEvent) {
  let idx;
  while ((idx = state.buffer.indexOf('\n')) >= 0) {
    const line = state.buffer.slice(0, idx).trim();
    state.buffer = state.buffer.slice(idx + 1);
    if (!line) continue;
    let payload = null;
    try {
      payload = JSON.parse(line);
    } catch (_) {
      // ignore malformed line
      continue;
    }
    if (payload?.type) {
      onEvent(payload);
    }
  }
}

function stopTtsRealtimeProcess() {
  if (ttsRealtimeState.child) {
    try {
      ttsRealtimeState.child.kill();
    } catch (_) {
      // ignore kill error
    }
  }
  ttsRealtimeState.child = null;
  ttsRealtimeState.buffer = '';
  ttsRealtimeState.ended = false;
  ttsRealtimeState.lastSampleRate = 24000;
}

function runTtsFlowList(textList, apiKey, region) {
  if (!Array.isArray(textList) || textList.length === 0) return;

  const url = region === 'singapore'
    ? 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime'
    : 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime';

  const env = {
    ...process.env,
    DASHSCOPE_API_KEY: apiKey,
    TTS_REALTIME_URL: url,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1'
  };

  const payload = JSON.stringify(textList);
  const logPath = path.join(__dirname, 'tts_use_payload.log');
  try {
    fs.writeFileSync(logPath, '', { flag: 'a', encoding: 'utf-8' });
    fs.appendFileSync(logPath, `${new Date().toISOString()} runTtsFlowList_payload=${payload}\n`, 'utf-8');
  } catch (_) {
    // ignore log errors
  }

  const pythonCode = [
    'import json, sys',
    'from tts_flow import use',
    'use(json.loads(sys.argv[1]))'
  ].join('; ');

  const errLogPath = path.join(__dirname, 'tts_use_error.log');

  if (ttsFlowChild) {
    try {
      ttsFlowChild.kill();
    } catch (_) {
      // ignore kill error
    }
    ttsFlowChild = null;
  }

  const spawnWithCommand = (command) => {
    try {
      fs.writeFileSync(errLogPath, '', { flag: 'a', encoding: 'utf-8' });
      fs.appendFileSync(errLogPath, `${new Date().toISOString()} spawn_${command}\n`, 'utf-8');
    } catch (_) {
      // ignore log errors
    }

    const child = spawn(command, ['-c', pythonCode, payload], {
      cwd: __dirname,
      windowsHide: true,
      env
    });

    ttsFlowChild = child;

    child.stderr.on('data', (chunk) => {
      const msg = String(chunk || '');
      if (!msg) return;
      try {
        fs.appendFileSync(errLogPath, `${new Date().toISOString()} ${msg}\n`, 'utf-8');
      } catch (_) {
        // ignore log errors
      }
    });

    child.on('error', (err) => {
      try {
        fs.appendFileSync(errLogPath, `${new Date().toISOString()} spawn_error=${String(err?.message || err)}\n`, 'utf-8');
      } catch (_) {
        // ignore log errors
      }
      if (command === 'python') {
        spawnWithCommand('py');
      }
    });

    child.on('close', (code) => {
      try {
        fs.appendFileSync(errLogPath, `${new Date().toISOString()} exit_code=${code}\n`, 'utf-8');
      } catch (_) {
        // ignore log errors
      }
      if (ttsFlowChild === child) {
        ttsFlowChild = null;
      }
    });
  };

  spawnWithCommand('python');
}


function getSizePreset(mode, config = loadConfig()) {
  const fallback = sizePresets[mode] || sizePresets.medium;
  const custom = config?.sizePresets?.[mode];
  const width = Number(custom?.width);
  const height = Number(custom?.height);
  return {
    width: Number.isFinite(width) ? Math.max(80, Math.round(width)) : fallback.width,
    height: Number.isFinite(height) ? Math.max(100, Math.round(height)) : fallback.height
  };
}

function applyAutoLaunch(enabled) {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath
  });
}

function getAutoLaunchEnabled() {
  if (!app.isPackaged) {
    return loadConfig().autoLaunch;
  }
  return app.getLoginItemSettings().openAtLogin;
}

function syncSpeechWindowPosition() {
  if (!mainWindow || mainWindow.isDestroyed() || !speechWindow || speechWindow.isDestroyed()) return;
  const [x, y] = mainWindow.getPosition();
  const [w, h] = mainWindow.getSize();
  const [, sh] = speechWindow.getContentSize();

  const cfg = loadConfig();
  const anchorX = Number(cfg?.coze?.bubbleAnchorX);
  const anchorY = Number(cfg?.coze?.bubbleAnchorY);
  const ax = Number.isFinite(anchorX) ? anchorX : defaultConfig.coze.bubbleAnchorX;
  const ay = Number.isFinite(anchorY) ? anchorY : defaultConfig.coze.bubbleAnchorY;

  const nx = x + Math.round(w * ax);
  const ny = y + Math.round(h * ay) - sh;

  speechWindow.setPosition(Math.round(nx), Math.max(0, Math.round(ny)));
}

function notifyPauseChanged() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('pet-pause-changed', isPaused);
}

function setPaused(nextPaused) {
  isPaused = !!nextPaused;

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (isPaused) {
      mainWindow.hide();
    } else {
      mainWindow.show();
    }
  }

  if (speechWindow && !speechWindow.isDestroyed()) {
    if (isPaused) {
      speechWindow.hide();
    } else {
      speechWindow.showInactive();
      syncSpeechWindowPosition();
    }
  }

  notifyPauseChanged();
  refreshTrayMenu();
}

function clampWindowPosition(x, y, targetWindow = mainWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) return { x: Math.round(x), y: Math.round(y) };

  const [width, height] = targetWindow.getSize();
  const candidate = {
    x: Math.round(Number(x) || 0),
    y: Math.round(Number(y) || 0),
    width,
    height
  };
  const display = screen.getDisplayMatching(candidate) || screen.getPrimaryDisplay();
  const area = display.workArea;
  const minX = area.x;
  const maxX = area.x + area.width - width;
  const minY = area.y;
  const maxY = area.y + area.height - height;

  return {
    x: Math.min(Math.max(minX, maxX), Math.max(minX, candidate.x)),
    y: Math.min(Math.max(minY, maxY), Math.max(minY, candidate.y))
  };
}

function showPetWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [x, y] = mainWindow.getPosition();
  const pos = clampWindowPosition(x, y);
  mainWindow.setPosition(pos.x, pos.y);
  mainWindow.show();
  mainWindow.focus();
  if (speechWindow && !speechWindow.isDestroyed()) {
    speechWindow.showInactive();
    syncSpeechWindowPosition();
  }
}

function notifySizeChanged() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('pet-size-changed', currentSizeMode);
}

function applySizeMode(nextMode, { persist = true, restart = false } = {}) {
  const cfgNow = loadConfig();
  const preset = getSizePreset(nextMode, cfgNow);
  if (!preset || !mainWindow || mainWindow.isDestroyed()) return;

  if (nextMode === currentSizeMode) {
    if (persist) {
      const cfg = loadConfig();
      saveConfig({ ...cfg, sizeMode: nextMode });
    }
    return;
  }

  currentSizeMode = nextMode;

  if (persist) {
    const cfg = loadConfig();
    saveConfig({ ...cfg, sizeMode: nextMode });
  }

  if (restart) {
    app.relaunch();
    app.exit(0);
    return;
  }

  const [x, y] = mainWindow.getPosition();
  const pos = clampWindowPosition(x, y);
  mainWindow.setSize(preset.width, preset.height);
  mainWindow.setPosition(pos.x, pos.y);

  notifySizeChanged();
  refreshTrayMenu();
}

function createSpeechWindow() {
  speechWindow = new BrowserWindow({
    width: 280,
    height: 160,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"/><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    #bubble{position:absolute;left:0;bottom:0;width:100%;min-height:44px;box-sizing:border-box;padding:8px 12px;border-radius:14px;
      background:rgba(255,255,255,.94);color:#1f2937;font-size:12px;line-height:1.42;border:1px solid rgba(255,255,255,.9);
      box-shadow:0 8px 22px rgba(0,0,0,.18);white-space:pre-wrap;overflow:hidden;display:none}
    #bubble.show{display:block}
    #bubble.holdable{cursor:pointer}
    #bubble:after{content:'';position:absolute;left:14px;bottom:-7px;width:12px;height:12px;background:rgba(255,255,255,.94);
      border-left:1px solid rgba(255,255,255,.9);border-bottom:1px solid rgba(255,255,255,.9);transform:rotate(45deg)}
  </style></head><body><div id="bubble"></div><script>
    const { ipcRenderer } = require('electron');
    const bubble = document.getElementById('bubble');
    let closable = false;
    let holdTimer = null;

    const clearHold = () => {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
    };

    bubble.addEventListener('mousedown', () => {
      if (!closable) return;
      clearHold();
      holdTimer = setTimeout(() => {
        ipcRenderer.send('speech-hide');
      }, 700);
    });
    bubble.addEventListener('mouseup', clearHold);
    bubble.addEventListener('mouseleave', clearHold);

    ipcRenderer.on('speech-set-text', (_e, payload) => {
      const text = typeof payload === 'string' ? payload : (payload?.text || '');
      closable = typeof payload === 'object' ? !!payload.closable : false;
      bubble.textContent = text || '';
      bubble.classList.add('show');
      bubble.classList.toggle('holdable', closable);
      const len = (text || '').length;
      const w = Math.min(560, Math.max(180, 180 + Math.floor(len / 12) * 26));
      bubble.style.width = w + 'px';
      setTimeout(() => {
        const h = Math.min(360, Math.max(56, bubble.scrollHeight + 8));
        ipcRenderer.send('speech-window-resize', { width: w, height: h });
      }, 0);
    });
    ipcRenderer.on('speech-hide', () => {
      bubble.classList.remove('show');
      bubble.classList.remove('holdable');
      closable = false;
      clearHold();
    });
  </script></body></html>`;

  speechWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  speechWindow.setIgnoreMouseEvents(true);
  speechWindow.on('closed', () => { speechWindow = null; });
}

function createWindow() {
  const config = loadConfig();
  // 恢复为“按保存档位直接冷启动”
  currentSizeMode = sizePresets[config.sizeMode] ? config.sizeMode : 'medium';
  const preset = getSizePreset(currentSizeMode, config);

  mainWindow = new BrowserWindow({
    width: preset.width,
    height: preset.height,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: __dirname + '/preload.js'
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.setMenuBarVisibility(false);
  mainWindow.center();

  // 如果没有模型，提示用户放入 assets/model.vrm
  try {
    const modelPath = path.join(__dirname, 'assets', 'model.vrm');
    if (!fs.existsSync(modelPath)) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '需要添加模型文件',
        message: '未检测到模型文件：assets/model.vrm',
        detail: '请把你的 VRM 模型文件放到 assets/model.vrm，然后重启桌宠即可显示。\n\n如果暂时没有模型，也会自动显示默认的 2D 图片。',
        buttons: ['知道了']
      }).catch(() => {});
    }
  } catch (_) {
    // ignore
  }

  createSpeechWindow();
  syncSpeechWindowPosition();

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape') mainWindow.close();
  });

  mainWindow.on('move', () => {
    syncSpeechWindowPosition();
  });

  mainWindow.on('show', () => {
    if (speechWindow && !speechWindow.isDestroyed()) {
      speechWindow.showInactive();
      syncSpeechWindowPosition();
    }
  });

  mainWindow.on('hide', () => {
    if (speechWindow && !speechWindow.isDestroyed()) {
      speechWindow.hide();
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    notifySizeChanged();

    const config = loadConfig();
    mainWindow.webContents.send('pet-breathing-mode-changed', config.breathingMode || 'subtle');
    mainWindow.webContents.send('pet-behavior-style-changed', config.behaviorStyle || 'balanced');
  });

  mainWindow.on('closed', () => {
    if (speechWindow && !speechWindow.isDestroyed()) {
      speechWindow.close();
      speechWindow = null;
    }
    mainWindow = null;
  });
}

function buildBehaviorSubmenu() {
  const config = loadConfig();
  const current = config.behaviorStyle || 'balanced';

  const setBehaviorStyle = (style) => {
    saveConfig({ ...config, behaviorStyle: style });
    mainWindow?.webContents.send('pet-behavior-style-changed', style);
    refreshTrayMenu();
  };

  return [
    { label: '活泼', type: 'radio', checked: current === 'playful', click: () => setBehaviorStyle('playful') },
    { label: '平衡', type: 'radio', checked: current === 'balanced', click: () => setBehaviorStyle('balanced') },
    { label: '安静', type: 'radio', checked: current === 'calm', click: () => setBehaviorStyle('calm') }
  ];
}

function openSizeScaleSettingsWindow() {
  const config = loadConfig();
  const overrides = {
    ...defaultConfig.sizeScaleOverrides,
    ...(config.sizeScaleOverrides || {})
  };

  const win = new BrowserWindow({
    width: 420,
    height: 310,
    title: '尺寸微调',
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>尺寸微调</title>
  <style>
    body{font-family:ui-sans-serif,system-ui; margin:0; background:#0f172a; color:#e2e8f0;}
    .wrap{padding:16px; display:flex; flex-direction:column; gap:10px;}
    label{font-size:12px; color:#cbd5e1;}
    input{width:100%; box-sizing:border-box; padding:8px 10px; border-radius:8px; border:1px solid #334155; background:#0b1220; color:#f8fafc;}
    .hint{font-size:12px; color:#94a3b8;}
    .btns{display:flex; justify-content:flex-end; gap:8px; margin-top:8px;}
    button{border:none; border-radius:8px; padding:8px 12px; cursor:pointer;}
    .save{background:#4f46e5; color:white;}
    .cancel{background:#334155; color:#e2e8f0;}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hint">输入倍率（建议 0.4 ~ 2.0）。保存后切换档位会自动重启生效。</div>
    <div><label>small 倍率</label><input id="small" type="number" step="0.01" value="${overrides.small}"/></div>
    <div><label>medium 倍率</label><input id="medium" type="number" step="0.01" value="${overrides.medium}"/></div>
    <div><label>large 倍率</label><input id="large" type="number" step="0.01" value="${overrides.large}"/></div>
    <div class="btns">
      <button class="cancel" id="cancelBtn">取消</button>
      <button class="save" id="saveBtn">保存</button>
    </div>
  </div>
  <script>
    const { ipcRenderer } = require('electron');
    const getNum = (id, fallback) => {
      const v = Number(document.getElementById(id).value);
      return Number.isFinite(v) && v > 0 ? v : fallback;
    };
    document.getElementById('cancelBtn').addEventListener('click', () => window.close());
    document.getElementById('saveBtn').addEventListener('click', async () => {
      await ipcRenderer.invoke('pet-save-size-scale-overrides', {
        small: getNum('small', 1),
        medium: getNum('medium', 1),
        large: getNum('large', 1)
      });
      window.close();
    });
  </script>
</body>
</html>`;

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function openAISettingsWindow() {
  const config = loadConfig();
  const coze = {
    endpoint: config?.coze?.endpoint || defaultConfig.coze.endpoint,
    token: config?.coze?.token || '',
    sessionId: config?.coze?.sessionId || defaultConfig.coze.sessionId,
    projectId: config?.coze?.projectId || defaultConfig.coze.projectId
  };

  const win = new BrowserWindow({
    width: 520,
    height: 420,
    title: 'AI 设置',
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  const safe = (v) => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>AI 设置</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto; margin:0; background:#0f172a; color:#e2e8f0;}
    .wrap{padding:16px; display:flex; flex-direction:column; gap:10px;}
    label{font-size:12px; color:#cbd5e1;}
    input{width:100%; box-sizing:border-box; padding:8px 10px; border-radius:8px; border:1px solid #334155; background:#0b1220; color:#f8fafc;}
    .row{display:flex; gap:10px;}
    .row > div{flex:1;}
    .btns{display:flex; justify-content:flex-end; gap:8px; margin-top:8px;}
    button{border:none; border-radius:8px; padding:8px 12px; cursor:pointer;}
    .save{background:#4f46e5; color:white;}
    .cancel{background:#334155; color:#e2e8f0;}
    .hint{font-size:12px; color:#94a3b8;}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hint">填写 Coze 智能体配置。Token 仅保存在本机配置文件。</div>
    <div>
      <label>Endpoint</label>
      <input id="endpoint" value="${safe(coze.endpoint)}" />
    </div>
    <div>
      <label>Token</label>
      <input id="token" value="${safe(coze.token)}" />
    </div>
    <div class="row">
      <div>
        <label>Session ID</label>
        <input id="sessionId" value="${safe(coze.sessionId)}" />
      </div>
      <div>
        <label>Project ID</label>
        <input id="projectId" value="${safe(coze.projectId)}" />
      </div>
    </div>
    <div class="btns">
      <button class="cancel" id="cancelBtn">取消</button>
      <button class="save" id="saveBtn">保存</button>
    </div>
  </div>
  <script>
    const endpoint = document.getElementById('endpoint');
    const token = document.getElementById('token');
    const sessionId = document.getElementById('sessionId');
    const projectId = document.getElementById('projectId');

    document.getElementById('cancelBtn').addEventListener('click', () => window.close());
    document.getElementById('saveBtn').addEventListener('click', () => {
      const payload = {
        endpoint: endpoint.value.trim(),
        token: token.value.trim(),
        sessionId: sessionId.value.trim(),
        projectId: Number(projectId.value.trim())
      };
      const ipc = require('electron').ipcRenderer;
      ipc.invoke('pet-save-coze-config', payload).then(() => window.close());
    });
  </script>
</body>
</html>`;

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function openPreferencesWindow() {
  const config = loadConfig();
  const sizeScale = { ...defaultConfig.sizeScaleOverrides, ...(config.sizeScaleOverrides || {}) };

  const win = new BrowserWindow({
    width: 640,
    height: 520,
    title: '偏好设置',
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  const safe = (v) => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"/><title>偏好设置</title><style>
  body{margin:0;font-family:ui-sans-serif,system-ui;background:#0f172a;color:#e2e8f0}
  .tabs{display:flex;gap:6px;padding:10px;border-bottom:1px solid #334155;background:#111827}
  .tab{padding:6px 10px;border-radius:8px;border:1px solid #334155;cursor:pointer;font-size:12px}
  .tab.active{background:#4f46e5;border-color:#4f46e5}
  .panel{display:none;padding:14px;gap:10px}
  .panel.active{display:flex;flex-direction:column}
  .row{display:flex;gap:10px}.row>div{flex:1}
  label{font-size:12px;color:#cbd5e1}input,select{width:100%;box-sizing:border-box;padding:8px;border-radius:8px;border:1px solid #334155;background:#0b1220;color:#f8fafc}
  .btns{display:flex;justify-content:flex-end;gap:8px;padding:10px;border-top:1px solid #334155}
  button{border:none;border-radius:8px;padding:8px 12px;cursor:pointer}.save{background:#4f46e5;color:#fff}.cancel{background:#334155;color:#e2e8f0}
  .hint{font-size:12px;color:#94a3b8}
  </style></head><body>
  <div class="tabs">
    <button class="tab active" data-panel="size">窗口大小</button>
    <button class="tab" data-panel="personalization">个性化</button>
    <button class="tab" data-panel="ai">对话设置</button>
    <button class="tab" data-panel="general">通用设置</button>
  </div>
  <div id="size" class="panel active">
    <label>档位</label>
    <select id="sizeMode"><option value="small">小</option><option value="medium">中</option><option value="large">大</option></select>
    <div class="hint">切换后将自动重启生效。</div>
    <div class="hint" style="margin-top:6px;">容器尺寸（像素）</div>
    <div class="row"><div><label>small 宽</label><input id="szSmallW" type="number" step="1" min="80" value="${safe((config?.sizePresets?.small?.width) ?? defaultConfig.sizePresets.small.width)}"></div><div><label>small 高</label><input id="szSmallH" type="number" step="1" min="100" value="${safe((config?.sizePresets?.small?.height) ?? defaultConfig.sizePresets.small.height)}"></div></div>
    <div class="row"><div><label>medium 宽</label><input id="szMediumW" type="number" step="1" min="80" value="${safe((config?.sizePresets?.medium?.width) ?? defaultConfig.sizePresets.medium.width)}"></div><div><label>medium 高</label><input id="szMediumH" type="number" step="1" min="100" value="${safe((config?.sizePresets?.medium?.height) ?? defaultConfig.sizePresets.medium.height)}"></div></div>
    <div class="row"><div><label>large 宽</label><input id="szLargeW" type="number" step="1" min="80" value="${safe((config?.sizePresets?.large?.width) ?? defaultConfig.sizePresets.large.width)}"></div><div><label>large 高</label><input id="szLargeH" type="number" step="1" min="100" value="${safe((config?.sizePresets?.large?.height) ?? defaultConfig.sizePresets.large.height)}"></div></div>
    <div class="hint" style="margin-top:6px;">尺寸微调倍率（建议 0.4 ~ 2.0）</div>
    <div class="row"><div><label>small</label><input id="scSmall" type="number" step="0.01" value="${safe(sizeScale.small)}"></div><div><label>medium</label><input id="scMedium" type="number" step="0.01" value="${safe(sizeScale.medium)}"></div><div><label>large</label><input id="scLarge" type="number" step="0.01" value="${safe(sizeScale.large)}"></div></div>
  </div>
  <div id="personalization" class="panel">
    <label>行为风格</label>
    <select id="behaviorStyle"><option value="playful">活泼</option><option value="balanced">平衡</option><option value="calm">安静</option></select>
    <label>呼吸效果</label>
    <select id="breathingMode"><option value="off">关闭</option><option value="subtle">轻微</option><option value="normal">标准</option></select>
  </div>
  <div id="ai" class="panel"><div class="row"><div><label>Endpoint</label><input id="endpoint" value="${safe(config?.coze?.endpoint || defaultConfig.coze.endpoint)}"></div></div><div><label>Token</label><input id="token" value="${safe(config?.coze?.token || '')}"></div><div class="row"><div><label>用户 ID（user_id）</label><input id="userId" value="${safe(config?.coze?.userId || '')}"></div><div><label>身份密码（password）</label><input id="cozePassword" value="${safe(config?.coze?.password || '')}"></div></div><div class="row"><div><label>阿里云 API Key</label><input id="aliyunApiKey" value="${safe(config?.coze?.aliyunApiKey || '')}"></div><div><label>地域</label><select id="aliyunRegion"><option value="beijing">北京（cn）</option><option value="singapore">新加坡（intl）</option></select></div></div><div class="row"><div><label>阿里云 Base URL（可留空自动匹配地域）</label><input id="aliyunBaseUrl" value="${safe(config?.coze?.aliyunBaseUrl || '')}"></div></div><div class="row"><div><label>TTS Model</label><select id="aliyunTtsModel"><option value="qwen3-tts-flash">qwen3-tts-flash</option><option value="qwen3-tts-instruct-flash">qwen3-tts-instruct-flash</option></select></div><div><label>Voice</label><input id="aliyunTtsVoice" value="${safe(config?.coze?.aliyunTtsVoice || defaultConfig.coze.aliyunTtsVoice)}"></div></div><div><label>Instructions（可选）</label><input id="aliyunTtsInstructions" value="${safe(config?.coze?.aliyunTtsInstructions || '')}"></div><div><label><input id="aliyunOptimizeInstructions" type="checkbox"> optimize_instructions</label></div><div><label><input id="ttsMuted" type="checkbox"> 静音模式（仅显示文字）</label></div><div class="row"><div><label>Session ID</label><input id="sessionId" value="${safe(config?.coze?.sessionId || defaultConfig.coze.sessionId)}"></div><div><label>Project ID</label><input id="projectId" value="${safe(config?.coze?.projectId || defaultConfig.coze.projectId)}"></div></div><div class="hint">输出框位置（相对角色窗口，X/Y 建议 0.0~1.0）</div><div class="row"><div><label>输出框锚点 X</label><input id="bubbleAnchorX" type="number" step="0.01" value="${safe(config?.coze?.bubbleAnchorX ?? defaultConfig.coze.bubbleAnchorX)}"></div><div><label>输出框锚点 Y</label><input id="bubbleAnchorY" type="number" step="0.01" value="${safe(config?.coze?.bubbleAnchorY ?? defaultConfig.coze.bubbleAnchorY)}"></div></div><div><label><input id="bubbleAutoClose" type="checkbox"> 对话泡自动关闭</label></div><div><label>每字符停留时长（毫秒）</label><input id="bubblePerCharMs" type="number" step="10" min="10" value="${safe(config?.coze?.bubblePerCharMs ?? defaultConfig.coze.bubblePerCharMs)}"></div><div><label>每行字符数</label><input id="charsPerLine" type="number" step="1" min="5" value="${safe(config?.coze?.charsPerLine ?? defaultConfig.coze.charsPerLine)}"></div></div>
  <div id="general" class="panel"><label><input id="autoLaunch" type="checkbox"> 开机自启动</label><label><input id="showPetBounds" type="checkbox"> 显示角色容器边界（调试）</label><div class="row"><div><label>时区（UTC+）</label><input id="timeZone" type="number" step="1" value="${safe(config?.coze?.timeZone ?? defaultConfig.coze.timeZone)}"></div></div><div class="hint">例如 8 表示 UTC+8。</div></div>
  <div class="btns"><button class="cancel" id="cancelBtn">取消</button><button class="save" id="saveBtn">保存</button></div>
  <script>
    const { ipcRenderer } = require('electron');
    const cfg = ${JSON.stringify(config)};
    document.getElementById('sizeMode').value = cfg.sizeMode || 'medium';
    document.getElementById('behaviorStyle').value = cfg.behaviorStyle || 'balanced';
    document.getElementById('breathingMode').value = cfg.breathingMode || 'subtle';
    document.getElementById('autoLaunch').checked = !!cfg.autoLaunch;
    document.getElementById('showPetBounds').checked = !!cfg.showPetBounds;
    document.getElementById('bubbleAutoClose').checked = (cfg?.coze?.bubbleAutoClose ?? true) !== false;
    document.getElementById('aliyunRegion').value = cfg?.coze?.aliyunRegion || 'beijing';
    document.getElementById('aliyunTtsModel').value = cfg?.coze?.aliyunTtsModel || 'qwen3-tts-flash';
    document.getElementById('aliyunOptimizeInstructions').checked = (cfg?.coze?.aliyunOptimizeInstructions ?? true) !== false;
    document.getElementById('ttsMuted').checked = !!cfg?.coze?.ttsMuted;
    document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));btn.classList.add('active');document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));document.getElementById(btn.dataset.panel).classList.add('active');}));
    document.getElementById('cancelBtn').addEventListener('click',()=>window.close());
    document.getElementById('saveBtn').addEventListener('click', async ()=>{
      const payload = {
        sizeMode: document.getElementById('sizeMode').value,
        behaviorStyle: document.getElementById('behaviorStyle').value,
        breathingMode: document.getElementById('breathingMode').value,
        autoLaunch: document.getElementById('autoLaunch').checked,
        showPetBounds: document.getElementById('showPetBounds').checked,
        sizePresets: {
          small: { width: Number(document.getElementById('szSmallW').value), height: Number(document.getElementById('szSmallH').value) },
          medium: { width: Number(document.getElementById('szMediumW').value), height: Number(document.getElementById('szMediumH').value) },
          large: { width: Number(document.getElementById('szLargeW').value), height: Number(document.getElementById('szLargeH').value) }
        },
        sizeScaleOverrides: {
          small: Number(document.getElementById('scSmall').value) || 1,
          medium: Number(document.getElementById('scMedium').value) || 1,
          large: Number(document.getElementById('scLarge').value) || 1
        },
        coze: {
          endpoint: document.getElementById('endpoint').value.trim(),
          token: document.getElementById('token').value.trim(),
          userId: document.getElementById('userId').value.trim(),
          password: document.getElementById('cozePassword').value.trim(),
          aliyunApiKey: document.getElementById('aliyunApiKey').value.trim(),
          aliyunBaseUrl: document.getElementById('aliyunBaseUrl').value.trim(),
          aliyunRegion: document.getElementById('aliyunRegion').value,
          aliyunTtsModel: document.getElementById('aliyunTtsModel').value,
          aliyunTtsVoice: document.getElementById('aliyunTtsVoice').value.trim(),
          aliyunTtsInstructions: document.getElementById('aliyunTtsInstructions').value.trim(),
          aliyunOptimizeInstructions: document.getElementById('aliyunOptimizeInstructions').checked,
          ttsMuted: document.getElementById('ttsMuted').checked,
          sessionId: document.getElementById('sessionId').value.trim(),
          projectId: Number(document.getElementById('projectId').value),
          bubbleAnchorX: Number(document.getElementById('bubbleAnchorX').value),
          bubbleAnchorY: Number(document.getElementById('bubbleAnchorY').value),
          bubbleAutoClose: document.getElementById('bubbleAutoClose').checked,
          bubblePerCharMs: Number(document.getElementById('bubblePerCharMs').value),
          charsPerLine: Number(document.getElementById('charsPerLine').value),
          timeZone: Number(document.getElementById('timeZone').value)
        }
      };
      const res = await ipcRenderer.invoke('pet-save-preferences', payload);
      if (res?.needsRestart) {
        const shouldRestart = window.confirm('有设置需要重启桌宠后生效。现在重启吗？');
        if (shouldRestart) {
          await ipcRenderer.invoke('pet-restart-app');
          return;
        }
      }
      window.close();
    });
  </script></body></html>`;

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function openChatHistoryWindow() {
  const cfg = loadConfig();
  const history = (Array.isArray(cfg.chatHistory) ? cfg.chatHistory : []).slice().reverse();

  const win = new BrowserWindow({
    width: 620,
    height: 560,
    title: '对话历史',
    resizable: true,
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  const safe = (v) => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const items = history.length
    ? history.map((item, idx) => `<div class="card"><div class="idx">#${history.length - idx}</div><div class="row"><b>你：</b>${safe(item.user || '—')}</div><div class="row"><b>桌宠：</b>${safe(item.assistant || '—')}</div></div>`).join('')
    : '<div class="empty">暂无对话历史</div>';

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"/><title>对话历史</title><style>
    body{margin:0;font-family:ui-sans-serif,system-ui;background:#0f172a;color:#e2e8f0}
    .wrap{padding:12px;display:flex;flex-direction:column;gap:10px;height:100vh;box-sizing:border-box}
    .list{overflow:auto;display:flex;flex-direction:column;gap:10px;padding-right:4px}
    .card{background:#111827;border:1px solid #334155;border-radius:10px;padding:10px}
    .idx{font-size:12px;color:#94a3b8;margin-bottom:6px}
    .row{line-height:1.5;word-break:break-word}
    .empty{color:#94a3b8;padding:20px;text-align:center}
  </style></head><body><div class="wrap"><div class="list">${items}</div></div></body></html>`;

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function buildControlMenuTemplate() {
  return [
    { label: '显示桌宠', click: () => showPetWindow() },
    { label: isPaused ? '恢复运行（快速启动）' : '暂停桌宠', click: () => setPaused(!isPaused) },
    { label: '偏好设置', click: () => openPreferencesWindow() },
    { label: '对话历史', click: () => openChatHistoryWindow() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ];
}

function refreshTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate(buildControlMenuTemplate());
  tray.setContextMenu(menu);
}

function resolveTrayIcon() {
  const candidates = [
    path.join(__dirname, 'assets', 'tray.ico'),
    path.join(__dirname, 'assets', 'tray.png'),
    path.join(__dirname, 'assets', 'pet.png'),
    'C:\\Users\\Wendy\\.cursor\\projects\\c-Users-Wendy-Desktop-AI-programming-cursor-project\\assets\\c__Users_Wendy_AppData_Roaming_Cursor_User_workspaceStorage_b22bb6a3d35a85380dfec37b789925de_images_image-8f8a54b9-2991-4b5e-b76c-12be9fb9d8ec.png'
  ];

  for (const iconPath of candidates) {
    try {
      if (!fs.existsSync(iconPath)) continue;
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) {
        return img.resize({ width: 16, height: 16, quality: 'best' });
      }
    } catch (_) {
      // try next candidate
    }
  }

  return nativeImage.createEmpty();
}

function createTray() {
  const icon = resolveTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('桌宠');
  refreshTrayMenu();
  tray.on('double-click', () => {
    if (isPaused) setPaused(false);
    showPetWindow();
  });
}

// 渲染进程通过 IPC 移动窗口、获取位置、关闭窗口
ipcMain.on('pet-set-position', (event, x, y) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const pos = clampWindowPosition(x, y);
    mainWindow.setPosition(pos.x, pos.y);
  }
});

ipcMain.handle('pet-get-position', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { x: 0, y: 0 };
  const [x, y] = mainWindow.getPosition();
  return { x, y };
});

ipcMain.handle('pet-get-cursor-point', () => {
  const p = screen.getCursorScreenPoint();
  return { x: p.x, y: p.y };
});

ipcMain.handle('pet-toggle-pause', () => {
  setPaused(!isPaused);
  return isPaused;
});

ipcMain.handle('pet-get-pause-state', () => isPaused);
ipcMain.handle('pet-get-size-mode', () => currentSizeMode);
ipcMain.handle('pet-get-breathing-mode', () => loadConfig().breathingMode || 'subtle');
ipcMain.handle('pet-get-show-pet-bounds', () => !!loadConfig().showPetBounds);
ipcMain.handle('pet-get-dialogue-settings', () => {
  const cfg = loadConfig();
  return {
    bubbleAutoClose: (cfg?.coze?.bubbleAutoClose ?? defaultConfig.coze.bubbleAutoClose) !== false,
    bubblePerCharMs: Number(cfg?.coze?.bubblePerCharMs ?? defaultConfig.coze.bubblePerCharMs),
    charsPerLine: Number(cfg?.coze?.charsPerLine ?? defaultConfig.coze.charsPerLine)
  };
});
ipcMain.handle('pet-get-size-scale-overrides', () => {
  const config = loadConfig();
  return {
    ...defaultConfig.sizeScaleOverrides,
    ...(config.sizeScaleOverrides || {})
  };
});
ipcMain.handle('pet-save-size-scale-overrides', async (_event, payload) => {
  const config = loadConfig();
  const sanitize = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 1;
    return Math.min(3, Math.max(0.1, n));
  };

  saveConfig({
    ...config,
    sizeScaleOverrides: {
      small: sanitize(payload?.small),
      medium: sanitize(payload?.medium),
      large: sanitize(payload?.large)
    }
  });

  return { ok: true };
});

ipcMain.handle('pet-save-preferences', async (_event, payload) => {
  const current = loadConfig();
  const sanitize = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 1;
    return Math.min(3, Math.max(0.1, n));
  };

  const sanitizeSize = (v, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(80, Math.round(n));
  };

  const next = {
    ...current,
    sizeMode: sizePresets[payload?.sizeMode] ? payload.sizeMode : current.sizeMode,
    behaviorStyle: ['playful', 'balanced', 'calm'].includes(payload?.behaviorStyle) ? payload.behaviorStyle : current.behaviorStyle,
    breathingMode: ['off', 'subtle', 'normal'].includes(payload?.breathingMode) ? payload.breathingMode : current.breathingMode,
    autoLaunch: !!payload?.autoLaunch,
    showPetBounds: !!payload?.showPetBounds,
    sizePresets: {
      small: {
        width: sanitizeSize(payload?.sizePresets?.small?.width, current?.sizePresets?.small?.width ?? defaultConfig.sizePresets.small.width),
        height: sanitizeSize(payload?.sizePresets?.small?.height, current?.sizePresets?.small?.height ?? defaultConfig.sizePresets.small.height)
      },
      medium: {
        width: sanitizeSize(payload?.sizePresets?.medium?.width, current?.sizePresets?.medium?.width ?? defaultConfig.sizePresets.medium.width),
        height: sanitizeSize(payload?.sizePresets?.medium?.height, current?.sizePresets?.medium?.height ?? defaultConfig.sizePresets.medium.height)
      },
      large: {
        width: sanitizeSize(payload?.sizePresets?.large?.width, current?.sizePresets?.large?.width ?? defaultConfig.sizePresets.large.width),
        height: sanitizeSize(payload?.sizePresets?.large?.height, current?.sizePresets?.large?.height ?? defaultConfig.sizePresets.large.height)
      }
    },
    sizeScaleOverrides: {
      small: sanitize(payload?.sizeScaleOverrides?.small),
      medium: sanitize(payload?.sizeScaleOverrides?.medium),
      large: sanitize(payload?.sizeScaleOverrides?.large)
    },
    coze: {
      endpoint: String(payload?.coze?.endpoint || current?.coze?.endpoint || defaultConfig.coze.endpoint).trim(),
      token: String(payload?.coze?.token || '').trim(),
      userId: String(payload?.coze?.userId || current?.coze?.userId || '').trim(),
      password: String(payload?.coze?.password || current?.coze?.password || '').trim(),
      aliyunApiKey: String(payload?.coze?.aliyunApiKey || current?.coze?.aliyunApiKey || '').trim(),
      aliyunBaseUrl: String(payload?.coze?.aliyunBaseUrl || current?.coze?.aliyunBaseUrl || '').trim(),
      aliyunRegion: ['beijing', 'singapore'].includes(String(payload?.coze?.aliyunRegion || ''))
        ? String(payload.coze.aliyunRegion)
        : (current?.coze?.aliyunRegion || defaultConfig.coze.aliyunRegion),
      aliyunTtsModel: ['qwen3-tts-flash', 'qwen3-tts-instruct-flash'].includes(String(payload?.coze?.aliyunTtsModel || ''))
        ? String(payload.coze.aliyunTtsModel)
        : (current?.coze?.aliyunTtsModel || defaultConfig.coze.aliyunTtsModel),
      aliyunTtsVoice: String(payload?.coze?.aliyunTtsVoice || current?.coze?.aliyunTtsVoice || defaultConfig.coze.aliyunTtsVoice).trim() || defaultConfig.coze.aliyunTtsVoice,
      aliyunTtsInstructions: String(payload?.coze?.aliyunTtsInstructions || current?.coze?.aliyunTtsInstructions || '').trim(),
      aliyunOptimizeInstructions: typeof payload?.coze?.aliyunOptimizeInstructions === 'boolean'
        ? payload.coze.aliyunOptimizeInstructions
        : (typeof current?.coze?.aliyunOptimizeInstructions === 'boolean'
          ? current.coze.aliyunOptimizeInstructions
          : defaultConfig.coze.aliyunOptimizeInstructions),
      ttsMuted: typeof payload?.coze?.ttsMuted === 'boolean'
        ? payload.coze.ttsMuted
        : (typeof current?.coze?.ttsMuted === 'boolean'
          ? current.coze.ttsMuted
          : defaultConfig.coze.ttsMuted),
      sessionId: String(payload?.coze?.sessionId || current?.coze?.sessionId || defaultConfig.coze.sessionId).trim(),
      projectId: Number(payload?.coze?.projectId) || current?.coze?.projectId || defaultConfig.coze.projectId,
      bubbleAnchorX: Number.isFinite(Number(payload?.coze?.bubbleAnchorX)) ? Number(payload.coze.bubbleAnchorX) : (current?.coze?.bubbleAnchorX ?? defaultConfig.coze.bubbleAnchorX),
      bubbleAnchorY: Number.isFinite(Number(payload?.coze?.bubbleAnchorY)) ? Number(payload.coze.bubbleAnchorY) : (current?.coze?.bubbleAnchorY ?? defaultConfig.coze.bubbleAnchorY),
      bubbleAutoClose: typeof payload?.coze?.bubbleAutoClose === 'boolean' ? payload.coze.bubbleAutoClose : (current?.coze?.bubbleAutoClose ?? true),
      bubblePerCharMs: Number.isFinite(Number(payload?.coze?.bubblePerCharMs)) ? Math.max(10, Number(payload.coze.bubblePerCharMs)) : (current?.coze?.bubblePerCharMs ?? defaultConfig.coze.bubblePerCharMs),
      charsPerLine: Number.isFinite(Number(payload?.coze?.charsPerLine)) ? Math.max(5, Number(payload.coze.charsPerLine)) : (current?.coze?.charsPerLine ?? defaultConfig.coze.charsPerLine),
      timeZone: Number.isFinite(Number(payload?.coze?.timeZone)) ? Math.max(-12, Math.min(14, Math.round(Number(payload.coze.timeZone)))) : (current?.coze?.timeZone ?? defaultConfig.coze.timeZone)
    }
  };

  saveConfig(next);
  applyAutoLaunch(next.autoLaunch);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pet-behavior-style-changed', next.behaviorStyle);
    mainWindow.webContents.send('pet-breathing-mode-changed', next.breathingMode);
    mainWindow.webContents.send('pet-show-pet-bounds-changed', !!next.showPetBounds);
  }

  const needsRestart = (
    next.sizeMode !== currentSizeMode ||
    JSON.stringify(next.sizeScaleOverrides) !== JSON.stringify(current.sizeScaleOverrides || defaultConfig.sizeScaleOverrides) ||
    JSON.stringify(next.sizePresets) !== JSON.stringify(current.sizePresets || defaultConfig.sizePresets)
  );

  refreshTrayMenu();
  return { ok: true, needsRestart };
});

ipcMain.handle('pet-restart-app', async () => {
  app.relaunch();
  app.exit(0);
  return { ok: true };
});

function extractTextFromAny(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const t = extractTextFromAny(item);
      if (t) return t;
    }
    return '';
  }
  if (typeof value === 'object') {
    const commonKeys = ['answer', 'text', 'content', 'message', 'output', 'response'];
    for (const key of commonKeys) {
      if (key in value) {
        const t = extractTextFromAny(value[key]);
        if (t) return t;
      }
    }
    for (const key of Object.keys(value)) {
      const t = extractTextFromAny(value[key]);
      if (t) return t;
    }
  }
  return '';
}

ipcMain.handle('pet-save-coze-config', async (_event, payload) => {
  const config = loadConfig();
  const endpoint = String(payload?.endpoint || '').trim() || defaultConfig.coze.endpoint;
  const token = String(payload?.token || '').trim();
  const sessionId = String(payload?.sessionId || '').trim() || defaultConfig.coze.sessionId;
  const projectIdNum = Number(payload?.projectId);
  const projectId = Number.isFinite(projectIdNum) ? projectIdNum : defaultConfig.coze.projectId;

  saveConfig({
    ...config,
    coze: {
      endpoint,
      token,
      sessionId,
      projectId
    }
  });

  return { ok: true };
});

ipcMain.on('pet-chat-query-stream', async (event, payload) => {
  const requestId = String(payload?.requestId || '');
  const prompt = String(payload?.prompt || '').trim();

  const send = (type, data = {}) => {
    event.sender.send('pet-chat-stream', { requestId, type, ...data });
  };

  if (!requestId) return;
  if (!prompt) {
    send('error', { error: 'empty_prompt' });
    return;
  }

  const coze = getCozeConfig();
  if (!coze.token) {
    send('error', { error: 'missing_token' });
    return;
  }
  if (!coze.userId || !coze.password) {
    send('error', { error: 'missing_identity' });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);

  try {
    const endpointUrl = new URL(coze.endpoint);
    endpointUrl.searchParams.set('user_id', coze.userId);
    endpointUrl.searchParams.set('password', coze.password);

    const response = await fetch(endpointUrl.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${coze.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        content: {
          query: {
            prompt: [
              {
                type: 'text',
                content: { text: prompt }
              }
            ]
          }
        },
        type: 'query',
        session_id: coze.sessionId,
        project_id: coze.projectId,
        time_zone: Number.isFinite(Number(coze.timeZone)) ? Number(coze.timeZone) : defaultConfig.coze.timeZone
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      send('error', { error: `http_${response.status}` });
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      const raw = await response.text();
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        parsed = raw;
      }
      const text = parsed?.content?.answer || extractTextFromAny(parsed).trim();
      send('chunk', { text: text || '（我暂时不知道怎么回答这句话）' });
      send('done');
      return;
    }

    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let fullText = '';
    let ttsStarted = false;

    const runTtsFlowList = (list, onDone) => {
      if (!coze.aliyunApiKey) {
        send('error', { error: 'missing_tts_credentials' });
        return;
      }

      const payload = JSON.stringify(list || []);
      const scriptCode = [
        'import json, sys',
        'from tts_flow import use',
        'use(json.loads(sys.argv[1]))'
      ].join('; ');

      const url = coze.aliyunRegion === 'singapore'
        ? 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime'
        : 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime';

      const env = {
        ...process.env,
        DASHSCOPE_API_KEY: coze.aliyunApiKey,
        TTS_REALTIME_URL: url,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1'
      };

      const errLogPath = path.join(__dirname, 'tts_use_error.log');
      const logPayload = () => {
        try {
          fs.writeFileSync(errLogPath, '', { flag: 'a', encoding: 'utf-8' });
          fs.appendFileSync(errLogPath, `${new Date().toISOString()} spawn_python_stream payload_len=${payload.length}\n`, 'utf-8');
        } catch (_) {
          // ignore log errors
        }
      };

      const spawnWith = (command) => {
        logPayload();
        const child = spawn(command, ['-c', scriptCode, payload], {
          cwd: __dirname,
          windowsHide: true,
          env
        });

        child.on('close', () => {
          if (typeof onDone === 'function') onDone();
          send('tts_stream_done');
        });

        child.on('error', (err) => {
          try {
            fs.appendFileSync(errLogPath, `${new Date().toISOString()} spawn_error=${String(err?.message || err)}\n`, 'utf-8');
          } catch (_) {
            // ignore log errors
          }
          if (command === 'python') {
            spawnWith('py');
          }
        });

        child.stdout.on('data', (chunk) => {
          const msg = String(chunk || '');
          if (!msg) return;
          if (msg.includes('AUDIO_START')) {
            send('tts_audio_start');
          }
        });

        child.stderr.on('data', (chunk) => {
          const msg = String(chunk || '').trim();
          if (!msg) return;
          if (msg.includes('AUDIO_START')) {
            send('tts_audio_start');
          }
          try {
            fs.appendFileSync(errLogPath, `${new Date().toISOString()} ${msg}\n`, 'utf-8');
          } catch (_) {
            // ignore log errors
          }
          const lower = msg.toLowerCase();
          if (lower.includes('error') || lower.includes('exception') || lower.includes('traceback')) {
            send('error', { error: 'tts_stream_failed', detail: msg });
          }
        });
      };

      spawnWith('python');
    };

    const pushLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let payloadLine = trimmed;
      if (payloadLine.startsWith('data:')) {
        payloadLine = payloadLine.slice(5).trim();
      }
      if (!payloadLine || payloadLine === '[DONE]') return;

      try {
        const obj = JSON.parse(payloadLine);

        // 按 Coze stream_run 实际格式，只消费 answer 分片
        // 典型结构：{ type: 'answer', content: { answer: '...' } }
        const answerPart = obj?.content?.answer;
        if (obj?.type === 'answer' && typeof answerPart === 'string' && answerPart.length > 0) {
          fullText += answerPart;
          send('chunk', { text: answerPart });
          return;
        }

        // 结束包：这里只标记结束，不在此处发送 done。
        // 否则渲染层会提前 unsubscribe，收不到后续 tts_ready / tts_error。
        if (obj?.type === 'message_end' || obj?.content?.message_end) {
          return;
        }
      } catch (_) {
        // 非 JSON 行忽略
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        pushLine(line);
      }
    }

    if (buffer.trim()) {
      pushLine(buffer);
    }

    const finalText = fullText.trim();
    if (finalText) {
      appendChatHistory(prompt, finalText);
    }

    const logPath = path.join(__dirname, 'tts_use_payload.log');
    try {
      fs.appendFileSync(logPath, `${new Date().toISOString()} stream_finalText_len=${finalText.length}\n`, 'utf-8');
    } catch (_) {
      // ignore log errors
    }

    if (finalText && coze.aliyunApiKey && !coze.ttsMuted) {
      const sentences = finalText.split(/(?<=[。！？!?])/).map((s) => s.trim()).filter(Boolean);
      const pairs = [];
      for (let i = 0; i < sentences.length; i += 2) {
        const pair = [sentences[i], sentences[i + 1]].filter(Boolean);
        if (pair.length) pairs.push(pair);
      }

      try {
        fs.appendFileSync(logPath, `${new Date().toISOString()} stream_pairs=${pairs.length}\n`, 'utf-8');
      } catch (_) {
        // ignore log errors
      }

      if (pairs.length) {
        let index = 0;
        const runNext = () => {
          const current = pairs[index];
          if (!current) return;
          runTtsFlowList(current, () => {
            index += 1;
            runNext();
          });
        };
        runNext();
      } else {
        try {
          fs.appendFileSync(logPath, `${new Date().toISOString()} stream_no_sentences\n`, 'utf-8');
        } catch (_) {
          // ignore log errors
        }
      }
    } else {
      try {
        fs.appendFileSync(logPath, `${new Date().toISOString()} stream_missing_key_or_text key=${coze.aliyunApiKey ? 'yes' : 'no'} text=${finalText ? 'yes' : 'no'} muted=${coze.ttsMuted ? 'yes' : 'no'}\n`, 'utf-8');
      } catch (_) {
        // ignore log errors
      }
    }

    send('done');
  } catch (error) {
    const msg = String(error?.message || '');
    if (error?.name === 'AbortError') {
      send('error', { error: 'timeout', detail: msg });
    } else if (msg.startsWith('aliyun_tts_http_')) {
      send('error', { error: 'tts_create_failed', detail: msg });
    } else if (msg.startsWith('aliyun_tts_python_failed_')) {
      send('error', { error: 'tts_query_failed', detail: msg });
    } else if (msg.startsWith('aliyun_tts_audio_url_missing')) {
      send('error', { error: 'tts_query_failed', detail: msg });
    } else {
      send('error', { error: 'network_error', detail: msg });
    }
  } finally {
    clearTimeout(timeout);
  }
});

ipcMain.handle('pet-chat-query', async (_event, promptText) => {
  const prompt = (promptText || '').trim();
  if (!prompt) {
    return { ok: false, error: 'empty_prompt' };
  }

  const coze = getCozeConfig();
  if (!coze.token) {
    return { ok: false, error: 'missing_token' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);

  try {
    const response = await fetch(coze.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${coze.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        content: {
          query: {
            prompt: [
              {
                type: 'text',
                content: { text: prompt }
              }
            ]
          }
        },
        type: 'query',
        session_id: coze.sessionId,
        project_id: coze.projectId
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const raw = await response.text();
      return { ok: false, error: `http_${response.status}`, raw };
    }

    // 尝试流式解析（SSE/分块 JSON）
    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let fullText = '';

      const pushLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let payload = trimmed;
        if (payload.startsWith('data:')) {
          payload = payload.slice(5).trim();
        }
        if (!payload || payload === '[DONE]') return;

        try {
          const obj = JSON.parse(payload);
          const part = extractTextFromAny(obj).trim();
          if (part) {
            fullText += part;
          }
        } catch (_) {
          // 非 JSON 分片，直接拼接文本
          fullText += payload;
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          pushLine(line);
        }
      }

      if (buffer.trim()) {
        pushLine(buffer);
      }

      const finalText = fullText.trim() || '（我暂时不知道怎么回答这句话）';
      const logPath = path.join(__dirname, 'tts_use_payload.log');
      try {
        fs.appendFileSync(logPath, `${new Date().toISOString()} finalText_len=${finalText.length}\n`, 'utf-8');
      } catch (_) {
        // ignore log errors
      }

      if (finalText && coze.aliyunApiKey) {
        const sentences = finalText.split(/(?<=[。！？!?])/).map((s) => s.trim()).filter(Boolean);
        const firstTwo = sentences.slice(0, 2);
        if (firstTwo.length) {
          runTtsFlowList(firstTwo, coze.aliyunApiKey, coze.aliyunRegion);
        } else {
          try {
            fs.appendFileSync(logPath, `${new Date().toISOString()} no_sentences\n`, 'utf-8');
          } catch (_) {
            // ignore log errors
          }
        }
      } else {
        try {
          fs.appendFileSync(logPath, `${new Date().toISOString()} missing_key_or_text key=${coze.aliyunApiKey ? 'yes' : 'no'}\n`, 'utf-8');
        } catch (_) {
          // ignore log errors
        }
      }

      return {
        ok: true,
        text: finalText
      };
    }

    // 回退：非流式
    const raw = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      parsed = raw;
    }

    const reply = extractTextFromAny(parsed).trim() || '（我暂时不知道怎么回答这句话）';
    if (reply && coze.aliyunApiKey) {
      const sentences = reply.split(/(?<=[。！？!?])/).map((s) => s.trim()).filter(Boolean);
      const firstTwo = sentences.slice(0, 2);
      if (firstTwo.length) {
        runTtsFlowList(firstTwo, coze.aliyunApiKey, coze.aliyunRegion);
      }
    }

    return {
      ok: true,
      text: reply,
      raw: parsed
    };
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timeout);
  }
});

ipcMain.on('speech-window-resize', (_event, size) => {
  if (!speechWindow || speechWindow.isDestroyed()) return;
  const w = Math.max(160, Math.min(560, Math.round(Number(size?.width) || 240)));
  const h = Math.max(52, Math.min(360, Math.round(Number(size?.height) || 96)));
  speechWindow.setSize(w, h);
  syncSpeechWindowPosition();
});

ipcMain.on('speech-set-text', (_event, payload) => {
  if (!speechWindow || speechWindow.isDestroyed()) return;
  const text = typeof payload === 'string' ? payload : (payload?.text || '');
  const closable = typeof payload === 'object' ? !!payload.closable : false;
  if (closable) {
    speechWindow.setIgnoreMouseEvents(false);
  } else {
    speechWindow.setIgnoreMouseEvents(true, { forward: true });
  }
  speechWindow.webContents.send('speech-set-text', { text, closable });
  if (!isPaused) speechWindow.showInactive();
  syncSpeechWindowPosition();
});

ipcMain.on('speech-hide', () => {
  if (!speechWindow || speechWindow.isDestroyed()) return;
  speechWindow.webContents.send('speech-hide');
  speechWindow.setIgnoreMouseEvents(true, { forward: true });
});

ipcMain.on('pet-show-context-menu', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const menu = Menu.buildFromTemplate(buildControlMenuTemplate());
  menu.popup({ window: mainWindow });
});

ipcMain.on('pet-close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

app.whenReady().then(() => {
  const config = loadConfig();
  applyAutoLaunch(config.autoLaunch);
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // 仅隐藏到托盘，不退出
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    notifyPauseChanged();
  } else {
    showPetWindow();
  }
});
