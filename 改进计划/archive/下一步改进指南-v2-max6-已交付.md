# graft-Max 下一步改进指南

> 生成时间：2026-02（基于 v0.28.0-max.6 现状）。**2026-11 更新：T1-T6、T8-T10 已全部落地（v0.28.0-max.7），T7 npm 发布已完成准备（bin/files/版本），待账号执行 `npm publish`。**
> 目标读者：负责实际编码的 AI / 开发者。本文档只做规划，不改代码。
> 原则：每个任务独立可交付、可验证、可回滚；遵守 `docs-selfdev/项目约束.md` 全部红线。

---

## 一、现状基线（写代码前必须知道的事实）

| 事实 | 证据 |
|------|------|
| 版本 `0.28.0-max.1`（package.json）落后于 CHANGELOG 的 max.6 | `package.json` vs `CHANGELOG.md` — **P0 待修** |
| 8 个 `max_*` 工具 + 6 件套 + legacy 别名全部工作 | `e2e/E2E-REPORT.md` 9/9 PASS |
| 联邦工具性能：qmd 293ms / gitnexus 1244ms（均为 spawn 模式） | E2E 实测 |
| 测试基线：npm test 4043 pass / 11 fail（上游遗留 flaky，在 trail 同步/日期用例） | `docs-selfdev/改造日志.md` |
| 关键红线：graft_* 逐字节兼容上游；品牌走 `GRAFT_MAX_INVOKED_AS` 环境变量；Max 槽位独立 `graft-max` id；未邀请仓库零工具 | `docs-selfdev/项目约束.md` |
| Windows 已知坑：.cmd shim spawn 两段式、MCP initialized 通知、stdin 分步写、spawn 绝对路径 | E2E 沉淀（federation.ts 注释） |
| stdin-leash 防 Windows 僵尸进程（10 分钟静默退出） | 项目约束 §1.5 |

改动后统一验证链（每个任务收尾必跑）：

```powershell
npx tsc --noEmit
npm run build
node dist/cli.js --version        # 应输出 0.28.0-max.N
npm test                          # 只看是否新增 fail（基线 11 fail）
claude mcp list                   # graft-max ✔ Connected（涉 MCP 行为时）
```

---

## 二、任务总览与优先级

| 编号 | 任务 | 优先级 | 风险 | 预估 |
|------|------|--------|------|------|
| T1 | 修正 package.json 版本号 + 建立版本单一来源 | P0 | 低 | 15min |
| T2 | 进程内嵌 qmd（BM25 索引内置化） | P1 | 中 | 2-4h |
| T3 | gitnexus 常驻连接复用 | P1 | 中 | 2h |
| T4 | max_find_docs / max_trace_arch 结果缓存 | P2 | 低 | 1h |
| T5 | cocoindex-code 语义搜索（第 9 个工具 max_search_semantic） | P2 | 中 | 4-6h |
| T6 | 编辑后自动增量索引 hooks（可选开关） | P3 | 中 | 3h |
| T7 | npm 发布 graft-max（脱离本机路径依赖） | P2 | 低 | 1-2h |
| T8 | 测试基线收敛：消灭 11 个上游遗留 flaky | P3 | 低 | 2h |
| T9 | Dashboard 功能增强 | P3 | 低 | 按需 |
| T10 | 清理旧产物（自研改造的屎山清理） | P2 | 低 | 1h |

执行顺序建议：**T1 → T10 → T2 → T3 → T4 → T5 →（T7/T8 并行）→ T6/T9 按需**。
理由：T1 是版本一致性根问题；T10 清理后再动大刀；T2/T3 是性能主线；T5 依赖 T2 的"工具注册扩展"经验。

---

## 三、各任务详细方案

### T1 · 版本号一致性修复（P0，先做）

**问题**：`package.json` 是 `0.28.0-max.1`，但 CHANGELOG 已记录到 `0.28.0-max.6`。`node dist/cli.js --version` 的输出与实际功能版本不符，E2E 报告里 initialize 返回的也是 max.1 —— 身份混乱，违反项目约束 §1 的"npm 包名/版本号"约定。

**方案**：
1. `package.json` version → `0.28.0-max.7`（下一个补丁位）
2. 顺手收尾：`package.json` 的 `repository.url` / `homepage` / `bugs` 还指向上游 `trailhq/Trail-Code`，改为 `https://github.com/lza6/graft-Max`（品牌化遗漏项）
3. 建议加 `scripts/bump-version.ps1`：唯一入口改 version + 自动追加 CHANGELOG 段，杜绝双源漂移

**验收**：`node dist/cli.js --version` = `0.28.0-max.7`；E2E initialize 返回新版本；`grep trailhq package.json` 无残留。

---

### T2 · 进程内嵌 qmd（P1，性能主线）

**目标**：`max_find_docs` 从 spawn qmd CLI（293ms）改为进程内 BM25 查询（<50ms），且不再要求用户 `npm install -g @tobilu/qmd`。

**根因分析**：当前 293ms 花在——cmd shim spawn（~80ms，Windows 已知坑）+ node 启动（~120ms）+ qmd 自身索引加载（~90ms）。后两项中"node 启动"完全可省，"索引加载"可通过常驻省掉。

**方案（两档，推荐 A）**：
- **方案 A（推荐）**：把 qmd 的 BM25 核心作为依赖引入（或 fork 其核心 ~200 行到 `src/mcp/fed-qmd/`），索引构建仍可调用外部 qmd 或自实现。`federation.ts` 的 `max_find_docs` 改为直接调用本地模块。
  - 优点：零 spawn、无 shim 坑；缺点：需维护一段上游代码。
- **方案 B**：保留 spawn，但起一个常驻 qmd 进程，通过 stdin/stdout JSON-RPC 复用（类似 T3 gitnexus 方案）。
  - 优点：不引入上游代码；缺点：仍是跨进程，收益打折。

**改动范围**：
- `src/mcp/federation.ts`（max_find_docs 实现 + probe 逻辑）
- `src/mcp/server.ts`（工具描述里"需安装 qmd"文案改为"内置"）
- 新增 `test/fed-qmd.test.ts`
- `README.md` 快速上手第 5 步删掉 qmd 安装要求

**约束**：probe 未安装/索引不存在时的降级行为必须保留（隐藏工具）；`max_find_docs` 输出格式不变（E2E 有断言 `qmd://...` URI 格式）。

**验收**：E2E max_find_docs 用例 P95 < 80ms；输出格式不变；未建索引时工具正确隐藏或返回友好中文错误。

---

### T3 · gitnexus 常驻连接复用（P1）

**目标**：`max_trace_arch` 从每次完整 stdio 握手（1244ms）降为复用常驻连接（~300ms）。

**方案**：
1. `federation.ts` 内建一个 `GitnexusSession` 类：首次调用时 spawn gitnexus + 完成 MCP 握手（initialized 通知，E2E 坑 #2）+ `tools/list`，之后每次 `tools/call` 直接写 stdin 分步写、保持管道打开（坑 #3）
2. 生命周期：挂在现有 stdin-leash 上（server 退出时 kill 子进程）；闲置 10 分钟自动回收（与 leash 同节奏）；崩溃后自动重建一次，二次失败降级为"每次握手"老路径
3. probe 结果与 session 状态合并缓存

**改动范围**：`src/mcp/federation.ts`；新增 `test/fed-gitnexus-session.test.ts`（fake gitnexus server 可参考 `test/fake-trail-server.ts` 模式）。

**验收**：E2E max_trace_arch 连续 3 次调用，第 2/3 次 < 500ms；杀掉 gitnexus 子进程后下一次调用自动重建成功。

---

### T4 · 联邦工具查询结果缓存（P2，小而值）

**方案**：`federation.ts` 加一个 60s TTL 的 LRU（key = 工具名+参数 JSON hash），命中直接返回并标注 `[cached]` 前缀行。Agent 在同一会话反复查同一问题时省 token 省时延。
**风险**：缓存过期语义——BM25 索引变了结果不新鲜。60s TTL + 工具描述里说明即可，不做失效监听（过度设计）。
**验收**：同参数二次调用 < 5ms 且带 `[cached]` 标注；不同参数不命中。

---

### T5 · cocoindex-code 语义搜索（第 9 个工具）

**目标**：新增 `max_search_semantic`——向量语义代码搜索，与 BM25/图谱互补（自然语言→代码语义）。

**前置调研**（写代码前必须确认，不确定就停下问）：
- cocoindex-code 的 API 形态：CLI / 库 / MCP server？嵌入是否需要付费 API（**红线：付费 API 预算 0**，若需 OpenAI embedding 则改为本地嵌入模型如 bge-small ONNX 或放弃）
- Δ-only 增量（改造日志提到已验证 0.5s）在本机怎么复现

**方案骨架**（比照 federation.ts 的 max_trace_arch 模式）：
1. 新文件 `src/mcp/fed-semantic.ts`，注册第 9 个工具
2. probe：cocoindex 未装/未建索引 → 隐藏工具（与 max_find_docs 同门控）
3. 结果格式：`file:line + score + 代码片段`，与 max_find_code 对齐
4. E2E：新增 `e2e/e2e-semantic.mjs`

**验收**：对 graft-Max 自身仓库查询 "spawn 子进程的超时处理" 类问题，返回相关 file:line；8+1 工具 tools/list 正常；未装时零 schema 占用。

---

### T6 · 编辑后自动增量索引 hooks（P3，默认关）

**方案**：GraFt 已有 hooks 基础设施（`src/claude/` hooks 层）。增加可选 hook：PostToolUse(Write/Edit) → 节流 5min → 图谱增量索引（后台 spawn，不阻塞）。默认关闭，`GRAFT_MAX_AUTO_INDEX=1` 或面板开关启用。
**理由默认关**：项目少时手动建图足够；后台进程又多一个僵尸面。
**验收**：开启后编辑文件 → 面板"建图状态"显示增量进行 → 完成后 max_find_code 查到新符号。

---

### T7 · npm 发布 graft-max（P2）

**步骤**：
1. T1 完成后（版本/仓库字段正确）
2. 补 `files` 字段（dist/ viewer/ README/ LICENSE/ CHANGELOG/，排除 test/ e2e/ vendors/）
3. `npm pack` 干跑检查体积与内容清单
4. `npm publish`（需 npm 账号 + 若用 scope 则 `--access public`）
5. 全局安装自测：`npm i -g graft-max` → `graft-max mcp` 注册路径不再是本机绝对路径（检查 switch-mcp / hosts 注册逻辑对"全局安装"路径的兼容——当前约束 §1.5 写死了 `node <dist>/cli.js` 绝对路径，**需支持解析全局 bin**，这是本任务的隐藏改动点）
6. CHANGELOG 追加发布记录

**风险**：约束 §1.5 "Max 永远注册为 node <dist>/cli.js 绝对路径" 与全局安装冲突 → 注册逻辑需改为优先全局 bin、本机源码兜底。

---

### T8 · 测试基线收敛（P3）

**现状**：11 个 fail 全是上游遗留（trail 同步/日期用例），每次验证都要"心算新增失败"，长期是噪音。
**方案**：逐个定性——是 Windows 环境问题（时区/路径分隔符）就修；是上游代码 bug 且 graft-Max 不走该功能，就加 `it.skip` + 注释注明上游 issue 链接与原因；**禁止削弱有效断言来让测试变绿**。
**验收**：`npm test` 全绿或所有 skip 有注释说明。

---

### T9 · Dashboard 增强（P3，按需挑选）

候选（按价值排序）：
1. **工具调用耗时趋势图**：devlog 已记录每次调用耗时，前端加 sparkline，直观看 T2/T3 优化前后的收益
2. **联邦工具状态卡**：qmd/gitnexus probe 状态 + 延迟常显（现在要翻日志）
3. 会话列表排序/筛选、自动刷新节流优化

**约束**：dashboard 是单文件内联 JS，改动后必须跑 `e2e/ui-interact.mjs`（7/7）+ 语法检查（上次修了三处内联脚本语法错误，教训：模板字面量别嵌 `</script>`、`\n` 转义）。

---

### T10 · 旧产物清理（P2）

**清单**（动手前逐项确认无引用）：
- `docs-selfdev/自研说明.md` 内容已过时（还在描述"graft 源码副本"时代的整合计划，与当前 max.6 状态矛盾）→ 合并进 `改造日志.md` 后删除
- 根目录 `README-upstream.md`：保留（上游同步参照物，但文件头加一行"仅上游同步参考用"）
- 检查 `dist/` 中是否有上游遗留的无主文件（build 后对比 src 模块清单）
- git 历史里的旧计划文件（若有 mcp-aggregation-plan 等 md 残留）归档到 `改进计划/archive/`

**验收**：`npm run build` + `npm test` 通过；docs-selfdev 只剩与现状一致的文档。

---

## 四、横切约束（所有任务通用，违反即返工）

1. **上游兼容红线**：graft_* 六件套与 legacy 别名逐字节不动；改 `server.ts` 时 tools/list 顺序只增不改
2. **身份环境变量**：新子进程逻辑若需识别 Max，必须走 `GRAFT_MAX_INVOKED_AS` 继承，不用模块变量
3. **Windows 优先**：所有 spawn 走 federation.ts 已沉淀的两段式模式；路径用 fileURLToPath 绝对路径；新进程挂 stdin-leash
4. **上下文预算**：新工具必须走 probe 门控，未安装 = 零 schema；initialize.instructions 保持 <1000 字符
5. **槽位隔离**：任何注册行为只在 `GRAFT_MAX_MCP=1` 下发生，永不触碰上游槽位
6. **测试**：新功能必有真实测试（参考现有 test/ 命名风格 `fed-*.test.ts`）；E2E 用 mjs 脚本进 e2e/ 并更新 E2E-REPORT.md
7. **文档同步**：CHANGELOG.md 追加、docs-selfdev/改造日志.md 记"改了什么/为什么/怎么验证"三段
8. **验证链**：见第一节，五步全绿才算完成；MCP 行为改动另加 `claude mcp list` + 真实会话调用一次

## 五、验收总表（全部完成后检查）

- [ ] `node dist/cli.js --version` 与 CHANGELOG 最新版本一致
- [ ] `package.json` 无 trailhq 残留引用
- [ ] `node e2e/e2e-federation.mjs` 9/9，且 max_find_docs < 80ms、max_trace_arch 二次调用 < 500ms
- [ ] `npm test` 无新增 fail（目标：全绿）
- [ ] 未安装联邦后端的干净环境下 tools/list 只出 graft 六件套（零 max_* schema 泄漏）
- [ ] Dashboard `e2e/ui-interact.mjs` 7/7
- [ ] `npm pack` 产物可全局安装并正常注册
- [ ] docs-selfdev 与现状一致，无过时文档残留
