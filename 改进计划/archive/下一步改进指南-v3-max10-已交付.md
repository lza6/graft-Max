# graft-Max 下一步改进指南（v3.0 · 基线 0.28.0-max.9）

> 生成时间：2026-11-04。**本文档只做规划，不改代码。**
> 上一版（v2.0，T1–T10）已全部交付并归档到 `改进计划/archive/下一步改进指南-v2-max6-已交付.md`。
> 本版不是上一版的续写，而是**基于 max.9 真实代码重新审计后的新一轮规划**：所有结论都带 `file:line` 证据或实测数字，可直接作为下一轮 AI/开发者的开工契约。

## 0. 怎么用这份文档

| 你是 | 读哪几节 | 怎么用 |
|------|---------|--------|
| 拍板的人 | §1 基线 → §3 缺陷清单 → §4 任务总览 → §11 待决策 | 只看这四节就能决定做什么、先做什么 |
| 写代码的 AI/开发者 | §5 任务详情 → §9 横切约束 → §10 验证链 | 按任务卡逐条执行，验收标准即完成定义 |
| 复核的人（Critic） | §3 证据 → §5 验收方法 → §10 验证链 | 不信任何"已完成"口头结论，只认命令输出 |

**本轮已确认的三个方向性决策（用户拍板，2026-11-04）**：

1. **节奏：均衡分批串行**——每批 3–5 个任务，缺陷 → 功能 → 发布，每批收尾跑完整验证链。
2. **面板：拆成独立前端工程**——`dashboard.ts` 里内联的 669 行 HTML/CSS/JS 迁出，走 esbuild 构建，拿到类型检查与真实前端测试。
3. **隐形成本**：ICM 逐调用写入 → 改批量/会话末写一次；T6 自动增量索引 **保持默认开**；日志与面板 **保持默认开**。

---

## 1. 现状基线（写代码前必须知道的事实）

### 1.1 代码与规模

| 事实 | 数值 | 证据/命令 |
|------|------|----------|
| 版本 | `0.28.0-max.9` | `package.json:3`、`node dist/cli.js --version` |
| 源码规模 | `src/` 82,077 行 / 250 个 `.ts` | `find src -name "*.ts" \| xargs wc -l` |
| 自研核心 | 3,849 行（`src/mcp/*` + `max-prompt.ts` + `stop.ts` + `refresh.ts`） | 见 §1.3 表 |
| 测试 | 4,156 tests / 4,053 pass / **0 fail** | `npm test`（`workflow_status.md` A3） |
| E2E | 9 个 `.mjs` 脚本（联邦 9/9、性能 8/8、duck-hub 7/7、docker 9/9、UI 7/7） | `e2e/`、`e2e/E2E-REPORT.md` |
| 提交历史 | 730 提交，2026-07-03 起（含上游历史） | `git log --oneline \| wc -l` |
| 上游基点 | `nanonets/graft` v0.28.0（本地 ref `b9c2e23`） | `git rev-parse upstream/main` |

### 1.2 已验收能力（不要再当"待做"）

见 `workflow_status.md` §2：tsc 0 错 / build 绿 / test 0 fail / 联邦 E2E 真通过 / 面板真浏览器验收 / Docker 真容器 9/9 / 端点压测有数据 / 文档同步。上一版 T1–T10 + D1 全部 done（T7 npm 发布 blocked：无账号）。

### 1.3 性能基线（优化时对照，不要重复测）

| 路径 | 现值 | 出处 |
|------|------|------|
| `max_find_docs` 进程内 BM25 | 2–5ms（原 spawn 293ms） | `fed-qmd.ts`、`e2e-fed-perf.mjs` |
| `max_trace_arch` 会话复用二次调用 | 128–200ms（原 1244ms） | `federation.ts` T3 |
| 联邦工具缓存命中 | 10–15ms（60s TTL / 32 条） | `federation.ts:510-537` |
| `max_search_semantic` | ~380ms | `fed-semantic.ts` |
| 面板串行端点 | < 3ms | `evidence/max9-ui-docker.json` |
| 面板 50 并发 `/stats` | p95 108ms | 同上 |
| `/storage` | p50 4.3ms / p99 5.3ms（修复前 7329ms） | 同上 |

### 1.4 红线（违反即返工，全文通用）

`docs-selfdev/项目约束.md` 全部有效，另外本轮新增三条（详见 §9）：

1. 面板不得出现"新增功能但旧功能静默消失"——已有一次教训（工具耗时卡片）。
2. 用户全局文件（`~/.claude/CLAUDE.md`、`~/.claude.json`、`sessions.json`）一律原子写。
3. 付费 API 真实调用预算 = 0，不变。

---

## 2. 审计结论（四维度，只读）

本轮审计覆盖四个维度：**测试与 E2E 覆盖 / 安全与运维 / 架构债与上游同步 / 性能与可观测**，全部**只读**（不改代码）。结论分级如下：

| 标签 | 含义 |
|------|------|
| **已验证** | 我实际执行命令/读到代码行，能给出 `file:line` 或命令输出 |
| **静态确认** | 读代码确认逻辑路径，未运行 |
| **合理推断** | 有间接证据，需实施时验证 |
| **待验证** | 缺环境/权限/账号 |

本指南的缺陷清单里，**每一条**都标了标签。Critic 复核时只认"已验证"和"静态确认"；"合理推断"必须在本轮内升级为已验证或删除。

> 数据采集时间：2026-11-04，仓库工作区含 3 个未提交修改（见 P3-16），所有数字均可在当天工作区复现。

### 2.1 维度一 · 测试与 E2E 覆盖

| 事实 | 证据 |
|------|------|
| 自研 3,849 行**零单测**：`dashboard/devlog/federation/fed-qmd/fed-semantic/max-prompt` 在 `test/` 下**没有**对应测试文件 | `ls test \| grep -icE "dashboard\|devlog\|federation\|fed-\|max-prompt"` → 0 |
| 唯二触及自研代码的测试：`test/mcp-server.test.ts`（只断言 ALL_TOOLS 含 `max_*`）、`test/claude-auto-index-t6.test.ts`（T6，5/5） | 文件内 grep |
| 测试运行器隔离做得对：独立 `TMPDIR`（结束 `rmSync` 清理）、`commit.gpgsign=false` 注入、`GRAFT_NO_TRAIL_SWITCH=1`、文件清单枚举（绕开 Windows 无 glob） | `scripts/run-tests.mjs:33-70` |
| 但**ambient env 仍共享**：所有测试文件继承父进程环境，`GRAFT_MAX_*` 一旦在开发者 shell 里设了，测试行为就随之漂移 | `run-tests.mjs:64`（`...process.env`）；`改造日志.md` max.7 教训条 |
| E2E 断言强度不齐：`e2e-fed-perf.mjs:63-65` 明确承认"hits 或 clean no hits 都算通过"，只排除 isError → 后端没索引时也能"通过" | `e2e/e2e-fed-perf.mjs:58-66` |
| `e2e-federation.mjs:73` 断言 `qmd://`，与内嵌路径实际输出不符（见 P1-4） | `e2e/e2e-federation.mjs:73` vs `src/mcp/fed-qmd.ts:129-147` |
| UI 断言不覆盖"工具耗时卡片"，所以它消失了也没人发现 | `grep -n "耗时\|toolStats" e2e/ui-interact.mjs` → 空 |
| **E2E 断言"有响应"而非"响应正确"**：≥6 处只判 `r.result !== undefined`（后端返回软错误也照样 PASS） | `e2e-federation.mjs:79`（`max_trace_arch` 只看 result 存在）、`:92`（`graft_ask` 同上）、`e2e-duck-hub.mjs:47`、`:49`（联邦两工具同上）、`e2e-fed-perf.mjs:63`（"no hits 也算过"，源码注释自认） |
| `initialize` 返回 `serverInfo.name === 'graft'`，而工具名是 `max_*` —— 身份两套说法，E2E 还把这条写成了断言 | `e2e/e2e-federation.mjs:60`；`src/mcp/server.ts:221`（`serverInfo: { name: brand(), version }`），`brand()` 只认 `TRAIL_INVOKED_AS` |
| 面板/日志没有任何"断言强度"约束：新增断言没人审，弱断言可以永久留存 | 现状（§5 N10 要治理） |

**结论**：回归网的地基是空的——所有关键行为（日志滚动、会话注册、联邦降级、面板路由）只靠 9 个手工 E2E 脚本兜底，而 E2E 需要真实 qmd/gitnexus/ccc 与浏览器，CI 上跑不了。→ **N7 + N10 是本轮最高杠杆的投入**。

### 2.2 维度二 · 安全与运维

| # | 风险 | 级别 | 证据 |
|---|------|------|------|
| S1 | 面板零鉴权 + 容器绑 `0.0.0.0` + 宿主端口全网卡发布 | **P1 · 已验证** | 本机独立实例实测：`/stats` `/tail` `/sessions` `/storage` 全部 200 无凭据，`/tail` 直接吐日志原文；`docker-compose.max.yml:41-44`；`dashboard.ts:602-651`（详见 P1-1） |
| S2 | `~/.claude/CLAUDE.md` 非原子写 | **P1** | `max-prompt.ts:57/63/72/78/84`（详见 P1-3） |
| S2b | `~/.claude.json` 仍有 6 处整写（`claude-global.ts:78/159/187/226`、`mcp-config.ts:123/178`），与项目约束 §8 正面冲突 | **P1** | 详见 P1-6 |
| S3 | **`memories.db` / `memories.db-wal` / `memories.db-shm`（8,140 条个人记忆）未被 `.gitignore` 覆盖**，`origin` 是公开仓库 `lza6/graft-Max` | **P1** | `git status --short` 显示 `?? memories.db*`；`git check-ignore` 无输出；`.gitignore` 无 `memories` 条目 |
| S4 | 日志原文含工具入参完整 JSON（可能含 token、私有代码片段），`clip 2000` 后落盘并可经面板读取 | P2 | `server.ts:209`、`devlog.ts:138-141` |
| S5 | 面板无 `nosniff`/CSP/Referrer-Policy，`Host` 头不校验（DNS rebinding 面**已实测可绕**） | **P1** | 实测输出见 P1-1；`dashboard.ts:90-93`（只有 content-type） |
| S6 | 遥测在本 fork 下**天然不发**（仓库里 key 为空字符串，`stamp-telemetry-key.mjs` 只在发布时烤入）——正面结论；但两条纪律必须写死：发布 graft-max 时**禁止**设 `GRAFT_POSTHOG_KEY`，否则 fork 的数据会发到 `events.nanonets.com` | P2 | `scripts/stamp-telemetry-key.mjs:1-30`、`src/telemetry/key.ts:44` |
| S7 | `TELEMETRY_DOC_URL` 仍指向上游仓库 `trailhq/Trail-Code` | P3 | `src/telemetry/notice.ts:23` |
| S8 | `scripts/switch-mcp.py` 依赖外部 Python 运行时（Windows 上未装 python 即失效，`.ps1` 只是薄包装） | P3 | `scripts/switch-mcp.py`、`scripts/switch-mcp.ps1`（239 字节） |
| S9 | 工作区有 3 个未提交修改（`.claude/helpers/graft-hooks.cjs`、`graft-statusline.cjs`、`skills/graft/SKILL.md`）与仓库根重复的 `参考的结果计划指南.md` | P3 | `git status` |

**结论**：S1/S2/S3 三条都属于"一次误操作 = 不可逆损失"（泄露开发上下文 / 截断个人全局规则 / 推送个人记忆库），必须在批次 A 清零。S1 与 S3 是纯配置/一行 gitignore 级的修复，投入产出比最高。

### 2.3 维度三 · 架构债与上游同步

**量化（`git diff --numstat upstream/main...HEAD`）**：69 个文件、**+5,776 / −1,894**。其中 **21 个是上游已有文件被修改（有删除行 = 每次上游更新都要手工 merge）**，其余 48 个是纯新增（低冲突）。

| 上游热路径文件 | 增/删 | 为什么会撞车 |
|---------------|-------|-------------|
| `src/mcp/server.ts` | +151 / −9 | 我们在 `tools/list`、`tools/call` 路由里插了联邦分支与中文日志 |
| `src/hosts/instructions.ts` | +24 / −34 | 中文 instructions 重写 |
| `src/mcp/instructions.ts` | +14 / −12 | 同上（Max 版 <1000 字符） |
| `src/graph/refresh.ts` | +20 / −1 | 自动建图（放开 `isTrailMapDir` 门槛） |
| `.claude/helpers/graft-hooks.cjs` | +108 / −8 | hook 层 Max 化 |
| `.claude/helpers/graft-statusline.cjs` | +12 / −8 | 状态栏 |
| `src/claude/hooks.ts` / `sync-run.ts` | +2/−2、+4/−1 | T6 自动增量索引接线 |
| `package.json` | +10 / −8 | name/bin/files/version |
| `README.md` / `CHANGELOG.md` | −728/+244、−1029/+147 | 品牌化重写 |
| 9 个上游测试文件 | 各 ±1~14 | 名称/断言随品牌调整 |

**结论**：同步成本不在"改了多少行"，而在**这 10 个文件**（server.ts 最痛）。→ **N18（同步演练）** 的价值是把"下次上游更新要付多少工时"变成已知数，并明确"新增能力优先放在新文件（`fed-*.ts` / `panel/` 模式）"这条架构纪律。

**死代码/僵尸路径**（本轮顺手清）：

| 项 | 证据 |
|---|------|
| `server.ts:138-139` if/else 两支同体 | 见 P3-1 |
| `ensurePromptBlock` 死导入 | 见 P3-2 |
| `devlog.ts:115-116` I18N 死规则 | 见 P3-3 |
| `/stats.toolStats` 计算但无人消费 | 见 P2-1 |
| 上游 GitHub App / 云同步路径（`src/app/`、`src/cloud/`、`src/telemetry/`）在 Max 形态下基本不执行，但仍是打包体积与审计面 | `dist/` 顶层含 `app/ cloud/ telemetry/`；`dist/vendor` 占 13MB |

### 2.4 维度四 · 性能与可观测性

| # | 项 | 现状/证据 | 影响 | 优化方向 |
|---|----|----------|------|---------|
| F1 | ICM 逐调用 spawn | `icm.exe remember` 单次实测 **3.26s**（`time icm.exe remember`），每次工具调用都跑 | 每次调用后多一个 3 秒进程 + 一次 embedding + 一次 SQLite 写；会话长了是 CPU/IO 持续背景噪音 | N3 批量化 |
| F2 | gitnexus 会话 stdout 无界累积 + 监听器不摘 | `federation.ts:279-306` | O(n²) 重解析 + 内存单调上涨 | N6 |
| F3 | 首查建图阻塞 90s | `refresh.ts:66` `FIRST_BUILD_WAIT_MS` | agent 体感"卡死"；面板看不到进度（`building.json` 由等待者删，见 P3-9） | N13 |
| F4 | `/stats` 每次解析 800 行日志 | `dashboard.ts:67-88`（2s 缓存） | 已有缓存，压测 p95 108ms；**但结果无人消费**（P2-1） | N9 让它产出可见价值 |
| F5 | `sessions.json` 每次调用同步读改写 | `devlog.ts:275-286`，实测 **1.08ms/轮**（290 字节） | 当前可接受；随会话数与文件增长线性变差 | 与 N4 一起改（节流），**不作为独立性能任务** |
| F6 | 可观测缺口 | 无 p50/p95、无缓存命中率、无后端探针健康度、无 RSS/错误率趋势 | 出问题时只能看日志肉眼看 | N9 |
| F7 | 面板轮询拓扑 | 2s 主轮询（tail/sessions/stats）+ 30s `/storage` + 会话 `lastSeen` 20s 节流 | 已较克制；多标签页会翻倍请求 | N10 用浏览器测试固化"请求频率"断言 |

**结论**：性能主线（T2/T3/T4）上一轮已经打完（60×/10× 收益），本轮的性能工作不是"更快"，而是**把已有快路径的副作用收干净（F1/F2）、把阻塞变成进度可见（F3）、把指标补齐（F6）**。不要再追边际毫秒。

---

## 3. 缺陷清单（P 分级，本轮必须清零 P0/P1）

> 这些是**我自己逐行读自研代码**得到的第一手发现，与上面四个维度的审计互补（那四份偏"系统面"，这份偏"自研代码逐行"）。

### P1-1 · 面板在容器形态下无鉴权暴露全量开发者日志（安全）

- **证据**：`docker-compose.max.yml:41-44` 设 `GRAFT_MAX_UI_HOST: "0.0.0.0"` + `ports: "24688:24688"`（Docker 默认绑定所有宿主网卡）；`src/mcp/dashboard.ts:602-651` 的 5 个端点**没有任何鉴权/Host 校验/令牌**，`/tail` 直接返回日志原文，而日志原文含每次工具调用的完整入参 JSON（`src/mcp/server.ts:209` `dlogBlock(... JSON.stringify(params.arguments))`）。
- **故障场景**：同网段任意机器 `curl http://<宿主IP>:24688/tail?n=2000` 即可读到这台机器的仓库绝对路径、查询语句、代码片段（工具返回 clip 2000 字符）。若宿主在咖啡厅/办公网，等于把开发上下文公开。
- **实测（2026-11-04，本机 24689 端口起的独立面板实例）**：

  ```
  /stats   => 200 | nosniff=null csp=null | body: {"logPath":"C:\\Users\\...\\.graft-max\\mcp.log",...
  /tail?n=3 => 200 | body: [2026-11-04 07:46:52.640] <-- 收到请求 tools/list  id=1 ...
  /sessions => 200 | body: [{"pid":30508,"cwd":"C:/Users/...","hostPid":...}]
  /storage  => 200 | body: {"root":"D:/自研工具/graft-Max","entries":[...]}
  /stats with Host: evil.example.com => 200        ← Host 头不校验（DNS rebinding 面成立）
  ```
- **标签**：**已验证**（端点无鉴权、日志原文可读、Host 不校验、缺安全响应头，均为命令输出）。
- **修复方向**：① compose 端口改 `127.0.0.1:24688:24688`；② 面板加一次性令牌（启动时生成，打印在 stderr 与 KPI 卡），`/tail`/`/storage`/`/sessions` 校验；③ 校验 `Host` 头只允许 `127.0.0.1`/`localhost`（防 DNS rebinding，当前实测 200 必须变 403）；④ 加 `X-Content-Type-Options: nosniff` 与最小 CSP。

### P1-2 · 每次工具调用 spawn 一个 `icm.exe` 进程，且记忆库被时间线污染（资源 + 数据）

- **证据**：`src/mcp/server.ts:30-38`（`recordIcmTimeline`）在**每一次** `tools/call` 完成后 `spawn('icm.exe', ['remember', content], {stdio:'ignore'})`，无超时、无节流、无上限；调用点 `server.ts:301`（联邦）与 `server.ts:330`（graft 工具）。
- **实测**：`time icm.exe remember ...` = **3.26 秒/次**；本机 ICM 库里已积累 **8,140 条**记忆（`icm.exe list --all | grep -c '^--- '`），其中工具时间线被 ICM 合并成超长摘要（单条 summary 里塞进 20+ 次调用，含 E2E 爆发时段的连刷记录）。这直接污染 `icm recall` 的信噪比。
- **标签**：已验证（进程 spawn 为代码事实；条数与污染样本为命令输出）。
- **修复方向**：进程内缓冲成 JSONL（`~/.graft-max/tool-timeline.jsonl`），按「每 N 次或每 60s 或会话退出」批量写一次；给 icm 子进程加 5s 超时与并发上限 1；E2E 时默认关闭（`GRAFT_TEST=1` 时禁用）。

### P1-3 · `~/.claude/CLAUDE.md`（用户全局提示词）非原子写，有截断风险

- **证据**：`src/hosts/max-prompt.ts:57`、`63`、`72`、`78`、`84` 五处 `writeFileSync(path, ...)` 直接覆盖用户全局文件，无 tmp+rename、无备份。同一个仓库在 `devlog.ts:214-224` 已经因为"async writeFile 交错把文件截成 0 字节（实测发生过）"而改成同步原子写，这里却退回了不安全写法。
- **故障场景**：注入过程中进程被杀/磁盘满/断电 → 用户全局 `CLAUDE.md`（可能有几千行个人规则）被截断。这与项目自己的 `.claude.json 246KB → 852B` 事故同源。
- **标签**：静态确认。
- **修复方向**：抽一个 `atomicWrite(path, content)` 工具函数（tmp + rename + 失败回滚），三处用户全局文件写入口（`max-prompt.ts`、`mcp-config.ts`、`devlog.ts`）统一走它；写前保留 `.bak` 一份（最多 3 份）。

### P1-4 · 联邦结果契约在两条路径下不一致（内嵌 vs spawn），E2E 断言与实现已脱钩

- **证据**：`src/mcp/fed-qmd.ts:129-147` 的 `formatResults()` 输出 `${filepath} #${docid}`（**无 `qmd://` 前缀、无 `:line`**），而 `src/mcp/fed-qmd.ts:7-8` 的注释声称"Output format stays byte-compatible with the CLI (qmd://collection/file headers)，which e2e/e2e-federation.mjs asserts on"；`e2e/e2e-federation.mjs:73` 确实断言 `qText.includes('qmd://')`。内嵌路径是默认路径（`federation.ts:185` 先走内嵌），所以这条断言要么已失效、要么该 E2E 跑在了内嵌不可用的环境上。
- **影响**：同一个工具在用户机器上返回两种格式，agent 的解析习惯被打断；E2E 报告里的"9/9 PASS"不能证明内嵌路径正确。
- **标签**：静态确认（格式差异读代码确认；断言是否真失败待跑验证）。
- **修复方向**：让 `formatResults` 输出与 CLI 逐字节一致（`qmd://<collection>/<displayPath>:<line> #<docid>`），并补一条内嵌路径的单测（假 store 注入）；E2E 增加"内嵌路径命中"用例。

### P1-5 · 跨容器/多进程会话计数与退出标记按裸 pid 匹配，会串行改错行

- **证据**：`src/mcp/devlog.ts:275-286`（`bumpRequests`）与 `:289-300`（`endSession`）都用 `rows.find(r => r.pid === process.pid)` 定位自己那一行，**没有 `host` 比对**；而同一文件 `:186`（`touchSession`）与 `:309-314`（`liveSessions`）已经改成 `host + pid` 身份（max.9 修过一轮）。
- **故障场景**：两个 graft-Max 容器里都是 `pid 1`，容器 A 的工具调用会给容器 B 的行 `requests +1`；容器 A 退出会把容器 B 标记成 `endedAt` → 面板上活跃会话凭空少一个、请求数错位。这正是 max.9 刚修过的 bug 的**未修封口**。
- **标签**：静态确认。
- **修复方向**：抽 `myRow(rows)` 统一用 `host+pid` 匹配；补 `devlog` 的多 host 单测（构造两行同 pid 不同 host 的 sessions.json）。

### P1-6 · `~/.claude.json` 仍有 6 处整写（无 tmp+rename），而项目约束自己写着"绝不整写"

- **证据**：`src/hosts/claude-global.ts:78`、`:159`、`:187`、`:226` 与 `src/hosts/mcp-config.ts:123`、`:178` 全部是 `writeFileSync(path, JSON.stringify(...))` —— **无临时文件、无 rename、无备份**。而 `docs-selfdev/项目约束.md` §8 明写："⚠️ 绝不整写 .claude.json（含大小写重复键 + 主进程随时写它，整写曾把 246KB 截成 852B）——必须字节级精准替换 + swap 原子写 + 写前 JSON 验证"，这条约束目前只被 `switch-mcp.py` 遵守。
- **故障场景**：`graft init` / 全局注册（`GRAFT_MAX_MCP=1` 时每次 boot 的 upsert 路径）触发整写，若此刻 Claude Code 主进程也在写该文件、或进程被杀、或磁盘满 → 用户的全部 MCP 服务器配置损坏（历史上真实发生过一次，靠 Claude Code 自带 backups 才救回来）。
- **标签**：静态确认。
- **修复方向**：`claude-global.ts`/`mcp-config.ts` 的写入统一走 N2 的 `atomicWriteSync` + 写前 `JSON.parse` 校验 + `.bak`；并补一条"大小写重复键不丢"的测试（构造含 `mcpServers` 与 `MCPServers` 的文件，写后两者都在）。

### P2-1 · 面板的"工具耗时卡片"在内嵌重写中静默丢失，服务端仍在付成本

- **证据**：`src/mcp/dashboard.ts:637` `/stats` 仍返回 `toolStats`（每 2s 解析最近 800 行日志，`dashboard.ts:64-88`）；但 `page()` 的内联前端（`dashboard.ts:216-591`）**没有任何一处渲染 `toolStats`**（`grep -c toolStats` = 5，全在服务端）。`CHANGELOG.md` max.7 明确记着"面板显示每工具调用次数/平均耗时/错误数"，`docs-selfdev/改造日志.md` 同；max.9 视觉重做把它弄丢了，`e2e/ui-interact.mjs` 也没断言它（`grep 耗时` 无命中）。
- **影响**：主推的"性能收益可视化"证据消失；同时每次 `/stats` 仍花一次 800 行日志解析。
- **标签**：已验证。
- **修复方向**：二选一，不许悬空——要么在 P1（面板拆工程）里把卡片补回来并加断言（`/stats.toolStats` 非空 + DOM 出现 ≥1 行），要么删掉 `/stats.toolStats` 与解析逻辑。推荐前者（它本身是这个项目的卖点）。

### P2-2 · gitnexus 常驻会话的 stdout 监听器永不移除，缓冲无界累积

- **证据**：`src/mcp/federation.ts:279-306`，握手成功后 `settled = true` 只阻止 resolve，**数据监听器继续存在**并对整个累积字符串 `out` 反复 `split('\n')` + 逐行 `JSON.parse`；`out` 从不截断。会话最长存活 10 分钟（idle 回收）+ 每次查询都会让 `out` 再长一截。
- **影响**：单次查询后每个数据块都要重解析整个历史缓冲（O(n²)），10 分钟会话内存单调上涨；理论上还会在极端情况拖慢后续 `gnxSessionCall`。
- **标签**：静态确认。
- **修复方向**：握手 settle 后 `child.stdout.off('data', onData)`（保留引用），会话期只保留 `gnxSessionCall` 的临时监听器；补一条"握手后监听器数量 = 0"的单测（可用 `fake-trail-server.ts` 模式造假 gitnexus）。

### P2-3 · 后端可用性探针（probe）永不过期，中途安装后端要重启才能用

- **证据**：`src/mcp/federation.ts:115-125` `probeCache` 是 `Map<Backend, boolean>`，命中即返回、**永不失效**；注释明确"a backend doesn't appear mid-session"。（`fed-qmd.ts:60-70` 的 SDK 路径已经做了 60s 重试，两个策略不一致。）
- **影响**：用户按 README 安装 qmd/gitnexus/ccc 后，当前会话永远看不到新工具，只能重启 MCP server（Claude Code 里等于重开会话），体验断点。
- **标签**：静态确认。
- **修复方向**：probe 结果加 TTL（建议 5 分钟）+ 失败态 30s；`tools/list` 有变化时发 `notifications/tools/list_changed`（`server.ts:180-184` 的 `KeptListing` 已具备这个通道）。

### P2-4 · 子进程 stdout 无上限累积

- **证据**：`src/mcp/federation.ts:84-89`（`runCli`）与 `:464-480`（one-shot gitnexus）对 `out` 无上限 append；`fed-semantic.ts:81` 还对 `r.out` 做 `clip(..., 120)` 仅用于日志，真正的 `out` 全量参与 JSON.parse。
- **影响**：一个失控后端（或 `ccc --json` 输出巨大结果集）可让 MCP server 进程吃满内存——而 MCP server 是 agent 会话的生命线。
- **标签**：静态确认。
- **修复方向**：`runCli` 加 `MAX_OUT = 8MB`，超限即 kill 并返回软错误；`limit` 已在 schema 侧限幅（ccc ≤ 20），保持。

### P2-5 · 个人记忆库 `memories.db*` 未纳入 `.gitignore`，一次 `git add -A` 即可推送到公开仓库（隐私）

- **证据**：`git status --short` 列出 `?? memories.db`、`?? memories.db-shm`、`?? memories.db-wal`、`?? 改进计划/archive/memories.db.backup-20261103-021733`；`git check-ignore -v memories.db` **无输出**；`.gitignore` 里只有 `dist/`、`graft/`、`/.graft/` 等，无 `memories*`。`origin` = `https://github.com/lza6/graft-Max.git`（公开仓库）。
- **故障场景**：任何一次 `git add -A && git push` 都会把 **8,140 条个人记忆**（含各项目上下文、路径、对话摘要）推到公开仓库，且 `git rm` 之后仍留在历史里。
- **标签**：已验证。
- **修复方向**：`.gitignore` 增 `memories.db*`、`.trail/`、`.mcp.json`（本机配置）、`*.db.backup-*`；把已存在的备份移出仓库目录（`~/.graft-max/backups/`）；加一条 pre-commit 检查（`.claude/helpers/` 已有 Node hook 基础设施）拒绝提交 `*.db`。

### P3 级（清理项，顺手做）

| # | 问题 | 证据 | 修法 |
|---|------|------|------|
| P3-1 | `server.ts` 里 `if (isMax()) X='1'; else X='1'` —— 两支同体 | `server.ts:138-139` | 直接 `process.env[MAX_BRAND_ENV] = '1'` + 注释说明"Max 二进制恒为 Max 身份" |
| P3-2 | `ensurePromptBlock` 被 import 但从未调用，"用户手删补回"功能实际未接线 | `server.ts:24`（唯一命中，无调用点） | 在 `tools/list` 或 `initialize` 入口处按 60s 节流调用一次，或删除该函数 |
| P3-3 | 日志 I18N 规则已死：`<-- tools/call (federated)` 早改成了中文输出 | `devlog.ts:115-116` vs `server.ts:300` | 删掉不匹配的规则；加单测喂真实日志行断言替换生效 |
| P3-4 | `cacheKey` 用 `JSON.stringify(args)`，键序不同即不命中 | `federation.ts:514-516` | 键排序后序列化（`Object.keys(a).sort()`），或按工具白名单字段拼接 |
| P3-5 | `liveSessions()`（GET 读路径）里有写盘副作用 | `devlog.ts:316-318` | 读接口只返回过滤结果，清理交给定时器/写路径 |
| P3-6 | 联邦工具缓存命中/未命中不可观测（无 metrics） | `federation.ts:539-566` | 计数器 + 暴露到 `/stats` |
| P3-7 | `getGnxSession(cwd)` 的会话是全局单例，参数 `cwd` 只影响首次 spawn | `federation.ts:320-336` | 会话按 `cwd` 分桶（Map<root, session>）或断言单 root |
| P3-8 | 面板会话表 `s.host` 未走 `esc()`，与其他字段不一致 | `dashboard.ts:491` | 统一 `esc()` |
| P3-9 | `building.json` 由"等待建图的那个查询"删除，而不是建图进程删除 | `graph/refresh.ts:159`（写）vs `:167-168`（等超时也删） | 改为由 build 子进程在完成时删除；面板改为读锁状态 |
| P3-10 | README 与实现漂移：写"8 个 max_* 工具"（实为 9）、工具表无 `max_search_semantic`、环境变量表无 `GRAFT_MAX_ICM` | `README.md:121`、`:277-292` | 见 N-文档任务 |
| P3-11 | `e2e/E2E-REPORT.md` 表头仍是 `0.28.0-max.1` 时代的输出 | `e2e/E2E-REPORT.md:9` | 重跑后覆盖 |
| P3-12 | 自研 3,849 行里 dashboard/devlog/federation/fed-* 全部**零单测**（`test/` 下无同名测试文件） | `ls test \| grep -iE 'dashboard\|devlog\|federation\|fed-'` 空 | 见 §5 测试任务 |
| P3-13 | `sessions.json` 每次工具调用同步读改写 —— 实测 **1.08ms/轮**（290 字节），**不是性能瓶颈**，只需修正确性（P1-5）与随会话数增长的趋势 | `devlog.ts:275-286` + 本地 benchmark | 与 N4 合并，节流落盘即可，不单列性能任务 |
| P3-14 | `TELEMETRY_DOC_URL` 指向上游 `trailhq/Trail-Code` | `src/telemetry/notice.ts:23` | 改指本仓库或删提示 |
| P3-15 | `scripts/switch-mcp.py` 依赖外部 Python，Windows 未装即失效 | `switch-mcp.ps1` 仅 239 字节包装 | 用 Node 重写（`scripts/switch-mcp.mjs`），消除运行时依赖 |
| P3-16 | 工作区 3 个未提交修改 + 根目录重复的 `参考的结果计划指南.md` | `git status` | 收批次时一并提交/清理 |
| P3-17 | `dist/` 里含 `app/ cloud/ telemetry/` 等 Max 形态基本不走的路径，`dist/vendor` 13MB | `du -sh dist/*` | 仅记录，不做裁剪（上游同步会打架） |
| P3-18 | **E2E 弱断言**：≥6 处只判 `result !== undefined`，软错误也算通过（后端全挂仍能刷出高分） | `e2e-federation.mjs:79/92`、`e2e-duck-hub.mjs:47/49`、`e2e-fed-perf.mjs:63` | 统一改为"非 isError + 内容形状断言（正则/字段）"；N10 里补一条断言强度审查清单 |
| P3-19 | `initialize.serverInfo.name` 仍是 `graft`（工具名却是 `max_*`），且 E2E 把它固化成断言 | `server.ts:221`、`e2e-federation.mjs:60` | 决定性二选一：要么 `name: isMax() ? 'graft-Max' : brand()` 并同步 E2E 断言，要么明确"serverInfo 刻意保持上游名"并写进项目约束 |

---

## 4. 任务总览（N 系列）

批次划分对应"均衡分批串行"：每批一个可交付里程碑，批内任务可并行，批间串行。

### 批次 A · 缺陷清算与回归网（P0/P1 清零）

| ID | 任务 | 优先级 | 风险 | 预估 | 依赖 |
|----|------|--------|------|------|------|
| **N0** | **隐私加固：`.gitignore` 覆盖 `memories.db*` / `.trail/` / `.mcp.json`，并加 pre-commit 拒收 `*.db`** | **P1** | **低** | **30min** | — |
| N1 | 面板安全加固：compose 回环绑定 + Host 校验 + 令牌 + 安全响应头 | P1 | 低 | 3h | — |
| N2 | `atomicWrite` 统一用户全局文件写入（含备份与回滚） | P1 | 中 | 4h | — |
| N3 | ICM 时间线批量化 + 超时 + E2E 静默 | P1 | 低 | 3h | — |
| N4 | `devlog` 身份修复（`host+pid`）+ 计数节流落盘 | P1 | 低 | 3h | — |
| N5 | `fed-qmd` 输出契约对齐 CLI + 内嵌路径单测 | P1 | 中 | 3h | — |
| N6 | 联邦健壮性三补：握手后摘监听器、probe TTL、stdout 上限 | P2 | 中 | 4h | — |
| N7 | 自研模块单测补齐（devlog / federation / fed-qmd / max-prompt / dashboard 路由） | P1 | 低 | 6h | N4–N6 |

### 批次 B · 面板工程化（用户已定方向）

| ID | 任务 | 优先级 | 风险 | 预估 | 依赖 |
|----|------|--------|------|------|------|
| N8 | 面板前端拆工程：新建 `panel/` + esbuild 产物进 `dist/panel/` | P1 | 中 | 8h | N7 |
| N9 | 补回"工具耗时"卡片 + 性能分位（p50/p95）+ 联邦后端健康度 | P2 | 低 | 4h | N8 |
| N10 | 面板契约测试（Playwright：轮询频率、暂停语义、空态、429/断连横幅） | P2 | 低 | 3h | N8 |

### 批次 C · 能力扩展（按优先级取用）

| ID | 任务 | 优先级 | 风险 | 预估 | 依赖 |
|----|------|--------|------|------|------|
| N11 | 多仓库支持：单进程多 root 或 compose 多 service 标准化 | P2 | 高 | 8h | N8 |
| N12 | 联邦后端"自助安装"：面板一键探测 + 安装指引 + 装完自动出现工具 | P2 | 中 | 4h | N6 |
| N13 | 冷启动体验：首查建图 90s 阻塞改为流式进度提示 | P2 | 中 | 4h | — |
| N14 | 索引新鲜度可视化（图谱 vs 工作区 diff 摘要） | P3 | 低 | 3h | N9 |

### 批次 D · 发布与运维工程化

| ID | 任务 | 优先级 | 风险 | 预估 | 依赖 |
|----|------|--------|------|------|------|
| N15 | 打包完整性审计：`files` 清单 / viewer 资源 / `.scm` / wasm 在全局安装下可用 | P1 | 中 | 3h | — |
| N16 | CI 门禁：tsc + build + test + 一个真 E2E（GitHub Actions，Windows runner） | P2 | 中 | 5h | N15 |
| N17 | npm 发布（需账号，当前 blocked）/ Docker Hub 推送 / GitHub Release 产物 | P2 | 低 | 2h | 用户提供账号 |
| N18 | 上游同步演练：`upstream/main` 合并一次，记录冲突热点与解决 SOP | P2 | 中 | 4h | — |

### 批次 E · 文档与知识沉淀

| ID | 任务 | 优先级 | 风险 | 预估 | 依赖 |
|----|------|--------|------|------|------|
| N19 | 文档与实现对齐：README（9 工具/环境变量表/新面板）、CHANGELOG、E2E-REPORT 重跑覆盖 | P2 | 低 | 3h | 各批收尾时做 |
| N20 | `docs-selfdev/` 补三篇：面板架构、联邦契约、失败模式手册（软错误矩阵） | P3 | 低 | 3h | — |

**执行顺序**：A（**N0**→N1→N2→N3→N4→N5→N6→N7）→ B（N8→N9→N10）→ C（N13→N12→N11→N14）→ D（N15→N16→N18→N17）→ E（N19/N20 贯穿）。
每批收尾必须：完整验证链（§10）+ CHANGELOG 追加 + `workflow_status.md` 更新。

**为什么是这个顺序**：N0 只要半小时就能掐掉一个不可逆风险；N1–N5 是 P1 缺陷（都改了会影响联邦/面板的既有行为），必须在补测试网之前清干净，否则测试会把错误行为固化；N7 是回归网地基，没有它 B 批的"拆面板工程"等于裸奔；C 批全部是"扩张"，放最后是因为它依赖 A/B 的稳定面。

---

## 5. 任务详情（每张卡 = 一个可交付）

格式：目标 / 根因 / 改动范围 / 不做什么 / 验收 / 回滚。

**开工前置检查（每个任务都做，2 分钟）**：

1. `git status` 干净（或已知当前改动归属，见 P3-16）；
2. 读一遍 `docs-selfdev/项目约束.md` 里与本任务相关的条目；
3. 确认本任务要改的文件**没有**别的并行任务在改（三个冲突热点：`federation.ts` / `dashboard.ts` / `server.ts`）；
4. 记下改动前的基线数字（`/stats` 的 p95、E2E 通过数、`npm test` 计数），否则改完无法证明"没变差"；
5. 任务卡里的"验收"逐条抄进本次的工作清单，完成一条勾一条——**没有命令输出的勾不算数**。

### N0 · 隐私加固（30 分钟，先做）

- **目标**：杜绝"一次 `git add -A` 把 8,140 条个人记忆推到公开仓库"（P2-5）。
- **改动范围**：`.gitignore`（增 `memories.db*`、`.trail/`、`.mcp.json`、`*.db.backup-*`）；把 `改进计划/archive/memories.db.backup-*` 移到 `~/.graft-max/backups/`；`.claude/helpers/` 加一个 pre-commit 检查（Node，匹配 `*.db`/`*.db-wal`/`*.db-shm` 直接拒绝）。
- **不做什么**：不改 ICM 自身的库路径；不清理 `memories.db` 内容（N3 处理污染源）。
- **验收**：① `git status --short` 不再列出任何 `memories.db*`；② `git add memories.db` → 被 hook 拒绝并给出提示；③ `git check-ignore -v memories.db` 有输出。
- **回滚**：`.gitignore` 与 hook 单文件。

### N1 · 面板安全 hardening

- **目标**：把"localhost 便利工具"和"0.0.0.0 容器服务"两种形态的安全边界显式化，杜绝 P1-1。
- **改动范围**：`docker-compose.max.yml:41-44`（端口改 `127.0.0.1:24688:24688`）；`src/mcp/dashboard.ts`（Host 校验 + 令牌 + `X-Content-Type-Options`/`Referrer-Policy`）；`Dockerfile.max`（不改绑定，改说明）；`README.md`（安全章节）。
- **不做什么**：不引入用户系统/多账号；不做 HTTPS/TLS；不改 MCP 侧行为。
- **验收**（全部要真实执行）：
  1. `curl -H "Host: evil.com" http://127.0.0.1:24688/stats` → 403；
  2. 无令牌 `curl http://127.0.0.1:24688/tail` → 401，带令牌 → 200；
  3. 容器：`docker port graft-max-dashboard` 显示 `127.0.0.1:24688`；
  4. `node e2e/ui-interact.mjs` 7/7（脚本内读取令牌）。
- **回滚**：单文件改动，`git revert` 即可；令牌机制用环境变量 `GRAFT_MAX_UI_TOKEN` 可关（默认开）。

### N2 · 原子写工具 + 用户全局文件保护

- **目标**：任何写用户全局文件的路径都不可截断（P1-3 + P1-6）。
- **改动范围**：新增 `src/util/atomic-write.ts`（`atomicWriteSync`/`atomicWrite` + `.bak` 轮转 + 写前 JSON 校验选项）；接入 `src/hosts/max-prompt.ts`（5 处）、`src/hosts/claude-global.ts`（4 处）、`src/hosts/mcp-config.ts`（2 处）、`src/mcp/devlog.ts:214-224`（复用，不重复实现）。
- **不做什么**：不改 `switch-mcp.py` 的字节级替换逻辑（它已另有保障）；不改变写入语义（内容仍由上游逻辑决定），只改"怎么落盘"。
- **验收**：单测——① 写入中断（mock `writeFileSync` 抛错）后原文件内容不变；② 正常写入后 `.bak` 存在且为上一版；③ `max-prompt` 三轮 upsert 后文件行数不变（幂等）；④ 构造含 `mcpServers` 与 `MCPServers`（大小写重复键）的 `~/.claude.json` 副本，写后两个键都在；⑤ 真实本机执行一次 `upsertGlobalPrompt()`，`~/.claude/CLAUDE.md` 的 icm 区块仍完整。
- **回滚**：函数级替换，逐点 revert。

### N3 · ICM 时间线批量化

- **目标**：把"每次调用一个进程 + 一条记忆"变成"会话末/N 次调用一次批量写"（P1-2）。
- **改动范围**：`src/mcp/server.ts:30-38`（改缓冲实现）+ 新增 `src/mcp/icm-timeline.ts`（缓冲、flush、超时、并发 1）；`server.ts:352-368`（退出路径 flush）；E2E 脚本统一 `GRAFT_TEST=1` 下禁用。
- **设计要点**：缓冲 32 行或 60s 触发；单次 flush 一个进程（`icm.exe store -t tool-timeline -c "<批量内容>"`）；子进程 5s 超时、最多 1 个在飞；失败静默丢批次（不重试、不阻塞）。
- **验收**：① 连续 10 次工具调用后 `~/.graft-max/tool-timeline.jsonl` 有 10 行，`icm` 只被调用 1 次（用 `GRAFT_MAX_ICM=2` 测试钩子记录调用次数）；② 会话退出时未满批也 flush；③ `icm.exe list --all | grep -c 'isError='` 在跑一天后不再单调暴涨（对比基线 5 条大摘要）。
- **回滚**：`GRAFT_MAX_ICM=0` 一键关闭（已存在）。

### N4 · devlog 身份与节流

- **目标**：多容器/多会话下计数与退出标记不再串行（P1-5），并去掉每次调用的同步写热点（P2-5）。
- **改动范围**：`src/mcp/devlog.ts`（`myRow()` 统一 host+pid；`bumpRequests` 内存计数 + 2s 节流；`endSession` 用 `myRow`；`liveSessions` 去掉写副作用）。
- **验收**：① 新增单测：构造 `sessions.json` 含两行 `pid=1` 不同 `host`，模拟 A 进程 bump → 只有 A 行 +1；② 模拟 A `endSession()` → 只有 A 行 `endedAt`；③ 压测：10 次工具调用只落盘 ≤ 6 次（节流生效，用 fs spy）；④ 面板 `e2e/ui-interact.mjs` 请求数仍随调用增长。
- **回滚**：`devlog.ts` 单文件。

### N5 · 联邦输出契约对齐

- **目标**：内嵌与 spawn 两条路径对同一查询返回**同一格式**（P1-4）。
- **改动范围**：`src/mcp/fed-qmd.ts:129-147`（`formatResults` 输出 `qmd://<collection>/<displayPath>:<line> #<docid>`）；`test/fed-qmd.test.ts`（新，假 store 注入）；`e2e/e2e-fed-perf.mjs`（加"内嵌路径命中"断言 `qmd://`）。
- **不做什么**：不改 CLI 侧 qmd 的输出；不改工具 schema。
- **验收**：① 单测：给定 2 条假结果，输出与 CLI 样例逐字符相等（CLI 样例从 `qmd search` 实跑抓一份固定在 fixture 里）；② `node e2e/e2e-federation.mjs` 9/9 且断言走的是内嵌路径（日志里出现 `in-process store ready`）。
- **回滚**：单文件。

### N6 · 联邦健壮性三补

- **目标**：`federation.ts` 三处硬化（P2-2/P2-3/P2-4）。
- **改动范围**：`federation.ts:279-306`（settle 后 `off`）、`:115-125`（probe TTL 5min / 失败 30s + `list_changed`）、`:84-89`（`MAX_OUT=8MB` 超限 kill）。
- **验收**：① 假 gitnexus server（沿用 `test/fake-trail-server.ts` 模式）握手后断言监听器已移除（`child.stdout.listenerCount('data') === 0`）；② 单测：probe 失败 → 30s 后可重试（假时钟）；③ 单测：喂 10MB stdout → 返回软错误且子进程被杀。
- **回滚**：单文件。

### N7 · 自研模块单测补齐（回归网的地基）

- **目标**：给 3,849 行自研代码补上最小但真实的测试面（当前为零）。
- **必测清单**（按 ROI 排序）：
  1. `test/max-prompt.test.ts`：created/updated/unchanged 三态 + 手删补回 + 幂等 + 原子性。
  2. `test/devlog-sessions.test.ts`：多 host 身份、僵尸清理、3 分钟远端判活、坏 JSON 恢复。
  3. `test/fed-cache.test.ts`：TTL、LRU 淘汰、错误不缓存、键序无关（N 系列 P3-4 一起修）。
  4. `test/fed-qmd.test.ts`：格式契约、SDK 缺失降级、索引缺失降级。
  5. `test/dashboard-routes.test.ts`：起真实 server（随机端口）打 `/tail` `/sessions` `/stats` `/storage` `/404`，断言 code+content-type+边界（`n` 超界裁剪、坏参数不崩）。
  6. `test/dashboard-host-guard.test.ts`：N1 的 403/401 行为。
- **验收**：`npm test` 新增文件全绿且总 fail = 0；`npx tsc --noEmit` 0 错。
- **回滚**：只增测试，不影响运行时代码。

### N8 · 面板前端拆工程

- **目标**：`dashboard.ts` 里 400+ 行内联 HTML/CSS/JS 迁到真实前端工程，拿到类型检查、构建期语法检查、可测 DOM（用户已拍板）。
- **落地方案**（推荐）：新建 `panel/`（`index.html` + `main.ts` + `style.css`），复用 `scripts/build-viewer.mjs` 的 esbuild 模式 → 产物 `dist/panel/`；`dashboard.ts` 只留服务端：路由 + `readFileSync(dist/panel/index.html)`（启动时读一次缓存）+ API。**保留单文件部署体验**（仍然零运行时依赖）。
- **不做什么**：不引 React/Vue（保持零依赖、包体积不变）；不合并上游 `viewer/`（那是上游代码，合并会抬升同步冲突）。
- **验收**：① `npm run build` 产出 `dist/panel/{index.html,app.js}`；② `node dist/cli.js mcp` 起面板，`/` 返回新页面；③ `e2e/ui-interact.mjs` 7/7 + 语法检查（`node --check dist/panel/app.js`）；④ `docker build -f Dockerfile.max` 后容器内面板可用（`e2e/e2e-docker.mjs` 9/9）；⑤ 包体积增量 < 30KB。
- **回滚**：`GRAFT_MAX_UI_LEGACY=1` 回退内联版一版（保留一个 release 周期）。

### N9 · 补回工具耗时卡片 + 性能分位

- **目标**：把 P2-1 的静默丢失补回，并升级成真正有用的观测面。
- **改动范围**：`/stats` 增 `p50/p95`（按工具聚合，采样最近 800 行）+ `fedHealth`（qmd/gitnexus/ccc 探针状态与延迟）；面板新增"工具耗时"卡与"联邦后端"卡。
- **验收**：① Playwright 断言卡片出现 ≥1 行且数值 > 0（先制造一次真实工具调用）；② `/stats` 串行 < 5ms、50 并发 p95 < 120ms（不劣化现有基线）；③ 有单测覆盖分位计算（给定日志样本断言 p50/p95 数值）。
- **回滚**：卡片可独立开关。

### N10 · 面板契约测试

- **目标**：把 max.9 的教训固化成断言："E2E 通过 ≠ UI 正确，必须有请求频率与写入结果断言"。
- **用例**：自动刷新频率（7s 内 `/stats` ≥ +2）、暂停后 0 请求、手动刷新始终生效、空态文案、断连横幅、主题持久化、`/storage` 30s 慢轮询解耦、窄屏 430px 无横向溢出。
- **验收**：`node e2e/ui-interact.mjs` 扩到 ≥ 12 条断言全绿；零 JS 错误（`pageerror` 监听）。

### N11 · 多仓库支持

- **目标**：现在"一个 server 一个 root"，面板一次只服务一个仓库；给出可落地的多仓库方案。
- **两案对比**（实施前需再拍板）：A「一个进程多 root」——`dashboard.ts` 的 `root` 变数组、会话表按仓库分组、`/storage` 按仓库展开；风险高（联邦 gitnexus 会话按 cwd 分桶是前置）。B「compose 多 service」——`docker-compose.max.yml` 用 `REPO_DIR_1..N` 生成多个 service；风险低、改动小、资源线性增长。
- **建议**：先做 B（1 天），把 A 留到有真实需求再说。
- **验收**：两个 service 同时起，各自面板端口不冲突（`GRAFT_MAX_UI` 递增），会话表不串。

### N12 · 联邦后端自助安装

- **目标**：把"装完要重启才生效"（P2-3）变成"面板可见 + 装完自动出现"。
- **方案**：面板新增"联邦后端"卡（qmd/gitnexus/ccc 三行：状态/版本/索引位置/最后探针时间 + 一键复制安装命令）；probe TTL + `list_changed` 让新工具即时出现。
- **验收**：卸载 qmd → 面板显示"未安装 + 安装命令"；安装 qmd → 5 分钟内（或点"重试探针"）面板变"就绪"，且 `tools/list` 多出 `max_find_docs`（真实 stdio 断言）。
- **不做**：不在面板里执行安装命令（安全边界）。

### N13 · 冷启动体验（首查建图 90s）

- **证据**：`src/graph/refresh.ts:66` `FIRST_BUILD_WAIT_MS = 90_000`——首次查询会**阻塞到 90 秒**。
- **目标**：把"黑屏 90 秒"变成"可感知进度 + 可提前返回"。
- **方案**：① 把 `building.json` 的生命周期交给 build 子进程（顺手修 P3-9），面板与工具返回都读它；② 工具返回改为"已开始在后台建图（第 N 秒）+ 预计时间 + 重试命令"，等待窗口降到 15–20s（可用 `GRAFT_MAX_FIRST_BUILD_WAIT_MS` 覆盖）；③ 面板"建图状态"卡显示进度（已解析文件数/总文件数，若 build 侧能提供）。
- **验收**：新仓库首查返回时间 < 20s 且带明确 note；后台建图完成后 `building.json` 消失；面板 KPI 在建图期间显示"建图中 · <repo>"。
- **风险**：降低等待会让 agent 首答"没有代码"——需在 note 里给出可执行的重试指引（现有文案已具备，保留）。

### N14 · 索引新鲜度可视化（P3 增强）

面板显示"图谱指纹 vs 工作区"的漂移摘要（改了几个文件、上次同步时间、下次自动同步剩余节流时间）。不做自动修复按钮（避免面板变成危险的操作台）。

### N15 · 打包完整性审计

- **目标**：`npm i -g graft-max` 后功能不缺件（当前 T7 blocked 但打包问题会一直存在）。
- **必查清单**：`package.json:files` = `dist, scripts, README, LICENSE` —— 检查 `dist/panel/`（N8 新增）、`dist/viewer/`、`dist/graph/queries/*.scm`、tree-sitter wasm、`dist/bin/*` 是否都在 `dist` 内（在就无需改 `files`）；`postinstall.mjs` 在全局安装（无 devDeps）下是否安全；`bin` 三个入口（`graft`/`graft-max`/`trail`）是否都指向 `dist/bin/graft.js`（注意：`trail` 指向 `dist/bin/trail.js`，`graft` 与 `graft-max` 同指 `graft.js` —— 确认 Max 身份是否因此被误判为上游）。
- **验收**：`npm pack` → 在空目录 `npm i -g ./graft-max-0.28.0-max.9.tgz` → `graft-max --version`、`graft-max mcp` 起得来、`graft-max viz` 有页面、面板有资源。

### N16 · CI 门禁

- **目标**：把"本机验证链"固化成 CI，杜绝"只有这台机器能跑"。
- **方案**：GitHub Actions（`windows-latest`）跑 `npx tsc --noEmit` → `npm run build` → `npm test` → `node e2e/e2e-fed-perf.mjs`（联邦后端用 mock 或缺省跳过，付费/外部依赖为 0）。macOS/ubuntu 只跑 tsc+build+test。
- **验收**：PR 上出现绿勾；故意引入一个类型错误 → CI 红。

### N17 · 发布（blocked，需用户账号）

`npm publish`（`publishConfig.access=public` 已就绪）/ Docker Hub 推送 / GitHub Release 附 tarball。**在拿到账号前不做任何伪造"已发布"**。

### N18 · 上游同步演练

- **目标**：量化"每次上游更新要付多少代价"，产出 SOP。
- **方案**：`git fetch upstream && git merge upstream/main`，记录冲突文件清单、解决手法、回归结果；把 SOP 写进 `docs-selfdev/上游同步SOP.md`（含"哪些文件是热路径，改它们前先想同步成本"）。
- **验收**：合并成功 + 完整验证链绿 + SOP 文档落地（若冲突过多，可只做"试合并并记录"而不 push）。

### N19 · 文档与实现对齐（每批收尾做）

README 修正（9 个工具、`max_search_semantic` 行、环境变量表补 `GRAFT_MAX_ICM`/`GRAFT_MAX_UI_TOKEN`/`GRAFT_MAX_FIRST_BUILD_WAIT_MS`）、CHANGELOG 追加、`e2e/E2E-REPORT.md` 重跑覆盖（版本号、工具名、耗时全部更新）。

### N20 · 知识沉淀

`docs-selfdev/` 新增三篇：`面板架构.md`（路由/数据源/轮询拓扑）、`联邦契约.md`（三个后端的输出格式与软错误矩阵）、`失败模式手册.md`（每个软错误 → 用户该做什么）。

---

## 6. 验收总表（每批收尾逐项勾）

### 6.1 批次级验收里程碑（DoD）

| 批次 | 完成定义（全部满足才算 done） |
|------|------------------------------|
| **A** | N1–N6 的 P1 缺陷全部有单测/curl 证据；`npm test` 新增 ≥ 5 个测试文件且总 fail 仍为 0；面板安全三连（403/401/回环端口）实测通过；ICM 一日调用量不再单调暴涨 |
| **B** | `npm run build` 产出 `dist/panel/*`；面板功能清单逐项勾销（含工具耗时卡）；`ui-interact` ≥12/12 且零 JS 错误；`/stats` p95 ≤ 120ms（不劣化） |
| **C** | 每个 C 批任务有真实使用场景验证（多仓库/装完后端即时出现/首查 <20s）；不新增伪功能 |
| **D** | `npm pack` 产物在干净目录全局安装可用；CI 绿；上游同步 SOP 落地；发布在拿到账号后才做 |
| **E** | README/CHANGELOG/E2E-REPORT/`workflow_status.md` 与实现逐条一致（Critic 复核） |

### 6.2 逐项验收表

| # | 标准 | 证据形式 |
|---|------|---------|
| 1 | `npx tsc --noEmit` 0 错误 | 命令输出 |
| 2 | `npm run build` 成功 + `--version` 正确 | 命令输出 |
| 3 | `npm test` 总 fail = 0（当前基线 0，不得回退） | 命令输出（含新增文件数） |
| 4 | 联邦 E2E：`e2e-federation` 9/9 + `e2e-fed-perf` ≥9/9（含内嵌断言） | 脚本输出 |
| 5 | 面板：`ui-interact` ≥12/12 + 零 JS 错误 + `/stats` p95 不劣化 | 脚本输出 + 压测数据 |
| 6 | 安全：Host 伪造 403、无令牌 401、容器端口只绑回环 | curl 输出 |
| 7 | Docker：`e2e-docker` 9/9 + `docker compose ps` healthy | 脚本输出 |
| 8 | 用户全局文件：连续 3 次注入幂等，文件无截断 | md5/行数对比 |
| 9 | 文档：README/CHANGELOG/E2E-REPORT 与代码一致 | 人工 diff（Critic） |
| 10 | `workflow_status.md` 已更新（含本轮证据） | 文件内容 |

---

## 7. 风险与反模式（写代码时最容易踩的）

1. **"UI 重做把功能弄丢"**——已经发生过一次（工具耗时卡片）。规则：任何前端重写，先列出旧页面的**全部功能清单**，逐项在新实现里勾掉，再提交。
2. **"E2E 通过 ≠ 用户路径可用"**——max.9 教训。面板类改动必须断言"请求频率"与"落盘结果"。
3. **"同步 IO 潜伏在热路径"**——`bumpRequests` 每次工具调用同步读改写（实测 1.08ms，尚可接受但会随会话数增长）。纪律：任何 `*Sync` 调用若在 `tools/call` 路径上，必须**实测过**并注释说明为什么可以接受。
4. **"给用户全局文件写东西"**——一律原子写 + 备份 + 幂等 + 可摘除（`switch-mcp.py` 的字节级替换是唯一例外，且已有 JSON 验证）。
5. **"为性能牺牲可读性"**——`federation.ts` 588 行已接近硬上限；新增逻辑优先新文件（`fed-*.ts` 模式已证明可行）。
6. **"多 Agent 并行改同一文件"**——`federation.ts` / `dashboard.ts` / `server.ts` 是本项目的三个冲突热点，任何并行任务必须显式划分文件边界。

---

## 8. 后续观察项（本轮不做，记录）

- `max_trace_arch` 在容器内的 gitnexus 索引预热流程（`workflow_status.md` §7 已列）
- `INSTALL_CCC=1` 镜像完整验证（语义搜索进容器）
- 上游 `viewer/`（图谱可视化）与本地面板的长期关系：是否需要一个统一入口（用户已选择"拆前端工程"而非"合并 viewer"，本条留作下轮候选）
- 遥测（`src/telemetry/`）：**本 fork 天然不上报**（仓库内 key 为空字符串，`scripts/stamp-telemetry-key.mjs` 仅在发布时由 `GRAFT_POSTHOG_KEY` 烤入），但发布纪律必须写死——发布 graft-max 时禁止设置该环境变量，否则会把 fork 事件发到 `events.nanonets.com`（见 S6）。

---

## 9. 横切约束（继承 v2.0 + 本轮新增）

**继承**（`docs-selfdev/项目约束.md` 全部有效，勿重复抄写）：graft_* 逐字节兼容、身份走环境变量、Max 槽位隔离、未邀请仓库零工具、联邦工具永不 throw、子进程硬超时、Windows 两段式 spawn、stdin-leash、上下文预算。

**本轮新增**：

| # | 约束 | 理由 |
|---|------|------|
| C1 | 任何前端重写必须过"功能清单逐项勾销"，且新增/删除 UI 元素必须有对应断言 | 工具耗时卡片静默丢失 |
| C2 | 写用户全局文件一律 `atomicWrite` + `.bak` + 幂等 + 可摘除 | CLAUDE.md 非原子写 |
| C3 | `tools/call` 热路径禁止无界同步 IO、禁止无上限子进程 spawn | `bumpRequests` 与 ICM spawn |
| C4 | 新增后台进程必须具备：超时、并发上限、关闭开关 | ICM / gitnexus session 教训 |
| C5 | 同一能力若存在多条实现路径（内嵌/降级），输出契约必须由**一处**格式化函数决定并有共享测试 | fed-qmd 双格式 |
| C6 | 面板若绑非回环地址（容器），必须同时满足：令牌 + Host 校验 + 端口只发布到 127.0.0.1（宿主侧） | P1-1 |
| C7 | 每个批次结束必须更新 `workflow_status.md` 的验收表与验证日志 | 证据链可追溯 |

---

## 10. 验证链（按风险选择，不要机械全跑）

```powershell
# 每次改动（低成本，必跑）
npx tsc --noEmit
npm run build
node dist/cli.js --version            # 0.28.0-max.N

# 涉及自研模块（devlog/federation/fed-*/dashboard/max-prompt）
node --test test/devlog-sessions.test.ts test/fed-cache.test.ts test/fed-qmd.test.ts test/max-prompt.test.ts

# 收批次尾（完整）
npm test                              # 总 fail 必须 0
node e2e/e2e-federation.mjs           # 9/9
node e2e/e2e-fed-perf.mjs             # ≥9/9
node e2e/ui-interact.mjs              # ≥12/12，零 JS 错误
node e2e/e2e-docker.mjs               # 9/9（涉镜像/容器权限时）
claude mcp list                        # graft-max ✔ Connected（涉 MCP 行为时）

# 真实会话冒烟（涉面板/工具名/提示词时）
# 在新 Claude Code 会话里调用一次 max_find_code + 打开面板确认会话表 LIVE
```

**分层规则**（用户明确要求）：改一个函数就跑对应单文件测试；跨模块或架构调整才跑完整链；不为每个小改动跑全量。

---

## 11. 待决策 / 待外部条件

| # | 事项 | 现状 | 需要谁 |
|---|------|------|--------|
| D-1 | npm 发布（N17） | blocked：无 npm 账号 | 用户提供账号与 OTP |
| D-2 | Docker Hub 推送 | 未开始：无账号 | 用户提供账号 |
| D-3 | 多仓库方案（N11） | 两案待选（建议先做 B：compose 多 service） | 用户拍板 |
| D-4 | 面板令牌是否默认开 | 建议默认开（容器形态必须），宿主形态可关 | 用户拍板 |
| D-5 | `GRAFT_MAX_UI_LEGACY` 兼容窗口 | 建议保留一个 release 后删除 | 用户拍板 |

---

## 附录 A · 关键文件地图（自研部分）

| 文件 | 行数 | 职责 | 本轮相关任务 |
|------|------|------|-------------|
| `src/mcp/server.ts` | 396 | MCP 门面：路由、工具列表、会话生命周期 | N3、N7、P3-1/P3-2 |
| `src/mcp/federation.ts` | 588 | 联邦三工具：qmd/gitnexus 会话、缓存、探针 | N5、N6、P3-3~P3-7 |
| `src/mcp/fed-qmd.ts` | 162 | qmd 进程内 SDK 快路径 + spawn 降级 | N5 |
| `src/mcp/fed-semantic.ts` | 94 | ccc 语义搜索 | N12 |
| `src/mcp/devlog.ts` | 319 | 日志滚动、汉化、会话注册表 | N4 |
| `src/mcp/dashboard.ts` | 669 | HTTP 面板（服务端 + 内联前端） | N1、N8、N9、N10 |
| `src/hosts/max-prompt.ts` | 90 | 全局提示词注入/摘除 | N2、P3-2 |
| `src/claude/stop.ts` | 258 | T6 编辑后自动增量索引 | 保持默认开（用户已定） |
| `src/graph/refresh.ts` | 407 | 首查自动建图 + 增量刷新 | N13、P3-9 |

## 附录 B · 证据采集命令（复核时直接跑）

> 已归档的实测证据：`evidence/panel-security-probe.md`（P1-1/S1/S5 的原始输出与复现脚本）、`evidence/max9-ui-docker.json`（max.9 压测原始数据）。

```powershell
# 缺陷证据
grep -n "toolStats" src/mcp/dashboard.ts | Select-String -NotMatch "cache|TTL|async function"
grep -n "rows.find((r) => r.pid === process.pid)" src/mcp/devlog.ts
grep -n "icmSpawn\|remember" src/mcp/server.ts
grep -n "writeFileSync" src/hosts/max-prompt.ts
grep -n "qmd://" e2e/e2e-federation.mjs
grep -n "formatResults" -A 20 src/mcp/fed-qmd.ts

# 基线核对
find src -name "*.ts" | xargs wc -l | tail -1
ls test | grep -icE "dashboard|devlog|federation|fed-"
icm.exe list --all | grep -c "isError="
```
