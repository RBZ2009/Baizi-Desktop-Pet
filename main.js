/**
 * Responsibility: Manage desktop pet windows, interactions and the local gateway bridge.
 * Implementation: 1. Preserve VRM controls. 2. Delegate dialogue to a managed utility process. 3. Expose only bounded IPC operations.
 */
const { app, BrowserWindow, ipcMain, Menu, Tray, screen, nativeImage, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { GatewayManager } = require('./gateway-manager');
const { SpeechService } = require('./speech-service');
const speechService = new SpeechService();

let mainWindow;
let speechWindow = null;
let chatWindow = null;
let tray = null;
let isPaused = false;
let currentSizeMode = 'medium';
let chatPanelVisible = false;

const sizePresets = {
  small: { width: 132, height: 172 },
  medium: { width: 206, height: 333 },
  large: { width: 560, height: 800 }
};

const configPath = path.join(app.getPath('userData'), 'pet-config.json');
const defaultConfig = {
  autoLaunch: true,
  sizeMode: 'small',
  breathingMode: 'subtle',
  behaviorStyle: 'balanced',
  showPetBounds: false,
  sizePresets: {
    small: { width: 132, height: 172 },
    medium: { width: 206, height: 333 },
    large: { width: 560, height: 800 }
  },
  sizeScaleOverrides: {
    small: 2,
    medium: 1.5,
    large: 0.7
  },
  dialogue: {
    bubbleAnchorX: 0.56, bubbleAnchorY: 0.34,
    bubbleAutoClose: true, bubblePerCharMs: 180, charsPerLine: 15
  }
};

// Read visual preferences independently from gateway data and credentials.
function loadConfig() {
  try {
    if (!fs.existsSync(configPath)) return structuredClone(defaultConfig);
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (parsed.coze && !parsed.dialogue) {
      parsed.dialogue = Object.fromEntries(Object.keys(defaultConfig.dialogue).map(key => [key, parsed.coze[key] ?? defaultConfig.dialogue[key]]));
    }
    delete parsed.coze;
    return { ...structuredClone(defaultConfig), ...parsed };
  } catch { return structuredClone(defaultConfig); }
}

// Atomically save preferences and report failures to callers.
function saveConfig(config) {
  const temporary = `${configPath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, configPath);
}

let gatewayManager = null;
let activeDialogue = null;
// Create the gateway manager after Electron is ready so safeStorage is available.
function getGateway() {
  if (!gatewayManager) gatewayManager = new GatewayManager(app.getPath('userData'), loadConfig().chatHistory || []);
  return gatewayManager;
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
  const anchorX = Number(cfg?.dialogue?.bubbleAnchorX);
  const anchorY = Number(cfg?.dialogue?.bubbleAnchorY);
  const ax = Number.isFinite(anchorX) ? anchorX : defaultConfig.dialogue.bubbleAnchorX;
  const ay = Number.isFinite(anchorY) ? anchorY : defaultConfig.dialogue.bubbleAnchorY;

  const nx = x + Math.round(w * ax);
  const ny = y + Math.round(h * ay) - sh;

  speechWindow.setPosition(Math.round(nx), Math.max(0, Math.round(ny)));
}

function syncChatWindowPosition() {
  if (!mainWindow || mainWindow.isDestroyed() || !chatWindow || chatWindow.isDestroyed() || !chatWindow.isVisible()) return;
  const [x, y] = mainWindow.getPosition();
  const preset = getSizePreset(currentSizeMode);
  const [chatWidth] = chatWindow.getSize();
  const chatX = x + Math.round((preset.width - chatWidth) / 2);
  const chatY = y + Math.round(preset.height * 0.61);
  const area = screen.getDisplayMatching({ x: chatX, y: chatY, width: chatWidth, height: 40 })?.workArea || screen.getPrimaryDisplay().workArea;
  chatWindow.setPosition(
    Math.min(Math.max(area.x, chatX), Math.max(area.x, area.x + area.width - chatWidth)),
    Math.min(Math.max(area.y, chatY), Math.max(area.y, area.y + area.height - 40))
  );
}

function createChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) return chatWindow;
  chatWindow = new BrowserWindow({
    width: 176,
    height: 48,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: __dirname + '/preload.js' }
  });
  chatWindow.setAlwaysOnTop(true, 'screen-saver');
  chatWindow.loadFile(path.join(__dirname, 'chat.html'));
  chatWindow.setMenuBarVisibility(false);
  chatWindow.webContents.on('did-finish-load', () => {
    const preset = getSizePreset(currentSizeMode);
    chatWindow?.webContents.send('pet-chat-window-anchor', { petWidth: preset.width, petHeight: preset.height });
    chatWindow?.webContents.send('pet-chat-panel-visibility', chatPanelVisible);
    syncChatWindowPosition();
  });
  chatWindow.on('closed', () => { chatWindow = null; });
  return chatWindow;
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

  if (chatWindow && !chatWindow.isDestroyed()) {
    if (isPaused) chatWindow.hide();
    else if (chatPanelVisible) {
      syncChatWindowPosition();
      chatWindow.showInactive();
    }
  }

  notifyPauseChanged();
  refreshTrayMenu();
}

function clampWindowPosition(x, y, targetWindow = mainWindow, targetSize = null) {
  if (!targetWindow || targetWindow.isDestroyed()) return { x: Math.round(x), y: Math.round(y) };

  const [currentWidth, currentHeight] = targetWindow.getSize();
  const width = targetSize?.width || currentWidth;
  const height = targetSize?.height || currentHeight;
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
  const pos = clampWindowPosition(x, y, mainWindow, { width: preset.width, height: preset.height });
  mainWindow.setSize(preset.width, preset.height);
  mainWindow.setPosition(pos.x, pos.y);
  syncChatWindowPosition();

  notifySizeChanged();
  syncChatWindowPosition();
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
    syncChatWindowPosition();
  });

  mainWindow.on('resize', () => {
    syncChatWindowPosition();
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
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.close();
      chatWindow = null;
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
    document.getElementById('openDialogue').addEventListener('click',()=>ipcRenderer.invoke('gateway-open'));
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
  <div id="ai" class="panel"><button id="openDialogue">打开对话与记忆设置</button><div class="hint">配置模型 API、自动记忆和系统语音。</div><div class="row"><div><label>气泡锚点 X</label><input id="bubbleAnchorX" type="number" step="0.01" value="${safe(config?.dialogue?.bubbleAnchorX ?? 0.56)}"></div><div><label>气泡锚点 Y</label><input id="bubbleAnchorY" type="number" step="0.01" value="${safe(config?.dialogue?.bubbleAnchorY ?? 0.34)}"></div></div><label><input id="bubbleAutoClose" type="checkbox">气泡自动关闭</label><label>每字符停留时间（毫秒）<input id="bubblePerCharMs" type="number" min="10" value="${safe(config?.dialogue?.bubblePerCharMs ?? 180)}"></label><label>每行字符数<input id="charsPerLine" type="number" min="5" value="${safe(config?.dialogue?.charsPerLine ?? 15)}"></label></div>
  <div id="general" class="panel"><label><input id="autoLaunch" type="checkbox"> 开机自启动</label><label><input id="showPetBounds" type="checkbox"> 显示角色容器边界（调试）</label></div>
  <div class="btns"><button class="cancel" id="cancelBtn">取消</button><button class="save" id="saveBtn">保存</button></div>
  <script>
    const { ipcRenderer } = require('electron');
    const cfg = ${JSON.stringify(config).replaceAll('<', '\\u003c')};
    document.getElementById('sizeMode').value = cfg.sizeMode || 'medium';
    document.getElementById('behaviorStyle').value = cfg.behaviorStyle || 'balanced';
    document.getElementById('breathingMode').value = cfg.breathingMode || 'subtle';
    document.getElementById('autoLaunch').checked = !!cfg.autoLaunch;
    document.getElementById('showPetBounds').checked = !!cfg.showPetBounds;
    document.getElementById('bubbleAutoClose').checked = (cfg?.dialogue?.bubbleAutoClose ?? true) !== false;
    document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));btn.classList.add('active');document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));document.getElementById(btn.dataset.panel).classList.add('active');}));
    document.getElementById('openDialogue').addEventListener('click',()=>ipcRenderer.invoke('gateway-open'));
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
        dialogue: {
          bubbleAnchorX: Number(document.getElementById('bubbleAnchorX').value),
          bubbleAnchorY: Number(document.getElementById('bubbleAnchorY').value),
          bubbleAutoClose: document.getElementById('bubbleAutoClose').checked,
          bubblePerCharMs: Number(document.getElementById('bubblePerCharMs').value),
          charsPerLine: Number(document.getElementById('charsPerLine').value)
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

function buildControlMenuTemplate() {
  return [
    { label: '显示桌宠', click: () => showPetWindow() },
    { label: isPaused ? '恢复运行（快速启动）' : '暂停桌宠', click: () => setPaused(!isPaused) },
    { label: '偏好设置', click: () => openPreferencesWindow() },
    { label: '对话与记忆', click: () => getGateway().openWindow() },
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
ipcMain.handle('pet-set-chat-panel-visible', (event, visible) => {
  const isPetRenderer = event.sender === mainWindow?.webContents;
  const isChatRenderer = event.sender === chatWindow?.webContents;
  if (!isPetRenderer && !isChatRenderer) return { ok: false };
  chatPanelVisible = !!visible;
  if (chatPanelVisible) {
    const window = createChatWindow();
    syncChatWindowPosition();
    window.setAlwaysOnTop(true, 'screen-saver');
    window.show();
    window.focus();
  } else if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.hide();
  }
  mainWindow?.webContents.send('pet-chat-panel-visibility', chatPanelVisible);
  return { ok: true, visible: chatPanelVisible };
});
ipcMain.on('pet-chat-window-resize', (event, size) => {
  if (event.sender !== chatWindow?.webContents || !chatWindow || chatWindow.isDestroyed()) return;
  const width = Math.min(300, Math.max(150, Math.round(Number(size?.width) || 176)));
  const height = Math.min(140, Math.max(36, Math.round(Number(size?.height) || 40)));
  chatWindow.setSize(width, height);
  syncChatWindowPosition();
});
ipcMain.handle('pet-get-breathing-mode', () => loadConfig().breathingMode || 'subtle');
ipcMain.handle('pet-get-show-pet-bounds', () => !!loadConfig().showPetBounds);
ipcMain.handle('pet-get-dialogue-settings', () => {
  const cfg = loadConfig();
  return {
    bubbleAutoClose: (cfg?.dialogue?.bubbleAutoClose ?? defaultConfig.dialogue.bubbleAutoClose) !== false,
    bubblePerCharMs: Number(cfg?.dialogue?.bubblePerCharMs ?? defaultConfig.dialogue.bubblePerCharMs),
    charsPerLine: Number(cfg?.dialogue?.charsPerLine ?? defaultConfig.dialogue.charsPerLine)
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
    dialogue: {
      bubbleAnchorX: Number.isFinite(Number(payload?.dialogue?.bubbleAnchorX)) ? Number(payload.dialogue.bubbleAnchorX) : (current?.dialogue?.bubbleAnchorX ?? defaultConfig.dialogue.bubbleAnchorX),
      bubbleAnchorY: Number.isFinite(Number(payload?.dialogue?.bubbleAnchorY)) ? Number(payload.dialogue.bubbleAnchorY) : (current?.dialogue?.bubbleAnchorY ?? defaultConfig.dialogue.bubbleAnchorY),
      bubbleAutoClose: typeof payload?.dialogue?.bubbleAutoClose === 'boolean' ? payload.dialogue.bubbleAutoClose : (current?.dialogue?.bubbleAutoClose ?? true),
      bubblePerCharMs: Number.isFinite(Number(payload?.dialogue?.bubblePerCharMs)) ? Math.max(10, Number(payload.dialogue.bubblePerCharMs)) : (current?.dialogue?.bubblePerCharMs ?? defaultConfig.dialogue.bubblePerCharMs),
      charsPerLine: Number.isFinite(Number(payload?.dialogue?.charsPerLine)) ? Math.max(5, Number(payload.dialogue.charsPerLine)) : (current?.dialogue?.charsPerLine ?? defaultConfig.dialogue.charsPerLine),
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

// Restrict settings and database controls to the sandboxed management page.
function requireManagementSender(event) {
  const expected = require('node:url').pathToFileURL(path.join(__dirname, 'ui/dialogue.html')).href;
  if (event.senderFrame?.url !== expected) throw new Error('不允许此页面访问对话设置。');
}

ipcMain.handle('gateway-open', () => { getGateway().openWindow(); });
ipcMain.handle('gateway-settings-get', event => { requireManagementSender(event); return getGateway().getSettings(); });
ipcMain.handle('gateway-settings-save', (event, payload) => { requireManagementSender(event); return getGateway().saveSettings(payload); });
ipcMain.handle('gateway-status', event => { requireManagementSender(event); return getGateway().request('/health'); });
ipcMain.handle('gateway-manage', async (event, { action, payload } = {}) => {
  requireManagementSender(event);
  const routes = { test: '/test', sessions: '/sessions', history: '/history', newSession: '/session/new', selectSession: '/session/select',
    memories: '/memories', saveMemory: '/memory/save', deleteMemory: '/memory/delete', memorySource: '/memory/source', retryMemory: '/memory/retry', export: '/export' };
  if (!routes[action]) throw new Error('不支持的管理操作。');
  if (['newSession', 'selectSession'].includes(action)) { activeDialogue?.controller.abort(); speechService.stop(); }
  const result = await getGateway().request(routes[action], payload || {});
  if (action === 'export') {
    const choice = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: '导出聊天与记忆', defaultPath: '白子聊天与记忆.json', filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (choice.canceled) return { cancelled: true };
    fs.writeFileSync(choice.filePath, JSON.stringify(result, null, 2), { mode: 0o600 });
    return { ok: true };
  }
  return result;
});

// Cancel a generation only when requested by its originating pet renderer.
ipcMain.on('pet-chat-cancel', event => {
  if (event.sender !== mainWindow?.webContents && event.sender !== chatWindow?.webContents) return;
  activeDialogue?.controller.abort();
  speechService.stop();
});

// Keep request ownership in the main process and relay one normalized event stream.
ipcMain.on('pet-chat-query-stream', async (event, payload) => {
  if (event.sender !== mainWindow?.webContents && event.sender !== chatWindow?.webContents) return;
  const requestId = String(payload?.requestId || '').slice(0, 100);
  if (!requestId) return;
  activeDialogue?.controller.abort();
  const state = { sender: event.sender, controller: new AbortController() };
  activeDialogue = state;
  speechService.begin(getGateway().getSettings(), status => {
    if (!event.sender.isDestroyed()) event.sender.send('pet-speech-status', { requestId, ...status });
  });
  const send = data => {
    if (activeDialogue !== state) return;
    if (data.type === 'chunk') speechService.append(data.text);
    if (data.type === 'done') speechService.finish();
    if (data.type === 'error' || data.type === 'cancelled') speechService.stop();
    if (activeDialogue === state && !event.sender.isDestroyed()) event.sender.send('pet-chat-stream', { requestId, ...data });
  };
  const disconnect = () => state.controller.abort();
  event.sender.once('destroyed', disconnect);
  try {
    await getGateway().chat(String(payload?.prompt || ''), send, state.controller.signal);
  } catch (error) {
    send({ type: state.controller.signal.aborted ? 'cancelled' : 'error', error: error.message });
  } finally {
    event.sender.removeListener('destroyed', disconnect);
    if (activeDialogue === state) activeDialogue = null;
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

// A single owner prevents simultaneous utility processes from writing the same SQLite file.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => showPetWindow());

app.whenReady().then(() => {
  const config = loadConfig();
  applyAutoLaunch(config.autoLaunch);
  createWindow();
  createTray();
  getGateway().ensureStarted().then(() => {
    const clean = loadConfig();
    delete clean.chatHistory;
    saveConfig(clean);
  }).catch(error => dialog.showMessageBox({ type: 'error', title: '本地对话服务无法启动', message: error.message }));
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

// Abort background work and release the owned gateway when the app quits.
app.on('before-quit', () => { activeDialogue?.controller.abort(); speechService.stop(); gatewayManager?.stop(); });
