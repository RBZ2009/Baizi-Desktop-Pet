/**
 * Responsibility: Persist conversations, summaries, memories and retryable jobs in a local SQLite file.
 * Implementation: 1. Load bundled sql.js. 2. Atomically replace snapshots after transactions. 3. Restore state when a write fails.
 */
const initSqlJs = require('sql.js');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

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
      storage.setMeta('schema_version', '1');
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
  exportData() { return { version: 1, exportedAt: new Date().toISOString(), sessions: this.sessions().map(session => ({ ...session, messages: this.messages(session.id) })), memories: this.memories() }; }
  close() { this.db.close(); }
}
module.exports = { Storage };
