/**
 * Responsibility: Verify workspace creation and approval persistence.
 * Implementation: 1. Use a disposable user-data directory. 2. Exercise canonical roots and pending requests. 3. Remove temporary state after each test.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceManager } = require('../workspace-manager');

test('workspace manager creates a default root and persists approvals', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baizi-workspace-'));
  try {
    const options = { documents: path.join(home, 'Documents') };
    const manager = new WorkspaceManager(path.join(home, 'data'), options);
    assert.ok(fs.existsSync(manager.workspaceRoot));
    assert.equal(manager.list().approved[0].source, 'default');
    const outside = path.join(home, 'Projects'); fs.mkdirSync(outside); fs.mkdirSync(path.join(outside, 'src'));
    assert.equal(manager.request(outside, '需要读取项目').status, 'pending');
    assert.equal(manager.list().pending.length, 1);
    manager.approve(outside);
    assert.equal(manager.isApproved(path.join(outside, 'src')), true);
    const reopened = new WorkspaceManager(path.join(home, 'data'), options);
    assert.equal(reopened.isApproved(outside), true);
    reopened.revoke(outside);
    assert.equal(reopened.isApproved(outside), false);
    assert.equal(reopened.isApproved(reopened.workspaceRoot), true);
    reopened.revoke(reopened.workspaceRoot);
    assert.equal(reopened.isApproved(reopened.workspaceRoot), true);
    assert.throws(() => reopened.request(os.homedir()), /不能授予/);
    assert.throws(() => reopened.request(path.join(home, 'data')), /不能授予/);
    const link = path.join(reopened.workspaceRoot, 'outside'); fs.symlinkSync(outside, link);
    assert.equal(reopened.isApproved(link), false);
    reopened.request(outside); reopened.deny(fs.realpathSync.native(outside));
    assert.equal(reopened.list().pending.length, 0);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
