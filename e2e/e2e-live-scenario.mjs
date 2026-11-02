/**
 * LIVE-SCENARIO E2E — simulates exactly what the user will see in their next
 * Claude Code session: graft-Max starts (log+UI on), the agent makes several
 * tool calls, and the dashboard at http://127.0.0.1:24688 shows
 *   1. the live session row (pid / host / repo / request count growing)
 *   2. real-time log lines for every call
 * Probes the dashboard BEFORE, DURING, and AFTER tool calls.
 */
import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { fileURLToPath } from 'node:url';

const getJson = (p) => new Promise((res, rej) => get(`http://127.0.0.1:24688${p}`, r => { let b=''; r.on('data',d=>b+=d); r.on('end',()=>res(JSON.parse(b))); }).on('error', rej));
const getText = (p) => new Promise((res, rej) => get(`http://127.0.0.1:24688${p}`, r => { let b=''; r.on('data',d=>b+=d); r.on('end',()=>res(b)); }).on('error', rej));

const results = [];
const check = (name, ok, detail='') => { results.push(ok); console.log(`${ok?'PASS':'FAIL'}  ${name}  ${String(detail).slice(0,140)}`); };

const c = spawn(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'mcp', 'C:/Users/Administrator.DESKTOP-EGNE9ND/Desktop/Agent-Code'], {
  env: { ...process.env, GRAFT_MAX_LOG: '1', GRAFT_MAX_UI: '1' }, windowsHide: true,
});
c.stderr.on('data', () => {});
const send = (o) => c.stdin.write(JSON.stringify(o) + '\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'claude-code-sim', version: '2.1.312' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });

// PHASE 1: dashboard reachable, session registered, zero requests yet
await new Promise(r => setTimeout(r, 1500));
try {
  const s = await getJson('/sessions');
  check('P1 session registered before any call', s.length === 1 && s[0].requests === 0, `pid=${s[0]?.pid} requests=${s[0]?.requests}`);
  const st = await getJson('/stats');
  check('P1 stats endpoint live', typeof st.logBytes === 'number' && st.logBytes > 0, `${st.logBytes} bytes`);
} catch (e) { check('P1 dashboard reachable', false, e.message); }

// PHASE 2: three real tool calls (graft + qmd + gitnexus)
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'graft_repo_map', arguments: {} } });
setTimeout(() => send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'max_find_docs', arguments: { query: 'graft-Max dashboard' } } }), 800);
setTimeout(() => send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'max_trace_arch', arguments: { query: 'entry point' } } }), 2000);

// PHASE 3: dashboard reflects the activity
await new Promise(r => setTimeout(r, 6000));
try {
  const s = await getJson('/sessions');
  check('P3 request count grew to >=3 (tools/call only; tools/list not counted)', s.length === 1 && s[0].requests >= 3, `requests=${s[0]?.requests}`);
  const tail = await getText('/tail?n=60');
  check('P3 log shows max_find_docs call', tail.includes('max_find_docs'), '');
  check('P3 log shows max_trace_arch call', tail.includes('max_trace_arch'), '');
  check('P3 log shows qmd child spawn', tail.includes('[fed] qmd spawn'), '');
  check('P3 log shows gitnexus child spawn', tail.includes('[fed] gitnexus spawn'), '');
  const st = await getJson('/stats');
  check('P3 stats requests match', st.requests >= 3, `stats.requests=${st.requests}`);
} catch (e) { check('P3 dashboard reflects activity', false, e.message); }

c.kill();
const pass = results.filter(Boolean).length;
console.log(`\n== LIVE-SCENARIO: ${pass}/${results.length} passed — this is what http://127.0.0.1:24688 shows in your next session`);
process.exit(pass === results.length ? 0 : 1);
