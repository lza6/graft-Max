# 面板端点安全探针（只读）

- 采集时间：2026-11-04
- 采集方式：在 24689 端口起一个独立 `startDashboard()` 实例（`GRAFT_MAX_UI=24689`、`GRAFT_MAX_LOG=1`），用 Node `fetch` 打真实 HTTP 端点，零 mock
- 目的：为《改进计划/下一步改进指南.md》P1-1 / S1 / S5 提供可复现证据
- 复现：`node <本文件同目录脚本>`（脚本内容见下）

## 实测输出（原样）

```
[graft-Max] dashboard: http://127.0.0.1:24689
/stats    => 200 | {"ct":"application/json; charset=utf-8","nosniff":null,"csp":null} | body: {"logPath":"C:\\Users\\Administrator.DESKTOP-EGNE9ND\\.graft-max\\mcp.log","logB...
/tail?n=3 => 200 | {"ct":"text/plain; charset=utf-8","nosniff":null,"csp":null} | body: [2026-11-04 07:46:52.640] <-- 收到请求 tools/list  id=1 [2026-11-04 07:46:52.941] <-
/sessions => 200 | {"ct":"application/json; charset=utf-8","nosniff":null,"csp":null} | body: [{"pid":30508,"cwd":"C:/Users/Administrator.DESKTOP-EGNE9ND/AppData/Local/Temp/t...
/storage  => 200 | {"ct":"application/json; charset=utf-8","nosniff":null,"csp":null} | body: {"root":"D:/自研工具/graft-Max","entries":[{"label":"开发者日志（滚动 5MB）","path":"C:\\User...
/stats with Host: evil.example.com => 200
```

## 结论（对应指南条目）

| 观察 | 含义 | 指南条目 |
|------|------|---------|
| 四个端点全部 200，无任何凭据 | 面板无鉴权 | P1-1 / S1 |
| `/tail` 返回日志原文（含工具调用行） | 开发上下文可被同网段读取 | P1-1 / S4 |
| `x-content-type-options` 与 `content-security-policy` 均为 `null` | 缺基础安全响应头 | S5 |
| 伪造 `Host: evil.example.com` 仍返回 200 | Host 头不校验 → DNS rebinding 面成立 | S5 / N1 验收项 |

## 复现脚本

```js
import { pathToFileURL } from 'node:url';
const { startDashboard } = await import(pathToFileURL('<repo>/dist/mcp/dashboard.js').href);
const PORT = 24689;
startDashboard(PORT, '<repo>');
await new Promise((r) => setTimeout(r, 900));
for (const p of ['/stats', '/tail?n=3', '/sessions', '/storage']) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
  console.log(p, r.status, r.headers.get('x-content-type-options'), (await r.text()).slice(0, 80));
}
const r2 = await fetch(`http://127.0.0.1:${PORT}/stats`, { headers: { Host: 'evil.example.com' } });
console.log('Host 伪造 =>', r2.status);
process.exit(0);
```

运行前置：`GRAFT_MAX_UI=24689 GRAFT_MAX_LOG=1 node <script>`（`GRAFT_MAX_UI` 不设则 dashboard 不启动——它是 opt-in）。
