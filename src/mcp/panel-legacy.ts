/**
 * [graft-Max N8] 旧版内联面板 —— 兼容回退，一个 release 周期后删除。
 *
 * 历史：`dashboard.ts` 把 669 行 HTML/CSS/JS 塞在一个模板字符串里，既没有
 * 类型检查也没有 DOM 测试（max.9 的"工具耗时卡片静默消失"就是这么发生的）。
 * N8 把它迁到 `panel/`（真前端工程 + esbuild + 可测 DOM），这里保留原样一份，
 * 用 `GRAFT_MAX_UI_LEGACY=1` 或 `dist/panel/` 缺失时兜底（从源码跑测试时不构建前端）。
 *
 * **不要在这里加任何新功能。** 新面板：`panel/`。
 */

/** 旧版页面（与 max.9 逐字节一致，只把版本号改成参数注入）。 */
export function legacyPage(port: number, version: string): string {
  // [graft-Max] 面板设计系统：一套 token（颜色/圆角/阴影/间距），亮暗自适应，
  // 组件化样式（panel / kpi / table / empty / toolbar）。目标不是"能看"，而是
  // 打开就知道系统在干什么、下一步该点哪。
  return `<!doctype html>
<html lang="zh" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>graft-Max Dashboard</title>
<style>
:root{
  --bg:#F5F7FA; --panel:#FFFFFF; --panel2:#FAFBFC; --ink:#101828; --ink2:#344054;
  --muted:#667085; --border:#E4E7EC; --border2:#F0F2F5;
  --accent:#5B6CFF; --accent2:#8B5CF6; --accent-soft:rgba(91,108,255,.08);
  --ok:#12B76A; --ok-soft:rgba(18,183,106,.10); --warn:#F79009; --err:#F04438; --err-soft:rgba(240,68,56,.08);
  --canvas:#F8FAFC; --code:#0F1729;
  --r-sm:8px; --r:12px; --r-lg:16px;
  --sh:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.05);
  --sh-lg:0 4px 12px rgba(16,24,40,.07),0 1px 3px rgba(16,24,40,.06);
}
:root[data-theme="dark"]{
  --bg:#0B0E14; --panel:#12161F; --panel2:#0E121A; --ink:#F2F4F7; --ink2:#D0D5DD;
  --muted:#98A2B3; --border:#1F2633; --border2:#171D27;
  --accent:#7C8BFF; --accent2:#A78BFA; --accent-soft:rgba(124,139,255,.12);
  --ok:#32D583; --ok-soft:rgba(50,213,131,.12); --warn:#FDB022; --err:#FDA29B; --err-soft:rgba(253,162,155,.10);
  --canvas:#0A0D13; --code:#080B11;
  --sh:0 1px 2px rgba(0,0,0,.4); --sh-lg:0 8px 24px rgba(0,0,0,.45);
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{font:14px/1.6 "Inter","Segoe UI",system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--ink);margin:0;-webkit-font-smoothing:antialiased}
.wrap{max-width:1240px;margin:0 auto;padding:0 24px 56px}
header{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:14px;padding:14px 0;
  background:color-mix(in srgb,var(--bg) 85%,transparent);backdrop-filter:blur(12px);
  border-bottom:1px solid var(--border);margin-bottom:22px}
.brand{display:flex;align-items:center;gap:11px;min-width:0}
.logo{width:34px;height:34px;border-radius:10px;flex:none;
  background:linear-gradient(135deg,var(--accent),var(--accent2));
  display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:16px;
  box-shadow:0 2px 8px var(--accent-soft)}
.brand h1{font-size:16px;margin:0;font-weight:650;letter-spacing:-.01em}
.brand .sub{color:var(--muted);font-size:12px;line-height:1.3}
.sp{flex:1}
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border-radius:999px;font-size:12px;
  font-weight:600;background:var(--ok-soft);color:var(--ok);white-space:nowrap}
.pill.off{background:var(--err-soft);color:var(--err)}
.pill .d{width:6px;height:6px;border-radius:50%;background:currentColor;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 22%,transparent)}
.pill.on .d{animation:beat 2s ease-in-out infinite}
@keyframes beat{0%,100%{opacity:1}50%{opacity:.35}}
button{background:var(--panel);color:var(--ink2);border:1px solid var(--border);border-radius:var(--r-sm);
  padding:7px 13px;cursor:pointer;font-size:13px;font-weight:500;display:inline-flex;align-items:center;gap:6px;
  transition:border-color .15s,color .15s,background .15s,transform .06s}
button:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
button:active{transform:translateY(1px)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button.primary{background:var(--accent);color:#fff;border-color:transparent;box-shadow:0 1px 2px var(--accent-soft)}
button.primary:hover{background:color-mix(in srgb,var(--accent) 88%,#000);color:#fff}
button.ghost{background:transparent;border-color:transparent}
button.ghost:hover{background:var(--accent-soft)}
button.sm{padding:4px 9px;font-size:12px;border-radius:6px}
input{background:var(--panel);color:var(--ink);border:1px solid var(--border);border-radius:var(--r-sm);
  padding:6px 9px;width:74px;font-size:13px;font-variant-numeric:tabular-nums}
input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-bottom:22px}
.kpi{background:var(--panel);border:1px solid var(--border);border-radius:var(--r-lg);padding:15px 16px;
  box-shadow:var(--sh);position:relative;overflow:hidden;transition:box-shadow .18s,transform .18s}
.kpi:hover{box-shadow:var(--sh-lg);transform:translateY(-1px)}
.kpi::after{content:"";position:absolute;inset:0 0 auto 0;height:2px;
  background:linear-gradient(90deg,var(--accent),var(--accent2));opacity:.55}
.kpi .top{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;font-weight:550}
.kpi .ic{width:22px;height:22px;border-radius:7px;background:var(--accent-soft);color:var(--accent);
  display:flex;align-items:center;justify-content:center;flex:none}
.kpi .ic svg{width:13px;height:13px}
.kpi .v{font-size:26px;font-weight:700;letter-spacing:-.02em;margin-top:8px;font-variant-numeric:tabular-nums}
.kpi .v small{font-size:12px;font-weight:500;color:var(--muted);letter-spacing:0}
.kpi .sub{color:var(--muted);font-size:11.5px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kpi.ok .ic{background:var(--ok-soft);color:var(--ok)}
.kpi.warn .ic{background:rgba(247,144,9,.12);color:var(--warn)}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--sh);
  margin-bottom:20px;overflow:hidden}
.phead{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border2)}
.phead h2{font-size:14px;margin:0;font-weight:650;letter-spacing:-.01em}
.phead .cnt{background:var(--accent-soft);color:var(--accent);border-radius:999px;padding:1px 9px;font-size:12px;font-weight:650}
.phead .meta{color:var(--muted);font-size:12px}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-size:13px}
th{padding:9px 18px;text-align:left;color:var(--muted);font-weight:600;font-size:11px;
  text-transform:uppercase;letter-spacing:.05em;background:var(--panel2);border-bottom:1px solid var(--border2);white-space:nowrap}
td{padding:11px 18px;border-bottom:1px solid var(--border2);vertical-align:middle}
tbody tr{transition:background .12s}
tbody tr:hover{background:color-mix(in srgb,var(--accent) 4%,transparent)}
tbody tr:last-child td{border-bottom:none}
.mono{font-family:ui-monospace,"SFMono-Regular",Consolas,monospace;font-size:12px;font-variant-ligatures:none}
.muted{color:var(--muted)}
.tag{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:600}
.tag.live{background:var(--ok-soft);color:var(--ok)}
.tag.file{background:var(--accent-soft);color:var(--accent)}
.tag.dir{background:rgba(139,92,246,.10);color:var(--accent2)}
.tag.none{background:var(--border2);color:var(--muted)}
.path{max-width:430px;word-break:break-all;color:var(--ink2)}
.bar{height:4px;border-radius:999px;background:var(--border2);overflow:hidden;margin-top:5px;width:78px}
.bar>i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--accent),var(--accent2))}
.empty{padding:34px 18px;text-align:center;color:var(--muted)}
.empty .ic{width:40px;height:40px;margin:0 auto 10px;border-radius:12px;background:var(--accent-soft);color:var(--accent);
  display:flex;align-items:center;justify-content:center}
.empty .ic svg{width:19px;height:19px}
.empty .t{color:var(--ink2);font-weight:600;font-size:13.5px;margin-bottom:4px}
.empty .h{font-size:12.5px;line-height:1.7;max-width:520px;margin:0 auto}
.empty code{background:var(--canvas);border:1px solid var(--border);border-radius:5px;padding:1px 6px;
  font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:var(--ink2)}
.banner{display:flex;align-items:center;gap:10px;background:var(--err-soft);border:1px solid color-mix(in srgb,var(--err) 35%,transparent);
  color:var(--err);border-radius:var(--r);padding:10px 14px;margin-bottom:16px;font-size:13px;font-weight:500}
.banner[hidden]{display:none}
.toolbar{display:flex;align-items:center;gap:8px;padding:10px 18px;border-bottom:1px solid var(--border2);flex-wrap:wrap}
.chips{display:flex;gap:6px}
.chip{padding:3px 10px;border-radius:999px;font-size:12px;cursor:pointer;border:1px solid var(--border);
  color:var(--muted);background:transparent;font-weight:500}
.chip.on{background:var(--accent-soft);border-color:color-mix(in srgb,var(--accent) 40%,transparent);color:var(--accent)}
#log{background:var(--code);color:#C7D2E0;height:46vh;min-height:220px;overflow-y:auto;padding:12px 16px;
  font-family:ui-monospace,"SFMono-Regular",Consolas,monospace;font-size:12px;line-height:1.65;white-space:pre-wrap;
  word-break:break-word}
#log .ln{padding:1px 0;border-left:2px solid transparent;padding-left:8px}
#log .err{color:#FDA29B;border-left-color:#F04438;background:rgba(240,68,56,.07)}
#log .fed{color:#9BB0FF}
#log .boot{color:#FDB022;border-left-color:#F79009}
#log .ts{color:#667085}
footer{color:var(--muted);font-size:12px;text-align:center;padding:8px 0 0;line-height:1.9}
footer code{background:var(--canvas);border:1px solid var(--border);border-radius:5px;padding:1px 6px;font-size:11.5px}
@media (max-width:1080px){.kpis{grid-template-columns:repeat(3,1fr)}}
@media (max-width:760px){
  .wrap{padding:0 14px 40px}
  /* 窄屏不挤压列：表格保持最小宽度，靠容器横向滚动（原先是把"运行中"竖排、路径一列一个字） */
  .tw table{min-width:720px}
  .tag{white-space:nowrap}
  .path{max-width:none;white-space:nowrap}
  .kpis{grid-template-columns:repeat(2,1fr);gap:10px}
  .kpi .v{font-size:22px}
  header{flex-wrap:wrap;gap:10px}
  .path{max-width:200px}
  th,td{padding:9px 12px}
  #log{height:40vh}
}
</style></head><body>
<div class="wrap">
<header>
  <div class="brand">
    <div class="logo">M</div>
    <div>
      <h1>graft-Max</h1>
      <div class="sub">仓库上下文图谱 · 联邦工具 · v${version}</div>
    </div>
  </div>
  <div class="sp"></div>
  <span class="pill on" id="livePill"><span class="d"></span><span id="liveText">运行中</span></span>
  <button class="ghost" onclick="toggleTheme()" title="切换亮暗主题" aria-label="切换主题">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
    <span id="themeLabel">亮色</span>
  </button>
  <button class="primary" onclick="poll(true)" title="立即刷新">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
    刷新
  </button>
</header>

<div class="banner" id="banner" hidden>
  <span>⚠</span><span id="bannerText">与 MCP 进程失联</span>
  <div class="sp"></div><button class="sm" onclick="poll(true)">重试</button>
</div>

<div class="kpis">
  <div class="kpi" id="kpiSessions">
    <div class="top"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg></span>活跃会话</div>
    <div class="v" id="cSessions">–</div>
    <div class="sub" id="sSessions">正在使用本服务的会话</div>
  </div>
  <div class="kpi">
    <div class="top"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/></svg></span>累计工具调用</div>
    <div class="v" id="cRequests">–</div>
    <div class="sub" id="sRequests">本进程启动以来</div>
  </div>
  <div class="kpi">
    <div class="top"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg></span>日志大小</div>
    <div class="v" id="cLog">–</div>
    <div class="sub">超过 5MB 自动滚动</div>
  </div>
  <div class="kpi" id="kpiBuild">
    <div class="top"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/></svg></span>建图状态</div>
    <div class="v" id="cBuilding">–</div>
    <div class="sub" id="sBuilding">图谱与代码同步状态</div>
  </div>
  <div class="kpi" id="kpiPanel">
    <div class="top"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg></span>面板地址</div>
    <div class="v" style="font-size:15px"><a href="http://127.0.0.1:${port}" style="color:var(--accent);text-decoration:none">127.0.0.1:${port}</a></div>
    <div class="sub">日志 · 会话 · 存储 · 统计</div>
  </div>
</div>

<div class="panel">
  <div class="phead">
    <h2>活跃会话</h2><span class="cnt" id="nSess">0</span>
    <div class="sp"></div><span class="meta" id="updSess">—</span>
  </div>
  <div class="tw"><table id="sess"><thead><tr><th>状态</th><th>pid</th><th>用户</th><th>仓库</th><th>宿主进程</th><th>请求</th><th>启动时间</th></tr></thead><tbody></tbody></table></div>
</div>

<div class="panel">
  <div class="phead">
    <h2>存储 / 产物</h2><span class="cnt" id="nStore">0</span>
    <div class="sp"></div><span class="meta">每 30s 刷新 · 点「复制」取路径</span>
  </div>
  <div class="tw"><table id="store"><thead><tr><th>产物</th><th>类型</th><th style="width:150px">占用</th><th>路径</th><th style="width:80px"></th></tr></thead><tbody></tbody></table></div>
</div>

<div class="panel">
  <div class="phead">
    <h2>实时日志</h2>
    <div class="sp"></div>
    <span class="meta">刷新间隔 <input id="ms" value="2000" aria-label="刷新间隔毫秒"> ms</span>
  </div>
  <div class="toolbar">
    <div class="chips" id="chips">
      <button class="chip on" data-f="all">全部</button>
      <button class="chip" data-f="err">只看错误</button>
      <button class="chip" data-f="fed">联邦工具</button>
      <button class="chip" data-f="boot">启动/退出</button>
    </div>
    <div class="sp"></div>
    <button class="sm" id="btnPause" onclick="togglePause()">暂停</button>
    <button class="sm" onclick="document.getElementById('log').scrollTop=document.getElementById('log').scrollHeight">回到底部</button>
  </div>
  <div id="log"></div>
</div>

<footer>
  由 <code>GRAFT_MAX_UI</code> 开启 · 默认只绑本机回环；非回环绑定时强制令牌
  （令牌打印在启动 stderr，点带 <code>?token=</code> 的地址即可建立凭据）<br>
  MCP 接入：<code>claude mcp add graft-max --scope user -- node &lt;path&gt;/dist/cli.js mcp</code>
</footer>
</div>
<script>
var S={filter:'all',paused:false,lastLines:[],maxBytes:1};
var timer=null;  // [bugfix] 重写时漏了声明：poll() 读 timer 抛 ReferenceError，自动刷新从未启动
function esc(s){return String(s).split('&').join('&amp;').split('<').join('&lt;').split('"').join('&quot;').split("'").join('&#39;')}
function $(id){return document.getElementById(id)}
function fmtBytes(b){if(b>=1073741824)return (b/1073741824).toFixed(2)+' GB';if(b>=1048576)return (b/1048576).toFixed(1)+' MB';if(b>=1024)return (b/1024).toFixed(1)+' KB';return b+' B'}
function ago(ts){var d=Math.round((Date.now()-ts)/1000);if(d<5)return '刚刚';if(d<60)return d+' 秒前';return Math.round(d/60)+' 分钟前'}
function setPill(on){var p=$('livePill');p.className='pill '+(on?'on':'off');$('liveText').textContent=on?'运行中':'失联'}
function showBanner(msg){var b=$('banner');if(msg){$('bannerText').textContent=msg;b.hidden=false}else b.hidden=true}
function applyTheme(t){document.documentElement.dataset.theme=t;$('themeLabel').textContent=t==='dark'?'亮色':'暗色'}
function toggleTheme(){var t=document.documentElement.dataset.theme==='dark'?'light':'dark';applyTheme(t);try{localStorage.setItem('gm-theme',t)}catch(e){}}
try{var saved=localStorage.getItem('gm-theme');applyTheme(saved||(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'));}catch(e){}

function emptyRow(cols,icon,title,hint){return '<tr><td colspan='+cols+'><div class="empty">'+
  '<div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">'+icon+'</svg></div>'+
  '<div class="t">'+title+'</div><div class="h">'+hint+'</div></div></td></tr>'}

async function loadSessions(){
  try{
    var rows=await (await fetch('/sessions')).json();
    $('cSessions').textContent=rows.length;$('nSess').textContent=rows.length;$('updSess').textContent=ago(Date.now());
    var tb=document.querySelector('#sess tbody');tb.innerHTML='';
    if(!rows.length){
      tb.innerHTML=emptyRow(7,'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>',
        '暂无可用的 MCP 会话',
        '在任意仓库里启动 MCP server 后，这里会显示谁在用、用的是哪个仓库。<br>例：<code>node dist/cli.js mcp &lt;仓库路径&gt;</code>');
      $('sSessions').textContent='等待 MCP 宿主连接';
      $('kpiSessions').className='kpi warn';
      return;
    }
    $('kpiSessions').className='kpi ok';
    $('sSessions').textContent=rows.map(function(r){return r.user}).filter(function(v,i,a){return a.indexOf(v)===i}).join(' / ')+' 正在使用';
    for(var i=0;i<rows.length;i++){var s=rows[i];
      tb.insertAdjacentHTML('beforeend','<tr>'+
        '<td><span class="tag live"><span style="width:5px;height:5px;border-radius:50%;background:currentColor;display:inline-block"></span>运行中</span></td>'+
        '<td class="mono">'+esc(s.pid)+'</td>'+
        '<td>'+esc(s.user)+'</td>'+
        '<td class="mono path" title="'+esc(s.cwd)+'">'+esc(s.cwd)+'</td>'+
        '<td class="mono muted">'+esc(s.hostPid==null?'?':s.hostPid)+' '+esc(String(s.hostCmd||'').split(/[\\\\/]/).pop())+(s.host?' <span class="tag none">'+String(s.host).slice(0,8)+'</span>':'')+'</td>'+
        '<td class="mono">'+esc(s.requests)+'</td>'+
        '<td class="muted">'+esc(new Date(s.startedAt).toLocaleString('zh-CN'))+'</td></tr>')}
    setPill(true);
  }catch(e){$('cSessions').textContent='–';setPill(false);showBanner('与 MCP 进程失联，正在重试…')}
}

async function loadStats(){
  try{
    var s=await (await fetch('/stats')).json();
    showBanner('');
    setPill(true);
    $('cRequests').textContent=s.requests;
    $('sRequests').textContent=s.requests>0?'本进程启动以来':'还没有工具调用';
    var bEl=$('cBuilding'),bld=s.building&&s.building.length;
    bEl.textContent=bld?('建图中 · '+s.building.length):'空闲';
    $('kpiBuild').className='kpi'+(bld?' warn':' ok');
    $('sBuilding').textContent=bld?('正在解析：'+s.building[0]):'图谱已就绪';
    $('cLog').innerHTML=(s.logBytes/1024).toFixed(1)+' <small>KB</small>';
  }catch(e){showBanner('面板接口无响应，MCP 进程可能已退出')}
}

async function loadStorage(){
  try{
    var s=await (await fetch('/storage')).json();
    var max=1;s.entries.forEach(function(e){if(e.bytes>max)max=e.bytes});S.maxBytes=max;
    $('nStore').textContent=s.entries.filter(function(e){return e.exists}).length+' / '+s.entries.length;
    var tb=document.querySelector('#store tbody');tb.innerHTML='';
    if(!s.entries.length){tb.innerHTML=emptyRow(5,'<path d="M3 7h18M3 12h18M3 17h18"/>','没有可统计的产物','');return}
    s.entries.forEach(function(e){
      var pct=e.exists&&max>0?Math.max(2,Math.round(e.bytes/max*100)):0;
      var size=e.exists?fmtBytes(e.bytes):'<span class="tag none">未创建</span>';
      var bar=e.exists&&e.kind==='dir'&&e.bytes>0?'<div class="bar"><i style="width:'+pct+'%"></i></div>':'';
      tb.insertAdjacentHTML('beforeend','<tr>'+
        '<td>'+esc(e.label)+'</td>'+
        '<td><span class="tag '+(e.kind==='dir'?'dir':'file')+'">'+(e.kind==='dir'?'目录':'文件')+'</span></td>'+
        '<td class="mono">'+size+bar+'</td>'+
        '<td class="mono path" title="'+esc(e.path)+'">'+esc(e.path)+'</td>'+
        '<td><button class="sm ghost" onclick="copyPath(this)" data-p="'+esc(e.path)+'">复制</button></td></tr>')})
  }catch(e){}
}
function copyPath(btn){
  var p=btn.dataset.p;
  function done(){btn.textContent='已复制';setTimeout(function(){btn.textContent='复制'},1200)}
  function fallback(){try{var t=document.createElement('textarea');t.value=p;document.body.appendChild(t);t.select();document.execCommand('copy');document.body.removeChild(t);done()}catch(e){btn.textContent='复制失败';setTimeout(function(){btn.textContent='复制'},1500)}}
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(p).then(done,fallback)}else fallback()
}

function lineClass(l){
  if(l.indexOf('isError=true')>=0)return 'err';
  if(l.indexOf('[联邦]')>=0||l.indexOf('[fed')>=0)return 'fed';
  if(l.indexOf('服务启动')>=0||l.indexOf('服务退出')>=0||l.indexOf('boot')>=0||l.indexOf('dashboard:')>=0)return 'boot';
  if(l.charAt(0)==='[')return 'ts';
  return '';
}
function renderLog(){
  var el=$('log');
  var lines=S.lastLines;
  if(!lines.length||(lines.length===1&&!lines[0])){
    el.innerHTML='<div class="ln ts">暂无日志。开启 <b>GRAFT_MAX_LOG=1</b> 后，工具调用、联邦子进程、服务启停都会记录在这里。</div>';
    return;
  }
  var html='';
  for(var i=0;i<lines.length;i++){
    var c=lineClass(lines[i]);
    if(S.filter!=='all'&&c!==S.filter)continue;
    html+='<div class="ln '+c+'">'+esc(lines[i])+'</div>';
  }
  el.innerHTML=html||'<div class="ln ts">当前筛选下没有匹配的日志</div>';
}
async function poll(force){
  // 暂停 = 暂停全部自动刷新（KPI/会话/日志都停）；手动「刷新」按钮始终有效
  if(S.paused&&!force)return;
  try{
    var t=await (await fetch('/tail?n=400')).text();
    var el=$('log');
    var atBottom=el.scrollTop+el.clientHeight>=el.scrollHeight-50;
    S.lastLines=t.split(String.fromCharCode(10));
    renderLog();
    if(atBottom||force)el.scrollTop=el.scrollHeight;
  }catch(e){}
  loadSessions();loadStats();
  if(!globalThis._stTimer){loadStorage();globalThis._stTimer=setInterval(loadStorage,30000)}
  if(!timer)startTimer();
}
function togglePause(){S.paused=!S.paused;$('btnPause').textContent=S.paused?'继续':'暂停';$('btnPause').className='sm'+(S.paused?'':' ghost')}
function startTimer(){
  if(timer)clearInterval(timer);
  var ms=function(){var v=parseInt($('ms').value);return isNaN(v)?2000:Math.max(500,v)};
  timer=setInterval(function(){poll(false)},ms());
}
$('chips').addEventListener('click',function(ev){
  var b=ev.target.closest('.chip');if(!b)return;
  S.filter=b.dataset.f;
  Array.prototype.forEach.call(this.querySelectorAll('.chip'),function(c){c.classList.toggle('on',c===b)});
  renderLog();
});
$('ms').addEventListener('change',startTimer);
poll(true);
</script></body></html>`;
}

