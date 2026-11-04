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
| A3 | `npm test` 总 fail = 0（基线不得回退） | done | **4261 tests / 4158 pass / 0 fail / 103 skipped**，exit 0（max.9: 4156/4053/0） |
| A4 | 联邦 E2E 真实通过 | done | `e2e-federation` 9/9、`e2e-fed-perf` 9/9（含内嵌路径 `qmd://agentcode/README.md:20 #101e06` 断言） |
| A5 | 面板 UI 真实浏览器验收 ≥12 条 | done | `ui-interact` **26/26**，零 pageerror / 零 console error，截图 `e2e/ui-interact.png` |
| A6 | Docker 部署真实可用 | done | 见 §4（重建镜像 → 热更新 → 容器 E2E 9/9） |
| A7 | 面板端点压测有数据且不劣化 | done | 串行 p50 `/stats` 3.7ms、`/tail` 1.4ms、`/storage` 1.1ms；50 并发 p95 **86.5ms**（max.9: 108ms）；697 req/s；零错误 |
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
| **N7** | 自研模块单测补齐 | done | 10 个新测试文件、90+ 断言（见 `test_ledger.md`） |
| **N8** | 面板前端拆工程 | done | `panel/` → `dist/panel/`；`GRAFT_MAX_UI_LEGACY=1` 回退；ui-interact 26/26 |
| **N9** | 工具耗时卡 + 性能分位 | done | `panel` 工具耗时卡（calls/avg/p50/p95/errors）+ `/stats.toolStats`；断言 p95≥p50 |
| **N10** | 面板契约测试 | done | `ui-interact` 26/26（含轮询频率、暂停语义、零 JS 错误） |
| **N11** | 多仓库（方案 A） | done | `knownRoots()` + `/storage.roots` 分组 + 存储缓存按 root 分桶 |
| **N12** | 联邦后端自助安装 | done | `e2e-backend-hotplug` 9/9（装完 → 点重探 → tools/list 立刻多出工具） |
| **N13** | 冷启动体验 | done | `test/first-build-wait.test.ts` 6/6（20s 窗口 + 进度 note + building.json 归建图进程） |
| **N14** | 索引新鲜度可视化 | done | `/fresh` + 面板「索引新鲜度」卡（clean/drift/unknown + 改增删） |
| **N15** | 打包完整性审计 | done | `npm pack` 含 9 wasm + 17 scm + panel + viewer；干净 prefix 全局安装后 build/viz 可用 |
| **N16** | CI 门禁 | done（本地等价验证） | `.github/workflows/ci-max.yml`（tsc+build+版本断言+打包完整性+冒烟 E2E）；GitHub 真绿勾见 §6 待验证 |
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
npm test                              4261 tests / 4158 pass / 0 fail / 103 skipped / exit 0
node e2e/e2e-ci-smoke.mjs             24/24
node e2e/e2e-federation.mjs           9/9
node e2e/e2e-fed-perf.mjs             9/9（T3 一次 1153ms → 二次 144ms）
node e2e/e2e-dashboard.mjs            5/5（含 /app.js bundle 断言）
node e2e/e2e-live-scenario.mjs        8/8
node e2e/e2e-idempotent.mjs           9/9
node e2e/e2e-race.mjs                 PASS（sessions.json 合法 JSON 7 行）
node e2e/e2e-fault-tolerance.mjs      6/6
node e2e/e2e-backend-hotplug.mjs      9/9
node e2e/ui-interact.mjs              26/26（零 pageerror）
node e2e/panel-load.mjs               10/10（见 A7）
node e2e/e2e-docker.mjs               9/9（重建镜像后，见下）
```

压测（`e2e/panel-load.mjs`，本机单机）：
```
串行 p50/p95: /stats=3.7/4.4ms  /tail?n=200=1.4/1.8ms  /sessions=1.1/1.5ms  /storage=1.1/1.3ms  /fresh=1.1/1.3ms
并发 50 · 6s · 4181 请求 · 696.8 req/s · p50 70.8ms p95 86.5ms p99 120.1ms · 错误 0
/storage 20 并发 p50 13.4ms p99 14.2ms
压力下 /healthz p99 3ms（事件循环未被目录遍历堵死）
```

Docker 热更新：
```
回滚镜像      graft-max:rollback-max9（= 旧 86b9b45851be，3.19GB）
重建          docker build -f Dockerfile.max -t graft-max:latest .
热更新        docker compose up -d（端口从 0.0.0.0:24688 改为 127.0.0.1:24688）
容器 E2E      node e2e/e2e-docker.mjs → 9/9
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
| R2（独立 Critic） | 见 §8 | |

## 6. 已知限制 / 待外部条件

- **N17 npm publish / Docker Hub push：blocked**（无账号；用户指示走本地闭环）。产物：tarball、本机镜像、GitHub Release。
- CI 的**真绿勾**需 push 后由 GitHub 执行（本轮会 push，结果写回本节）。
- 压测为本机单机数据，不构成生产并发基准。
- `INSTALL_CCC=1` / `INSTALL_GITNEXUS=1` 镜像未实测（默认关，各 +2GB）。
- 面板 "建图进度" 只到"已耗时 N 秒 + 仓库"，没有文件级进度（build 侧未暴露中途计数）。
- `GRAFT_MAX_UI_LEGACY=1` 的旧内联页面保留一个 release 周期（按指南 D-5）。

## 7. 上游同步（N18）

`git fetch upstream && git merge upstream/main` 试合并结果、冲突热点与解决 SOP 见
`docs-selfdev/上游同步SOP.md`（含"这 10 个文件是热路径，改之前先算同步成本"）。

## 8. 独立审查

（Critic 子代理结论写在此处，见 §8 表格补充）

| 项 | 结论 |
|----|------|
| 待填 | — |
