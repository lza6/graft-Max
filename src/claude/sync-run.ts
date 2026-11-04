import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { constants, setPriority } from 'node:os';
import { pathToFileURL } from 'node:url';
import { readWiring, computeStats } from './stats.js';
import { patchStats, releaseLock, resolveContextDir } from './state.js';
import { claimLock } from '../util/state.js';
import { graftCliPath } from './paths.js';

/** How long the end-of-turn rebuild may take before it is killed. */
const BUILD_TIMEOUT_MS = 120000;

/**
 * [graft-Max N13 / P3-9] 建图状态文件的唯一所有者就是这个建图进程。
 *
 * 历史坑：上游让**等待查询**在等待循环结束后 unlink 掉 building.json —— 于是
 * "建图还在跑、面板却显示建完了"，而且两个查询先后到达时会互删对方的状态。
 * 现在改成：谁真的在 build，谁负责写和删；等待方只读（`graph/refresh.ts`
 * 的 `buildingStatus()`）。
 */
function buildingMarkerPath(dir: string): string {
  return join(resolveContextDir(dir), '.graph', 'building.json');
}

function markBuilding(dir: string): string | null {
  try {
    const p = buildingMarkerPath(dir);
    mkdirSync(join(resolveContextDir(dir), '.graph'), { recursive: true });
    writeFileSync(p, JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid, root: dir }), 'utf8');
    return p;
  } catch {
    return null; // 状态文件是纯附加信息，写不了不耽误建图
  }
}

function clearBuilding(p: string | null): void {
  if (!p) return;
  try {
    unlinkSync(p);
  } catch {
    /* already gone */
  }
}

/** MONEY GUARD: plain `graft build` only — structural, $0, offline. Never --deep. */
function realBuild(dir: string, timeout = BUILD_TIMEOUT_MS): void {
  // GRAFT_TEST_CLI is the same seam hooks.ts's graftJson uses, so a test can
  // point this at a stub and inspect the exact argv it was invoked with.
  const cliPath = process.env.GRAFT_TEST_CLI ?? graftCliPath();
  const args = [cliPath, 'build', '.'];
  // Mirrors `withContextDirArg` in hooks.ts: a no-op unless GRAFT_DIR is set, so an
  // unconfigured repo's rebuild sees byte-identical argv to before this existed.
  if (process.env.GRAFT_DIR) args.push('--dir', resolveContextDir(dir));
  execFileSync(process.execPath, args, { cwd: dir, stdio: 'ignore', timeout, windowsHide: true });
}

export function runSync(dir: string, build: (d: string) => void = realBuild): void {
  // Whoever took the lock has likely exited by now; the lock names this process
  // instead, so it is not taken over while the build below still runs.
  claimLock(dir);
  const marker = markBuilding(dir);
  try {
    build(dir);
    const w = readWiring(dir);
    if (!w) { patchStats(dir, { syncing: false }); return; } // build ran but output unreadable — stay dirty, retry
    patchStats(dir, {
      dirty: false, staleCount: 0, syncing: false, syncedAt: new Date().toISOString(),
      ...computeStats(w),
    });
  } catch {
    // [S1 review max.7] record the failed attempt so autoIndexAfterEdit's
    // throttle can back off — otherwise a broken-index repo pays a spawn +
    // immediate failure on EVERY post-edit.
    patchStats(dir, { syncing: false, syncedAt: new Date().toISOString() }); // leave dirty=true; retry next turn
  } finally {
    releaseLock(dir);
    clearBuilding(marker);
  }
}

export function main(): void {
  const dir = process.argv[2];
  // An optional build timeout in ms: a repo's first build, started by a query
  // (graph/refresh.ts), parses every file and can outlast the end-of-turn budget.
  const timeout = Number(process.argv[3]);
  if (!dir) return;
  // A background build: the person's own work goes first, and on an idle machine it is
  // as fast as before. The `build` child inherits the priority.
  try { setPriority(constants.priority.PRIORITY_LOW); } catch { /* runs at normal priority */ }
  runSync(dir, timeout > 0 ? (d) => realBuild(d, timeout) : realBuild);
}

// Run only when executed directly (node dist/claude/sync-run.js <dir> [timeoutMs]), not on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
