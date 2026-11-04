# test_ledger — 测试台账（graft-Max · max.10）

> 只记录**真实存在、真实跑过**的测试。状态列含义：
> `已验证`=本轮实际执行并看到输出；`静态确认`=读代码/文件确认存在但本轮未执行；`待验证`=缺环境。
> 每次改动按风险选最小范围（见 `policy.md` §7 与指南 §10），不为小改动跑全量。

## 1. 本轮新增（自研模块从零单测到有网）

> 实测口径：`git diff --name-only --diff-filter=A c7fd6ab..HEAD -- test/` → **12 个测试文件**
> （外加 1 个 fixture `test/fixtures/qmd-cli-sample.txt`），合计 **107 条 `test()` 用例**。

| 文件 | 覆盖什么 | 关键断言 | 状态 |
|------|---------|---------|------|
| `test/devlog-sessions.test.ts` | 会话注册表：host+pid 身份、计数节流、自净、跨 host 判活、坏 JSON 自愈 | 同 pid 不同 host 只改本机行；10 次 bump 不在热路径落盘、flush 一次写 10；GET 不写盘；死 pid 被剪 | 已验证 9/9 |
| `test/devlog-i18n.test.ts` | 日志汉化层 | 英文请求行被翻；中文行不二次翻译；**`dlogBlock` 标题必须汉化、body 原文不翻** | 已验证 6/6 |
| `test/icm-timeline.test.ts` | ICM 批量化 | 10 次调用 → JSONL 10 行且 **spawn 0 次**；满 32 行自动 flush；`=0` 全关；真参数 `store -t tool-timeline -c <批量>`；非 0 退出/error/超时 均丢批次且 kill | 已验证 9/9 |
| `test/atomic-write.test.ts` | 原子写工具 | 中断后原文件不变；`.bak` 轮转 3 份；非法 JSON 拒绝写；幂等 | 已验证 |
| `test/max-prompt.test.ts` | 全局提示词注入 | created/updated/unchanged 三态；手删补回 + 60s 节流；摘除零残留；大小写重复键不丢 | 已验证 7/7 |
| `test/fed-qmd.test.ts` | qmd 输出契约 | 与真实 CLI 样本逐字符相等（fixture）；空结果非错误；SDK 缺失降级；索引缺失软错误带修复命令 | 已验证 |
| `test/fed-cache.test.ts` | 联邦缓存 | 键序无关命中；TTL 过期重算；错误不缓存；容量淘汰；计数可见 | 已验证 |
| `test/fed-robustness.test.ts` | 联邦健壮性 | 握手后 `listenerCount('data')===0`；探针 30s/5min TTL；8MB stdout → kill + 软错误；超时/起不来永不 throw；cwd 分桶不串仓 | 已验证 |
| `test/dashboard-routes.test.ts` | 面板路由契约（真 server，随机端口） | 6 个端点状态码/content-type/形状；`/tail?n=abc` 不空；`/stats` 字段齐全 + p95≥p50 + 错误计数；`/storage` 老形状 + `roots`；Host 伪造 403（用 node:http，fetch 伪造不了 Host）；`percentile`/`knownRoots` 纯函数 | 已验证 15/15 |
| `test/dashboard-security.test.ts` | 面板鉴权 | Host 白名单；无令牌 401；`?token=`/Bearer/Cookie 三种携带；`/healthz` 无鉴权；安全头 | 已验证 |
| `test/first-build-wait.test.ts` | 冷启动 + building.json 生命周期 | 默认 20s 窗口（env 覆盖生效）；超时 note 含"已 N 秒 + 重试指引"；建图进程写/删状态文件（抛错也删）；残留超时判陈旧 | 已验证 6/6 |
| `test/ignored-files.test.ts` | 隐私加固 | `.gitignore` 四条覆盖；`git check-ignore` 真命中；钩子脚本零第三方依赖 | 已验证 4/4 |

## 2. 本轮修改/重写的 E2E

| 脚本 | 断言数 | 依赖 | 状态 |
|------|-------|------|------|
| `e2e/e2e-ci-smoke.mjs`（新） | 24 | 仅 dist + 临时仓库（**无外部后端/无浏览器**） | 已验证 24/24 |
| `e2e/ui-interact.mjs`（重写） | 26 | Playwright + dist | 已验证 26/26，零 pageerror |
| `e2e/e2e-backend-hotplug.mjs`（新） | 9 | dist + 假 qmd（真 PATH）+ 真面板 | 已验证 9/9 |
| `e2e/e2e-fed-perf.mjs`（加强断言） | ≥9 | 真实 qmd/gitnexus | 见 §4 |
| `e2e/e2e-federation.mjs` | 9 | 真实后端 | 见 §4 |
| `e2e/e2e-docker.mjs` | 9 | Docker Desktop | 见 §4 |

## 3. 回归基线

| 门 | 基线 | 本轮 | 证据 |
|----|------|------|------|
| `npx tsc --noEmit` | 0 错 | 0 错 | 每条改动后执行 |
| `npm run build` | 成功 | 成功（含 panel 前端 tsc + esbuild） | `dist/panel/app.js` 17.4KB |
| `npm test` | max.9: 4156 tests / 0 fail | 见 `workflow_status.md` §4 | 命令输出 |
| 面板端点 | 串行 <5ms / 50 并发 p95<120ms | 见 §4 压测 | 脚本输出 |
| 打包 | — | `npm pack` 3.4MB / 1531 文件，9 wasm + 17 scm + panel + viewer 齐 | `tar -tzf` 输出 |
| 全局安装 | — | 干净 prefix 安装 → `--version` / `build` / `viz` 页面 200 | 实测 |

## 4. 尚未在本轮执行（明确标注，不伪装）

| 项 | 原因 | 替代验证 |
|----|------|---------|
| `e2e/e2e-docker.mjs`（容器 9/9） | 需要重建镜像（约 1–3 分钟）+ Docker Desktop 运行中；本轮在最后的热更新阶段执行 | 见 `workflow_status.md` §4 |
| GitHub Actions 真绿勾 | 需要 push（本轮会推）；`gh run watch` 结果写回 `workflow_status.md` | 本地同命令全绿 |
| `INSTALL_CCC=1` / `INSTALL_GITNEXUS=1` 镜像 | 各 +2GB 且未实测过 | 记为已知限制 |
| 跨平台（macOS） | 本机只有 Windows | CI 的 ubuntu-latest leg 覆盖 Linux |

## 5. 断言强度纪律（P3-18）

新增/修改断言时必查：

1. 不得只判 `result !== undefined`——必须判 `isError === false` **且** 内容形状（正则/字段）。
2. UI 断言必须覆盖"请求频率"或"落盘结果"，不能只看元素存在。
3. 新增断言若可被"后端全挂"满足，等于没断言。
4. 前端重写必须提交旧功能清单逐项勾销（约束 C1）。
