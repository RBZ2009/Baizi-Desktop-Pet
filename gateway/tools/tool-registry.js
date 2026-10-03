/**
 * Responsibility: Define and execute the local tools available to the dialogue model.
 * Implementation:
 * 1. Expose provider-neutral JSON Schema definitions.
 * 2. Validate every model argument at the gateway boundary.
 * 3. Keep network tools bounded and restrict command execution to read-only allowlisted tasks.
 */
const { execFile } = require('node:child_process');
const path = require('node:path');
const { actionToolDefinition, normalizeAction } = require('../actions/action-registry');

const MAX_TOOL_TEXT = 12000;
const commands = {
  pwd: ['pwd', []], date: ['date', []], whoami: ['whoami', []], uname: ['uname', ['-a']], ls: ['ls', ['-la']],
  'git status': ['git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--short']],
  'git log --oneline -5': ['git', ['--no-pager', '-c', 'core.fsmonitor=false', 'log', '--oneline', '-5']]
};

const definitions = [
  { type: 'function', function: { name: 'get_current_time', description: '获取指定时区的当前日期和时间。', parameters: {
    type: 'object', properties: { timeZone: { type: 'string', description: 'IANA 时区，例如 Asia/Shanghai。' } }, additionalProperties: false
  } } },
  { type: 'function', function: { name: 'get_weather', description: '查询城市当前天气和未来几天的预报。', parameters: {
    type: 'object', properties: { city: { type: 'string', description: '城市名，例如上海或 Tokyo。' }, days: { type: 'integer', minimum: 1, maximum: 3 } }, required: ['city'], additionalProperties: false
  } } },
  { type: 'function', function: { name: 'search_web', description: '搜索公开网页，返回少量标题、摘要和链接。', parameters: {
    type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 }, count: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['query'], additionalProperties: false
  } } },
  { type: 'function', function: { name: 'run_command', description: '运行一个安全的只读本地诊断命令。只能从允许列表中选择，不能执行修改文件或任意 shell。', parameters: {
    type: 'object', properties: { command: { type: 'string', enum: Object.keys(commands) } }, required: ['command'], additionalProperties: false
  } } },
  actionToolDefinition
];

// Keep external responses short so a web page cannot consume the conversation budget.
function clip(value, limit = MAX_TOOL_TEXT) { return String(value || '').replace(/\u0000/g, '').slice(0, limit); }

// Decode the entities commonly returned by lightweight HTML search endpoints.
function decodeHtml(value) {
  return String(value || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (match, code) => {
      const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
      return point <= 0x10ffff ? String.fromCodePoint(point) : match;
    });
}

// Bound both body bytes and time independently of the foreground conversation deadline.
async function fetchText(url, signal, accept) {
  const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000);
  const response = await fetch(url, { signal: boundedSignal, headers: { Accept: accept, 'User-Agent': 'BaiziDesktopPet/1.0' } });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`外部服务返回 HTTP ${response.status}。`); }
  if (!response.body) throw new Error('外部服务未返回内容。');
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error('外部服务内容超过 1 MB 限制。');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// Fetch JSON through the same byte-limited network boundary.
async function fetchJson(url, signal) {
  return JSON.parse(await fetchText(url, signal, 'application/json'));
}

// Return a compact current-time payload without contacting a provider.
function getCurrentTime(args, options) {
  const timeZone = String(args?.timeZone || options.timeZone || 'Asia/Shanghai');
  try {
    const date = new Date();
    const formatter = new Intl.DateTimeFormat('zh-CN', { timeZone, dateStyle: 'full', timeStyle: 'long' });
    return { timeZone, iso: date.toISOString(), local: formatter.format(date) };
  } catch { throw new Error('时区无效，请使用 Asia/Shanghai 等 IANA 时区。'); }
}

// Resolve a city then query Open-Meteo without requiring a separate API key.
async function getWeather(args, options) {
  const city = String(args?.city || '').trim().slice(0, 80);
  const days = Math.max(1, Math.min(3, Number(args?.days) || 1));
  if (!city) throw new Error('天气查询需要城市名。');
  const signal = options.signal || AbortSignal.timeout(12000);
  const geo = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`, signal);
  const place = geo.results?.[0];
  if (!place) throw new Error(`没有找到城市“${city}”。`);
  const forecast = await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,weather_code&forecast_days=${days}&timezone=auto`, signal);
  return { source: 'https://open-meteo.com/', location: `${place.name}${place.admin1 ? `，${place.admin1}` : ''}${place.country ? `，${place.country}` : ''}`,
    timezone: forecast.timezone, current: forecast.current, currentUnits: forecast.current_units, daily: forecast.daily, dailyUnits: forecast.daily_units };
}

// Recover attribute values without depending on HTML attribute ordering.
function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1] || '';
}

// Resolve search-engine redirect links to an HTTP(S) destination without visiting the target.
function resultUrl(raw) {
  try {
    const url = new URL(decodeHtml(raw), 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    const destination = target ? new URL(target) : url;
    return ['http:', 'https:'].includes(destination.protocol) ? destination.href : '';
  } catch { return ''; }
}

// Search DuckDuckGo's lightweight HTML endpoint and return text-only snippets.
async function searchWeb(args, options) {
  const query = String(args?.query || '').trim().slice(0, 200);
  const count = Math.max(1, Math.min(5, Number(args?.count) || 3));
  if (!query) throw new Error('网页搜索需要关键词。');
  const html = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, options.signal, 'text/html');
  if (/anomaly-modal|bots use DuckDuckGo|challenge-form/i.test(html)) throw new Error('搜索服务要求验证码，请稍后再试或使用浏览器搜索。');
  const matches = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].filter(match => attribute(match[1], 'class').split(/\s+/).includes('result__a'));
  const results = matches.slice(0, count).map((match, index) => {
    const start = match.index + match[0].length;
    const snippet = html.slice(start, start + 4000).match(/<(?:a|div)\b[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i)?.[1] || '';
    return { rank: index + 1, title: clip(decodeHtml(match[2].replace(/<[^>]+>/g, '')), 240), url: resultUrl(attribute(match[1], 'href')), snippet: clip(decodeHtml(snippet.replace(/<[^>]+>/g, '')), 500) };
  }).filter(item => item.url);
  if (!results.length && !/no-results|No results found/i.test(html)) throw new Error('搜索服务未返回可解析结果，请稍后再试。');
  return { source: 'DuckDuckGo', query, results, note: '结果来自搜索摘要，未打开目标网页。' };
}

// Execute one explicitly allowlisted command without invoking a shell.
async function runCommand(args, options) {
  const command = String(args?.command || '').trim();
  if (!Object.hasOwn(commands, command)) throw new Error('该命令不在只读允许列表中。');
  const cwd = path.resolve(options.workspaceRoot || process.cwd());
  return new Promise((resolve, reject) => execFile(commands[command][0], commands[command][1], {
    cwd, timeout: 10000, maxBuffer: 64 * 1024, windowsHide: true, signal: options.signal,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', GIT_TERMINAL_PROMPT: '0' }
  }, (error, stdout, stderr) => {
    if (options.signal?.aborted) return reject(Object.assign(new Error('请求已取消。'), { name: 'AbortError' }));
    resolve({ command, exitCode: Number.isInteger(error?.code) ? error.code : (error ? 1 : 0), stdout: clip(stdout), stderr: clip(stderr || error?.message) });
  }));
}

// Enforce the published schema locally rather than trusting model/provider validation.
function validateArguments(definition, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是 JSON 对象。');
  const schema = definition.function.parameters;
  for (const key of schema.required || []) if (!Object.hasOwn(args, key)) throw new Error(`工具缺少参数：${key}。`);
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties[key];
    if (!property || (property.type === 'string' ? typeof value !== 'string' : !Number.isInteger(value))) throw new Error(`工具参数无效：${key}。`);
    if (property.enum && !property.enum.includes(value)) throw new Error(key === 'command' ? '该命令不在只读允许列表中。' : key === 'action' ? '桌宠动作不在允许列表中。' : `参数 ${key} 不在允许列表中。`);
    if (property.type === 'string' && (!value.trim() || value.length > (property.maxLength || 200))) throw new Error(`参数 ${key} 为空或过长。`);
    if ((property.minimum !== undefined && value < property.minimum) || (property.maximum !== undefined && value > property.maximum)) throw new Error(`参数 ${key} 超过限制。`);
  }
}

// Parse and route a model tool call while keeping all side effects behind one boundary.
async function executeTool(name, rawArguments, options = {}) {
  let args;
  try { args = typeof rawArguments === 'string' ? JSON.parse(rawArguments || '{}') : (rawArguments || {}); }
  catch { throw new Error('工具参数不是有效 JSON。'); }
  const definition = definitions.find(definition => definition.function.name === name);
  if (!definition) throw new Error('模型请求了未注册的工具。');
  validateArguments(definition, args);
  if (name === 'get_current_time') return getCurrentTime(args, options);
  if (name === 'get_weather') return getWeather(args, options);
  if (name === 'search_web') return searchWeb(args, options);
  if (name === 'run_command') return runCommand(args, options);
  if (name === 'set_pet_action') return normalizeAction(args);
  throw new Error('工具不可用。');
}

module.exports = { definitions, executeTool, clip };
