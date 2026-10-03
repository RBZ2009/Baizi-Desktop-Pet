/**
 * Responsibility: Persist conversations, summaries, memories and retryable jobs in a local SQLite file.
 * Implementation: 1. Load bundled sql.js. 2. Atomically replace snapshots after transactions. 3. Restore state when a write fails.
 */
const initSqlJs = require('sql.js');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

/**
 * Responsibility: Define the user profile contract shared by storage, tools and the management UI.
 * Implementation: 1. Keep the editable fields finite and named. 2. Bound free text at the persistence boundary. 3. Keep age optional and numeric.
 */
const USER_PROFILE_FIELDS = Object.freeze({
  display_name: { label: '姓名或昵称', type: 'string', maxLength: 80, priority: 2 },
  preferred_address: { label: '希望的称呼', type: 'string', maxLength: 80, priority: 1 },
  age: { label: '年龄', type: 'integer', min: 1, max: 120, priority: 6, optional: true },
  occupation: { label: '职业或身份', type: 'string', maxLength: 120, priority: 4, optional: true },
  location: { label: '所在城市或地区', type: 'string', maxLength: 120, priority: 5, optional: true },
  timezone: { label: '时区', type: 'string', maxLength: 80, priority: 5, optional: true },
  interests: { label: '兴趣', type: 'string', maxLength: 500, priority: 7, optional: true },
  communication_preferences: { label: '沟通偏好', type: 'string', maxLength: 500, priority: 3 },
  current_goals: { label: '近期目标', type: 'string', maxLength: 500, priority: 8, optional: true },
  important_notes: { label: '希望记住的事项', type: 'string', maxLength: 700, priority: 9, optional: true }
});

class Storage {
  // Open the user's database and import legacy history only once.
  static async open(dataDir, legacyHistory = []) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
    const filename = path.join(dataDir, 'dialogue.sqlite');
    const db = new SQL.Database(fs.existsSync(filename) ? fs.readFileSync(filename) : undefined);
    const storage = new Storage(SQL, db, filename);
    storage.transaction(() => {
      db.run(`
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL,
          summary TEXT NOT NULL DEFAULT '', summary_through INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
          role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS message_session ON messages(session_id, id);
        CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, fact_key TEXT NOT NULL UNIQUE, category TEXT NOT NULL,
          value TEXT NOT NULL, source_message_id INTEGER, source TEXT NOT NULL, importance REAL NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS memory_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL,
          operation TEXT NOT NULL, previous_value TEXT, next_value TEXT, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL UNIQUE,
          revision INTEGER NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
          error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS user_profile (field TEXT PRIMARY KEY, value TEXT NOT NULL,
          source TEXT NOT NULL, source_message_id INTEGER, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS user_profile_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, field TEXT NOT NULL,
          operation TEXT NOT NULL, previous_value TEXT, next_value TEXT, source TEXT NOT NULL, created_at INTEGER NOT NULL);
      `);
      db.run("UPDATE jobs SET status='pending' WHERE status='running'");
      db.run("UPDATE messages SET status='interrupted' WHERE status='pending'");
      if (!storage.meta('current_session')) storage.setMeta('current_session', storage.insertSession('和白子的对话'));
      if (!storage.meta('legacy_imported')) {
        if (legacyHistory.length) {
          const session = storage.insertSession('旧版对话（导入）');
          for (const turn of legacyHistory.slice(-20)) {
            for (const [role, text] of [['user', turn.user], ['assistant', turn.assistant]]) {
              if (text) storage.insertMessage(session, role, String(text), 'complete', Number(turn.createdAt) || Date.now());
            }
          }
        }
        storage.setMeta('legacy_imported', '1');
      }
      storage.setMeta('schema_version', '2');
    });
    return storage;
  }

  // Keep SQL and filesystem state owned by one gateway process.
  constructor(SQL, db, filename) { this.SQL = SQL; this.db = db; this.filename = filename; }

  // Bind parameters and release statements even when a query fails.
  all(sql, params = []) {
    const statement = this.db.prepare(sql);
    try {
      statement.bind(params);
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally { statement.free(); }
  }

  // A failed persistence operation must not be reported as a successful mutation.
  transaction(work) {
    const previous = this.db.export();
    try {
      this.db.run('BEGIN');
      const result = work();
      this.db.run('COMMIT');
      const temp = `${this.filename}.tmp`;
      const descriptor = fs.openSync(temp, 'w', 0o600);
      try { fs.writeFileSync(descriptor, Buffer.from(this.db.export())); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      fs.renameSync(temp, this.filename);
      return result;
    } catch (error) {
      this.db.close();
      this.db = new this.SQL.Database(previous);
      throw new Error(`本地数据库保存失败：${error.code || error.message}`);
    }
  }

  // Read and write small database metadata within the caller's transaction.
  meta(key) { return this.all('SELECT value FROM metadata WHERE key=?', [key])[0]?.value; }
  setMeta(key, value) { this.db.run('INSERT OR REPLACE INTO metadata VALUES (?,?)', [key, String(value)]); }

  // Create a session without implicitly changing the active session.
  insertSession(title) {
    const id = randomUUID();
    this.db.run('INSERT INTO sessions(id,title,created_at) VALUES (?,?,?)', [id, title, Date.now()]);
    return id;
  }

  // Start a fresh short-term context while preserving cross-session memories.
  newSession() { return this.transaction(() => { const id = this.insertSession('新的对话'); this.setMeta('current_session', id); return { id }; }); }
  currentSession() { return this.all('SELECT * FROM sessions WHERE id=?', [this.meta('current_session')])[0]; }
  sessions() { return this.all('SELECT * FROM sessions ORDER BY created_at DESC'); }
  messages(sessionId) { return this.all('SELECT * FROM messages WHERE session_id=? ORDER BY id', [sessionId]); }

  // Select a history session only after checking it exists.
  selectSession(id) {
    if (!this.all('SELECT id FROM sessions WHERE id=?', [id]).length) throw new Error('会话不存在。');
    return this.transaction(() => { this.setMeta('current_session', id); return { id }; });
  }

  // Insert a message without exporting the database until its enclosing transaction commits.
  insertMessage(sessionId, role, content, status, createdAt = Date.now()) {
    this.db.run('INSERT INTO messages(session_id,role,content,status,created_at) VALUES (?,?,?,?,?)', [sessionId, role, content, status, createdAt]);
    return this.all('SELECT last_insert_rowid() AS id')[0].id;
  }

  // Record turn ownership before issuing an external request.
  beginTurn(sessionId, prompt) {
    return this.transaction(() => {
      if (!this.messages(sessionId).length) this.db.run('UPDATE sessions SET title=? WHERE id=?', [prompt.slice(0, 32), sessionId]);
      const userId = this.insertMessage(sessionId, 'user', prompt, 'pending');
      return { userId, assistantId: this.insertMessage(sessionId, 'assistant', '', 'pending') };
    });
  }

  // Commit both sides of a turn together; interrupted replies remain inspectable but excluded from context.
  finishTurn(turn, text, status, error = '') {
    this.transaction(() => {
      this.db.run('UPDATE messages SET status=? WHERE id=?', [status, turn.userId]);
      this.db.run('UPDATE messages SET content=?,status=? WHERE id=?', [text, status, turn.assistantId]);
      if (error) this.setMeta('last_chat_error', error);
    });
  }

  // Save a bounded summary with its exact source cursor.
  saveSummary(sessionId, summary, through) {
    this.transaction(() => this.db.run('UPDATE sessions SET summary=?,summary_through=? WHERE id=?', [summary, through, sessionId]));
  }

  memories(includeDeleted = false) { return this.all(`SELECT * FROM memories ${includeDeleted ? '' : 'WHERE deleted=0'} ORDER BY importance DESC,updated_at DESC`); }
  revision() { return Number(this.meta('memory_revision') || 0); }

  // Normalize canonical keys so trivial punctuation and case do not create duplicate facts.
  normalizeKey(key) { return String(key).normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '').slice(0, 160); }

  // Apply a single fact, retaining its previous value in a change log.
  upsertMemory({ key, value, category = 'fact', importance = 0.7 }, sourceMessageId = null, source = 'automatic') {
    key = this.normalizeKey(key);
    value = String(value || '').trim();
    if (!key || !value || value.length > 1000 || /(?:sk-[\w-]{16,}|Bearer\s+[\w.-]{20,}|(?:api[_ -]?key|密码|password)\s*[:：=])/i.test(value)) throw new Error('记忆内容为空、过长或包含凭据。');
    const old = this.all('SELECT * FROM memories WHERE fact_key=?', [key])[0];
    if (source === 'automatic' && old?.deleted) return null;
    const id = old?.id || randomUUID();
    const now = Date.now();
    this.db.run(`INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?,0)
      ON CONFLICT(fact_key) DO UPDATE SET category=excluded.category,value=excluded.value,source_message_id=excluded.source_message_id,
      source=excluded.source,importance=excluded.importance,updated_at=excluded.updated_at,deleted=0`,
    [id, key, String(category).slice(0, 50), value, sourceMessageId, source, Math.max(0, Math.min(1, Number(importance) || 0.7)), old?.created_at || now, now]);
    this.db.run('INSERT INTO memory_changes(memory_id,operation,previous_value,next_value,created_at) VALUES (?,?,?,?,?)',
      [id, old ? 'update' : 'create', old?.value || null, value, now]);
    return id;
  }

  // Manual edits invalidate in-flight extraction results, preventing stale jobs from overwriting the user.
  saveMemory(input) {
    return this.transaction(() => {
      if (input.id) {
        const old = this.all('SELECT * FROM memories WHERE id=? AND deleted=0', [input.id])[0];
        if (!old) throw new Error('记忆不存在。');
        input = { ...input, key: old.fact_key };
      }
      const id = this.upsertMemory(input, null, 'manual');
      this.setMeta('memory_revision', this.revision() + 1);
      return { id };
    });
  }

  // Keep a deletion tombstone so old history cannot silently resurrect the removed fact.
  deleteMemory(id) {
    return this.transaction(() => {
      const old = this.all('SELECT * FROM memories WHERE id=? AND deleted=0', [id])[0];
      if (!old) throw new Error('记忆不存在。');
      this.db.run('UPDATE memories SET deleted=1,updated_at=? WHERE id=?', [Date.now(), id]);
      this.db.run('INSERT INTO memory_changes(memory_id,operation,previous_value,created_at) VALUES (?,?,?,?)', [id, 'delete', old.value, Date.now()]);
      this.setMeta('memory_revision', this.revision() + 1);
      return { ok: true };
    });
  }

  // Enqueue extraction once per completed user message.
  enqueueMemory(messageId) {
    this.transaction(() => this.db.run("INSERT OR IGNORE INTO jobs(message_id,revision,status,created_at) VALUES (?,?,'pending',?)", [messageId, this.revision(), Date.now()]));
  }
  pendingJob() { return this.all("SELECT jobs.*,messages.content FROM jobs JOIN messages ON messages.id=jobs.message_id WHERE jobs.status='pending' AND jobs.attempts<3 ORDER BY jobs.id LIMIT 1")[0]; }
  markJob(id, status, error = '') {
    this.transaction(() => this.db.run(`UPDATE jobs SET status=?,error=?,attempts=attempts+? WHERE id=?`, [status, error, status === 'running' ? 1 : 0, id]));
  }

  // Return the fixed profile fields in a stable shape; missing values remain empty strings.
  userProfile() {
    const rows = new Map(this.all('SELECT field,value,source,source_message_id,updated_at FROM user_profile').map(row => [row.field, row]));
    const fields = {};
    for (const [field, definition] of Object.entries(USER_PROFILE_FIELDS)) {
      const row = rows.get(field);
      fields[field] = { value: row?.value || '', label: definition.label, source: row?.source || '', sourceMessageId: row?.source_message_id || null,
        updatedAt: row?.updated_at || null, optional: !!definition.optional, priority: definition.priority };
    }
    const missing = Object.entries(fields).filter(([, field]) => !field.value).map(([key]) => key);
    const requiredMissing = Object.entries(fields).filter(([, field]) => !field.value && !field.optional).map(([key]) => key);
    const optionalMissing = Object.entries(fields).filter(([, field]) => !field.value && field.optional).map(([key]) => key);
    return { fields, missing, requiredMissing, optionalMissing, complete: missing.length === 0 };
  }

  // Validate and persist only user-profile fields explicitly supplied by the caller.
  updateUserProfile(input, source = 'conversation', sourceMessageId = null) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('用户档案更新必须是对象。');
    const entries = Object.entries(input);
    if (!entries.length) throw new Error('没有可保存的用户档案字段。');
    for (const [field, value] of entries) {
      const definition = USER_PROFILE_FIELDS[field];
      if (!definition) throw new Error(`用户档案字段不允许：${field}。`);
      if (definition.type === 'integer') {
        if (!Number.isInteger(value) || value < definition.min || value > definition.max) throw new Error(`${definition.label}必须是 ${definition.min}～${definition.max} 的整数。`);
      } else if (typeof value !== 'string' || !value.trim() || value.length > definition.maxLength) {
        throw new Error(`${definition.label}为空或超过 ${definition.maxLength} 个字符。`);
      }
    }
    return this.transaction(() => {
      const now = Date.now();
      for (const [field, rawValue] of entries) {
        const value = String(rawValue).trim();
        const old = this.all('SELECT value FROM user_profile WHERE field=?', [field])[0];
        this.db.run(`INSERT INTO user_profile(field,value,source,source_message_id,updated_at) VALUES (?,?,?,?,?)
          ON CONFLICT(field) DO UPDATE SET value=excluded.value,source=excluded.source,source_message_id=excluded.source_message_id,updated_at=excluded.updated_at`,
        [field, value, source, sourceMessageId, now]);
        this.db.run('INSERT INTO user_profile_changes(field,operation,previous_value,next_value,source,created_at) VALUES (?,?,?,?,?,?)',
          [field, old ? 'update' : 'create', old?.value || null, value, source, now]);
      }
      this.setMeta('profile_last_updated_at', now);
      return { updated: entries.map(([field]) => field), profile: this.userProfile() };
    });
  }

  // Clear one profile field while retaining an audit record; old conversation text cannot restore it automatically.
  clearUserProfileField(field) {
    if (!Object.hasOwn(USER_PROFILE_FIELDS, field)) throw new Error(`用户档案字段不允许：${field}。`);
    return this.transaction(() => {
      const old = this.all('SELECT value FROM user_profile WHERE field=?', [field])[0];
      if (!old) return { ok: true, profile: this.userProfile() };
      this.db.run('DELETE FROM user_profile WHERE field=?', [field]);
      this.db.run('INSERT INTO user_profile_changes(field,operation,previous_value,next_value,source,created_at) VALUES (?,?,?,?,?,?)',
        [field, 'clear', old.value, null, 'manual', Date.now()]);
      return { ok: true, profile: this.userProfile() };
    });
  }

  // Decide whether this turn may contain a gentle onboarding question and record the cooldown atomically.
  prepareProfilePrompt(prompt, cooldownHours = 168) {
    const profile = this.userProfile();
    if (!profile.missing.length) return null;
    if (this.meta('profile_proactive_enabled') === '0') return null;
    const text = String(prompt || '').trim();
    if (!text || /[?？]|^(请|帮我|查询|搜索|查一下|天气|运行|执行|打开|设置|修改|解释|总结|写|生成|翻译|代码|为什么|怎么|如何|能否|可以|现在|查看)/u.test(text)) return null;
    const last = Number(this.meta('profile_last_prompt_at') || 0);
    if (last && Date.now() - last < Math.max(1, Number(cooldownHours) || 168) * 3600_000) return null;
    const field = profile.missing.slice().sort((a, b) => USER_PROFILE_FIELDS[a].priority - USER_PROFILE_FIELDS[b].priority)[0];
    this.transaction(() => {
      this.setMeta('profile_last_prompt_at', Date.now());
      this.setMeta('profile_last_prompted_field', field);
      this.setMeta('profile_prompt_count', Number(this.meta('profile_prompt_count') || 0) + 1);
    });
    return { field, label: USER_PROFILE_FIELDS[field].label };
  }

  // Expose profile metadata for the management view without exposing database internals.
  userProfileStatus() {
    const profile = this.userProfile();
    return { ...profile, proactiveEnabled: this.meta('profile_proactive_enabled') !== '0', lastPromptAt: Number(this.meta('profile_last_prompt_at') || 0),
      lastPromptedField: this.meta('profile_last_prompted_field') || '', promptCount: Number(this.meta('profile_prompt_count') || 0) };
  }

  // Update onboarding preferences without letting the model toggle them.
  setProfileProactiveEnabled(enabled) {
    return this.transaction(() => { this.setMeta('profile_proactive_enabled', enabled ? '1' : '0'); return this.userProfileStatus(); });
  }

  // Validate job revision at commit time, then save all extracted facts atomically.
  applyJob(job, facts) {
    return this.transaction(() => {
      if (job.revision !== this.revision()) {
        this.db.run("UPDATE jobs SET status='skipped',error='用户已手动修改记忆，忽略旧提取结果。' WHERE id=?", [job.id]);
        return 0;
      }
      let count = 0;
      for (const fact of facts) if (this.upsertMemory(fact, job.message_id)) count += 1;
      this.db.run("UPDATE jobs SET status='complete',error='' WHERE id=?", [job.id]);
      return count;
    });
  }

  // Export user-visible data without API credentials or internal database paths.
  exportData() { return { version: 2, exportedAt: new Date().toISOString(), sessions: this.sessions().map(session => ({ ...session, messages: this.messages(session.id) })), memories: this.memories(), userProfile: this.userProfileStatus() }; }
  close() { this.db.close(); }
}
module.exports = { Storage, USER_PROFILE_FIELDS };
