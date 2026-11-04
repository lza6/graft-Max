/**
 * [graft-Max P3-3] 日志汉化层：真实写过来的行必须被翻译，已经是中文的行不得二次翻译。
 *
 * 之前两条规则（`<-- tools/call (federated)` / `<-- tools/call (graft)`）早已失效——
 * server.ts 直接输出中文，正则永远匹配不到，等于死代码。删掉它们之后，这个
 * 测试用**真实的日志行**把"该翻的翻、不该翻的不动"钉死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'gm-i18n-'));
process.env.USERPROFILE = dir;
process.env.HOME = dir;
const logFile = join(dir, 'mcp.log');
process.env.GRAFT_MAX_LOG = logFile;

const devlogMod = await import('../src/mcp/devlog.js');
devlogMod.setDevlogHomeForTest(dir);
const { dlog, dlogBlock, logPath } = devlogMod;

const settle = () => new Promise((r) => setTimeout(r, 60));
const readLog = (): string => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '');

test('logPath 指到沙箱', () => {
  assert.equal(logPath(), logFile);
});

test('英文请求行被汉化（真实格式）', async () => {
  dlog('--> tools/call  id=7  name=graft_find_code');
  dlog('<-- tools/list  id=8  ->  ');
  dlog('<-- initialize  id=9');
  await settle();
  const text = readLog();
  assert.match(text, /--> 工具调用\s+请求id=7\s+工具=graft_find_code/, 'tools/call 行必须汉化');
  assert.match(text, /<-- 工具列表返回\s+id=8 ->（空，仓库未建图）/, '空工具列表行必须带说明');
  assert.match(text, /<-- 收到请求 initialize\s+id=9/, '通用请求行必须汉化');
});

test('已是中文的行不得被二次翻译', async () => {
  const chinese = '<-- 工具返回（联邦）  max_find_docs  12ms  isError=false';
  dlog(chinese);
  await settle();
  const text = readLog();
  assert.ok(text.includes(chinese), '中文行应原样落盘');
  // 已删除的死规则不得再给中文行加前缀
  assert.equal(
    text.split('工具返回（联邦）').length - 1,
    1,
    '一条输入只应产生一处"工具返回（联邦）"',
  );
});

test('联邦子进程行被汉化', async () => {
  dlog('[fed] qmd spawn: qmd search x');
  await settle();
  assert.match(readLog(), /\[联邦\] qmd 子进程启动: qmd search x/);
});

test('P3-3 根因：dlogBlock 的**标题**必须汉化，body（工具原文）不得翻译', async () => {
  const body = 'src/math.ts:L1-L3\nfunction add(a: number, b: number): number';
  dlogBlock('--> tools/call  id=42  name=max_repo_map', body);
  await settle();
  const text = readLog();
  assert.match(text, /--> 工具调用\s+请求id=42\s+工具=max_repo_map/, 'dlogBlock 完全绕过了汉化层——这是历史上所有工具行都是英文的根因');
  assert.ok(text.includes(body), '工具输出原文必须逐字保留（翻译代码会毁掉可复制性）');
});

test('快路径证据行也汉化（进程内文档库就绪 / gitnexus 常驻会话就绪）', async () => {
  dlog('[fed-qmd] in-process store ready (/home/u/.cache/qmd/index.sqlite) in 3ms');
  dlog('[fed] gitnexus session ready in 1200ms');
  await settle();
  const text = readLog();
  assert.match(text, /\[联邦-qmd\] 进程内文档库就绪（\/home\/u\/\.cache\/qmd\/index\.sqlite）耗时 3ms/, 'T2 内嵌快路径的证据行');
  assert.match(text, /\[联邦\] gitnexus 常驻会话就绪 1200ms/, 'T3 会话复用的证据行');
});

test('cleanup', () => {
  rmSync(dir, { recursive: true, force: true });
});
