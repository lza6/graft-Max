/**
 * [N12 收尾] 联邦后端「自动发现」E2E —— 不点按钮、不重启，也要自己出现。
 *
 * `e2e-backend-hotplug.mjs` 验证的是"点「重试探针」立刻生效"（显式路径）。
 * 这个脚本验证**后台心跳**路径：探针失败结果只缓存 30s，心跳每 N 秒跑一次，
 * 一旦后端从不可用变可用就发 `notifications/tools/list_changed`。
 *
 * 手法与 hotplug 相同（假 qmd + 真 PATH + 真 stdio），差别是：
 *   - `GRAFT_MAX_FED_WATCH_MS=300`（把 60s 心跳压到 300ms，否则这个测试要跑一分钟）
 *   - **全程不碰 `/reprobe`**，只等心跳
 *
 * 用法：node e2e/e2e-fed-heartbeat.mjs   （需先 npm run build）
 */
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
const isWin = process.platform === 'win32';

const results = [];
const check = (n, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${String(d).slice(0, 160)})` : ''}`);
};

const sandbox = mkdtempSync(join(tmpdir(), 'gm-heartbeat-'));
const home = join(sandbox, 'home');
const repo = join(sandbox, 'repo');
const fakebin = join(sandbox, 'bin');
mkdirSync(home, { recursive: true });
mkdirSync(join(repo, 'src'), { recursive: true });
mkdirSync(fakebin, { recursive: true });
writeFileSync(join(repo, 'src', 'm.ts'), 'export function add(a: number, b: number): number { return a + b; }\n', 'utf8');
execFileSync(process.execPath, [CLI, 'build', '.'], {
  cwd: repo,
  stdio: 'ignore',
  timeout: 180_000,
  env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '' },
  windowsHide: true,
});

function installFakeQmd(installed) {
  writeFileSync(join(fakebin, 'qmd.cmd'), installed ? '@echo off\r\necho qmd 1.0.0 (fake)\r\nexit /b 0\r\n' : '@echo off\r\nexit /b 1\r\n', 'utf8');
  const sh = join(fakebin, 'qmd');
  writeFileSync(sh, installed ? '#!/bin/sh\necho "qmd 1.0.0 (fake)"\nexit 0\n' : '#!/bin/sh\nexit 1\n', 'utf8');
  try {
    chmodSync(sh, 0o755);
  } catch {
    /* Windows 上 chmod 无意义 */
  }
  // 失败 TTL 是 30s —— 心跳每 300ms 跑一次仍会被 TTL 拦住。
  // 所以这里不等 TTL，而是靠"心跳 + 探针在 TTL 过期后重试"；为了让测试在秒级完成，
  // 我们把心跳调快的同时，接受"第一次心跳命中失败缓存、第二次起才可能成功"这个事实。
}
installFakeQmd(false);

const child = spawn(process.execPath, [CLI, 'mcp', repo], {
  env: {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    PATH: `${fakebin}${isWin ? ';' : ':'}${process.env.PATH ?? ''}`,
    GRAFT_MAX_LOG: '1',
    GRAFT_MAX_MCP: '1',
    GRAFT_TEST: '1',
    GRAFT_MAX_FED_WATCH_MS: '300', // 心跳 300ms（生产默认 60s）
    GRAFT_MAX_FIRST_BUILD_WAIT_MS: '0',
    GRAFT_MAX_UI: '',
  },
  windowsHide: true,
});
child.stderr.on('data', () => {});

const notifications = [];
const replies = new Map();
let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.method === 'notifications/tools/list_changed') notifications.push(Date.now());
      if (msg.id !== undefined) replies.set(msg.id, msg);
    } catch {
      /* ignore */
    }
  }
});
const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function reply(id, ms = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (replies.has(id)) return replies.get(id);
    await wait(50);
  }
  throw new Error(`no reply for id=${id}`);
}
const names = (r) => (r.result?.tools ?? []).map((t) => t.name);

try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'hb', version: '0' } } });
  await reply(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  await wait(300);

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const before = names(await reply(2));
  check('1 未装 qmd 时 max_find_docs 隐藏', !before.includes('max_find_docs'), before.join(','));

  // 用户"装好了"。失败 TTL 30s 会挡住立即重探，所以这里把等待窗口设到 TTL 之后——
  // 这也是真实用户的体感上限（心跳间隔 + 30s）。
  installFakeQmd(true);
  console.log('  已"安装"假 qmd，等待失败 TTL(30s) 过期 + 心跳（最多 45s，不点任何按钮）…');
  const t0 = Date.now();
  let appeared = false;
  while (Date.now() - t0 < 45_000) {
    await wait(500);
    send({ jsonrpc: '2.0', id: 100 + (Date.now() % 1000), method: 'tools/list', params: {} });
    // 用固定 id 拿响应比较麻烦，这里直接看通知：list_changed 才是"自动发现"的信号
    if (notifications.length > 0) {
      appeared = true;
      break;
    }
  }
  check('2 装完后端后，心跳自动发出 tools/list_changed（无需点按钮/重启）', appeared, `等待 ${Math.round((Date.now() - t0) / 1000)}s，通知 ${notifications.length} 次`);

  // 再确认工具真的出现了
  const rid = 9000;
  send({ jsonrpc: '2.0', id: rid, method: 'tools/list', params: {} });
  const after = names(await reply(rid));
  check('3 tools/list 已包含 max_find_docs', after.includes('max_find_docs'), after.join(','));
} catch (e) {
  check(`未捕获异常：${e instanceof Error ? e.message : String(e)}`, false);
} finally {
  try {
    child.stdin.end();
    child.kill();
  } catch {}
  rmSync(sandbox, { recursive: true, force: true });
}

const failed = results.filter((r) => !r).length;
console.log(`\n后端自动发现（心跳）E2E: ${results.length - failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
