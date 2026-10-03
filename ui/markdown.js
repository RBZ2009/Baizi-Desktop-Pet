/**
 * Responsibility: Render model Markdown as safe HTML in history and reply bubbles.
 * Implementation: 1. Disable raw HTML and remote images. 2. Parse math with texmath.
 * 3. Render bounded KaTeX expressions with trust disabled and escaped error output.
 */
(function attachMarkdownRenderer(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('markdown-it'), require('katex'), require('markdown-it-texmath'));
  } else root.baiziMarkdown = factory(root.markdownit, root.katex, root.texmath);
}(typeof window !== 'undefined' ? window : globalThis, function createMarkdownRenderer(MarkdownIt, katex, texmath) {
  const md = new MarkdownIt({ html: false, breaks: true, linkify: true, table: true });
  const mathOptions = { throwOnError: false, trust: false, strict: 'ignore', output: 'htmlAndMathml', maxExpand: 200, maxSize: 20 };
  md.use(texmath, { engine: katex, delimiters: ['dollars', 'brackets'], katexOptions: mathOptions });

  // Use the same safe KaTeX options for all delimiter types; stream fragments remain readable.
  function mathHtml(content, displayMode) {
    try { return katex.renderToString(content, { ...mathOptions, displayMode }); }
    catch { return md.utils.escapeHtml(content); }
  }
  md.renderer.rules.math_inline = (tokens, index) => mathHtml(tokens[index].content, false);
  md.renderer.rules.math_inline_double = (tokens, index) => `<span class="math-block">${mathHtml(tokens[index].content, true)}</span>`;
  md.renderer.rules.math_block = (tokens, index) => `<div class="math-block">${mathHtml(tokens[index].content, true)}</div>\n`;
  md.renderer.rules.math_block_eqno = (tokens, index) => `<div class="math-block">${mathHtml(tokens[index].content, true)}<span>(${md.utils.escapeHtml(tokens[index].info)})</span></div>\n`;

  // Render image descriptions instead of allowing model text to request local or remote assets.
  md.renderer.rules.image = (tokens, index) => md.utils.escapeHtml(tokens[index].content);
  const validateLink = md.validateLink.bind(md);
  md.validateLink = url => /^https?:\/\//i.test(url) && validateLink(url);
  md.renderer.rules.link_open = (tokens, index, options, env, self) => {
    tokens[index].attrSet('rel', 'noreferrer noopener');
    return self.renderToken(tokens, index, options);
  };

  // Keep links in message content from navigating a privileged local application page.
  rootDocument()?.addEventListener('click', event => {
    const anchor = event.target.closest?.('.markdown-content a');
    if (!anchor) return;
    event.preventDefault();
    const bridge = window.speechOverlay || window.dialogue;
    bridge?.openLink?.(anchor.href);
  });

  // Node tests have no document; browser renderers share one delegated link handler.
  function rootDocument() { return typeof document === 'undefined' ? null : document; }

  // Re-render accumulated source so unfinished Markdown settles as later deltas arrive.
  return function renderMarkdown(source) { return md.render(String(source || '')); };
}));
