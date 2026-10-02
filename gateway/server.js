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
const { Storage } = require('./storage');
const { MemoryService } = require('./memory-service');
const { ChatService } = require('./chat-service');
const persona = fs.readFileSync(path.join(__dirname, 'prompts/baizi.md'), 'utf8');

// Limit request size before parsing client data.
async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error('请求过大。');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// Start the service on a kernel-selected loopback port; the bearer token stays in the main process.
async function createGateway({ token, settings, dataDir, legacyHistory = [] }) {
  let config = normalizeSettings(settings);
  const temporaryDir = !dataDir ? fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'baizi-gateway-test-')) : null;
  const storage = await Storage.open(dataDir || temporaryDir, legacyHistory);
  const memory = new MemoryService(storage, () => config);
  const chat = new ChatService(storage, persona, memory);
  let active = null;
  const server = http.createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (req.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(401).end(); return;
    }
    const respond = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      if (req.url === '/health' && req.method === 'GET') return respond({ ok: true, session: storage.currentSession(),
        memories: storage.memories().length, pendingJobs: storage.all("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('pending','running')")[0].count,
        failedJobs: storage.all("SELECT COUNT(*) AS count FROM jobs WHERE status='failed'")[0].count,
        memoryError: memory.lastError || storage.meta('last_memory_error') || '', summaryError: storage.meta('last_summary_error') || '',
        memoryResult: storage.meta('last_memory_result') || '' });
      const body = req.method === 'POST' ? await readJson(req) : {};
      if (req.url === '/configure' && req.method === 'POST') {
        config = normalizeSettings(body);
        if (!config.autoMemory) memory.pause(); else memory.kick();
        return respond({ ok: true });
      }
      if (req.url === '/cancel' && req.method === 'POST') { active?.abort(); return respond({ ok: true }); }
      if (req.url === '/test' && req.method === 'POST') {
        const result = await chatCompletion(config, [{ role: 'user', content: '请只回复：连接成功' }], { maxTokens: 128 });
        return respond({ text: result.text });
      }
      if (req.method === 'POST') {
        if (req.url === '/sessions') return respond({ sessions: storage.sessions(), current: storage.currentSession().id });
        if (req.url === '/history') return respond({ messages: storage.messages(body.id || storage.currentSession().id) });
        if (req.url === '/session/new' || req.url === '/session/select') {
          active?.abort(); await chat.settle();
          return respond(req.url === '/session/new' ? storage.newSession() : storage.selectSession(String(body.id || '')));
        }
        if (req.url === '/memories') return respond({ memories: storage.memories() });
        if (req.url === '/memory/save') return respond(storage.saveMemory(body));
        if (req.url === '/memory/delete') return respond(storage.deleteMemory(String(body.id || '')));
        if (req.url === '/memory/source') {
          const record = storage.all('SELECT * FROM memories WHERE id=? AND deleted=0', [String(body.id || '')])[0];
          if (!record) throw new Error('记忆不存在。');
          return respond({ memory: record, messages: record.source_message_id ? storage.all('SELECT * FROM messages WHERE id=?', [record.source_message_id]) : [],
            changes: storage.all('SELECT * FROM memory_changes WHERE memory_id=? ORDER BY id DESC LIMIT 30', [record.id]) });
        }
        if (req.url === '/memory/retry') {
          storage.transaction(() => storage.db.run("UPDATE jobs SET status='pending',attempts=0 WHERE status='failed'"));
          memory.kick(); return respond({ ok: true });
        }
        if (req.url === '/export') return respond(storage.exportData());
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
        await chat.run(prompt, { ...config }, controller.signal, send);
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
  memory.kick();
  return { port: server.address().port, close: async () => {
    active?.abort(); memory.stop(); server.closeAllConnections();
    await chat.settle();
    while (memory.running) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => server.close(resolve));
    storage.close();
    if (temporaryDir) fs.rmSync(temporaryDir, { recursive: true, force: true });
  } };
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
