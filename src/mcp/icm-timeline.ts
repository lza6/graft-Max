/**
 * [graft-Max N3] ICM 时序记忆批量化。
 *
 * 背景（P1-2）：原实现每次 `tools/call` 完成都 `spawn('icm.exe', ['remember', …])`，
 * 单次实测 3.26 秒、无超时、无节流、无上限；一天下来 ICM 库里堆了几千条
 * "工具调用时间线"，把 `icm recall` 的信噪比彻底冲垮，同时每次调用后多一个
 * 3 秒的顽固子进程。
 *
 * 现在的策略（三条硬约束，对应 docs-selfdev/项目约束.md C4）：
 *   1. **先落本地 JSONL**（`~/.graft-max/tool-timeline.jsonl`，append-only）——
 *      数据永不丢，ICM 挂掉也不影响；
 *   2. **批量进 ICM**：缓冲满 `BATCH_LINES` 行或距上次 flush 超过 `FLUSH_MS`
 *      才起**一个** `icm.exe store` 进程，把整批作为一条记忆写进去；
 *   3. **超时 + 并发 1**：单次 flush 硬超时 5s（超时 kill），同一时刻最多一个
 *      icm 子进程在飞；失败静默丢批次（不重试、不阻塞、不影响 MCP 响应）。
 *
 * 开关：
 *   - `GRAFT_MAX_ICM=0`  完全关闭（连 JSONL 都不写）
 *   - `GRAFT_MAX_ICM=2`  干跑模式：只计数、不 spawn（单测与 E2E 用）
 *   - `GRAFT_TEST=1`     同上（E2E 脚本统一开的静默位）
 */
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { GRAFT_MAX_HOME, tightenPerms } from './devlog.js';

/** 一批最多攒多少行（够了就立刻 flush，不等定时器）。 */
const BATCH_LINES = 32;
/** 距上次 flush 超过这么久且有缓冲 → flush（由下一次 record 触发，或退出时强制）。 */
const FLUSH_MS = 60_000;
/** 单次 icm 子进程硬超时。 */
const ICM_TIMEOUT_MS = 5_000;
/** 可用 GRAFT_MAX_ICM_TIMEOUT_MS 覆盖（单测里调到 50ms）。 */
function icmTimeoutMs(): number {
  const v = Number(process.env.GRAFT_MAX_ICM_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : ICM_TIMEOUT_MS;
}
/** 单测注入点：替换 spawn，用来断言参数与模拟 exit/error/超时，不真起进程。 */
type SpawnLike = typeof spawn;
let spawnImpl: SpawnLike = spawn;
export function __setIcmSpawnForTest(fn: SpawnLike | null): void {
  spawnImpl = fn ?? spawn;
}
/** 行内 args 截断长度（保持记忆精简可读）。 */
const ARGS_CLIP = 200;

export interface IcmTimelineStats {
  /** 当前缓冲行数 */
  buffered: number;
  /** 已成功提交给 icm 的批次数 */
  batches: number;
  /** 已写入 JSONL 的行数 */
  lines: number;
  /** 实际 spawn 的 icm 子进程次数（干跑模式下为 0） */
  spawns: number;
  /** 失败/超时被丢弃的批次数 */
  dropped: number;
  /** 因干跑或关闭而跳过的 spawn 次数 */
  skipped: number;
  lastFlushAt: number | null;
}

let buffer: string[] = [];
/** [M9] JSONL 首次创建后收过权限就不重复 chmod。 */
let permsDone = false;
let lastFlushAt = 0;
let inFlight: Promise<void> | null = null;
const stats: IcmTimelineStats = {
  buffered: 0,
  batches: 0,
  lines: 0,
  spawns: 0,
  dropped: 0,
  skipped: 0,
  lastFlushAt: null,
};

/** 0 = 全关；2 = 干跑；其它(默认 1/未设) = 正常。 */
function mode(): 0 | 1 | 2 {
  if (process.env.GRAFT_TEST === '1') return 2;
  const v = process.env.GRAFT_MAX_ICM;
  if (v === '0') return 0;
  if (v === '2') return 2;
  return 1;
}

export function timelinePath(): string {
  return join(GRAFT_MAX_HOME, 'tool-timeline.jsonl');
}

/** 记一次工具调用。永不 throw、永不阻塞（只做字符串拼装 + appendFileSync）。 */
export function recordTimeline(tool: string, args: unknown, ms: number, isError: boolean): void {
  const m = mode();
  if (m === 0) return;
  let brief: string;
  try {
    const json = JSON.stringify(args ?? {});
    brief = json.length > ARGS_CLIP ? `${json.slice(0, ARGS_CLIP)}…` : json;
  } catch {
    brief = '<unserializable>';
  }
  const iso = new Date().toISOString();
  const line = `${iso} ${tool} ${ms}ms isError=${isError} args=${brief}`;
  // 1) 本地 JSONL：先落地，后端挂了也不丢。失败静默（日志层永远不能拖垮 server）。
  try {
    mkdirSync(GRAFT_MAX_HOME, { recursive: true });
    appendFileSync(timelinePath(), line + '\n', 'utf8');
    // [M9] JSONL 是跨项目的工具调用史，首次创建后收紧权限（POSIX 0600；Windows no-op）。
    if (!permsDone && existsSync(timelinePath())) {
      permsDone = true;
      tightenPerms(timelinePath());
    }
    stats.lines += 1;
  } catch {
    /* 磁盘满/权限 → 丢这一行的本地副本，继续走内存缓冲 */
  }
  // 2) 内存缓冲 → 满批或超时自动 flush
  buffer.push(line);
  stats.buffered = buffer.length;
  const now = Date.now();
  if (buffer.length >= BATCH_LINES || (lastFlushAt !== 0 && now - lastFlushAt >= FLUSH_MS)) {
    void flushTimeline();
  } else if (lastFlushAt === 0) {
    // 首次记录：起一个 unref 定时器，保证"只调一次也要落进 ICM"
    const t = setTimeout(() => void flushTimeline(), FLUSH_MS);
    t.unref?.();
  }
}

/**
 * 把缓冲提交给 icm。并发上限 1：已有一个在飞时直接返回（不排队、不堆积），
 * 缓冲留给下一次触发或进程退出时的强制 flush。
 */
export function flushTimeline(): Promise<void> {
  if (inFlight) return inFlight;
  if (buffer.length === 0) return Promise.resolve();
  const m = mode();
  if (m === 0) {
    buffer = [];
    stats.buffered = 0;
    return Promise.resolve();
  }
  const batch = buffer;
  buffer = [];
  stats.buffered = 0;
  lastFlushAt = Date.now();
  stats.lastFlushAt = lastFlushAt;
  if (m === 2) {
    // 干跑：只计数，证明"每 N 次调用只 spawn 一次"这条契约，不碰外部进程。
    stats.skipped += 1;
    stats.batches += 1;
    return Promise.resolve();
  }
  inFlight = new Promise<void>((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (ok) stats.batches += 1;
      else stats.dropped += 1;
      inFlight = null;
      resolve();
    };
    try {
      const child = spawnImpl('icm.exe', ['store', '-t', 'tool-timeline', '-c', batch.join('\n'), '-i', 'low'], {
        windowsHide: true,
        stdio: 'ignore',
        shell: false,
      });
      stats.spawns += 1;
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        done(false);
      }, icmTimeoutMs());
      // 注意：**不能** unref。unref 后若进程此时没别的活干，事件循环会直接排空，
      // 超时回调永远不跑 → 子进程不被 kill、批次的 Promise 永远 pending
      // （Ubuntu CI 上就是这么炸的：`Promise resolution is still pending but the
      // event loop has already resolved`）。5s 的上限本身可接受，让它保持进程存活。
      child.on('error', () => {
        clearTimeout(timer);
        done(false);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        done(code === 0);
      });
    } catch {
      done(false);
    }
  });
  return inFlight;
}

/** 退出路径用：带 5s 上限地等一次 flush，绝不拖延进程退出。 */
export async function flushTimelineOnExit(): Promise<void> {
  try {
    await Promise.race([flushTimeline(), new Promise<void>((r) => setTimeout(r, icmTimeoutMs()).unref?.())]);
  } catch {
    /* 退出不因记忆失败而失败 */
  }
}

/** 观测用（/stats、单测）。返回的是快照，调用方不能改内部状态。 */
export function icmTimelineStats(): IcmTimelineStats {
  return { ...stats, buffered: buffer.length };
}

/** 仅测试用：清空缓冲与计数。 */
export function __resetIcmTimelineForTest(): void {
  buffer = [];
  lastFlushAt = 0;
  inFlight = null;
  stats.buffered = 0;
  stats.batches = 0;
  stats.lines = 0;
  stats.spawns = 0;
  stats.dropped = 0;
  stats.skipped = 0;
  stats.lastFlushAt = null;
}
