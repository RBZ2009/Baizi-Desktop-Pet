/**
 * Responsibility: Verify safe Markdown and KaTeX rendering for reply bubbles.
 * Implementation: 1. Render through the same UI renderer in Node. 2. Assert semantic HTML for common Markdown. 3. Ensure raw HTML and code spans stay inert.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const renderMarkdown = require('../ui/markdown.js');

test('renders emphasis, lists, links and code blocks as Markdown', () => {
  const html = renderMarkdown('**重点**\n\n- 第一项\n- 第二项\n\n[文档](https://example.com)\n\n`$not math$`');
  assert.match(html, /<strong>重点<\/strong>/);
  assert.match(html, /<ul>[\s\S]*<li>第一项<\/li>[\s\S]*<\/ul>/);
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.match(html, /rel="noreferrer noopener"/);
  assert.match(html, /<code>\$not math\$<\/code>/);
});

test('renders inline and block mathematical expressions with KaTeX', () => {
  const inline = renderMarkdown('能量公式：$E=mc^2$，以及 \\(a+b\\)^2。');
  const block = renderMarkdown('$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$');
  assert.match(inline, /class="katex"/);
  assert.match(inline, /application\/x-tex/);
  assert.match(block, /class="math-block"/);
  assert.match(block, /katex-display/);
  assert.equal((inline.match(/class="katex"/g) || []).length, 2);
  assert.match(renderMarkdown('\\[\n\\frac{1}{2}\n\\]'), /katex-display/);
  assert.match(renderMarkdown('结果：$$x^2$$'), /katex-display/);
});

test('escapes raw HTML while preserving Markdown output', () => {
  const html = renderMarkdown('<script>alert(1)</script> **安全文本**');
  assert.doesNotMatch(html, /<script>/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<strong>安全文本<\/strong>/);
});

test('blocks unsafe links, images and trusted KaTeX commands', () => {
  const html = renderMarkdown('[坏链接](javascript:alert(1)) ![图片](https://example.com/pixel) $\\href{javascript:alert(1)}{x}$');
  assert.doesNotMatch(html, /<img|href="javascript:|<script/i);
  assert.doesNotMatch(renderMarkdown('[本地](file:///etc/passwd)'), /href="file:/);
});

test('preserves code indentation, tables and incomplete stream fragments', () => {
  const html = renderMarkdown('```js\nfunction f() {\n  return 1;\n}\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');
  assert.match(html, /\n  return 1;/);
  assert.match(html, /<table>/);
  assert.doesNotThrow(() => renderMarkdown('**未结束 $\\frac{1}'));
});
