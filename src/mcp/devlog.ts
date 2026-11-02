/**
 * graft-Max dev log v2: rotation + the dashboard's shared store.
 *
 * Rotation (the "never grows forever" rule):
 *   - Size cap: when the active file passes MAX_BYTES it is renamed
 *     mcp.log.1 (yesterday's mcp.log.1, if any, is dropped). Two files,
 *     hard-capped, ~10 MB worst case — predictable disk, no cron needed.
 *   - Age cap: on boot, entries older than RETAIN_DAYS are stripped from
 *     the active file (log lines start with `[YYYY-MM-DD `, cheap to scan).
 *
 * Session registry (the "who is using this" answer):
 *   - Every server boot writes a session row: pid, cwd (the repo it serves),
 *     host pid (the editor/agent that spawned us), user, start time.
 *   - On exit, the row is stamped with end time. Stale rows (pid no longer
 *     alive) are pruned on read, so crashed servers don't haunt the list.
 */
import { appendFile, mkdir, rename, readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const GRAFT_MAX_HOME = join(homedir(), '.graft-max');
export const DEFAULT_LOG = join(GRAFT_MAX_HOME, 'mcp.log');
export const SESSIONS_FILE = join(GRAFT_MAX_HOME, 'sessions.json');

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB per file, two files ≈ 10 MB ceiling
const RETAIN_DAYS = 14;

let enabled = !!process.env.GRAFT_MAX_LOG && process.env.GRAFT_MAX_LOG !== '0';
let target = process.env.GRAFT_MAX_LOG && process.env.GRAFT_MAX_LOG !== '1' ? process.env.GRAFT_MAX_LOG : DEFAULT_LOG;
let ensured = false;

export function isLogEnabled(): boolean {
  return enabled;
}

export function logPath(): string {
  return target;
}

function stamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function clip(s: string, max = 2000): string {
  const one = s.replaceAll('\r', '');
  return one.length <= max ? one : `${one.slice(0, max)}\n… [+${one.length - max} chars]`;
}

/** Rotate when over cap; strip ancient lines on the way. Runs at most once
 * per boot plus after each rotation — not per line (per-line stat() would
 * make logging itself the bottleneck). */
async function rotateIfNeeded(): Promise<void> {
  try {
    if (!existsSync(target)) return;
    const st = await stat(target);
    if (st.size < MAX_BYTES) return;
    const old = `${target}.1`;
    if (existsSync(old)) await unlink(old);
    await rename(target, old);
    dlog(`log rotated at ${st.size} bytes → ${old}`);
  } catch {
    /* rotation failure must never break logging */
  }
}

/** Boot-time age prune: keep the last 14 days of lines. Best-effort. */
async function pruneOldEntries(): Promise<void> {
  try {
    if (!existsSync(target)) return;
    const cutoff = Date.now() - RETAIN_DAYS * 86_400_000;
    const text = await readFile(target, 'utf8');
    const lines = text.split('\n');
    const kept = lines.filter((l) => {
      const m = l.match(/^\[(\d{4}-\d{2}-\d{2}) /);
      if (!m) return true; // non-timestamped lines (block bodies) ride with their header
      return new Date(m[1]).getTime() >= cutoff;
    });
    if (kept.length !== lines.length) await writeFile(target, kept.join('\n'), 'utf8');
  } catch {
    /* pruning is best-effort */
  }
}

async function write(line: string): Promise<void> {
  try {
    if (!ensured) {
      ensured = true;
      await mkdir(dirname(target), { recursive: true });
      void pruneOldEntries();
    }
    await appendFile(target, line + '\n', 'utf8');
    void rotateIfNeeded();
  } catch {
    /* logging never takes the server down */
  }
}


// ---------------------------------------------------------------------------
// [graft-Max] 汉化层：日志行写盘前把已知英文模式替换成中文（开发者友好）。
// 工具名/路径/参数保持原样——只有"动作描述"被翻译，不影响 grep 工具名。
// ---------------------------------------------------------------------------
const I18N: Array<[RegExp, string]> = [
  [/=== graft-Max MCP server boot ===/, '=== graft-Max MCP 服务启动 ==='],
  [/=== graft-Max MCP server exit \(stdin leash: silent 10min\) ===/, '=== graft-Max MCP 服务退出（stdin 沉默10分钟，看门狗触发）==='],
  [/=== graft-Max MCP server exit ===/, '=== graft-Max MCP 服务退出 ==='],
  [/^session registered: pid=(\d+) host=(\d+) root=(.*) version=(.*)$/, '会话注册: pid=$1 宿主pid=$2 仓库=$3 版本=$4'],
  [/^dashboard: (http:\/\/127\.0\.0\.1:\d+) \(tail \/ sessions \/ stats\)$/, '面板已启动: $1 （实时日志 / 会话表 / 统计）'],
  [/^dashboard: port (\d+) busy — UI not started \(MCP unaffected\)$/, '面板端口 $1 被占用 — UI 未启动（MCP 不受影响）'],
  [/^log rotated at (\d+) bytes/, '日志已滚动（超过5MB）: $1 字节'],
  [/^--> tools\/call  id=(\S+)  name=(\S+)$/, '--> 工具调用  请求id=$1  工具=$2'],
  [/^<-- tools\/call \(federated\)/, '<-- 工具返回（联邦）'],
  [/^<-- tools\/call \(graft\)/, '<-- 工具返回（graft）'],
  [/^<-- tools\/list  id=(\S+)  ->  $/, '<-- 工具列表返回  id=$1 ->（空，仓库未建图）'],
  [/^<-- tools\/list  id=(\S+)  ->  /, '<-- 工具列表返回  id=$1 -> '],
  [/^<-- (\S+)  id=(\S+) \(notification\)$/, '<-- 收到 $1  id=$2（通知）'],
  [/^<-- (\S+)  id=(\S+)$/, '<-- 收到请求 $1  id=$2'],
  [/^\[fed\] qmd spawn: /, '[联邦] qmd 子进程启动: '],
  [/^\[fed\] qmd done ok=(\S+) out="(.*)" err="(.*)"$/, '[联邦] qmd 完成 成功=$1 输出="$2" 错误="$3"'],
  [/^\[fed\] gitnexus spawn \(cwd=(.*)\) query="(.*)"$/, '[联邦] gitnexus 子进程启动（仓库=$1）查询="$2"'],
  [/^\[fed\] gitnexus session: /, '[联邦] gitnexus 会话分步: '],
  [/^\[fed\] gitnexus answered /, '[联邦] gitnexus 返回 '],
];
function i18n(line: string): string {
  let out = line;
  for (const [re, rep] of I18N) out = out.replace(re, rep);
  return out;
}

export function dlog(msg: string): void {
  if (!enabled) return;
  void write(`[${stamp()}] ${i18n(msg)}`);
}

export function dlogBlock(title: string, body: string): void {
  if (!enabled) return;
  void write(`[${stamp()}] ${title}\n${clip(body)}\n`);
}

// ---------------------------------------------------------------------------
// Session registry — who is using graft-Max right now
// ---------------------------------------------------------------------------

export interface SessionRow {
  pid: number;
  /** Normalized forward-slash repo path (comparisons are separator-agnostic). */
  cwd: string;
  /** Process id of whoever spawned us (the agent/editor) — "who". */
  hostPid: number | null;
  hostCmd: string;
  user: string;
  startedAt: string;
  endedAt: string | null;
  /** Requests served this session, for the dashboard's activity column. */
  requests: number;
}

function readSessions(): SessionRow[] {
  try {
    return JSON.parse(existsSync(SESSIONS_FILE) ? readFileSync(SESSIONS_FILE, 'utf8') : '[]');
  } catch {
    return [];
  }
}

function writeSessions(rows: SessionRow[]): void {
  try {
    void writeFile(SESSIONS_FILE, JSON.stringify(rows, null, 1), 'utf8');
  } catch {
    /* best effort */
  }
}

/** pid alive? (0 signal probe; works cross-platform without exec) */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Register this server instance. Called once at boot. */
export function registerSession(root: string, version: string): void {
  try {
    const rows = readSessions().filter((r) => r.pid !== process.pid);
    rows.push({
      pid: process.pid,
      cwd: root.split('\\').join('/'),
      hostPid: process.ppid ?? null,
      hostCmd: shortHostCmd(),
      user: process.env.USERNAME ?? process.env.USER ?? 'unknown',
      startedAt: new Date().toISOString(),
      endedAt: null,
      requests: 0,
    });
    mkdirSync(GRAFT_MAX_HOME, { recursive: true });
    writeFileSync(SESSIONS_FILE, JSON.stringify(rows, null, 1), 'utf8');
    dlog(`session registered: pid=${process.pid} host=${process.ppid} root=${root} version=${version}`);
  } catch {
    /* registry is best-effort */
  }
}

function shortHostCmd(): string {
  try {
    return (process.env.COMMAND_LINE ?? process.title ?? '').slice(0, 120);
  } catch {
    return '';
  }
}

/** Count one served request against this session (dashboard activity). */
export function bumpRequests(): void {
  try {
    const rows = readSessions();
    const me = rows.find((r) => r.pid === process.pid);
    if (me) {
      me.requests += 1;
      writeSessions(rows);
    }
  } catch {
    /* best effort */
  }
}

/** Mark this instance ended. Called on stdin close. */
export function endSession(): void {
  try {
    const rows = readSessions();
    const me = rows.find((r) => r.pid === process.pid);
    if (me) {
      me.endedAt = new Date().toISOString();
      writeSessions(rows);
    }
  } catch {
    /* best effort */
  }
}

/** Live sessions for the dashboard: ended rows dropped, dead pids pruned. */
export function liveSessions(): SessionRow[] {
  const rows = readSessions();
  const live = rows.filter((r) => !r.endedAt && alive(r.pid));
  // prune everything not live, write back only when something actually went away
  if (live.length !== rows.length) writeSessions(live);
  return live.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
