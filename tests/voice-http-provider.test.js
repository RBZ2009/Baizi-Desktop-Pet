/**
 * Responsibility: Verify the configurable HTTP voice adapter's request shape and response parsing.
 * Implementation: Use a deterministic fetch stub for successful transcription, synthesis and errors.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HttpVoiceProvider, createRequestHeaders } = require('../gateway/voice/http-provider');

test('HTTP voice provider sends authenticated transcription and parses text', async () => {
  const requests = [];
  const provider = new HttpVoiceProvider({ settings: { inputEnabled: true, transcriptionEndpoint: 'https://voice.example/transcribe', transcriptionModel: 'stt-1' }, apiKey: 'secret', fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ text: '  你好，白子。  ' }), { headers: { 'content-type': 'application/json' } });
  } });
  assert.equal(await provider.transcribe(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' })), '你好，白子。');
  assert.equal(requests[0].url, 'https://voice.example/transcribe');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer secret');
  assert.equal(requests[0].options.method, 'POST');
});

test('HTTP voice provider returns synthesized bytes and reports bounded service errors', async () => {
  let body;
  const provider = new HttpVoiceProvider({ settings: { provider: 'custom', outputEnabled: true, synthesisEndpoint: 'https://voice.example/speech', synthesisModel: 'tts-1', voice: 'baizi', speed: 1 }, fetchImpl: async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(Uint8Array.from([9, 8, 7]), { headers: { 'content-type': 'audio/mpeg' } });
  } });
  assert.deepEqual([...(await provider.synthesize('你好')).audio], [9, 8, 7]);
  assert.equal(body.input, '你好');
  assert.equal(body.voice, 'baizi');
  assert.deepEqual(createRequestHeaders(''), {});
});

test('HTTP voice provider preserves service error text', async () => {
  const provider = new HttpVoiceProvider({ settings: { inputEnabled: true, transcriptionEndpoint: 'https://voice.example', transcriptionModel: 'stt-1' }, fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'provider unavailable' } }), { status: 503 }) });
  await assert.rejects(() => provider.transcribe(new Blob(['audio'], { type: 'audio/webm' })), /provider unavailable/);
});
