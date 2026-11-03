# 更新日志（CHANGELOG）

所有重要改动记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循语义化：`0.28.0-max.N`（上游版本-max 补丁位）。

## [0.28.0-max.7] — 2026-11

### 新增
- **T2 进程内嵌 qmd**（`src/mcp/fed-qmd.ts`）：max_find_docs 直连 qmd SDK
  （动态 import，绕过 top-level-await ESM 的 ERR_REQUIRE_ASYNC_MODULE），
  searchLex 实测 2-5ms（原 spawn 293ms）；SDK 不可解析时自动降级 spawn
- **T3 gitnexus 常驻会话**（federation.ts）：stdio 握手一次复用，二次查询
  实测 128-200ms（原每次 1244ms）；崩溃自动重建一次，二次失败降级 one-shot；
  闲置 10 分钟回收（与 stdin-leash 同节奏），server 退出时统一 kill
- **T4 联邦工具结果缓存**：60s TTL LRU（32 条），命中带 `[cached, 60s TTL]`
  标注，实测二次调用 10-15ms；错误结果不缓存
- **T5 第 9 个联邦工具 max_search_semantic**（`src/mcp/fed-semantic.ts`）：
  cocoindex-code（ccc）本地嵌入语义搜索（snowflake-arctic-embed-xs，$0 离线）；
  probe 门控 = ccc 已装 + 仓库已 `ccc init`，否则零 schema 占用
- **T6 编辑后自动增量索引**（stop.ts `autoIndexAfterEdit`，默认开启）：
  post-edit hook 即时触发 detached sync-run（复用锁与 sync-run.js），60s 节流
  （GRAFT_MAX_SYNC_THROTTLE_MS），GRAFT_MAX_AUTO_INDEX=0 可关
- **T9 Dashboard 工具耗时卡片**：/stats 返回 toolStats（近 800 行日志解析），
  面板显示每工具调用次数/平均耗时/错误数（跨 max_/graft_/trail_ 前缀聚合）
- **T9.2 存储/产物视图**：新增 /storage 端点 + 面板"存储 / 产物"表格——
  日志/会话注册表/~/.trail/graft-Max 主目录/本仓库图谱/.cocoindex_code 全部
  落盘产物的绝对路径+递归大小（30s 慢轮询，不挤占 2s 主轮询），路径一键复制

### 修复
- **T1 版本号漂移**：package.json 0.28.0-max.1 → max.7；repository/homepage/bugs
  的 trailhq 上游残留 → lza6/graft-Max；bin 增加 graft-max/trail
- **T8 测试基线收敛：17 fail → 0**（基线 11 + 新增 6）：
  - cli-meta：断言更新为 graft-max 包名（品牌化正确行为）
  - hosts-trail：中文 Max 指令块断言（graft-Max 连字符品牌在 trail 拼写下保留）
  - mcp-connector(.review)：repo 工具断言接受 Max 身份（max_*），workspace 部分不变
  - skills-state：monthDay 时区依赖 → 用同源 Date 计算期望日
  - trail-scenario-hooks：shipCheck 的 seen-set 写进真实 ~/.trail 导致跨运行
    污染（非幂等）→ 测试沙箱 TRAIL_HOME（修复了根因，非跳过）
  - mcp-server：版本断言接受 -max.N 后缀
- dashboard toolStats 聚合：max_/graft_/trail_ 前缀归一

### 变更
- T10 旧产物清理：docs-selfdev/自研说明.md（fork 前状态）合并进改造日志后删除；
  README-upstream.md 加参考标注；已完成任务文档归档到 改进计划/archive/
- mcpInstructions：联邦工具行补 max_search_semantic

### 审查闭环（独立 reviewer 3 轮 → Approve）
- R1 关停竞态：stdin-end/leash 退出路径 await shutdownFederatedSessions（qmd sqlite 落盘）
- R2 同步 dirSize 脱离 2s 主轮询（Playwright 实证 7s 内 /stats 4 次 / /storage 1 次）
- R3 esc() 补引号转义；R4 qmd store 失败 60s 重试不再永久缓存
- S1 sync 失败也写 syncedAt（T6 退避）；S2 spawn error 监听；S3 gitnexus 启动失败 30s 负缓存
- S4 E2E rpc 90s 超时；closeEmbeddedQmd 3s 兜底

### 性能实测（E2E，duck2api-hub 真实仓库）
- max_find_docs：293ms → 进程内 2-5ms（60 倍）
- max_trace_arch 二次调用：1244ms → 128-200ms（6-10 倍）
- 缓存命中：10-15ms
- E2E：e2e-fed-perf.mjs 8/8 + e2e-federation.mjs 9/9；npm test 4053 pass / 0 fail

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
