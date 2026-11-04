/**
 * [graft-Max][N2] `src/hosts/max-prompt.ts`（用户全局 ~/.claude/CLAUDE.md 注入）
 * 与 `~/.claude.json` 写入口的行为网。
 *
 * 全部跑在 mkdtemp 假 home 上——真实的 ~/.claude/CLAUDE.md 里有用户几千行个人规则，
 * 测试绝不碰它（调用 `ensurePromptBlock()` 那一条用 HOME/USERPROFILE 沙箱隔离）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_PROMPT_END, MAX_PROMPT_START, ensurePromptBlock, globalClaudeMdPath,
  removeGlobalPrompt, upsertGlobalPrompt,
} from '../src/hosts/max-prompt.js';
import { mergeJsonKey } from '../src/hosts/mcp-config.js';
import { disableGraftServerIn } from '../src/hosts/claude-global.js';

const dirs: string[] = [];
function scratchHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'gm-mp-'));
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } });

const USER_CONTENT = '## 我自己的规则\n\n- 不要改我的格式\n- 不要动我的行号\n';

/** 注入一份"用户已有 ~/.claude/CLAUDE.md"的假 home（区块之外全是用户内容）。 */
function homeWithUserContent(): { home: string; path: string } {
  const home = scratchHome();
  const path = globalClaudeMdPath(home);
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(path, USER_CONTENT, 'utf8');
  return { home, path };
}

test('空 home → created，文件含 MAX_PROMPT_START，写后可立刻读到完整内容（非空 + 换行结尾）', () => {
  const home = scratchHome();
  const path = globalClaudeMdPath(home);
  assert.equal(upsertGlobalPrompt(home), 'created');

  const raw = readFileSync(path, 'utf8');
  assert.ok(raw.length > 0, '写后立刻读到空文件 = 原子写没生效');
  assert.ok(raw.includes(MAX_PROMPT_START));
  assert.ok(raw.includes(MAX_PROMPT_END));
  assert.ok(raw.endsWith('\n'), '文件应以换行结尾');
  // 首写没有上一版，不该凭空生成 .bak
  assert.equal(existsSync(`${path}.bak`), false);
});

test('再调一次 → unchanged，且文件字节不变（幂等，不重复写盘）', () => {
  const home = scratchHome();
  const path = globalClaudeMdPath(home);
  assert.equal(upsertGlobalPrompt(home), 'created');
  const first = readFileSync(path, 'utf8');
  assert.equal(upsertGlobalPrompt(home), 'unchanged');
  assert.equal(upsertGlobalPrompt(home), 'unchanged');
  assert.equal(readFileSync(path, 'utf8'), first, 'unchanged 不该改写文件');
});

test('区块被改过（模拟升版遗留旧块）→ updated，用户内容完好，区块仍只有一个', () => {
  const { home, path } = homeWithUserContent();
  assert.equal(upsertGlobalPrompt(home), 'created'); // 插到用户内容最前面

  // 模拟"文件里躺着上一版区块"：标题行与当前生成的不一致
  const canonical = '## graft-Max — 优先用图谱查代码（每个会话自动生效）';
  const stale = readFileSync(path, 'utf8').replace(canonical, '## graft-Max — OLD TITLE v0.1');
  writeFileSync(path, stale, 'utf8');
  assert.ok(stale.includes('OLD TITLE'));

  assert.equal(upsertGlobalPrompt(home), 'updated');
  const raw = readFileSync(path, 'utf8');
  assert.ok(!raw.includes('OLD TITLE'), '旧块必须被换成当前版本');
  assert.ok(raw.includes(canonical));
  assert.equal(raw.split(MAX_PROMPT_START).length, 2, '区块只能有一个');
  assert.equal(raw.split(MAX_PROMPT_END).length, 2, '结束标记只能有一个');
  assert.ok(raw.includes(USER_CONTENT.trimEnd()), '用户内容必须原样保留');
  assert.ok(raw.endsWith('\n'));
  assert.ok(raw.indexOf(MAX_PROMPT_START) < raw.indexOf(USER_CONTENT), '区块在头部');
  // 上一版落在 .bak 里（升版可回滚）
  assert.ok(readFileSync(`${path}.bak`, 'utf8').includes('OLD TITLE'));
});

test('用户手删区块 → ensurePromptBlock() 补回；60 秒节流内不再重复补', () => {
  // ensurePromptBlock() 没有 home 参数（故意：热路径上用 homedir()），用 env 沙箱隔离。
  const { home, path } = homeWithUserContent();
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    // 第一次调用：块不在 → 补回（这也是 lastCheck 的唯一一次"过期"状态）
    ensurePromptBlock();
    assert.ok(readFileSync(path, 'utf8').includes(MAX_PROMPT_START), '手删的块必须补回');
    assert.ok(readFileSync(path, 'utf8').includes(USER_CONTENT.trimEnd()));

    // 60s 节流：再手删一次，紧接着调用不会补（节流是设计行为，不是缺陷）
    writeFileSync(path, USER_CONTENT, 'utf8');
    ensurePromptBlock();
    assert.ok(!readFileSync(path, 'utf8').includes(MAX_PROMPT_START), '60s 内应被节流跳过');
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
  }
});

test('removeGlobalPrompt → 区块消失、其它内容保留、二次调用返回 false', () => {
  const { home, path } = homeWithUserContent();
  upsertGlobalPrompt(home);
  assert.equal(removeGlobalPrompt(home), true);

  const raw = readFileSync(path, 'utf8');
  assert.ok(!raw.includes(MAX_PROMPT_START));
  assert.ok(!raw.includes(MAX_PROMPT_END));
  assert.equal(raw, USER_CONTENT, '摘除后应只剩用户原文');
  assert.equal(removeGlobalPrompt(home), false, '已经没有区块了');

  const empty = scratchHome();
  assert.equal(removeGlobalPrompt(empty), false, '文件都不存在时不该抛');
});

test('大小写重复键保护：写入口不丢 mcpServers / MCPServers（P1-6 验收④）', () => {
  const home = scratchHome();
  const path = join(home, '.claude.json');
  const original = {
    mcpServers: { graft: { command: 'node', args: ['a.js'] } },
    MCPServers: { other: { command: 'node', args: ['b.js'] } },
    numStartups: 7,
  };
  writeFileSync(path, JSON.stringify(original, null, 2) + '\n', 'utf8');

  // 真实写入口 1：mcp-config.ts 的 mergeJsonKey（整写 JSON 的那条路）
  const w = mergeJsonKey('claude-global-mcp-max', path, 'mcpServers', { command: 'node', args: ['dist/cli.js', 'mcp'] }, 'graft-max');
  assert.equal(w.action, 'updated');
  let after1 = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(after1.MCPServers, original.MCPServers, '大小写另一个键不能被吞掉');
  assert.deepEqual(after1.mcpServers.graft, original.mcpServers.graft);
  assert.deepEqual(after1.mcpServers['graft-max'], { command: 'node', args: ['dist/cli.js', 'mcp'] });
  assert.equal(after1.numStartups, 7, '其它字段必须原样保留');

  // 真实写入口 2：claude-global.ts 的 disableGraftServerIn（另一条整写路）
  const w2 = disableGraftServerIn(home, 'C:/some/project');
  assert.equal(w2.action, 'updated');
  const after2 = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(after2.MCPServers, original.MCPServers);
  assert.deepEqual(after2.mcpServers.graft, original.mcpServers.graft);
  assert.deepEqual(after2.projects['C:/some/project'].disabledMcpServers, ['graft']);
  assert.equal(readFileSync(path, 'utf8').endsWith('\n'), true);
  // 两次整写都留下了上一版
  assert.ok(existsSync(`${path}.bak`));
  assert.deepEqual(JSON.parse(readFileSync(`${path}.bak`, 'utf8')).MCPServers, original.MCPServers);
});
