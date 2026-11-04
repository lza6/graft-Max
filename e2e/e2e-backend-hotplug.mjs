/**
 * [N12] 联邦后端热插拔 E2E —— "中途装上后端，不重启会话就能用"。
 *
 * 验收的是 P2-3 那条用户痛点：按 README 装完 qmd，当前会话永远看不到新工具，
 * 只能重开 MCP server（在 Claude Code 里等于重开会话）。
 *
 * 手法（真实链路，不是 mock 内部函数）：
 *   1. PATH 最前面放一个**假 qmd**，初始 exit 1（= 未安装）；
 *   2. 起真 MCP server + 真面板，tools/list 断言 `max_find_docs` **不在**列表里；
 *   3. 把假 qmd 改成 exit 0（= 用户装好了）；
 *   4. 打面板 `GET /reprobe`（= 用户点「重试探针」，或等 60s 心跳 + 30s 失败 TTL）；
 *   5. 再 tools/list —— `max_find_docs` 必须出现，且 `notifications/tools/list_changed`
 *      已发出（真 stdio 断言）。
 *
 * 用法：node e2e/e2e-backend-hotplug.mjs   （需要先 npm run build）
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

const sandbox = mkdtempSync(join(tmpdir(), 'gm-hotplug-'));
const home = join(sandbox, 'home');
const repo = join(sandbox, 'repo');
const fakebin = join(sandbox, 'bin');
mkdirSync(home, { recursive: true });
mkdirSync(join(repo, 'src'), { recursive: true });
mkdirSync(fakebin, { recursive: true });
writeFileSync(join(repo, 'src', 'm.ts'), 'export function add(a: number, b: number): number { return a + b; }\n', 'utf8');

const quiet = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '' };
execFileSync(process.execPath, [CLI, 'build', '.'], { cwd: repo, stdio: 'ignore', timeout: 180_000, env: quiet, windowsHide: true });

/** 假 qmd：装/没装两种状态。Windows 上 PATH 解析 .cmd 需要 shell，与真实 npm shim 一致。 */
function installFakeQmd(installed) {
  const body = installed ? '@echo off\r\necho qmd 1.0.0 (fake)\r\nexit /b 0\r\n' : '@echo off\r\nexit /b 1\r\n';
  writeFileSync(join(fakebin, 'qmd.cmd'), body, 'utf8');
  const sh = installed ? '#!/bin/sh\necho "qmd 1.0.0 (fake)"\nexit 0\n' : '#!/bin/sh\nexit 1\n';
  const p = join(fakebin, 'qmd');
  writeFileSync(p, sh, 'utf8');
  try {
    chmodSync(p, 0o755);
  } catch {
    /* Windows 上 chmod 无意义 */
  }
}
installFakeQmd(false);

const PORT = 24780 + (process.pid % 60);
const child = spawn(process.execPath, [CLI, 'mcp', repo], {
  env: {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    PATH: `${fakebin}${isWin ? ';' : ':'}${process.env.PATH ?? ''}`,
    GRAFT_MAX_LOG: '1',
    GRAFT_MAX_UI: String(PORT),
    GRAFT_MAX_LEASH: '0',
    GRAFT_MAX_MCP: '1',
    GRAFT_TEST: '1',
    GRAFT_MAX_FED_WATCH: '0', // 用 /reprobe 精确驱动，不等 60s 心跳
    GRAFT_MAX_FIRST_BUILD_WAIT_MS: '0',
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
      if (msg.method === 'notifications/tools/list_changed') notifications.push(msg);
      if (msg.id !== undefined) replies.set(msg.id, msg);
    } catch {
      /* protocol noise */
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
const toolNames = (r) => (r.result?.tools ?? []).map((t) => t.name);

try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    await wait(100);
    try {
      up = (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok;
    } catch {
      /* not yet */
    }
  }
  check('0 面板起来', up, `port=${PORT}`);
  if (!up) throw new Error('dashboard never came up');

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'hotplug', version: '0' } } });
  await reply(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  await wait(200);

  // 1) 未装：max_find_docs 必须被隐藏（上下文预算规则：没装就不占 schema）
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const before = toolNames(await reply(2));
  check('1 未装 qmd 时 max_find_docs 被隐藏', !before.includes('max_find_docs'), before.join(','));
  check('1b graft 六件套仍然可用（兄弟后端挂掉不影响主链路）', before.filter((n) => /(find_code|repo_map|find_all)/.test(n)).length >= 2, before.join(','));

  const statsBefore = await (await fetch(`http://127.0.0.1:${PORT}/stats`)).json();
  const qmdBefore = (statsBefore.fedHealth ?? []).find((b) => b.name === 'qmd');
  check('2 面板 fedHealth 报告 qmd 不可用', qmdBefore?.ok === false, JSON.stringify(qmdBefore));

  // 2) 用户"装好了"
  installFakeQmd(true);

  // 3) 点「重试探针」
  const reprobe = await (await fetch(`http://127.0.0.1:${PORT}/reprobe`)).json();
  const qmdAfter = (reprobe.backends ?? []).find((b) => b.name === 'qmd');
  check('3 /reprobe 返回 qmd 就绪', qmdAfter?.ok === true, JSON.stringify(qmdAfter));

  // 4) 不重启会话，tools/list 立刻多出 max_find_docs
  await wait(600);
  send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
  const after = toolNames(await reply(3));
  check('4 重探后 tools/list 出现 max_find_docs（无需重启）', after.includes('max_find_docs'), after.join(','));
  check('4b 发了 notifications/tools/list_changed（客户端才会主动重拉）', notifications.length >= 1, `${notifications.length} 次`);

  const statsAfter = await (await fetch(`http://127.0.0.1:${PORT}/stats`)).json();
  const qmdNow = (statsAfter.fedHealth ?? []).find((b) => b.name === 'qmd');
  check('5 面板 fedHealth 变为就绪', qmdNow?.ok === true, JSON.stringify(qmdNow));

  // 6) 真调用一次，证明工具真的能干活（不是只出现在列表里）
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'max_find_docs', arguments: { query: 'anything' } } });
  const call = await reply(4);
  const text = call.result?.content?.[0]?.text ?? '';
  check('6 max_find_docs 真实可调用（能返回软错误或结果，但绝不能是 unknown tool）', !text.includes('unknown tool'), text.slice(0, 140));
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
console.log(`\n后端热插拔 E2E: ${results.length - failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
