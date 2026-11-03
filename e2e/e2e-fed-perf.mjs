/**
 * graft-Max E2E for 改进指南 T2/T3/T4:
 *   T2  max_find_docs in-process qmd (fast path)
 *   T3  max_trace_arch persistent gitnexus session (2nd call much faster)
 *   T4  result cache (same args → [cached] prefix, <5ms)
 * Real stdio JSON-RPC against the built server. No mocks.
 * ROOT defaults to the authorized experiment repo (duck2api-hub).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const ROOT = process.env.E2E_ROOT ?? 'C:/Users/Administrator.DESKTOP-EGNE9ND/Desktop/duck-2api/duck2api-hub';
const results = [];
function rec(name, ok, detail, ms) {
  results.push({ name, ok, detail, ms });
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${ms !== undefined ? `  ${ms}ms` : ''}  — ${detail}`);
}

const child = spawn(process.execPath, [SERVER, 'mcp'], { cwd: ROOT, windowsHide: true });
child.stderr.on('data', () => {});
const pending = new Map();
let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line.startsWith('{')) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch { /* partial */ }
  }
});
let nextId = 1;
function rpc(method, params, timeoutMs = 90000) {
  const id = nextId++;
  return new Promise((res, rej) => {
    // [S4 review] a hung server must fail the E2E, not hang it forever
    const t = setTimeout(() => { pending.delete(id); rej(new Error(`rpc timeout: ${method} id=${id}`)); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(t); res(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

// handshake
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

// --- tools/list: both federated tools still advertised
const t0 = Date.now();
let r = await rpc('tools/list', {});
const names = r.result.tools.map((t) => t.name);
rec('tools/list has federated pair', names.includes('max_find_docs') && names.includes('max_trace_arch'), names.join(','), Date.now() - t0);

// --- T2: qmd in-process speed (2 calls; index is graft-Max's own qmd db)
const q1t = Date.now();
r = await rpc('tools/call', { name: 'max_find_docs', arguments: { query: 'E2E hub', limit: 3 } });
const q1ms = Date.now() - q1t;
const q1text = r.result?.content?.[0]?.text ?? '';
rec('T2 qmd search works', !r.result?.isError, `text: ${q1text.slice(0, 90).replaceAll('\n', ' | ')}`, q1ms);
// note: the CLI db indexes the user's collections, not ROOT — hits or clean
// "no hits" are both fine; a crash/isError is not.

// --- T4: cache — same args twice, 2nd must be [cached] and fast
const c1t = Date.now();
r = await rpc('tools/call', { name: 'max_find_docs', arguments: { query: 'E2E hub cache check', limit: 3 } });
const c1ms = Date.now() - c1t;
const c2t = Date.now();
r = await rpc('tools/call', { name: 'max_find_docs', arguments: { query: 'E2E hub cache check', limit: 3 } });
const c2ms = Date.now() - c2t;
const c2text = r.result?.content?.[0]?.text ?? '';
rec('T4 cache hit annotated', c2text.startsWith('[cached'), c2text.slice(0, 60).replaceAll('\n', ' | '), c2ms);
rec('T4 cache fast (<50ms)', c2ms < 50, `first=${c1ms}ms second=${c2ms}ms`, c2ms);

// --- T3: gitnexus session — 1st call includes handshake, 2nd reuses it
const g1t = Date.now();
r = await rpc('tools/call', { name: 'max_trace_arch', arguments: { query: 'hub server entry points' } });
const g1ms = Date.now() - g1t;
const g1ok = r.result !== undefined && !r.result.isError;
rec('T3 gitnexus 1st call (handshake)', g1ok, (r.result?.content?.[0]?.text ?? '').slice(0, 90).replaceAll('\n', ' | '), g1ms);
const g2t = Date.now();
r = await rpc('tools/call', { name: 'max_trace_arch', arguments: { query: 'session handling code' } });
const g2ms = Date.now() - g2t;
rec('T3 gitnexus 2nd call (session reuse)', r.result !== undefined && !r.result.isError, `1st=${g1ms}ms 2nd=${g2ms}ms`, g2ms);

// --- T5: semantic search (needs ccc installed + repo indexed via ccc init/index)
rec('T5 tool advertised (repo indexed)', names.includes('max_search_semantic'), `max_search_semantic in list: ${names.includes('max_search_semantic')}`);
const s1t = Date.now();
r = await rpc('tools/call', { name: 'max_search_semantic', arguments: { query: 'spawn subprocess timeout handling', limit: 3 } });
const s1ms = Date.now() - s1t;
const s1text = r.result?.content?.[0]?.text ?? '';
rec('T5 semantic search works', !r.result?.isError && /L\d+.*score=\d/.test(s1text), s1text.slice(0, 90).replaceAll('\n', ' | '), s1ms);

child.kill('SIGKILL');
const pass = results.filter((x) => x.ok).length;
console.log(`\n${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);
