<div align="center">

# graft-Max

**一个 MCP server，八大工具 —— 仓库上下文图谱 + 联邦检索，为 Claude Code 深度定制**

`graft v0.28.0 深度 fork` · `全部工具 max_* 命名` · `免费本地零 API key` · `Windows 原生`

[快速上手](#快速上手) · [工作原理](#工作原理) · [性能实测](#性能实测) · [开发者面板](#开发者面板) · [维护指南](#维护指南-development) · [路线图](#路线图)

</div>

---

## 这是什么（小白版）

**一句话**：graft-Max 让 Claude Code「看懂你的整个仓库」——它把代码建成本地知识图谱，Agent 查一次顶几十次 grep + 翻文件，还能顺便查文档、查架构依赖。

**你有两种身份读这份文档**：

- 🧑‍💻 **我只是想用** → 看[快速上手](#快速上手)（10 分钟）和[日常怎么用](#日常怎么用)（零命令，说人话就行）
- 🔧 **我要维护/二开** → 看[工作原理](#工作原理)、[维护指南](#维护指南-development)、[路线图](#路线图)，源码全在本地（含上游 vendors/）

### 它和原版 graft 的区别

| | 原版 graft | graft-Max |
|---|-----------|----------|
| MCP 工具 | `graft_find_code` 等 6 个 | **`max_find_code` 等 8 个**（一眼识别 Max） |
| 文档/笔记检索 | ❌ | ✅ `max_find_docs`（qmd BM25） |
| 架构级依赖链 | ❌ | ✅ `max_trace_arch`（gitnexus） |
| 自动建图 | 需手动 `graft init` + `build` | ✅ 首次查询**自动建图**（~2 秒） |
| 开发者面板 | ❌ | ✅ `http://127.0.0.1:24688` 实时日志 + 谁在用 |
| 日志 | 编辑器 stderr 里看不全 | 中文彩色分级 + 5MB 滚动永不撑爆磁盘 |
| 全局提示词 | 手动写 | ✅ 自动注入 `~/.claude/CLAUDE.md` 头部（幂等） |
| 与上游关系 | — | 源码 fork（`vendors/` 还收编了 5 个配套上游），**不走上游 npm 包** |

---

## 快速上手

### 前置要求

- Node.js 18+、npm、Git（Windows 10/11 原生，无需 WSL）
- Claude Code（任何最近版本）

### 安装（10 分钟）

```powershell
# 1. 拿到源码（本机已有就跳过）
git clone https://github.com/lza6/graft-Max.git D:\自研工具\graft-Max
cd D:\自研工具\graft-Max

# 2. 构建（~30 秒）
npm install
npm run build          # tsc 0 错误 + viewer bundle + 语法 wasm

# 3. 注册到 Claude Code（user 作用域，全项目可用）
claude mcp add graft-max --scope user -- node "D:\自研工具\graft-Max\dist\cli.js" mcp
claude mcp list        # 看到 graft-max ✔ Connected 即成功

# 4. 打开开发者面板 + 日志（写进用户环境变量，一次即可）
[Environment]::SetEnvironmentVariable("GRAFT_MAX_LOG", "1", "User")
[Environment]::SetEnvironmentVariable("GRAFT_MAX_UI",  "1", "User")

# 5.（联邦工具后端，可选但推荐）
npm install -g @tobilu/qmd        # max_find_docs 后端
npm install -g gitnexus           # max_trace_arch 后端
```

**完成。** 新开一个 Claude Code 会话，graft-Max 自动生效：8 个 `max_*` 工具自动可用、
全局提示词自动注入、面板在 `http://127.0.0.1:24688`。

### 日常怎么用

**你不需要记任何命令**。在 Claude Code 里说人话：

| 你说 | Agent 自动用 | 背后 |
|------|-------------|------|
| "这个项目的登录逻辑在哪？" | `max_find_code` | 图谱查询，返回精确 file:line + 内联代码 |
| "找出所有用到 retry 的地方" | `max_find_all` | 穷举搜索，按耦合度排序 |
| "重构这个函数前，改它会影响什么？" | `max_trace_calls` | 爆炸半径，重构前必查 |
| "我们笔记里有没有写过部署流程？" | `max_find_docs` | qmd BM25 查文档（需先 `qmd collection add <目录> --name <名字>`） |
| "auth 模块被谁依赖？" | `max_trace_arch` | gitnexus 架构图谱 |
| "这个文件有哪些 API？" | `max_file_api` | ~200 token 看完整个文件的签名 |

**首次进入一个新仓库**：什么都不用做——第一次查询时 graft-Max 自动建图（小仓库
~2 秒，大仓库按体积），之后每次查询前自动增量刷新，永远反映未提交的编辑。

**怎么验证它真的在被使用**：
1. 浏览器打开 `http://127.0.0.1:24688` → 「活跃会话」表里你的会话 ● LIVE，请求数随对话增长
2. 「实时日志」里能看到每次调用：几点几毫秒、哪个工具、输入参数、输出、耗时、是否出错

### 一键切回原版

```powershell
python D:\自研工具\graft-Max\scripts\switch-mcp.py orig   # 切回 npx @nanonets/graft + 摘除全局提示词
python D:\自研工具\graft-Max\scripts\switch-mcp.py max    # 切回 graft-Max
python D:\自研工具\graft-Max\scripts\switch-mcp.py status # 看当前状态
```

---

## 工作原理

### 总架构

```
Claude Code 会话
   │ (一个 MCP stdio 连接)
   ▼
graft-Max server（dist/cli.js mcp）
   ├─ graft 六件套引擎（符号图谱，tree-sitter 解析 → graft/ 目录的 md 节点）
   ├─ max_find_docs ──── spawn qmd search ────→ qmd BM25 索引（~/.cache/qmd）
   └─ max_trace_arch ─── spawn gitnexus mcp ───→ gitnexus 图数据库（.gitnexus/）
   │
   ├─ 开发者日志（~/.graft-max/mcp.log，中文，5MB 滚动 + 14 天裁剪）
   ├─ 会话注册表（~/.graft-max/sessions.json：pid/宿主/仓库/请求数）
   └─ Dashboard（127.0.0.1:24688，只绑本机）
```

### 八个工具的分工（互补不打架）

| 层 | 工具 | 回答的问题 |
|----|------|-----------|
| 符号层 | `max_find_code` / `max_find_all` / `max_file_api` | "这段代码在哪/怎么实现"（LSP 级精确） |
| 结构层 | `max_trace_calls` / `max_repo_map` / `max_check_freshness` | "谁调用它/改它影响什么"（图谱边） |
| 架构层 | `max_trace_arch` | "模块 A 依赖模块 B 吗"（gitnexus 图数据库） |
| 文档层 | `max_find_docs` | "我们的笔记/规格怎么写的"（BM25 全文） |

### 自动建图原理（为什么不用手动 init）

上游只在 trail 布局仓库自动建图。graft-Max 放开了这个门槛：`ensureFreshGraph`
发现 `graft/.graph/wiring.json` 不存在时，若满足「真仓库」条件（非家目录、无
--dir 覆盖、GRAFT_MAX_MCP=1），取锁后启动首次构建。防重复是双保险：

1. **存在性检查**：wiring.json 在 → 跳过（后续查询 19-20ms 直连）
2. **文件锁**：多会话并发首查时，只有一个进程真正 build，其余等锁后直连

### 查询前自动刷新原理（agent 实时性）

每次 `tools/call` 前跑 `ensureFreshGraph`：对仓库做指纹采样（文件 mtime/size/
hash），与图谱指纹 diff。零漂移 ~3ms 直连；有漂移走 Δ-only 增量重建（只重新
解析变更文件）。**所以 agent 编辑文件后立刻查询，图谱已是"现在"的状态**——
实测写文件后 221ms 刷新且命中刚写入的符号。

### 联邦路由原理（一个 server 怎么带三个后端）

`src/mcp/server.ts` 的 tools/list 把 graft 六件套与联邦工具合并暴露；
tools/call 按名字路由：`max_find_docs`/`max_trace_arch` 走 federation.ts 的
子进程代理（qmd 直跑 CLI；gitnexus 走完整 MCP stdio 握手：initialize →
notifications/initialized → tools/list → tools/call，分步写防 cmd-shim 管道
丢消息）。**路由顺序**：联邦工具原生 max_* 名先匹配，再做 max_→graft_ 改写。

### 日志与防膨胀

- 每条日志：`[本地时间.毫秒] 中文动作描述 + 参数 + 输出(截 2000 字符) + 耗时 + isError`
- 5MB 滚动（`mcp.log → mcp.log.1`，双文件 10MB 硬上限）+ 启动时清 14 天前行
- 写失败静默——日志永远不能拖垮 server

### 全局提示词注入原理

`~/.claude/CLAUDE.md` 头部插入 `graft-max:start/end` 标记块（中文引导：先图谱后
grep、重构先 trace_calls 等）。幂等三态：created/updated/unchanged——块存在且
内容一致时零写入。用独立标记，与 icm 等其他工具的区块互不干扰（E2E 验证 icm
块完整）。切回原版（switch-mcp.py orig）自动摘除整块，零残留。

---

## 性能实测

全部数字来自本仓库真实 E2E（30 项断言，`e2e/` 四套脚本可复跑）：

| 操作 | 耗时 | 说明 |
|------|------|------|
| 首次建图（本仓库 4 文件） | 2.0s | tree-sitter 解析 + md 节点生成 |
| 增量刷新（无变更） | 3ms | 指纹比对直连 |
| 增量刷新（有编辑） | 221ms | Δ-only，只重新解析变更文件 |
| `max_find_code` 查询 | 60-160ms | 图谱查询 + 结果渲染 |
| `max_find_docs`（qmd BM25） | 293ms | 含子进程 spawn |
| `max_trace_arch`（gitnexus） | 1244ms | 含 MCP stdio 握手 + 图查询 |
| 同目录 5 会话连开 | 提示词仍 1 块 | 幂等注入（unchanged 路径零写） |
| 同仓库 5 次查询 | 无重复建图 | 19-20ms/次 |
| 服务器启动 → 可查询 | ~900ms | 含 upkeep + 会话注册 |
| 构建验证链 | tsc 0 错误 | `npm run build` 全绿 |

**测试基线**：`npm test` 4036 pass / ~10 fail（上游在本机即有的 flaky，非核心
路径）；四套 E2E 全绿：`e2e-federation` 9/9、`e2e-dashboard` 4/4、
`e2e-live-scenario` 8/8、`e2e-idempotent` 9/9。

---

## 开发者面板

浏览器打开 `http://127.0.0.1:24688`（GRAFT_MAX_UI=1 的会话启动时自动开）：

- **统计卡片**：活跃会话数 / 累计工具调用 / 日志大小 / 面板地址
- **活跃会话表**：谁在用——pid、用户、宿主进程（哪个编辑器拉起的）、仓库路径、请求数（实时增长）、启动时间
- **实时日志**：2 秒轮询，彩色分级（启动橙 / 联邦紫 / 错误红 / 时间戳灰），自动滚底
- 亮暗双主题（🌓 切换），设计 tokens 对齐上游 viewer
- 端口被占自动 +1~+9；只绑 127.0.0.1 永不暴露网络

截图见 `e2e/dashboard-dark.png` / `e2e/dashboard-light.png`。

---

## 环境变量速查

| 变量 | 默认 | 作用 |
|------|------|------|
| `GRAFT_MAX_LOG` | 关 | `1` 开日志（默认 `~/.graft-max/mcp.log`）；设为路径可重定向 |
| `GRAFT_MAX_UI` | 关 | `1` 开面板（端口 24688）；设为端口号自定义 |
| `GRAFT_MAX_MCP` | 关 | `1` 时 init 注册 `graft-max` id + 自动建图 + 全局提示词生效 |
| `GRAFT_MAX_INVOKED_AS` | — | 进程树 Max 身份标记（自动设置，勿手改） |
| `GRAFT_MCP_NPX` | 关 | 上游兼容：强制 npx 形式注册（原版行为） |

---

## 维护指南 (Development)

### 构建与验证链（每次改动必跑）

```powershell
npx tsc --noEmit               # 类型 0 错误
npm run build                  # 构建全绿
node dist/cli.js --version     # 0.28.0-max.N
npm test                       # 基线 4036 pass / ~10 fail（上游本机 flaky）
node e2e/e2e-federation.mjs    # 9/9
node e2e/e2e-dashboard.mjs     # 4/4
node e2e/e2e-live-scenario.mjs # 8/8
node e2e/e2e-idempotent.mjs    # 9/9
```

**净新增失败 = 0 才算过**（对比改动前的 fail 集合）。

### 项目约束（红线条目，详见 docs-selfdev/项目约束.md）

1. graft_* 工具行为与上游逐字节兼容；品牌走环境变量不走路由 hack
2. 未邀请 graft 的仓库 = 零工具（context 预算哲学）
3. 联邦工具永不 throw（失败返回 isError + 修复命令）；子进程硬超时
4. 绝不整写 `~/.claude.json`（含大小写重复键，只能字节级精准替换——曾把
   246KB 配置截成 852B 的血泪教训）
5. 不引入付费 API、不引入本地大模型（算力红线）

### 同步上游

```powershell
# graft-Max 自身（fork of nanonets/graft）
git fetch upstream && git merge upstream/main   # 解决冲突 → 跑验证链
# vendors/ 里的配套上游（qmd/gitnexus/context-mode/icm/cocoindex-code）
cd D:\自研工具\vendors\<name> && git pull
```

### 目录导览

| 路径 | 内容 |
|------|------|
| `src/mcp/server.ts` | MCP server 本体（JSON-RPC 循环 + 路由） |
| `src/mcp/federation.ts` | 联邦工具（qmd/gitnexus 代理） |
| `src/mcp/devlog.ts` | 中文日志层 + 会话注册表 + 滚动 |
| `src/mcp/dashboard.ts` | Web 面板 |
| `src/brand.ts` | 三品牌机制（graft/trail/**graft-Max**） |
| `src/hosts/max-prompt.ts` | 全局提示词注入/摘除 |
| `docs-selfdev/` | **自研知识库**：改造日志、项目约束、整合设计 |
| `e2e/` | 四套真实 E2E + 截图 |
| `vendors/`（上级目录） | 5 个配套上游的完整源码 |

---

## 路线图

- [x] v0.28.0-max.1 品牌化基座 + MCP 联邦层 + Dashboard + 自动建图 + 全局提示词
- [x] 一键切换（max/orig）+ 幂等保障 + 日志防膨胀
- [ ] **进程内嵌 qmd**：把 BM25 索引直接嵌进 graft-Max（省一次 spawn，预计 293ms → <50ms）
- [ ] **gitnexus 常驻**：架构图查询复用连接（1244ms → ~300ms）
- [ ] **cocoindex-code 集成**：语义代码搜索作为第 9 个工具（Δ-only 增量已验证 0.5s）
- [ ] **编辑后自动增量索引 hooks**（项目多了再开，当前手动 ccc index）
- [ ] **上游发版跟踪**：graft 0.29+ 的 viewer 改进择机合并
- [ ] ** 发布 graft-max 到 npm**（私有 scope），脱离本机路径依赖

---

## License

遵循上游 LICENSE（nanonets/graft，MIT）。graft-Max 品牌层、`docs-selfdev/`、
`e2e/`、federation/dashboard/devlog 归本项目。
