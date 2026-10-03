/**
 * Responsibility: Guard against stale text replies and overlapping speech playback.
 * Implementation: 1. Exercise the actual renderer handler in a controlled VM. 2. Mock only the operating-system speech process. 3. Assert cancellation ownership.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

test('chat overlay ignores stale replies and completes text independently of speech', () => {
  const source = fs.readFileSync(require.resolve('../ui/chat.js'), 'utf8');
  const listeners = {}; const shown = []; const streams = []; const keyHandlers = [];
  const input = { value: '', style: {}, addEventListener(type, callback) { if (type === 'keydown') keyHandlers.push(callback); } };
  const panel = { style: { setProperty() {} }, classList: { toggle() {} }, getBoundingClientRect: () => ({ height: 42 }) };
  const context = {
    document: { getElementById: id => id === 'chat-input' ? input : panel, createElement: () => ({ getContext: () => ({ font: '', measureText: text => ({ width: text.length * 6 }) }) }), body: { appendChild() {} } },
    window: { desktopPet: {
      cancelChat() {}, chatQueryStream: (id, text) => streams.push({ id, text }),
      onChatStream(callback) { listeners.stream = callback; }, onSpeechStatus(callback) { listeners.speech = callback; },
      setSpeechText: payload => shown.push(payload.text), hideSpeech() {}, setChatWindowSize() {},
      getDialogueSettings: () => Promise.resolve({}), onChatWindowAnchor() {}, onChatPanelVisibility() {}
    }, addEventListener() {} },
    getComputedStyle: () => ({ font: '12px sans-serif' }), setTimeout, clearTimeout, Date, Math, console
  };
  vm.runInNewContext(source, context);
  input.value = '第一条'; keyHandlers[0]({ key: 'Enter', shiftKey: false, isComposing: false, preventDefault() {} });
  const first = streams[0].id;
  input.value = '第二条'; keyHandlers[0]({ key: 'Enter', shiftKey: false, isComposing: false, preventDefault() {} });
  const second = streams[1].id;
  listeners.stream({ requestId: first, type: 'chunk', text: '过期回复' });
  assert.ok(!shown.includes('过期回复'));
  listeners.stream({ requestId: second, type: 'chunk', text: '新回复' });
  listeners.stream({ requestId: second, type: 'done', text: '新回复' });
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
