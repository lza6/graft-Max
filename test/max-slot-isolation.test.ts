/**
 * [回归] Max 槽位隔离 —— `GRAFT_MAX_MCP=1` 不得把**上游 `graft` 槽位**改写成我们自己的路径。
 *
 * 真 bug（2026-11 实测抓到，日志归因时发现）：
 * upkeep 在每次 boot 刷新项目 `.mcp.json`，原来 `serverEntry()` 只判
 * `GRAFT_MAX_MCP === '1'` 就返回 MAX_LAUNCH（我们的 dist 路径），而调用方用的是
 * `mergeJsonKey(..., 'graft')` 写**上游槽位** → 项目里的 `mcpServers.graft` 被从
 * `npx -y @nanonets/graft mcp` 悄悄改成我们自己的绝对路径，还留下 `.bak`。
 * 这违反 `docs-selfdev/项目约束.md` §1.5「绝不写上游 graft 槽位」。
 *
 * 现在的契约：**只有 slot === 'graft-max' 时才允许出现我们的路径。**
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeJsonKey, serverEntry } from '../src/hosts/mcp-config.js';

const OUR_DIST = 'dist/cli.js';
/** 断言用：把路径分隔符归一化后再比（Windows 上是 dist\cli.js）。 */
// JSON 里反斜杠是成对转义的（`\`），归一化后会出现 `//` —— 用正则容忍任意分隔符。
const OUR_DIST_RE = /dist[\\/]+cli\.js/;
const hasOurDist = (args: string[]) => args.some((a) => OUR_DIST_RE.test(a));
const withMax = (fn: () => void) => {
  const prev = process.env.GRAFT_MAX_MCP;
  process.env.GRAFT_MAX_MCP = '1';
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.GRAFT_MAX_MCP;
    else process.env.GRAFT_MAX_MCP = prev;
  }
};

test('GRAFT_MAX_MCP=1：上游 graft 槽位的 entry 仍是 npx（不写我们的路径）', () => {
  withMax(() => {
    for (const opts of [{ brand: 'graft' as const }, { brand: 'graft' as const, slot: 'graft' as const }]) {
      const e = serverEntry(opts);
      assert.equal(e.command, 'npx', `上游槽位不得用我们的可执行：${JSON.stringify(e)}`);
      assert.ok(!hasOurDist(e.args), `上游槽位不得指向我们的 dist：${JSON.stringify(e)}`);
      assert.ok(e.args.includes('@nanonets/graft'), `应当是上游包：${JSON.stringify(e)}`);
    }
  });
});

test('GRAFT_MAX_MCP=1：我们自己的 graft-max 槽位才是我们的路径', () => {
  withMax(() => {
    const e = serverEntry({ brand: 'graft', slot: 'graft-max' });
    assert.equal(e.command, 'node');
    assert.ok(hasOurDist(e.args), `graft-max 槽位应指向我们的 dist：${JSON.stringify(e)}`);
    assert.ok(e.args.includes('mcp'));
  });
});

test('GRAFT_MAX_MCP=1：trail 槽位同样不被我们占用', () => {
  withMax(() => {
    const e = serverEntry({ brand: 'trail' });
    assert.ok(!hasOurDist(e.args), `trail 槽位不得写我们的 dist：${JSON.stringify(e)}`);
  });
});

test('写 graft 键 与 写 graft-max 键 的产物不同（端到端：mergeJsonKey + serverEntry）', () => {
  withMax(() => {
    const d = mkdtempSync(join(tmpdir(), 'gm-slot-'));
    try {
      const up = join(d, 'up.mcp.json');
      const max = join(d, 'max.mcp.json');
      mergeJsonKey('t-up', up, 'mcpServers', serverEntry({ brand: 'graft', slot: 'graft' }), 'graft');
      mergeJsonKey('t-max', max, 'mcpServers', serverEntry({ brand: 'graft', slot: 'graft-max' }), 'graft-max');

      const upTxt = readFileSync(up, 'utf8');
      const maxTxt = readFileSync(max, 'utf8');
      assert.match(upTxt, /"graft"/);
      assert.ok(!OUR_DIST_RE.test(upTxt), `上游槽位文件里不该出现我们的 dist：${upTxt}`);
      assert.match(maxTxt, /"graft-max"/);
      assert.ok(OUR_DIST_RE.test(maxTxt), `graft-max 槽位应指向我们的 dist：${maxTxt}`);
      // 状态断言：一个文件里不能同时出现两个槽位（否则会被启动两次）
      assert.ok(!upTxt.includes('"graft-max"'));
      assert.ok(!maxTxt.includes('"graft"'));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

test('未开 GRAFT_MAX_MCP 时不产生我们的路径（上游行为逐字节不变）', () => {
  const prev = process.env.GRAFT_MAX_MCP;
  delete process.env.GRAFT_MAX_MCP;
  try {
    const e = serverEntry({ brand: 'graft' });
    assert.ok(!hasOurDist(e.args), JSON.stringify(e));
  } finally {
    if (prev !== undefined) process.env.GRAFT_MAX_MCP = prev;
  }
});
