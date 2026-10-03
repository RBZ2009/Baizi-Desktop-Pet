/**
 * Responsibility: Present independent Markdown reply bubbles in stack or replacement mode.
 * Implementation: 1. Update response IDs through SpeechMessages. 2. Render only the top body.
 * 3. Measure both the bubble and fixed-size layers within the current display limits.
 */
const stack = document.getElementById('bubble-stack');
const bubble = document.getElementById('bubble');
const text = document.getElementById('text');
const messages = new window.SpeechMessages();
const renderMarkdown = window.baiziMarkdown;
let holdTimer = null;
let lastPlacement = null;

// Font loading can change fraction and matrix heights after the first render.
function measureBubble() {
  if (stack.hidden) return;
  const bounds = stack.getBoundingClientRect();
  window.speechOverlay.resize(Math.ceil(bounds.width) + 20, Math.ceil(bounds.height) + 20);
}
document.fonts.addEventListener('loadingdone', measureBubble);

// Release the close gesture when the pointer leaves or the response changes.
function clearHold() { clearTimeout(holdTimer); holdTimer = null; }

// Account for the centered top bubble when the lower layers are wider than its body.
function placePointer(payload) {
  if (!payload) return;
  bubble.classList.toggle('below', !!payload.below);
  const offset = (stack.clientWidth - bubble.clientWidth) / 2;
  const pointer = Math.min(bubble.clientWidth - 18, Math.max(18, (Number(payload.pointerX) || stack.clientWidth / 2) - offset));
  bubble.style.setProperty('--pointer-x', `${pointer}px`);
}

// Render fixed blank backplates while leaving the newest response free to size to its contents.
function renderTop(animate = false) {
  const payload = messages.current();
  if (!payload) { stack.hidden = true; window.speechOverlay.hide(); return; }
  const content = payload.text;
  const depth = messages.depth();
  const roleWidth = Number(payload.roleWidth) || 132;
  const maxWidth = Math.max(140, Math.min(Number(payload.maxWidth) || 400, Math.max(260, Math.min(400, roleWidth * 1.5))));
  const lineWidth = Math.max(15, Math.min(35, Number(payload.charsPerLine) || 20)) * 12 + 26;
  const width = Math.min(maxWidth, Math.max(180, Math.min(lineWidth, content.length * 10 + 26)));
  const layerWidth = Math.min(maxWidth, 216);
  stack.hidden = false;
  stack.style.width = `${depth ? Math.max(width, layerWidth) : width}px`;
  stack.style.setProperty('--layer-width', `${layerWidth}px`);
  stack.style.setProperty('--stack-space', `${depth * 9}px`);
  stack.dataset.depth = String(depth);
  bubble.style.width = `${width}px`;
  bubble.classList.toggle('holdable', !!payload.closable);
  if (renderMarkdown) text.innerHTML = renderMarkdown(content);
  else text.replaceChildren(document.createTextNode(content));
  text.style.maxHeight = `${Math.max(30, Math.min(298 - depth * 9, (Number(payload.maxHeight) || 340) - 44 - depth * 9))}px`;
  if (animate) {
    bubble.getAnimations().forEach(animation => animation.cancel());
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      bubble.animate([{ opacity: 0, transform: 'translateY(5px) scale(.97)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }],
        { duration: 180, easing: 'cubic-bezier(.2,.75,.25,1)' });
    }
  }
  placePointer(lastPlacement);
  measureBubble();
  if (!payload.closable) text.scrollTop = text.scrollHeight;
}

// A model-call boundary creates a bubble; ordinary stream updates retain the same bubble.
window.speechOverlay.onText(payload => {
  clearHold();
  messages.setMode(payload.bubbleMode);
  const previous = messages.current();
  messages.update(payload);
  renderTop(!previous || previous.messageId !== messages.current().messageId || !!previous.transient !== !!payload.transient);
});

// Preferences apply to an already-open stack as well as to later replies.
window.speechOverlay.onSettings(settings => {
  messages.setMode(settings?.bubbleMode);
  if (!stack.hidden) renderTop();
});
window.speechOverlay.onPlacement(payload => { lastPlacement = payload; placePointer(payload); });

// Auto-hide clears all expired bubbles so a later response cannot resurrect them.
window.speechOverlay.onHide(() => { stack.hidden = true; messages.clear(); clearHold(); });
bubble.addEventListener('mousedown', event => {
  if (event.button !== 0 || !messages.current()?.closable || event.target.closest('a')) return;
  clearHold();
  holdTimer = setTimeout(() => { messages.dismiss(); renderTop(true); }, 700);
});
bubble.addEventListener('mouseup', clearHold);
bubble.addEventListener('mouseleave', clearHold);
window.addEventListener('beforeunload', clearHold);
