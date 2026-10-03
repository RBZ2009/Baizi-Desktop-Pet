/**
 * Responsibility: Define and execute the local tools available to the dialogue model.
 * Implementation:
 * 1. Expose provider-neutral JSON Schema definitions.
 * 2. Validate every model argument at the gateway boundary.
 * 3. Keep network tools bounded and restrict command execution to read-only allowlisted tasks.
 */
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const execFileAsync = promisify(execFile);
const MAX_TOOL_TEXT = 12000;

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
    type: 'object', properties: { command: { type: 'string', enum: ['pwd', 'date', 'whoami', 'uname', 'ls', 'git status', 'git log --oneline -5', 'npm test'] } }, required: ['command'], additionalProperties: false
  } } }
];

// Keep external responses short so a web page cannot consume the conversation budget.
function clip(value, limit = MAX_TOOL_TEXT) { return String(value || '').replace(/\u0000/g, '').slice(0, limit); }

// Decode the entities commonly returned by lightweight HTML search endpoints.
function decodeHtml(value) {
  return String(value || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// Fetch JSON with one bounded deadline shared by the tool request.
async function fetchJson(url, signal) {
  const response = await fetch(url, { signal: signal || AbortSignal.timeout(12000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`外部服务返回 HTTP ${response.status}。`);
  return response.json();
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
  return { location: `${place.name}${place.country ? `，${place.country}` : ''}`, timezone: forecast.timezone, current: forecast.current, daily: forecast.daily };
}

// Search DuckDuckGo's lightweight HTML endpoint and return text-only snippets.
async function searchWeb(args, options) {
  const query = String(args?.query || '').trim().slice(0, 200);
  const count = Math.max(1, Math.min(5, Number(args?.count) || 3));
  if (!query) throw new Error('网页搜索需要关键词。');
  const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { signal: options.signal || AbortSignal.timeout(12000), headers: { Accept: 'text/html', 'User-Agent': 'BaiziDesktopPet/1.0' } });
  if (!response.ok) throw new Error(`搜索服务返回 HTTP ${response.status}。`);
  const html = await response.text();
  const matches = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const results = matches.slice(0, count).map((match, index) => {
    const start = match.index + match[0].length;
    const snippet = html.slice(start, start + 1800).match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>|class="result__snippet"[^>]*>([\s\S]*?)<\/div>/)?.[1] || html.slice(start, start + 1800).match(/class="result__snippet"[^>]*>([\s\S]*?)<\/div>/)?.[1] || '';
    return { rank: index + 1, title: clip(decodeHtml(match[2].replace(/<[^>]+>/g, '')), 240), url: decodeHtml(match[1]), snippet: clip(decodeHtml(snippet.replace(/<[^>]+>/g, '')), 500) };
  });
  return { query, results };
}

// Execute one explicitly allowlisted command without invoking a shell.
async function runCommand(args, options) {
  const command = String(args?.command || '').trim();
  const commands = {
    pwd: ['pwd', []], date: ['date', []], whoami: ['whoami', []], uname: ['uname', ['-a']], ls: ['ls', ['-la']],
    'git status': ['git', ['status', '--short']], 'git log --oneline -5': ['git', ['log', '--oneline', '-5']],
    'npm test': [process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test']]
  };
  if (!commands[command]) throw new Error('该命令不在只读允许列表中。');
  const cwd = path.resolve(options.workspaceRoot || process.cwd());
  try {
    const result = await execFileAsync(commands[command][0], commands[command][1], { cwd, timeout: 15000, maxBuffer: 512 * 1024, windowsHide: true });
    return { command, cwd, exitCode: 0, stdout: clip(result.stdout), stderr: clip(result.stderr) };
  } catch (error) {
    return { command, cwd, exitCode: Number.isInteger(error.code) ? error.code : 1, stdout: clip(error.stdout), stderr: clip(error.stderr || error.message) };
  }
}

// Parse and route a model tool call while keeping all side effects behind one boundary.
async function executeTool(name, rawArguments, options = {}) {
  let args;
  try { args = typeof rawArguments === 'string' ? JSON.parse(rawArguments || '{}') : (rawArguments || {}); }
  catch { throw new Error('工具参数不是有效 JSON。'); }
  if (!definitions.some(definition => definition.function.name === name)) throw new Error('模型请求了未注册的工具。');
  if (name === 'get_current_time') return getCurrentTime(args, options);
  if (name === 'get_weather') return getWeather(args, options);
  if (name === 'search_web') return searchWeb(args, options);
  if (name === 'run_command') return runCommand(args, options);
  throw new Error('工具不可用。');
}

module.exports = { definitions, executeTool, clip };
