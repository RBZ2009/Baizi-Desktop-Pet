/**
 * Responsibility: Validate the configurable HTTP speech contract without choosing a vendor.
 * Implementation: 1. Allowlist fields. 2. Validate independent endpoints/models. 3. Bound audio settings.
 * Input defaults preserve the existing macOS voice and leave the microphone disabled.
 */
const defaults = Object.freeze({
  provider: 'none', inputEnabled: false, outputEnabled: true,
  transcriptionEndpoint: '', synthesisEndpoint: '', transcriptionModel: '', synthesisModel: '',
  voice: '', language: 'zh', instructions: '', speed: 1,
  autoSend: false, maxRecordingSeconds: 60
});

// Only explicitly configured HTTPS or loopback HTTP services may receive audio or credentials.
function normalizeEndpoint(value) {
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { throw new Error('语音服务地址无效。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
    throw new Error('语音服务地址必须使用 HTTPS（本机服务可使用 HTTP），且不能包含凭据或查询参数。');
  }
  return url.toString().replace(/\/$/, '');
}

// Copy only the public schema so unexpected fields, including credentials, cannot reach a renderer.
function normalizeVoiceSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('语音配置无效。');
  const result = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, input[key] ?? value]));
  if (!['none', 'custom', 'system'].includes(result.provider)) throw new Error('语音输出模式无效。');
  for (const key of ['transcriptionEndpoint', 'synthesisEndpoint']) result[key] = normalizeEndpoint(String(result[key]).trim());
  for (const key of ['transcriptionModel', 'synthesisModel', 'voice', 'language', 'instructions']) {
    result[key] = String(result[key]).trim();
    if (result[key].length > (key === 'instructions' ? 1500 : 200)) throw new Error('语音配置文字过长。');
  }
  if (result.language && !/^[a-z]{2,3}$/.test(result.language)) throw new Error('转写语言请填写 zh、en 等语言代码，留空自动识别。');
  for (const key of ['inputEnabled', 'outputEnabled', 'autoSend']) result[key] = !!result[key];
  for (const [key, min, max] of [['speed', 0.25, 4], ['maxRecordingSeconds', 5, 120]]) {
    result[key] = Number(result[key]);
    if (!Number.isFinite(result[key]) || result[key] < min || result[key] > max) throw new Error(`${key} 必须在 ${min}～${max} 之间。`);
  }
  result.maxRecordingSeconds = Math.floor(result.maxRecordingSeconds);
  if (result.inputEnabled && (!result.transcriptionEndpoint || !result.transcriptionModel)) throw new Error('启用麦克风时请填写转写地址和转写模型。');
  if (result.provider === 'custom' && result.outputEnabled && (!result.synthesisEndpoint || !result.synthesisModel || !result.voice)) {
    throw new Error('启用 API 配音时请填写合成地址、合成模型和声音。');
  }
  return result;
}

module.exports = { defaults, normalizeVoiceSettings };
