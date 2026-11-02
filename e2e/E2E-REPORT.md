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
