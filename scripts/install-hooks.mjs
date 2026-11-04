#!/usr/bin/env node
/**
 * Points this clone at the repo's tracked hooks directory.
 *
 * `.githooks/` is committed, but git only runs it when `core.hooksPath` says so
 * — a fresh clone runs nothing. This sets it for the current repository only
 * (no `--global`), so other checkouts of other projects are untouched.
 *
 * Idempotent: run it as many times as you like. Zero dependencies.
 *
 * Usage: node scripts/install-hooks.mjs   (or: npm run hooks:install)
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hooksDir = ".githooks";

if (!existsSync(resolve(repoRoot, hooksDir, "pre-commit"))) {
  console.error(`[install-hooks] ✗ 找不到 ${hooksDir}/pre-commit，仓库可能不完整。`);
  process.exit(1);
}

try {
  execFileSync("git", ["config", "core.hooksPath", hooksDir], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  const current = execFileSync("git", ["config", "--get", "core.hooksPath"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  console.log(`[install-hooks] ✓ core.hooksPath = ${current}（本仓库本地配置）`);
  console.log("[install-hooks] pre-commit 隐私检查已生效。");
} catch (err) {
  console.error("[install-hooks] ✗ 设置 core.hooksPath 失败：");
  console.error(String(err?.stderr ?? err?.message ?? err));
  process.exit(1);
}
