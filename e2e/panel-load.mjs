/**
 * [N9 验收] 面板端点压测 —— 断言"没变差"，不是刷分。
 *
 * max.9 的基线（evidence/max9-ui-docker.json）：串行 <3ms，50 并发 /stats p95 108ms，
 * /storage p99 5.3ms（修复前 7329ms，因为同步目录遍历堵死事件循环）。
 * 本轮加了 4 张新卡（工具耗时/联邦后端/新鲜度/多仓库存储），必须证明：
 *   1. 串行端点仍然 < 5ms；
 *   2. 50 并发 /stats p95 < 120ms；
 *   3. /storage 仍然是毫秒级（按 root 分桶的缓存生效）；
 *   4. 零 5xx、零超时。
 *
 * ⚠️ 必须在**空闲机器**上跑：与 `npm test`（会拉起上百个 node 进程）并行时，
 *    实测 p95 会从 86ms 涨到 170ms、吞吐从 697 掉到 405 req/s —— 那是 CPU 争用，
 *    不是回归。测量前先确认没有别的重活在跑。
 *
 * 用法：node e2e/panel-load.mjs          （需先 npm run build）
 *      CONC=50 DURATION=6 node e2e/panel-load.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
const CONC = Number(process.env.CONC ?? 50);
const DURATION_MS = Number(process.env.DURATION ?? 6) * 1000;

const results = [];
const check = (n, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`);
};
const pct = (arr, p) => {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
};
const r1 = (n) => Math.round(n * 10) / 10;

const sandbox = mkdtempSync(join(tmpdir(), 'gm-load-'));
const home = join(sandbox, 'home');
const repo = join(sandbox, 'repo');
mkdirSync(home, { recursive: true });
mkdirSync(join(repo, 'src'), { recursive: true });
writeFileSync(join(repo, 'src', 'm.ts'), 'export function add(a: number, b: number): number { return a + b; }\n', 'utf8');
execFileSync(process.execPath, [CLI, 'build', '.'], {
  cwd: repo,
  stdio: 'ignore',
  timeout: 180_000,
  env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '' },
  windowsHide: true,
});

const PORT = 24850 + (process.pid % 40);
const child = spawn(process.execPath, [CLI, 'mcp', repo], {
  env: { ...process.env, USERPROFILE: home, HOME: home, GRAFT_MAX_LOG: '1', GRAFT_MAX_UI: String(PORT), GRAFT_MAX_LEASH: '0', GRAFT_MAX_MCP: '1', GRAFT_TEST: '1' },
  windowsHide: true,
});
child.stderr.on('data', () => {});
child.stdout.on('data', () => {});

const base = `http://127.0.0.1:${PORT}`;
const timed = async (path) => {
  const t0 = performance.now();
  const r = await fetch(base + path);
  await r.arrayBuffer();
  return { ms: performance.now() - t0, status: r.status };
};

try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      up = (await fetch(`${base}/healthz`)).ok;
    } catch {}
  }
  check('0 面板起来', up, `port=${PORT}`);
  if (!up) throw new Error('dashboard never came up');

  // 预热：先打一轮，把 30s/2s 缓存填上（与 max.9 的测量口径一致）
  for (const p of ['/stats', '/tail?n=200', '/sessions', '/storage', '/fresh']) await timed(p);

  // 1) 串行延迟
  const serial = {};
  for (const p of ['/stats', '/tail?n=200', '/sessions', '/storage', '/fresh']) {
    const xs = [];
    for (let i = 0; i < 20; i++) xs.push((await timed(p)).ms);
    serial[p] = { p50: r1(pct(xs, 50)), p95: r1(pct(xs, 95)) };
  }
  console.log(`  串行 p50/p95: ${Object.entries(serial).map(([k, v]) => `${k}=${v.p50}/${v.p95}ms`).join('  ')}`);
  check('1 串行 /stats p50 < 5ms', serial['/stats'].p50 < 5, `${serial['/stats'].p50}ms`);
  check('1b 串行 /tail p50 < 5ms', serial['/tail?n=200'].p50 < 5, `${serial['/tail?n=200'].p50}ms`);
  check('1c 串行 /storage p50 < 5ms（缓存生效，修复前 3201ms）', serial['/storage'].p50 < 5, `${serial['/storage'].p50}ms`);
  check('1d 串行 /fresh p50 < 10ms', serial['/fresh'].p50 < 10, `${serial['/fresh'].p50}ms`);

  // 2) 50 并发 /stats 打 DURATION_MS
  const lat = [];
  let errors = 0;
  const deadline = Date.now() + DURATION_MS;
  let requests = 0;
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      while (Date.now() < deadline) {
        const r = await timed('/stats').catch(() => ({ ms: 0, status: 0 }));
        if (r.status !== 200) errors++;
        else lat.push(r.ms);
        requests++;
      }
    }),
  );
  const qps = requests / (DURATION_MS / 1000);
  console.log(`  并发 ${CONC} · ${DURATION_MS / 1000}s · ${requests} 请求 · ${r1(qps)} req/s · p50 ${r1(pct(lat, 50))}ms p95 ${r1(pct(lat, 95))}ms p99 ${r1(pct(lat, 99))}ms · 错误 ${errors}`);
  check('2 50 并发 /stats p95 < 120ms（max.9 基线 108ms）', pct(lat, 95) < 120, `${r1(pct(lat, 95))}ms`);
  check('2b 并发零错误（无 5xx / 无超时）', errors === 0, `${errors} 个错误`);
  check('2c 吞吐 ≥ 100 req/s', qps >= 100, `${r1(qps)} req/s`);

  // 3) /storage 并发（过去最容易被目录遍历堵死的端点）
  const st = [];
  await Promise.all(
    Array.from({ length: 20 }, async () => {
      for (let i = 0; i < 5; i++) st.push((await timed('/storage')).ms);
    }),
  );
  check('3 /storage 20 并发 p99 < 50ms', pct(st, 99) < 50, `p50 ${r1(pct(st, 50))}ms p99 ${r1(pct(st, 99))}ms`);

  // 4) 事件循环没被堵死：并发压力下 /healthz 仍然秒回
  const hb = [];
  const hbDeadline = Date.now() + 1500;
  await Promise.all(
    Array.from({ length: 20 }, async () => {
      while (Date.now() < hbDeadline) {
        hb.push((await timed('/healthz')).ms);
        await new Promise((r) => setTimeout(r, 20));
      }
    }),
  );
  check('4 压力下 /healthz p99 < 50ms（事件循环未被目录遍历堵死）', pct(hb, 99) < 50, `p99 ${r1(pct(hb, 99))}ms`);
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
console.log(`\n面板压测: ${results.length - failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
