/**
 * Responsibility: Define and validate gateway configuration.
 * Implementation: 1. Normalize provider URLs. 2. Bound resource limits. 3. Keep secrets out of UI responses.
 */
const { defaults: voiceDefaults, normalizeVoiceSettings } = require('./voice/settings');
const defaults = {
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen-plus', apiKey: '', temperature: 0.8,
  contextWindow: 32768, maxOutputTokens: 2048, requestTimeoutMs: 90000,
  autoMemory: true, memoryModel: '', toolsEnabled: true, commandToolsEnabled: false, ttsEnabled: false,
  ttsVoice: 'Tingting', ttsRate: 180, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  profileEnabled: true, profileProactiveQuestions: true, profileQuestionCooldownHours: 168,
  voiceApiKey: '', voiceTranscriptionApiKey: '', voiceSynthesisApiKey: '', voice: voiceDefaults
};

// Accept HTTPS providers and explicit loopback HTTP providers for local development.
function normalizeSettings(input = {}) {
  const result = { ...defaults, ...input };
  const url = new URL(String(result.baseUrl).trim());
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
    throw new Error('API 地址必须使用 HTTPS（本机服务可使用 HTTP），且不能包含凭据或查询参数。');
  }
  result.baseUrl = url.toString().replace(/\/$/, '').replace(/\/chat\/completions$/, '');
  for (const key of ['model', 'memoryModel', 'apiKey', 'ttsVoice']) result[key] = String(result[key] || '').trim();
  if (!result.model || result.model.length > 200 || result.apiKey.length > 4096) throw new Error('模型名称或 API Key 无效。');
  for (const [key, min, max] of [['temperature', 0, 2], ['contextWindow', 4096, 1000000], ['maxOutputTokens', 128, 32768], ['requestTimeoutMs', 1000, 300000], ['ttsRate', 80, 400]]) {
    const value = Number(result[key]);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} 必须在 ${min}～${max} 之间。`);
    result[key] = key === 'temperature' ? value : Math.floor(value);
  }
  if (result.maxOutputTokens + 1024 >= result.contextWindow) throw new Error('上下文窗口必须大于输出预算加 1024。');
  result.autoMemory = !!result.autoMemory;
  result.toolsEnabled = !!result.toolsEnabled;
  result.commandToolsEnabled = !!result.commandToolsEnabled;
  result.ttsEnabled = !!result.ttsEnabled;
  result.profileEnabled = result.profileEnabled !== false;
  result.profileProactiveQuestions = result.profileProactiveQuestions !== false;
  for (const key of ['voiceApiKey', 'voiceTranscriptionApiKey', 'voiceSynthesisApiKey']) {
    result[key] = String(result[key] || '').trim();
    if (result[key].length > 4096 || /[\r\n]/.test(result[key])) throw new Error('语音 API Key 无效。');
  }
  result.voice = normalizeVoiceSettings(result.voice);
  const cooldown = Number(result.profileQuestionCooldownHours);
  if (!Number.isFinite(cooldown) || cooldown < 1 || cooldown > 8760) throw new Error('用户档案主动询问冷却时间必须在 1～8760 小时之间。');
  result.profileQuestionCooldownHours = Math.floor(cooldown);
  result.timeZone = String(result.timeZone || defaults.timeZone);
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: result.timeZone }).format(); }
  catch { throw new Error('时区无效，请填写 Asia/Shanghai 等 IANA 时区。'); }
  return result;
}

// Never return the stored API key to a renderer.
function publicSettings(settings) {
  const { apiKey, voiceApiKey, voiceTranscriptionApiKey, voiceSynthesisApiKey, ...publicValue } = settings;
  return { ...publicValue, voice: normalizeVoiceSettings(settings.voice), hasApiKey: !!apiKey,
    hasVoiceApiKey: !!voiceApiKey, hasVoiceTranscriptionApiKey: !!voiceTranscriptionApiKey, hasVoiceSynthesisApiKey: !!voiceSynthesisApiKey };
}
module.exports = { defaults, normalizeSettings, publicSettings };
