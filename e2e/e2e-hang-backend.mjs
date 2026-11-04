/**
 * [假死后端 E2E] gitnexus 指向一个"握手成功、query 永远沉默"的假进程。
 * 实测三件事：
 *   1. 请求耗时被硬超时兜住（45s 上限；返回 isError=true 而不是永远挂起）
 *   2. 超时窗口内 server 对其它请求仍有响应（无队头阻塞）
 *   3. 会话路径 vs one-shot 路径都有超时（两条路径都不能死等）
 */
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = 'D:/自研工具/graft-Max/dist/cli.js';
const sandbox = mkdtempSync(join(tmpdir(), 'gm-hang2-'));
const home = join(sandbox, 'home');
const repo = join(sandbox, 'repo');
const bin = join(sandbox, 'bin');
for (const d of [home, join(repo, 'src'), bin]) mkdirSync(d, { recursive: true });
writeFileSync(join(repo, 'src', 'm.ts'), 'export function add(a: number, b: number): number { return a + b; }\n');
execFileSync(process.execPath, [CLI, 'build', '.'], { cwd: repo, stdio: 'ignore', timeout: 180000, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '' } });

// 假死 gitnexus：initialize 立即回（握手成功 → 会话建立），query 永不回。
const HANG_BODY = `let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf(String.fromCharCode(10)))>=0){const l=b.slice(0,i);b=b.slice(i+1);try{const m=JSON.parse(l);if(m.id!==undefined&&m.method==='initialize'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'hang',version:'0'}}})+String.fromCharCode(10));}}catch(e){}}});setInterval(()=>{},1000);`;
writeFileSync(join(bin, 'gitnexus.cmd'), `@echo off\r\nnode -e "${HANG_BODY.replace(/"/g, '\\"')}" %*`, 'utf8');
const sh = join(bin, 'gitnexus');
writeFileSync(sh, `#!/bin/sh\nnode -e '${HANG_BODY.replace(/'/g, "\\'")}' "$@"\n`, 'utf8');
try { chmodSync(sh, 0o755); } catch { /* Windows */ }

const c = spawn(process.execPath, [CLI, 'mcp', repo], {
  env: {
    ...process.env, USERPROFILE: home, HOME: home,
    PATH: `${bin};${process.env.PATH ?? ''}`,
    GRAFT_MAX_LOG: '1', GRAFT_MAX_MCP: '1', GRAFT_TEST: '1', GRAFT_MAX_LEASH: '0',
  },
  windowsHide: true,
});
c.stderr.on('data', () => {});

const replies = new Map();
let buf = '';
c.stdout.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (l) { try { const m = JSON.parse(l); if (m.id !== undefined) replies.set(m.id, m); } catch { /* noise */ } }
  }
});
const send = (o) => c.stdin.write(`${JSON.stringify(o)}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`); };

try {
  send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'h2', version: '0' } } });
  await wait(500);
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

  console.log('== 1) 假死 gitnexus：max_trace_arch 必须被**总预算**兜住（≤62s；旧行为是 100s+ 无回包）==');
  const t0 = Date.now();
  send({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'max_trace_arch', arguments: { query: 'entry' } } });
  while (!replies.has(10) && Date.now() - t0 < 100000) await wait(200);
  const ms1 = Date.now() - t0;
  const done = replies.has(10);
  const r1 = done ? replies.get(10).result : null;
  check('1a 请求有回包（不永远挂起）', done, `${ms1}ms`);
  check('1b isError=true（软错误，带修复指引）', done && r1?.isError === true, done ? (r1?.content?.[0]?.text ?? '').slice(0, 90) : 'no reply');
  check('1c 耗时 ≤ 62s（总预算 60s 生效，不再串联各段超时）', ms1 <= 62_000, `${ms1}ms`);

  console.log('== 2) 慢请求期间 server 对其它请求仍有响应（无队头阻塞）==');
  const t1 = Date.now();
  send({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'max_check_freshness', arguments: {} } });
  while (!replies.has(20) && Date.now() - t1 < 20000) await wait(100);
  check('2a max_check_freshness < 5s（未被假死请求拖死）', replies.has(20) && Date.now() - t1 < 5000, `${Date.now() - t1}ms`);

  console.log('== 3) 会话复用路径同样被兜住（第二次 query 不卡更久）==');
  const t2 = Date.now();
  send({ jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'max_trace_arch', arguments: { query: 'again' } } });
  while (!replies.has(30) && Date.now() - t2 < 100000) await wait(200);
  const ms3 = Date.now() - t2;
  check('3a 第二次请求也有回包', replies.has(30), `${ms3}ms`);
  check('3b isError=true', replies.has(30) && replies.get(30).result?.isError === true, '');

  console.log('== 4) server 本体存活（假死后端不能拖垮 MCP server）==');
  check('4a server 进程仍活着', !c.killed && c.exitCode === null, '');
} catch (e) {
  check(`异常：${e.message}`, false);
} finally {
  try { c.stdin.end(); c.kill(); } catch { /* gone */ }
  setTimeout(() => { try { rmSync(sandbox, { recursive: true, force: true, maxRetries: 5 }); } catch { /* EPERM on Windows, non-fatal */ } }, 1500);
}

console.log(`\n假死后端 E2E: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
