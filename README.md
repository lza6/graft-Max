<div align="center">

# graft-Max

**自研代码上下文工具链 —— 基于 graft 的深度定制版**

graft-Max = [nanonets/graft](https://github.com/nanonets/graft) v0.28.0 fork + 自研 MCP 聚合层（规划中）

</div>

---

## 这是什么

graft-Max 是我们对 **graft**（代码上下文图谱，Agent 用它做结构化代码检索）的自研 fork：

- **上游核心**：把仓库建成本地可再生的 context graph，Agent 的 `explore`/`context`/`affected` 查询一次顶几十次 grep+read
- **我们的增量**（本仓库 `docs-selfdev/` 记录全部改造）：
  - v0.28.0-max.1：品牌化基座（package: `graft-max`，`GRAFT_MAX_INVOKED_AS` 环境变量标记 Max 构建，行为与 graft 逐字节兼容）
  - 规划中：**统一 MCP 门面** —— 在 `src/mcp/server.ts` 聚合 qmd（文档语义）/ gitnexus（架构图谱）/ cocoindex-code（语义搜索）查询，Agent 只见一个 server
- **为什么 fork**：graft 是我们实测最好用、Agent 调用最频繁的代码工具；拿到源码才能按自己的工具链深度整合

## 上游关系与同步

| 项 | 值 |
|----|-----|
| 上游 | https://github.com/nanonets/graft （同代码双名：trail / graft） |
| 基线 | v0.28.0（main `b9c2e23`） |
| 同步 | `git pull https://github.com/nanonets/graft.git main` 后重跑 `npm run build` |
| 测试基线 | 4043 pass / 11 fail（failures 集中在 trail 同步与日期相关用例，非核心路径） |

## 构建与使用

```powershell
npm install          # 74 包，~25s
npm run build        # tsc 0 错误 + viewer bundle + 17 个 grammar query + 9 个 wasm
node dist/cli.js --version   # → 0.28.0-max.1
npm test             # 完整测试套件
```

把 Claude Code 的 MCP 指到自产版：

```powershell
claude mcp remove graft -s user
claude mcp add graft --scope user -- node D:\自研工具\graft-Max\dist\bin\graft.js mcp
```

## 目录导览

| 路径 | 内容 |
|------|------|
| `src/mcp/` | MCP server 本体（server.ts / connector.ts）——**聚合层改造点** |
| `src/tools.ts` | 工具注册与命名（explore / context / affected…） |
| `src/brand.ts` | 品牌机制（trail/graft 双名 + **graft-Max 标记**） |
| `src/blast/` | blast-radius 影响半径 |
| `src/graph/` | tree-sitter 图谱查询 |
| `docs-selfdev/` | **我们的自研文档**（改造记录/整合设计） |
| `README-upstream.md` | 上游原版 README |

## License

遵循上游 LICENSE（见 LICENSE 文件）。graft-Max 品牌层与 docs-selfdev/ 归本项目。
