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
 * Binds 127.0.0.1 only (never a network face). Port default 24688, chosen
 * away from serena's 24282 and other local dashboards. Port conflict is a
 * soft failure: the server logs the miss and keeps serving MCP — the
 * dashboard is a convenience, not a dependency.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, open } from 'node:fs/promises';
import { dlog, logPath, liveSessions, SESSIONS_FILE, GRAFT_MAX_HOME, type SessionRow } from './devlog.js';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_PORT = 24688;

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

/** [graft-Max T9] per-tool call counts + timing, parsed from the last chunk of
 * the log. Log lines look like `<-- 工具返回…  <name>  123ms  isError=true`
 * (server.ts dlogBlock). Powers the dashboard's 耗时趋势 card — visual proof of
 * the T2/T3 fast-path wins. Reads at most the last ~256KB, so cost is flat. */
async function toolStats(): Promise<Record<string, { calls: number; avgMs: number; errors: number }>> {
  const lines = await tailLines(800);
  const per = new Map<string, { calls: number; totalMs: number; errors: number }>();
  for (const line of lines) {
    const m = /<--\s+(?:工具返回|tools\/call).*?\s(\S+)\s+(\d+)ms\s+isError=(true|false)/.exec(line);
    if (!m) continue;
    // normalize across spellings (max_/graft_/trail_/legacy aliases) so one
    // tool's calls aggregate on one row
    const name = m[1].replace(/^(max_|graft_|trail_)/, '').replace(/^ask$/, 'find_code');
    const e = per.get(name) ?? { calls: 0, totalMs: 0, errors: 0 };
    e.calls++;
    e.totalMs += Number(m[2]);
    if (m[3] === 'true') e.errors++;
    per.set(name, e);
  }
  const out: Record<string, { calls: number; avgMs: number; errors: number }> = {};
  for (const [name, e] of per) out[name] = { calls: e.calls, avgMs: Math.round(e.totalMs / e.calls), errors: e.errors };
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
interface StorageEntry { label: string; path: string; bytes: number; kind: 'file' | 'dir' }

function dirSize(dir: string, depth = 0): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    try {
      if (e.isDirectory()) {
        // depth cap: graph dirs are shallow; anything deeper is not ours
        if (depth < 6) total += dirSize(p, depth + 1);
      } else if (e.isFile()) {
        total += statSync(p).size;
      }
    } catch {/* raced delete / permission — skip the entry */}
  }
  return total;
}

async function storageEntries(root: string): Promise<StorageEntry[]> {
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
    try {
      bytes = kind === 'dir' ? dirSize(p) : statSync(p).size;
      // [review r4] SQLite 伴生文件（-wal/-shm）常占大头，一并计入
      if (kind === 'file' && p.endsWith('.sqlite')) {
        for (const side of ['-wal', '-shm']) {
          try { bytes += statSync(p + side).size; } catch {/* no sidecar */}
        }
      }
    } catch {/* absent — still listed with 0 */}
    out.push({ label: label.trim(), path: p, bytes, kind });
  }
  return out;
}

function human(bytes: number): string {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

function page(port = DEFAULT_PORT): string {
  // [graft-Max] 设计语言对齐上游 viewer（style.css 的 tokens）：同一套
  // --bg/--panel/--ink/--accent 变量，亮暗双主题自动跟随系统，可手动切。
  // [需求补全] 端口动态渲染：端口被占自动偏移后，卡片不能显示错误地址。
  return `<!doctype html>
<html lang="zh" data-theme="dark"><head><meta charset="utf-8"><title>graft-Max Dashboard</title>
<style>
:root{
  --bg:#F4F6F6; --panel:#FFFFFF; --panel2:#FBFCFC; --ink:#17191B; --muted:#6B7278;
  --border:#E2E6E7; --border2:#EDF0F1; --accent:#546FFF; --chip:#F0F3F3;
  --ok:#2E9E5B; --warn:#D98E2B; --err:#D6455B; --canvas:#F8FAFA;
}
:root[data-theme="dark"]{
  --bg:#0E1012; --panel:#15181B; --panel2:#111417; --ink:#E7E9EA; --muted:#8B9298;
  --border:#252B30; --border2:#1D2226; --accent:#7B8FFF; --chip:#1C2125;
  --ok:#57C98B; --warn:#E0A04A; --err:#F07186; --canvas:#101315;
}
*{box-sizing:border-box}
body{font:14px/1.55 "Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--ink);margin:0;padding:0 0 32px}
.wrap{max-width:1200px;margin:0 auto;padding:20px 24px}
header{display:flex;align-items:center;gap:12px;padding:14px 0 10px;border-bottom:1px solid var(--border);margin-bottom:16px}
header .logo{width:26px;height:26px;border-radius:7px;background:var(--accent);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:14px}
header h1{font-size:17px;margin:0;font-weight:600}
header .ver{color:var(--muted);font-size:12px}
header .sp{flex:1}
button{background:var(--panel);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:5px 14px;cursor:pointer;font-size:13px}
button:hover{border-color:var(--accent);color:var(--accent)}
button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
input{background:var(--canvas);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:5px 8px;width:72px;font-size:13px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:18px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
.card .k{color:var(--muted);font-size:12px}.card .v{font-size:22px;font-weight:600;margin-top:2px}
.card .v small{font-size:12px;color:var(--muted);font-weight:400}
h2{font-size:14px;font-weight:600;color:var(--ink);margin:20px 0 8px;display:flex;align-items:center;gap:8px}
h2 .dot{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 6px var(--ok)}
table{border-collapse:collapse;width:100%;background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow:hidden;font-size:13px}
td,th{padding:7px 12px;text-align:left;border-bottom:1px solid var(--border2)}
th{background:var(--panel2);color:var(--muted);font-weight:500;font-size:12px}
tr:last-child td{border-bottom:none}
.live{color:var(--ok);font-weight:600}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}
.muted{color:var(--muted)}
#log{background:var(--canvas);border:1px solid var(--border);border-radius:10px;padding:10px 12px;height:52vh;overflow-y:auto;white-space:pre-wrap;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.6}
#log .ts{color:var(--muted)} #log .err{color:var(--err);background:rgba(214,69,91,.08);border-radius:4px}
#log .fed{color:var(--accent)} #log .boot{color:var(--warn);font-weight:600}
.row{display:flex;gap:8px;align-items:center;margin:8px 0;font-size:13px;color:var(--muted)}
.badge{display:inline-block;background:var(--chip);border-radius:5px;padding:1px 7px;font-size:11px;color:var(--muted)}
</style></head><body>
<div class="wrap">
<header>
  <div class="logo">M</div>
  <div><h1>graft-Max Dashboard</h1><div class="ver">v0.28.0-max · 仓库上下文图谱 + 联邦工具</div></div>
  <div class="sp"></div>
  <button onclick="toggleTheme()" title="切换亮暗">🌓 主题</button>
  <button class="primary" onclick="poll(true)">刷新</button>
  <button onclick="startTimer()" title="应用新的轮询间隔">应用间隔</button>
</header>
<div class="cards">
  <div class="card"><div class="k">活跃会话</div><div class="v" id="cSessions">–</div></div>
  <div class="card"><div class="k">累计工具调用</div><div class="v" id="cRequests">–</div></div>
  <div class="card"><div class="k">日志大小</div><div class="v" id="cLog">–</div></div>
  <div class="card"><div class="k">建图状态</div><div class="v" id="cBuilding" style="font-size:15px">–</div></div>
  <div class="card"><div class="k">工具耗时 <small>（近 800 行日志）</small></div><div class="v" id="cTools" style="font-size:13px">–</div></div>
  <div class="card"><div class="k">面板地址</div><div class="v" style="font-size:13px"><a href="http://127.0.0.1:${port}" style="color:var(--accent,#4c7dff)">127.0.0.1:${port}</a><br><small>实时日志 / 会话 / 统计 / 存储</small></div></div>
</div>
<h2><span class="dot"></span>活跃会话 · 谁正在使用</h2>
<table id="sess"><thead><tr><th>状态</th><th>pid</th><th>用户</th><th>仓库</th><th>宿主进程</th><th>请求数</th><th>启动时间</th></tr></thead><tbody></tbody></table>
<h2>存储 / 产物 <span class="badge">本工具落盘的全部路径与占用（30s 刷新）</span></h2>
<table id="store"><thead><tr><th>产物</th><th>类型</th><th>大小</th><th>路径</th><th></th></tr></thead><tbody></tbody></table>
<h2>实时日志 <span class="badge">自动刷新 <input id="ms" value="2000"> ms</span></h2>
<div id="log"></div>
</div>
<script>
let timer=null;
function esc(s){return s.split('&').join('&amp;').split('<').join('&lt;').split('"').join('&quot;').split("'").join('&#39;')}
function toggleTheme(){const r=document.documentElement;const nv=r.dataset.theme==='dark'?'light':'dark';r.dataset.theme=nv;try{localStorage.setItem('gm-theme',nv)}catch(e){}}
try{const saved=localStorage.getItem('gm-theme');if(saved)document.documentElement.dataset.theme=saved;}catch(e){}
async function loadSessions(){
  try{const rows=await (await fetch('/sessions')).json();
  document.getElementById('cSessions').textContent=rows.length;
  const tb=document.querySelector('#sess tbody');tb.innerHTML='';
  if(!rows.length){tb.innerHTML='<tr><td colspan=7 class=muted>没有活跃会话（MCP server 未启动或已退出）</td></tr>';return}
  for(const s of rows){tb.insertAdjacentHTML('beforeend',
    '<tr><td class=live>● LIVE</td><td class=mono>' + s.pid + '</td><td>' + esc(s.user) + '</td><td class=mono>' + esc(s.cwd) + '</td><td class=muted>' + (s.hostPid ?? '?') + ' <span class=muted>' + esc((s.hostCmd || '').split('/').pop() || '') + '</span></td><td>' + s.requests + '</td><td class=muted>' + new Date(s.startedAt).toLocaleString('zh-CN') + '</td></tr>' ) }
  }catch(e){document.getElementById('cSessions').textContent='–'}
}
async function loadStats(){
  try{const s=await (await fetch('/stats')).json();
  document.getElementById('cRequests').textContent=s.requests;
  const bEl=document.getElementById('cBuilding');
  if(bEl){bEl.textContent=(s.building&&s.building.length)?('建图中('+s.building.length+')'):'空闲';}
  document.getElementById('cLog').innerHTML=(s.logBytes/1024).toFixed(1)+' <small>KB（5MB 自动滚动）</small>';
  const tEl=document.getElementById('cTools');
  if(tEl){const ts=s.toolStats||{};const rows=Object.entries(ts).sort((a,b)=>b[1].calls-a[1].calls).slice(0,6);
    tEl.innerHTML=rows.length?rows.map(([n,v])=>esc(n)+' · '+v.calls+'次 · 均'+v.avgMs+'ms'+(v.errors?' <span style=\\'color:var(--err,#e5484d)\\'>'+v.errors+'错</span>':'')).join('<br>'):'<small>暂无调用</small>';}
  }catch(e){}
}
function fmtBytes(b){if(b>=1073741824)return (b/1073741824).toFixed(2)+' GB';if(b>=1048576)return (b/1048576).toFixed(1)+' MB';if(b>=1024)return (b/1024).toFixed(1)+' KB';return b+' B'}
async function loadStorage(){
  try{const s=await (await fetch('/storage')).json();
  const tb=document.querySelector('#store tbody');tb.innerHTML='';
  for(const e of s.entries){tb.insertAdjacentHTML('beforeend',
    '<tr><td>'+esc(e.label)+'</td><td class=muted>'+(e.kind==='dir'?'目录':'文件')+'</td><td class=mono>'+fmtBytes(e.bytes)+'</td><td class=mono style=max-width:420px;word-break:break-all>'+esc(e.path)+'</td><td><button style="padding:2px 8px;font-size:11px" onclick="copyPath(this)" data-p="'+esc(e.path)+'">复制</button></td></tr>')}
  }catch(e){}
}
function copyPath(btn){try{navigator.clipboard.writeText(btn.dataset.p);btn.textContent='已复制';setTimeout(()=>{btn.textContent='复制'},1200)}catch(e){}}
async function poll(force){
  const el=document.getElementById('log');
  try{
    const t=await (await fetch('/tail?n=300')).text();
    const atBottom=el.scrollTop+el.clientHeight>=el.scrollHeight-40;
    el.innerHTML=t.split('\\n').map(l=>{
      let cls='';
      if(l.includes('isError=true'))cls='err';
      else if(l.includes('[联邦]')||l.includes('[fed]'))cls='fed';
      else if(l.includes('服务启动')||l.includes('服务退出')||l.includes('boot'))cls='boot';
      else if(l.startsWith('['))cls='ts';
      return '<div class="'+cls+'">'+esc(l)+'</div>';}).join('');
    if(atBottom)el.scrollTop=el.scrollHeight;
  }catch(e){}
  loadSessions();loadStats();
  // [R2 review] dirSize 是同步递归走盘，不跟 2s poll：首轮一次 + 30s 慢轮询
  if(!globalThis._stTimer){loadStorage();globalThis._stTimer=setInterval(loadStorage,30000);}
  if(!timer)startTimer();
}
function startTimer(){
  if(timer)clearInterval(timer);
  const ms=()=>{const v=parseInt(document.getElementById('ms').value);return isNaN(v)?2000:Math.max(500,v)};
  timer=setInterval(()=>poll(false),ms());
}
poll(true);
document.getElementById('ms').addEventListener('change', startTimer);
</script></body></html>`;
}

export function startDashboard(explicitPort?: number, root = process.cwd()): void {
  const want = process.env.GRAFT_MAX_UI;
  if (!want || want === '0') return; // opt-in only
  // `let`: the EADDRINUSE retry below re-listens on port+1 and the request
  // handlers (page(port)) must render the ACTUAL port, not the wanted one.
  let port = explicitPort ?? ((want && want !== '1' ? parseInt(want) : DEFAULT_PORT) || DEFAULT_PORT);
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page(port));
      } else if (url.pathname === '/tail') {
        const n = Math.min(2000, Math.max(1, parseInt(url.searchParams.get('n') ?? '200')));
        const lines = await tailLines(n);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(lines.join('\n'));
      } else if (url.pathname === '/sessions') {
        json(res, 200, liveSessions());
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
        // [graft-Max] 各会话仓库的建图状态（building.json 存在=建图进行中）
        const building = sessions
          .filter((s2) => existsSync(join(s2.cwd, 'graft', '.graph', 'building.json')))
          .map((s2) => s2.cwd);
        json(res, 200, {
          logPath: logPath(),
          logBytes: bytes,
          rotated,
          sessionsFile: SESSIONS_FILE,
          requests: sessions.reduce((a, s2) => a + s2.requests, 0),
          building,
          // [graft-Max T9] per-tool stats for the 耗时趋势 card
          toolStats: await toolStats(),
        });
      } else if (url.pathname === '/favicon.ico') {
        // [UI 审计] 浏览器自动请求；404 会污染控制台——内联 SVG 图标零请求
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
        res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#4c7dff"/><text x="8" y="12" font-size="10" text-anchor="middle" fill="#fff" font-family="sans-serif" font-weight="700">M</text></svg>');
      } else if (url.pathname === '/storage') {
        // [graft-Max T9.2] 本工具全部落盘产物的路径+大小
        json(res, 200, { root, entries: await storageEntries(root) });
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
      server.listen(port, '127.0.0.1');
      return;
    }
    dlog(`dashboard: port ${port} busy — UI not started (MCP unaffected)`);
  });
  server.listen(port, '127.0.0.1', () => {
    dlog(`dashboard: http://127.0.0.1:${port} (tail / sessions / stats)`);
    // Make the URL findable even without reading logs.
    console.error(`[graft-Max] dashboard: http://127.0.0.1:${port}`);
  });
}
