# E2E 报告 — graft-Max（v0.28.0-max.10）

- 时间：2026-11-04
- 方式：**全部真实执行**——node 子进程起 `dist/cli.js mcp`（stdio JSON-RPC），真实后端
  （qmd / gitnexus / ccc 均为本机全局安装），真实浏览器（Playwright 1.64.1），真实容器
  （Docker Desktop 29.9.2）。零 mock 掉业务逻辑。
- 被测仓库：`C:/Users/Administrator.DESKTOP-EGNE9ND/Desktop/Agent-Code`（有 graft 索引 +
  agentcode qmd 集合 + gitnexus 索引）、`duck2api-hub`、以及各脚本自建的临时仓库。
- 总表：**11 个脚本，全部全绿**。

## 1. 一览

| 脚本 | 断言 | 结果 | 依赖 | 说明 |
|------|------|------|------|------|
| `e2e-ci-smoke.mjs` | 24 | **24/24** | 仅 dist + 临时仓库 | **自包含**，CI 与任何机器可跑；MCP 全链路 + 落盘证据 |
| `e2e-federation.mjs` | 9 | **9/9** | 真实 qmd/gitnexus | 联邦三工具 + 软错误 + legacy 别名 |
| `e2e-fed-perf.mjs` | 9 | **9/9** | 真实 qmd/gitnexus/ccc | 含 T2/T3/T4/T5 性能断言与内嵌路径格式断言 |
| `e2e-dashboard.mjs` | 5 | **5/5** | 真实 server | 会话/统计/tail/HTML + `/app.js` bundle |
| `e2e-live-scenario.mjs` | 8 | **8/8** | 真实 server | 模拟用户下一会话看到的画面 |
| `e2e-idempotent.mjs` | 9 | **9/9** | 真实 server ×5 | 提示词幂等 + 首查建图不重复 + 增量刷新 |
| `e2e-race.mjs` | 1 | **PASS** | 真实 server ×5 | 并发写 sessions.json 不损坏 |
| `e2e-fault-tolerance.mjs` | 6 | **6/6** | 代码级 | 超时/软错误/永不 throw |
| `e2e-backend-hotplug.mjs` | 9 | **9/9** | 假 qmd（真 PATH）+ 真面板 | 装完后端不用重启即出现工具 |
| `ui-interact.mjs` | 26 | **26/26** | Playwright | 零 pageerror / 零 console error |
| `panel-load.mjs` | 10 | **10/10** | 真实 server | 串行/50 并发/事件循环未堵 |
| `e2e-docker.mjs` | 13 | **13/13** | Docker | 镜像版本/非 root/MCP/令牌/健康检查 |
| `verify-compose.mjs` | 12 | **12/12** | Docker（compose 实例） | 部署后冒烟：端口回环/令牌/面板资源 |

## 2. 联邦层（真实后端）

| 结果 | 用例 | 耗时 | 证据摘要 |
|------|------|------|---------|
| ✅ | initialize | 875ms | `{"name":"graft","version":"0.28.0-max.10"}` |
| ✅ | tools/list 六件套 | 1137ms | max_find_code…max_repo_map（+ 视后端 0–3 个联邦工具） |
| ✅ | max_find_docs 真实 qmd 检索（**内嵌路径**） | 7–319ms | `qmd://agentcode/README.md:20 #101e06` + `Title:` + `Score:` |
| ✅ | max_trace_arch 真实 gitnexus（会话复用） | 1st 1153ms → 2nd **144ms** | definitions/processes 结构 |
| ✅ | max_search_semantic 真实 ccc | 459ms | `CHANGELOG.md:L11-14 (markdown) score=0.81` |
| ✅ | 缓存命中 | 2ms | 前缀 `[cached, 60s TTL]` |
| ✅ | 软错误（空 query / 后端缺失 / 超时 / 8MB 超限） | — | `isError:true` + 可执行修复命令，**永不 throw** |

## 3. 面板（真实浏览器，Playwright）

26 条断言全绿，关键几条：

| 断言 | 实测 |
|------|------|
| 5 张 KPI 卡 + 真实数值 | requests=3 |
| 工具耗时卡有真实数据行 | 3 行，`repo_map | 1 | 78 ms | 78 ms | 78 ms | 0` |
| p95 ≥ p50（分位没写反） | 78ms vs 78ms |
| 联邦后端卡 3 行 + 确定状态 | qmd 就绪 / 刚刚探测 / 297s 后可重探 |
| 存储卡按仓库分组 + 可复制 | 1 组 / 10 行 |
| 索引新鲜度卡 | 1 行 `同步` |
| 实时日志渲染 | 45 行，含汉化后的"工具调用" |
| 「只看错误」筛选 | 只剩 1 行 err（故意造的一次软错误） |
| 主题切换 + 刷新后保持 | light → dark，localStorage=dark |
| 轮询 500ms 真生效 | 2.4s 内 `/stats` 4 次 |
| 暂停后自动轮询停住 | 1.5s 内 0 请求；手动刷新仍生效 |
| 「重试探针」 | 真实调用 `/reprobe` 1 次 |
| 窄屏 430px | 溢出 0px |
| **零 pageerror / 零 console error** | 0 / 0 |

截图：`ui-interact.png`（面板全页）、`dashboard-*.png`。

## 4. 性能（`panel-load.mjs`，本机单机）

```
串行 p50/p95: /stats=2.7/4.0ms  /tail?n=200=1.2/1.4ms  /sessions=1.4/1.8ms
              /storage=1.3/1.6ms  /fresh=1.5/2.2ms
并发 50 × 3 轮 · 12987 请求 · 721.5 req/s · 中位 p50 69.2ms / p95 83.8ms / p99 105.2ms · 错误 0
/storage 20 并发 p50 12.5ms p99 14.4ms
压力下 /healthz p99 1.7ms（事件循环未被目录遍历堵死）
```

对照 max.9 基线：`/stats` 50 并发 p95 108ms → 本轮 **83.8ms**（3 轮中位）（新增 4 张卡后仍更快，
因为 toolStats 仍是 2s 缓存、storage 改为按 root 分桶）。

## 5. 容器（Docker Desktop 29.9.2）

`e2e-docker.mjs` 13/13：

```
D1 镜像内版本            0.28.0-max.10
D5 非 root 运行          uid=node
D2 MCP initialize        server=graft v=0.28.0-max.10
D2 tools/list            六个 max_*（+ 已装后端的联邦工具）
D3 真实工具调用          isError=false（挂载仓库上真建图）
D6 常驻模式存活          State.Running=true（GRAFT_MAX_LEASH=0）
D4a 容器形态强制令牌     stderr 带 ?token= 的 URL
D4b 无令牌 → 401
D4c /healthz 无鉴权 → 200
D4d 带令牌 /stats → 200
D4  /storage             10 条产物
D4  令牌不落 mcp.log     ✔（写进去等于把钥匙挂在门上）
```

`verify-compose.mjs` 12/12（**部署后**的真实实例）：
端口 `24688/tcp -> 127.0.0.1:24688`（不再是 0.0.0.0）、版本 max.10、`dist/panel/` 在镜像里、
无令牌 401、错误令牌 401、`?token=` 自举 Cookie 后页面 200、`/app.js` 17802B。

## 6. 环境要求与不可自动化的部分

| 脚本 | 需要什么 | 没有时 |
|------|---------|--------|
| `e2e-ci-smoke` / `panel-load` / `e2e-backend-hotplug` | 只要 `dist/` | 总能跑（CI 用它们） |
| `e2e-federation` / `e2e-fed-perf` | 真实 qmd + gitnexus（+ ccc）与已建索引的仓库 | 会如实 FAIL，不会假装通过 |
| `ui-interact` | Playwright（本机全局 1.64.1） | 报错退出 |
| `e2e-docker` / `verify-compose` | Docker Desktop + 已构建镜像 | 报错退出 |
| `e2e-dashboard` / `e2e-live-scenario` / `e2e-idempotent` / `e2e-race` | 本机 `Agent-Code` 仓库有索引 | 需改 `E2E_ROOT` |

**断言强度纪律（P3-18，本轮已修 6 处弱断言）**：不再出现"只判 `result !== undefined`"；
联邦断言检查内容形状（`qmd://…:line #docid` 正则、`isError` 判失败、`[cached]` 前缀）；
面板断言检查请求频率、落盘结果与零 JS 错误。
