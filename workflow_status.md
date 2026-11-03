# workflow_status — graft-Max

> 只记录事实与证据，不记录推理与敏感信息。只有观察到交付物和验收证据才标 done。
> 更新于 2026-11（v0.28.0-max.9）

## 1. 任务契约

| 项 | 内容 |
|---|---|
| 产品 | graft-Max：graft 的深度 fork，MCP server（仓库上下文图谱 + 联邦工具 + 开发者面板 + Docker 部署） |
| 红线 | graft_* 六件套逐字节兼容（见 `docs-selfdev/项目约束.md`）；品牌走环境变量；上游槽位隔离；未邀请仓库零工具 |
| 本机 | Windows 11 + Docker Desktop；仓库 `D:\自研工具\graft-Max`；E2E 实验仓库 `duck2api-hub` |

## 2. 验收标准与状态

| # | 标准 | 状态 | 证据 |
|---|------|------|------|
| A1 | `npx tsc --noEmit` 0 错误 | done | 每次改动后执行，均 0 错误 |
| A2 | `npm run build` 成功，`--version` 正确 | done | `0.28.0-max.9` |
| A3 | `npm test` 无失败 | done | 4156 tests / 4053 pass / 0 fail（基线 max.6 为 11 fail） |
| A4 | 联邦 E2E 真实通过 | done | e2e-fed-perf 8/8、e2e-federation 9/9、duck-hub 7/7 |
| A5 | 面板 UI 真实浏览器验收 | done | ui-interact 7/7；截图 4 张；自动刷新/暂停/筛选/复制/主题实测 |
| A6 | Docker 部署真实可用 | done | e2e-docker 9/9；compose `Up (healthy)` |
| A7 | 面板端点压测有数据 | done | 串行 <3ms；50 并发 /stats p95 108ms；/storage p99 5.3ms（修复前 7329ms） |
| A8 | 文档与实现一致 | done | CHANGELOG / README / 项目约束 / 改造日志 / E2E-REPORT 同步 |

## 3. 任务图（已完成）

| ID | 任务 | 状态 | 证据 |
|----|------|------|------|
| T1 | 版本号漂移修复（package.json max.1→.9；仓库字段） | done | `--version`；无 trailhq 残留 |
| T2 | 进程内嵌 qmd | done | searchLex 2-5ms（原 293ms）；日志 `in-process store ready` |
| T3 | gitnexus 常驻会话 | done | 二次调用 128-200ms（原 1244ms） |
| T4 | 联邦工具 60s 结果缓存 | done | 命中 10-15ms，`[cached]` 标注 |
| T5 | 第 9 工具 max_search_semantic | done | ccc 本地嵌入，E2E 380ms 出结果 |
| T6 | 编辑后自动增量索引（默认开） | done | 单测 5/5；GRAFT_MAX_AUTO_INDEX 开关 |
| T7 | npm 发布 | **blocked** | 无 npm 账号（用户指示跳过）；bin/files/版本已就绪 |
| T8 | 测试基线收敛 | done | 17 fail → 0（含根因修复：shipCheck 跨运行污染→沙箱 TRAIL_HOME） |
| T9 | Dashboard（耗时卡 + 存储/DB 视图 + 视觉重做） | done | 截图 + 压测 + 浏览器交互断言 |
| T10 | 旧产物清理 | done | 自研说明.md 合并删除；完成文档归档 `改进计划/archive/` |
| D1 | Docker 部署（镜像 + compose + 容器 E2E） | done | e2e-docker 9/9；compose healthy |

## 4. 验证日志（最近一轮）

```
tsc --noEmit                0 错误
npm run build               成功，version 0.28.0-max.9
npm test                    4156 tests / 4053 pass / 0 fail
node e2e/e2e-docker.mjs     Docker E2E: 9/9 passed
node e2e/ui-interact.mjs    UI 深度交互验收: 7/7
node e2e/e2e-fed-perf.mjs   8/8 PASS
node e2e/e2e-federation.mjs 9/9 passed
node e2e/e2e-duck-hub.mjs   7/7 passed
docker compose ps           graft-max-dashboard Up (healthy) 24688
压测：/stats p50 56.7ms(p95 107.7) /storage p50 4.3ms(p99 5.3) /tail p50 6.5ms err=0
```

## 5. 审查发现（已关闭）

| 轮次 | 发现 | 处理 |
|------|------|------|
| R1-R3 | 关停竞态、dirSize 卡主轮询、esc 未转义引号、qmd 失败永久缓存等 9 项 | 全部修复并通过复验（Approve） |
| R4 | qmd SQLite 未计入 WAL/SHM、favicon 无 cache-control、提示词端口写死 | 全部修复（Approve） |
| R5 | 面板重做 + 容器权限 + 压测修复 | 见 `evidence/max9-ui-docker.json` |

## 6. 已知限制

- `INSTALL_CCC` / `INSTALL_GITNEXUS` 未在镜像内实测（默认关，各 +2GB）
- 压测为本机单机，不构成生产并发基准
- 面板仅绑定本机回环（容器内需 `GRAFT_MAX_UI_HOST=0.0.0.0` 才能被 `-p` 打到）

## 7. 下一步（未开始，按需）

- `INSTALL_CCC=1` 镜像完整验证（语义搜索进容器）
- 多仓库切换：面板一次只服务一个 root，多仓库需要多实例（compose 可用多 service）
- `max_trace_arch` 的 gitnexus 索引在容器内的预热流程
