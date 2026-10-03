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
const { sandboxProfile } = require('../gateway/tools/shell-tool');

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

test('provider keeps fragmented tool arguments separate from streamed reply text', async () => {
  const provider = await mockProvider((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frames = [
      { choices: [{ delta: { content: '嗯，', tool_calls: [{ index: 0, id: 'call_nod', type: 'function', function: { name: 'set_pet_action', arguments: '{"action":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"nod"}' } }] }, finish_reason: 'tool_calls' }] }
    ];
    res.end(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n');
  });
  try {
    let visible = '';
    const result = await chatCompletion(provider.settings, [], { tools: [{ type: 'function', function: { name: 'set_pet_action' } }], onDelta: text => visible += text });
    assert.equal(visible, '嗯，');
    assert.equal(result.toolCalls[0].function.arguments, '{"action":"nod"}');
    assert.equal(result.toolCalls[0].id, 'call_nod');
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
      // Match the actual user request; action guidance can legitimately contain the word “等待”.
      if (JSON.parse(input).messages.filter(message => message.role === 'user').at(-1)?.content === '等待') return;
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

test('command tool requires explicit directory approval and produces a bounded sandbox', async () => {
  await assert.rejects(executeTool('run_command', JSON.stringify({ command: 'cat notes.md' }), { workspaceRoot: process.cwd(), workspacePermissions: [] }), error => {
    assert.equal(error.code, 'WORKSPACE_PERMISSION_REQUIRED');
    assert.equal(error.path, process.cwd());
    return true;
  });
  const profile = sandboxProfile(['/tmp/approved'], ['/tmp/private']);
  assert.match(profile, /deny default/);
  assert.match(profile, /subpath "\/tmp\/approved"/);
  assert.match(profile, /deny file-read\* file-write\* \(subpath "\/tmp\/private"\)/);
  assert.doesNotMatch(profile, /network-outbound/);
});

test('action tool normalizes a supported animation command', async () => {
  assert.deepEqual(await executeTool('set_pet_action', JSON.stringify({ action: 'wave', durationMs: 1800 })), { action: 'wave', durationMs: 1800 });
  await assert.rejects(executeTool('set_pet_action', JSON.stringify({ action: 'deleteFiles' })), /动作不在允许列表/);
  assert.equal((await executeTool('set_pet_action', '{"action":"nod"}')).durationMs, 1400);
  await assert.rejects(executeTool('set_pet_action', '{"action":"nod","durationMs":1.5}'), /参数无效/);
  await assert.rejects(executeTool('run_command', '{"command":"npm test"}'), /授权/);
  await assert.rejects(executeTool('get_current_time', 'null'), /JSON 对象/);
});

test('gateway exposes dialogue gestures and forwards a model-selected comfort action', async () => {
  let offeredActions = [];
  const provider = await mockProvider((req, res) => {
    let input = '';
    req.on('data', chunk => input += chunk);
    req.on('end', () => {
      const body = JSON.parse(input);
      if (!body.messages.some(message => message.role === 'tool')) {
        offeredActions = body.tools.find(tool => tool.function.name === 'set_pet_action').function.parameters.properties.action.enum;
        return res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
          { id: 'call_comfort', type: 'function', function: { name: 'set_pet_action', arguments: '{"action":"comfort"}' } }
        ] } }] }));
      }
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '嗯，我在这里。' } }] }));
    });
  });
  const gateway = await createGateway({ token: 'test-token', settings: provider.settings });
  try {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/chat`, { method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: '今天工作好累。' }) });
    const events = [];
    for await (const data of readSse(response.body)) events.push(JSON.parse(data));
    for (const action of ['listen', 'explain', 'confused', 'idea', 'shy', 'comfort', 'cheer', 'stretch',
      'proud', 'surprised', 'protest', 'peek', 'sleepy', 'clap']) {
      assert.ok(offeredActions.includes(action), action);
      assert.equal((await executeTool('set_pet_action', JSON.stringify({ action }))).action, action);
    }
    assert.deepEqual(events.find(event => event.name === 'set_pet_action' && event.status === 'complete')?.result,
      { action: 'comfort', durationMs: 4000 });
    assert.equal(events.at(-1).text, '嗯，我在这里。');
  } finally { await gateway.close(); await provider.close(); }
});

test('gateway falls back to plain text when an older provider rejects tool fields', async () => {
  const provider = await mockProvider((req, res) => {
    let input = '';
    req.on('data', chunk => input += chunk);
    req.on('end', () => {
      const body = JSON.parse(input);
      if (body.tools) return res.writeHead(400).end('{}');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '兼容文字回复。' } }] }));
    });
  });
  const gateway = await createGateway({ token: 'test-token', settings: provider.settings });
  try {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/chat`, { method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: '你好' }) });
    const events = [];
    for await (const data of readSse(response.body)) events.push(JSON.parse(data));
    assert.equal(events.at(-1).text, '兼容文字回复。');
    assert.equal(events.find(event => event.status === 'unavailable')?.name, 'tools');
  } finally { await gateway.close(); await provider.close(); }
});
