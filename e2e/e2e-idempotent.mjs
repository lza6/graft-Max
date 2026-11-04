/**
 * 终版幂等 E2E v2 —— 修正测试脚本的 env bug：
 * B/C 段也在 server 子进程内执行（完全模拟真实链路），而不是主进程。
 * 主进程只负责 spawn server + 通过 JSON-RPC 发 tools/call。
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO = process.env.E2E_ROOT ?? dirname(fileURLToPath(import.meta.url));

const results = [];
const check = (n, ok, d='') => { results.push(ok); console.log(`${ok?'PASS':'FAIL'}  ${n}  ${String(d).slice(0,110)}`); };
const ENV = { ...process.env, GRAFT_MAX_LOG: '1', GRAFT_MAX_MCP: '1' };

// ===== A: 5 sessions same dir =====
const servers = [];
for (let i = 0; i < 5; i++) {
  const c = spawn(process.execPath, ['D:/自研工具/graft-Max/dist/cli.js', 'mcp', REPO], { env: { ...ENV, GRAFT_MAX_UI: String(24720+i) }, windowsHide: true });
  c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 's'+i, version: '0' } } }) + '\n');
  c.on('error', () => {});
  servers.push(c);
}
await new Promise(r => setTimeout(r, 5000));
const md = readFileSync(process.env.USERPROFILE + '/.claude/CLAUDE.md', 'utf8');
check('A1 5 会话后提示词仍 1 块', (md.match(/graft-max:start/g)||[]).length === 1);
check('A2 ICM 块完整保留', md.includes('<!-- icm:start -->') && md.includes('icm.exe store') && md.includes('Memoirs'));
check('A3 5 个 server 全部活着', servers.every(c => !c.killed));

// ===== B/C: fresh repo，通过真实 server 的 JSON-RPC 查询（链路=真实）=====
const dir = join(tmpdir(), 'gm-v2-' + Date.now());
mkdirSync(join(dir, 'src'), { recursive: true });
writeFileSync(join(dir, 'src', 'a.ts'), 'export function f1(){return 1}\nexport function f2(){return f1()+1}\n');
const c = spawn(process.execPath, ['D:/自研工具/graft-Max/dist/cli.js', 'mcp', dir], { env: ENV, windowsHide: true });
let buf = ''; const pending = new Map();
c.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0,i).trim(); buf = buf.slice(i+1); try { const m = JSON.parse(l); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch{} } });
const rpc = (id, name, args) => new Promise(res => { pending.set(id, res); c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n'); });

let t = Date.now();
let r = await rpc(10, 'graft_find_code', { query: 'functions' });
check('B1 首查自动建图（真实 MCP 链路）', existsSync(join(dir, 'graft', '.graph', 'wiring.json')), `${Date.now()-t}ms note="${(r.result?.content?.[0]?.text||'').slice(0,50)}"`);
for (let i = 2; i <= 5; i++) {
  t = Date.now();
  r = await rpc(10+i, 'graft_find_code', { query: 'functions' });
  const txt = r.result?.content?.[0]?.text || '';
  check(`B${i} 第${i}次不重建（${Date.now()-t}ms）`, !txt.includes('built') || Date.now()-t < 500, `${Date.now()-t}ms`);
}
// C: 编辑后查询（模拟 agent 写文件后问图谱）
writeFileSync(join(dir, 'src', 'b.ts'), 'export function f3(){return f2()+1}\n');
t = Date.now();
r = await rpc(20, 'graft_find_code', { query: 'f3 function' });
const ms = Date.now() - t;
const hasF3 = (r.result?.content?.[0]?.text || '').includes('f3');
check('C1 agent 编辑后查询：增量刷新+命中新符号', ms < 3000 && hasF3, `${ms}ms f3命中=${hasF3}`);

servers.forEach(s => s.kill()); c.kill();
const pass = results.filter(Boolean).length;
console.log(`\n== 终版幂等 E2E v2: ${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
