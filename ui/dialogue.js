/**
 * Responsibility: Configure the local conversation provider and present management results.
 * Implementation: 1. Use the fixed preload bridge. 2. Keep secrets write-only. 3. Render errors and data as text.
 */
const api = window.dialogue;
const notice = document.getElementById('notice');
const fields = ['baseUrl', 'model', 'contextWindow', 'maxOutputTokens', 'temperature', 'memoryModel', 'ttsVoice', 'ttsRate', 'timeZone'];

// Display service errors without injecting HTML into the management page.
function showNotice(text) { notice.textContent = text; }

// Populate public configuration, leaving the saved key invisible.
async function loadSettings() {
  const settings = await api.getSettings();
  for (const key of fields) document.getElementById(key).value = settings[key];
  document.getElementById('timeoutSeconds').value = settings.requestTimeoutMs / 1000;
  for (const key of ['autoMemory', 'toolsEnabled', 'commandToolsEnabled', 'ttsEnabled']) document.getElementById(key).checked = settings[key];
  document.getElementById('apiKey').placeholder = settings.hasApiKey ? '已保存 Key；留空保留' : '请输入 API Key';
  if (settings.settingsError) showNotice(settings.settingsError);
}

// Save a complete validated configuration and clear the key input afterward.
document.getElementById('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const settings = Object.fromEntries(fields.map(key => [key, document.getElementById(key).value]));
    for (const key of ['autoMemory', 'toolsEnabled', 'commandToolsEnabled', 'ttsEnabled', 'clearApiKey']) settings[key] = document.getElementById(key).checked;
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
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', async () => {
  document.querySelectorAll('[data-tab]').forEach(item => item.classList.toggle('selected', item === button));
  for (const id of ['settings', 'memories', 'history']) document.getElementById(id).hidden = id !== button.dataset.tab;
  try {
    if (button.dataset.tab === 'memories') await loadMemories();
    if (button.dataset.tab === 'history') await loadHistory();
  } catch (error) { showNotice(error.message); }
}));
loadSettings().catch(error => showNotice(error.message));

// Build cards with DOM text nodes so model output and stored facts cannot execute script.
function card(text) {
  const element = document.createElement('div'); element.className = 'card';
  const paragraph = document.createElement('p'); paragraph.textContent = text; element.append(paragraph);
  return element;
}

// Wrap asynchronous actions and surface failures in the same status area.
function action(label, work) {
  const button = document.createElement('button'); button.textContent = label;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await work(); } catch (error) { showNotice(error.message); }
    finally { button.disabled = false; }
  });
  return button;
}

// Reload memory facts and extraction health, including retries and provider failures.
async function loadMemories() {
  const [result, status] = await Promise.all([api.manage('memories'), api.status()]);
  const list = document.getElementById('memory-list'); list.replaceChildren();
  document.getElementById('memory-status').textContent = `共 ${result.memories.length} 条；待提取 ${status.pendingJobs} 条；失败 ${status.failedJobs} 条。${status.memoryResult || ''}${status.memoryError ? '\n最近提取错误：' + status.memoryError : ''}`;
  if (!result.memories.length) list.append(card('还没有长期记忆。你可以直接添加，或开启自动记忆后与白子聊天。'));
  for (const memory of result.memories) {
    const item = card(`${memory.fact_key}：${memory.value}`);
    item.append(action('编辑', () => {
      document.getElementById('memoryId').value = memory.id;
      document.getElementById('memoryKey').value = memory.fact_key;
      document.getElementById('memoryKey').readOnly = true;
      document.getElementById('memoryValue').value = memory.value;
      document.getElementById('memoryValue').focus();
    }), action('查看来源', async () => {
      const result = await api.manage('memorySource', { id: memory.id });
      const detail = card((result.messages.length ? '用户原话：' + result.messages[0].content : '来源：手动添加或编辑') + '\n最近变更：\n' + result.changes.map(change => `${new Date(change.created_at).toLocaleString()} · ${change.operation} · ${change.next_value || '已删除'}`).join('\n'));
      item.querySelector('.source-detail')?.remove(); detail.classList.add('source-detail'); item.append(detail);
    }), action('删除', async () => {
      if (!window.confirm(`删除“${memory.fact_key}”？旧提取任务不会恢复它。`)) return;
      await api.manage('deleteMemory', { id: memory.id }); await loadMemories(); showNotice('记忆已删除。');
    }));
    list.append(item);
  }
}

// Clear the edit target without discarding any persisted record.
function resetMemoryForm() {
  document.getElementById('memory-form').reset();
  document.getElementById('memoryId').value = '';
  document.getElementById('memoryKey').readOnly = false;
}

// Explicit user edits are persisted immediately rather than waiting for model extraction.
document.getElementById('memory-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await api.manage('saveMemory', { id: document.getElementById('memoryId').value || undefined,
      key: document.getElementById('memoryKey').value, value: document.getElementById('memoryValue').value });
    resetMemoryForm(); await loadMemories(); showNotice('记忆已保存。');
  } catch (error) { showNotice(error.message); }
});
document.getElementById('reset-memory').addEventListener('click', resetMemoryForm);
document.getElementById('refresh-memories').addEventListener('click', () => loadMemories().catch(error => showNotice(error.message)));
document.getElementById('retry-memory').addEventListener('click', async () => {
  try { await api.manage('retryMemory'); await loadMemories(); showNotice('已将失败任务放回队列；自动记忆开启时会执行。'); }
  catch (error) { showNotice(error.message); }
});

// Export through a native save dialog in the main process; the renderer never chooses filesystem paths.
document.getElementById('export-data').addEventListener('click', async () => {
  try { const result = await api.manage('export'); showNotice(result.cancelled ? '已取消导出。' : '聊天与记忆已导出。'); }
  catch (error) { showNotice(error.message); }
});

let currentSessionId = '';
let sessionRecords = [];
// Populate saved sessions and keep the selected history separate from the active chat session.
async function loadHistory() {
  const result = await api.manage('sessions');
  sessionRecords = result.sessions;
  currentSessionId = result.current;
  const select = document.getElementById('session-select');
  const selected = select.value;
  select.replaceChildren();
  for (const session of result.sessions) {
    const option = document.createElement('option'); option.value = session.id;
    option.textContent = `${session.id === result.current ? '当前 · ' : ''}${session.title} · ${new Date(session.created_at).toLocaleString()}`;
    select.append(option);
  }
  select.value = result.sessions.some(session => session.id === selected) ? selected : result.current;
  await showHistory();
}

// Render complete and interrupted messages and explain the selected session's current status.
async function showHistory() {
  const id = document.getElementById('session-select').value;
  const result = await api.manage('history', { id });
  const list = document.getElementById('history-list'); list.replaceChildren();
  document.getElementById('session-status').textContent = id === currentSessionId ? '这是当前正在使用的会话。' : '正在查看历史会话；点击“继续选中的会话”切换。';
  const session = sessionRecords.find(item => item.id === id);
  if (session?.summary) list.append(card(`较早对话摘要（覆盖到消息 ${session.summary_through}）\n${session.summary}`));
  const status = await api.status();
  if (status.summaryError) list.append(card(`最近摘要未更新：${status.summaryError}\n原始对话仍然保留。`));
  const statuses = { complete: '完成', failed: '失败', interrupted: '已打断', pending: '生成中', truncated: '达到输出上限' };
  if (!result.messages.length) list.append(card('这个会话还没有消息。'));
  for (const message of result.messages) list.append(card(`${message.role === 'user' ? '你' : '白子'} · ${statuses[message.status] || message.status}\n${message.content || '（没有生成内容）'}`));
}
document.getElementById('session-select').addEventListener('change', () => showHistory().catch(error => showNotice(error.message)));
document.getElementById('refresh-history').addEventListener('click', () => loadHistory().catch(error => showNotice(error.message)));
document.getElementById('new-session').addEventListener('click', async () => {
  try { await api.manage('newSession'); document.getElementById('session-select').value = ''; await loadHistory(); showNotice('已开启新会话；长期记忆保留。'); }
  catch (error) { showNotice(error.message); }
});
document.getElementById('select-session').addEventListener('click', async () => {
  try { await api.manage('selectSession', { id: document.getElementById('session-select').value }); await loadHistory(); showNotice('已切换会话。'); }
  catch (error) { showNotice(error.message); }
});

// Refresh visible data periodically so background memory writes appear without manual reload.
const refreshTimer = setInterval(() => {
  if (!document.hidden && !document.getElementById('memories').hidden && !document.getElementById('memoryId').value) loadMemories().catch(error => showNotice(error.message));
}, 5000);
window.addEventListener('beforeunload', () => clearInterval(refreshTimer));
