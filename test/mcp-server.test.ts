import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { buildGraph } from '../src/graph/build.js';

async function rpc(messages: object[], dir: string, expected: number, extraEnv: Record<string, string> = {}): Promise<any[]> {
  // A fresh HOME: the server's boot upkeep reads the machine's own wiring and
  // update cache, and its lines ride in `instructions`, so the real HOME would
  // make the length test depend on whatever this machine has installed.
  const home = mkdtempSync(join(tmpdir(), 'graft-mcpsrv-home-'));
  const { TRAIL_HOME: _t, GRAFT_HOME: _g, ...env } = process.env;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'mcp', dir], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, HOME: home, ...extraEnv } });
  const responses: any[] = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) responses.push(JSON.parse(line));
    }
  });
  for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
  const deadline = Date.now() + 15000;
  while (responses.length < expected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  await once(child, 'exit').catch(() => {});
  return responses;
}

test('initialize → tools/list → tools/call round-trip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-mcpsrv-'));
  const rs = await rpc(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'graft_trace_calls', arguments: { symbol: 'x.ts', depth: 2 } } },
    ],
    dir,
    3,
  );
  assert.equal(rs.length, 3);
  const init = rs.find((r) => r.id === 1);
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.ok(init.result.capabilities.tools);
  assert.equal(init.result.serverInfo.name, 'graft');
  // This dir has no graph and no parent checkout, so the server advertises
  // nothing: graft is registered at the user MCP scope now (hosts/claude-global.ts),
  // which starts it in every project the user opens, and six tool schemas charged
  // to a repo that never asked for graft is context spent for answers it cannot
  // give. See `advertised` in src/mcp/server.ts.
  const list = rs.find((r) => r.id === 2);
  assert.deepEqual(list.result.tools, []);
  // Not advertised is not the same as not callable — a client that calls anyway
  // still gets the soft error that names the fix.
  const call = rs.find((r) => r.id === 3);
  assert.equal(call.result.isError, true); // unbuilt repo → soft error content
  assert.match(call.result.content[0].text, /graft build/);
});

/** [graft-Max] 六个 graft 工具必在（Max 品牌命名）。
 *  联邦三工具**依赖后端探针**，因此**不能**写进这里的固定期望值 —— 之前那样写会在
 *  CI（没装 qmd/gitnexus）稳定失败：4050 pass / 2 fail，红的就是这两条。
 *  所以：确定性断言用 GRAFT_MAX_FEDERATED=0（只留六个），
 *  "装了才出现"的语义由 e2e/e2e-backend-hotplug.mjs 真实覆盖。 */
const MAX_SIX = ['max_find_code', 'max_file_api', 'max_check_freshness', 'max_trace_calls', 'max_find_all', 'max_repo_map'];
/** 可能出现的联邦工具全集（出现与否取决于后端是否安装）。 */
const FED_POSSIBLE = ['max_find_docs', 'max_trace_arch', 'max_search_semantic'];

async function listTools(dir: string, extraEnv: Record<string, string> = {}): Promise<string[]> {
  const rs = await rpc(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ],
    dir,
    2,
    extraEnv,
  );
  return rs.find((r) => r.id === 2).result.tools.map((t: any) => t.name);
}

test('a built repo advertises every tool', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-mcpbuilt-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'math.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
  await buildGraph(dir);

  // 关掉联邦 → 期望值确定（六个 max_*），在任何机器/CI 上都一样
  assert.deepEqual(await listTools(dir, { GRAFT_MAX_FEDERATED: '0' }), MAX_SIX);

  // 打开联邦 → 六件套必在；多出来的**只能**是联邦工具（具体哪几个由环境决定，不写死）
  const withFed = await listTools(dir);
  for (const t of MAX_SIX) assert.ok(withFed.includes(t), `missing ${t} in ${withFed.join(',')}`);
  const extras = withFed.filter((t) => !MAX_SIX.includes(t));
  for (const t of extras) assert.ok(FED_POSSIBLE.includes(t), `未预期的工具 ${t}（六件套之外只允许联邦工具）`);
});

test('a fresh worktree advertises every tool, on the strength of its parent', async () => {
  // The case the user-level registration exists for. `graft/` is gitignored, so
  // `git worktree add` never checks it out and this tree has no graph of its own —
  // it gets one from the parent on the first query (graph/seed.ts). Gating on this
  // tree alone would hide graft in exactly the worktree the user came to work in.
  const main = mkdtempSync(join(tmpdir(), 'graft-mcpwtmain-'));
  // Identity in the env, not the config: a CI runner has none, and blanking
  // GIT_CONFIG_GLOBAL removes any it had, so `git commit` would fail.
  const git = (...args: string[]): void =>
    execFileSync('git', args, {
      cwd: main,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'graft test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'graft test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
    });
  git('init', '-b', 'main');
  mkdirSync(join(main, 'src'), { recursive: true });
  writeFileSync(join(main, 'src', 'math.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
  writeFileSync(join(main, '.gitignore'), 'graft/\n');
  git('add', '-A');
  git('commit', '-m', 'init');
  await buildGraph(main);

  const wt = join(mkdtempSync(join(tmpdir(), 'graft-mcpwt-')), 'feature');
  git('worktree', 'add', '--detach', wt, 'HEAD');
  assert.equal(existsSync(join(wt, 'graft')), false, 'the gitignored cache does not travel');

  // 同上：确定性断言关掉联邦；再验证六件套在联邦开启时仍然齐全
  assert.deepEqual(await listTools(wt, { GRAFT_MAX_FEDERATED: '0' }), MAX_SIX);
  const wtWithFed = await listTools(wt);
  for (const t of MAX_SIX) assert.ok(wtWithFed.includes(t), `worktree missing ${t}`);
});

test('initialize carries instructions — the layer that survives tool deferral', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-mcpsrv-instr-'));
  const rs = await rpc(
    [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }],
    dir,
    1,
  );
  const { instructions, serverInfo } = rs[0].result;
  assert.equal(typeof instructions, 'string');
  // A host that defers graft's schemas shows the model six bare names and nothing
  // else, so this string has to carry both the pitch and the recovery instruction.
  // [graft-Max] 指令块为中文 Max 版：仍要求"一次加载全部工具"的批取指引 +
  // max_* 工具名 + <1000 字符预算（上游同红线）
  assert.match(instructions, /graft-Max/, 'branded as graft-Max');
  for (const t of ['max_find_code', 'max_find_all', 'max_trace_calls', 'max_file_api', 'max_repo_map']) {
    assert.ok(instructions.includes(t), `names ${t}`);
  }
  assert.ok(instructions.length < 1000, `instructions must stay under 1000 chars, got ${instructions.length}`);
  // [graft-Max] semver with our -max.N suffix on top of the upstream triple.
  assert.match(serverInfo.version, /^\d+\.\d+\.\d+(-max\.\d+)?$/, 'real version, not the old hardcoded 0');
});

test('unknown method returns -32601', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-mcpsrv2-'));
  const rs = await rpc([{ jsonrpc: '2.0', id: 9, method: 'resources/list' }], dir, 1);
  assert.equal(rs[0].error.code, -32601);
});
