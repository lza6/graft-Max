/**
 * [graft-Max] 全局提示词注入：把 Max 的使用引导写进用户全局 ~/.claude/CLAUDE.md
 * 的**头部**（文件最前面），用独立的 graft-max:start/end 标记管理自己的区块，
 * 与上游 graft 的 graft:start/end、icm 等其他工具的区块互不干扰。
 *
 * - 幂等：块已存在且内容一致 → unchanged
 * - 用户内容永不触碰：只动标记之间的区域；没有标记就插到文件最前
 * - 追加条件：GRAFT_MAX_MCP=1（只有 Max 被启用时才注入），开关关掉时
 *   removeGlobalPrompt() 把块整个摘除——这就是"一键切换"的提示词半边。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const MAX_PROMPT_START = '<!-- graft-max:start -->';
export const MAX_PROMPT_END = '<!-- graft-max:end -->';

/** 全局 CLAUDE.md 路径（home 可注入便于测试）。 */
export function globalClaudeMdPath(home: string = homedir()): string {
  return join(home, '.claude', 'CLAUDE.md');
}

export function maxGlobalPrompt(): string {
  return `${MAX_PROMPT_START}
## graft-Max — 优先用图谱查代码（每个会话自动生效）

本机的 graft-Max MCP 在每个项目自动可用。写代码/查代码/改代码前：

1. **先图谱后 grep**：理解代码用 \`graft_find_code\`（MCP 工具），穷举搜索用
   \`graft_find_all\`；重构/重命名前必跑 \`graft_trace_calls\`（爆炸半径）。
2. **架构问题用 \`max_trace_arch\`**（模块级依赖链）；文档/笔记问题用
   \`max_find_docs\`（本地 BM25）——这两个是 graft-Max 联邦工具，与 graft
   六件套同一个 server。
3. 仓库没有图谱时**不要让用户手动初始化**：第一次查询会自动建图（几十秒），
   提示"building in the background"就稍后重问即可。
4. 面板：\`http://127.0.0.1:24688\` 实时查看工具调用日志/会话/存储占用（GRAFT_MAX_UI=1 时；端口被占自动 +1~+9，以 MCP server 启动 stderr 打印的实际地址为准）。
${MAX_PROMPT_END}`;
}

/** 幂等注入：块在头部。返回动作：created | updated | unchanged。 */
export function upsertGlobalPrompt(home: string = homedir()): 'created' | 'updated' | 'unchanged' {
  const path = globalClaudeMdPath(home);
  const block = maxGlobalPrompt();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, block + '\n\n', 'utf8');
    return 'created';
  }
  const raw = readFileSync(path, 'utf8');
  const s = raw.indexOf(MAX_PROMPT_START);
  const e = raw.indexOf(MAX_PROMPT_END);
  if (s !== -1 && e !== -1) {
    const current = raw.slice(s, e + MAX_PROMPT_END.length);
    if (current === block) return 'unchanged';
    writeFileSync(path, raw.slice(0, s) + block + raw.slice(e + MAX_PROMPT_END.length), 'utf8');
    return 'updated';
  }
  // 没有块：插到最前（"追加到全局提示词前面"）
  writeFileSync(path, block + '\n\n' + raw, 'utf8');
  return 'created';
}

/** 轻量补块检查：块被用户手删时补回（不含 existsSync 的快路径，供热路径调用）。
 * server boot 已注入；这里兜"会话中途用户手删"的情况。节流：60 秒内最多查一次。 */
let lastCheck = 0;
export function ensurePromptBlock(): void {
  const now = Date.now();
  if (now - lastCheck < 60_000) return;
  lastCheck = now;
  try {
    const path = globalClaudeMdPath();
    if (!existsSync(path)) return;
    const raw = readFileSync(path, 'utf8');
    if (!raw.includes(MAX_PROMPT_START)) upsertGlobalPrompt();
  } catch {/* best effort */}
}

/** 摘除注入块（切回原版时用）。返回是否动了文件。 */
export function removeGlobalPrompt(home: string = homedir()): boolean {
  const path = globalClaudeMdPath(home);
  if (!existsSync(path)) return false;
  const raw = readFileSync(path, 'utf8');
  const s = raw.indexOf(MAX_PROMPT_START);
  const e = raw.indexOf(MAX_PROMPT_END);
  if (s === -1 || e === -1) return false;
  let out = raw.slice(0, s) + raw.slice(e + MAX_PROMPT_END.length);
  out = out.replace(/^\n+/, ''); // 头部空行清干净
  writeFileSync(path, out, 'utf8');
  return true;
}
