/**
 * Privacy guard rails (plan task N0).
 *
 * This repo is public, and the working tree next to it holds the ICM memory
 * database, a machine-local MCP config and trail runtime data. A single
 * `git add -A` used to be enough to publish all of it. These assertions pin the
 * three layers that prevent that: the ignore rules, the hook script's lack of
 * dependencies (it must run on a bare clone), and git actually agreeing the
 * database is ignored.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("gitignore: personal data and machine-local config are ignored", () => {
  const ignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
  for (const entry of ["memories.db", "*.db.backup-*", ".mcp.json", ".trail/"]) {
    assert.ok(
      ignore.split(/\r?\n/).includes(entry),
      `.gitignore must contain the exact line ${JSON.stringify(entry)}`,
    );
  }
});

test("check-forbidden-files: exists and imports nothing outside node:", () => {
  const scriptPath = join(repoRoot, "scripts", "check-forbidden-files.mjs");
  assert.ok(existsSync(scriptPath), "scripts/check-forbidden-files.mjs must exist");

  const source = readFileSync(scriptPath, "utf8");

  // No CommonJS — the pre-commit hook runs it as ESM on a bare clone.
  assert.ok(!/\brequire\s*\(/.test(source), "script must not use require()");

  const specifiers = [
    ...source.matchAll(/\bfrom\s+["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s+["']([^"']+)["']/g),
  ].map((m) => m[1]);

  for (const specifier of specifiers) {
    assert.ok(
      specifier.startsWith("node:"),
      `third-party import ${JSON.stringify(specifier)} would break a fresh clone`,
    );
  }
});

test("git: memories.db is actually reported as ignored", () => {
  const stdout = execFileSync("git", ["check-ignore", "-v", "memories.db"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.match(stdout, /memories\.db/);
});
