/**
 * Dashboard E2E — keeps the MCP server alive while probing the HTTP UI.
 * Verifies: sessions registry (who is using), stats, tail, HTML page.
 * Uses node:http directly against 127.0.0.1 (local, no proxy involvement).
 */
import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { fileURLToPath } from 'node:url';

function fetchLocal(url) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
}

const c = spawn(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'mcp', 'C:/Users/Administrator.DESKTOP-EGNE9ND/Desktop/Agent-Code'], {
  env: { ...process.env, GRAFT_MAX_LOG: '1', GRAFT_MAX_UI: '24688' },
  windowsHide: true,
});
c.stderr.on('data', () => {});
const send = (o) => c.stdin.write(JSON.stringify(o) + '\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), 600);
setTimeout(() => send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'graft_repo_map', arguments: {} } }), 1400);
setTimeout(() => send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'max_find_docs', arguments: { query: 'windows-mcp' } } }), 2200);

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail?.slice(0, 120)}`); };

setTimeout(async () => {
  try {
    const sess = JSON.parse((await fetchLocal('http://127.0.0.1:24688/sessions')).body);
    check('/sessions shows live session', sess.length >= 1 && sess.some((s) => s.cwd.includes('Agent-Code') && s.requests >= 2), JSON.stringify(sess).slice(0, 200));
    const stats = JSON.parse((await fetchLocal('http://127.0.0.1:24688/stats')).body);
    check('/stats log bytes > 0', stats.logBytes > 0, JSON.stringify(stats));
    const tail = (await fetchLocal('http://127.0.0.1:24688/tail?n=50')).body;
    check('/tail has timestamped lines', tail.split('\n').some((l) => /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(l)), tail.split('\n').find((l) => /^\[/.test(l))?.slice(0, 90));
    const page = (await fetchLocal('http://127.0.0.1:24688/')).body;
    // [N8] 面板已拆成真前端工程：HTML 里只有外链 app.js，主题/刷新逻辑在 JS bundle 里。
    // 断言同时覆盖 HTML 与 JS 两份产物，比只看内联 HTML 更强（少一个 404 就能发现）。
    const appJs = (await fetchLocal('http://127.0.0.1:24688/app.js')).body;
    check('/ HTML page (new design)', page.includes('graft-Max Dashboard') && page.includes('活跃会话') && page.includes('app.js'), `${page.length} bytes`);
    check('/app.js bundle served', appJs.length > 5000 && appJs.includes('toggleTheme') && appJs.includes('/reprobe'), `${appJs.length} bytes`);
  } catch (e) {
    check('dashboard reachable', false, e.message);
  }
  c.kill();
  console.log(`\n== ${results.filter((r) => r.ok).length}/${results.length} passed`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}, 6000);
