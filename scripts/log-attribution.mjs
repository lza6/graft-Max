#!/usr/bin/env node
/**
 * [诊断工具] 日志归因 —— 把 `~/.graft-max/mcp.log` 这口黑匣子打开：
 *
 *   谁（哪个仓库） · 什么时候 · 起了几次服务 · **暴露了哪些工具** · 实际调用了哪些 · 几次
 *
 * 为什么需要它：MCP server 的日志是"加了什么"的流水，但用户真正想知道的是
 * "工具有没有在真实会话里被用、在哪个项目里用的、为什么某个项目一次都没调"。
 * 光看 `grep 工具调用 | wc -l` 会把**测试沙箱的调用**和**真实会话的调用**混在一起，
 * 得出"161 次调用很活跃"的错误结论（本仓库就发生过一次）。
 *
 * 归类规则（写死，不做模糊猜测）：
 *   - `sandbox`  ：root 命中 trail-test-run- / gm-v2- / gm-ci-smoke / gm-hotplug /
 *                  gm-firstbuild / gm-feed- / gm-privacy / graft-mcpsrv / graft-trailname / Temp
 *                  （这些是 test/ 与 e2e/ 自己造的临时仓库）
 *   - `REAL`     ：其余（你的项目目录）
 *
 * 用法：
 *   node scripts/log-attribution.mjs                 # 全量
 *   node scripts/log-attribution.mjs --recent 30     # 只看最近 30 个会话
 *   node scripts/log-attribution.mjs --root new-api  # 只看某个仓库
 *   node scripts/log-attribution.mjs --json          # 机器可读（给面板/CI 用）
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BS = String.fromCharCode(92);
const HOME = process.env.USERPROFILE || process.env.HOME || homedir();
const LOG = join(HOME, '.graft-max', 'mcp.log');

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const asJson = argv.includes('--json');
const recent = Number(arg('recent', '0')) || 0;
const rootFilter = arg('root', null);

if (!existsSync(LOG)) {
  console.error(`日志不存在：${LOG}\n（GRAFT_MAX_LOG 未开启时不会有这个文件）`);
  process.exit(1);
}

const SANDBOX_RE = /trail-test-run-|gm-v2-|gm-ci-smoke|gm-hotplug|gm-firstbuild|gm-feed-|gm-privacy|graft-mcpsrv|graft-trailname|tmp\.[A-Za-z0-9]|Temp/i;
const isSandbox = (root) => SANDBOX_RE.test(root.split(BS).join('/'));
const tailName = (p) => p.split(BS).join('/').split('/').filter(Boolean).pop() || p;

/** 该仓库是否被"邀请"（有图谱索引 → advertised() 才会给工具）。 */
function invited(root) {
  return (
    existsSync(join(root, 'graft', '.graph', 'wiring.json')) ||
    existsSync(join(root, '.trail', 'cache', '.graph', 'wiring.json')) ||
    existsSync(join(root, '.trail', 'workspace.json'))
  );
}

// ---------------------------------------------------------------------------
// 解析：按"服务启动"切分会话段；段内记录 initialize / tools/list / tools/call
// ---------------------------------------------------------------------------
const BOOT = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.\d+\].*服务启动 === root=(.*?) brainsOnly=(\S+) version=(\S*)? pid=(\d+)/;
const CALL = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.\d+\] --> 工具调用\s+请求id=(\S+)\s+工具=(\S+)/;
const LISTED = /<-- 工具列表返回\s+id=\S+\s*->\s*(.*)$/;

const sessions = [];
let cur = null;
for (const line of readFileSync(LOG, 'utf8').split('\n')) {
  const b = BOOT.exec(line);
  if (b) {
    cur = {
      at: b[1], root: b[2], brainsOnly: b[3], version: b[4] || '(空)', pid: b[5],
      kind: isSandbox(b[2]) ? 'sandbox' : 'REAL',
      initialized: false, listed: [], calls: [], nick: tailName(b[2]),
    };
    sessions.push(cur);
    continue;
  }
  if (!cur) continue;
  if (/<-- 收到请求 initialize/.test(line)) cur.initialized = true;
  const l = LISTED.exec(line);
  if (l) {
    const names = l[1].replace(/（空，仓库未建图）/, '').split(',').map((s) => s.trim()).filter(Boolean);
    if (names.length) cur.listed = names;
  }
  const c = CALL.exec(line);
  if (c) cur.calls.push({ at: c[1], tool: c[3], alias: !c[3].startsWith('max_') });
}

let scoped = sessions;
if (rootFilter) scoped = scoped.filter((s) => s.nick.toLowerCase().includes(String(rootFilter).toLowerCase()));
if (recent > 0) scoped = scoped.slice(-recent);

// ---------------------------------------------------------------------------
// 聚合
// ---------------------------------------------------------------------------
const byRepo = new Map();
for (const s of scoped) {
  const key = `${s.kind}|${s.nick}`;
  const e = byRepo.get(key) || {
    kind: s.kind, repo: s.nick, root: s.root, versions: new Set(), sessions: 0,
    initialized: 0, exposed: 0, exposedMax: 0, calls: 0, aliasCalls: 0, tools: {}, first: s.at, last: s.at,
  };
  e.sessions += 1;
  e.versions.add(s.version);
  if (s.initialized) e.initialized += 1;
  if (s.listed.length) { e.exposed += 1; e.exposedMax = Math.max(e.exposedMax, s.listed.length); }
  e.last = s.at;
  for (const c of s.calls) {
    e.calls += 1;
    if (c.alias) e.aliasCalls += 1;
    e.tools[c.tool] = (e.tools[c.tool] || 0) + 1;
  }
  byRepo.set(key, e);
}

const repos = [...byRepo.values()].sort((a, b) => b.calls - a.calls);
const realCalls = repos.filter((r) => r.kind === 'REAL').reduce((a, r) => a + r.calls, 0);
const sandCalls = repos.filter((r) => r.kind === 'sandbox').reduce((a, r) => a + r.calls, 0);
const aliasTotal = repos.reduce((a, r) => a + r.aliasCalls, 0);

if (asJson) {
  console.log(JSON.stringify({
    logPath: LOG,
    sessions: scoped.length,
    totalCalls: realCalls + sandCalls,
    realCalls, sandboxCalls: sandCalls, aliasCalls: aliasTotal,
    repos: repos.map((r) => ({
      repo: r.repo, kind: r.kind, root: r.root, versions: [...r.versions],
      sessions: r.sessions, initialized: r.initialized,
      exposedSessions: r.exposed, exposedTools: r.exposedMax,
      calls: r.calls, aliasCalls: r.aliasCalls, tools: r.tools, first: r.first, last: r.last,
    })),
  }, null, 2));
  process.exit(0);
}

const fmtTools = (t) => Object.entries(t).sort((a, b) => b[1] - a[1]).map(([n, v]) => `${n}×${v}`).join(' ') || '—';

console.log(`日志：${LOG}`);
console.log(`会话段：${scoped.length} 个${rootFilter ? `（过滤 root≈${rootFilter}）` : ''}`);
console.log(`调用总账：真实仓库 ${realCalls} 次 ｜ 测试沙箱 ${sandCalls} 次 ｜ 其中旧名别名 ${aliasTotal} 次\n`);

for (const kind of ['REAL', 'sandbox']) {
  const list = repos.filter((r) => r.kind === kind && r.sessions > 0);
  if (list.length === 0) continue;
  console.log(kind === 'REAL' ? '=== 真实仓库会话 ===' : '=== 测试/沙箱（test 与 e2e 自造，非真实使用）===');
  for (const r of list) {
    const inv = kind === 'REAL' ? (invited(r.root) ? '已邀请' : '未邀请') : '—';
    console.log(`  ${r.repo.padEnd(22)} ${inv.padEnd(4)} 会话${String(r.sessions).padStart(3)}  暴露${String(r.exposed).padStart(3)}(${r.exposedMax}个)  调用${String(r.calls).padStart(3)}${r.aliasCalls ? `(别名${r.aliasCalls})` : ''}  ${[...r.versions].join(',')}`);
    if (r.calls) console.log(`      ${fmtTools(r.tools)}`);
  }
  console.log('');
}

const zero = repos.filter((r) => r.kind === 'REAL' && r.calls === 0 && r.exposed > 0);
if (zero.length) {
  console.log('=== 注意：这些真实仓库**暴露了工具但一次都没调用** ===');
  for (const r of zero) console.log(`  ${r.repo.padEnd(22)} 会话${r.sessions} 暴露${r.exposedMax}个工具 首次${r.first} 末次${r.last}`);
  console.log('  → 工具是可用的（tools/list 有返回），是会话里没有发起调用。');
  console.log('  → 排查方向：① 该会话是否加载了全局提示词块（~/.claude/CLAUDE.md 的 graft-max:start 段）');
  console.log('              ② 该轮任务是否真的需要代码检索（闲聊/配置类任务不会调）');
  console.log('              ③ 会话是否只是 health check（claude mcp list 会 spawn 一次）');
  console.log('');
}

const aliasSessions = scoped.filter((s) => s.calls.some((c) => c.alias)).slice(-5);
if (aliasSessions.length) {
  console.log('=== 旧名别名调用（graft_*/trail_*，兼容层；最近 5 个会话）===');
  for (const s of aliasSessions) {
    const names = s.calls.filter((c) => c.alias).map((c) => `${c.at.slice(11)} ${c.tool}`);
    console.log(`  ${s.nick} (${s.version}): ${names.join(' | ')}`);
  }
}
