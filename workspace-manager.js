/**
 * Responsibility: Create the user's pet workspace and enforce directory permissions.
 * Implementation: 1. Create a stable Documents workspace on first run. 2. Keep approved roots canonical.
 * 3. Require an explicit approval record before a tool can access any external directory.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_NAME = 'Baizi-Desktop-Pet-Workspace';

function canonical(value) {
  const resolved = path.resolve(String(value));
  try { return fs.realpathSync.native(resolved); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(resolved);
    if (parent === resolved) throw error;
    return path.join(canonical(parent), path.basename(resolved));
  }
}

class WorkspaceManager {
  constructor(userData, { documents = path.join(os.homedir(), 'Documents') } = {}) {
    fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
    this.file = path.join(userData, 'workspace-permissions.json');
    this.documents = documents;
    this.workspaceRoot = path.join(this.documents, WORKSPACE_NAME);
    this.state = { approved: [], pending: [] };
    this.load();
    fs.mkdirSync(this.workspaceRoot, { recursive: true, mode: 0o700 });
    const root = canonical(this.workspaceRoot);
    this.workspaceRoot = root;
    if (!this.state.approved.some(item => item.path === root)) this.state.approved.unshift({ path: root, label: '桌宠工作区', source: 'default', createdAt: new Date().toISOString() });
    this.save();
  }
  // Ignore malformed persisted records instead of granting implicit access.
  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const key of ['approved', 'pending']) this.state[key] = Array.isArray(saved[key]) ? saved[key].filter(item => item && typeof item.path === 'string' && path.isAbsolute(item.path)) : [];
    } catch (_) {}
  }
  save() { const tmp = `${this.file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 }); fs.renameSync(tmp, this.file); }
  list() { return { workspaceRoot: this.workspaceRoot, approved: this.state.approved.map(item => ({ ...item })), pending: this.state.pending.map(item => ({ ...item })) }; }
  snapshot() { return this.state.approved.map(item => ({ ...item })); }
  isApproved(target) { const value = canonical(target); return this.state.approved.some(item => value === item.path || value.startsWith(`${item.path}${path.sep}`)); }
  // Reject broad and sensitive roots before recording an approval request.
  validateDirectory(target) {
    if (typeof target !== 'string' || !target.trim() || !path.isAbsolute(target)) throw new Error('请提供目录的绝对路径。');
    if (!fs.statSync(target).isDirectory()) throw new Error('只能申请目录权限。');
    const value = canonical(target);
    const home = canonical(os.homedir());
    const sensitive = [path.dirname(this.file), path.join(home, '.ssh'), path.join(home, '.aws'), path.join(home, '.codex'), path.join(home, 'Library'), '/System', '/private/etc', '/private/var/db', '/dev'];
    if (value === home || home.startsWith(value + path.sep) || value === path.parse(value).root || sensitive.some(entry => {
      const root = canonical(entry);
      return value === root || value.startsWith(root + path.sep) || root.startsWith(value + path.sep);
    })) throw new Error('此目录包含系统或凭据数据，不能授予桌宠访问权限。');
    return value;
  }
  // Record a request without granting access; duplicate requests retain their original reason.
  request(target, reason = '') {
    const value = this.validateDirectory(target);
    if (this.isApproved(value)) return { status: 'approved', path: value };
    if (!this.state.pending.some(item => item.path === value)) this.state.pending.push({ path: value, reason: String(reason).slice(0, 240), createdAt: new Date().toISOString() });
    this.save(); return { status: 'pending', path: value };
  }
  // Only approve a pending request from the management window.
  approve(target) {
    const value = this.validateDirectory(target);
    const item = this.state.pending.find(entry => entry.path === value);
    if (!item) throw new Error('此目录没有待审批的申请。');
    this.state.pending = this.state.pending.filter(entry => entry.path !== value);
    if (!this.state.approved.some(entry => entry.path === value)) this.state.approved.push({ ...item, label: path.basename(value) || value, approvedAt: new Date().toISOString() });
    this.save(); return this.list();
  }
  revoke(target) { const value = canonical(target); this.state.approved = this.state.approved.filter(item => item.path !== value || item.source === 'default'); this.save(); return this.list(); }
  // Dismiss an unwanted request without granting it.
  deny(target) { const value = canonical(target); this.state.pending = this.state.pending.filter(item => item.path !== value); this.save(); return this.list(); }
}

module.exports = { WorkspaceManager, WORKSPACE_NAME };
