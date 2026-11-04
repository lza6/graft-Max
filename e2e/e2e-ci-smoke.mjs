/**
 * [graft-Max N16] CI 冒烟 E2E —— 唯一一个不依赖真实后端/浏览器/网络的自包含 E2E。
 *
 * 为什么需要它：仓库里其它 9 个 E2E 都硬编码了本机路径与真实 qmd/gitnexus 后端，
 * 在 CI 上一条都跑不了，于是"只有这台机器能验证"。这个脚本只依赖：
 *   - `dist/cli.js`（npm run build 的产物）
 *   - 一个临时目录里造出来的迷你仓库
 *   - stdio JSON-RPC（和真实 MCP 宿主完全同一条链路）
 *
 * 覆盖的真实链路：initialize → tools/list → tools/call（建图 + 图查询）→
 * 会话注册 → ICM 时序 JSONL → 退出清理。
 *
 * 断言强度（P3-18 教训）：不看"有返回"，看"返回对不对"—— 名称、字段形状、
 * 内容非空、isError=false、落盘文件真实存在。
 *
 * 用法：node e2e/e2e-ci-smoke.mjs        （需要先 npm run build）
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}${detail ? `  (${String(detail).slice(0, 120)})` : ''}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? `  (${String(detail).slice(0, 400)})` : ''}`);
  }
};

if (!existsSync(CLI)) {
  console.error(`FAIL  dist/cli.js missing at ${CLI} — run "npm run build" first`);
  process.exit(1);
}

// --- 沙箱：临时 home（sessions.json / mcp.log / tool-timeline.jsonl 都落这里）+ 迷你仓库 ---
const sandbox = mkdtempSync(join(tmpdir(), 'gm-ci-smoke-'));
const home = join(sandbox, 'home');
const repo = join(sandbox, 'repo');
mkdirSync(home, { recursive: true });
mkdirSync(join(repo, 'src'), { recursive: true });
writeFileSync(
  join(repo, 'src', 'math.ts'),
  'export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n',
  'utf8',
);
writeFileSync(join(repo, 'README.md'), '# smoke repo\n\nA tiny repo for the CI smoke test.\n', 'utf8');

// --- 邀请仓库：真实用户路径就是 `graft build`（建图即邀请） ---
// 项目约束 §2："未邀请 graft 的仓库 = 零工具"（schema 是每轮都计费的 context）。
// advertised() 判据是 graft/.graph/wiring.json 是否存在，所以新仓库必须先建图，
// 否则 tools/list 是空的 —— 这不是 bug，是上下文预算规则；冒烟测试必须走真实路径。
const quietEnv = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '' };
try {
  execFileSync(process.execPath, [CLI, 'build', '.'], { cwd: repo, stdio: 'ignore', timeout: 180_000, env: quietEnv, windowsHide: true });
  check('预置：graft build 产出图谱索引', existsSync(join(repo, 'graft', '.graph', 'wiring.json')));
} catch (e) {
  check('预置：graft build 成功', false, e instanceof Error ? e.message : String(e));
}

const child = spawn(process.execPath, [CLI, 'mcp', repo], {
  env: {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    GRAFT_MAX_LOG: '1',
    GRAFT_MAX_MCP: '1',
    GRAFT_TEST: '1', // ICM 时序走干跑，不起外部进程
    GRAFT_MAX_UI: '', // 面板不在本冒烟里起（端口在不同 runner 上可能冲突）
    GRAFT_MAX_LEASH: '0',
    GRAFT_MAX_FIRST_BUILD_WAIT_MS: '60000', // 迷你仓库首查建图很快，给足窗口
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    http_proxy: '',
    https_proxy: '',
  },
  windowsHide: true,
});

let stdoutBuf = '';
let stderrBuf = '';
const replies = new Map();
child.stdout.on('data', (d) => {
  stdoutBuf += d.toString();
  let idx;
  while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) replies.set(msg.id, msg);
    } catch {
      check('stdout 只能是 JSON-RPC（出现非协议行）', false, line);
    }
  }
});
child.stderr.on('data', (d) => {
  stderrBuf += d.toString();
});

const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function withTimeout(promise, ms, label) {
  const t = new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms));
  return Promise.race([promise, t]);
}
async function reply(id, ms = 30_000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (replies.has(id)) return replies.get(id);
    await wait(50);
  }
  throw new Error(`no reply for id=${id} within ${ms}ms`);
}

const cleanup = () => {
  try {
    child.stdin.end();
  } catch {}
  try {
    child.kill();
  } catch {}
  if (process.env.GM_KEEP !== '1') rmSync(sandbox, { recursive: true, force: true });
  else console.log(`sandbox kept: ${sandbox}`);
};

try {
  // 1) initialize
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ci-smoke', version: '0' } },
  });
  const init = await withTimeout(reply(1), 20_000, 'initialize');
  check('initialize 有 result', !!init.result, JSON.stringify(init).slice(0, 120));
  check('initialize.serverInfo.version 是 max 版本', /-max\.\d+$/.test(init.result?.serverInfo?.version ?? ''), init.result?.serverInfo?.version);
  check('initialize.instructions 非空（<1000 字符预算内）', (init.result?.instructions ?? '').length > 0 && (init.result?.instructions ?? '').length < 4000, `${(init.result?.instructions ?? '').length} chars`);
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

  // 2) tools/list —— 仓库被邀请（GRAFT_MAX_MCP=1）时必须出现 graft 六件套
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const list = await withTimeout(reply(2), 20_000, 'tools/list');
  const names = (list.result?.tools ?? []).map((t) => t.name);
  check('tools/list 非空', names.length > 0, names.join(','));
  const six = ['find_code', 'find_all', 'trace_calls', 'file_api', 'repo_map', 'check_freshness'];
  const maxName = (n) => names.find((x) => x === `max_${n}` || x === `graft_${n}` || x === `trail_${n}`);
  for (const n of six) check(`tool ${n} 已 advertise`, !!maxName(n));
  check('每个 tool 都有 object 型 inputSchema', (list.result?.tools ?? []).every((t) => t.inputSchema?.type === 'object'));

  // 3) tools/call：真实建图 + 真实图查询（首次会触发自动建图）
  const mapName = maxName('repo_map');
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: mapName, arguments: {} } });
  const map = await withTimeout(reply(3), 120_000, 'tools/call repo_map');
  const mapText = map.result?.content?.[0]?.text ?? '';
  check('repo_map 调用成功（isError=false）', map.result?.isError === false, mapText.slice(0, 160));
  check('repo_map 内容非空', mapText.trim().length > 0, `${mapText.length} chars`);
  check('repo_map 建出了图（含 math.ts 或 add）', /math\.ts|add/i.test(mapText), mapText.slice(0, 200));

  const findName = maxName('find_code');
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: findName, arguments: { query: 'add two numbers' } } });
  const find = await withTimeout(reply(4), 60_000, 'tools/call find_code');
  const findText = find.result?.content?.[0]?.text ?? '';
  check('find_code 调用成功（isError=false）', find.result?.isError === false, findText.slice(0, 160));
  check('find_code 命中了真实符号', /add/i.test(findText), findText.slice(0, 200));

  // 4) 落盘证据：会话注册表 + 开发日志 + ICM 时序 JSONL
  const sessionsPath = join(home, '.graft-max', 'sessions.json');
  let rows = [];
  for (let i = 0; i < 40 && rows.length === 0; i++) {
    await wait(50);
    if (!existsSync(sessionsPath)) continue;
    try {
      rows = JSON.parse(readFileSync(sessionsPath, 'utf8') || '[]');
    } catch {}
  }
  check('会话注册表落盘且有自己的行', rows.length >= 1 && rows.some((r) => r.pid === child.pid), JSON.stringify(rows).slice(0, 200));
  check('自己的行 cwd 指向被服务的仓库', rows.some((r) => String(r.cwd).replaceAll('\\', '/').toLowerCase() === repo.replaceAll('\\', '/').toLowerCase()));

  const logPath = join(home, '.graft-max', 'mcp.log');
  let logText = '';
  for (let i = 0; i < 40 && !logText.includes('工具调用'); i++) {
    await wait(50);
    if (!existsSync(logPath)) continue;
    logText = readFileSync(logPath, 'utf8');
  }
  check('开发日志落盘且已汉化（含"工具调用"）', logText.includes('工具调用'), logPath);
  check('日志记录了真实工具名', /工具=max_repo_map|工具=max_find_code/.test(logText), logText.split('\n').find((l) => l.includes('工具='))?.slice(0, 120));

  const jsonl = join(home, '.graft-max', 'tool-timeline.jsonl');
  let lines = [];
  for (let i = 0; i < 40 && lines.length < 2; i++) {
    await wait(50);
    if (!existsSync(jsonl)) continue;
    lines = readFileSync(jsonl, 'utf8').split('\n').filter(Boolean);
  }
  check('ICM 时序 JSONL 有 2 条调用记录', lines.length >= 2, `${lines.length} lines`);
  check('JSONL 行格式含工具名与 isError', lines.length > 0 && /isError=(true|false)/.test(lines[0]), lines[0]?.slice(0, 120));

  // 5) 干净退出：关 stdin 后进程必须自己结束
  child.stdin.end();
  const exited = await withTimeout(
    new Promise((resolve) => child.once('exit', (code) => resolve(code))),
    15_000,
    'graceful exit',
  );
  check('关 stdin 后进程自行退出（code=0）', exited === 0, `code=${exited}`);
  if (stderrBuf.trim()) console.log(`---- server stderr (tail) ----\n${stderrBuf.trim().split('\n').slice(-12).join('\n')}`);
} catch (e) {
  check(`未捕获异常：${e instanceof Error ? e.message : String(e)}`, false);
  if (stderrBuf.trim()) console.log(`---- server stderr (tail) ----\n${stderrBuf.trim().split('\n').slice(-20).join('\n')}`);
} finally {
  cleanup();
}

console.log(`\nCI smoke E2E: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
