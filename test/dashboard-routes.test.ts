/**
 * [N7] 面板路由契约测试 —— 起**真的** HTTP server（随机端口），逐个端点打，
 * 断言状态码 + content-type + 响应形状 + 参数边界。
 *
 * 为什么必须有它：max.9 之前 `dashboard.ts` 的 669 行里没有一行测试，`/storage`
 * 从 7329ms 降到 5ms 这类回归只能靠人肉压测发现。这里把"路由能应答、参数不炸、
 * 形状不变"钉死，任何重构（比如 N8 拆前端工程）都能立刻发现破约。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';

const home = mkdtempSync(join(tmpdir(), 'gm-dash-'));
process.env.USERPROFILE = home;
process.env.HOME = home;
const gmHome = join(home, '.graft-max');
mkdirSync(gmHome, { recursive: true });
const logFile = join(gmHome, 'mcp.log');
process.env.GRAFT_MAX_LOG = logFile;
process.env.GRAFT_MAX_UI = '1'; // 打开面板（端口由 startDashboard 的显式参数决定）
delete process.env.GRAFT_MAX_UI_TOKEN; // 回环默认形态：免令牌
delete process.env.GRAFT_MAX_UI_HOST; // 绑回环

// 造一段"真实形状"的日志：两次成功、一次失败，供 toolStats 分位断言
const seededLog = [
  '[2026-11-04 08:00:00.000] === graft-Max MCP 服务启动 === root=/tmp/repo version=0.0.0-test',
  '[2026-11-04 08:00:01.000] --> 工具调用  请求id=1  工具=max_find_code',
  '[2026-11-04 08:00:01.100] <-- 工具返回（graft）  graft_find_code  100ms  isError=false',
  '[2026-11-04 08:00:02.000] <-- 工具返回（graft）  graft_find_code  10ms  isError=false',
  '[2026-11-04 08:00:03.000] <-- 工具返回（graft）  graft_repo_map  200ms  isError=true',
].join('\n');
writeFileSync(logFile, `${seededLog}\n`, 'utf8');

const dash = await import('../src/mcp/dashboard.js');
const { startDashboard, percentile, knownRoots, hostAllowed, isLoopbackBind } = dash;

const repo = join(home, 'repo');
mkdirSync(repo, { recursive: true });

let srv: Server | undefined;
let port = 0;
const base = (): string => `http://127.0.0.1:${port}`;

/** 启动一次，整个文件复用（端口随机，避免和本机其它面板撞车）。 */
test.before(async () => {
  srv = startDashboard(0, repo);
  assert.ok(srv, 'startDashboard 应当返回 server');
  if (!srv.listening) await once(srv, 'listening');
  const addr = srv.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
  assert.ok(port > 0, '应当拿到真实端口');
});

test.after(async () => {
  if (srv) {
    srv.close();
    await once(srv, 'close').catch(() => {});
  }
  rmSync(home, { recursive: true, force: true });
});

const get = async (path: string, headers: Record<string, string> = {}): Promise<{ status: number; type: string; body: string }> => {
  const r = await fetch(base() + path, { headers });
  return { status: r.status, type: r.headers.get('content-type') ?? '', body: await r.text() };
};

test('GET / 返回 HTML 页面（含品牌）', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/html/);
  assert.match(r.body, /graft-Max/);
  assert.match(r.body, /<html/i);
});

test('安全响应头在每条响应上都存在（含 4xx）', async () => {
  for (const path of ['/', '/stats', '/nope']) {
    const r = await get(path);
    assert.equal(r.status === 404 ? 404 : 200, r.status);
    const raw = await fetch(base() + path);
    assert.equal(raw.headers.get('x-content-type-options'), 'nosniff', `${path} 缺 nosniff`);
    assert.ok(raw.headers.get('content-security-policy')?.includes("default-src 'self'"), `${path} 缺 CSP`);
    assert.equal(raw.headers.get('referrer-policy'), 'no-referrer', `${path} 缺 referrer-policy`);
    assert.equal(raw.headers.get('x-frame-options'), 'DENY', `${path} 缺 x-frame-options`);
  }
});

test('GET /healthz：无鉴权、无数据的探活端点', async () => {
  const r = await get('/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true });
});

test('GET /tail：n 参数生效、超界裁剪、坏参数不崩', async () => {
  const one = await get('/tail?n=1');
  assert.equal(one.status, 200);
  assert.match(one.type, /text\/plain/);
  assert.equal(one.body.split('\n').filter(Boolean).length, 1, 'n=1 只返回最后一行');

  const clamped = await get('/tail?n=999999');
  assert.equal(clamped.status, 200);
  assert.ok(clamped.body.split('\n').filter(Boolean).length <= 2001, 'n 必须被裁剪到 2000');

  const broken = await get('/tail?n=abc');
  assert.equal(broken.status, 200, '坏参数不得 500');
  assert.ok(broken.body.length > 0);
});

test('GET /sessions：JSON 数组，形状正确', async () => {
  const r = await get('/sessions');
  assert.equal(r.status, 200);
  assert.match(r.type, /application\/json/);
  const rows = JSON.parse(r.body) as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(rows));
});

test('GET /stats：契约字段齐全（version/port/roots/toolStats/fedHealth/fedCache）', async () => {
  const r = await get('/stats');
  assert.equal(r.status, 200);
  const s = JSON.parse(r.body) as Record<string, unknown>;
  for (const key of ['version', 'port', 'logPath', 'logBytes', 'requests', 'roots', 'building', 'toolStats', 'fedHealth', 'fedCache']) {
    assert.ok(key in s, `缺少字段 ${key}`);
  }
  assert.equal(s.port, port, 'port 必须是真实监听端口');
  assert.ok(Array.isArray(s.roots) && (s.roots as string[]).length >= 1, 'roots 至少含主仓库');
  assert.equal((s.fedHealth as unknown[]).length, 3, '三个联邦后端都要报健康度');
});

test('GET /stats 的 toolStats 给出真实分位（p95 ≥ p50 ≥ 0，且有错误计数）', async () => {
  const s = JSON.parse((await get('/stats')).body) as { toolStats: Record<string, { calls: number; avgMs: number; p50: number; p95: number; errors: number }> };
  const fc = s.toolStats.find_code;
  assert.ok(fc, '日志里的 find_code 应被聚合成一行');
  assert.equal(fc.calls, 2, '两次成功调用');
  assert.equal(fc.avgMs, 55, '(100+10)/2');
  assert.ok(fc.p50 <= fc.p95, 'p50 不得大于 p95');
  assert.equal(fc.errors, 0);
  const rm = s.toolStats.repo_map;
  assert.ok(rm, 'repo_map 也要有一行');
  assert.equal(rm.errors, 1, 'isError=true 必须计入错误数');
});

test('GET /fresh：JSON 数组，每个仓库带 state', async () => {
  const r = await get('/fresh');
  assert.equal(r.status, 200);
  const list = JSON.parse(r.body) as Array<{ root: string; state: string; note: string }>;
  assert.ok(Array.isArray(list) && list.length >= 1);
  assert.ok(['clean', 'drift', 'unknown'].includes(list[0].state), `未知 state: ${list[0].state}`);
  assert.ok(list[0].note.length > 0, '人类可读的说明不能为空');
});

test('GET /storage：顶层 entries（老形状）+ roots（多仓库分组）', async () => {
  const r = await get('/storage');
  assert.equal(r.status, 200);
  const s = JSON.parse(r.body) as { root: string; entries: Array<{ label: string; path: string; kind: string; exists: boolean }>; roots: Array<{ root: string; entries: unknown[] }> };
  assert.ok(Array.isArray(s.entries) && s.entries.length > 0, '顶层 entries 保持向后兼容');
  assert.ok(Array.isArray(s.roots) && s.roots.length >= 1, '新形状 roots 必须存在');
  for (const e of s.entries) {
    assert.ok(['file', 'dir'].includes(e.kind), `kind 只能是 file/dir: ${e.kind}`);
    assert.equal(typeof e.path, 'string');
  }
  assert.ok(s.entries.some((e) => e.label.includes('开发者日志')), '日志文件应当在产物清单里');
});

test('GET /favicon.ico：内联 SVG（不污染控制台）', async () => {
  const r = await get('/favicon.ico');
  assert.equal(r.status, 200);
  assert.match(r.type, /svg/);
  assert.match(r.body, /<svg/);
});

test('未知路径 → 404 JSON', async () => {
  const r = await get('/definitely-not-a-route');
  assert.equal(r.status, 404);
  assert.deepEqual(JSON.parse(r.body), { error: 'not found' });
});

test('Host 伪造 → 403（防 DNS rebinding）', async () => {
  // 注意：不能用 fetch 伪造 Host —— undici 把 Host 列为禁止头，设了也会被改回
  // 真实主机名（第一次写这条测试就是被它骗了：断言 403 却拿到 200）。
  // 必须走 node:http 的原始请求，`headers.host` 才是真的发出去的 Host。
  const { request } = await import('node:http');
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/stats', method: 'GET', headers: { host: 'evil.example.com' } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);

  // 同一个端口、真实 Host → 200（不是把所有请求都拒了）
  const ok = await get('/stats');
  assert.equal(ok.status, 200);
});

test('percentile 纯函数：最近秩法，边界不返回 NaN', () => {
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile([7], 95), 7, '单样本退化为该值');
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 95), 4);
  assert.equal(percentile([5, 1, 3].sort((a, b) => a - b), 50), 3);
});

test('knownRoots：主 root + 活跃会话 cwd，去重且归一大小写/分隔符', () => {
  const roots = knownRoots(repo);
  assert.ok(roots.length >= 1);
  assert.equal(roots[0].replaceAll('\\', '/').toLowerCase(), repo.replaceAll('\\', '/').toLowerCase());
  // 传同一个仓库的不同写法不应产生第二行
  const withDup = knownRoots(repo);
  assert.equal(withDup.length, roots.length);
});

test('hostAllowed / isLoopbackBind 的基本判定', () => {
  assert.equal(hostAllowed('127.0.0.1:24688', '127.0.0.1'), true);
  assert.equal(hostAllowed('localhost', '127.0.0.1'), true);
  assert.equal(hostAllowed('[::1]:24688', '127.0.0.1'), true);
  assert.equal(hostAllowed('evil.com', '127.0.0.1'), false);
  assert.equal(isLoopbackBind('127.0.0.1'), true);
  assert.equal(isLoopbackBind('0.0.0.0'), false);
});
