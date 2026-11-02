import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instructionBody, cursorRule, kiroSteering, windsurfRule } from '../src/hosts/instructions.js';

test('canonical body names the three essentials', () => {
  // [graft-Max] 中文 Max 版：三个要点（ask 图谱优先 / grep 穷举 / callers 爆炸半径）
  // + Max 联邦工具说明。原英文断言按语义翻译。
  const b = instructionBody();
  assert.match(b, /## graft-Max — 仓库上下文图谱/m);
  assert.match(b, /graft ask "/);
  assert.match(b, /穷举/, 'teaches the exhaustive-task grep rule');
  assert.match(b, /callers|调用链/, 'teaches the callers/callees/impact commands');
  assert.match(b, /graft grep/, 'routes sweeps to graft grep');
  assert.match(b, /graft map/, 'tells the agent to orient with graft map before exploring');
  assert.ok(!/hook|statusline/i.test(b), 'no host-specific machinery in the shared body');
});

test('cursor rule has alwaysApply frontmatter and the body', () => {
  const r = cursorRule();
  assert.match(r, /^---\ndescription: .+\nalwaysApply: true\n---\n/);
  assert.ok(r.includes(instructionBody()));
});

test('kiro steering has inclusion: always frontmatter and the body', () => {
  const r = kiroSteering();
  assert.match(r, /^---\ninclusion: always\n---\n/);
  assert.ok(r.includes(instructionBody()));
});

test('windsurf rule is the plain body', () => {
  assert.ok(windsurfRule().includes(instructionBody()));
});
