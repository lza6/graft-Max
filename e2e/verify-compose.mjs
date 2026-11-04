/**
 * [发布验收] 部署后的容器实例**冒烟**：不是"容器起来了"，而是"线上这套东西真的能用"。
 *
 * 覆盖：端口只绑回环 / 镜像版本 / healthz / 令牌（401 vs 200）/ 面板资源 / 令牌不落盘 /
 * compose healthy。跑在宿主机上，用 docker CLI + 本机 HTTP。
 *
 * 用法：node e2e/verify-compose.mjs      （先 docker compose -f docker-compose.max.yml up -d）
 */
import { spawnSync } from 'node:child_process';

const NAME = process.env.E2E_CONTAINER ?? 'graft-max-dashboard';
const PORT = Number(process.env.E2E_PORT ?? 24688);
const results = [];
const check = (n, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`);
};
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000 });

// 1) compose 状态
{
  const ps = sh('docker', ['compose', '-f', 'docker-compose.max.yml', 'ps', '--format', '{{.Name}}|{{.Status}}|{{.Ports}}']);
  const line = (ps.stdout ?? '').trim().split('\n').find((l) => l.includes(NAME)) ?? '';
  check('1 compose 服务在跑且 healthy', /Up .*healthy/i.test(line), line || '(none)');
}

// 2) 端口只绑回环
{
  const p = (sh('docker', ['port', NAME]).stdout ?? '').trim();
  check('2 宿主端口只绑 127.0.0.1（不是 0.0.0.0）', /^24688\/tcp -> 127\.0\.0\.1:24688$/m.test(p), p.replaceAll('\n', ' '));
}

// 3) 容器内版本
{
  const v = (sh('docker', ['exec', NAME, 'node', '/app/dist/cli.js', '--version']).stdout ?? '').trim();
  check('3 容器内版本是 max.10', /^0\.28\.0-max\.10$/.test(v), v);
}

// 4) 面板资源在新镜像里（N8 产物）
{
  const ls = (sh('docker', ['exec', NAME, 'sh', '-c', 'ls /app/dist/panel/']).stdout ?? '').replaceAll('\n', ' ').trim();
  check('4 镜像内含 dist/panel/（app.js + index.html + style.css）', /app\.js/.test(ls) && /index\.html/.test(ls) && /style\.css/.test(ls), ls);
}

// 5) healthz 无鉴权
{
  const r = await fetch(`http://127.0.0.1:${PORT}/healthz`).catch((e) => ({ status: 0, text: () => e.message }));
  check('5 /healthz 无鉴权 200', r.status === 200, `status=${r.status}`);
}

// 6) 无令牌 → 401
{
  const r = await fetch(`http://127.0.0.1:${PORT}/stats`).catch((e) => ({ status: 0 }));
  check('6 无令牌 /stats → 401', r.status === 401, `status=${r.status}`);
}

// 7) 从容器日志拿令牌 → 带令牌可用
{
  const logs = sh('docker', ['logs', '--tail', '80', NAME]);
  const all = `${logs.stdout ?? ''}${logs.stderr ?? ''}`;
  const m = /dashboard: http:\/\/[^\s]+\?token=([0-9a-f]+)/.exec(all);
  const token = m?.[1] ?? '';
  check('7 启动日志里有带令牌的 URL（容器形态强制）', token.length >= 16, token ? `${token.slice(0, 6)}…` : '(none)');

  if (token) {
    const s = await fetch(`http://127.0.0.1:${PORT}/stats?token=${token}`).catch(() => ({ status: 0 }));
    const body = s.status === 200 ? await s.json() : {};
    check('7b 带令牌 /stats → 200 且字段齐全', s.status === 200 && typeof body.requests === 'number' && Array.isArray(body.fedHealth), `status=${s.status} fedHealth=${(body.fedHealth ?? []).length}`);
    const bad = await fetch(`http://127.0.0.1:${PORT}/stats?token=deadbeef`).catch(() => ({ status: 0 }));
    check('7c 错误令牌 → 401（不是"有令牌就放行"）', bad.status === 401, `status=${bad.status}`);

    const page = await fetch(`http://127.0.0.1:${PORT}/?token=${token}`).catch(() => ({ status: 0, text: async () => '' }));
    const html = await page.text();
    check('7d 页面自举 Cookie 后可用', page.status === 200 && html.includes('graft-Max Dashboard') && html.includes('app.js'), `status=${page.status} ${html.length}B`);

    const js = await fetch(`http://127.0.0.1:${PORT}/app.js?token=${token}`).catch(() => ({ status: 0, text: async () => '' }));
    const bundle = await js.text();
    check('7e /app.js 在容器里可取（前端工程进了镜像）', js.status === 200 && bundle.length > 5000, `status=${js.status} ${bundle.length}B`);
  }
}

// 8) 令牌绝不落 mcp.log（那正是 /tail 读的文件）
{
  const log = (sh('docker', ['exec', NAME, 'sh', '-c', 'cat /home/node/.graft-max/mcp.log 2>/dev/null | head -200']).stdout ?? '');
  check('8 令牌不在 mcp.log 里（否则 /tail 等于泄露钥匙）', log.length > 0 && !log.includes('?token='), `${log.length} bytes`);
}

const failed = results.filter((r) => !r).length;
console.log(`\n部署冒烟: ${results.length - failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
