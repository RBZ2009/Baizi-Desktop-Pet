/**
 * Responsibility: Run a private loopback gateway under Electron's utility process.
 * Implementation: 1. Authenticate all HTTP calls. 2. Stream normalized chat events. 3. Cancel replaced or disconnected requests.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { timingSafeEqual } = require('node:crypto');
const { normalizeSettings } = require('./settings');
const { chatCompletion } = require('./provider');
const persona = fs.readFileSync(path.join(__dirname, 'prompts/baizi.md'), 'utf8');

// Limit request size before parsing client data.
async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('请求过大。');
  }
  return JSON.parse(body || '{}');
}

// Start the service on a kernel-selected loopback port; the bearer token stays in the main process.
async function createGateway({ token, settings, dataDir, legacyHistory = [] }) {
  let config = normalizeSettings(settings);
  let active = null;
  const server = http.createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (req.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(401).end(); return;
    }
    const respond = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      if (req.url === '/health' && req.method === 'GET') return respond({ ok: true });
      const body = req.method === 'POST' ? await readJson(req) : {};
      if (req.url === '/configure' && req.method === 'POST') { config = normalizeSettings(body); return respond({ ok: true }); }
      if (req.url === '/cancel' && req.method === 'POST') { active?.abort(); return respond({ ok: true }); }
      if (req.url === '/test' && req.method === 'POST') {
        const result = await chatCompletion(config, [{ role: 'user', content: '请只回复：连接成功' }], { maxTokens: 128 });
        return respond({ text: result.text });
      }
      if (req.url !== '/chat' || req.method !== 'POST') return respond({ error: '接口不存在。' }, 404);
      const prompt = String(body.prompt || '').trim();
      if (!prompt || prompt.length > 12000) return respond({ error: '请输入 1～12000 字的消息。' }, 400);
      active?.abort();
      const controller = new AbortController();
      active = controller;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      const send = event => { if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
      res.on('close', () => controller.abort());
      send({ type: 'start' });
      try {
        const result = await chatCompletion(config, [{ role: 'system', content: persona }, { role: 'user', content: prompt }], {
          signal: controller.signal, onDelta: text => send({ type: 'chunk', text })
        });
        send({ type: 'done', text: result.text, usage: result.usage });
      } catch (error) {
        send({ type: error.name === 'AbortError' ? 'cancelled' : 'error', error: error.message });
      } finally {
        if (active === controller) active = null;
        res.end();
      }
    } catch (error) {
      if (!res.headersSent) respond({ error: error.message }, 400);
      else res.end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port, close: async () => { active?.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

// Electron bootstraps the child through its private parent port, without command-line secrets.
if (process.parentPort) {
  process.parentPort.once('message', async ({ data }) => {
    try {
      const gateway = await createGateway(data);
      process.parentPort.postMessage({ type: 'ready', port: gateway.port });
    } catch (error) { process.parentPort.postMessage({ type: 'error', error: error.message }); process.exit(1); }
  });
}
module.exports = { createGateway, readJson };
