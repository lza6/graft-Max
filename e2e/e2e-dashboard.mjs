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

// [N10 收尾] 端口不能写死：本机可能已有别的实例（比如 compose 容器）占着 24688，
// 我们的 server 会自动 +1~+9 落到别处，写死就会打到别人的面板上（实测被容器的 401 打回）。
// 从 stderr 拿真实端口（面板启动行就是这个），拿不到才退回期望值。
const WANT_PORT = 24688 + (process.pid % 20);
let uiPort = WANT_PORT;
const c = spawn(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'mcp', 'C:/Users/Administrator.DESKTOP-EGNE9ND/Desktop/Agent-Code'], {
  env: { ...process.env, GRAFT_MAX_LOG: '1', GRAFT_MAX_UI: String(WANT_PORT) },
  windowsHide: true,
});
c.stderr.on('data', (buf) => {
  const m = /dashboard: http:\/\/(?:127\.0\.0\.1|0\.0\.0\.0|localhost):(\d+)/.exec(String(buf));
  if (m) uiPort = Number(m[1]);
});
const send = (o) => c.stdin.write(JSON.stringify(o) + '\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), 600);
setTimeout(() => send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'graft_repo_map', arguments: {} } }), 1400);
setTimeout(() => send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'max_find_docs', arguments: { query: 'windows-mcp' } } }), 2200);

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail?.slice(0, 120)}`); };

setTimeout(async () => {
  try {
    const sess = JSON.parse((await fetchLocal(`http://127.0.0.1:${uiPort}/sessions`)).body);
    check('/sessions shows live session', sess.length >= 1 && sess.some((s) => s.cwd.includes('Agent-Code') && s.requests >= 2), JSON.stringify(sess).slice(0, 200));
    const stats = JSON.parse((await fetchLocal(`http://127.0.0.1:${uiPort}/stats`)).body);
    check('/stats log bytes > 0', stats.logBytes > 0, JSON.stringify(stats));
    const tail = (await fetchLocal(`http://127.0.0.1:${uiPort}/tail?n=50`)).body;
    check('/tail has timestamped lines', tail.split('\n').some((l) => /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(l)), tail.split('\n').find((l) => /^\[/.test(l))?.slice(0, 90));
    const page = (await fetchLocal(`http://127.0.0.1:${uiPort}/`)).body;
    // [N8] 面板已拆成真前端工程：HTML 里只有外链 app.js，主题/刷新逻辑在 JS bundle 里。
    // 断言同时覆盖 HTML 与 JS 两份产物，比只看内联 HTML 更强（少一个 404 就能发现）。
    const appJs = (await fetchLocal(`http://127.0.0.1:${uiPort}/app.js`)).body;
    check('/ HTML page (new design)', page.includes('graft-Max Dashboard') && page.includes('活跃会话') && page.includes('app.js'), `${page.length} bytes`);
    check('/app.js bundle served', appJs.length > 5000 && appJs.includes('toggleTheme') && appJs.includes('/reprobe'), `${appJs.length} bytes`);
  } catch (e) {
    check('dashboard reachable', false, e.message);
  }
  c.kill();
  console.log(`\n== ${results.filter((r) => r.ok).length}/${results.length} passed`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}, 6000);
