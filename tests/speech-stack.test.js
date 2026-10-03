/**
 * Responsibility: Guard the response boundaries and notification stack state.
 * Implementation: 1. Exercise response IDs with a local mock provider. 2. Verify stream updates
 * do not add bubbles. 3. Cover transient prompts, replacement and stack dismissal without UI automation.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { SpeechMessages } = require('../ui/speech-messages');
const { createGateway } = require('../gateway/server');
const { normalizeSettings } = require('../gateway/settings');
const { readSse } = require('../gateway/provider');

test('stream updates stay in their response bubble and transient prompts never enter history', () => {
  const stack = new SpeechMessages();
  stack.update({ messageId: 'r:0', text: '思考中', transient: true });
  assert.equal(stack.entries.length, 0);
  stack.update({ messageId: 'r:0', text: '我查一下', closable: false });
  stack.update({ messageId: 'r:0', text: '我查一下天气', closable: false });
  assert.equal(stack.entries.length, 1);
  stack.update({ messageId: 'r:1', text: '今天晴天', closable: true });
  assert.equal(stack.current().text, '今天晴天');
  assert.equal(stack.depth(), 1);
  assert.equal(stack.entries[1].closable, true);
  stack.dismiss();
  assert.equal(stack.current().text, '我查一下天气');
  stack.clear();
  assert.equal(stack.current(), undefined);
});

test('replacement removes the preceding message and switching modes does not revive it', () => {
  const stack = new SpeechMessages(4);
  for (let index = 0; index < 8; index++) stack.update({ messageId: String(index), text: String(index) });
  assert.equal(stack.entries.length, 4);
  assert.equal(stack.depth(), 2);
  stack.setMode('replace');
  assert.equal(stack.entries.length, 1);
  stack.update({ messageId: 'latest', text: '最新' });
  assert.equal(stack.depth(), 0);
  assert.equal(stack.current().text, '最新');
  stack.setMode('stack');
  assert.equal(stack.entries.length, 1);
});

test('multiple provider responses have distinct IDs and done exposes only the final response body', async () => {
  const provider = http.createServer((req, res) => {
    let input = '';
    req.on('data', chunk => { input += chunk; });
    req.on('end', () => {
      const messages = JSON.parse(input).messages;
      const hasResult = messages.some(message => message.role === 'tool');
      res.end(JSON.stringify({ choices: [{ finish_reason: hasResult ? 'stop' : 'tool_calls', message: {
        content: hasResult ? '查询完成。' : '我查一下。',
        ...(hasResult ? {} : { tool_calls: [{ id: 'time', type: 'function', function: { name: 'get_current_time', arguments: '{}' } }] })
      } }] }));
    });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  let gateway;
  try {
    gateway = await createGateway({ token: 'stack-test', settings: normalizeSettings({
      baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'test', autoMemory: false
    }) });
    const response = await fetch(`http://127.0.0.1:${gateway.port}/chat`, { method: 'POST',
      headers: { Authorization: 'Bearer stack-test', 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: '现在几点？' }) });
    const events = [];
    for await (const data of readSse(response.body)) events.push(JSON.parse(data));
    assert.deepEqual(events.filter(event => event.type === 'chunk').map(event => [event.responseIndex, event.text]), [[0, '我查一下。'], [1, '查询完成。']]);
    assert.equal(events.at(-1).responseIndex, 1);
    assert.equal(events.at(-1).responseText, '查询完成。');
    assert.equal(events.at(-1).text, '我查一下。\n\n查询完成。');
  } finally {
    await gateway?.close();
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  }
});
