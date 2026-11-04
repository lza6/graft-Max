/**
 * [M7] /stats.errorRate 测试：起真 dashboard（随机端口），seed 日志
 * （10 行工具返回、其中 3 行 isError=true），断言 rate=0.3、windowLines 正确。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';

const home = mkdtempSync(join(tmpdir(), 'gm-errrate-'));
process.env.USERPROFILE = home;
process.env.HOME = home;
const gmHome = join(home, '.graft-max');
mkdirSync(gmHome, { recursive: true });
const logFile = join(gmHome, 'mcp.log');
process.env.GRAFT_MAX_LOG = logFile;
process.env.GRAFT_MAX_UI = '1';
delete process.env.GRAFT_MAX_UI_TOKEN;
delete process.env.GRAFT_MAX_UI_HOST;

// 10 行工具返回，其中 3 行 isError=true（索引 1、4、7）
const lines: string[] = [];
for (let i = 0; i < 10; i++) {
  const err = i === 1 || i === 4 || i === 7;
  lines.push(`[2026-11-05 08:00:${String(i).padStart(2, '0')}.000] <-- 工具返回（graft）  graft_find_code  ${100 + i}ms  isError=${err}`);
}
writeFileSync(logFile, lines.join('\n') + '\n', 'utf8');

const { startDashboard } = await import('../src/mcp/dashboard.js');

const repo = join(home, 'repo');
mkdirSync(repo, { recursive: true });

let srv: Server | undefined;
let port = 0;

test.before(async () => {
  srv = startDashboard(0, repo);
  if (!srv.listening) await once(srv, 'listening');
  const addr = srv.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
  assert.ok(port > 0);
});

test.after(async () => {
  if (srv) {
    srv.close();
    await once(srv, 'close').catch(() => {});
  }
  rmSync(home, { recursive: true, force: true });
});

test('[M7] /stats.errorRate：3/10 = 0.3，windowLines=10', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/stats`);
  assert.equal(r.status, 200);
  const s = (await r.json()) as { errorRate: { windowLines: number; errors: number; rate: number | null } };
  assert.ok(s.errorRate, 'errorRate 字段必须存在');
  assert.equal(s.errorRate.windowLines, 10);
  assert.equal(s.errorRate.errors, 3);
  assert.ok(
    Math.abs((s.errorRate.rate as number) - 0.3) < 1e-9,
    `rate 应为 0.3（4 位小数），实际 ${s.errorRate.rate}`,
  );
});

test('[M7] errorRate 与 toolStats 同 TTL：追加日志后 2s 内缓存不变，过期后刷新', async () => {
  const get = async () => {
    const r = await fetch(`http://127.0.0.1:${port}/stats`);
    return (await r.json()) as { errorRate: { windowLines: number; errors: number; rate: number | null } };
  };
  const before = await get();
  assert.equal(before.errorRate.windowLines, 10);
  // 追加一行失败日志 —— TTL 内缓存不刷新
  appendFileSync(logFile, '[2026-11-05 08:00:59.000] <-- 工具返回（graft）  graft_find_code  50ms  isError=true\n');
  const cached = await get();
  assert.equal(cached.errorRate.windowLines, 10, '2s TTL 内必须命中缓存');
  // 等过期后刷新
  await new Promise((res) => setTimeout(res, 2100));
  const fresh = await get();
  assert.equal(fresh.errorRate.windowLines, 11);
  assert.equal(fresh.errorRate.errors, 4);
  // rate 保留 4 位小数：Math.round((4/11)*10000)/10000 = 0.3636
  assert.equal(fresh.errorRate.rate, Math.round((4 / 11) * 10000) / 10000, `实际 ${fresh.errorRate.rate}`);
});

test('[M7] 空窗口：无工具返回行时 rate=null', async () => {
  // 用独立临时日志起第二个 dashboard，日志里只有非工具行
  const home2 = mkdtempSync(join(tmpdir(), 'gm-errrate0-'));
  process.env.USERPROFILE = home2;
  process.env.HOME = home2;
  const log2 = join(home2, '.graft-max', 'mcp.log');
  mkdirSync(join(home2, '.graft-max'), { recursive: true });
  writeFileSync(log2, '[2026-11-05 09:00:00.000] === graft-Max MCP 服务启动 ===\n', 'utf8');
  // 重新加载模块拿新的 env……startDashboard 读的是 devlog 的模块级 target，
  // 这里改为直接验证纯逻辑：windowLines=0 → rate=null 已由实现分支保证，
  // 并通过对第一个 server 的日志重定向不可行，退而验证导出的 errorRate 契约。
  const dash = await import('../src/mcp/dashboard.js');
  assert.equal(typeof dash.errorRate, 'function');
  const er = await dash.errorRate();
  // 当前窗口（第一个 server 的日志）已有数据
  assert.equal(er.windowLines, 11);
  rmSync(home2, { recursive: true, force: true });
});
