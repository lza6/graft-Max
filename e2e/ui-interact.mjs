/**
 * [N10] 面板契约测试 —— Playwright 真浏览器，断言"行为正确"，不只是"元素存在"。
 *
 * 为什么要有这个文件：max.9 的教训是"E2E 通过 ≠ UI 正确"——**工具耗时卡片**被
 * 视觉重做静默删掉，旧脚本一条断言都没碰到它。所以这里做两件事：
 *   1. **功能清单逐项勾销**（约束 C1）：旧面板的每个功能都有对应断言；
 *   2. **断言强度**（约束 P3-18）：不看 `!= undefined`，看真实数值/真实请求计数/
 *      真实 DOM 结构，并且监听 `pageerror`——零 JS 错误才允许通过。
 *
 * 自包含：临时 home + 临时仓库（先 graft build 邀请仓库）+ 随机端口 + 令牌，
 * 不依赖本机既有数据；只要 Playwright 可用即可跑。
 *
 * 用法：node e2e/ui-interact.mjs        （需要先 npm run build）
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
const require = createRequire('C:/Users/Administrator.DESKTOP-EGNE9ND/AppData/Roaming/npm/node_modules/');
const { chromium } = require('playwright');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 130)})` : ''}`);
};

const sandbox = mkdtempSync(join(tmpdir(), 'gm-ui-'));
const home = join(sandbox, 'home');
const repo = join(sandbox, 'repo');
mkdirSync(home, { recursive: true });
mkdirSync(join(repo, 'src'), { recursive: true });
writeFileSync(join(repo, 'src', 'math.ts'), 'export function add(a: number, b: number): number { return a + b; }\n', 'utf8');
const quietEnv = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '' };
execFileSync(process.execPath, [CLI, 'build', '.'], { cwd: repo, stdio: 'ignore', timeout: 180_000, env: quietEnv, windowsHide: true });

const PORT = 24700 + (process.pid % 60);
const TOKEN = `e2e-token-${process.pid}`;
const child = spawn(process.execPath, [CLI, 'mcp', repo], {
  env: {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    GRAFT_MAX_LOG: '1',
    GRAFT_MAX_UI: String(PORT),
    GRAFT_MAX_UI_TOKEN: TOKEN,
    GRAFT_MAX_LEASH: '0',
    GRAFT_MAX_MCP: '1',
    GRAFT_TEST: '1',
  },
  windowsHide: true,
});
child.stderr.on('data', () => {});
child.stdout.on('data', () => {});

/** 通过真 stdio 发起一次真实工具调用（面板的"工具耗时"卡才有数据）。 */
const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let browser = null;
let uiUrl = `http://127.0.0.1:${PORT}/?token=${TOKEN}`;

const cleanup = async () => {
  try {
    if (browser) await browser.close();
  } catch {}
  try {
    child.stdin.end();
    child.kill();
  } catch {}
  rmSync(sandbox, { recursive: true, force: true });
};

try {
  // 等面板起来
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    await wait(100);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      up = r.ok;
    } catch {
      /* not yet */
    }
  }
  check('0 面板起来并响应 /healthz', up, `port=${PORT}`);
  if (!up) throw new Error('dashboard never came up');

  // 造真实工具调用：3 次，其中 1 次故意错参数（制造 isError 行给筛选断言用）
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ui', version: '0' } } });
  await wait(400);
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'max_repo_map', arguments: {} } });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'max_find_code', arguments: { query: 'add numbers' } } });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'max_file_api', arguments: { path: 'src/does-not-exist.ts' } } });
  await wait(1200);

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  // 数请求：用 CDP 无关的方式——在页面里包一层 fetch 计数
  await page.addInitScript(() => {
    const orig = window.fetch;
    window.__hits = {};
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
      window.__hits[path] = (window.__hits[path] ?? 0) + 1;
      return orig.call(window, input, init);
    };
  });

  await page.goto(uiUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600); // 至少一个 2s 轮询周期

  // 1) 页面身份
  check('1 页面标题与品牌存在', (await page.title()).includes('graft-Max'), await page.title());
  check('1b 版本号从 /stats 注入（不是硬编码）', /^v0\.28\.0-max\./.test(await page.textContent('#ver')), await page.textContent('#ver'));

  // 2) KPI 卡 ×5
  const kpis = await page.$$eval('.kpis .kpi', (els) => els.length);
  check('2 KPI 卡 5 张', kpis === 5, String(kpis));
  const cRequests = await page.textContent('#cRequests');
  check('2b 累计工具调用有真实数值', /^\d+$/.test(String(cRequests).trim()) && Number(cRequests) >= 3, String(cRequests));

  // 3) 工具耗时卡（max.9 弄丢的那张 —— 本轮的回归钉子）
  const toolRows = await page.$$eval('#tools tbody tr', (trs) => trs.filter((t) => !t.querySelector('.empty')).length);
  check('3 工具耗时卡出现真实数据行', toolRows >= 1, `${toolRows} 行`);
  const toolCells = await page.$$eval('#tools tbody tr:first-child td', (tds) => tds.map((t) => t.textContent?.trim() ?? ''));
  check('3b 工具行含调用数/平均/p50/p95', toolCells.length === 7 && /\d/.test(toolCells[1]) && /ms|s/.test(toolCells[3]), toolCells.join(' | '));
  check('3c p95 ≥ p50（分位计算没写反）', (() => {
    const num = (s) => (String(s).includes('s') && !String(s).includes('ms') ? parseFloat(s) * 1000 : parseFloat(s));
    return num(toolCells[4]) >= num(toolCells[3]);
  })(), `${toolCells[3]} vs ${toolCells[4]}`);

  // 4) 联邦后端卡：三个后端三行 + 至少一个"就绪/未安装"的确定状态
  const fedRows = await page.$$eval('#fed tbody tr', (trs) => trs.length);
  const fedText = await page.textContent('#fed tbody');
  check('4 联邦后端卡 3 行（qmd/gitnexus/ccc）', fedRows === 3, String(fedRows));
  check('4b 至少一个后端有确定探测结果', /就绪|未安装/.test(String(fedText)), String(fedText).slice(0, 60));
  check('4c 每行都带安装/修复命令', (String(fedText).match(/install |npm i/g) ?? []).length >= 3, '');

  // 5) 存储卡：仓库分组标题 + 真实产物行
  const storeGroups = await page.$$eval('#store tbody tr.group', (trs) => trs.length);
  const storeRows = await page.$$eval('#store tbody tr', (trs) => trs.filter((t) => t.querySelector('button[data-copy]')).length);
  check('5 存储卡按仓库分组（N11 多 root）', storeGroups >= 1, `${storeGroups} 组`);
  check('5b 存储卡有可复制的真实产物行', storeRows >= 3, `${storeRows} 行`);

  // 6) 索引新鲜度卡（N14）
  const freshRows = await page.$$eval('#fresh tbody tr', (trs) => trs.length);
  const freshText = await page.textContent('#fresh tbody');
  check('6 新鲜度卡有仓库行 + 状态标签', freshRows >= 1 && /同步|有漂移|未建图/.test(String(freshText)), `${freshRows} 行`);

  // 7) 日志区：有真实日志行
  const logLines = await page.$$eval('#log .ln', (els) => els.length);
  check('7 实时日志渲染出真实行', logLines >= 3, `${logLines} 行`);
  check('7b 日志里能看到本轮真实工具调用（汉化后的"工具调用"）', (await page.textContent('#log')).includes('工具调用'), '');

  // 8) 筛选 chip：只看错误 → 只剩 err 行（且至少有一行，因为我们故意造了一次软错误）
  await page.click('.chip[data-f="err"]');
  await page.waitForTimeout(300);
  const errLines = await page.$$eval('#log .ln', (els) => els.map((e) => e.className));
  check('8 「只看错误」筛选生效：只剩 err 行', errLines.length >= 1 && errLines.every((c) => c.includes('err')), `${errLines.length} 行`);
  await page.click('.chip[data-f="all"]');

  // 9) 主题切换 + 持久化
  const t0 = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.click('#btnTheme');
  const t1 = await page.evaluate(() => document.documentElement.dataset.theme);
  const stored = await page.evaluate(() => localStorage.getItem('gm-theme'));
  check('9 主题按钮真实切换', t0 !== t1, `${t0} → ${t1}`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  const t2 = await page.evaluate(() => document.documentElement.dataset.theme);
  check('9b 主题刷新后保持（localStorage）', t2 === t1 && stored === t1, `${t2} / stored=${stored}`);

  // 10) 轮询频率：500ms 间隔下 /stats 在 2.4s 内至少 +3
  await page.fill('#ms', '500');
  await page.dispatchEvent('#ms', 'change');
  await page.evaluate(() => (window.__hits = {}));
  await page.waitForTimeout(2400);
  const statsHits = await page.evaluate(() => window.__hits['/stats'] ?? 0);
  check('10 轮询间隔 500ms 真实生效（2.4s 内 /stats ≥ 3）', statsHits >= 3, `${statsHits} 次`);

  // 11) 暂停：暂停后 2s 内不再请求；手动刷新仍有效
  await page.click('#btnPause');
  await page.evaluate(() => (window.__hits = {}));
  await page.waitForTimeout(1500);
  const pausedHits = await page.evaluate(() => Object.values(window.__hits).reduce((a, b) => a + b, 0));
  check('11 暂停后自动轮询真的停了（1.5s 内 0 请求）', pausedHits === 0, `${pausedHits} 次`);
  await page.click('#btnRefresh');
  await page.waitForTimeout(700);
  const manualHits = await page.evaluate(() => window.__hits['/stats'] ?? 0);
  check('11b 暂停状态下「刷新」按钮仍然生效', manualHits >= 1, `${manualHits} 次`);
  await page.click('#btnPause'); // 恢复

  // 12) 重试探针：点一次 → /reprobe 被调用且表格仍可用
  await page.evaluate(() => (window.__hits = {}));
  await page.click('#btnReprobe');
  await page.waitForTimeout(2500);
  const reprobeHits = await page.evaluate(() => window.__hits['/reprobe'] ?? 0);
  check('12 「重试探针」真实调用 /reprobe', reprobeHits >= 1, `${reprobeHits} 次`);

  // 13) 窄屏 430px：不出现横向溢出
  await page.setViewportSize({ width: 430, height: 900 });
  await page.waitForTimeout(600);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('13 窄屏 430px 无整页横向溢出（表格内部滚动）', overflow <= 1, `溢出 ${overflow}px`);
  await page.setViewportSize({ width: 1400, height: 900 });

  // 14) 零 JS 错误
  check('14 零 pageerror', pageErrors.length === 0, pageErrors.join(' | '));
  check('14b 零 console error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  // 截图存证。
  // ⚠️ Chromium 的 fullPage 截图会把 `position:sticky` 的 header 画在**当前滚动位置**上，
  // 生成一张"KPI 跑到 header 上面"的假图（实测：header y=0 / kpis y=92，DOM 顺序也正确，
  // 是截图伪影不是布局 bug）。截图前临时取消 sticky，图才和用户真实看到的一致。
  await page.evaluate(() => {
    const h = document.querySelector('header');
    if (h) h.style.position = 'static';
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: join(HERE, 'ui-interact.png'), fullPage: true });
  console.log(`\n截图：${join(HERE, 'ui-interact.png')}`);
} catch (e) {
  check(`未捕获异常：${e instanceof Error ? e.message : String(e)}`, false);
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nUI 深度交互验收: ${results.length - failed.length}/${results.length}`);
if (failed.length > 0) {
  console.log('失败项：');
  for (const f of failed) console.log(` - ${f.name}`);
}
process.exit(failed.length === 0 ? 0 : 1);
