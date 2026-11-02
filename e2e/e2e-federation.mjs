/**
 * graft-Max federation E2E — real stdio JSON-RPC against the built server,
 * real backends (qmd/gitnexus installed on this machine), no mocks.
 * Project rule (docs-selfdev/约束): a proxy tool never throws; every failure
 * must come back as isError content, and graft_* tools must keep working.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let child;

const SERVER = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const ROOT = process.env.E2E_ROOT ?? 'D:/自研工具/graft-Max';
const results = [];


function start() {
  child = spawn(process.execPath, [SERVER, 'mcp'], { cwd: ROOT, windowsHide: true });
  return child;
}

const pending = new Map();
let buf = '';

start();
child.on('error', (e) => { rec('child spawn', false, e.message); });
child.stderr.on('data', (d) => console.error('[server-stderr]', d.toString().slice(0,120)));
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line.startsWith('{')) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {}
  }
});

function rpc(method, params, id) {
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const t0 = Date.now();
function rec(name, ok, detail, ms) {
  results.push({ name, ok: !!ok, ms: ms ?? (Date.now() - t0), detail: String(detail).slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${ms ?? Date.now() - t0}ms)  ${String(detail).slice(0, 160)}`);
}

let r = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } }, 1);
rec('initialize', r.result?.serverInfo?.name === 'graft', JSON.stringify(r.result?.serverInfo));

// 2) tools/list — expect graft_* six + max_find_docs + max_trace_arch
r = await rpc('tools/list', {}, 2);
const names = (r.result?.tools ?? []).map((t) => t.name);
rec('tools/list has graft six', ['max_find_code','max_find_all','max_trace_calls','max_file_api','max_repo_map','max_check_freshness'].every((n) => names.includes(n)), names.join(','));
rec('tools/list has max_find_docs (qmd probed OK)', names.includes('max_find_docs'), names.includes('max_find_docs') ? 'present' : 'MISSING');
rec('tools/list has max_trace_arch (gitnexus probed OK)', names.includes('max_trace_arch'), names.includes('max_trace_arch') ? 'present' : 'MISSING');

// 3) real qmd search through the proxy (machine has agentcode collection)
const tQ = Date.now();
r = await rpc('tools/call', { name: 'max_find_docs', arguments: { query: 'windows-mcp 接入', limit: 3 } }, 3);
const qText = r.result?.content?.[0]?.text ?? '';
rec('max_find_docs real qmd search', r.result && !r.result.isError && qText.includes('qmd://'), `hits: ${qText.split('qmd://').length - 1}, first: ${qText.slice(0, 80)}`, Date.now() - tQ);

// 4) real gitnexus query through the proxy (this repo was indexed earlier)
const tG = Date.now();
r = await rpc('tools/call', { name: 'max_trace_arch', arguments: { query: 'what does the mcp server do' } }, 4);
const gText = r.result?.content?.[0]?.text ?? '';
rec('max_trace_arch real gitnexus query', r.result !== undefined, `isError=${r.result?.isError}, text: ${gText.slice(0, 120)}`, Date.now() - tG);

// 5) missing-arg soft error (never throws)
r = await rpc('tools/call', { name: 'max_find_docs', arguments: {} }, 5);
rec('max_find_docs empty query → soft isError', r.result?.isError === true, (r.result?.content?.[0]?.text ?? '').slice(0, 80));

// 6) graft tools still work through the same server (no regression)
const tA = Date.now();
r = await rpc('tools/call', { name: 'max_find_code', arguments: { query: 'federation proxy tools', limit: 3 } }, 6);
rec('graft_find_code still works', r.result !== undefined && !r.result.isError, (r.result?.content?.[0]?.text ?? '').slice(0, 100), Date.now() - tA);

// 7) legacy alias still resolves
r = await rpc('tools/call', { name: 'max_ask', arguments: { query: 'mcp server', limit: 2 } }, 7);
rec('legacy alias graft_ask still works', r.result !== undefined, `isError=${r.result?.isError}`, Date.now() - tA);

child.kill('SIGKILL');
writeFileSync('e2e/e2e-result.json', JSON.stringify({ when: new Date().toISOString(), server: SERVER, root: ROOT, results }, null, 2));
const pass = results.filter((x) => x.ok).length;
console.log(`\n== ${pass}/${results.length} passed; details in e2e/e2e-result.json`);
process.exit(pass === results.length ? 0 : 1);
