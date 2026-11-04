/**
 * graft-Max developer dashboard: a tiny local web UI over the dev log and
 * the session registry. Opt-in via GRAFT_MAX_UI=1 (or PORT), default off —
 * same philosophy as the log itself: never on for a user who didn't ask.
 *
 *   GET /            — single-file HTML: tail (poll /tail), sessions table
 *   GET /tail?n=200  — last n log lines as plain text (default 200, max 2000)
 *   GET /sessions    — live sessions JSON (pid/who/repo/requests/started)
 *   GET /stats       — one-line summary: log size, rotation state, sessions
 *
 * Binds 127.0.0.1 by default (never a network face); GRAFT_MAX_UI_HOST can
 * move it to 0.0.0.0 for container port-forwarding. Port default 24688,
 * chosen away from serena's 24282 and other local dashboards. Port conflict
 * is a soft failure: the server logs the miss and keeps serving MCP — the
 * dashboard is a convenience, not a dependency.
 *
 * [N1 · 安全硬化] 两种形态的安全边界是显式的，不是"默认就安全"：
 *   - Host 校验（防 DNS rebinding）：只认回环名 / 绑定地址本身 / 本机 hostname。
 *   - 令牌鉴权（仅数据端点）：非回环绑定**强制**开启，令牌自动生成并只打到
 *     stderr（devlog 会进 mcp.log，而 mcp.log 面板自己能读 → 不写令牌）。
 *     回环绑定默认关闭，GRAFT_MAX_UI_TOKEN=<值> 可显式打开，=0 显式关掉。
 *   - GET /?token=<t> 会把令牌种成 Cookie（HttpOnly/SameSite=Strict），
 *     所以点一次带令牌的 URL，之后的前端轮询自动带凭据，前端 JS 无需改动。
 *   - /healthz 是无鉴权、无数据的探活端点（容器 healthcheck 打它）。
 *   - 所有响应带 nosniff / Referrer-Policy / X-Frame-Options / 最小 CSP。
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile, stat, open, readdir } from 'node:fs/promises';
import { dlog, logPath, liveSessions, SESSIONS_FILE, GRAFT_MAX_HOME, type SessionRow } from './devlog.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
// [N8] 旧版内联页面：仅作兼容回退（GRAFT_MAX_UI_LEGACY=1 或 dist/panel 缺失）。
import { legacyPage } from './panel-legacy.js';
// [N9/N12] 联邦后端健康度：面板"联邦后端"卡的数据源。
import { fedBackendHealth, getFedCacheStats, reprobeBackends, type FedBackendHealth } from './federation.js';
// [N13/N14] 建图状态（子进程拥有 building.json，这里只读）。
import { buildingStatus, type BuildingStatus } from '../graph/refresh.js';
// [N14] 索引新鲜度：图谱指纹 vs 工作区。
import { probeDrift, isClean, type Drift } from '../graph/fingerprint.js';
import { readStats } from '../util/state.js';
import { mapDirFor } from '../context/map-dir.js';

const DEFAULT_PORT = 24688;

/* ------------------------------------------------------------------ *
 * [N1 · 安全硬化] Host 校验 / 令牌鉴权 / 安全响应头
 * 下面几个函数是纯的（不碰 IO），单测直接 import 断言它们，不必起 server。
 * ------------------------------------------------------------------ */

/** 回环名白名单：容器 healthcheck 固定打 http://127.0.0.1:PORT，所以
 * 127.0.0.1 必须永远放行，否则令牌形态下容器会 unhealthy。 */
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** 去掉 Host 头里的端口，返回"纯主机名"。`[::1]:24688` → `[::1]`。 */
export function hostOnly(hostHeader: string | undefined | null): string {
  const h = (hostHeader ?? '').trim().toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? h : h.slice(0, end + 1); // 保留方括号：'[::1]'
  }
  const first = h.indexOf(':');
  if (first === -1) return h; // 'localhost'
  if (h.indexOf(':', first + 1) !== -1) return h; // 裸 IPv6（'::1'），无端口可去
  return h.slice(0, first); // 'example.com:24688'
}

/** 绑定地址是否是回环。`127.x.x.x` / `localhost` / `::1` 都算。 */
export function isLoopbackBind(bindHost: string | undefined | null): boolean {
  const b = (bindHost ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!b) return true; // 缺省即 127.0.0.1
  return b === 'localhost' || b === '::1' || b === '0:0:0:0:0:0:0:1' || /^127\./.test(b);
}

/**
 * Host 头白名单（防 DNS rebinding：攻击者域名解析到 127.0.0.1 后，浏览器
 * 会带 `Host: evil.example.com` 打本机端口，这条校验把它挡在 403）。
 * 允许：回环名；非回环绑定时再加绑定地址本身与 os.hostname()。
 */
export function hostAllowed(hostHeader: string | undefined | null, bindHost: string): boolean {
  const h = hostOnly(hostHeader);
  if (!h) return false; // HTTP/1.1 必须有 Host；浏览器/curl 都会带
  if (LOOPBACK_NAMES.has(h)) return true;
  const bare = h.replace(/^\[|\]$/g, '');
  if (LOOPBACK_NAMES.has(bare)) return true;
  if (isLoopbackBind(bindHost)) return false;
  const bind = (bindHost ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === bind || bare === bind) return true;
  try {
    if (h === hostname().trim().toLowerCase()) return true;
  } catch {/* hostname() 失败不影响判定 */}
  return false;
}

export interface TokenPolicy {
  /** 是否校验令牌 */
  required: boolean;
  /** 生效的令牌；required=false 时为 null */
  token: string | null;
  /** 令牌是不是本次启动随机生成的 */
  generated: boolean;
  /** 非回环绑定时用户写了 GRAFT_MAX_UI_TOKEN=0（想关），被强制忽略 */
  forcedWarn: boolean;
}

/**
 * 令牌策略（进程启动时算一次，全程不变）：
 *   - 非回环绑定（0.0.0.0 等）→ **强制**要求令牌；没显式给就随机生成。
 *   - 回环绑定 → 默认不要求；显式给非 0 非空值才启用；=0 显式关闭。
 */
export function resolveTokenPolicy(bindHost: string, rawEnv: string | undefined = process.env.GRAFT_MAX_UI_TOKEN): TokenPolicy {
  const raw = (rawEnv ?? '').trim();
  const gen = (forcedWarn: boolean): TokenPolicy => ({
    required: true,
    token: randomBytes(16).toString('hex'),
    generated: true,
    forcedWarn,
  });
  if (!isLoopbackBind(bindHost)) {
    if (raw === '0') return gen(true); // 非回环形态下"关令牌"无效
    if (raw) return { required: true, token: raw, generated: false, forcedWarn: false };
    return gen(false);
  }
  if (!raw || raw === '0') return { required: false, token: null, generated: false, forcedWarn: false };
  return { required: true, token: raw, generated: false, forcedWarn: false };
}

const TOKEN_COOKIE = 'gm_ui';

/** 常量时间比较；长度不同直接返回 false（timingSafeEqual 长度不等会 throw）。 */
export function tokenMatches(presented: string | null | undefined, token: string | null | undefined): boolean {
  if (!presented || !token) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(token, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** 三种携带方式：`Authorization: Bearer <t>` / `?token=<t>` / Cookie `gm_ui=<t>`。 */
export function extractToken(
  headers: { authorization?: string | string[]; cookie?: string | string[] },
  urlToken?: string | null,
): string | null {
  const q = (urlToken ?? '').trim();
  if (q) return q;
  const auth = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization;
  const m = /^Bearer\s+(\S+)$/i.exec((auth ?? '').trim());
  if (m) return m[1];
  const rawCookie = Array.isArray(headers.cookie) ? headers.cookie.join('; ') : headers.cookie;
  for (const part of (rawCookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== TOKEN_COOKIE) continue;
    const v = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return null;
}

/** 所有响应都带的基础安全头。页面是内联 <style>/<script>，所以 style/script
 * 必须留 'unsafe-inline'，否则整页白屏；其余一律收紧到 'self'。 */
const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
};

/** 需要令牌的数据端点。`/`（页面）、`/healthz`（探活）、`/favicon.ico`（静态）不校验。 */
const AUTH_ENDPOINTS = new Set(['/tail', '/sessions', '/stats', '/storage', '/fresh', '/reprobe']);

/** 明文拒绝（不返回 JSON：避免中间层把错误当数据渲染，也便于 curl 肉眼确认）。 */
function deny(res: ServerResponse, code: number, body: string): void {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

/** Last n lines of the (possibly large) log, reading backwards in chunks so
 * we never load the whole file to answer a tail. */
async function tailLines(n: number): Promise<string[]> {
  try {
    const fh = await open(logPath(), 'r');
    try {
      const st = await fh.stat();
      if (st.size === 0) return [];
      const CHUNK = 64 * 1024;
      let buf = Buffer.alloc(0);
      let pos = st.size;
      while (pos > 0 && buf.length < n * 256 && st.size - pos < st.size + CHUNK) {
        const step = Math.min(CHUNK, pos);
        pos -= step;
        const chunk = Buffer.alloc(step);
        await fh.read(chunk, 0, step, pos);
        buf = Buffer.concat([chunk, buf]);
        // early stop: enough complete lines
        if (buf.toString('utf8').split('\n').length >= n + 1 && buf[0] !== 0x0a) {
          // may be mid-line; keep reading a bit more only if boundary unclear
        }
        if (buf.toString('utf8').split('\n').length >= n + 1) break;
      }
      const lines = buf.toString('utf8').split('\n');
      return lines.slice(-n - 1, -1); // last line is usually empty (trailing \n)
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
}

/** [graft-Max T9 + N9] per-tool 调用次数 + 耗时分位，解析日志尾部。
 * 日志行形如 `<-- 工具返回…  <name>  123ms  isError=true`（server.ts dlogBlock）。
 * max.9 的视觉重做把这张卡在前端弄丢了，服务端却一直在付费计算 —— N9 把它补回来，
 * 并升级成 p50/p95（只有平均值看不出长尾，而长尾才是 agent 卡顿的真凶）。
 * 只读最后 800 行（≈256KB），2s 缓存，成本是平的。 */
const TOOLSTATS_TTL_MS = 2000;
interface ToolStat {
  calls: number;
  avgMs: number;
  p50: number;
  p95: number;
  errors: number;
}
let toolStatsCache: { at: number; v: Record<string, ToolStat> } | null = null;

/** 最近秩法分位（p=50/95）：给定已排序数组，取第 ceil(p/100·n) 个。
 * 样本少时退化为最大值——一个调用也能给出数，不会返回 NaN。 */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx];
}

async function toolStats(): Promise<Record<string, ToolStat>> {
  // [压测修复] 每次 /stats 都读 800 行日志解析，50 并发下 p50 67ms；2s 缓存足够
  if (toolStatsCache && Date.now() - toolStatsCache.at < TOOLSTATS_TTL_MS) return toolStatsCache.v;
  const lines = await tailLines(800);
  const per = new Map<string, { durs: number[]; errors: number }>();
  for (const line of lines) {
    const m = /<--\s+(?:工具返回|tools\/call).*?\s(\S+)\s+(\d+)ms\s+isError=(true|false)/.exec(line);
    if (!m) continue;
    // normalize across spellings (max_/graft_/trail_/legacy aliases) so one
    // tool's calls aggregate on one row
    const name = m[1].replace(/^(max_|graft_|trail_)/, '').replace(/^ask$/, 'find_code');
    const e = per.get(name) ?? { durs: [], errors: 0 };
    e.durs.push(Number(m[2]));
    if (m[3] === 'true') e.errors++;
    per.set(name, e);
  }
  const out: Record<string, ToolStat> = {};
  for (const [name, e] of per) {
    const sorted = [...e.durs].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    out[name] = {
      calls: sorted.length,
      avgMs: Math.round(sum / sorted.length),
      p50: Math.round(percentile(sorted, 50)),
      p95: Math.round(percentile(sorted, 95)),
      errors: e.errors,
    };
  }
  toolStatsCache = { at: Date.now(), v: out };
  return out;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** [graft-Max T9.2] Storage view: every artifact this tool writes, with its
 * absolute path and on-disk size (directories measured with one recursive
 * walk, depth-capped). Feeds the 存储/产物 card so "where is my data and how
 * big is it" is answerable from the panel without opening a terminal. */
interface StorageEntry { label: string; path: string; bytes: number; kind: 'file' | 'dir'; exists: boolean }

/**
 * 目录大小。**异步**遍历：同步版实测把 60MB 的 .cocoindex_code 走一遍要 3 秒，
 * 期间整个面板事件循环被卡死（压测：/storage p50 3201ms、/tail 同请求排队）。
 * 深度上限 6 挡住符号链接环；文件数上限挡住病态目录。
 */
const DIR_WALK_MAX_FILES = 50_000;
async function dirSize(dir: string, depth = 0, budget = { n: DIR_WALK_MAX_FILES }): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (budget.n-- <= 0) break;
    const p = join(dir, e.name);
    try {
      if (e.isDirectory()) {
        // depth cap: graph dirs are shallow; anything deeper is not ours
        if (depth < 6) total += await dirSize(p, depth + 1, budget);
      } else if (e.isFile()) {
        total += (await stat(p)).size;
      }
    } catch {/* raced delete / permission — skip the entry */}
  }
  return total;
}

/** [压测修复] 产物统计结果短缓存：30s 内复用，并把并发请求合并成一次遍历
 * （面板每 30s 轮询 + 多个会话/标签页同时打开时，不再各自走一遍目录）。 */
const STORAGE_TTL_MS = 30_000;
// [N11] 按 root 分桶：多仓库时一张面板要遍历 N 个仓库，单槽缓存会让每个请求都
// 全部重算（实测 3 个仓库时 /storage 从 4ms 退化到 3 次遍历）。分桶后每个仓库
// 各自 30s 缓存 + 各自 inflight 合并。
const storageCache = new Map<string, { at: number; entries: StorageEntry[] }>();
const storageInflight = new Map<string, Promise<StorageEntry[]>>();

async function storageEntries(root: string): Promise<StorageEntry[]> {
  // 命中 30s 缓存；并发请求共享同一次遍历（压测：无缓存时 p50 3.2s，且堵住事件循环）
  const hit = storageCache.get(root);
  if (hit && Date.now() - hit.at < STORAGE_TTL_MS) return hit.entries;
  const flying = storageInflight.get(root);
  if (flying) return flying;
  const p = collectStorage(root).finally(() => {
    storageInflight.delete(root);
  });
  storageInflight.set(root, p);
  const entries = await p;
  storageCache.set(root, { at: Date.now(), entries });
  // 缓存条目上限：仓库数上限就是活跃会话数，但死会话可能残留路径 → 兜一个上限
  if (storageCache.size > 16) {
    const oldest = [...storageCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) storageCache.delete(oldest[0]);
  }
  return entries;
}

async function collectStorage(root: string): Promise<StorageEntry[]> {
  const trailHome = process.env.TRAIL_HOME ?? join(homedir(), '.trail');
  const cacheDir = process.env.XDG_CACHE_HOME
    ? join(process.env.XDG_CACHE_HOME, 'qmd')
    : join(homedir(), '.cache', 'qmd');
  const candidate: Array<[label: string, path: string, kind: StorageEntry['kind']]> = [
    ['开发者日志（滚动 5MB）', logPath(), 'file'],
    ['会话注册表', SESSIONS_FILE, 'file'],
    ['Trail 全局状态（learnings/sessions）', trailHome, 'dir'],
    ['graft-Max 主目录', GRAFT_MAX_HOME, 'dir'],
    // [需求补全] 用户点名的"数据库 DB"：max_find_docs 的 BM25 库就是这份 SQLite
    ['qmd 文档索引数据库（SQLite + WAL）', join(cacheDir, 'index.sqlite'), 'file'],    ['qmd 嵌入模型缓存', join(cacheDir, 'models'), 'dir'],
  ];
  // per-repo artifacts for the repo this server serves
  const repo: Array<[label: string, path: string, kind: StorageEntry['kind']]> = [
    ['本仓库图谱 graft/（节点+缓存）', join(root, 'graft'), 'dir'],
    ['本仓库 Trail 状态 .trail/', join(root, '.trail'), 'dir'],
    ['本仓库语义索引 .cocoindex_code/', join(root, '.cocoindex_code'), 'dir'],
    // [需求补全] max_trace_arch 的架构图索引（gitnexus analyze 产物）
    ['本仓库架构图索引 .gitnexus/', join(root, '.gitnexus'), 'dir'],
  ];
  const out: StorageEntry[] = [];
  for (const [label, p, kind] of [...candidate, ...repo]) {
    let bytes = 0;
    let exists = false;
    try {
      bytes = kind === 'dir' ? await dirSize(p) : (await stat(p)).size;
      exists = true;
      // [review r4] SQLite 伴生文件（-wal/-shm）常占大头，一并计入
      if (kind === 'file' && p.endsWith('.sqlite')) {
        for (const side of ['-wal', '-shm']) {
          try { bytes += (await stat(p + side)).size; } catch {/* no sidecar */}
        }
      }
    } catch {/* absent — still listed, marked 未创建 */}
    out.push({ label: label.trim(), path: p, bytes, kind, exists });
  }
  return out;
}

function human(bytes: number): string {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

/**
 * 面板标题里的版本号。本模块在 dist/mcp/ 比 dist/cli.js 深一层，
 * cli-meta 的 readCurrentVersion 只按后者形状找，所以这里自己向上找
 * package.json（最多 3 级），失败退回 'dev'。
 */
let cachedVersion: string | null = null;
function panelVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 3; i++) {
      const pkg = join(dir, 'package.json');
      if (existsSync(pkg)) {
        const v = (JSON.parse(readFileSync(pkg, 'utf8')) as { version?: string }).version;
        if (v) { cachedVersion = v; return v; }
      }
      dir = dirname(dir);
    }
  } catch {/* fall through */}
  cachedVersion = 'dev';
  return cachedVersion;
}

// ---------------------------------------------------------------------------
// [N8] 面板资源：dist/panel/{index.html,app.js,style.css}
// 由 `scripts/build-panel.mjs` 从 `panel/` 构建（esbuild，零运行时依赖）。
// ---------------------------------------------------------------------------
const PANEL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'panel');
let panelHtmlCache: string | null = null;
let panelWarned = false;

/** 面板是否回退到旧版内联页：显式开关，或 dist/panel 还没构建（从 src 跑测试时）。 */
export function panelUsesLegacy(): boolean {
  if (process.env.GRAFT_MAX_UI_LEGACY === '1') return true;
  return !existsSync(join(PANEL_DIR, 'index.html'));
}

/** 读面板静态资源；缺失返回 null。index.html 只读一次（启动即缓存）。 */
function readPanelAsset(name: 'index.html' | 'app.js' | 'style.css'): string | null {
  if (name === 'index.html' && panelHtmlCache !== null) return panelHtmlCache;
  try {
    const body = readFileSync(join(PANEL_DIR, name), 'utf8');
    if (name === 'index.html') panelHtmlCache = body;
    return body;
  } catch {
    if (!panelWarned && name === 'index.html') {
      panelWarned = true;
      dlog('dashboard: dist/panel 缺失（前端未构建），回退旧版内联页面；npm run build:panel 可生成新面板');
    }
    return null;
  }
}

/** 面板 HTML：新工程优先，缺失/显式回退时用 max.9 的内联版。 */
function page(port = DEFAULT_PORT): string {
  if (!panelUsesLegacy()) {
    const html = readPanelAsset('index.html');
    if (html !== null) return html;
  }
  return legacyPage(port, panelVersion());
}

// ---------------------------------------------------------------------------
// [N11] 多仓库：一张面板认识"所有活着的仓库"，而不只是自己被启动时的那一个。
//
// 每个仓库的 MCP server 各起一个面板（端口自动 +1..+9），但它们读的是同一份
// sessions.json —— 所以任何一张面板都能列出全部仓库的会话、存储与新鲜度。
// 这就是方案 A（单进程多 root）的落地形态：不需要把 root 变成数组参数，
// 也不去动联邦 gitnexus 的会话分桶。
// ---------------------------------------------------------------------------
const normPath = (p: string): string => p.split(String.fromCharCode(92)).join('/').replace(/\/+$/, '').toLowerCase();

/** 本面板要展示的全部仓库：主 root + 所有活跃会话的 cwd（大小写/分隔符归一后去重）。 */
export function knownRoots(primary: string): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    if (!raw || !raw.trim()) return;
    const p = raw.split(String.fromCharCode(92)).join('/').replace(/\/+$/, '');
    const k = normPath(p);
    if (seen.has(k)) return;
    seen.add(k);
    ordered.push(p);
  };
  push(primary);
  for (const s of liveSessions()) push(String(s.cwd ?? ''));
  return ordered;
}

// ---------------------------------------------------------------------------
// [N14] 索引新鲜度：图谱指纹 vs 工作区（30s 缓存，成本与一次查询探针同级）
// ---------------------------------------------------------------------------
export interface FreshInfo {
  root: string;
  state: 'clean' | 'drift' | 'unknown';
  changed: number;
  added: number;
  removed: number;
  syncedAt?: string;
  note: string;
}
const FRESH_TTL_MS = 30_000;
let freshCache: { at: number; rootsKey: string; v: FreshInfo[] } | null = null;

async function freshness(roots: string[]): Promise<FreshInfo[]> {
  const key = roots.join('|');
  if (freshCache && freshCache.rootsKey === key && Date.now() - freshCache.at < FRESH_TTL_MS) return freshCache.v;
  const out: FreshInfo[] = [];
  for (const root of roots) {
    try {
      const outDir = mapDirFor(root);
      if (!existsSync(join(outDir, '.graph', 'wiring.json'))) {
        out.push({ root, state: 'unknown', changed: 0, added: 0, removed: 0, note: '这个仓库还没有图谱（首次查询会自动建图）' });
        continue;
      }
      const drift: Drift | null = probeDrift(root, outDir);
      const st = readStats(root) as { syncedAt?: string } | null;
      if (drift && !isClean(drift)) {
        out.push({
          root,
          state: 'drift',
          changed: (drift.changed ?? []).length,
          added: (drift.added ?? []).length,
          removed: (drift.removed ?? []).length,
          syncedAt: st?.syncedAt,
          note: '工作区已改动：下一次查询会自动增量重建',
        });
      } else {
        out.push({ root, state: 'clean', changed: 0, added: 0, removed: 0, syncedAt: st?.syncedAt, note: '图谱与工作区一致' });
      }
    } catch (e) {
      out.push({ root, state: 'unknown', changed: 0, added: 0, removed: 0, note: `探测失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }
  freshCache = { at: Date.now(), rootsKey: key, v: out };
  return out;
}

/**
 * [N12] 面板「重试探针」装完之后要能**真的看到新工具**。
 * dashboard 不认识 MCP 的 tools/list（那是 server.ts 的 KeptListing），所以留一个
 * 注册点：server.ts 把 `() => federated.refresh()` 挂进来，重探成功后叫醒它，
 * 由它重新算 tools/list 并发 `notifications/tools/list_changed`。
 */
let toolsRefreshHook: (() => void) | null = null;

/** 注册"重探后刷新工具列表"的回调（server.ts 调用；测试也能用它断言被叫到）。 */
export function setToolsRefreshHook(fn: (() => void) | null): void {
  toolsRefreshHook = fn;
}

/** 本次进程生效的令牌策略（startDashboard 时确定一次，之后只读）。 */
let tokenPolicy: TokenPolicy = { required: false, token: null, generated: false, forcedWarn: false };

/** 只读一份给测试/诊断用，避免测试重复推导环境变量。 */
export function activeTokenPolicy(): TokenPolicy {
  return tokenPolicy;
}

/**
 * Starts the dashboard. Returns the http.Server (already listening, or
 * listening on a fallback port) so tests can `await once(srv,'listening')`
 * and close it; callers that don't care can keep ignoring the return value.
 * Returns undefined when the dashboard is opted out (GRAFT_MAX_UI unset/0).
 */
export function startDashboard(explicitPort?: number, root = process.cwd()): Server | undefined {
  const want = process.env.GRAFT_MAX_UI;
  if (!want || want === '0') return undefined; // opt-in only
  // `let`: the EADDRINUSE retry below re-listens on port+1 and the request
  // handlers (page(port)) must render the ACTUAL port, not the wanted one.
  let port = explicitPort ?? ((want && want !== '1' ? parseInt(want) : DEFAULT_PORT) || DEFAULT_PORT);
  // [Docker] 容器内必须绑 0.0.0.0 才能被 -p 端口映射打到（Docker DNAT 目标
  // 是容器 eth0，不是 loopback）。默认仍是 127.0.0.1，宿主用法不变。
  const bindHost = process.env.GRAFT_MAX_UI_HOST ?? '127.0.0.1';
  // [N1] 非回环绑定 = 面板是一个网络面 → 强制令牌；回环绑定默认免令牌。
  tokenPolicy = resolveTokenPolicy(bindHost);
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    try {
      // 1) Host 校验：DNS rebinding 的门。5 个端点此前一律接受任意 Host。
      if (!hostAllowed(req.headers.host, bindHost)) {
        deny(res, 403, 'forbidden host');
        return;
      }
      // 2) 探活：无鉴权、无数据（容器 healthcheck 打它，令牌形态下也不会 401）
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // 3) 数据端点鉴权（仅在策略要求时；回环默认形态行为完全不变）
      const presented = extractToken(req.headers, url.searchParams.get('token'));
      if (AUTH_ENDPOINTS.has(url.pathname) && tokenPolicy.required && !tokenMatches(presented, tokenPolicy.token)) {
        deny(res, 401, 'unauthorized');
        return;
      }
      if (url.pathname === '/') {
        // 页面令牌自举：点一次启动日志里那条 ?token= 的 URL，种下 HttpOnly
        // Cookie，之后前端 2s 轮询自动带凭据（前端 JS 一行都不用改）。
        if (tokenPolicy.token && tokenMatches(presented, tokenPolicy.token)) {
          res.setHeader('set-cookie', `${TOKEN_COOKIE}=${encodeURIComponent(tokenPolicy.token)}; HttpOnly; SameSite=Strict; Path=/`);
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        // 端口 0（测试/随机端口）时 `port` 是 0，得问内核要真实值
        res.end(page((server.address() as { port?: number } | null)?.port ?? port));
      } else if (url.pathname === '/app.js' || url.pathname === '/style.css') {
        // [N8] 面板静态资源（不回退内联：旧版页面自带内联 CSS/JS，不需要这两个 URL）
        const body = panelUsesLegacy() ? null : readPanelAsset(url.pathname === '/app.js' ? 'app.js' : 'style.css');
        if (body === null) {
          json(res, 404, { error: 'panel not built — run: npm run build:panel' });
          return;
        }
        res.writeHead(200, {
          'content-type': url.pathname === '/app.js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
          // no-cache：面板是新工程的第一个发布周期，宁可每次协商也别让用户看到旧 JS
          'cache-control': 'no-cache',
        });
        res.end(body);
      } else if (url.pathname === '/tail') {
        // [N7] `n` 是用户可控参数：`?n=abc` 必须回退到默认值，而不是 NaN 传进
        // slice() 后返回空 body（实测过：浏览器看不到日志、也不报错，最难查的那种）。
        const rawN = Number.parseInt(url.searchParams.get('n') ?? '200', 10);
        const n = Number.isFinite(rawN) ? Math.min(2000, Math.max(1, rawN)) : 200;
        const lines = await tailLines(n);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(lines.join('\n'));
      } else if (url.pathname === '/sessions') {
        json(res, 200, liveSessions());
      } else if (url.pathname === '/fresh') {
        // [N14] 索引新鲜度：每个已知仓库的"图谱指纹 vs 工作区"摘要（30s 缓存）
        json(res, 200, await freshness(knownRoots(root)));
      } else if (url.pathname === '/reprobe') {
        // [N12] 显式重探联邦后端：装完东西不用重启 session。
        // 注意（安全边界）：这里**只**跑各后端的 --version 探针，绝不执行安装命令。
        const backends = await reprobeBackends();
        // 装完就能用：叫醒 tools/list（不发这一步，用户会以为"重试没用"）
        try {
          toolsRefreshHook?.();
        } catch (e) {
          dlog(`dashboard: tools refresh hook failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        json(res, 200, { backends });
      } else if (url.pathname === '/stats') {
        let bytes = 0;
        try {
          bytes = (await stat(logPath())).size;
        } catch {/* no log yet */}
        let rotated = '';
        try {
          rotated = (await stat(`${logPath()}.1`)).size > 0 ? 'yes' : '';
        } catch {/* none */}
        const sessions: SessionRow[] = liveSessions();
        const roots = knownRoots(root);
        // [N13/N14] 建图状态：状态文件由建图子进程维护（P3-9），这里只读，
        // 并且按"已知的全部仓库"扫，而不是只扫 cwd/graft（trail 布局在 .trail/cache）。
        const building: BuildingStatus[] = roots.map((r) => buildingStatus(r)).filter((b) => b.building);
        const fedHealth: FedBackendHealth[] = fedBackendHealth();
        json(res, 200, {
          logPath: logPath(),
          logBytes: bytes,
          rotated,
          sessionsFile: SESSIONS_FILE,
          requests: sessions.reduce((a, s2) => a + s2.requests, 0),
          building,
          roots,
          version: panelVersion(),
          // 端口 0（随机端口）时给内核真相
          port: (server.address() as { port?: number } | null)?.port ?? port,
          // [graft-Max T9 + N9] per-tool 次数/平均/p50/p95/错误，喂"工具耗时"卡
          toolStats: await toolStats(),
          // [N9/N12] 联邦后端健康度 + 结果缓存命中率（P3-6）
          fedHealth,
          fedCache: getFedCacheStats(),
        });
      } else if (url.pathname === '/favicon.ico') {
        // [UI 审计] 浏览器自动请求；404 会污染控制台——内联 SVG 图标零请求
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
        res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#4c7dff"/><text x="8" y="12" font-size="10" text-anchor="middle" fill="#fff" font-family="sans-serif" font-weight="700">M</text></svg>');
      } else if (url.pathname === '/storage') {
        // [graft-Max T9.2 + N11] 本工具全部落盘产物；多仓库时按仓库分组。
        // 顶层 `entries` 保持"主 root"的老形状（脚本/老测试兼容），`roots` 是全量。
        const allRoots = knownRoots(root);
        const groups = [];
        for (const r of allRoots) groups.push({ root: r, entries: await storageEntries(r) });
        json(res, 200, { root, entries: groups[0]?.entries ?? [], roots: groups });
      } else {
        json(res, 404, { error: 'not found' });
      }
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  server.on('error', (e: Error & { code?: string }) => {
    // [需求补全] 端口被占自动偏移 +1~+9（历史行为回归了：之前只软失败不换端口，
    // 多会话并存时后启动的面板直接消失）。全忙才真放弃。
    if ((e.code === 'EADDRINUSE' || e.code === 'EACCES') && !explicitPort && port < DEFAULT_PORT + 9) {
      dlog(`dashboard: port ${port} busy — trying ${port + 1}`);
      port += 1;
      server.listen(port, bindHost);
      return;
    }
    dlog(`dashboard: port ${port} busy — UI not started (MCP unaffected)`);
  });
  server.listen(port, bindHost, () => {
    // 端口 0 = 随机端口，真实端口只有内核知道；日志与令牌 URL 必须用真实端口
    const actualPort = (server.address() as { port?: number } | null)?.port ?? port;
    dlog(`dashboard: http://${bindHost}:${actualPort} (tail / sessions / stats / storage)`);
    if (tokenPolicy.required) {
      // ⚠️ 令牌**只**走 stderr：devlog 会落进 mcp.log，而 mcp.log 正是面板
      // /tail 读的文件 —— 写进日志等于把钥匙挂在门上。
      dlog(`dashboard: token enabled (bind=${bindHost})`);
      if (tokenPolicy.forcedWarn) {
        dlog('dashboard: GRAFT_MAX_UI_TOKEN=0 ignored — non-loopback bind always requires a token');
      }
      console.error(`[graft-Max] dashboard: http://${bindHost}:${actualPort}/?token=${tokenPolicy.token}`);
    } else {
      console.error(`[graft-Max] dashboard: http://${bindHost}:${actualPort}`);
    }
  });
  return server;
}
