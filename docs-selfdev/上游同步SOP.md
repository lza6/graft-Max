# 上游同步 SOP（`nanonets/graft` → graft-Max）

> 每次把上游前进合并进 fork 时照这个走。目标不是"合得上"，而是**知道要付多少代价**。
> 首次实测：2026-11-04（max.10 收尾，上游 `ca20a67`）。

## 0. 一句话结论（实测数据）

上游那次只前进 **1 个提交**（README 徽章链接），冲突 **1 文件 1 处**，解决成本 **≈1 分钟**。
但**同步成本不在这类提交上**——它在下面那 10 个"两边都改"的源文件里。

## 1. 数字基线（`git diff --numstat upstream/main...HEAD` 在 fork 点的结论）

69 个文件、**+5,776 / −1,894**；其中 **21 个是上游已有文件被修改**（有删除行 = 每次同步都要手工 merge），
其余 48 个是纯新增（几乎零冲突）。

## 2. 热路径文件清单（改之前先算同步成本）

| 文件 | 为什么会撞车 |
|------|-------------|
| `src/mcp/server.ts` | 我们在 `tools/list`/`tools/call` 里插了联邦分支、ICM 记录、中文日志、`setToolsRefreshHook` |
| `src/hosts/instructions.ts` / `src/mcp/instructions.ts` | 中文 instructions 重写 |
| `src/graph/refresh.ts` | 首查自动建图放开门槛 + 20s 等待窗口 + `buildingStatus()` |
| `src/claude/sync-run.ts` | `building.json` 归属建图进程（P3-9） |
| `src/claude/hooks.ts` / `sync-run.ts` | T6 自动增量索引接线 |
| `.claude/helpers/graft-hooks.cjs` / `graft-statusline.cjs` | hook 层 Max 化 |
| `package.json` | name/bin/files/version/scripts |
| `README.md` / `CHANGELOG.md` | **我们整篇重写** → 永远取 ours |
| 9 个上游测试文件 | 名称/断言随品牌调整 |

**纪律（架构层面）**：新增能力优先放**新文件**（`fed-*.ts`、`panel/`、`scripts/*.mjs`、
`docs-selfdev/*`），不要往 `server.ts` / `federation.ts` / `dashboard.ts` 继续堆。
这两个文件已经接近行数上限，往上堆的每一行都在给下次同步加利息。

## 3. 步骤

```powershell
# 1) 工作区必须干净（否则 merge 失败后你分不清哪些是你的改动）
git status --short

# 2) 取上游
git fetch upstream

# 3) 先算代价（不改工作区）
git rev-list --left-right --count HEAD...upstream/main     # 左边=我们领先, 右边=落后
git merge-tree --write-tree HEAD upstream/main > ..\mt.txt  # git>=2.38：试合并，只报冲突文件

# 4) 真合并
git merge upstream/main

# 5) 解决冲突
#    README.md / CHANGELOG.md → 永远 --ours（我们整篇重写，上游改动通常不适用）
git checkout --ours README.md && git add README.md
#    源码冲突 → 逐处读两边的意图，保住上游的行为修正 + 我们的 Max 分支，双方意图都要留

# 6) 验证（合并只碰文档时可只跑 1+2+快速 E2E；碰了源码必须跑全链）
npx tsc --noEmit
npm run build
node dist/cli.js --version
node e2e/e2e-ci-smoke.mjs
npm test                    # 总 fail 必须 0
node e2e/e2e-federation.mjs ; node e2e/e2e-fed-perf.mjs

# 7) 记账
git commit
```

## 4. 判定标准

| 项 | 通过线 |
|----|--------|
| `npx tsc --noEmit` | 0 错误 |
| `npm test` | 0 fail（基线见 `workflow_status.md` A3） |
| `e2e-ci-smoke` | 24/24 |
| 联邦 E2E | 9/9 + 9/9 |
| `git rev-list --left-right --count HEAD...upstream/main` | 右侧 = 0 |
| 冲突解决是否有"静默丢功能" | 前端/工具清单逐项勾销（约束 C1）；`tools/list` 工具数不得减少 |

## 5. 反模式（踩过/差点踩）

1. **拿 ours 解决源码冲突**——会静默丢掉上游的 bug 修正，且测试不会红（我们的测试只覆盖自己的路径）。
2. **合并完只跑 tsc**——联邦行为的变化只有 E2E 能看出来。
3. **在脏工作区上 merge**——失败后 `git merge --abort` 会把你的未提交工作一起搅进去。
4. **往热路径文件里加功能**——每次同步都要重新手工合；新功能请开新文件。

## 6. 本次记录（2026-11-04 · max.10）

```
上游提交      ca20a67 "Point the README website badge at trailhq.com/trail-code (#753)"
变更范围      README.md 1 文件 / +1 −1
冲突          README.md 一处（整段）→ 取 ours（该段在我们的重写里不存在）
解决成本      ≈1 分钟
验证          npx tsc --noEmit 0 错误；npm run build 成功；版本 0.28.0-max.10；
              npm test 4261 tests / 4158 pass / 0 fail；12 个 E2E 全绿
同步后状态    git rev-list --left-right --count HEAD...upstream/main → 32 0（不再落后）
```
