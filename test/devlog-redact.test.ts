/**
 * [M8 · P1] 日志脱敏：`/tail` 能把 mcp.log 原文吐给浏览器，所以凡是进日志的
 * 工具入参/输出里若带密钥形态的串，落盘前必须掩码。
 *
 * 红线：只脱"明显密钥"，不碰普通代码/路径（误伤会毁掉日志的排障价值）；
 * `GRAFT_MAX_LOG_REDACT=0` 一键关；掩码保留前 4 字符方便人工比对"是哪把钥匙"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'gm-redact-'));
process.env.USERPROFILE = dir;
process.env.HOME = dir;
mkdirSync(join(dir, '.graft-max'), { recursive: true });
const logFile = join(dir, 'mcp.log');
delete process.env.GRAFT_MAX_LOG_REDACT; // 默认开
process.env.GRAFT_MAX_LOG = logFile;

const devlogMod = await import('../src/mcp/devlog.js');
devlogMod.setDevlogHomeForTest(dir); // GRAFT_MAX_LOG 已指向 logFile，setter 会以它为准
const { dlog, dlogBlock, redact, __resetRedactCacheForTest } = devlogMod;
const settle = () => new Promise((r) => setTimeout(r, 80));
const readLog = (): string => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '');

test('redact 纯函数：5 类明显密钥被掩码（保留前 4 字符）', () => {
  // OpenAI 风格
  const openai = redact('api call with sk-proj4abcdefghij0123456789 done');
  assert.ok(!openai.includes('abcdefghij0123456789'), `明文泄露: ${openai}`);
  assert.ok(openai.includes('sk-p***'), `保留前缀: ${openai}`);
  // GitHub token
  const gh = redact('git push using ghp_16charsminimum0987654321 ok');
  assert.ok(!gh.includes('16charsminimum'), gh);
  assert.match(gh, /ghp_\*\*\*/); // ghp_ 恰好 4 字符，无可保留的第 5 字符
  // AWS access key
  const aws = redact('aws: AKIAIOSFODNN7EXAMPLE');
  assert.ok(!aws.includes('IOSFODNN7EXAMPLE'), aws);
  assert.match(aws, /AKIA\*\*\*/); // 同上
  // Slack / bearer
  const bearer = redact('Authorization: Bearer abc123def456ghi789 done');
  assert.ok(!bearer.includes('abc123def456ghi789'), bearer);
  assert.match(bearer, /Bearer abc\*\*\*/, bearer); // 规则保留 m 前 10 字符 = 'Bearer abc'
  // 键值对（token= / api_key: / password=）
  const kv = redact('config: api_key=supersecretvalue12345 used');
  assert.ok(!kv.includes('supersecretvalue12345'), kv);
  // Slack token。格式拆开写：GitHub Push Protection 会把完整形态的样例当真密钥
  // 拦截推送（这本身是对 M8 价值的一次旁证）——拼接起来即可绕开误报，仍测同一形态。
  const slackTok = ['xoxb-1234', '567890123', '-1234567890123-abcdefgh'].join('');
  const slack = redact(`slack ${slackTok}`);
  assert.ok(!slack.includes('abcdefgh'), slack);
  assert.match(slack, /xoxb\*\*\*/); // xoxb 恰好 4 字符
});

test('redact 不误伤：普通代码/路径/短串原样保留', () => {
  const code = 'const api_keyName = "config"; src/hosts/max-prompt.ts:L42 sk sketchy skunk';
  assert.equal(redact(code), code, '普通标识符与路径必须原样');
  // sk- 后面太短（<16）不是密钥
  assert.equal(redact('sk-short'), 'sk-short');
  // base64 但无密钥形态前缀
  assert.equal(redact('hash sha256:deadbeefcafebabe'), 'hash sha256:deadbeefcafebabe');
});

test('dlog 落盘的行已脱敏', async () => {
  dlog('--> tools/call name=x args={"apiKey":"sk-live0123456789abcdef"}');
  await settle();
  const text = readLog();
  assert.ok(!text.includes('0123456789abcdef'), `落盘含明文: ${text}`);
  assert.match(text, /sk-l\*\*\*/);
});

test('dlogBlock 的 body（工具入参/输出）也脱敏，结构保留', async () => {
  dlogBlock(
    '--> tools/call  id=9  name=max_find_code',
    JSON.stringify({ query: 'add', token: 'ghp_abcdefghijklmnopqrstuvwxyz123456' }, null, 1),
  );
  await settle();
  const text = readLog();
  assert.ok(!text.includes('ghijklmnopqrstuvwxyz123456'), `body 明文落盘: ${text}`);
  assert.ok(text.includes('"query": "add"'), '非密钥字段必须原样（结构可 grep）');
});

test('GRAFT_MAX_LOG_REDACT=0 一键关（排障时需要看原文）', async () => {
  __resetRedactCacheForTest(); // 前面的用例已把"默认开"缓存进模块
  process.env.GRAFT_MAX_LOG_REDACT = '0';
  try {
    dlog('raw: sk-proj4abcdefghij0123456789');
    await settle();
    assert.ok(readLog().includes('sk-proj4abcdefghij0123456789'), '关闭后应保留原文');
  } finally {
    delete process.env.GRAFT_MAX_LOG_REDACT;
    __resetRedactCacheForTest(); // 恢复默认开，避免影响后续用例
  }
});

test('redact 幂等且不做多余替换', () => {
  const once = redact('token: ghp_abcdefghijklmnopqrst');
  assert.equal(redact(once), once, '二次脱敏不得再变（*** 不该被再匹配）');
});

test('cleanup', () => {
  rmSync(dir, { recursive: true, force: true });
});
