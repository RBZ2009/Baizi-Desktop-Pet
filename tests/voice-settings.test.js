/**
 * Responsibility: Verify voice preferences remain provider-independent and safe at the config boundary.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeVoiceSettings } = require('../gateway/voice/settings');

test('voice settings default to disabled input and reject unsafe endpoints', () => {
  const settings = normalizeVoiceSettings();
  assert.equal(settings.provider, 'none');
  assert.equal(settings.inputEnabled, false);
  assert.throws(() => normalizeVoiceSettings({ transcriptionEndpoint: 'http://voice.example/api' }), /HTTPS/);
  assert.throws(() => normalizeVoiceSettings({ transcriptionEndpoint: 'https://user:pass@voice.example' }), /凭据/);
});

test('voice settings accept local HTTP adapters and normalize flags', () => {
  const settings = normalizeVoiceSettings({ transcriptionEndpoint: 'http://127.0.0.1:8787/', transcriptionModel: 'local-stt', inputEnabled: 1, autoSend: 0 });
  assert.equal(settings.transcriptionEndpoint, 'http://127.0.0.1:8787');
  assert.equal(settings.inputEnabled, true);
  assert.equal(settings.autoSend, false);
});
