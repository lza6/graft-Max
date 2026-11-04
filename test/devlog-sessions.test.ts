/**
 * [graft-Max N4] devlog 会话注册表：身份、节流、自净、跨 host 判活。
 *
 * 修的是 P1-5：`bumpRequests` / `endSession` 原来按**裸 pid** 找自己那一行，
 * 而容器里每个进程都是 pid 1 —— 容器 A 的调用会给容器 B 的行 +1，A 退出会把
 * B 标成 ended。身份必须是 host+pid。
 *
 * 测试隔离：devlog 在模块加载时用 os.homedir() 解析 ~/.graft-max，所以这里先把
 * USERPROFILE/HOME 指到临时目录，再**动态 import**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'gm-devlog-'));
process.env.USERPROFILE = home;
process.env.HOME = home;
const gmHome = join(home, '.graft-max');
mkdirSync(gmHome, { recursive: true });
const sessionsFile = join(gmHome, 'sessions.json');

const devlog = await import('../src/mcp/devlog.js');
// 单进程全量测试时模块可能已被别处加载（homedir 定死），显式重定位到沙箱。
devlog.setDevlogHomeForTest(gmHome);
const { bumpRequests, flushPendingBumps, endSession, liveSessions, registerSession, touchSession, SESSIONS_FILE } = devlog;

assert.equal(SESSIONS_FILE, sessionsFile, 'sessions.json must live under the sandboxed home');

const ME = hostname();
const OTHER = 'other-container-abc123';
const nowIso = () => new Date().toISOString();
const minsAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

interface Row {
  pid: number;
  host?: string;
  cwd: string;
  hostPid: number | null;
  hostCmd: string;
  user: string;
  startedAt: string;
  endedAt: string | null;
  requests: number;
  lastSeen?: string;
}

function row(over: Partial<Row> = {}): Row {
  return {
    pid: process.pid,
    host: ME,
    cwd: 'C:/repo',
    hostPid: 1,
    hostCmd: 'test',
    user: 'tester',
    startedAt: nowIso(),
    endedAt: null,
    requests: 0,
    lastSeen: nowIso(),
    ...over,
  };
}

function seed(rows: Row[]): void {
  writeFileSync(sessionsFile, JSON.stringify(rows, null, 1), 'utf8');
}

function read(): Row[] {
  return JSON.parse(readFileSync(sessionsFile, 'utf8')) as Row[];
}

function settle(): void {
  // 把可能挂着的内存计数先清空，保证每个用例从 0 开始
  flushPendingBumps();
}

test('P1-5: 同 pid 不同 host —— 只有本机行被 +1', () => {
  settle();
  seed([row({ requests: 0 }), row({ host: OTHER, requests: 0 })]);
  bumpRequests();
  assert.equal(flushPendingBumps(), true, 'flush 应当真的写了盘');
  const rows = read();
  const mine = rows.find((r) => r.host === ME && r.pid === process.pid);
  const theirs = rows.find((r) => r.host === OTHER);
  assert.ok(mine && theirs, '两行都应在文件里');
  assert.equal(mine.requests, 1, '本机行 +1');
  assert.equal(theirs.requests, 0, '别的容器的同 pid 行不能被改');
});

test('P1-5: endSession 只标本机行 endedAt', () => {
  settle();
  seed([row(), row({ host: OTHER })]);
  endSession();
  const rows = read();
  const mine = rows.find((r) => r.host === ME && r.pid === process.pid)!;
  const theirs = rows.find((r) => r.host === OTHER)!;
  assert.ok(mine.endedAt, '本机行应打上结束时间');
  assert.equal(theirs.endedAt, null, '别的容器行不得被标结束');
});

test('P3-13: 请求计数节流 —— 10 次调用不在热路径写盘，flush 时一次写入 10', () => {
  settle();
  seed([row({ requests: 0 })]);
  for (let i = 0; i < 10; i++) bumpRequests();
  // 同步检查：此刻还没到 2s 节流窗口，文件里的计数必须仍是 0（证明没有逐调用写盘）
  assert.equal(read()[0].requests, 0, '节流窗口内不得落盘');
  assert.equal(flushPendingBumps(), true);
  assert.equal(read()[0].requests, 10, 'flush 一次性写入累计的 10 次');
  assert.equal(flushPendingBumps(), false, '没有待写计数时 flush 返回 false（不产生空写）');
});

test('坏 JSON 自愈：sessions.json 被写坏时读接口返回空数组且不抛', () => {
  settle();
  writeFileSync(sessionsFile, '{ this is not json', 'utf8');
  assert.deepEqual(liveSessions(), []);
  // 下一次写会原子重建
  registerSession('C:/repo', '0.0.0-test');
  const rows = read();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].host, ME);
});

test('跨 host 判活：lastSeen 新鲜 → LIVE，超过 3 分钟 → 剪掉', () => {
  settle();
  seed([
    row({ host: OTHER, lastSeen: minsAgo(1) }),
    row({ host: 'other-container-old', lastSeen: minsAgo(5) }),
  ]);
  const live = liveSessions();
  assert.equal(live.length, 1, '只保留新鲜的跨容器会话');
  assert.equal(live[0].host, OTHER);
});

test('读路径无写副作用：liveSessions 不改文件字节', () => {
  settle();
  seed([row({ host: 'other-container-old', lastSeen: minsAgo(9) })]);
  const before = readFileSync(sessionsFile, 'utf8');
  liveSessions();
  const after = readFileSync(sessionsFile, 'utf8');
  assert.equal(after, before, 'GET 读路径不得触发写盘（P3-5）');
});

test('同 host 死 pid 从 live 列表消失，但写路径自净后才从文件移除', () => {
  settle();
  const deadPid = 999_999; // 本机上几乎不可能存在
  seed([row({ pid: deadPid, host: ME })]);
  assert.equal(liveSessions().length, 0, '死 pid 不算 LIVE');
  // 触发一次写路径：registerSession 会写盘并顺带自净
  registerSession('C:/repo', '0.0.0-test');
  const rows = read();
  assert.equal(rows.some((r) => r.pid === deadPid), false, '死行应被剪掉');
  assert.equal(rows.length, 1, '只剩刚注册的自己');
});

test('touchSession 幂等：20s 节流窗口内不重复写盘', () => {
  settle();
  registerSession('C:/repo', '0.0.0-test');
  touchSession(); // 第一次调用会建立 lastTouch 并刷新一次 lastSeen
  const before = readFileSync(sessionsFile, 'utf8');
  touchSession(); // 20s 窗口内：必须直接返回，不碰磁盘
  const after = readFileSync(sessionsFile, 'utf8');
  assert.equal(after, before, '20s 内第二次 touch 不应写盘');
});

test('cleanup', () => {
  rmSync(home, { recursive: true, force: true });
  assert.equal(existsSync(home), false);
});
