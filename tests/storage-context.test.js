/**
 * Responsibility: Verify persistence, context budgets and durable memory behavior.
 * Implementation: 1. Use temporary SQLite databases. 2. Simulate provider responses. 3. Exercise errors, restart recovery and stale extraction guards.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { Storage } = require('../gateway/storage');
const { ContextManager, tokenBound, retrieveMemories } = require('../gateway/context-manager');
const { MemoryService, parseFacts } = require('../gateway/memory-service');
const { normalizeSettings } = require('../gateway/settings');
const { executeTool } = require('../gateway/tools/tool-registry');

// Allocate a disposable real SQLite database for each scenario.
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baizi-storage-test-'));
  const storage = await Storage.open(root);
  return { root, storage, close: () => { storage.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('SQLite survives reopening and imports legacy history exactly once', async () => {
  const f = await fixture();
  try {
    const session = f.storage.currentSession();
    const turn = f.storage.beginTurn(session.id, '我叫小明');
    f.storage.finishTurn(turn, '你好呀', 'complete');
    f.storage.saveMemory({ key: '名字', value: '小明', category: 'profile' });
    f.storage.close();
    f.storage = await Storage.open(f.root, [{ user: '不应重复导入', assistant: '测试' }]);
    assert.equal(f.storage.memories()[0].value, '小明');
    assert.equal(f.storage.messages(session.id).length, 2);
    assert.equal(f.storage.sessions().length, 1);
    f.storage.close();
    // A brand-new path imports legacy data into a separate history session.
    fs.rmSync(path.join(f.root, 'dialogue.sqlite'));
    f.storage = await Storage.open(f.root, [{ user: '旧记录', assistant: '旧回复' }]);
    assert.equal(f.storage.sessions().length, 2);
    f.storage.close();
    f.storage = await Storage.open(f.root, [{ user: '旧记录', assistant: '旧回复' }]);
    assert.equal(f.storage.sessions().length, 2);
  } finally { f.storage.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('failed disk writes roll back mutations and pending turns recover as interrupted', async () => {
  const f = await fixture();
  try {
    const original = f.storage.filename;
    f.storage.filename = path.join(f.root, 'missing', 'database');
    assert.throws(() => f.storage.saveMemory({ key: '名字', value: '未保存' }), /保存失败/);
    assert.equal(f.storage.memories().length, 0);
    f.storage.filename = original;
    f.storage.beginTurn(f.storage.currentSession().id, '尚未完成');
    f.storage.close(); f.storage = await Storage.open(f.root);
    assert.ok(f.storage.messages(f.storage.currentSession().id).every(message => message.status === 'interrupted'));
  } finally { f.storage.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('manual memory changes invalidate stale jobs and deletions leave tombstones', async () => {
  const f = await fixture();
  try {
    const turn = f.storage.beginTurn(f.storage.currentSession().id, '我喜欢咖啡');
    f.storage.finishTurn(turn, '知道了', 'complete');
    f.storage.enqueueMemory(turn.userId);
    const job = f.storage.pendingJob();
    const { id } = f.storage.saveMemory({ key: '饮品偏好', value: '茶' });
    assert.equal(f.storage.applyJob(job, [{ key: '饮品偏好', value: '咖啡' }]), 0);
    assert.equal(f.storage.memories()[0].value, '茶');
    f.storage.deleteMemory(id);
    f.storage.enqueueMemory(turn.assistantId);
    assert.equal(f.storage.applyJob(f.storage.pendingJob(), [{ key: '饮品偏好', value: '咖啡' }]), 0);
    assert.equal(f.storage.memories().length, 0);
  } finally { f.close(); }
});

test('context preserves complete pairs, excludes failed turns and never exceeds its input budget', async () => {
  const f = await fixture();
  try {
    const session = f.storage.currentSession();
    for (let i = 0; i < 4; i++) {
      const turn = f.storage.beginTurn(session.id, `问题${i} ` + '长'.repeat(150));
      f.storage.finishTurn(turn, '答'.repeat(150), i === 0 ? 'failed' : 'complete');
    }
    f.storage.saveMemory({ key: '名字', value: '小明', category: 'profile' });
    const context = new ContextManager(f.storage, '你是白子。');
    const result = await context.build(session.id, '我叫什么名字？', normalizeSettings({ contextWindow: 4096, maxOutputTokens: 2048 }), new AbortController().signal);
    assert.ok(tokenBound(result.messages) <= result.stats.inputBudget);
    assert.ok(!JSON.stringify(result.messages).includes('问题0'));
    assert.ok(JSON.stringify(result.messages).includes('小明'));
    assert.equal(result.stats.recentMessages % 2, 0);
    await assert.rejects(context.build(session.id, '长'.repeat(2000), normalizeSettings({ contextWindow: 4096 }), new AbortController().signal), /超过模型上下文/);
  } finally { f.close(); }
});

test('old complete turns are summarized with a source cursor while original history is retained', async () => {
  const f = await fixture();
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ choices: [{ message: { content: '用户正在准备考试，约定周末复习。' } }] })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const session = f.storage.currentSession();
    for (let i = 0; i < 20; i++) {
      const turn = f.storage.beginTurn(session.id, '问'.repeat(70));
      f.storage.finishTurn(turn, '答'.repeat(70), 'complete');
    }
    const settings = normalizeSettings({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'mock', contextWindow: 4096, maxOutputTokens: 1024 });
    const result = await new ContextManager(f.storage, '白子').build(session.id, '继续', settings, new AbortController().signal);
    assert.ok(result.stats.summarizedThrough > 0);
    assert.ok(f.storage.currentSession().summary.includes('考试'));
    assert.equal(f.storage.messages(session.id).length, 40);
    assert.ok(tokenBound(result.messages) <= result.stats.inputBudget);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.close(); }
});

test('automatic extraction persists source-backed facts and malformed output is not an empty success', async () => {
  const f = await fixture();
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ choices: [{ message: { content: '{"memories":[{"key":"名字","value":"小明","category":"profile"}]}' } }] })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const service = new MemoryService(f.storage, () => normalizeSettings({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'mock' }));
  try {
    const turn = f.storage.beginTurn(f.storage.currentSession().id, '我叫小明');
    f.storage.finishTurn(turn, '你好呀', 'complete');
    f.storage.enqueueMemory(turn.userId);
    service.kick();
    const deadline = Date.now() + 3000;
    while (service.running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.storage.memories()[0]?.value, '小明');
    assert.equal(f.storage.memories()[0]?.source_message_id, turn.userId);
    assert.equal(f.storage.pendingJob(), undefined);
    assert.throws(() => parseFacts('not-json'));
    assert.deepEqual(parseFacts('{"memories":[]}'), []);
    assert.throws(() => parseFacts('{"memories":[{"key":"名字"}]}'));
  } finally { service.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.close(); }
});

test('retrieval prioritizes relevant Chinese facts rather than injecting the entire memory store', () => {
  const result = retrieveMemories([{ fact_key: '饮食偏好', value: '不喜欢甜食', category: 'preference', importance: 0.7 },
    { fact_key: '运动', value: '足球', category: 'preference', importance: 0.7 }], '你记得我喜欢甜食吗？');
  assert.equal(result.length, 1);
  assert.equal(result[0].value, '不喜欢甜食');
});

test('malformed extraction is recorded as a retryable failure without saving invented memories', async () => {
  const f = await fixture();
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ choices: [{ message: { content: '格式损坏' } }] })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const service = new MemoryService(f.storage, () => normalizeSettings({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'mock' }));
  try {
    const turn = f.storage.beginTurn(f.storage.currentSession().id, '我叫小明');
    f.storage.finishTurn(turn, '你好', 'complete'); f.storage.enqueueMemory(turn.userId);
    service.kick();
    const deadline = Date.now() + 3000;
    while (service.running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.storage.memories().length, 0);
    assert.equal(f.storage.pendingJob().attempts, 1);
    assert.ok(f.storage.meta('last_memory_error'));
  } finally { service.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.close(); }
});

test('user profile validates fixed fields, survives restart and records source', async () => {
  const f = await fixture();
  try {
    const saved = f.storage.updateUserProfile({ display_name: '小明', preferred_address: '队长', age: 28 }, 'conversation', 42);
    assert.deepEqual(saved.updated, ['display_name', 'preferred_address', 'age']);
    assert.equal(saved.profile.fields.preferred_address.value, '队长');
    assert.equal(saved.profile.fields.age.sourceMessageId, 42);
    assert.throws(() => f.storage.updateUserProfile({ age: 0 }, 'manual'), /整数/);
    assert.throws(() => f.storage.updateUserProfile({ unknown: '值' }, 'manual'), /不允许/);
    f.storage.close(); f.storage = await Storage.open(f.root);
    assert.equal(f.storage.userProfile().fields.display_name.value, '小明');
    assert.equal(f.storage.userProfileStatus().fields.age.value, '28');
    f.storage.clearUserProfileField('age');
    assert.equal(f.storage.userProfileStatus().fields.age.value, '');
  } finally { f.close(); }
});

test('profile prompting is gentle, explicit tasks bypass it and cooldown is durable', async () => {
  const f = await fixture();
  try {
    const first = f.storage.prepareProfilePrompt('你好', 168);
    assert.equal(first.field, 'preferred_address');
    assert.equal(f.storage.prepareProfilePrompt('嗯，继续聊聊', 168), null);
    assert.equal(f.storage.prepareProfilePrompt('现在几点？', 0), null);
    f.storage.transaction(() => f.storage.setMeta('profile_last_prompt_at', '0'));
    const next = f.storage.prepareProfilePrompt('继续', 1);
    assert.equal(next.field, 'preferred_address');
    f.storage.setProfileProactiveEnabled(false);
    assert.equal(f.storage.prepareProfilePrompt('你好', 0), null);
  } finally { f.close(); }
});

test('profile appears as data-only context and tools update only allowlisted fields', async () => {
  const f = await fixture();
  try {
    const context = new ContextManager(f.storage, '你是白子。');
    const result = await context.build(f.storage.currentSession().id, '你好', normalizeSettings({ contextWindow: 8192, maxOutputTokens: 1024 }), new AbortController().signal);
    const system = result.messages.find(message => message.role === 'system').content;
    assert.match(system, /用户档案/);
    assert.match(system, /preferred_address/);
    const updated = await executeTool('update_user_profile', JSON.stringify({ fields: { communication_preferences: '简洁回答' }, reason: '用户明确说希望简洁回答' }), { storage: f.storage, sourceMessageId: 9 });
    assert.equal(updated.profile.fields.communication_preferences.value, '简洁回答');
    const profile = await executeTool('get_user_profile', '{}', { storage: f.storage });
    assert.equal(profile.fields.communication_preferences, '简洁回答');
    await assert.rejects(executeTool('update_user_profile', JSON.stringify({ fields: { notes: '猜测' }, reason: '推测' }), { storage: f.storage }), /不允许/);
  } finally { f.close(); }
});
