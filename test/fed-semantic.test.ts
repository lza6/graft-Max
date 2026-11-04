/**
 * [M13 补口] fed-semantic 契约测试（此前该文件零直测，覆盖率 58%）。
 *
 * 覆盖软错误矩阵的 E2（缺 query）/ E10（ccc 不可用）/ E11（真无结果）与输出两段式；
 * ccc 用假二进制（PATH 注入），不拖真后端——CI 可跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetFedStateForTest } from '../src/mcp/federation.js';

const isWin = process.platform === 'win32';
let binDir: string;
let repo: string;

test.before(() => {
  const d = mkdtempSync(join(tmpdir(), 'gm-fedsem-'));
  binDir = join(d, 'bin');
  repo = join(d, 'repo');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  // ccc 的"已索引"判定：root/.cocoindex_code 存在
  mkdirSync(join(repo, '.cocoindex_code'), { recursive: true });
});

test.after(() => {
  try {
    rmSync(join(tmpdir(), 'gm-fedsem-'), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** 装一个假 ccc：`--help` 成功、`search` 按脚本输出。 */
function installCcc(mode: 'ok' | 'fail' | 'garbled', searchOut = ''): void {
  const script = mode === 'fail'
    ? '@echo off\r\nexit /b 3\r\n'
    : mode === 'garbled'
      ? `@echo off\r\necho daemon starting...\r\nexit /b 0\r\n`
      : `@echo off\r\nif "%1"=="--help" (echo ccc 1.0.0 & exit /b 0)\r\necho ${searchOut}\r\nexit /b 0\r\n`;
  writeFileSync(join(binDir, 'ccc.cmd'), script, 'utf8');
  const sh = join(binDir, 'ccc');
  const shBody = mode === 'fail'
    ? '#!/bin/sh\nexit 3\n'
    : mode === 'garbled'
      ? '#!/bin/sh\necho "daemon starting..."\n'
      : `#!/bin/sh\nif [ "$1" = "--help" ]; then echo "ccc 1.0.0"; exit 0; fi\ncat <<'OUT'\n${searchOut}\nOUT\n`;
  writeFileSync(sh, shBody, 'utf8');
  try {
    chmodSync(sh, 0o755);
  } catch {
    /* Windows */
  }
}

const withPath = (fn: () => Promise<void>): Promise<void> => {
  const saved = process.env.PATH;
  // PATH 按平台处理，两边的原因不同且都实测过：
  //  - POSIX：假 ccc 是 `#!/bin/sh` 脚本，脚本内部要用 /bin 下的命令 —— 必须保留原 PATH，
  //    只把 binDir 前置（CI 上没有真 ccc，不存在被抢的问题）。
  //  - Windows：direct spawn 只会试 .exe/.com（libuv 不认 .cmd），若保留原 PATH 就会
  //    直接命中系统里的真 ccc.exe（实测），所以只留 binDir → direct ENOENT → 走 shell
  //    兜底 → cmd 在 binDir 找到假 ccc.cmd。
  process.env.PATH = isWin ? binDir : `${binDir}:${saved ?? ''}`;
  return fn().finally(() => {
    process.env.PATH = saved;
    resetFedStateForTest(); // 清探针缓存，下一个 mode 重新探
  });
};

test('E2: 缺 query → 软错误，参数固定文案', async () => {
  const { runSemanticSearch } = await import('../src/mcp/fed-semantic.js');
  const r = await runSemanticSearch({}, repo);
  assert.deepEqual(r, { text: 'max_search_semantic requires a query', isError: true });
});

test('E10: ccc 探针失败（未安装）→ 软错误带 installHint', async () => {
  await withPath(async () => {
    installCcc('fail');
    const { runSemanticSearch } = await import('../src/mcp/fed-semantic.js');
    const r = await runSemanticSearch({ query: 'anything' }, repo);
    assert.equal(r.isError, true);
    assert.match(r.text, /semantic search unavailable/);
    assert.match(r.text, /cocoindex-code/, '必须带可执行的修复命令');
  });
});

test('E11: 正常返回但零结果 → "no hits for:"，isError=false（不是故障）', async () => {
  await withPath(async () => {
    installCcc('ok', '{"results": [], "success": true}');
    const { runSemanticSearch } = await import('../src/mcp/fed-semantic.js');
    const r = await runSemanticSearch({ query: 'nothing matches this' }, repo);
    assert.deepEqual(r, { text: 'no hits for: nothing matches this', isError: false });
  });
});

test('输出两段式：<path>:L<start>-<end> (<lang>) score=<x.xx> + 内容（截 500）', async () => {
  await withPath(async () => {
    const content = 'export function add(a: number, b: number): number {\n  return a + b;\n}'.repeat(3);
    installCcc('ok', JSON.stringify({
      results: [{ file_path: 'src/math.ts', start_line: 1, end_line: 3, language: 'typescript', score: 0.81234, content }],
    }));
    const { runSemanticSearch } = await import('../src/mcp/fed-semantic.js');
    const r = await runSemanticSearch({ query: 'add two numbers' }, repo);
    assert.equal(r.isError, false);
    assert.match(r.text, /^src\/math\.ts:L1-3 \(typescript\) score=0\.81\n/, `头两段式: ${r.text.slice(0, 80)}`);
    assert.ok(r.text.includes('return a + b;'), 'snippet 原文保留');
  });
});

test('limit 夹到 ≤20（schema 侧限幅的服务端兜底）', async () => {
  await withPath(async () => {
    // 假 ccc 把 argv 回显进一个"结果"的 content 字段——这样断言能从输出文本里
    // 读到真实的 --limit N（传空 results 的话 limit 根本不会被断言到）。
    const script = `@echo off\r\necho {\"results\": [{\"file_path\": \"a.ts\", \"start_line\": 1, \"end_line\": 1, \"score\": 0.5, \"content\": \"ARGS %*\"}]}\r\nexit /b 0\r\n`;
    writeFileSync(join(binDir, 'ccc.cmd'), script, 'utf8');
    writeFileSync(join(binDir, 'ccc'), `#!/bin/sh
printf '%s\n' "{\\"results\\": [{\\"file_path\\": \\"a.ts\\", \\"start_line\\": 1, \\"end_line\\": 1, \\"score\\": 0.5, \\"content\\": \\"ARGS $*\\"}]}"
`, 'utf8');
    try {
      chmodSync(join(binDir, 'ccc'), 0o755);
    } catch {
      /* Windows */
    }
    const { runSemanticSearch } = await import('../src/mcp/fed-semantic.js');
    const r = await runSemanticSearch({ query: 'x', limit: 999 }, repo);
    assert.equal(r.isError, false);
    const m = /ARGS .*--limit (\d+)/.exec(r.text);
    assert.ok(m, `argv 回显缺失: ${r.text.slice(0, 120)}`);
    assert.ok(Number(m[1]) <= 20, `limit 未夹紧: ${m[1]}`);
  });
});

test('lang/path 参数透传给 ccc 命令行（limit 测试同款 argv 回显）', async () => {
  await withPath(async () => {
    const script = `@echo off\r\necho {\"results\": [{\"file_path\": \"a.ts\", \"start_line\": 1, \"end_line\": 1, \"score\": 0.5, \"content\": \"ARGS %*\"}]}\r\nexit /b 0\r\n`;
    writeFileSync(join(binDir, 'ccc.cmd'), script, 'utf8');
    // POSIX 版必须用双引号包 printf 的参数：单引号会阻止 $* 展开（Linux 上 argv 回显变字面量）
    writeFileSync(join(binDir, 'ccc'), `#!/bin/sh
printf '%s\\n' "{\\\"results\\\": [{\\\"file_path\\\": \\\"a.ts\\\", \\\"start_line\\\": 1, \\\"end_line\\\": 1, \\\"score\\\": 0.5, \\\"content\\\": \\\"ARGS $*\\\"}]}"
`, 'utf8');
    try {
      chmodSync(join(binDir, 'ccc'), 0o755);
    } catch {
      /* Windows */
    }
    const { runSemanticSearch } = await import('../src/mcp/fed-semantic.js');
    const r = await runSemanticSearch({ query: 'x', lang: 'python', path: 'src/' }, repo);
    assert.equal(r.isError, false);
    assert.match(r.text, /--lang python/, `lang 未透传: ${r.text.slice(0, 120)}`);
    assert.match(r.text, /--path src\//, 'path 未透传');
  });
});

test('非 JSON 输出（守护进程首启消息）→ 可读文本透传，isError 跟随退出码', async () => {
  await withPath(async () => {
    installCcc('garbled');
    const { runSemanticSearch } = await import('../src/mcp/fed-semantic.js');
    const r = await runSemanticSearch({ query: 'q' }, repo);
    assert.equal(r.isError, false, 'garbled 模式 exit 0 → isError=false');
    assert.match(r.text, /daemon starting/);
  });
});
