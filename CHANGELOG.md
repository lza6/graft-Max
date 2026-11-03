# 更新日志（CHANGELOG）

所有重要改动记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循语义化：`0.28.0-max.N`（上游版本-max 补丁位）。

## [0.28.0-max.6] — 2026-02

### 新增
- **会话 cwd 规范化**：sessions.json 统一正斜杠，dashboard 匹配分隔符无关
- **duck2api-hub 真实第三方仓库 E2E**（`e2e/e2e-duck-hub.mjs` 7/7）：
  8 工具/建图/联邦/面板/日志全链路，实测 max_find_code 309ms 省 11370 token（90%）
- **UI 深度交互验收**（`e2e/ui-interact.mjs` 7/7）：
  主题持久化 localStorage、轮询间隔真实生效、错误行 CSS 渲染路径验证
- **建图状态可视化**：building.json 落盘 + 面板"建图状态"卡片（空闲/建图中(N)）
- **提示词自动补块**：tools/call 时节流检查（60s 一次），用户手删自动补回
- **code-review-graph 修复**：杀残留进程后 `uv tool install --force` 重装，14/14 MCP 全绿

### 修复
- dashboard 页面脚本三处语法错误（esc 正则被 `</script>` 截断、insertAdjacentHTML
  缺右括号、模板字面量 `\n` 转义）
- 会话表 cwd 分隔符不匹配导致面板找不到会话
- switch-mcp v2：Max 走独立 `graft-max` id，current() 识别独立 id

### 变更
- 全部 8 个 MCP 工具统一 `max_*` 命名（inMax 品牌），initialize 指令块换中文 Max 版
- 主题持久化 localStorage（gm-theme）；轮询间隔输入框真实生效（最小 500ms）
- vendors/ 全量收编 9 个上游源码（新增 serena/context7/chrome-devtools-mcp/modelcontextprotocol-servers）

## [0.28.0-max.5] — 2026-02

- MCP 联邦层落地（federation.ts）：max_find_docs(qmd) / max_trace_arch(gitnexus)
- 开发者日志层（GRAFT_MAX_LOG，中文 I18N）+ Web Dashboard（GRAFT_MAX_UI）+ 会话注册表
- 日志防膨胀：5MB 滚动 + 14 天裁剪 + sessions 死 pid 自净
- 自动建图（graft 布局放开 isTrailMapDir 门槛）+ 全局提示词注入/摘除 + 一键切换
- stdin-leash 防 Windows 僵尸进程；与上游槽位物理隔离（graft-max 独立 id）

## [0.28.0-max.1] — 2026-02

- fork nanonets/graft v0.28.0（main b9c2e23）
- 品牌化基座：package graft-max、GRAFT_MAX_INVOKED_AS、中文 README
- 构建验证：tsc 0 错误、npm test 与上游同基线、E2E 体系建立
