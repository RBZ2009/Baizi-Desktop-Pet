/**
 * Responsibility: Verify voice session ownership, normalized provider events and fallback playback.
 * Implementation: 1. Use an in-memory provider. 2. Interrupt it with a newer session. 3. Assert
 * stale events and provider failures cannot control the current session.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { VoiceSession, STATES } = require('../gateway/voice/session');

test('fallback owns text playback and cancellation invalidates late status', () => {
  const calls = []; const statuses = []; const events = [];
  const fallback = {
    begin(settings, onStatus) { calls.push(['begin', settings]); this.onStatus = onStatus; },
    append(text) { calls.push(['append', text]); },
    finish() { calls.push(['finish']); },
    stop() { calls.push(['stop']); }
  };
  const session = new VoiceSession({ fallback, onEvent: event => events.push(event) });
  const id = session.beginFallback({ ttsEnabled: true }, status => statuses.push(status));
  session.appendText('你好。'); session.finishText();
  assert.equal(session.state, STATES.FALLBACK);
  assert.deepEqual(calls.slice(-2), [['append', '你好。'], ['finish']]);
  fallback.onStatus({ type: 'playing' });
  assert.equal(statuses.length, 1);
  session.cancel();
  fallback.onStatus({ type: 'idle' });
  assert.equal(statuses.length, 1);
  assert.equal(events.at(-1).type, 'session.stopped');
  assert.equal(events.at(-1).sessionId, id);
});

test('provider events normalize state and stale events are ignored after replacement', async () => {
  const events = []; const providers = [];
  const provider = {
    async connect({ emit }) { providers.push(emit); emit({ type: 'session.ready' }); return () => {}; }
  };
  const session = new VoiceSession({ onEvent: event => events.push(event) });
  const first = await session.connect(provider);
  assert.equal(session.state, STATES.LISTENING);
  await session.connect(provider);
  providers[0]({ type: 'response.started' });
  assert.equal(session.state, STATES.LISTENING);
  providers[1]({ type: 'response.started' });
  assert.equal(session.state, STATES.RESPONDING);
  assert.equal(events.filter(event => event.type === 'response.started').length, 1);
  assert.notEqual(first, session.sessionId);
});

test('provider errors become session.error without throwing into the renderer event loop', async () => {
  const events = [];
  const session = new VoiceSession({ onEvent: event => events.push(event) });
  await session.connect({ async connect() { return { close() {} }; } });
  assert.equal(session.handle({ type: 'error', error: '连接断开' }), true);
  assert.equal(session.state, STATES.FAILED);
  assert.deepEqual(events.at(-1), { type: 'session.error', sessionId: session.sessionId, error: '连接断开' });
});
