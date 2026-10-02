/**
 * Responsibility: Guard against stale text replies and overlapping speech playback.
 * Implementation: 1. Exercise the actual renderer handler in a controlled VM. 2. Mock only the operating-system speech process. 3. Assert cancellation ownership.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

test('new replies detach old listeners and text completion does not wait for audio', async () => {
  const source = fs.readFileSync(require.resolve('../renderer.js'), 'utf8');
  const start = source.indexOf('let chatUnsubscribe = null;');
  const end = source.indexOf('function updateDebug()', start);
  const subscriptions = []; const shown = [];
  const context = { window: { desktopPet: { cancelChat() {}, chatQueryStream() {},
    onChatStream(callback) { const item = { callback, active: true }; subscriptions.push(item); return () => item.active = false; } } },
    document: {}, chatInputEl: { value: '第一条' }, speechHideTimer: null, activeChatRequestId: null,
    setChatPanelVisible() {}, renderStreamingSpeech: text => shown.push(text), showSpeech: text => shown.push(text),
    Date, Math, clearTimeout, console };
  vm.runInNewContext(source.slice(start, end), context);
  await context.submitChatPrompt(); const first = context.activeChatRequestId;
  context.chatInputEl.value = '第二条'; await context.submitChatPrompt(); const second = context.activeChatRequestId;
  assert.equal(subscriptions[0].active, false);
  subscriptions[0].callback({ requestId: first, type: 'chunk', text: '过期回复' });
  assert.ok(!shown.includes('过期回复'));
  subscriptions[1].callback({ requestId: second, type: 'chunk', text: '新回复' });
  subscriptions[1].callback({ requestId: second, type: 'done', text: '新回复' });
  assert.equal(context.activeChatRequestId, null);
  assert.equal(subscriptions[1].active, false);
  assert.equal(shown.at(-1), '新回复');
});

test('speech uses stdin, queues sentences and invalidates callbacks after interruption', () => {
  const children = []; const statuses = [];
  const module = { exports: {} };
  const source = fs.readFileSync(require.resolve('../speech-service.js'), 'utf8');
  const context = { module, process: { platform: 'darwin' }, require: () => ({ spawn(command, args) {
    const child = new EventEmitter();
    child.stdin = new EventEmitter(); child.stdin.end = text => child.text = text;
    child.kill = () => child.killed = true;
    child.command = command; child.args = args; children.push(child); return child;
  } }) };
  vm.runInNewContext(source, context);
  const service = new module.exports.SpeechService();
  service.begin({ ttsEnabled: true, ttsVoice: 'Tingting', ttsRate: 180 }, event => statuses.push(event));
  service.append('第一句。第二句。尾句');
  assert.equal(children.length, 1);
  assert.equal(children[0].text, '第一句。');
  assert.ok(!children[0].args.includes('第一句。'));
  children[0].emit('close', 0);
  assert.equal(children.length, 2);
  service.finish();
  children[1].emit('close', 0);
  assert.equal(children[2].text, '尾句');
  service.begin({ ttsEnabled: true, ttsVoice: 'Tingting', ttsRate: 180 }, event => statuses.push(event));
  assert.equal(children[2].killed, true);
  children[2].emit('close', 1);
  assert.equal(statuses.length, 0);
});
