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
| MCP 工具 | `graft_find_code` 等 6 个 | **`max_find_code` 等 6 个 + 最多 3 个联邦工具**（装了什么后端就自动出现什么，没装的不占 schema 预算） |
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

**完成。** 新开一个 Claude Code 会话，graft-Max 自动生效：6 个 `max_*` 工具 + 已装后端对应的联邦工具自动可用、
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

### 九个工具的分工（互补不打架）

> 前 6 个（符号/结构层）永远在；后 3 个是联邦工具，**后端没装就自动隐藏**——
> 不装 qmd 就没有 `max_find_docs`，不装 gitnexus 就没有 `max_trace_arch`，
> 不装 ccc 就没有 `max_search_semantic`（未邀请的仓库则连这 6 个也不给）。

| 层 | 工具 | 回答的问题 |
|----|------|-----------|
| 符号层 | `max_find_code` / `max_find_all` / `max_file_api` | "这段代码在哪/怎么实现"（LSP 级精确） |
| 结构层 | `max_trace_calls` / `max_repo_map` / `max_check_freshness` | "谁调用它/改它影响什么"（图谱边） |
| 架构层 | `max_trace_arch` | "模块 A 依赖模块 B 吗"（gitnexus 图数据库） |
| 文档层 | `max_find_docs` | "我们的笔记/规格怎么写的"（qmd BM25 全文，毫秒级、零模型） |
| 语义层 | `max_search_semantic` | "不记得关键词、只记得意思"（ccc 本地嵌入，~380ms） |

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

- **KPI 卡 5 张**：活跃会话 / 累计工具调用（带错误率趋势，>10% 标红） / 日志大小 / 建图状态（建图中显示仓库、已耗时与产物体积增长曲线） / 面板地址
- **活跃会话表**：谁在用——pid、用户、宿主进程（哪个编辑器拉起的）、仓库路径、请求数（实时增长）、启动时间、**容器标识徽章**
- **工具耗时卡**：每个工具的次数 / 平均 / **p50 / p95** / 错误数 + 分布条（性能收益的可视化证据）
- **联邦后端卡**：qmd / gitnexus / ccc 的探针状态、距今多久、安装/修复命令（一键复制）、**「重试探针」按钮**——装完后端不用重启会话
- **存储 / 产物卡**：每个产物文件/目录的绝对路径与占用，**按仓库分组**（一张面板看全部仓库），一键复制路径
- **索引新鲜度卡**：图谱指纹 vs 工作区（改/增/删几个文件、上次同步时间）
- **实时日志**：2 秒轮询（间隔可调，最小 500ms），彩色分级（启动橙 / 联邦紫 / 错误红 / 时间戳灰），筛选 chips、暂停/继续、自动滚底
- 亮暗双主题（🌓 切换，localStorage 持久化），窄屏 430px 无横向溢出
- 端口被占自动 +1~+9；**只绑 127.0.0.1**，非回环绑定强制令牌 + Host 校验

### 面板的安全边界（两种形态，规则不同）

| 形态 | 绑定 | 鉴权 |
|------|------|------|
| 宿主（默认） | `127.0.0.1` | 默认免令牌（本机便利工具）；`GRAFT_MAX_UI_TOKEN=<串>` 可显式开启 |
| 容器 / 非回环 | `0.0.0.0` | **强制令牌**（未给则启动时随机生成，URL 打到 stderr）+ Host 白名单 + 无鉴权探活 `/healthz` |

- 令牌携带方式：`Authorization: Bearer`、`?token=`、或 Cookie（点一次带 `?token=` 的 URL 自动种下 HttpOnly Cookie）
- 所有响应带 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`、最小 CSP
- Host 伪造（DNS rebinding）→ `403`；无令牌打数据端点 → `401`
- **日志落盘前自动脱敏**（`GRAFT_MAX_LOG_REDACT`，默认开）：工具入参/输出里明显密钥形态的串
  （`sk-…`/`ghp_…`/`AKIA…`/`Bearer …`/`api_key=` 等）被掩码成 `前4字符***` —— 日志会经
  `/tail` 进浏览器，不该成为密钥的第二个家
- 前端是独立工程（`panel/`，esbuild 构建到 `dist/panel/`）。旧版内联页已在 max.11 删除（清退承诺兑现），面板只有一份 HTML

截图见 `e2e/dashboard-dark.png` / `e2e/dashboard-light.png` / `e2e/dashboard-storage.png`（存储视图）。

---

## Docker 部署

镜像定义在 `Dockerfile.max`（与上游 GitHub App 的 `Dockerfile` 完全独立：那个是 HTTP webhook 服务，
这个是 MCP stdio + 可选 Dashboard）。编排文件 `docker-compose.max.yml`。

### 构建

```powershell
docker build -f Dockerfile.max -t graft-max:latest .
```

**国内网络开箱可用**：apt 走 `mirrors.aliyun.com`、npm 走 `registry.npmmirror.com`
（容器内实测直连可达），不需要代理、不需要 `--network=host`。
海外或要走代理时覆盖：`--build-arg APT_MIRROR=deb.debian.org --build-arg NPM_REGISTRY=https://registry.npmjs.org`。

**构建很快（~20-60 秒）的原因**：所有原生 tree-sitter 语法包都是 devDependencies，
运行时用 WASM 语法（`tree-sitter-wasm` + `web-tree-sitter`），所以 `npm ci --ignore-scripts`
跳过原生编译即可——不需要 python3/make/g++，也就没有 gcc/g++ 那 40MB 大包的下载风险。

镜像体积：默认（含 qmd）**3.2GB**；`--build-arg INSTALL_QMD=0` 的瘦身版 **977MB**
（`max_find_docs` 会因后端缺失被 probe 门控自动隐藏）。

可选构建参数（默认值即下面这样，按需开）：

| 参数 | 默认 | 说明 |
|------|------|------|
| `INSTALL_QMD` | `1` | 镜像内装 `@tobilu/qmd`（`max_find_docs` 后端） |
| `INSTALL_CCC` | `0` | 装 `cocoindex-code`（`max_search_semantic` 后端，约 +2GB） |
| `INSTALL_GITNEXUS` | `0` | 装 `gitnexus`（`max_trace_arch` 后端） |

未安装的后端工具按 probe 门控自动隐藏（零 schema 占用），`max_find_code` 等六件套始终可用。

### 用法一：MCP stdio（推荐，接 Claude Code）

```powershell
# 手动试跑（-i 必须：MCP 走 stdin/stdout）
docker run -i --rm -v "D:\你的仓库:/workspace" graft-max:latest mcp

# 注册到 Claude Code（user 作用域，全项目可用）
claude mcp add graft-max-docker --scope user -- docker run -i --rm `
  -v "D:\你的仓库:/workspace" graft-max:latest mcp
claude mcp list   # 看到 graft-max-docker ✔ Connected
```

注意：`-v` 的宿主路径要写**仓库绝对路径**；容器内建图产物（`graft/`、`.trail/`）写回挂载目录，
宿主上照样能看到、`git status` 里也与本地建图一致。

### 用法二：Dashboard 常驻

```powershell
# 一键起（REPO_DIR 默认 duck2api-hub，你自己的仓库用环境变量覆盖）
$env:REPO_DIR="D:\你的仓库"; docker compose -f docker-compose.max.yml up -d
# 面板：http://127.0.0.1:24688  （日志 / 会话 / 存储与 DB 占用全在里面）
docker compose -f docker-compose.max.yml logs -f max
docker compose -f docker-compose.max.yml down
```

常驻模式的两处差异（compose 里已配好）：
- `GRAFT_MAX_LEASH=0`：容器没有 MCP 宿主的 stdin 流量，stdin-leash 10 分钟自退必须关掉，否则容器一启动就因 stdin EOF 退出。
- `GRAFT_MAX_UI_HOST=0.0.0.0`：容器内若仍绑 `127.0.0.1`，`-p 24688:24688` 打不进去
  （Docker DNAT 目标是容器 eth0，不是 loopback）——镜像里已默认设好。
- qmd 索引放命名卷 `qmd-index`，容器重建不丢。

### 验证

```powershell
node e2e/e2e-docker.mjs      # D1 版本 / D2 MCP 握手 / D3 真实调用 / D4 面板+存储 / D5 非 root / D6 常驻存活
```

---

## 环境变量速查

| 变量 | 默认 | 作用 |
|------|------|------|
| `GRAFT_MAX_LOG` | 关 | `1` 开日志（默认 `~/.graft-max/mcp.log`）；设为路径可重定向 |
| `GRAFT_MAX_UI` | 关 | `1` 开面板（端口 24688）；设为端口号自定义 |
| `GRAFT_MAX_MCP` | 关 | `1` 时 init 注册 `graft-max` id + 自动建图 + 全局提示词生效 |
| `GRAFT_MAX_INVOKED_AS` | — | 进程树 Max 身份标记（自动设置，勿手改） |
| `GRAFT_MAX_LEASH` | 开 | `0` 关闭 stdin-leash（Docker 常驻容器必开此值，否则 10 分钟自退） |
| `GRAFT_MAX_UI_HOST` | `127.0.0.1` | 面板绑定地址。容器里必须 `0.0.0.0` 才能被 `-p` 端口映射打到（Dockerfile 已设）；宿主用法保持默认即可 |
| `GRAFT_MAX_AUTO_INDEX` | 开 | `0` 关闭「编辑后自动增量索引」（post-edit 触发后台建图） |
| `GRAFT_MAX_SYNC_THROTTLE_MS` | 60000 | 自动增量索引的最小间隔（毫秒） |
| `GRAFT_MAX_UI_TOKEN` | 自动 | 面板数据端点令牌。非回环绑定**强制**开启（未给则随机生成）；回环默认关，设非空值即开启，`0` 显式关闭（仅回环形态有效） |
| `GRAFT_MAX_ICM` | 开 | ICM 时序记忆。`0` 关闭；`2` 干跑（只计数不 spawn，E2E/单测用） |
| `GRAFT_MAX_ICM_TIMEOUT_MS` | 5000 | 单次 ICM 批量写入的硬超时 |
| `GRAFT_MAX_FIRST_BUILD_WAIT_MS` | 20000 | 首查等建图的上限（上游是 90000；超时后立刻返回"后台建图中+重试指引"）。建图期间面板显示产物体积增长曲线（每 500ms 采样） |
| `GRAFT_MAX_FED_WATCH` | 开 | `0` 关闭联邦后端的 60s 探针心跳（心跳让"中途装上的后端"自动出现） |
| `GRAFT_MAX_LOG_REDACT` | 开 | 日志脱敏开关。默认把**明显密钥形态**（`sk-…`、`ghp_…`、`AKIA…`、`xox…`、`Bearer …`、`api_key=/token:/password=` 等）在落盘前掩码成 `前4字符***`；`0` 关闭（排障需要看原文时）。只脱密钥，不碰代码/路径 |
| `GRAFT_MAX_REPROBE_MIN_MS` | 2000 | 面板「重试探针」(`/reprobe`) 的最小间隔，`0` 关闭节流（默认 2s 防本机页面 spam 触发子进程） |
| `GRAFT_MAX_FED_WATCH_MS` | 60000 | 联邦后端探针心跳间隔（毫秒）。决定"装完后端多久自动出现工具"：最坏 = 心跳间隔 + 失败 TTL 30s |
| `GRAFT_MAX_FEDERATED` | 开 | `0`/`false` 一键关掉**全部联邦工具**（`max_find_docs`/`max_trace_arch`/`max_search_semantic`），只剩 graft 六件套 —— schema 预算吃紧或排查 graft 本体问题时用 |
| `GRAFT_MCP_NPX` | 关 | 上游兼容：强制 npx 形式注册（原版行为） |

---

## 维护指南 (Development)

### 构建与验证链（每次改动必跑）

```powershell
npx tsc --noEmit               # 类型 0 错误
npm run build                  # 构建全绿（含 panel 前端的 tsc + esbuild）
node dist/cli.js --version     # 0.28.0-max.N
npm test                       # 本轮基线：0 fail（4292 tests / 4187 pass）
node scripts/check-coverage.mjs # 自研 8 文件覆盖率门禁（语句≥80%/分支≥70% Win）
node scripts/log-attribution.mjs # 日志归因：哪个仓库·何时·暴露了什么·实际调了什么（--json 可机读）
node e2e/e2e-ci-smoke.mjs      # 24/24（自包含：不依赖外部后端，CI 也跑这条）
node e2e/e2e-federation.mjs    # 9/9（需真实 qmd/gitnexus）
node e2e/e2e-dashboard.mjs     # 4/4
node e2e/e2e-live-scenario.mjs # 8/8
node e2e/e2e-idempotent.mjs    # 9/9
node e2e/ui-interact.mjs       # 27/27（Playwright，零 JS 错误；需先 build）

# E2E 仓库选择：默认服务本仓库；想测别的仓库设 E2E_ROOT：
#   E2E_ROOT=C:/path/to/repo node e2e/e2e-federation.mjs
# （e2e-duck-hub 默认仍指本机 duck2api-hub——它有 ccc 索引，别的机器没有就如实 FAIL）
node e2e/e2e-backend-hotplug.mjs # 9/9（后端热插拔：点重探即生效）
node e2e/e2e-fed-heartbeat.mjs   # 3/3（不点按钮：30s 后心跳自动发现）
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
- [x] **进程内嵌 qmd**（max.7）：进程内 searchLex 2-5ms，spawn 仅作兜底
- [x] **gitnexus 常驻**（max.7）：会话复用，二次查询 128-200ms
- [x] **cocoindex-code 集成**（max.7）：max_search_semantic 上线（本地嵌入 $0，probe 门控）
- [ ] **编辑后自动增量索引 hooks**（项目多了再开，当前手动 ccc index）
- [ ] **上游发版跟踪**：graft 0.29+ 的 viewer 改进择机合并
- [ ] ** 发布 graft-max 到 npm**（私有 scope），脱离本机路径依赖

---

## License

遵循上游 LICENSE（nanonets/graft，MIT）。graft-Max 品牌层、`docs-selfdev/`、
`e2e/`、federation/dashboard/devlog 归本项目。
