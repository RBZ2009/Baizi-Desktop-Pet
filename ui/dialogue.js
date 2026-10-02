/**
 * Responsibility: Configure the local conversation provider and present management results.
 * Implementation: 1. Use the fixed preload bridge. 2. Keep secrets write-only. 3. Render errors and data as text.
 */
const api = window.dialogue;
const notice = document.getElementById('notice');
const fields = ['baseUrl', 'model', 'contextWindow', 'maxOutputTokens', 'temperature', 'memoryModel', 'ttsVoice', 'ttsRate'];

// Display service errors without injecting HTML into the management page.
function showNotice(text) { notice.textContent = text; }

// Populate public configuration, leaving the saved key invisible.
async function loadSettings() {
  const settings = await api.getSettings();
  for (const key of fields) document.getElementById(key).value = settings[key];
  document.getElementById('timeoutSeconds').value = settings.requestTimeoutMs / 1000;
  for (const key of ['autoMemory', 'ttsEnabled']) document.getElementById(key).checked = settings[key];
  document.getElementById('apiKey').placeholder = settings.hasApiKey ? '已保存 Key；留空保留' : '请输入 API Key';
  if (settings.settingsError) showNotice(settings.settingsError);
}

// Save a complete validated configuration and clear the key input afterward.
document.getElementById('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const settings = Object.fromEntries(fields.map(key => [key, document.getElementById(key).value]));
    for (const key of ['autoMemory', 'ttsEnabled', 'clearApiKey']) settings[key] = document.getElementById(key).checked;
    settings.apiKey = document.getElementById('apiKey').value;
    settings.requestTimeoutMs = Number(document.getElementById('timeoutSeconds').value) * 1000;
    await api.saveSettings(settings);
    document.getElementById('apiKey').value = '';
    document.getElementById('clearApiKey').checked = false;
    await loadSettings();
    showNotice('设置已保存。');
  } catch (error) { showNotice(error.message); }
});

// Probe the saved provider configuration without adding a conversation turn.
document.getElementById('test-model').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  showNotice('正在测试已保存的模型配置…');
  try { const result = await api.manage('test'); showNotice(`连接成功：${result.text}`); }
  catch (error) { showNotice(error.message); }
  finally { button.disabled = false; }
});

// Switch panels using static DOM elements.
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-tab]').forEach(item => item.classList.toggle('selected', item === button));
  for (const id of ['settings', 'memories', 'history']) document.getElementById(id).hidden = id !== button.dataset.tab;
}));
loadSettings().catch(error => showNotice(error.message));
