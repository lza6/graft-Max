/**
 * N1 · 面板安全 hardening（P1-1）的回归网。
 *
 * 两层：
 *   1) 纯函数层 —— Host 白名单 / 令牌策略 / 令牌比较 / 令牌提取，逐个矩阵断言。
 *   2) 真实 HTTP 层 —— 用 randomBytes 端口真起 startDashboard()，用 node:http
 *      客户端真发请求（Host 头可任意伪造，fetch() 改不了 Host）。真跑真断言，
 *      不打桩。
 *
 * 为什么用 loopback + 显式 GRAFT_MAX_UI_TOKEN 来验证"强制令牌"那条路径：
 * 绑 0.0.0.0 在 CI/开发机上会碰防火墙授权，且行为等价（策略函数已覆盖
 * `0.0.0.0` 分支，见下面 resolveTokenPolicy 的用例）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { hostname } from 'node:os';
import type { AddressInfo } from 'node:net';
import {
  startDashboard,
  hostOnly,
  isLoopbackBind,
  hostAllowed,
  resolveTokenPolicy,
  tokenMatches,
  extractToken,
} from '../src/mcp/dashboard.js';
import type { Server } from 'node:http';

/* ---------------------------- 测试基础设施 ---------------------------- */

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** 真发一个 GET；`host` 覆盖 Host 头（fetch 不允许改，node:http 允许）。 */
function get(port: number, path: string, opts: { host?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { host: opts.host ?? `127.0.0.1:${port}`, ...(opts.headers ?? {}) },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** 起一个真面板（端口 0 = 随机空闲端口），env 注入后立即还原。 */
async function withServer<T>(env: Record<string, string | undefined>, fn: (port: number) => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  let srv: Server | undefined;
  try {
    srv = startDashboard(0, process.cwd());
    assert.ok(srv, 'startDashboard 应该返回 server（GRAFT_MAX_UI 已设置）');
    if (!srv.listening) await once(srv, 'listening');
    const { port } = srv.address() as AddressInfo;
    return await fn(port);
  } finally {
    if (srv) await new Promise<void>((r) => srv!.close(() => r()));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/* ---------------------------- 1. 纯函数 ---------------------------- */

test('hostOnly 去端口，兼容 [::1]:port 与裸 IPv6', () => {
  assert.equal(hostOnly('127.0.0.1:24688'), '127.0.0.1');
  assert.equal(hostOnly('LOCALHOST'), 'localhost');
  assert.equal(hostOnly('[::1]:24688'), '[::1]');
  assert.equal(hostOnly('[::1]'), '[::1]');
  assert.equal(hostOnly('::1'), '::1');
  assert.equal(hostOnly('example.com:80'), 'example.com');
  assert.equal(hostOnly(''), '');
  assert.equal(hostOnly(undefined), '');
  assert.equal(hostOnly(null), '');
});

test('isLoopbackBind 识别回环绑定', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.0.0.5', '', undefined]) {
    assert.equal(isLoopbackBind(h as string), true, `${String(h)} 应算回环`);
  }
  for (const h of ['0.0.0.0', '192.168.1.5', '::', 'host.docker.internal']) {
    assert.equal(isLoopbackBind(h), false, `${h} 不应算回环`);
  }
});

test('hostAllowed：伪造 Host 一律拒绝，回环与 healthcheck 放行', () => {
  // DNS rebinding 面（实测旧行为是 200）
  assert.equal(hostAllowed('evil.example.com', '127.0.0.1'), false);
  assert.equal(hostAllowed('evil.example.com:24688', '127.0.0.1'), false);
  assert.equal(hostAllowed('evil.example.com', '0.0.0.0'), false);
  // 回环永远放行（容器 healthcheck 固定打 127.0.0.1）
  assert.equal(hostAllowed('127.0.0.1:24688', '127.0.0.1'), true);
  assert.equal(hostAllowed('127.0.0.1', '0.0.0.0'), true);
  assert.equal(hostAllowed('localhost:24688', '127.0.0.1'), true);
  assert.equal(hostAllowed('[::1]:24688', '127.0.0.1'), true);
  assert.equal(hostAllowed('::1', '127.0.0.1'), true);
  // 缺 Host（HTTP/1.1 必须有）→ 拒绝
  assert.equal(hostAllowed(undefined, '127.0.0.1'), false);
  assert.equal(hostAllowed('', '127.0.0.1'), false);
  // 非回环绑定：绑定地址本身 + 本机 hostname 放行
  assert.equal(hostAllowed('0.0.0.0:24688', '0.0.0.0'), true);
  const hn = hostname().trim().toLowerCase();
  if (!['localhost', '127.0.0.1', '::1'].includes(hn)) {
    assert.equal(hostAllowed(hn, '0.0.0.0'), true, 'hostname() 在非回环形态应放行');
    assert.equal(hostAllowed(hn, '127.0.0.1'), false, '回环形态不应额外放行 hostname');
  }
});

test('resolveTokenPolicy：非回环强制令牌，回环默认关', () => {
  // 回环：默认关
  for (const raw of [undefined, '', '  ', '0']) {
    const p = resolveTokenPolicy('127.0.0.1', raw);
    assert.equal(p.required, false, `raw=${String(raw)} 回环应免令牌`);
    assert.equal(p.token, null);
    assert.equal(p.forcedWarn, false);
  }
  // 回环：显式给值才启用
  const on = resolveTokenPolicy('127.0.0.1', 'my-token');
  assert.deepEqual(on, { required: true, token: 'my-token', generated: false, forcedWarn: false });

  // 非回环：未给 → 随机生成 + 强制
  const gen = resolveTokenPolicy('0.0.0.0', undefined);
  assert.equal(gen.required, true);
  assert.equal(gen.generated, true);
  assert.match(gen.token ?? '', /^[0-9a-f]{32}$/, '随机令牌应为 32 位 hex');
  // 两次生成的令牌不同（不是硬编码常量）
  assert.notEqual(resolveTokenPolicy('0.0.0.0', '').token, gen.token);

  // 非回环：显式给值 → 用它
  const explicit = resolveTokenPolicy('192.168.1.5', 'abc123');
  assert.equal(explicit.required, true);
  assert.equal(explicit.token, 'abc123');
  assert.equal(explicit.generated, false);

  // 非回环 + =0（想关）→ 无效应，仍强制生成，并打 warn
  const forced = resolveTokenPolicy('0.0.0.0', '0');
  assert.equal(forced.required, true);
  assert.equal(forced.generated, true);
  assert.equal(forced.forcedWarn, true);
});

test('tokenMatches 用常量时间比较，长度不等不 throw', () => {
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abd', 'abc'), false);
  assert.equal(tokenMatches('abcd', 'abc'), false);
  assert.equal(tokenMatches('', 'abc'), false);
  assert.equal(tokenMatches(null, 'abc'), false);
  assert.equal(tokenMatches('abc', null), false);
  assert.equal(tokenMatches(undefined, undefined), false);
});

test('extractToken 支持 Bearer / ?token= / Cookie gm_ui', () => {
  assert.equal(extractToken({ authorization: 'Bearer t1' }, null), 't1');
  assert.equal(extractToken({ authorization: 'bearer   t2  ' }, null), 't2');
  assert.equal(extractToken({}, 't3'), 't3');
  assert.equal(extractToken({ cookie: 'gm_ui=t4' }, null), 't4');
  assert.equal(extractToken({ cookie: 'a=b; gm_ui=t5; c=d' }, null), 't5');
  assert.equal(extractToken({ cookie: 'gm_ui=t%2F6' }, null), 't/6');
  assert.equal(extractToken({ cookie: 'other=1' }, null), null);
  assert.equal(extractToken({}, null), null);
  assert.equal(extractToken({ authorization: 'Basic zzz' }, null), null);
  // 查询参数优先（它就是页面自举那条 URL 的形态）
  assert.equal(extractToken({ authorization: 'Bearer a' }, 'q'), 'q');
});

/* ---------------------------- 2. 真实 HTTP ---------------------------- */

const TOKEN = 'testtoken123';

test('强制令牌形态（非回环策略）：Host/401/200/healthz/安全头 全矩阵', async () => {
  await withServer({ GRAFT_MAX_UI: '1', GRAFT_MAX_UI_HOST: '127.0.0.1', GRAFT_MAX_UI_TOKEN: TOKEN, GRAFT_MAX_LOG: undefined }, async (port) => {
    const seen: Reply[] = [];
    const track = async (p: string, o?: { host?: string; headers?: Record<string, string> }) => {
      const r = await get(port, p, o);
      seen.push(r);
      return r;
    };

    // (a) Host 伪造 → 403 forbidden host（旧行为是 200）
    const evil = await track('/stats', { host: 'evil.example.com' });
    assert.equal(evil.status, 403);
    assert.equal(evil.body, 'forbidden host');

    const evil2 = await track('/tail', { host: 'evil.example.com:24688' });
    assert.equal(evil2.status, 403, '带端口的伪造 Host 也必须 403');

    // (b) 合法 Host + 无令牌 → 401
    for (const p of ['/tail', '/sessions', '/stats', '/storage']) {
      const r = await track(p);
      assert.equal(r.status, 401, `${p} 无令牌应 401`);
      assert.equal(r.body, 'unauthorized');
    }

    // (c) 三种携带方式 → 200
    const q = await track(`/tail?n=3&token=${TOKEN}`);
    assert.equal(q.status, 200);
    const bearer = await track('/stats', { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(bearer.status, 200);
    const cookie = await track('/sessions', { headers: { cookie: `gm_ui=${TOKEN}` } });
    assert.equal(cookie.status, 200);

    // 错误令牌 → 401（长度相同也不放行）
    const wrong = await track('/tail', { headers: { authorization: 'Bearer testtoken124' } });
    assert.equal(wrong.status, 401);

    // (d) /healthz 无令牌 → 200 且只有 {ok:true}（容器 healthcheck 不会 unhealthy）
    const hz = await track('/healthz');
    assert.equal(hz.status, 200);
    assert.deepEqual(JSON.parse(hz.body), { ok: true });

    // (e) 页面免鉴权，但带 ?token= 会种 Cookie（令牌自举）
    const pagePlain = await track('/');
    assert.equal(pagePlain.status, 200);
    assert.equal(pagePlain.headers['set-cookie'], undefined, '无令牌访问不应种 Cookie');
    assert.match(pagePlain.body, /graft-Max Dashboard/);

    const pageTok = await track(`/?token=${TOKEN}`);
    assert.equal(pageTok.status, 200);
    const setCookie = String(pageTok.headers['set-cookie'] ?? '');
    assert.match(setCookie, /gm_ui=testtoken123/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\//);
    assert.equal(pageTok.body.includes(TOKEN), false, '页面 HTML 里绝不能出现令牌明文');

    // (f) 静态资源免鉴权
    const fav = await track('/favicon.ico');
    assert.equal(fav.status, 200);

    // (g) 所有响应都带安全头
    assert.ok(seen.length >= 12);
    for (const r of seen) {
      assert.equal(r.headers['x-content-type-options'], 'nosniff', `缺 nosniff（status=${r.status}）`);
      assert.equal(r.headers['referrer-policy'], 'no-referrer');
      assert.equal(r.headers['x-frame-options'], 'DENY');
      const csp = String(r.headers['content-security-policy'] ?? '');
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /script-src 'self' 'unsafe-inline'/, '内联脚本要允许 unsafe-inline，否则页面白屏');
    }
  });
});

test('回环默认形态：无令牌可读数据端点（宿主用法行为不变）', async () => {
  await withServer({ GRAFT_MAX_UI: '1', GRAFT_MAX_UI_HOST: '127.0.0.1', GRAFT_MAX_UI_TOKEN: undefined, GRAFT_MAX_LOG: undefined }, async (port) => {
    const tail = await get(port, '/tail?n=1');
    assert.equal(tail.status, 200, '回环形态下不设 GRAFT_MAX_UI_TOKEN 应免令牌');
    assert.equal(tail.headers['x-content-type-options'], 'nosniff');

    const stats = await get(port, '/stats');
    assert.equal(stats.status, 200);
    const body = JSON.parse(stats.body) as { logPath?: string };
    assert.ok(typeof body.logPath === 'string');

    // Host 校验照样生效（这是所有形态的基础线）
    assert.equal((await get(port, '/stats', { host: 'evil.example.com' })).status, 403);
  });
});

test('GRAFT_MAX_UI_TOKEN=0：回环形态显式关闭令牌', async () => {
  await withServer({ GRAFT_MAX_UI: '1', GRAFT_MAX_UI_HOST: '127.0.0.1', GRAFT_MAX_UI_TOKEN: '0', GRAFT_MAX_LOG: undefined }, async (port) => {
    assert.equal((await get(port, '/tail?n=1')).status, 200);
    assert.equal((await get(port, '/healthz')).status, 200);
  });
});

test('GRAFT_MAX_UI 未设置时 dashboard 不启动', async () => {
  const saved = process.env.GRAFT_MAX_UI;
  delete process.env.GRAFT_MAX_UI;
  try {
    assert.equal(startDashboard(0, process.cwd()), undefined);
  } finally {
    if (saved !== undefined) process.env.GRAFT_MAX_UI = saved;
  }
});
