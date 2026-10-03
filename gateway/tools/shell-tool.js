/**
 * Responsibility: Execute model shell commands under macOS directory permissions.
 * Implementation: 1. Resolve cwd and approved roots through realpath. 2. Apply an inherited OS sandbox.
 * 3. Bound execution time and output, with no credentials in the child environment.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// Encode paths as sandbox literals; model input never becomes profile source.
function literal(value) { return JSON.stringify(value); }

// Deny network and writes by default; explicit protected roots remain blocked even when nested.
function sandboxProfile(roots, protectedPaths = []) {
  const home = require('node:os').homedir();
  const blocked = [home, ...protectedPaths.filter(Boolean).map(root => path.resolve(root))];
  return ['(version 1)', '(deny default)', '(allow process-fork)', '(allow process-exec)', '(allow signal (target self))',
    '(allow file-read*)', '(allow file-write-data (literal "/dev/null"))',
    ...blocked.map(root => `(deny file-read* file-write* (subpath ${literal(root)}))`),
    ...roots.map(root => `(allow file-read* file-write* (subpath ${literal(root)}))`)
  ].join('\n');
}

// Run one command in a fail-closed sandbox, never in an unconfined fallback shell.
async function runCommand(args, options = {}) {
  const command = String(args.command || '').trim();
  if (!command || command.length > 500 || command.includes('\0')) throw new Error('命令为空或超过长度限制。');
  const cwd = fs.realpathSync.native(path.resolve(args.cwd || options.workspaceRoot || process.cwd()));
  if (!fs.statSync(cwd).isDirectory()) throw new Error('命令工作目录必须是目录。');
  const roots = (options.workspacePermissions || []).flatMap(item => {
    try { const root = fs.realpathSync.native(item.path); return fs.statSync(root).isDirectory() ? [root] : []; }
    catch (_) { return []; }
  });
  if (!roots.some(root => cwd === root || cwd.startsWith(root + path.sep))) {
    const error = new Error(`目录尚未授权，请在设置中审批：${cwd}`);
    error.code = 'WORKSPACE_PERMISSION_REQUIRED'; error.path = cwd;
    error.reason = String(args.reason || `执行命令：${command}`).slice(0, 240);
    throw error;
  }
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) throw new Error('此系统没有可用的命令沙箱，已停止执行。');
  const profile = sandboxProfile(roots, options.protectedPaths);
  return new Promise((resolve, reject) => execFile('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', command], {
    cwd, timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, signal: options.signal,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: cwd, TMPDIR: cwd, LANG: 'en_US.UTF-8', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' }
  }, (error, stdout, stderr) => {
    if (options.signal?.aborted) return reject(Object.assign(new Error('请求已取消。'), { name: 'AbortError' }));
    resolve({ command, cwd, exitCode: Number.isInteger(error?.code) ? error.code : error ? 1 : 0,
      stdout: String(stdout || '').replace(/\0/g, '').slice(0, 12000),
      stderr: String(stderr || error?.message || '').replace(/\0/g, '').slice(0, 12000), timedOut: !!error?.killed });
  }));
}

module.exports = { runCommand, sandboxProfile };
