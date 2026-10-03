/**
 * Responsibility: Verify provider framing, gateway authentication and cancellation without paid APIs.
 * Implementation: 1. Serve a loopback mock provider. 2. Exercise real HTTP streams. 3. Close every server after testing.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createGateway } = require('../gateway/server');
const { chatCompletion, readSse } = require('../gateway/provider');
const { normalizeSettings } = require('../gateway/settings');
const { executeTool } = require('../gateway/tools/tool-registry');

// Run provider requests against a disposable local HTTP server.
async function mockProvider(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { settings: normalizeSettings({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'test-only', autoMemory: false }),
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test('provider decodes split UTF-8 SSE and ignores reasoning content', async () => {
  const provider = await mockProvider((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const bytes = Buffer.from('data: {"choices":[{"delta":{"reasoning_content":"private","content":"白子你好"}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
    for (const byte of bytes) res.write(Buffer.from([byte]));
    res.end();
  });
  try {
    let output = '';
    const result = await chatCompletion(provider.settings, [], { onDelta: text => output += text });
    assert.equal(result.text, '白子你好');
    assert.equal(output, '白子你好');
  } finally { await provider.close(); }
});

test('provider accepts non-stream JSON and reports deadline errors', async () => {
  const provider = await mockProvider((_req, res) => res.end(JSON.stringify({ choices: [{ message: { content: 'JSON 回复' } }] })));
  try { assert.equal((await chatCompletion(provider.settings, [])).text, 'JSON 回复'); }
  finally { await provider.close(); }
  const slow = await mockProvider(() => {});
  try { await assert.rejects(chatCompletion({ ...slow.settings, requestTimeoutMs: 30 }, []), /超时/); }
  finally { await slow.close(); }
});

test('gateway requires bearer authentication and rejects browser origins', async () => {
  const gateway = await createGateway({ token: 'test-token', settings: normalizeSettings() });
  try {
    const url = `http://127.0.0.1:${gateway.port}/health`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer test-token', Origin: 'https://example.com' } })).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer test-token' } })).status, 200);
  } finally { await gateway.close(); }
});

test('gateway emits text completion and can abort an in-flight request', async () => {
  const provider = await mockProvider((req, res) => {
    let input = '';
    req.on('data', chunk => input += chunk);
    req.on('end', () => {
      if (input.includes('等待')) return;
      res.end(JSON.stringify({ choices: [{ message: { content: '你好呀' } }] }));
    });
  });
  const gateway = await createGateway({ token: 'test-token', settings: provider.settings });
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  const call = prompt => fetch(`http://127.0.0.1:${gateway.port}/chat`, { method: 'POST', headers, body: JSON.stringify({ prompt }) });
  try {
    const response = await call('你好');
    const events = [];
    for await (const data of readSse(response.body)) events.push(JSON.parse(data));
    assert.deepEqual(events.map(event => event.type), ['start', 'context', 'chunk', 'done']);
    assert.equal(events.at(-1).text, '你好呀');
    const pending = await call('等待');
    await fetch(`http://127.0.0.1:${gateway.port}/cancel`, { method: 'POST', headers, body: '{}' });
    const cancelled = [];
    for await (const data of readSse(pending.body)) cancelled.push(JSON.parse(data).type);
    assert.equal(cancelled.at(-1), 'cancelled');
  } finally { await gateway.close(); await provider.close(); }
});

test('provider settings reject credential-bearing URLs and inconsistent budgets', () => {
  assert.throws(() => normalizeSettings({ baseUrl: 'https://user:password@example.com/v1' }));
  assert.throws(() => normalizeSettings({ baseUrl: 'http://example.com/v1' }));
  assert.throws(() => normalizeSettings({ contextWindow: 4096, maxOutputTokens: 4096 }));
});

test('a stream cut short is rejected instead of being committed as a complete response', async () => {
  const provider = await mockProvider((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"未完成"}}]}\n\n');
  });
  try { await assert.rejects(chatCompletion(provider.settings, [], { onDelta() {} }), /意外结束/); }
  finally { await provider.close(); }
});

test('gateway executes a model tool call and feeds the result back before replying', async () => {
  const provider = await mockProvider((req, res) => {
    let input = '';
    req.on('data', chunk => input += chunk);
    req.on('end', () => {
      const body = JSON.parse(input);
      const hasToolResult = body.messages.some(message => message.role === 'tool');
      if (!hasToolResult) {
        return res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
          { id: 'call_time', type: 'function', function: { name: 'get_current_time', arguments: '{}' } }
        ] } }] }));
      }
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '现在是本地时间。' } }] }));
    });
  });
  const gateway = await createGateway({ token: 'test-token', settings: provider.settings });
  const response = await fetch(`http://127.0.0.1:${gateway.port}/chat`, { method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: '现在几点？' }) });
  const events = [];
  try {
    for await (const data of readSse(response.body)) events.push(JSON.parse(data));
    assert.deepEqual(events.map(event => event.type), ['start', 'context', 'tool', 'tool', 'chunk', 'done']);
    assert.equal(events.at(-1).text, '现在是本地时间。');
  } finally { await gateway.close(); await provider.close(); }
});

test('command tool refuses commands outside its read-only allowlist', async () => {
  await assert.rejects(executeTool('run_command', JSON.stringify({ command: 'rm -rf .' }), { workspaceRoot: process.cwd() }), /允许列表/);
});

test('action tool normalizes a supported animation command', async () => {
  assert.deepEqual(await executeTool('set_pet_action', JSON.stringify({ action: 'wave', durationMs: 1800 })), { action: 'wave', durationMs: 1800 });
  await assert.rejects(executeTool('set_pet_action', JSON.stringify({ action: 'deleteFiles' })), /动作不在允许列表/);
});
