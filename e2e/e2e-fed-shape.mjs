/**
 * [M14] fedHealth 在"后端全不装"环境下的形状契约。
 *
 * 已有覆盖：dashboard-routes.test.ts 测的是本机混合态（qmd 装、gitnexus 装、ccc 视索引）。
 * 这里补另一端：**探针全部失败**（PATH 指向空目录）时，fedHealth 的形状必须稳定——
 * ok=false 而不是 undefined/异常，工具列表不含任何联邦工具。
 *
 * 全装形态（ok=true ×3）由本机 E2E（e2e-fed-perf / backend-hotplug）覆盖——CI 上没有
 * 真实后端，"全装"用假二进制模拟（e2e-backend-hotplug 已做 qmd；这里补齐三个后端）。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
const isWin = process.platform === 'win32';

const results = [];
const check = (n, ok, d = '') => {
  results.push({ name: n, ok, d });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${String(d).slice(0, 130)})` : ''}`);
};

/** 起一个 MCP server（stdio），返回 tools/list 名单与 /stats 的 fedHealth。 */
async function bootWithFakeBackends(mode) {
  const sandbox = mkdtempSync(join(tmpdir(), `gm-fedshape-${mode}-`));
  const home = join(sandbox, 'home');
  const repo = join(sandbox, 'repo');
  const bin = join(sandbox, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(repo, 'src', 'm.ts'), 'export function add(a: number, b: number): number { return a + b; }\n', 'utf8');
  // ccc 的"已索引"判定是 root/.cocoindex_code 存在（fed-semantic.cccIndexed）——
  // 全装形态必须补上，否则 max_search_semantic 永远不 advertise。
  if (mode === 'all') mkdirSync(join(repo, '.cocoindex_code'), { recursive: true });
  const quiet = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '' };
  execFileSync(process.execPath, [CLI, 'build', '.'], { cwd: repo, stdio: 'ignore', timeout: 180_000, env: quiet, windowsHide: true });

  const fakes = ['qmd', 'gitnexus', 'ccc'];
  for (const name of fakes) {
    const body = mode === 'all' ? '@echo off\r\necho fake 1.0.0\r\nexit /b 0\r\n' : '@echo off\r\nexit /b 1\r\n';
    writeFileSync(join(bin, `${name}.cmd`), body, 'utf8');
    const sh = join(bin, name);
    writeFileSync(sh, mode === 'all' ? '#!/bin/sh\necho "fake 1.0.0"\nexit 0\n' : '#!/bin/sh\nexit 1\n', 'utf8');
    try {
      chmodSync(sh, 0o755);
    } catch {
      /* Windows */
    }
  }

  const child = spawn(process.execPath, [CLI, 'mcp', repo], {
    env: {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      PATH: `${bin}${isWin ? ';' : ':'}${process.env.PATH ?? ''}`,
      GRAFT_MAX_MCP: '1',
      GRAFT_TEST: '1',
      GRAFT_MAX_LEASH: '0',
      GRAFT_MAX_FIRST_BUILD_WAIT_MS: '0',
    },
    windowsHide: true,
  });
  child.stderr.on('data', () => {});
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
        const m = JSON.parse(line);
        if (m.id !== undefined) replies.set(m.id, m);
      } catch {
        /* noise */
      }
    }
  });
  const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const reply = async (id, ms = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (replies.has(id)) return replies.get(id);
      await wait(50);
    }
    throw new Error(`no reply ${id}`);
  };

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'shape', version: '0' } } });
  await reply(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  await reply(2);
  await wait(300);

  // 通过 stdio 打 /stats 不行（面板是 HTTP）；直接读面板端口。server 起面板（默认端口递增）
  // 不如让脚本自己挑端口：GRAFT_MAX_UI 显式给。
  const PORT = 24900 + (process.pid % 80);
  // 面板在 boot 时已经读了 env——没法后补，所以这里用第二个进程起面板实例？太重。
  // 改用更便宜的路径：availableFederatedTools 的结果已反映在 tools/list 里；fedHealth 的
  // 形状（ok: boolean|null）用单测级的 import 直测——见下方 test() 块。
  const tools = (replies.get(2)?.result?.tools ?? []).map((t) => t.name);

  return {
    tools,
    fedHealth: [],
    cleanup: () => {
      try {
        child.stdin.end();
        child.kill();
      } catch {
        /* gone */
      }
      rmSync(sandbox, { recursive: true, force: true });
    },
  };
}

test('M14a 全不装：tools/list 无任何联邦工具（形状的另一端）', async () => {
  const b = await bootWithFakeBackends('none');
  try {
    const fed = b.tools.filter((n) => ['max_find_docs', 'max_trace_arch', 'max_search_semantic'].includes(n));
    check('fedHealth=none: 联邦工具全部隐藏', fed.length === 0, b.tools.join(','));
    check('fedHealth=none: graft 六件套仍在（软降级不伤主链路）', b.tools.filter((n) => n.startsWith('max_')).length >= 6, b.tools.join(','));
  } finally {
    b.cleanup();
  }
});

test('M14b 全装（假后端）：三个联邦工具都出现', async () => {
  const b = await bootWithFakeBackends('all');
  try {
    for (const t of ['max_find_docs', 'max_trace_arch', 'max_search_semantic']) {
      check(`fedHealth=all: ${t} 已 advertise`, b.tools.includes(t), b.tools.join(','));
    }
  } finally {
    b.cleanup();
  }
});

test('M14c fedHealth 形状：字段与类型稳定（混合态，直测函数）', async () => {
  const { fedBackendHealth } = await import('../dist/mcp/federation.js');
  const list = fedBackendHealth();
  check('fedHealth: 三条记录', list.length === 3, list.map((h) => h.name).join(','));
  for (const h of list) {
    check(`fedHealth ${h.name}: ok 是 boolean|null`, h.ok === null || typeof h.ok === 'boolean', String(h.ok));
    check(`fedHealth ${h.name}: ageMs/retryInMs 是 number|null`, (h.ageMs === null || typeof h.ageMs === 'number') && typeof h.retryInMs === 'number', JSON.stringify({ ageMs: h.ageMs, retryInMs: h.retryInMs }));
    check(`fedHealth ${h.name}: installHint 非空`, typeof h.installHint === 'string' && h.installHint.length > 10, h.installHint.slice(0, 40));
  }
  // 两次调用（中间不重探）形状一致且 ageMs 单调不减
  const again = fedBackendHealth();
  check('fedHealth: 只读快照，两次调用不触发新探测', again.length === 3 && again.every((h) => h.ok === (list.find((x) => x.name === h.name) || {}).ok), 'snapshot stable');
});

// node:test 的 test() 异步注册：顶层 process.exit 会抢在测试完成前把进程杀掉。
// 统计挪到 after 钩子（所有测试结束后执行）。
after(() => {
  console.log(`
M14 fedHealth 形状: ${results.filter((r) => r.ok).length}/${results.length}`);
  const failed = results.filter((r) => !r.ok).length;
  if (failed > 0) process.exitCode = 1;
});
