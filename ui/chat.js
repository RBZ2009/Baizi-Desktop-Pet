/**
 * Responsibility: Own the independent glass chat composer and display dialogue progress.
 * Implementation: 1. Resize from input content. 2. Ignore stale request events. 3. Relay replies to the speech overlay.
 */
const panel = document.getElementById('chat-panel');
const input = document.getElementById('chat-input');
const voiceButton = document.getElementById('voice-button');
const voicePlayer = document.getElementById('voice-player');
let petWidth = 132;
let petHeight = 172;
let activeRequestId = null;
let latestText = '';
let currentResponseIndex = 0;
let speechMessageId = '';
let bubbleTimer = null;
let dialogueSettings = { bubbleAutoClose: true, bubblePerCharMs: 180, charsPerLine: 15 };
let voiceObjectUrl = '';
let lastCompletedRequestId = null;

const voiceInput = typeof VoiceInput === 'function' ? new VoiceInput({
  onState: state => voiceButton?.classList.toggle('recording', state === 'recording'),
  onText: text => { input.value = `${input.value}${input.value ? ' ' : ''}${text}`; resizeChatWindow(); input.focus(); },
  onError: error => setSpeech(`麦克风输入失败：${error.message}`, true)
}) : null;

window.desktopPet?.onVoiceStop?.(() => voiceInput?.stop());

function resizeChatWindow() {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  context.font = getComputedStyle(input).font;
  const widestLine = input.value.split('\n').reduce((width, line) => Math.max(width, context.measureText(line).width), 0);
  const width = Math.min(260, Math.max(petWidth + 20, Math.ceil(widestLine + 48)));
  panel.style.setProperty('--panel-width', `${width}px`);
  input.style.height = 'auto';
  input.style.height = `${Math.min(128, input.scrollHeight)}px`;
  input.style.overflowY = input.scrollHeight > 128 ? 'auto' : 'hidden';
  const panelHeight = Math.ceil(panel.getBoundingClientRect().height);
  const windowHeight = Math.max(36, Math.min(140, panelHeight));
  window.desktopPet?.setChatWindowSize?.(width, windowHeight);
}

function formatSpeechText(text) {
  return String(text || '');
}

function setSpeech(text, closable) {
  window.desktopPet?.setSpeechText?.({
    text: formatSpeechText(text),
    closable,
    messageId: speechMessageId,
    transient: !latestText && !closable,
    charsPerLine: Math.max(5, Number(dialogueSettings.charsPerLine) || 15)
  });
}

function showFinalSpeech(text, durationMs = 6000) {
  const content = formatSpeechText(text);
  setSpeech(content, true);
  if (bubbleTimer) clearTimeout(bubbleTimer);
  if (!dialogueSettings.bubbleAutoClose) return;
  const autoMs = Math.max(1200, content.length * Math.max(10, Number(dialogueSettings.bubblePerCharMs) || 180));
  bubbleTimer = setTimeout(() => window.desktopPet?.hideSpeech?.(), Math.max(durationMs, autoMs));
}

async function submitPrompt() {
  const text = input.value.trim();
  if (!text) return;
  window.desktopPet?.cancelChat?.();
  activeRequestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  lastCompletedRequestId = null;
  latestText = '';
  currentResponseIndex = 0;
  speechMessageId = `${activeRequestId}:0`;
  if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
  input.value = '';
  resizeChatWindow();
  setSpeech('思考中…', false);
  window.desktopPet?.chatQueryStream?.(activeRequestId, text);
}

window.desktopPet?.getDialogueSettings?.().then(settings => {
  dialogueSettings = {
    bubbleAutoClose: (settings?.bubbleAutoClose ?? true) !== false,
    bubblePerCharMs: Math.max(10, Number(settings?.bubblePerCharMs) || 180),
    charsPerLine: Math.max(5, Number(settings?.charsPerLine) || 15)
  };
}).catch(() => {});

window.desktopPet?.onChatWindowAnchor?.(anchor => {
  petWidth = Number(anchor?.petWidth) || petWidth;
  petHeight = Number(anchor?.petHeight) || petHeight;
  resizeChatWindow();
});

window.desktopPet?.onChatStream?.(payload => {
  if (!payload || payload.requestId !== activeRequestId) return;
  if (payload.type === 'chunk') {
    const index = Number.isInteger(payload.responseIndex) ? payload.responseIndex : currentResponseIndex;
    if (index !== currentResponseIndex) {
      currentResponseIndex = index;
      latestText = '';
      speechMessageId = `${activeRequestId}:${index}`;
    }
    latestText += payload.text || '';
    setSpeech(latestText || '...', false);
  } else if (payload.type === 'tool' && payload.status === 'running') {
    const labels = { get_weather: '查询天气中…', search_web: '搜索网页中…', get_current_time: '查看时间中…', run_command: '本地诊断中…', set_pet_action: '回应中…' };
    setSpeech(latestText || labels[payload.name] || '处理工具请求中…', false);
  } else if (['done', 'error', 'cancelled'].includes(payload.type)) {
    if (payload.type === 'done' && typeof payload.responseText === 'string' && payload.responseText.trim()) {
      currentResponseIndex = payload.responseIndex;
      speechMessageId = `${activeRequestId}:${currentResponseIndex}`;
      latestText = payload.responseText;
    }
    const result = payload.type === 'done' ? (latestText || payload.responseText || payload.text) :
      payload.type === 'cancelled' ? (latestText || '已停止回复。') :
        `${payload.error || '对话失败。'}${latestText ? `\n\n${latestText}` : ''}`;
    const note = payload.truncated ? '\n\n（回复达到输出上限，可让白子继续。）' : '';
    showFinalSpeech((result || '没有收到可读回复。') + note, 12000);
    lastCompletedRequestId = activeRequestId;
    activeRequestId = null;
  }
});

window.desktopPet?.onSpeechStatus?.(status => {
  if (status.requestId === activeRequestId && status.type === 'error') {
    showFinalSpeech(`${latestText || '语音提示'}\n\n${status.error}`, 12000);
  }
});

window.desktopPet?.onVoiceAudio?.(payload => {
  if (!payload || ![activeRequestId, lastCompletedRequestId].includes(payload.requestId) || !payload.audioBase64) return;
  if (voiceObjectUrl) URL.revokeObjectURL(voiceObjectUrl);
  const bytes = Uint8Array.from(atob(payload.audioBase64), character => character.charCodeAt(0));
  voiceObjectUrl = URL.createObjectURL(new Blob([bytes], { type: payload.mimeType || 'audio/mpeg' }));
  voicePlayer.src = voiceObjectUrl;
  voicePlayer.play().catch(() => {});
});

if (voiceButton && typeof voiceButton.addEventListener === 'function') voiceButton.addEventListener('click', async () => {
  try {
    if (voiceInput?.recorder) voiceInput.stop();
    else await voiceInput?.start();
  } catch (error) { setSpeech(`麦克风不可用：${error.message}`, true); }
});

window.desktopPet?.onChatPanelVisibility?.(visible => {
  panel.classList.toggle('show', !!visible);
  if (visible) setTimeout(() => input.focus(), 0);
});

input.addEventListener('input', resizeChatWindow);
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submitPrompt();
  }
  if (event.key === 'Escape') {
    // Text may have finished while system speech is still playing.
    window.desktopPet?.cancelChat?.();
    window.desktopPet?.cancelVoiceSpeech?.(activeRequestId);
    voicePlayer?.pause?.();
    window.desktopPet?.setChatPanelVisible?.(false);
  }
});

window.addEventListener('load', () => {
  resizeChatWindow();
  setTimeout(() => input.focus(), 40);
});
