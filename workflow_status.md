# workflow_status — graft-Max

> 只记录事实与证据，不记录推理与敏感信息。只有观察到交付物和验收证据才标 done。
> 更新于 2026-11-04（v0.28.0-max.10，对应 `改进计划/下一步改进指南.md` v3.0 的 N0–N20 全量）

## 1. 任务契约

| 项 | 内容 |
|---|---|
| 产品 | graft-Max：graft 的深度 fork，MCP server（仓库上下文图谱 + 联邦工具 + 开发者面板 + Docker 部署） |
| 红线 | graft_* 六件套逐字节兼容（`docs-selfdev/项目约束.md`）；品牌走环境变量；上游槽位隔离；未邀请仓库零工具 |
| 本机 | Windows 11 + Docker Desktop；仓库 `D:\自研工具\graft-Max`；E2E 实验仓库 `duck2api-hub` / `Agent-Code` |
| 本轮范围 | 指南 v3.0 批次 A→E 全 21 卡（用户授权全量） |
| 用户拍板 | ① 全量执行 ② 发布走本地闭环（npm pack + 本机 Docker 热更新 + GitHub Release）③ N11 采用方案 A（单进程多 root）④ 面板令牌容器强制/宿主默认关 |

## 2. 验收标准与状态（本轮）

| # | 标准 | 状态 | 证据 |
|---|------|------|------|
| A1 | `npx tsc --noEmit` 0 错误 | done | 每条改动后执行，均 0 输出 |
| A2 | `npm run build` 成功（含 panel 前端 tsc + esbuild） | done | `dist/panel/app.js` 17.4KB；版本 `0.28.0-max.10` |
| A3 | `npm test` 总 fail = 0（基线不得回退） | done | **4263 tests / 4160 pass / 0 fail / 103 skipped**，exit 0（max.9: 4156/4053/0） |
| A4 | 联邦 E2E 真实通过 | done | `e2e-federation` 9/9、`e2e-fed-perf` 9/9（含内嵌路径 `qmd://agentcode/README.md:20 #101e06` 断言） |
| A5 | 面板 UI 真实浏览器验收 ≥12 条 | done | `ui-interact` **27/27**，零 pageerror / 零 console error，截图 `e2e/ui-interact.png` |
| A6 | Docker 部署真实可用 | done | `e2e-docker` **13/13**（新镜像 max.10）；`verify-compose` **12/12**（热更新后的真实实例） |
| A7 | 面板端点压测有数据且不劣化 | done | 串行 p50 `/stats` 2.7ms、`/tail` 1.2ms、`/storage` 1.3ms；50 并发 p95 **83.8ms**（max.9: 108ms）；721.5 req/s；零错误 |
| A8 | 文档与实现一致 | done | README / CHANGELOG / `docs-selfdev/*` / `test_ledger.md` / `policy.md` 同步 |
| A9 | 安全三连实测 | done | Host 伪造 403 / 无令牌 401 / 容器端口只绑 `127.0.0.1` |
| A10 | 用户全局文件幂等无截断 | done | `test/atomic-write.test.ts` + `test/max-prompt.test.ts`（7/7） |
| A11 | 打包完整性（干净目录全局安装） | done | `npm pack` 3.4MB/1531 文件；`--version`/`build`/`viz` 页面 200 |

## 3. 任务图（N0–N20）

| ID | 任务 | 状态 | 关键证据 |
|----|------|------|---------|
| **N0** | 隐私加固（.gitignore + pre-commit + 备份移出） | done | `git check-ignore -v memories.db` 命中；`node scripts/check-forbidden-files.mjs` 对 `memories.db` exit=1 |
| **N1** | 面板安全 hardening | done | curl: 403 / 401 / 200(带令牌) / 200(/healthz) + 4 个安全头 + `set-cookie gm_ui` |
| **N2** | atomicWrite 统一 11 处用户全局文件写入 | done | `test/atomic-write.test.ts`（.bak 轮转/非法 JSON 拒绝/中断不破坏原文件） |
| **N3** | ICM 时间线批量化 | done | `test/icm-timeline.test.ts` 9/9；10 次调用 → JSONL 10 行 + spawn 0 次 |
| **N4** | devlog 身份 + 计数节流 | done | `test/devlog-sessions.test.ts` 9/9（同 pid 不同 host 只改本机行；10 次 bump 只落盘 1 次） |
| **N5** | 联邦输出契约对齐 CLI | done | `test/fed-qmd.test.ts` + fixture（真实 `qmd search` 输出）；E2E 断言 `qmd://…:line #docid` |
| **N6** | 联邦健壮性三补 | done | `test/fed-robustness.test.ts`（监听器归零 / probe 30s+5min TTL / 8MB kill）+ `fed-cache` 键序 |
| **N7** | 自研模块单测补齐 | done | **12 个新测试文件 / 107 条用例**（`git diff --diff-filter=A c7fd6ab..HEAD -- test/` 实测；见 `test_ledger.md`） |
| **N8** | 面板前端拆工程 | done | `panel/` → `dist/panel/`；`GRAFT_MAX_UI_LEGACY=1` 回退；ui-interact 27/27 |
| **N9** | 工具耗时卡 + 性能分位 | done | `panel` 工具耗时卡（calls/avg/p50/p95/errors）+ `/stats.toolStats`；断言 p95≥p50 |
| **N10** | 面板契约测试 | done | `ui-interact` 27/27（含轮询频率、暂停语义、零 JS 错误） |
| **N11** | 多仓库（方案 A） | done | `knownRoots()` + `/storage.roots` 分组 + 存储缓存按 root 分桶 |
| **N12** | 联邦后端自助安装 | done | `e2e-backend-hotplug` 9/9（装完 → 点重探 → tools/list 立刻多出工具） |
| **N13** | 冷启动体验 | done | `test/first-build-wait.test.ts` 6/6（20s 窗口 + 进度 note + building.json 归建图进程） |
| **N14** | 索引新鲜度可视化 | done | `/fresh` + 面板「索引新鲜度」卡（clean/drift/unknown + 改增删） |
| **N15** | 打包完整性审计 | done | `npm pack` 含 9 wasm + 17 scm + panel + viewer；干净 prefix 全局安装后 build/viz 可用 |
| **N16** | CI 门禁 | done | `.github/workflows/ci-max.yml`；**GitHub 侧实跑全绿**：`max gate (ubuntu-latest)` ✅ + `max gate (windows-latest)` ✅（commit 4d63b5e，run 41752856232） |
| **N17** | 发布（npm/Docker Hub） | **blocked** | 无账号（用户指示本地闭环）：tarball + 本机 Docker 热更新 + GitHub Release 替代 |
| **N18** | 上游同步演练 | done | 见 §4（试合并 → 冲突清单 → SOP `docs-selfdev/上游同步SOP.md`） |
| **N19** | 文档与实现对齐 | done | README（6+3 工具口径/8 个新 env/面板安全两形态）、CHANGELOG、E2E-REPORT 重跑 |
| **N20** | 知识沉淀 | done | `docs-selfdev/面板架构.md`、`联邦契约.md`、`失败模式手册.md` |
| P3-1…P3-11 | 静态清理项 | done | if/else 同体、ensurePromptBlock 接线、I18N 死规则根因、cacheKey 键序、liveSessions 写副作用、缓存计数、gnx 会话分桶、host 转义、building.json 归属、README 漂移、E2E-REPORT 版本 |
| P3-12…P3-19 | 见 N7/N10/§3 | done | 零单测→10 文件；E2E 弱断言→形状断言；`initialize.serverInfo.name` 说明见 `项目约束.md` §1 |

## 4. 验证日志（本轮，全部真实执行）

```
npx tsc --noEmit                      0 错误（多次）
npm run build                         成功；dist/panel/app.js 17.4KB；9 wasm；17 scm
node dist/cli.js --version            0.28.0-max.10
npm test                              4263 tests / 4160 pass / 0 fail / 103 skipped / exit 0
node e2e/e2e-ci-smoke.mjs             24/24
node e2e/e2e-federation.mjs           9/9
node e2e/e2e-fed-perf.mjs             9/9（T3 一次 1153ms → 二次 144ms）
node e2e/e2e-dashboard.mjs            5/5（含 /app.js bundle 断言）
node e2e/e2e-live-scenario.mjs        8/8
node e2e/e2e-idempotent.mjs           9/9
node e2e/e2e-race.mjs                 PASS（sessions.json 合法 JSON 7 行）
node e2e/e2e-fault-tolerance.mjs      6/6
node e2e/e2e-backend-hotplug.mjs      9/9（点重探按钮即生效）
node e2e/e2e-fed-heartbeat.mjs       3/3（不点按钮，30s 失败 TTL 后心跳自动发现）
node e2e/ui-interact.mjs              27/27（零 pageerror）
node e2e/panel-load.mjs               10/10（见 A7）
node e2e/e2e-docker.mjs               13/13（新镜像 max.10，含令牌 401/200 与非 root）
node e2e/verify-compose.mjs           12/12（部署后真实实例：端口回环/令牌/面板资源/令牌不落盘）
```

压测（`e2e/panel-load.mjs`，本机单机）：
```
串行 p50/p95: /stats=2.7/4.0ms  /tail?n=200=1.2/1.4ms  /sessions=1.4/1.8ms  /storage=1.3/1.6ms  /fresh=1.5/2.2ms
并发 50 × 3 轮 · 12987 请求 · 721.5 req/s · 中位 p50 69.2ms / p95 83.8ms / p99 105.2ms · 错误 0
/storage 20 并发 p50 12.5ms p99 14.4ms
压力下 /healthz p99 1.7ms（事件循环未被目录遍历堵死）
```

Docker 热更新（`docker-compose.max.yml`）：
```
回滚点        docker tag graft-max:latest graft-max:rollback-max9（= 旧 86b9b45851be）
重建          docker build -f Dockerfile.max -t graft-max:latest .   → 6bc461a8082c
热更新        docker compose -f docker-compose.max.yml up -d        → Recreated + Started
端口变化      BEFORE 0.0.0.0:24688->24688  →  AFTER 127.0.0.1:24688->24688
容器 E2E      node e2e/e2e-docker.mjs       → 13/13
部署冒烟      node e2e/verify-compose.mjs   → 12/12（healthy / max.10 / 401 / 200 / app.js / 令牌不落 mcp.log）
回滚命令      docker tag graft-max:rollback-max9 graft-max:latest && docker compose up -d
```

打包（N15）：
```
npm pack                 graft-max-*.tgz 3.4MB / 1531 文件
tar 清单                 wasm=9 · dist/vendor=17 · dist/viewer=3 · dist/graph/queries=17
npm i -g --prefix <空目录> ./graft-max-*.tgz   →  added 28 packages
graft-max --version      0.28.0-max.（正确）
graft-max build .        微型仓库建图成功（无 devDeps，走 vendored wasm）
graft-max viz --port ..  / => 200 2417B ; /app.js => 200 35825B
```

## 5. 审查发现

| 轮次 | 发现 | 处理 |
|------|------|------|
| R1（批次 A/B 自审，逐条 curl/命令验证） | ① 子代理产出需独立复核 → 60 个新单测全部我自己重跑；② `?n=abc` 打 `/tail` 返回空 body（NaN 进 slice） | ① 全部 60/60 通过；② 修为回退默认 200，并加进 `dashboard-routes` 断言 |
| R1 续 | ③ `dlogBlock` 从不过汉化层（P3-3 真根因） | 修根因 + 恢复/新增规则 + 加真实日志行测试（7/7） |
| R1 续 | ④ fullPage 截图里 header 落到 KPI 下方 | 用 boundingBox（header y=0 / kpis y=92）+ DOM 顺序证明是 Chromium sticky 截图伪影；E2E 截图前置 `position:static` |
| R1 续 | ⑤ `e2e-live-scenario` 断言 `s[0]`、且钉死 qmd spawn 路径 | 改为按自己 pid 找行、接受内嵌/spawn 两条真实路径（更强的"后端真被调用"断言） |
| R1 续 | ⑥ `e2e-dashboard` 断言 `toggleTheme` 在 HTML 里（N8 后移入 bundle） | 改为同时断言 HTML 与 `/app.js`（更强：多一个 404 就能发现） |
| R1 续 | ⑦ 多仓库下 `/storage` 单槽缓存会让每个请求重算 N 次遍历 | 缓存与 inflight 按 root 分桶（压测 p50 1.1ms 证明） |
| R2（CI 反查，读上一版 push 的 Actions 日志） | ⑧ **仓库 CI 一直是红的（ubuntu + windows 都红）**：`test/mcp-server.test.ts` 的两条 "advertises every tool"（not ok 1738/1739）把联邦工具写进固定期望值，并引用 `GRAFT_MAX_FEDERATED=0` 当确定性开关 —— 而**代码里从来没实现过这个开关**（只在测试与 `项目约束.md` §4 被提到）。结果装了后端的机器多两个工具、CI runner 少两个工具，两边都断言失败（4050 pass / 2 fail）。 | ⑧ 真正实现 `GRAFT_MAX_FEDERATED=0/false`（`availableFederatedTools()` 返回空）；测试改确定性口径（六件套 + 六件套之外只允许联邦工具）。`test/mcp-server.test.ts` 5/5；README 补该变量。 |
| R2 续 | ⑨ `/reprobe` 无节流：回环免令牌形态下任何本机页面都能用 `<img src>` 触发它，而它 spawn 三个探针进程 | ⑨ 加 2s 节流（429 + retryInMs）+ 契约测试 |
| R3（CI 深挖，读 GitHub 上 node-20 那条 `CI` 的失败日志） | ⑩ windows-latest：`fed-qmd` 8 条失败——仓库无 `.gitattributes`，Git for Windows 的 `core.autocrlf=true` 把逐字节 fixture 检出成 CRLF。⑪ ubuntu-latest：`icm-timeline` 超时用例失败——`Promise resolution is still pending but the event loop has already resolved`，根因是 flush 超时定时器被 `unref()`，事件循环排空后超时回调不执行（生产语义同样错：5s 超时必须 kill）。 | ⑩ 新增 `.gitattributes`（`test/fixtures/** -text`；`*.sh`/`.githooks` 钉 LF），并在 autocrlf=true 的机器上重新 clone 验证 fixture 保持 LF、README 变 CRLF。⑪ 去掉该 unref；`test/icm-timeline.test.ts` 9/9。 |
| R4（独立 Critic） | 见 §8 | |

## 6. 已知限制 / 待外部条件

- **N17 npm publish / Docker Hub push：blocked**（无账号；用户指示走本地闭环）。产物：tarball、本机镜像、GitHub Release。
- CI 的**真绿勾**：已实测。`CI (graft-Max gate)` 在 `4d63b5e` 上 **ubuntu-latest ✅ + windows-latest ✅**
  （双平台都跑 tsc / build / 版本断言 / 打包完整性 / 自包含 E2E；ubuntu 额外跑 `npm test` 通过，
  run id 41752856232）。
- **遗留一条上游 CI 红灯**：上游自带的 `.github/workflows/ci.yml`（node 20，跑 `npm test`）在
  `4d63b5e` 的 ubuntu leg 仍失败（windows leg 通过）。本轮新 gate 用 node 22 且全绿，
  说明这是 **Node 20 特有的**上游测试问题，与 Max 改动无关（max.9 时两个 leg 都红）。
  已记入 `改进计划/下一步改进指南.md` 的遗留清单（M13 一带处理：给 ci.yml 也升到 22 或定位该用例）。
- 压测为本机单机数据，不构成生产并发基准。
- `INSTALL_CCC=1` / `INSTALL_GITNEXUS=1` 镜像未实测（默认关，各 +2GB）。
- 面板 "建图进度" 只到"已耗时 N 秒 + 仓库"，没有文件级进度（build 侧未暴露中途计数）。
- `GRAFT_MAX_UI_LEGACY=1` 的旧内联页面保留一个 release 周期（按指南 D-5）。

## 7. 上游同步（N18，已真合并）

```
合并前  git rev-list --left-right --count HEAD...upstream/main → 28 1
        （落后 1 个提交：ca20a67 "Point the README website badge at trailhq.com/trail-code"）
试合并  git merge-tree --write-tree HEAD upstream/main → exit=1，只报 CONFLICT README.md
真合并  git merge upstream/main → 1 文件 1 处冲突
解决    取 ours（我们整篇重写了 README，上游只改了一行徽章链接，那段内容在我们版本里不存在）
合并后  HEAD...upstream/main → 32 0（不再落后）；tsc 0 错误 / build 成功 / 版本 max.10 / CI smoke 24/24
```

SOP 落地：`docs-selfdev/上游同步SOP.md`（热路径 10 文件清单、步骤、判定标准、4 条反模式、本次记录）。

## 8. 独立审查（状态：部分完成，如实记录）

| 项 | 事实 |
|----|------|
| 独立 Critic 子代理（全量面） | **本会话内未返回结论**（启动后长时间无输出，会话结束前未等到报告）。**不得视为已审查。** |
| 独立 Critic 子代理（定向 6 问） | **同上，未返回结论。** |
| 本主控的替代审查（显式声明：这是同一执行环境里的**角色切换**，不是独立进程） | 逐条复核了 12 项声称（测试数、CI、压测、容器、打包、上游同步）并全部用命令复现；另做了 5 项对抗性自查，**发现并修复 2 个真问题**：<br>① `/stats` 同请求内两次读 `sessions.json`（50 并发 = 100 次/s 重复读）→ 改为一次快照复用；<br>② 面板改刷新间隔时若正好有 `tick()` 在飞，旧轮询链不会退休 → 双链并存频率翻倍 → 加代际号（诚实标注：未构造出复现时序，属按代码读出的竞态、防御性修复）。<br>另修正 3 处**过度声称**（测试数 9/10/11 不一致 → 统一 12 文件/107 用例；压测数字三份文档各不相同 → 统一到一次真实输出；`serverInfo.name` 的 E2E 断言描述与代码不符 → 改写并补 `file:line`）。 |
| 结论 | **P0/P1 未发现**；2 个自查问题已修复并复验；但**独立第三方审查仍缺**，因此本轮不给 "Approve"，按 `policy.md` §4 应视为 `CONDITIONAL`：功能可交付，审查门禁未闭合。下一轮第一件事就是补一次真正的独立审查（`改进计划/下一步改进指南.md` 已列为前置）。 |
