/**
 * graft-Max Docker 部署 E2E（真实容器、真实 MCP 协议、真实 dashboard）。
 *
 * 覆盖：
 *   D1  镜像存在 + 版本正确（容器内 node dist/cli.js --version）
 *   D2  MCP stdio 全握手（initialize → tools/list）——docker run -i 驱动
 *   D3  真实工具调用：max_find_code 在挂载的仓库上返回结果
 *   D4  dashboard 端口可达 + /stats /storage 真实响应（容器内建图产物写入挂载卷）
 *   D5  容器非 root 运行（安全基线）
 *   D6  常驻模式 GRAFT_MAX_LEASH=0 不会被 stdin leash 自杀（30s 存活检查）
 *
 * 前置：docker build -f Dockerfile.max -t graft-max:latest .
 * 运行：node e2e/e2e-docker.mjs
 */
import { spawn, spawnSync } from 'node:child_process';

const IMAGE = process.env.E2E_DOCKER_IMAGE ?? 'graft-max:latest';
const REPO = process.env.E2E_ROOT ?? 'C:/Users/Administrator.DESKTOP-EGNE9ND/Desktop/duck-2api/duck2api-hub';
const results = [];
function rec(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}  — ${detail}`);
}

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, ...opts });
}

// ---- D1 镜像 + 版本
{
  const r = sh('docker', ['run', '--rm', '--entrypoint', 'node', IMAGE, '/app/dist/cli.js', '--version']);
  const v = (r.stdout ?? '').trim();
  rec('D1 镜像内版本', /^0\.28\.0-max\.\d+$/.test(v), `version=${v || '(none)'} err=${(r.stderr ?? '').slice(0, 80)}`);
}

// ---- D5 非 root
{
  const r = sh('docker', ['run', '--rm', '--entrypoint', 'id', IMAGE, '-un']);
  const who = (r.stdout ?? '').trim();
  rec('D5 非 root 运行', who === 'node', `uid=${who || '(none)'}`);
}

// ---- D2 + D3：真实 MCP 会话（stdin 驱动，和 Claude Code 的方式一致）
await new Promise((resolve) => {
  const c = spawn('docker', ['run', '-i', '--rm', '-v', `${REPO}:/workspace`, IMAGE, 'mcp', '/workspace'], {
    windowsHide: true,
  });
  let id = 1;
  const pending = new Map();
  let buf = '';
  c.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      } catch {/* partial */}
    }
  });
  const rpc = (method, params, ms = 90000) => new Promise((res, rej) => {
    const rid = id++;
    const t = setTimeout(() => { pending.delete(rid); rej(new Error(`timeout ${method}`)); }, ms);
    pending.set(rid, (m) => { clearTimeout(t); res(m); });
    c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n');
  });

  (async () => {
    try {
      const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
      c.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      rec('D2 MCP initialize', /^0\.28\.0-max\.\d+$/.test(init.result?.serverInfo?.version ?? ''), `server=${init.result?.serverInfo?.name} v=${init.result?.serverInfo?.version}`);

      const list = await rpc('tools/list', {});
      const names = (list.result?.tools ?? []).map((t) => t.name);
      rec('D2 tools/list 有 max_* 六件套', names.filter((n) => n.startsWith('max_')).length >= 6, names.join(','));

      const call = await rpc('tools/call', { name: 'max_find_code', arguments: { query: 'hub server entry', limit: 2 } }, 120000);
      const text = call.result?.content?.[0]?.text ?? '';
      rec('D3 真实工具调用（挂载仓库）', call.result !== undefined && (!call.result.isError || text.length > 0), `isError=${call.result?.isError} text=${text.slice(0, 70).replaceAll('\n', ' | ')}`);
    } catch (e) {
      rec('D2/D3 MCP 会话', false, String(e.message).slice(0, 120));
    } finally {
      c.kill('SIGKILL');
      resolve();
    }
  })();
});

// ---- D4 + D6：常驻容器（dashboard 端口 + leash 关闭存活）
{
  const name = 'graft-max-e2e';
  sh('docker', ['rm', '-f', name]);
  // [N1] 宿主侧端口只发布到回环（与 docker-compose.max.yml 同一纪律）：
  // `-p 24799:24799` 会绑所有网卡，等于把开发日志面板暴露到整个网段。
  const r = spawn('docker', ['run', '-d', '--name', name, '-p', '127.0.0.1:24799:24799', '-e', 'GRAFT_MAX_UI=24799', '-e', 'GRAFT_MAX_LOG=1', '-e', 'GRAFT_MAX_LEASH=0', '-v', `${REPO}:/workspace`, IMAGE, 'mcp', '/workspace'], { windowsHide: true });
  await new Promise((res) => r.on('close', res));
  // 等 dashboard 起来（最多 60s；容器内首次建图可能慢，但 /stats 不等建图）
  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) {
    try { const t = await fetch('http://127.0.0.1:24799/healthz'); ready = t.ok; } catch { /* not yet */ }
    if (!ready) await new Promise((res) => setTimeout(res, 2000));
  }
  const up = sh('docker', ['inspect', '-f', '{{.State.Running}}', name]).stdout?.trim();
  rec('D6 常驻模式存活（leash 关闭）', up === 'true', `State.Running=${up} healthzReady=${ready}`);

  // [N1] 容器形态 = 非回环绑定 = 强制令牌。令牌只在 stderr 打一次（不进 mcp.log）。
  const logsForToken = sh('docker', ['logs', '--tail', '60', name]);
  const tokenLog = `${logsForToken.stdout ?? ''}${logsForToken.stderr ?? ''}`;
  const tokM = /dashboard: http:\/\/[^\s]+\?token=([0-9a-f]+)/.exec(tokenLog);
  const TOKEN = tokM?.[1] ?? '';
  rec('D4a 容器形态强制令牌（stderr 带 ?token= 的 URL）', TOKEN.length >= 16, `token=${TOKEN ? TOKEN.slice(0, 6) + '…' : '(none)'}`);

  let stats = null;
  let storage = null;
  try {
    const noAuth = await fetch('http://127.0.0.1:24799/stats');
    rec('D4b 无令牌打数据端点 → 401', noAuth.status === 401, `status=${noAuth.status}`);
    const hz = await fetch('http://127.0.0.1:24799/healthz');
    rec('D4c /healthz 无鉴权 → 200（容器 healthcheck 依赖它）', hz.status === 200, `status=${hz.status}`);
    const q = TOKEN ? `?token=${TOKEN}` : '';
    const rs = await fetch(`http://127.0.0.1:24799/stats${q}`);
    stats = rs.ok ? await rs.json() : null;
    const rt = await fetch(`http://127.0.0.1:24799/storage${q}`);
    storage = rt.ok ? await rt.json() : null;
    rec('D4d 带令牌 /stats → 200', rs.status === 200, `status=${rs.status}`);
  } catch (e) {
    rec('D4 dashboard 端口', false, String(e.message).slice(0, 100));
  }
  if (stats) rec('D4 /stats 真实响应', typeof stats.requests === 'number', `requests=${stats.requests} toolStats=${Object.keys(stats.toolStats ?? {}).length} fedHealth=${(stats.fedHealth ?? []).length}`);
  if (storage) rec('D4 /storage 真实响应', Array.isArray(storage.entries) && storage.entries.length >= 5, `${storage.entries?.length} 条产物`);

  // docker logs 把容器 stdout/stderr 分流到本进程的两个管道，合并看
  const logsOut = sh('docker', ['logs', '--tail', '40', name]);
  const logs = `${logsOut.stdout ?? ''}${logsOut.stderr ?? ''}`;
  // boot 行走日志文件（~/.graft-max/mcp.log），面板地址行走 stderr；两处都验
  const logFile = sh('docker', ['exec', name, 'sh', '-c', 'cat /home/node/.graft-max/mcp.log 2>/dev/null | head -40']).stdout ?? '';
  rec('D4 容器日志有 boot 行 + 令牌不落 mcp.log',
      /dashboard: http:\/\//.test(logs) && /graft-Max MCP/.test(logFile) && !logFile.includes('?token='),
      `stderr="${logs.split('\n').filter(Boolean)[0]?.slice(0, 50) ?? ''}" logfile="${logFile.split('\n').filter((l) => /graft-Max MCP/.test(l))[0]?.slice(0, 60) ?? ''}"`);
  sh('docker', ['rm', '-f', name]);
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n== Docker E2E: ${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
