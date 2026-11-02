/**
 * The `instructions` string returned in graft's MCP `initialize` response.
 *
 * This is the one piece of graft prose that survives **tool deferral**. When a
 * host has more tools than its schema budget allows, it sends tool *names* only
 * and withholds the JSONSchemas until a `ToolSearch`-style lookup fetches them —
 * measured in a real session: 111 tools deferred, of which graft's six arrived as
 * six bare strings with no descriptions at all. The MCP spec's `instructions`
 * field is delivered on a separate track (Claude Code records it as its own
 * `mcp_instructions_delta` context layer), so it lands whole even then. Other
 * servers already rely on this — `claude-in-chrome` uses it for exactly the
 * batch-your-ToolSearch instruction below; graft used to send nothing.
 *
 * Two jobs, in this order:
 *   1. Defuse the deferral tax. One lookup loads all six tools for the whole
 *      session, so the cost is a single round trip, not two calls per use. An
 *      agent that doesn't know this can only assume the worse reading.
 *   2. Say what each tool is FOR as a decision rule, not a feature summary —
 *      because in a host with no hooks and no skill listing (a plain chat client
 *      with an MCP config), this string plus the tool descriptions are the entire
 *      steering budget graft gets.
 *
 * Budget: keep this under ~1,000 characters. Observed sibling servers sit at
 * 660–984, and nothing proves a longer one survives un-truncated.
 */
import { brand, inBrand } from '../brand.js';

/** Tool names in the order an agent should reach for them, most-used first. */
const TOOL_ORDER = [
  'graft_find_code',
  'graft_find_all',
  'graft_trace_calls',
  'graft_file_api',
  'graft_repo_map',
] as const;

/** The `select:` argument that loads every graft tool in one lookup. */
export function toolSearchQuery(prefix = `mcp__${brand()}__`): string {
  return `select:${TOOL_ORDER.map((t) => `${prefix}${inBrand(t)}`).join(',')}`;
}

/** Under trail, the same text with trail's tool names (see brand.ts `inBrand`). */
export function mcpInstructions(): string {
  // [graft-Max] 中文指令块（<1000 字符红线不变）。工具名经 inMax 变 max_*。
  const q = toolSearchQuery().replaceAll('graft_', 'max_');
  return [
    '本仓库已被 graft-Max 索引：符号图谱（file:line 精确区间 + 调用关系）。查代码',
    '优先用这些工具，一次调用顶多次 grep/read。',
    '',
    `**若工具被延迟加载（只见名字）：一次全部加载** ToolSearch "${q}"——整个会话只此一次。`,
    '',
    '- max_find_code — "X 怎么实现/Y 在哪"：排序命中+内联代码。',
    '- max_find_all — 穷举搜索（find_code 是 top-N 会漏）。',
    '- max_trace_calls — 调用链/爆炸半径，重命名前必跑。',
    '- max_file_api — 一个文件的全部 API（~200 token）。',
    '- max_repo_map — 陌生仓库导航。',
    '- max_find_docs / max_trace_arch — 文档检索 / 架构依赖链（联邦工具）。',
    '',
    '结果已反映未提交编辑——每次查询前图谱自动刷新。',
  ].join('\n');
}
