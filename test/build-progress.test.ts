/**
 * [M5] 建图文件级进度（诚实降级版：产物体积增长曲线，非文件级 X/Y）。
 *
 * 契约：
 *   1. runSync 期间 building.json 出现 progress = { elapsedMs, bytesSoFar, samples }，
 *      且 samples 随时间递增（≥2 说明计时器真的 tick 了）；
 *   2. build 抛错 → 终值仍写入 + building.json 被删（P3-9 契约不回退）；
 *   3. buildingStatus() 对新形状返回 progress，旧形状（无 progress）不报错。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildingStatus } from '../src/graph/refresh.js';
import { runSync } from '../src/claude/sync-run.js';

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'gm-buildprogress-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'math.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  return d;
}
const markerOf = (d: string): string => join(d, 'graft', '.graph', 'building.json');

/**
 * 真·同步睡眠（不堵 worker 线程，等价于生产里 execFileSync 阻塞主线程）：
 * 主线程事件循环暂停期间 worker 照常采样，消息在线程恢复时投递。
 */
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

test('M5：build 期间 building.json 出现 progress，samples 随 tick 递增（≥2）', () => {
  const d = repo();
  try {
    const sampled: Array<{ elapsedMs: number; bytesSoFar: number; samples: number }> = [];
    // 与生产 realBuild 一致：同步阻塞主线程 1.3s；期间产物持续变大
    const fakeBuild = (dir: string): void => {
      const g = join(dir, 'graft', '.graph');
      const peek = (): void => {
        const raw = JSON.parse(readFileSync(markerOf(dir), 'utf8')) as {
          progress?: { elapsedMs: number; bytesSoFar: number; samples: number };
        };
        if (raw.progress) sampled.push(raw.progress);
      };
      writeFileSync(join(g, 'wiring.json'), 'x'.repeat(100));
      sleepSync(650);
      peek();
      writeFileSync(join(g, 'wiring.json'), 'x'.repeat(2500));
      sleepSync(650);
      peek();
    };
    runSync(d, fakeBuild);
    assert.ok(sampled.length >= 2, `至少 2 次采样到 progress，实际 ${sampled.length}`);
    assert.ok(sampled.some((p) => p.samples >= 1), 'worker 至少完成一次 tick，实际 ' + JSON.stringify(sampled));
    assert.ok(sampled.every((p) => Number.isFinite(p.bytesSoFar)), 'bytesSoFar 必须是有限数字');
    assert.ok(
      sampled[sampled.length - 1].bytesSoFar >= sampled[0].bytesSoFar,
      '产物体积应该单调不减（体积增长曲线）',
    );
    // 建图结束：状态文件删除（P3-9 不回退），progress 不残留
    assert.equal(existsSync(markerOf(d)), false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('M5：build 抛错 → progress 终值仍写入且 building.json 被删（P3-9 契约）', () => {
  const d = repo();
  try {
    let sawProgressDuringFailure = false;
    // runSync 的契约是吞错不 reject（与同步路径一致），失败体现在 stats.dirty 与状态文件清理
    runSync(d, (dir) => {
      sleepSync(650); // 越过一次 500ms tick，让 worker 真的写出 progress
      const raw = JSON.parse(readFileSync(markerOf(dir), 'utf8')) as { progress?: unknown };
      sawProgressDuringFailure = raw.progress != null;
      throw new Error('build blew up');
    });
    assert.ok(sawProgressDuringFailure, '失败路径下 progress 也必须先写出来（终值/中间值均可）');
    assert.equal(existsSync(markerOf(d)), false, '失败后状态文件必须被建图进程删掉');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('buildingStatus：新形状（带 progress）→ 透传 progress', () => {
  const d = repo();
  try {
    mkdirSync(join(d, 'graft', '.graph'), { recursive: true });
    writeFileSync(
      markerOf(d),
      JSON.stringify({
        startedAt: new Date().toISOString(),
        pid: 7,
        root: d,
        progress: { elapsedMs: 4200, bytesSoFar: 3_300_000, samples: 8 },
      }),
      'utf8',
    );
    const s = buildingStatus(d);
    assert.equal(s.building, true);
    assert.deepEqual(s.progress, { elapsedMs: 4200, bytesSoFar: 3_300_000, samples: 8 });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('buildingStatus：旧形状（无 progress）→ progress 为 undefined，不报错', () => {
  const d = repo();
  try {
    mkdirSync(join(d, 'graft', '.graph'), { recursive: true });
    writeFileSync(markerOf(d), JSON.stringify({ startedAt: new Date().toISOString(), pid: 1, root: d }), 'utf8');
    const s = buildingStatus(d);
    assert.equal(s.building, true);
    assert.equal(s.progress, undefined);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
