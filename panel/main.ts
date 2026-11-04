/**
 * [graft-Max N8] graft-Max 面板前端（真前端工程）。
 *
 * 背景：max.9 之前这 400 行 HTML/CSS/JS 全塞在 `src/mcp/dashboard.ts` 的一个模板
 * 字符串里——没有类型检查、没有 DOM 测试、拼错一个 id 就能让整块功能静默消失
 * （"工具耗时卡片"就是这么丢的）。现在它是独立工程：`tsc` 类型检查 + esbuild
 * 打包 + Playwright 契约测试（`e2e/ui-interact.mjs`）。
 *
 * 约定：
 *   - **零运行时依赖**（不引 React/Vue），产物就是一个 app.js，单文件部署体验不变。
 *   - 所有 DOM 交互用 addEventListener，不用内联 onclick（CSP 干净、可测）。
 *   - 任何 API 失败都要可见（横幅/空态），绝不静默吞掉——静默是这个项目最大的历史教训。
 */

// ---------------------------------------------------------------------------
// 与后端的契约（dashboard.ts 的 /stats /sessions /storage /fresh 的返回形状）
// ---------------------------------------------------------------------------
interface SessionRow {
  pid: number;
  host?: string;
  cwd: string;
  hostPid: number | null;
  hostCmd: string;
  user: string;
  startedAt: string;
  endedAt: string | null;
  requests: number;
  lastSeen?: string;
}

interface ToolStat {
  calls: number;
  avgMs: number;
  p50: number;
  p95: number;
  errors: number;
}

interface FedHealth {
  name: string;
  ok: boolean | null;
  ageMs: number | null;
  retryInMs: number;
  installHint: string;
}

interface StorageEntry {
  label: string;
  path: string;
  bytes: number;
  kind: 'file' | 'dir';
  exists: boolean;
}

interface RepoStorage {
  root: string;
  entries: StorageEntry[];
}

interface BuildInfo {
  root: string;
  startedAt?: string;
  elapsedMs?: number;
  stale?: boolean;
  progress?: { elapsedMs?: number; bytesSoFar?: number };
}

interface FreshInfo {
  root: string;
  state: 'clean' | 'drift' | 'unknown';
  changed: number;
  added: number;
  removed: number;
  syncedAt?: string;
  note: string;
}

interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
}

interface Stats {
  version: string;
  port: number;
  logPath: string;
  logBytes: number;
  rotated: string;
  sessionsFile: string;
  requests: number;
  building: BuildInfo[];
  roots: string[];
  toolStats: Record<string, ToolStat>;
  /** [M7] 错误率趋势（最近 800 行工具返回；rate 为 null 表示窗口内没有工具调用） */
  errorRate?: { windowLines: number; errors: number; rate: number | null };
  fedHealth: FedHealth[];
  fedCache: CacheStats;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`panel: missing #${id} in index.html`);
  return el as T;
};

const esc = (s: unknown): string =>
  String(s).split('&').join('&amp;').split('<').join('&lt;').split('"').join('&quot;').split("'").join('&#39;');

const fmtBytes = (b: number): string => {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
};

const ago = (ts: number): string => {
  const d = Math.round((Date.now() - ts) / 1000);
  if (d < 5) return '刚刚';
  if (d < 60) return `${d} 秒前`;
  return `${Math.round(d / 60)} 分钟前`;
};

const fmtMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);

/** 仓库路径的短显示（长路径只留最后两段，title 里给全路径）。 */
const shortRepo = (root: string): string => {
  const parts = root.replaceAll('\\', '/').split('/').filter(Boolean);
  return parts.length <= 2 ? root : `…/${parts.slice(-2).join('/')}`;
};

type Filter = 'all' | 'err' | 'fed' | 'boot';
interface State {
  filter: Filter;
  paused: boolean;
  lines: string[];
}

const S: State = { filter: 'all', paused: false, lines: [] };

// ---------------------------------------------------------------------------
// 主题
// ---------------------------------------------------------------------------
const applyTheme = (t: 'dark' | 'light'): void => {
  document.documentElement.dataset.theme = t;
  $('themeLabel').textContent = t === 'dark' ? '亮色' : '暗色';
};
const toggleTheme = (): void => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    localStorage.setItem('gm-theme', next);
  } catch {
    /* 隐私模式下 localStorage 会抛，主题只是一次性偏好 */
  }
};
try {
  const saved = localStorage.getItem('gm-theme');
  const light = window.matchMedia?.('(prefers-color-scheme: light)').matches;
  applyTheme(saved === 'light' || saved === 'dark' ? saved : light ? 'light' : 'dark');
} catch {
  applyTheme('dark');
}

// ---------------------------------------------------------------------------
// 状态条 / 横幅
// ---------------------------------------------------------------------------
const setPill = (on: boolean): void => {
  $('livePill').className = `pill ${on ? 'on' : 'off'}`;
  $('liveText').textContent = on ? '运行中' : '失联';
};
const showBanner = (msg: string): void => {
  const b = $('banner');
  if (msg) {
    $('bannerText').textContent = msg;
    b.hidden = false;
  } else {
    b.hidden = true;
  }
};

/** 统一的 fetch：把 401/403 翻译成人能看懂的话，而不是静默失败。 */
async function api<T>(path: string): Promise<T> {
  const r = await fetch(path, { credentials: 'same-origin' });
  if (r.status === 401) throw new Error('需要令牌：请用启动日志里带 ?token= 的地址打开面板');
  if (r.status === 403) throw new Error('Host 校验拒绝：请用 127.0.0.1 或 localhost 访问');
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return (await r.json()) as T;
}

// ---------------------------------------------------------------------------
// 表格：空态
// ---------------------------------------------------------------------------
const emptyRow = (cols: number, icon: string, title: string, hint: string): string =>
  `<tr><td colspan="${cols}"><div class="empty"><div class="ic">` +
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${icon}</svg></div>` +
  `<div class="t">${title}</div><div class="h">${hint}</div></div></td></tr>`;

const ICON_USERS =
  '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>';
const ICON_BARS = '<path d="M3 7h18M3 12h18M3 17h18"/>';

// ---------------------------------------------------------------------------
// 活跃会话
// ---------------------------------------------------------------------------
async function loadSessions(): Promise<void> {
  const rows = await api<SessionRow[]>('/sessions');
  $('cSessions').textContent = String(rows.length);
  $('nSess').textContent = String(rows.length);
  $('updSess').textContent = ago(Date.now());
  const tb = document.querySelector<HTMLTableSectionElement>('#sess tbody');
  if (!tb) return;
  tb.innerHTML = '';
  if (rows.length === 0) {
    tb.innerHTML = emptyRow(
      7,
      ICON_USERS,
      '暂无可用的 MCP 会话',
      '在任意仓库里启动 MCP server 后，这里会显示谁在用、用的是哪个仓库。<br>例：<code>node dist/cli.js mcp &lt;仓库路径&gt;</code>',
    );
    $('sSessions').textContent = '等待 MCP 宿主连接';
    $('kpiSessions').className = 'kpi warn';
    return;
  }
  $('kpiSessions').className = 'kpi ok';
  const users = [...new Set(rows.map((r) => r.user))].join(' / ');
  $('sSessions').textContent = `${users} 正在使用`;
  for (const s of rows) {
    const hostBadge = s.host ? ` <span class="tag none">${esc(s.host.slice(0, 8))}</span>` : '';
    const cmd = String(s.hostCmd ?? '').split(/[\\/]/).pop() ?? '';
    tb.insertAdjacentHTML(
      'beforeend',
      '<tr>' +
        '<td><span class="tag live"><span style="width:5px;height:5px;border-radius:50%;background:currentColor;display:inline-block"></span>运行中</span></td>' +
        `<td class="mono">${esc(s.pid)}</td>` +
        `<td>${esc(s.user)}</td>` +
        `<td class="mono path" title="${esc(s.cwd)}">${esc(s.cwd)}</td>` +
        `<td class="mono muted">${esc(s.hostPid ?? '?')} ${esc(cmd)}${hostBadge}</td>` +
        `<td class="mono">${esc(s.requests)}</td>` +
        `<td class="muted">${esc(new Date(s.startedAt).toLocaleString('zh-CN'))}</td>` +
        '</tr>',
    );
  }
  setPill(true);
}

// ---------------------------------------------------------------------------
// 工具耗时（N9：把 max.7 弄丢的卡片补回来，并升级成 p50/p95）
// ---------------------------------------------------------------------------
async function loadTools(stats: Stats): Promise<void> {
  const entries = Object.entries(stats.toolStats).sort((a, b) => b[1].calls - a[1].calls);
  $('nTools').textContent = String(entries.length);
  $('updTools').textContent = `按最近 800 行日志聚合 · ${new Date().toLocaleTimeString('zh-CN')}`;
  const tb = document.querySelector<HTMLTableSectionElement>('#tools tbody');
  if (!tb) return;
  if (entries.length === 0) {
    tb.innerHTML = emptyRow(
      7,
      ICON_BARS,
      '还没有工具调用记录',
      '调用一次 <code>max_find_code</code> 或 <code>graft_repo_map</code>，这里会显示每工具的次数、平均耗时与 p95 分位（性能收益的可视化证据）。',
    );
    return;
  }
  const maxP95 = Math.max(1, ...entries.map(([, v]) => v.p95));
  tb.innerHTML = '';
  for (const [name, v] of entries) {
    const pct = Math.max(2, Math.round((v.p95 / maxP95) * 100));
    tb.insertAdjacentHTML(
      'beforeend',
      '<tr>' +
        `<td class="mono">${esc(name)}</td>` +
        `<td class="mono num">${v.calls}</td>` +
        `<td class="mono num">${fmtMs(v.avgMs)}</td>` +
        `<td class="mono num">${fmtMs(v.p50)}</td>` +
        `<td class="mono num">${fmtMs(v.p95)}</td>` +
        `<td class="num">${v.errors > 0 ? `<span class="tag err">${v.errors}</span>` : '<span class="muted">0</span>'}</td>` +
        `<td><div class="bar wide"><i style="width:${pct}%"></i></div></td>` +
        '</tr>',
    );
  }
}

// ---------------------------------------------------------------------------
// 联邦后端（N12：装完不用重启就能看见 + 安装命令一键复制）
// ---------------------------------------------------------------------------
function fedStatusTag(h: FedHealth): string {
  if (h.ok === true) return '<span class="tag ok">就绪</span>';
  if (h.ok === false) return '<span class="tag err">未安装</span>';
  return '<span class="tag none">未探测</span>';
}

async function loadFed(stats: Stats): Promise<void> {
  const list = stats.fedHealth ?? [];
  const ready = list.filter((h) => h.ok === true).length;
  $('nFed').textContent = `${ready} / ${list.length}`;
  $('updFed').textContent = `成功 5 分钟 / 失败 30 秒后自动重探 · 缓存 ${stats.fedCache?.hits ?? 0} 命中 / ${stats.fedCache?.misses ?? 0} 未命中`;
  const tb = document.querySelector<HTMLTableSectionElement>('#fed tbody');
  if (!tb) return;
  tb.innerHTML = '';
  if (list.length === 0) {
    tb.innerHTML = emptyRow(5, ICON_BARS, '没有启用的联邦后端', '联邦后端（qmd / gitnexus / ccc）全部可用时，这里显示它们的探针状态。');
    return;
  }
  for (const h of list) {
    const probe = h.ageMs === null ? '未探测' : `${ago(Date.now() - h.ageMs)}探测`;
    const retry = h.retryInMs > 0 ? ` · ${Math.ceil(h.retryInMs / 1000)}s 后可重探` : ' · 可重探';
    tb.insertAdjacentHTML(
      'beforeend',
      '<tr>' +
        `<td class="mono">${esc(h.name)}</td>` +
        `<td>${fedStatusTag(h)}</td>` +
        `<td class="muted">${esc(probe + retry)}</td>` +
        `<td><div class="hint"><code>${esc(h.installHint)}</code></div></td>` +
        `<td><button class="sm ghost" data-copy="${esc(h.installHint)}">复制</button></td>` +
        '</tr>',
    );
  }
}

// ---------------------------------------------------------------------------
// 存储 / 产物（N11 多仓库：按仓库分组）
// ---------------------------------------------------------------------------
function renderStorageRows(entries: StorageEntry[]): string {
  if (entries.length === 0) return emptyRow(6, ICON_BARS, '没有可统计的产物', '');
  const max = Math.max(1, ...entries.map((e) => e.bytes));
  return entries
    .map((e) => {
      const pct = e.exists && max > 0 ? Math.max(2, Math.round((e.bytes / max) * 100)) : 0;
      const size = e.exists ? fmtBytes(e.bytes) : '<span class="tag none">未创建</span>';
      const bar = e.exists && e.kind === 'dir' && e.bytes > 0 ? `<div class="bar"><i style="width:${pct}%"></i></div>` : '';
      return (
        '<tr>' +
        `<td class="mono path" title="${esc(e.path)}"><span class="tag repo">${esc(e.label)}</span></td>` +
        `<td><span class="tag ${e.kind === 'dir' ? 'dir' : 'file'}">${e.kind === 'dir' ? '目录' : '文件'}</span></td>` +
        `<td class="mono">${size}${bar}</td>` +
        `<td class="mono path" title="${esc(e.path)}">${esc(e.path)}</td>` +
        `<td><button class="sm ghost" data-copy="${esc(e.path)}">复制</button></td>` +
        '</tr>'
      );
    })
    .join('');
}

async function loadStorage(): Promise<void> {
  const data = await api<{ root: string; entries: StorageEntry[]; roots?: RepoStorage[] }>('/storage');
  const groups: RepoStorage[] = data.roots ?? [{ root: data.root, entries: data.entries }];
  const all = groups.flatMap((g) => g.entries);
  $('nStore').textContent = `${all.filter((e) => e.exists).length} / ${all.length}`;
  $('updStore').textContent = `每 30s 刷新 · ${groups.length} 个仓库 · 点「复制」取路径`;
  const tb = document.querySelector<HTMLTableSectionElement>('#store tbody');
  if (!tb) return;
  tb.innerHTML = '';
  for (const g of groups) {
    // N11：一个进程可能服务多个仓库（多会话），分组标题让"这份产物属于谁"一眼可见
    tb.insertAdjacentHTML(
      'beforeend',
      `<tr class="group"><td colspan="5">${esc(shortRepo(g.root))} <span class="muted">· ${g.entries.filter((e) => e.exists).length}/${g.entries.length} 已创建</span></td></tr>`,
    );
    tb.insertAdjacentHTML('beforeend', renderStorageRows(g.entries));
  }
}

// ---------------------------------------------------------------------------
// 索引新鲜度（N14）
// ---------------------------------------------------------------------------
const FRESH_TAG: Record<FreshInfo['state'], string> = {
  clean: '<span class="tag ok">同步</span>',
  drift: '<span class="tag warn">有漂移</span>',
  unknown: '<span class="tag none">未建图</span>',
};

async function loadFresh(): Promise<void> {
  const list = await api<FreshInfo[]>('/fresh');
  $('nFresh').textContent = String(list.length);
  const tb = document.querySelector<HTMLTableSectionElement>('#fresh tbody');
  if (!tb) return;
  if (list.length === 0) {
    tb.innerHTML = emptyRow(5, ICON_BARS, '还没有可比较的仓库', '有会话在某个仓库里跑过以后，这里显示图谱指纹与工作区的差异。');
    return;
  }
  tb.innerHTML = '';
  for (const f of list) {
    const changed =
      f.state === 'drift'
        ? `<span class="mono">改 ${f.changed} · 增 ${f.added} · 删 ${f.removed}</span>`
        : '<span class="muted">—</span>';
    tb.insertAdjacentHTML(
      'beforeend',
      '<tr>' +
        `<td class="mono path" title="${esc(f.root)}">${esc(shortRepo(f.root))}</td>` +
        `<td>${FRESH_TAG[f.state] ?? FRESH_TAG.unknown}</td>` +
        `<td>${changed}</td>` +
        `<td class="muted">${f.syncedAt ? esc(new Date(f.syncedAt).toLocaleString('zh-CN')) : '—'}</td>` +
        `<td class="hint">${esc(f.note)}</td>` +
        '</tr>',
    );
  }
}

// ---------------------------------------------------------------------------
// 统计（KPI）
// ---------------------------------------------------------------------------
async function loadStats(): Promise<Stats> {
  const s = await api<Stats>('/stats');
  showBanner('');
  setPill(true);
  $('ver').textContent = `v${s.version}`;
  const url = `http://127.0.0.1:${s.port}`;
  const a = $<HTMLAnchorElement>('panelUrl');
  a.textContent = `127.0.0.1:${s.port}`;
  a.href = url;
  $('cRequests').textContent = String(s.requests);
  // [M7] KPI 副标题展示错误率趋势；>10% 时整张卡标 warn（红一下让人看见）
  const er = s.errorRate;
  const sub = $('sRequests');
  const kpi = $('cRequests').closest('.kpi');
  if (er && er.rate !== null && s.requests > 0) {
    const pct = (er.rate * 100).toFixed(1);
    sub.textContent = `错误率 ${pct}%（最近 ${er.windowLines} 次）`;
    kpi?.classList.toggle('warn', er.rate > 0.1);
  } else {
    sub.textContent = s.requests > 0 ? '本进程启动以来' : '还没有工具调用';
    kpi?.classList.remove('warn');
  }
  const building = (s.building ?? []).filter((b) => !b.stale);
  const cB = $('cBuilding');
  cB.textContent = building.length > 0 ? `建图中 · ${building.length}` : '空闲';
  $('kpiBuild').className = `kpi ${building.length > 0 ? 'warn' : 'ok'}`;
  $('sBuilding').textContent =
    building.length > 0
      ? (() => {
          const b = building[0];
          const secs = Math.max(1, Math.round((b.elapsedMs ?? 0) / 1000));
          // [M5] 产物体积增长曲线（非文件级 X/Y）：bytes 存在时追加"产物 X KB/MB"
          const bytes = b.progress?.bytesSoFar;
          const size = bytes === undefined ? '' : bytes >= 1024 * 1024 ? ` · 产物 ${(bytes / 1024 / 1024).toFixed(1)}MB` : ` · 产物 ${Math.round(bytes / 1024)}KB`;
          return `正在解析：${shortRepo(b.root)} · 已 ${secs}s${size}`;
        })()
      : '图谱已就绪';
  $('cLog').innerHTML = `${(s.logBytes / 1024).toFixed(1)} <small>KB</small>`;
  $('sLog').textContent = s.rotated ? '已滚动过（mcp.log.1 存在）' : '超过 5MB 自动滚动';
  return s;
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------
type LineClass = '' | 'err' | 'fed' | 'boot' | 'ts';
const lineClass = (l: string): LineClass => {
  if (l.includes('isError=true')) return 'err';
  if (l.includes('[联邦]') || l.includes('[fed')) return 'fed';
  if (l.includes('服务启动') || l.includes('服务退出') || l.includes('boot') || l.includes('dashboard:')) return 'boot';
  if (l.startsWith('[')) return 'ts';
  return '';
};

function renderLog(): void {
  const el = $('log');
  if (S.lines.length === 0 || (S.lines.length === 1 && !S.lines[0])) {
    el.innerHTML = '<div class="ln ts">暂无日志。开启 <b>GRAFT_MAX_LOG=1</b> 后，工具调用、联邦子进程、服务启停都会记录在这里。</div>';
    return;
  }
  let html = '';
  for (const line of S.lines) {
    const c = lineClass(line);
    if (S.filter !== 'all' && c !== S.filter) continue;
    html += `<div class="ln ${c}">${esc(line)}</div>`;
  }
  el.innerHTML = html || '<div class="ln ts">当前筛选下没有匹配的日志</div>';
}

async function loadLog(force: boolean): Promise<void> {
  const r = await fetch('/tail?n=400', { credentials: 'same-origin' });
  if (!r.ok) throw new Error(`/tail → HTTP ${r.status}`);
  const text = await r.text();
  const el = $('log');
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 50;
  S.lines = text.split('\n');
  renderLog();
  if (atBottom || force) el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------------------
// 轮询
// ---------------------------------------------------------------------------
let timer: number | null = null;
let slowTimer: number | null = null;
/** [自审修复·静态确认] 轮询"代"：改刷新间隔的那一瞬间若正好有一轮 `tick()` 在 await，
 *  它恢复后会**再挂一个定时器**，此时 `clearTimeout` 已经无从下手（旧 id 早就 fire 过），
 *  于是两条链并存、请求频率翻倍。用代际号让过期的链自己退出。
 *  诚实标注：**没有构造出能复现它的时序**（窗口只有几十毫秒），这是按代码读出来的竞态，
 *  属防御性修复；E2E 只有"速率不超上界"的断言，不能当它的回归证明。 */
let timerGen = 0;

/** 一次完整刷新：日志 + KPI + 三张表。任何一块失败都要让用户看见。 */
async function tick(force = false): Promise<void> {
  if (S.paused && !force) return;
  try {
    await loadLog(force);
  } catch (e) {
    showBanner(e instanceof Error ? e.message : String(e));
    setPill(false);
  }
  try {
    const stats = await loadStats();
    await Promise.all([loadSessions(), loadTools(stats), loadFed(stats)]);
  } catch (e) {
    showBanner(e instanceof Error ? e.message : String(e));
    setPill(false);
  }
  try {
    await Promise.all([loadStorage(), loadFresh()]);
  } catch (e) {
    // 存储/新鲜度是慢面：失败只记横幅，不影响 2s 主轮询
    showBanner(e instanceof Error ? e.message : String(e));
  }
}

const intervalMs = (): number => {
  const v = parseInt($<HTMLInputElement>('ms').value, 10);
  return Number.isNaN(v) ? 2000 : Math.max(500, v);
};

function startTimer(): void {
  timerGen += 1;
  const my = timerGen;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const loop = async (): Promise<void> => {
    if (my !== timerGen) return; // 已被新的一代取代（用户改了间隔）→ 这条链退休
    await tick(false);
    if (my !== timerGen) return;
    timer = window.setTimeout(loop, intervalMs());
  };
  timer = window.setTimeout(loop, intervalMs());
}

function startSlowTimer(): void {
  if (slowTimer !== null) clearInterval(slowTimer);
  slowTimer = window.setInterval(() => {
    if (S.paused) return;
    void loadStorage().catch(() => {});
    void loadFresh().catch(() => {});
  }, 30_000);
}

// ---------------------------------------------------------------------------
// 交互
// ---------------------------------------------------------------------------
$('btnTheme').addEventListener('click', toggleTheme);
$('btnRefresh').addEventListener('click', () => void tick(true));
$('btnRetry').addEventListener('click', () => void tick(true));
$('btnBottom').addEventListener('click', () => {
  const el = $('log');
  el.scrollTop = el.scrollHeight;
});

$('btnPause').addEventListener('click', () => {
  S.paused = !S.paused;
  const b = $('btnPause');
  b.textContent = S.paused ? '继续' : '暂停';
  b.className = `sm${S.paused ? '' : ' ghost'}`;
});

$('chips').addEventListener('click', (ev) => {
  const target = ev.target as HTMLElement;
  const chip = target.closest<HTMLElement>('.chip');
  if (!chip) return;
  S.filter = (chip.dataset.f as Filter) ?? 'all';
  for (const c of Array.from($('chips').querySelectorAll<HTMLElement>('.chip'))) {
    c.classList.toggle('on', c === chip);
  }
  renderLog();
});

$<HTMLInputElement>('ms').addEventListener('change', startTimer);

// 复制按钮：storage / fed 两张表共用（事件委托，重渲染后依然有效）
document.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLElement>('button[data-copy]');
  if (!btn) return;
  const text = btn.dataset.copy ?? '';
  const done = (): void => {
    btn.textContent = '已复制';
    window.setTimeout(() => {
      btn.textContent = '复制';
    }, 1200);
  };
  const fallback = (): void => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch {
      btn.textContent = '复制失败';
      window.setTimeout(() => {
        btn.textContent = '复制';
      }, 1500);
    }
  };
  if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
});

// 重试探针：显式清缓存重探（N12）。装完后端不用重启 session。
$('btnReprobe').addEventListener('click', () => {
  const b = $<HTMLButtonElement>('btnReprobe');
  b.disabled = true;
  b.textContent = '探测中…';
  void fetch('/reprobe', { credentials: 'same-origin' })
    .then(() => tick(true))
    .catch(() => showBanner('重试探针失败'))
    .finally(() => {
      b.disabled = false;
      b.textContent = '重试探针';
    });
});

void tick(true);
startTimer();
startSlowTimer();
