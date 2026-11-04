import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
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
/** [M5] 进度采样 tick：worker 线程 500ms 一次产物体积统计，同步 build 期间也能跑。 */
const PROGRESS_TICK_MS = 500;

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

/**
 * [M5] 起一个 **worker 线程** 每 500ms 统计 `.graph` 产物字节数并**自己重写**
 * building.json（progress = { elapsedMs, bytesSoFar, samples }）。
 *
 * 为什么是 worker，且写文件也在 worker 里：默认 `realBuild` 是 execFileSync，
 * 会把主线程事件循环整个堵住 —— 主线程 setInterval 一次 tick 都跑不到，连
 * worker 发回的 message 回调也排队等主线程空闲。所以采样和写入都必须在
 * worker 线程完成。终值（samples+1 那次）由 stop() 在主线程 build 返回后
 * **同步**写入，然后才删 marker —— 终值一定写得进去。worker 只在 build 存活
 * 期间运行，stop() 里 terminate，无泄漏。全部吞错：进度是纯附加信息，绝不
 * 拖垮建图。
 */
function startProgress(dir: string, marker: string | null): () => void {
  if (!marker) return () => {}; // 状态文件写不了 → 没有可更新的事实，直接空操作
  const startedAt = (() => {
    try {
      return (JSON.parse(readFileSync(marker, 'utf8')) as { startedAt?: string }).startedAt ?? new Date().toISOString();
    } catch {
      return new Date().toISOString();
    }
  })();
  const workerSrc = `
import { parentPort, workerData } from "node:worker_threads";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const state = { samples: 0 };
const tick = () => {
  let bytesSoFar = 0;
  try {
    for (const name of readdirSync(workerData.graphDir)) {
      const st = statSync(join(workerData.graphDir, name));
      if (st.isFile()) bytesSoFar += st.size;
    }
  } catch { /* graph dir not there yet → 0 */ }
  state.samples += 1;
  try {
    writeFileSync(workerData.marker, JSON.stringify({
      startedAt: workerData.startedAt, pid: workerData.pid, root: workerData.root,
      progress: { elapsedMs: Date.now() - Date.parse(workerData.startedAt), bytesSoFar, samples: state.samples },
    }), 'utf8');
  } catch { /* building.json 被并发删了 → 跳过本次 tick */ }
};
tick();
setInterval(tick, ${PROGRESS_TICK_MS});
parentPort.on('close', () => { /* 主线程 terminate 时静默退出 */ });
`;
  let samples = 0;
  const writeProgress = (): void => {
    try {
      writeFileSync(
        marker,
        JSON.stringify({
          startedAt,
          pid: process.pid,
          root: dir,
          progress: { elapsedMs: Date.now() - Date.parse(startedAt), bytesSoFar: 0, samples },
        }),
        'utf8',
      );
    } catch {
      /* 纯附加信息：building.json 被并发删了，跳过 */
    }
  };
  let worker: Worker | undefined;
  try {
    // data: URL ESM worker —— eval:true 的 CJS worker 在 tsx loader 下拿不到
    // parentPort（loader 泄漏进 worker），ESM data: URL 两种环境都干净。
    worker = new Worker(
      new URL('data:text/javascript,' + encodeURIComponent(workerSrc)),
      {
        workerData: {
          graphDir: join(resolveContextDir(dir), '.graph'),
          marker,
          startedAt,
          pid: process.pid,
          root: dir,
        },
      },
    );
    worker.on('error', () => { /* 采样失败 → 面板少一条曲线，建图照常 */ });
    worker.unref(); // worker 只是采样；终值由主线程 stop() 同步写，unref 不影响它
  } catch {
    return () => {}; // worker 起不来 → 没有进度显示，建图照常
  }
  return () => {
    try { worker?.terminate(); } catch { /* already gone */ }
    samples = (() => {
      try {
        return ((JSON.parse(readFileSync(marker, 'utf8')) as { progress?: { samples?: number } }).progress?.samples ?? 0) + 1;
      } catch {
        return 1;
      }
    })();
    writeProgress(); // 终值：build 结束（成功/失败都要走到）后立刻写
  };
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
  const stopProgress = startProgress(dir, marker);
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
    stopProgress(); // M5：终值写入必须在 clearBuilding 之前（写完才删）
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
