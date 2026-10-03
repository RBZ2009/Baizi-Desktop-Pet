const panel = document.getElementById('chat-panel');
const input = document.getElementById('chat-input');
let petWidth = 132;
let petHeight = 172;
let activeRequestId = null;
let latestText = '';
let bubbleTimer = null;
let dialogueSettings = { bubbleAutoClose: true, bubblePerCharMs: 180, charsPerLine: 15 };

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
  return String(text || '').replace(/\s+\n/g, '\n').replace(/\n\s+/g, '\n');
}

function setSpeech(text, closable) {
  window.desktopPet?.setSpeechText?.({
    text: formatSpeechText(text),
    closable,
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
  latestText = '';
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
    latestText += payload.text || '';
    setSpeech(latestText || '...', false);
  } else if (['done', 'error', 'cancelled'].includes(payload.type)) {
    const result = payload.type === 'done' ? (payload.text || latestText) :
      payload.type === 'cancelled' ? (latestText || '已停止回复。') :
        `${payload.error || '对话失败。'}${latestText ? `\n\n${latestText}` : ''}`;
    const note = payload.truncated ? '\n\n（回复达到输出上限，可让白子继续。）' : '';
    showFinalSpeech((result || '没有收到可读回复。') + note, 12000);
    activeRequestId = null;
  }
});

window.desktopPet?.onSpeechStatus?.(status => {
  if (status.requestId === activeRequestId && status.type === 'error') {
    showFinalSpeech(`${latestText || '语音提示'}\n\n${status.error}`, 12000);
  }
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
    if (activeRequestId) window.desktopPet?.cancelChat?.();
    window.desktopPet?.setChatPanelVisible?.(false);
  }
});

window.addEventListener('load', () => {
  resizeChatWindow();
  setTimeout(() => input.focus(), 40);
});
