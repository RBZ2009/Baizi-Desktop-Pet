/**
 * Responsibility: Adapt OpenAI-compatible HTTP transcription and speech services.
 * Implementation: 1. Upload in-memory recordings as multipart. 2. Request binary MP3 speech.
 * 3. Bound response sizes and timeouts and keep credentials in the main process.
 * Services may be local adapters; WebRTC/Realtime protocols require a separate provider.
 */
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const AUDIO_TYPES = Object.freeze({ 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' });

// Carry only bearer credentials and explicit content negotiation across the HTTP boundary.
function createRequestHeaders(apiKey, extra = {}) {
  return { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...extra };
}

// Consume bounded bodies even when a provider uses chunked transfer without Content-Length.
async function readBody(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('语音服务响应过大。'); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > limit) throw new Error('语音服务响应过大。');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

class HttpVoiceProvider {
  // Allow different services/keys for input and output; never reuse the text model's key implicitly.
  constructor({ settings, apiKey = '', transcriptionApiKey = '', synthesisApiKey = '', fetchImpl = fetch } = {}) {
    this.settings = settings;
    this.transcriptionApiKey = transcriptionApiKey || apiKey;
    this.synthesisApiKey = synthesisApiKey || apiKey;
    this.fetch = fetchImpl;
  }

  // Apply deadlines to headers and body consumption; redirects must not move recorded audio to another host.
  async request(endpoint, options, signal, apiKey, limit) {
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000);
    try {
      const response = await this.fetch(endpoint, { ...options, redirect: 'error', signal: combined });
      const bytes = await readBody(response, response.ok ? limit : 65536);
      if (!response.ok) {
        let message = `语音服务请求失败（${response.status}）。`;
        try { const value = JSON.parse(bytes.toString('utf8')); message = value.error?.message || value.error || value.message || message; } catch { /* Keep non-JSON responses out of the UI. */ }
        throw new Error(String(message).split(apiKey || '\u0000').join('[redacted]').slice(0, 350));
      }
      return { bytes, mimeType: response.headers.get('content-type')?.split(';')[0] || 'audio/mpeg' };
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      if (combined.aborted) throw new Error('语音服务超时，请检查服务地址或稍后重试。');
      throw error;
    }
  }

  // Match the recording's MIME type and extension, and require a bounded JSON transcript.
  async transcribe(audio, { signal } = {}) {
    if (!this.settings.inputEnabled) throw new Error('麦克风输入已关闭。');
    const mimeType = audio.type.split(';')[0];
    if (!AUDIO_TYPES[mimeType] || !audio.size || audio.size > MAX_AUDIO_BYTES) throw new Error('录音格式或大小无效。');
    const form = new FormData();
    form.append('file', audio, `microphone.${AUDIO_TYPES[mimeType]}`);
    form.append('model', this.settings.transcriptionModel);
    form.append('response_format', 'json');
    if (this.settings.language) form.append('language', this.settings.language);
    const { bytes } = await this.request(this.settings.transcriptionEndpoint, {
      method: 'POST', headers: createRequestHeaders(this.transcriptionApiKey, { Accept: 'application/json' }), body: form
    }, signal, this.transcriptionApiKey, 131072);
    let result;
    try { result = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('转写接口未返回有效 JSON。'); }
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    if (!text) throw new Error('没有识别到语音，请再试一次。');
    if (text.length > 12000) throw new Error('转写内容过长，请缩短录音。');
    return text;
  }

  // Use the speech endpoint's schema; style instructions are opt-in for models that support them.
  async synthesize(text, { signal } = {}) {
    if (this.settings.provider !== 'custom' || !this.settings.outputEnabled) throw new Error('API 配音已关闭。');
    const { bytes, mimeType } = await this.request(this.settings.synthesisEndpoint, {
      method: 'POST', headers: createRequestHeaders(this.synthesisApiKey, { 'Content-Type': 'application/json', Accept: 'audio/mpeg' }),
      body: JSON.stringify({ model: this.settings.synthesisModel, voice: this.settings.voice, input: text,
        speed: this.settings.speed, response_format: 'mp3', ...(this.settings.instructions ? { instructions: this.settings.instructions } : {}) })
    }, signal, this.synthesisApiKey, MAX_AUDIO_BYTES);
    if (!bytes.length || !mimeType.startsWith('audio/')) throw new Error('合成接口未返回可播放音频。');
    return { audio: Uint8Array.from(bytes), mimeType };
  }
}

module.exports = { HttpVoiceProvider, createRequestHeaders, MAX_AUDIO_BYTES, AUDIO_TYPES };
