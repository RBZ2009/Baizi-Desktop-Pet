/**
 * Responsibility: Render and measure streamed reply text in a separate bounded window.
 * Implementation: 1. Render trusted Markdown/KaTeX HTML from the local renderer. 2. Scroll long replies without truncating them. 3. Keep the pointer directed at the role anchor.
 */
const bubble = document.getElementById('bubble');
const text = document.getElementById('text');
const renderMarkdown = window.baiziMarkdown;
let closable = false;
let holdTimer = null;

// Font loading can change fraction and matrix heights after the first render.
function measureBubble() {
  if (bubble.hidden) return;
  const bounds = bubble.getBoundingClientRect();
  window.speechOverlay.resize(Math.ceil(bounds.width) + 20, Math.ceil(bounds.height) + 20);
}
document.fonts.addEventListener('loadingdone', measureBubble);

// Release the close gesture when the pointer leaves or the response changes.
function clearHold() { clearTimeout(holdTimer); holdTimer = null; }

// Keep measurements within the active display and retain readable text at every pet size.
window.speechOverlay.onText(payload => {
  clearHold();
  const content = String(payload?.text || '');
  closable = !!payload?.closable;
  const roleWidth = Number(payload?.roleWidth) || 132;
  const maxWidth = Math.max(140, Math.min(Number(payload?.maxWidth) || 400, Math.max(260, Math.min(400, roleWidth * 1.5))));
  const lineWidth = Math.max(15, Math.min(35, Number(payload?.charsPerLine) || 20)) * 12 + 26;
  const width = Math.min(maxWidth, Math.max(180, Math.min(lineWidth, content.length * 10 + 26)));
  bubble.hidden = false;
  bubble.style.width = `${width}px`;
  bubble.classList.toggle('holdable', closable);
  if (renderMarkdown) text.innerHTML = renderMarkdown(content);
  else text.replaceChildren(document.createTextNode(content));
  text.style.maxHeight = `${Math.max(30, Math.min(298, (Number(payload?.maxHeight) || 340) - 44))}px`;
  measureBubble();
  if (!closable) text.scrollTop = text.scrollHeight;
});

// Position the small pointer at the screen-space anchor supplied by the main process.
window.speechOverlay.onPlacement(payload => {
  bubble.classList.toggle('below', !!payload?.below);
  const pointer = Math.min(bubble.clientWidth - 18, Math.max(18, Number(payload?.pointerX) || bubble.clientWidth / 2));
  bubble.style.setProperty('--pointer-x', `${pointer}px`);
});

// Hide the entire overlay surface without stealing keyboard focus.
window.speechOverlay.onHide(() => { bubble.hidden = true; closable = false; clearHold(); });
bubble.addEventListener('mousedown', event => {
  if (event.button !== 0 || !closable) return;
  clearHold();
  holdTimer = setTimeout(() => window.speechOverlay.hide(), 700);
});
bubble.addEventListener('mouseup', clearHold);
bubble.addEventListener('mouseleave', clearHold);
window.addEventListener('beforeunload', clearHold);
