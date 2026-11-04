#!/usr/bin/env node
/**
 * Rejects staging of personal / machine-local files.
 *
 * Why this exists: this repo is public, and `git add -A` would otherwise push
 * the ICM memory database (8,000+ cross-project memories), the machine-local
 * MCP config, and the trail runtime folder. `.gitignore` stops the common case,
 * but it does nothing for paths already tracked or force-added — a pre-commit
 * gate is the last line of defence before data leaves the machine.
 *
 * Zero dependencies on purpose: this runs before anything is installed and must
 * work on a bare `git clone` on Windows (where hooks execute through sh).
 *
 * Usage:
 *   node scripts/check-forbidden-files.mjs           # check staged files (default)
 *   node scripts/check-forbidden-files.mjs --staged  # explicit, same behaviour
 *
 * Exit codes: 0 = clean (or nothing staged), 1 = at least one forbidden path.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Path rules, matched against the repo-relative path exactly as git prints it
 * (forward slashes even on Windows).
 */
const RULES = [
  { name: "SQLite database", test: (p) => /\.db$/i.test(p) },
  { name: "SQLite WAL/SHM sidecar", test: (p) => /\.db-(wal|shm)$/i.test(p) },
  { name: "database backup", test: (p) => /\.db\.backup-/i.test(p) },
  { name: "machine-local MCP config", test: (p) => /^\.mcp\.json$/.test(p) },
  { name: "trail runtime data", test: (p) => /^\.trail\//.test(p) },
];

function stagedFiles() {
  let out;
  try {
    out = execFileSync(
      "git",
      ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (err) {
    console.error("[check-forbidden-files] 无法读取暂存区（git diff --cached 失败）：");
    console.error(String(err?.stderr ?? err?.message ?? err));
    process.exit(1);
  }
  // -z separates entries with NUL, so filenames with spaces/unicode stay intact.
  return out.split("\0").filter(Boolean);
}

const staged = stagedFiles();
if (staged.length === 0) process.exit(0);

const hits = [];
for (const path of staged) {
  const rule = RULES.find((r) => r.test(path));
  if (rule) hits.push({ path, rule: rule.name });
}

if (hits.length === 0) process.exit(0);

console.error("");
console.error("[check-forbidden-files] ✗ 拒绝提交：暂存区包含个人/本机数据");
console.error("");
for (const hit of hits) {
  console.error(`  - ${hit.path}  （${hit.rule}）`);
}
console.error("");
console.error("这些是个人或本机数据，永不入库：");
console.error("  - memories.db / memories.db-wal / memories.db-shm：ICM 个人记忆库，含跨项目上下文");
console.error("  - *.db.backup-*：记忆库备份");
console.error("  - .mcp.json：每台机器不同的 MCP 配置");
console.error("  - .trail/：本地 trail 运行时数据");
console.error("");
console.error("处理方式：git restore --staged <文件> 把它移出暂存区（.gitignore 已覆盖，通常无需再管）。");
console.error("如确需提交（例如有意新增数据库 fixture），请用 git commit --no-verify 并在提交说明里写清理由。");
console.error("");
process.exit(1);
