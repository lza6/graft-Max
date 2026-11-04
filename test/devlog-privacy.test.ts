/**
 * [M10 + M9] devlog 隐私测试：
 *  - M10: hostCmd 只保留可执行文件名（不含完整命令行里的密钥参数/内网路径）
 *  - M9:  日志与会话文件首次创建后权限收紧为 0600（仅 POSIX；Windows 上跳过）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'gm-privacy-'));
process.env.USERPROFILE = home;
process.env.HOME = home;
const gmHome = join(home, '.graft-max');
mkdirSync(gmHome, { recursive: true });
const logFile = join(gmHome, 'mcp.log');
process.env.GRAFT_MAX_LOG = logFile;

// [M10] 构造含密钥的完整命令行
process.env.COMMAND_LINE = 'node /secret/path/cli.js --token=sk-abc123def456ghi789 --internal-url=http://10.0.0.5:9200';

const devlog = await import('../src/mcp/devlog.js');
// 重定位到沙箱（单进程跑全量测试时，模块可能在别处已被加载过，homedir() 已被定死）
devlog.setDevlogHomeForTest(gmHome);
const { registerSession, SESSIONS_FILE, logPath, tightenPerms, endSession } = devlog;

test.after(() => {
  endSession();
  rmSync(home, { recursive: true, force: true });
});

test('[M10] registerSession 落盘的 hostCmd 不含密钥值与内网路径，只含可执行名', () => {
  registerSession('/tmp/repo', '0.0.0-test');
  assert.ok(existsSync(SESSIONS_FILE), 'sessions.json 应当被创建');
  const rows = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) as Array<{ hostCmd: string }>;
  assert.ok(rows.length >= 1);
  const mine = rows[rows.length - 1];
  assert.ok(mine.hostCmd.length > 0, 'hostCmd 不应为空');
  assert.ok(mine.hostCmd.length <= 60, 'hostCmd 长度截 60');
  assert.equal(mine.hostCmd, 'node', `只保留可执行文件名，实际: ${mine.hostCmd}`);
  // 隐私红线：完整命令行里的敏感片段绝不能落盘
  assert.ok(!mine.hostCmd.includes('--token'), '不得包含 --token 参数');
  assert.ok(!mine.hostCmd.includes('sk-abc123'), '不得包含密钥值');
  assert.ok(!mine.hostCmd.includes('/secret/path'), '不得包含内网路径');
  assert.ok(!mine.hostCmd.includes('10.0.0.5'), '不得包含内网 URL');
});

test('[M10] Windows 风格带引号路径取引号内首个 token 的 basename', async () => {
  const { basename } = await import('node:path');
  // 直接驱动 shortHostCmd 不可行（未导出），通过 env + 再注册一行来覆盖引号分支
  process.env.COMMAND_LINE = '"C:\\Program Files\\My Agent\\cli.exe" --key=supersecret12345';
  registerSession('/tmp/repo2', '0.0.0-test');
  const rows = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) as Array<{ hostCmd: string }>;
  const mine = rows[rows.length - 1];
  assert.equal(mine.hostCmd, basename('C:\\Program Files\\My Agent\\cli.exe'), `实际: ${mine.hostCmd}`);
  assert.ok(!mine.hostCmd.includes('supersecret'));
});

test('[M9] 日志文件首次写入后 chmod 0600（POSIX）', { skip: process.platform === 'win32' }, async () => {
  // 用**独立**沙箱与本进程内独立的一次写入来断言（不与本文件其它用例共享
  // logPermDone / ensured 状态——共享会让"首次写"变成"第 N 次写"，chmod 只做一次）。
  const fresh = mkdtempSync(join(tmpdir(), 'gm-priv-fresh-'));
  const freshLog = join(fresh, 'mcp.log');
  const prev = process.env.GRAFT_MAX_LOG;
  process.env.GRAFT_MAX_LOG = freshLog;
  try {
    devlog.setDevlogHomeForTest(fresh);
    devlog.dlog('privacy smoke line');
    for (let i = 0; i < 100 && !existsSync(freshLog); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(existsSync(freshLog), '日志文件应当已创建');
    const mode = statSync(freshLog).mode & 0o777;
    assert.equal(mode, 0o600, `必须是 0600，实际 mode=${mode.toString(8)}`);
  } finally {
    process.env.GRAFT_MAX_LOG = prev;
    devlog.setDevlogHomeForTest(gmHome); // 交还给本文件的共享沙箱
    rmSync(fresh, { recursive: true, force: true });
  }
});

test('[M9] tightenPerms：POSIX 收紧为 0600；失败静默不抛错', { skip: process.platform === 'win32' }, () => {
  const f = join(home, 'perm-probe.txt');
  writeFileSync(f, 'x', { mode: 0o666 });
  tightenPerms(f);
  const mode = statSync(f).mode & 0o777;
  assert.equal(mode, 0o600, `实际 mode=${mode.toString(8)}`);
  unlinkSync(f);
  // 不存在的文件也不得抛错（收紧失败静默的铁则）
  assert.doesNotThrow(() => tightenPerms(join(home, 'no-such-file-xyz')));
});
