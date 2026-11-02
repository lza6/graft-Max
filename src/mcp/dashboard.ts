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
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>graft-Max Dashboard</title>
<style>
 body{font:13px/1.5 ui-monospace,Consolas,monospace;background:#0d1117;color:#c9d1d9;margin:0;padding:16px}
 h1{font-size:16px;color:#58a6ff;margin:0 0 4px} .sub{color:#8b949e;margin-bottom:12px}
 table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border:1px solid #21262d;padding:4px 8px;text-align:left}
 th{background:#161b22;color:#58a6ff} .live{color:#3fb950;font-weight:bold} .dead{color:#8b949e}
 #log{background:#010409;border:1px solid #21262d;padding:8px;height:55vh;overflow-y:auto;white-space:pre-wrap;font-size:12px}
 .ok{color:#3fb950}.err{color:#f85149}.ts{color:#8b949e}
 button{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:4px 12px;cursor:pointer}
 button:hover{background:#30363d} input{background:#010409;color:#c9d1d9;border:1px solid #30363d;padding:4px;width:70px}
 .row{display:flex;gap:8px;align-items:center;margin:8px 0}
</style></head><body>
<h1>graft-Max Dashboard</h1>
<div class="sub" id="stats">loading…</div>
<h3>Live sessions（谁正在使用）</h3>
<table id="sess"><thead><tr><th>状态</th><th>pid</th><th>用户</th><th>仓库 (cwd)</th><th>宿主进程</th><th>请求数</th><th>启动时间</th></tr></thead><tbody></tbody></table>
<h3>Log tail（实时日志）</h3>
<div class="row"><button onclick="poll(true)">刷新</button> 自动刷新 <input id="ms" value="2000">ms <span id="pauseHint"></span></div>
<div id="log"></div>
<script>
let lastLen=0, paused=false, timer=null;
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;')}
async function loadSessions(){
  const r=await fetch('/sessions'); const rows=await r.json();
  const tb=document.querySelector('#sess tbody'); tb.innerHTML='';
  if(!rows.length){tb.innerHTML='<tr><td colspan=7 class=dead>没有活跃会话（server 未启动或已退出）</td></tr>';return}
  for(const s of rows){tb.insertAdjacentHTML('beforeend',
    \`<tr><td class=live>● LIVE</td><td>\${s.pid}</td><td>\${esc(s.user)}</td><td>\${esc(s.cwd)}</td><td>\${s.hostPid??'?'} \${esc(s.hostCmd||'')}</td><td>\${s.requests}</td><td class=ts>\${s.startedAt}</td></tr>\`)}
}
async function loadStats(){
  const s=await (await fetch('/stats')).json();
  document.getElementById('stats').textContent=\`log: \${s.logPath}  (\${(s.logBytes/1024).toFixed(1)} KB)  ·  sessions file: \${s.sessionsFile}  ·  requests served: \${s.requests}\`;
}
async function poll(force){
  if(!force&&paused)return;
  const n=parseInt(document.getElementById('ms').value)>=500?200:200;
  const r=await fetch('/tail?n=300'); const t=await r.text();
  const el=document.getElementById('log');
  const atBottom=el.scrollTop+el.clientHeight>=el.scrollHeight-40;
  el.innerHTML=t.split('\\n').map(l=>{
    let cls=''; if(l.includes('isError=true'))cls='err'; else if(l.startsWith('['))cls='ts';
    return '<div class="'+cls+'">'+esc(l)+'</div>';}).join('');
  if(atBottom)el.scrollTop=el.scrollHeight;
  loadSessions(); loadStats();
}
async function boot(){await poll(true); const ms=()=>parseInt(document.getElementById('ms').value)||2000; timer=setInterval(poll,2000);}
boot();
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
