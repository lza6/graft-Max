/**
 * The one canonical Graft instruction block, rendered into each host's
 * native format. Content changes happen HERE only; renderers just wrap it.
 *
 * `name` is the repo's name for the tool (see `hostWiringName`): a repo wired
 * by trail gets the same text in trail's spelling, so an agent on a machine
 * with only `trail` installed is never told to run `graft`.
 */
import type { Brand } from '../brand.js';
import { trailSpelling } from '../claude/skill-template.js';

function inName(text: string, name: Brand): string {
  return name === 'trail' ? trailSpelling(text) : text;
}

export function instructionBody(name: Brand = 'graft'): string {
  return inName(graftBody(), name);
}

function graftBody(): string {
  // [graft-Max] 中文指令块：Max 构建面向中文开发者。工具名保持英文（协议层
  // 不变），只汉化"怎么用"的引导。内容是上游英文版的等价翻译 + Max 增补
  // （联邦工具 max_find_docs / max_trace_arch）。
  return `## graft-Max — 仓库上下文图谱

本仓库已被 graft-Max 索引：\`graft/\` 目录里是小型互链的 markdown 节点，解释每个
子系统并携带精确的 file:line 区间，随代码同步更新。

本仓库的**任何任务**——理解某段逻辑、定位代码位置、评估改动范围——先查图谱再
grep/打开源文件。可以随意多查（很便宜），查询词尽量复用你已有的字面量（符号名、
报错串、文件名）。不熟悉本仓库？先跑 \`graft map\`——按 token 预算的仓库导航
（目录聚类/枢纽/热点），零 LLM、零 key。

- \`graft ask "你的问题" --source\` → 排序后的节点 + 内联相关代码区间（默认每条
  ≤8 行精要；不够用加 \`--full\` 看完整定义）。理解/编辑类任务，第一条结果通常
  就是答案——引用它的 \`covers:\` file:line 直接编辑。穷举类任务（"这个模式的
  全部出现/全部调用方"）改跑 \`graft grep "<字面量>"\`（按符号分组）。
- \`graft grep "<正则>"\` — 穷举式搜索。
- \`graft callers <符号>\` / \`--direction out\` / \`--depth all\` — 调用链/被调用/
  完整爆炸半径。重命名、跨文件重构**之前**必跑。
- \`graft skeleton <文件>\` — 一个文件的全部 API 签名（~200 token）。
- \`graft map\` — 新仓库导航。

**graft-Max 联邦工具**（同一个 MCP server 里的兄弟工具）：
- \`max_find_docs\` — 文档/笔记/规格的 BM25 检索（qmd，非代码）。
- \`max_trace_arch\` — 架构级依赖链查询（gitnexus，模块视角；符号视角用
  graft_trace_calls，两者互补）。

结果已反映未提交的编辑——每次查询前图谱自动刷新。`;
}

export function cursorRule(name: Brand = 'graft'): string {
  return inName(`---
description: Use the Graft context graph in graft/ before exploring source
alwaysApply: true
---
${graftBody()}
`, name);
}

export function kiroSteering(name: Brand = 'graft'): string {
  return inName(`---
inclusion: always
---
${graftBody()}
`, name);
}

export function windsurfRule(name: Brand = 'graft'): string {
  return inName(`${graftBody()}
`, name);
}
