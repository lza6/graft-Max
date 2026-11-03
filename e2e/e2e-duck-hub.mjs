/**
 * duck2api-hub 真实 E2E —— 全链路：
 *  1. 无图仓库首查 → 自动建图（测量）
 *  2. 二查直连 + max_find_code 真实回答
 *  3. max_find_docs / max_trace_arch 联邦真实调用
 *  4. dashboard 24688 显示该会话 + 请求数
 */
import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { existsSync } from 'node:fs';

const REPO = 'C:/Users/Administrator.DESKTOP-EGNE9ND/Desktop/duck-2api/duck2api-hub';
const results = [];
const check = (n, ok, d='') => { results.push(ok); console.log(`${ok?'PASS':'FAIL'}  ${n}  ${String(d).slice(0,130)}`); };
const getJson = (p) => new Promise((res, rej) => get(`http://127.0.0.1:24688${p}`, r => { let b=''; r.on('data',d=>b+=d); r.on('end',()=>res(JSON.parse(b))); }).on('error', rej));

const hadGraph = existsSync(REPO + '/graft/.graph/wiring.json');
console.log(`(测试前图谱已存在: ${hadGraph} — 无论哪种都继续验证)`);

const c = spawn(process.execPath, ['D:/自研工具/graft-Max/dist/cli.js', 'mcp', REPO], { env: { ...process.env, GRAFT_MAX_LOG: '1', GRAFT_MAX_UI: '24688', GRAFT_MAX_MCP: '1' }, windowsHide: true });
c.stderr.on('data', ()=>{});
let buf=''; const pend=new Map();
c.stdout.on('data', d=>{ buf+=d; let i; while((i=buf.indexOf('\n'))>=0){ const l=buf.slice(0,i).trim(); buf=buf.slice(i+1); try{const m=JSON.parse(l); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}}catch{} } });
const rpc=(id,name,args)=>new Promise(res=>{pend.set(id,res);c.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})+'\n');});
const rpcRaw=(id,method,params)=>new Promise(res=>{pend.set(id,res);c.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});

// 1) initialize + tools/list
await rpcRaw(1,'initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'duck-e2e',version:'0'}});
const list=await rpcRaw(2,'tools/list',{});
const names=(list.result?.tools??[]).map(t=>t.name);
check('1 tools/list 8 个 max_* 工具', names.length>=8 && names.every(n=>n.startsWith('max_')), names.join(','));

// 2) 首查（建图或直连都算通过，测真实耗时）
let t=Date.now();
const q1=await rpc(3,'max_find_code',{query:'项目入口 main 函数'});
const ms1=Date.now()-t;
check('2 max_find_code 真实回答', !q1.result?.isError && (q1.result?.content?.[0]?.text||'').length>50, `${ms1}ms "${(q1.result?.content?.[0]?.text||'').slice(0,60)}"`);
console.log(`   (首查耗时 ${ms1}ms — ${hadGraph?'已有图直连':'含自动建图'})`);

// 3) 二查
t=Date.now();
const q2=await rpc(4,'max_find_code',{query:'配置文件处理'});
check('3 二查直连', !q2.result?.isError && Date.now()-t<3000, `${Date.now()-t}ms`);

// 4) 联邦
const q3=await rpc(5,'max_find_docs',{query:'api 网关'});
check('4 max_find_docs 联邦', q3.result!==undefined, `isError=${q3.result?.isError}`);
const q4=await rpc(6,'max_trace_arch',{query:'entry point'});
check('5 max_trace_arch 联邦', q4.result!==undefined, `isError=${q4.result?.isError}`);

// 5) dashboard
await new Promise(r=>setTimeout(r,1500));
try {
  const s=await getJson('/sessions');
  const mine=s.find(x=>x.cwd===REPO);
  check('6 dashboard 显示本会话', !!mine, mine?`requests=${mine.requests}`:'');
  const tail=await new Promise((res,rej)=>get('http://127.0.0.1:24688/tail?n=200',r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>res(b));}).on('error',rej));
  check('7 日志含本次全部调用', ['max_find_code','max_find_docs','max_trace_arch'].every(n=>tail.includes(n)), '');
} catch(e){ check('6 dashboard 可达', false, e.message); }

c.kill();
console.log(`\n== duck2api-hub 真实 E2E: ${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean)?0:1);
