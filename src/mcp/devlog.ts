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
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir, userInfo, hostname } from 'node:os';

export const GRAFT_MAX_HOME = join(homedir(), '.graft-max');
export const DEFAULT_LOG = join(GRAFT_MAX_HOME, 'mcp.log');
export const SESSIONS_FILE = join(GRAFT_MAX_HOME, 'sessions.json');

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB per file, two files ≈ 10 MB ceiling
const RETAIN_DAYS = 14;

let enabled = !!process.env.GRAFT_MAX_LOG && process.env.GRAFT_MAX_LOG !== '0';
let target = process.env.GRAFT_MAX_LOG && process.env.GRAFT_MAX_LOG !== '1' ? process.env.GRAFT_MAX_LOG : DEFAULT_LOG;
let ensured = false;
/** [M9] 权限收紧只在每个文件首次写后做一次（进程内记忆，不反复 stat/chmod）。 */
let logPermDone = false;
let sessionsPermDone = false;

/** [M9 · P2] 日志/会话文件权限收紧到 0600（仅 POSIX）。
 * Windows 的 ACL 模型不同（chmod 意义有限），no-op；失败静默——
 * 收紧失败不能拖垮日志与会话注册。 */
export function tightenPerms(path: string): void {
  if (process.platform === 'win32') return;
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
}

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
    // [M9] 首次写入后收紧权限（仅 POSIX；Windows 上 no-op）。失败静默——
    // 权限收紧绝不能拖垮日志本身。
    if (!logPermDone) {
      logPermDone = true;
      tightenPerms(target);
    }
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
  // [P3-3] 已删除两条死规则（`<-- tools/call (federated)` / `<-- tools/call (graft)`）：
  // server.ts 早就在 dlog 里直接输出中文（`<-- 工具返回（联邦）…`），这两条正则永远匹配不到，
  // 留着只会让后来者误以为英文日志还会走这里。真实行→替换行为的断言见 test/devlog-i18n.test.ts。
  [/^<-- tools\/list  id=(\S+)  ->  $/, '<-- 工具列表返回  id=$1 ->（空，仓库未建图）'],
  [/^<-- tools\/list  id=(\S+)  ->  /, '<-- 工具列表返回  id=$1 -> '],
  [/^<-- (\S+)  id=(\S+) \(notification\)$/, '<-- 收到 $1  id=$2（通知）'],
  [/^<-- (\S+)  id=(\S+)$/, '<-- 收到请求 $1  id=$2'],
  [/^\[fed\] qmd spawn: /, '[联邦] qmd 子进程启动: '],
  [/^\[fed\] qmd done ok=(\S+) out="(.*)" err="(.*)"$/, '[联邦] qmd 完成 成功=$1 输出="$2" 错误="$3"'],
  [/^\[fed\] gitnexus spawn \(cwd=(.*)\) query="(.*)"$/, '[联邦] gitnexus 子进程启动（仓库=$1）查询="$2"'],
  [/^\[fed\] gitnexus session: /, '[联邦] gitnexus 会话分步: '],
  // [P3-3 续] 这两条是"快路径真的生效了"的证据行，之前一直是英文，日志读起来两套语言。
  [/^\[fed-qmd\] in-process store ready \((.*)\) in (\d+)ms$/, '[联邦-qmd] 进程内文档库就绪（$1）耗时 $2ms'],
  [/^\[fed\] gitnexus session ready in (\d+)ms$/, '[联邦] gitnexus 常驻会话就绪 $1ms'],
  [/^\[fed\] gitnexus answered /, '[联邦] gitnexus 返回 '],
];
function i18n(line: string): string {
  let out = line;
  for (const [re, rep] of I18N) out = out.replace(re, rep);
  return out;
}

// ---------------------------------------------------------------------------
// [M8 · P1] 日志脱敏。
//
// 为什么必须有：`/tail` 把 mcp.log 原文吐给浏览器（面板默认免令牌=本机任何页面
// 都能 fetch），而日志里记的是**工具的完整入参与输出原文**——任何进过一次调用的
// API key / token 就会永远躺在盘上、且可被网页读取。
//
// 红线（三选一的保守策略）：
//   1. 只匹配**明显密钥形态**（有已知前缀/长度约束），绝不碰普通代码、路径、
//      短串——误伤会毁掉日志的排障价值，比泄密更常发生；
//   2. 掩码保留**前 4 字符**，人工比对"是哪把钥匙泄露过"仍然可行；
//   3. `GRAFT_MAX_LOG_REDACT=0` 一键关（排障时确实需要看原文）。
// ---------------------------------------------------------------------------

/** 掩码是否启用（默认开；GRAFT_MAX_LOG_REDACT=0 关）。进程内缓存。 */
let redactOn: boolean | null = null;
function redactionEnabled(): boolean {
  if (redactOn === null) {
    const v = process.env.GRAFT_MAX_LOG_REDACT;
    redactOn = !(v === '0' || v === 'false');
  }
  return redactOn;
}

const REDACT_RULES: Array<[RegExp, (m: string, groups: string[]) => string]> = [
  // OpenAI / Anthropic 风格：sk- 前缀 + ≥16 个 [A-Za-z0-9_-]
  [/\bsk-[A-Za-z0-9_-]{16,}/g, (m) => `${m.slice(0, 4)}***`],
  // GitHub: ghp_ / gho_ / ghs_ / ghu_
  [/\bgh[posu]_[A-Za-z0-9]{16,}/g, (m) => `${m.slice(0, 4)}***`],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, (m) => `${m.slice(0, 11)}***`],
  // AWS access key id
  [/\bAKIA[0-9A-Z]{16}\b/g, (m) => `${m.slice(0, 4)}***`],
  // Slack: xox[baprs]-…
  [/\bxox[baprs]-[A-Za-z0-9-]{20,}/g, (m) => `${m.slice(0, 4)}***`],
  // Bearer 头
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g, (m) => `${m.slice(0, 10)}***`],
  // 键值对：api_key=/token:/password= …值为 ≥10 的连续串（键名不区分大小写）
  [/\b(api[_-]?key|apikey|token|secret|password|passwd|pwd)(\s*[:=]\s*)["']?([A-Za-z0-9._~+/=-]{10,})/gi,
    (m, g) => `${g[0]}${g[1]}${g[2].slice(0, 4)}***`],
];

/** 掩码一个字符串。永不 throw；已含 *** 的串原样返回（幂等）。 */
export function redact(text: string): string {
  if (!redactionEnabled()) return text;
  if (text.includes('***')) return text;
  let out = text;
  for (const [re, rep] of REDACT_RULES) {
    out = out.replace(re, (...args: unknown[]) => {
      const m = args[0] as string;
      const groups = args.slice(1, -2).map((x) => (typeof x === 'string' ? x : ''));
      try {
        return rep(m, groups);
      } catch {
        return m; // 规则自身的错误不放大成日志层的故障
      }
    });
  }
  return out;
}

export function __resetRedactCacheForTest(): void {
  redactOn = null;
}

export function dlog(msg: string): void {
  if (!enabled) return;
  void write(`[${stamp()}] ${redact(i18n(msg))}`);
}

export function dlogBlock(title: string, body: string): void {
  if (!enabled) return;
  // [P3-3 根因] 这里**必须**走 i18n(title)：历史上 dlogBlock 只拼字符串、从不翻译，
  // 于是 `--> tools/call …` / `<-- tools/call (graft) …` 这些标题永远是英文，
  // 而对应的 I18N 规则看起来"永远匹配不上"，被误判成死代码删掉。
  // body 是工具原始输出，**不翻译**（翻译代码片段会毁掉可读性与可复制性）。
  // [M8] 标题与 body 都过脱敏：只掩密钥形态的串，代码/路径/结构原样（可 grep 可复制）。
  void write(`[${stamp()}] ${redact(i18n(title))}\n${clip(redact(body))}\n`);
}

// ---------------------------------------------------------------------------
// Session registry — who is using graft-Max right now
// ---------------------------------------------------------------------------

export interface SessionRow {
  pid: number;
  /** [Docker] 容器里每个进程都是 pid 1 —— 只用 pid 做身份会让多容器互相覆盖，
   * 所以身份是 host+pid；host 取 os.hostname()（Docker 默认=容器短 ID）。 */
  host?: string;
  /** 最近一次活动时间（工具调用时刷新）。跨容器无法用 kill(pid,0) 探活，
   * 改用这个时间戳判活。 */
  lastSeen?: string;
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


/** 本机（容器）标识：Docker 默认把容器短 ID 设为 hostname，宿主则是机器名。 */
function myHost(): string {
  try { return hostname(); } catch { return 'unknown'; }
}
const myselfId = (): string => myHost() + ':' + process.pid;
/** 跨容器判活窗口：别的 host 的会话拿不到它的 pid，只能靠 lastSeen 新鲜度。 */
const REMOTE_STALE_MS = 3 * 60_000;
/** 已结束行保留时长与条数上限（保留一点历史便于排查，但不能无限长）。 */
const ENDED_RETAIN_MS = 60 * 60_000;
const ENDED_KEEP_MAX = 20;
/** 请求计数的落盘节流窗口（P1-5/P3-13：不要每次工具调用都同步读改写）。 */
const BUMP_THROTTLE_MS = 2_000;

/**
 * [P1-5] 本会话的行：身份是 **host + pid**，不是裸 pid。
 * 容器里每个进程都是 pid 1 —— 只按 pid 找会串行改到别的容器的行
 * （A 的调用给 B 的行 +1、A 退出把 B 标成 ended）。touchSession/liveSessions
 * 早已改成 host+pid，这里是剩下两处（bumpRequests/endSession）的封口。
 */
function myRow(rows: SessionRow[]): SessionRow | undefined {
  const me = myHost();
  return rows.find((r) => (r.host ?? me) === me && r.pid === process.pid);
}

/** 清理死行：同 host 用 pid 探活，跨 host 用 lastSeen 新鲜度；ended 行按时间/条数截断。 */
function pruneDeadRows(rows: SessionRow[]): SessionRow[] {
  const me = myHost();
  const now = Date.now();
  const kept: SessionRow[] = [];
  for (const r of rows) {
    const sameHost = (r.host ?? me) === me;
    if (sameHost && r.pid === process.pid) {
      kept.push(r); // 自己永远保留（哪怕窗口刚过期，也由 touchSession 刷新）
      continue;
    }
    if (r.endedAt) {
      const t = Date.parse(r.endedAt);
      if (Number.isFinite(t) && now - t < ENDED_RETAIN_MS) kept.push(r);
      continue;
    }
    if (sameHost) {
      if (alive(r.pid)) kept.push(r);
      continue;
    }
    const t = Date.parse(r.lastSeen ?? r.startedAt ?? '');
    if (Number.isFinite(t) && now - t < REMOTE_STALE_MS) kept.push(r);
  }
  const ended = kept.filter((r) => r.endedAt).sort((a, b) => Date.parse(b.endedAt as string) - Date.parse(a.endedAt as string));
  if (ended.length <= ENDED_KEEP_MAX) return kept;
  const drop = new Set(ended.slice(ENDED_KEEP_MAX));
  return kept.filter((r) => !drop.has(r));
}

let lastTouch = 0;
let registeredRoot: string | null = null;
/** 工具调用时刷新本会话的 lastSeen（20s 节流，避免每次调用都写盘）。 */
export function touchSession(): void {
  const now = Date.now();
  if (now - lastTouch < 20_000) return;
  lastTouch = now;
  try {
    const me = myHost();
    const rows = readSessions();
    const mine = rows.find((r) => (r.host ?? me) === me && r.pid === process.pid);
    if (!mine) {
      // 行被别的 host 按 lastSeen 剪掉了（本进程空闲超过判活窗口）→ 重建，避免"复活不了"
      if (!registeredRoot) return;
      const fresh: SessionRow = {
        pid: process.pid, host: me, cwd: registeredRoot.split(String.fromCharCode(92)).join('/'),
        hostPid: process.ppid ?? null, hostCmd: shortHostCmd(),
        user: process.env.USERNAME ?? process.env.USER ?? (() => { try { return userInfo().username || 'unknown'; } catch { return 'unknown'; } })(),
        startedAt: new Date(now).toISOString(), endedAt: null, requests: 0,
        lastSeen: new Date(now).toISOString(),
      };
      writeSessions([...rows, fresh]);
      return;
    }
    mine.lastSeen = new Date(now).toISOString();
    writeSessions(rows);
  } catch {/* best effort */}
}

function readSessions(): SessionRow[] {
  try {
    const raw = existsSync(SESSIONS_FILE) ? readFileSync(SESSIONS_FILE, 'utf8') : '[]';
    return JSON.parse(raw || '[]');
  } catch {
    return []; // 坏文件：视为空，下一次写会原子重建
  }
}

function writeSessions(rows: SessionRow[]): void {
  try {
    // [P3-5] 自净挪到**写路径**：读路径（liveSessions）只过滤不落盘，否则面板每 2s
    // 轮询都会触发一次写，把只读接口变成写接口。
    // [graft-Max] 同步原子写：多 server 并发 bump 时，async writeFile 交错会把
    // 文件截成 0 字节（实测发生过）。writeFileSync + 同目录 tmp + rename 原子替换。
    const clean = pruneDeadRows(rows);
    // [Critic C1] 临时文件名必须**每写一次都不同**：固定 `sessions.json.tmp` 时，
    // 两个进程并发写会互相覆盖/互相 rename 对方的半成品（A 的 rename 可能拿到 B 写了一半的
    // 内容）。pid + 随机后缀让每个写者只可能 rename 自己的 tmp。
    const tmp = `${SESSIONS_FILE}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(clean, null, 1), 'utf8');
    // [M9] tmp 先收紧再 rename，保证最终文件就是 0600（rename 保留 tmp 的 mode）
    tightenPerms(tmp);
    renameSync(tmp, SESSIONS_FILE);
    if (!sessionsPermDone) {
      sessionsPermDone = true;
      tightenPerms(SESSIONS_FILE);
    }
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
  registeredRoot = root;
  try {
    const me = myselfId();
    const rows = readSessions().filter((r) => `${r.host ?? me}` + ':' + r.pid !== me);
    rows.push({
      pid: process.pid,
      cwd: root.split('\\').join('/'),
      hostPid: process.ppid ?? null,
      hostCmd: shortHostCmd(),
      // [Docker] Linux 容器里没有 USERNAME/USER 环境变量（除特别 ENV），
      // 退到 os.userInfo() 才拿得到 'node'，否则面板永远显示 unknown。
      user: process.env.USERNAME ?? process.env.USER ?? (() => {
        try { return userInfo().username || 'unknown'; } catch { return 'unknown'; }
      })(),
      startedAt: new Date().toISOString(),
      endedAt: null,
      requests: 0,
      host: myHost(),
      lastSeen: new Date().toISOString(),
    });
    mkdirSync(GRAFT_MAX_HOME, { recursive: true });
    // [N4] 与其它写路径统一：原子替换 + 顺带自净死行。
    writeSessions(rows);
    dlog(`session registered: pid=${process.pid} host=${process.ppid} root=${root} version=${version}`);
  } catch {
    /* registry is best-effort */
  }
}

function shortHostCmd(): string {
  // [M10 · P2] 隐私：sessions.json 会被面板 /sessions 展示，完整命令行可能带
  // 密钥参数（--token=…）、内网路径。只保留**可执行文件名**：
  //   - Windows 路径常含空格且整体带引号 → 优先取首引号段；
  //   - 否则按空格取第一个 token，再取 basename（吃掉路径前缀）。
  // 长度截 60，足够放 "python3.11.exe" / "Code.exe" 这类名字。
  try {
    const cmdline = process.env.COMMAND_LINE ?? process.title ?? '';
    let first: string;
    const q = cmdline.match(/^"([^"]+)"/);
    if (q) first = q[1];
    else first = cmdline.trim().split(/\s+/)[0] ?? '';
    return basename(first).slice(0, 60);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// [N4] 请求计数：内存累加 + 2s 节流落盘
//
// 原实现每次 tools/call 都 `readSessions()` + `writeFileSync()`（实测 1.08ms/轮），
// 在热路径上做无界同步 IO（项目约束 C3 禁止）。现在计数先进内存，最多每 2s
// 落盘一次；`flushPendingBumps()` 在会话结束/退出时兜底，保证尾巴不丢。
// ---------------------------------------------------------------------------
let pendingBumps = 0;
let bumpTimer: ReturnType<typeof setTimeout> | null = null;

/** Count one served request against this session (dashboard activity) — buffered. */
export function bumpRequests(): void {
  pendingBumps += 1;
  if (bumpTimer) return;
  bumpTimer = setTimeout(() => {
    bumpTimer = null;
    flushPendingBumps();
  }, BUMP_THROTTLE_MS);
  // 不因这个定时器阻止进程退出（真退出路径会显式 flush）
  (bumpTimer as unknown as { unref?: () => void }).unref?.();
}

/** 把内存里积攒的请求数写进本会话那一行（host+pid 定位）。返回是否真的写了盘。 */
export function flushPendingBumps(): boolean {
  if (pendingBumps === 0) return false;
  const n = pendingBumps;
  pendingBumps = 0;
  try {
    const rows = readSessions();
    const me = myRow(rows);
    if (!me) return false;
    me.requests += n;
    writeSessions(rows);
    return true;
  } catch {
    return false;
  }
}

/** Mark this instance ended. Called on stdin close. */
export function endSession(): void {
  try {
    flushPendingBumps(); // 先把尾巴的请求数落下来，再标结束
    const rows = readSessions();
    const me = myRow(rows);
    if (me) {
      me.endedAt = new Date().toISOString();
      writeSessions(rows);
    }
  } catch {
    /* best effort */
  }
}

/** Live sessions for the dashboard: ended rows dropped, dead pids pruned.
 * [P3-5] 纯读：过滤在内存里做，落盘自净交给写路径（writeSessions → pruneDeadRows）。 */
export function liveSessions(): SessionRow[] {
  const rows = readSessions();
  const me = myHost();
  const now = Date.now();
  // [Docker] 同一 host 才能用 kill(pid,0) 探活；别的容器（host 不同）靠 lastSeen 新鲜度，
  // 否则容器里"pid 1 永远活着"会把别的容器的死会话永远显示成 LIVE。
  const isLive = (r: SessionRow): boolean => {
    if (r.endedAt) return false;
    if ((r.host ?? me) === me) return alive(r.pid);
    const t = Date.parse(r.lastSeen ?? r.startedAt ?? '');
    return Number.isFinite(t) && now - t < REMOTE_STALE_MS;
  };
  return rows.filter(isLive).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
