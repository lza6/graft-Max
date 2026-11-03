# 更新日志（CHANGELOG）

所有重要改动记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循语义化：`0.28.0-max.N`（上游版本-max 补丁位）。

## [0.28.0-max.9] — 2026-11

### 修复（真实 bug，截图验收抓出来的）
- **命名卷权限**：`Dockerfile.max` 只在镜像里预建了 `.cache/qmd`，没建 `.graft-max` / `.trail`。
  Docker 用命名卷覆盖**不存在**的路径时会建成 `root:root`，容器以 `node` 运行 → 日志、会话注册表
  全写不进去，面板上所有产物显示"未创建"、活跃会话恒为 0。现在三个运行时可写目录都在镜像里
  预建并 `chown node:node`。
- **自动刷新从未启动**：前端重写时漏了 `var timer=null`，`poll()` 读 `timer` 抛 `ReferenceError`，
  首屏之后面板再也不刷新（看起来有数据，其实是死的）。
- **暂停按钮语义不符**：只停了日志 `/tail`，KPI/会话仍在轮询。现在"暂停"= 暂停全部自动刷新，
  手动"刷新"始终有效。
- **版本号显示 dev**：`readCurrentVersion` 按 `dist/cli.js` 形状找 package.json，而本模块在
  `dist/mcp/` 深一层 → 改为向上最多 3 级查找。
- **多容器会话互相覆盖**：会话注册表用 OS pid 当唯一键，而容器里每个进程都是 `pid 1` —
  两个 MCP 容器会把彼此的行覆盖掉，面板只剩一个。现在身份改为 `host+pid`（host 取
  `os.hostname()`，Docker 默认是容器短 ID），并新增 `lastSeen`（工具调用时 20s 节流刷新）：
  同 host 用 `kill(pid,0)` 探活，跨容器用 lastSeen 3 分钟窗口判活。会话表新增容器标识徽章。

### 变更 · 面板视觉与交互重做
- 设计系统：统一 token（颜色/圆角/阴影/间距），亮暗双主题，首次跟随系统偏好再持久化用户选择
- KPI 卡片：线性图标 + 主数值 + 语境说明（如"等待 MCP 宿主连接"/"图谱已就绪"），状态色随数据变化
- 面板化布局：活跃会话 / 存储产物 / 实时日志三段式，标题栏带计数与更新时间
- 空态：图标 + 标题 + **下一步该干什么**的可执行提示（不再是一行灰字）
- 存储表：类型徽章、相对占用条、路径一键复制（带 `execCommand` 兜底）、未创建弱化显示
- 日志：级别筛选（全部/只看错误/联邦工具/启动退出）、暂停/继续、回到底部、级别左侧色条
- 失联横幅：面板与 MCP 进程断开时顶部提示 + 重试按钮
- 响应式：≤1080px 三列 KPI、≤760px 两列 + 表格横向收敛，移动端 430px 实测可用
- 去掉"应用间隔"按钮：输入框回车/失焦即生效（少一次点击），E2E 断言同步更新

## [0.28.0-max.8] — 2026-11

### 新增 · Docker 部署
- **`Dockerfile.max`**：MCP stdio + 可选 Dashboard 镜像（与上游 GitHub App 的 `Dockerfile` 物理分离）
  - 多阶段构建：build 阶段只需 node（原生语法包是 devDep，运行时走 WASM，无需编译器），运行阶段只留 git/ca-certificates/curl
  - 非 root 运行（`USER node`），仓库以 volume 挂到 `/workspace`，建图产物写回挂载目录
  - 联邦后端可选：`INSTALL_QMD=1`（默认）、`INSTALL_CCC`/`INSTALL_GITNEXUS` 按需；未装由 probe 门控自动隐藏
  - **国内网络默认可用**：apt → `mirrors.aliyun.com`、npm → `registry.npmmirror.com`（容器内实测直连可达），
    无需代理、无需 `--network=host`；海外用 `--build-arg APT_MIRROR=deb.debian.org NPM_REGISTRY=...` 切回官方源
- **`docker-compose.max.yml`**：dashboard 常驻一键起（端口映射 + healthcheck 打 /stats + qmd 索引与日志卷持久化）
- **`GRAFT_MAX_LEASH=0`**：关闭 stdin-leash，常驻容器必需（容器无 MCP 宿主 stdin，否则启动即退出 / 10 分钟自杀）
- **`e2e/e2e-docker.mjs`**：真实容器 E2E（版本 / MCP 握手 / 真实工具调用 / 面板+存储 / 非 root / 常驻存活）
- **`GRAFT_MAX_UI_HOST`**：面板绑定地址（默认 127.0.0.1）。**修 bug**：dashboard 原本写死绑
  127.0.0.1，容器里 `-p 24688:24688` 映射打不进去（Docker DNAT 目标是容器 eth0 不是 loopback），
  镜像内默认 `0.0.0.0`
- **构建体积/耗时实测**：默认镜像（含 qmd）3.2GB，构建 ~60s；`INSTALL_QMD=0` 瘦身版 977MB。
  快的原因是原生 tree-sitter 语法全是 devDependencies、运行时走 WASM，`npm ci --ignore-scripts`
  跳过编译即可 —— 不需要 python3/make/g++（gcc-12/g++-12 各约 40MB，国内极易卡死）
- Dashboard 迭代：标题版本号动态读取（不再写死）、产物未创建时显示「未创建」而非 `0 B`、
  容器内用户名回退 `os.userInfo()`（原来显示 unknown）
- README 增《Docker 部署》章节；docs-selfdev/项目约束.md 增 §7 Docker 约束


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
