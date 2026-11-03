# E2E 报告 — graft-Max MCP 联邦层

- 时间：2026-11-02T19:28:50.816Z
- 方式：**真实 E2E**——node 子进程起 `dist/cli.js mcp`（stdio JSON-RPC），打真实后端（qmd 2.8.3、gitnexus 1.6.12 均为本机全局安装），零 mock
- 被测仓库：C:/Users/Administrator.DESKTOP-EGNE9ND/Desktop/Agent-Code（有 graft 索引 + agentcode qmd 集合 + gitnexus 索引）
- 结果：**9/9 PASS**

| 结果 | 用例 | 耗时 | 证据摘要 |
|------|------|------|---------|
| ✅ PASS | initialize | 875ms | {"name":"graft","version":"0.28.0-max.1"} |
| ✅ PASS | tools/list has graft six | 1137ms | graft_find_code,graft_file_api,graft_check_freshness,graft_trace_calls,graft_fin |
| ✅ PASS | tools/list has max_find_docs (qmd probed OK) | 1137ms | present |
| ✅ PASS | tools/list has max_trace_arch (gitnexus probed OK) | 1137ms | present |
| ✅ PASS | max_find_docs real qmd search | 293ms | hits: 1, first: qmd://agentcode/README.md:344 #101e06
Title: Agent-Code
Score:   |
| ✅ PASS | max_trace_arch real gitnexus query | 1244ms | isError=false, text: {
  "processes": [],
  "process_symbols": [],
  "definition |
| ✅ PASS | max_find_docs empty query → soft isError | 2675ms | max_find_docs requires a query |
| ✅ PASS | graft_find_code still works | 131ms | graft ask — "federation proxy tools"  (empty)

no matching nodes across 4 worksp |
| ✅ PASS | legacy alias graft_ask still works | 230ms | isError=false |

## 关键实测数据

- **max_find_docs（qmd 代理）**：真实 BM25 检索 293ms，命中 `qmd://agentcode/README.md:344`（81% 分）
- **max_trace_arch（gitnexus 代理）**：真实架构图查询 1244ms，返回 JSON 图谱结果
- **无回归**：graft 六件套 + legacy 别名（graft_ask）全部照常；`tools/list` 一次返回 8 个工具

## E2E 过程中发现并修复的坑（全部沉淀进 federation.ts 注释）

1. **Windows .cmd shim**：`spawn('qmd')` ENOENT——npm 全局 CLI 是 cmd shim，需先直试再 shell 兜底（runCli 两段式）
2. **MCP 握手缺 `notifications/initialized`**：gitnexus 静默丢弃 tools/call
3. **一次性 write+stdin.end() 丢消息**：经 cmd shim 的管道竞争——必须分步写、保持 stdin 打开（修复后 gitnexus 查询从 45s 超时 → 1.2s 返回）
4. **spawn cwd 相对路径**：`dist/cli.js` 相对子进程 cwd 解析——必须传绝对路径（fileURLToPath）

## 复跑

```powershell
cd D:\自研工具\graft-Max
node e2e/e2e-federation.mjs        # 默认根=graft-Max 自身
$env:E2E_ROOT="C:/Users/Administrator.DESKTOP-EGNE9ND/Desktop/Agent-Code"; node e2e/e2e-federation.mjs
```

## max.7 联邦性能与第 9 工具（2026-11，e2e-fed-perf.mjs 8/8）

真实 stdio JSON-RPC，根目录 = duck2api-hub（授权实验仓库）。真实后端调用，无 mock。

| 用例 | 结果 | 耗时 | 说明 |
|------|------|------|------|
| tools/list 含联邦工具组 | ✅ | 695ms | 9 个 max_*（含 max_search_semantic） |
| T2 qmd 内嵌搜索 | ✅ | ~2-5ms 进程内 | createRequire → 动态 import 修复（top-level-await ESM） |
| T4 缓存命中 | ✅ | 10-15ms | `[cached, 60s TTL]` 标注 |
| T3 gitnexus 首调（含握手） | ✅ | 1047-1939ms | — |
| T3 gitnexus 二调（会话复用） | ✅ | **128-200ms** | 原 1244ms |
| T5 语义搜索 | ✅ | ~380ms | ccc 本地嵌入，file:line + score |

复跑：`node e2e/e2e-fed-perf.mjs`（E2E_ROOT 可覆盖，默认 duck2api-hub）

## 存储/产物视图验收（max.7 追加）

- /storage 端点：7 条产物（日志 520KB、sessions.json、~/.trail 30.7KB、.graft-max 523KB、
  仓库 graft/ 12.6MB、.trail/ 0B、.cocoindex_code/ 60MB）路径+大小全部正确
- Playwright：表 7 行渲染、复制按钮反馈"已复制"、轮询解耦实证（7s: /stats×4, /storage×1）
- 截图：dashboard-storage.png（暗色主题存储表）、dashboard-full.png（全页）

## Docker 部署 E2E（max.7，e2e/e2e-docker.mjs 9/9）

真实容器、真实 MCP stdio 协议、真实 dashboard HTTP。镜像 `graft-max:latest`（3.2GB，构建 ~60s）。

| 用例 | 结果 | 证据 |
|------|------|------|
| D1 镜像内版本 | ✅ | `0.28.0-max.7` |
| D5 非 root | ✅ | `uid=node` |
| D2 MCP initialize | ✅ | `server=graft v=0.28.0-max.7` |
| D2 tools/list 六件套+联邦 | ✅ | max_find_code…max_repo_map(+max_find_docs) |
| D3 真实工具调用（挂载仓库） | ✅ | `[graft] tokens saved ≈ 5,893 (99%)` |
| D6 常驻存活（leash 关） | ✅ | State.Running=true, dashboardReady=true |
| D4 /stats 真实响应 | ✅ | 真实 HTTP |
| D4 /storage 真实响应 | ✅ | 10 条产物（容器路径 /workspace/graft 等） |
| D4 日志 boot 行 | ✅ | stderr 面板地址 + 日志文件 boot 行 |

UI 截图：`e2e/docker-dashboard.png`（Playwright 真实浏览器：主题切换持久化、复制按钮反馈"已复制"、
刷新按钮触发请求、存储表 10 行含 qmd DB/.gitnexus、零 JS 错误）

## max.9 面板重做 + 容器权限修复（真实浏览器验收）

| 验收项 | 结果 | 证据 |
|--------|------|------|
| 自动刷新真的在跑 | ✅ | 7s 内 /stats +3 /tail +3（2s 间隔） |
| 暂停 = 全停 | ✅ | 暂停后 5s 内额外请求 +0 |
| 主题持久化 | ✅ | 切换后重载仍为所选主题 |
| 日志级别筛选 | ✅ | "只看错误" 1 行 / "全部" 16 行 |
| 复制路径 | ✅ | 按钮反馈"已复制" |
| 零 JS 错误 | ✅ | pageerror/console.error 均为空 |
| 移动端 430px | ✅ | KPI 卡片宽 196px，两列堆叠 |
| 容器内数据真实落盘 | ✅ | 命名卷修复后 9/10 产物存在、活跃会话 1（修复前全 0） |

截图：`e2e/dashboard-light.png` / `dashboard-dark.png` / `dashboard-mobile.png`
