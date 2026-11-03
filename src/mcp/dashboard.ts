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
import { dlog, logPath, liveSessions, SESSIONS_FILE, type SessionRow } from './devlog.js';

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

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function page(): string {
  // [graft-Max] 设计语言对齐上游 viewer（style.css 的 tokens）：同一套
  // --bg/--panel/--ink/--accent 变量，亮暗双主题自动跟随系统，可手动切。
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
  <div class="card"><div class="k">面板地址</div><div class="v" style="font-size:13px">127.0.0.1:24688<br><small>实时日志 / 会话 / 统计</small></div></div>
</div>
<h2><span class="dot"></span>活跃会话 · 谁正在使用</h2>
<table id="sess"><thead><tr><th>状态</th><th>pid</th><th>用户</th><th>仓库</th><th>宿主进程</th><th>请求数</th><th>启动时间</th></tr></thead><tbody></tbody></table>
<h2>实时日志 <span class="badge">自动刷新 <input id="ms" value="2000"> ms</span></h2>
<div id="log"></div>
</div>
<script>
let timer=null;
function esc(s){return s.split('&').join('&amp;').split('<').join('&lt;')}
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
  document.getElementById('cLog').innerHTML=(s.logBytes/1024).toFixed(1)+' <small>KB（5MB 自动滚动）</small>';
  }catch(e){}
}
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

export function startDashboard(explicitPort?: number): void {
  const want = process.env.GRAFT_MAX_UI;
  if (!want || want === '0') return; // opt-in only
  const port = explicitPort ?? ((want && want !== '1' ? parseInt(want) : DEFAULT_PORT) || DEFAULT_PORT);
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page());
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
        json(res, 200, {
          logPath: logPath(),
          logBytes: bytes,
          rotated,
          sessionsFile: SESSIONS_FILE,
          requests: sessions.reduce((a, s) => a + s.requests, 0),
        });
      } else {
        json(res, 404, { error: 'not found' });
      }
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  server.on('error', () => {
    dlog(`dashboard: port ${port} busy — UI not started (MCP unaffected)`);
  });
  server.listen(port, '127.0.0.1', () => {
    dlog(`dashboard: http://127.0.0.1:${port} (tail / sessions / stats)`);
    // Make the URL findable even without reading logs.
    console.error(`[graft-Max] dashboard: http://127.0.0.1:${port}`);
  });
}
