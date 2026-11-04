/**
 * [graft-Max N13] 冷启动体验：首查不再黑屏 90 秒。
 *
 * 三条契约：
 *   1. 默认等待窗口 20s（可用 GRAFT_MAX_FIRST_BUILD_WAIT_MS 覆盖），不是 90s；
 *   2. 等待超时后返回的 note 说明"还在建、建了多久、怎么重试"，而不是空话；
 *   3. building.json 由**建图进程**写和删（P3-9）：等待者不碰它，面板看到的
 *      "建图中"就是真实的执行状态；残留超过硬超时自动判陈旧。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildingStatus, ensureFreshGraph } from '../src/graph/refresh.js';
import { runSync } from '../src/claude/sync-run.js';

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'gm-firstbuild-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'math.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  return d;
}
function trailRepo(): string {
  const d = repo();
  mkdirSync(join(d, '.trail', 'learnings'), { recursive: true });
  return d;
}
const markerOf = (d: string, layout: 'graft' | 'trail' = 'graft'): string =>
  layout === 'trail' ? join(d, '.trail', 'cache', '.graph', 'building.json') : join(d, 'graft', '.graph', 'building.json');

/** 站在 claude/sync-run.js 的位置：记下 argv，按住锁一段时间再放。 */
function holdStub(d: string, holdMs: number): () => void {
  const stub = join(d, 'first-build-stub.mjs');
  writeFileSync(
    stub,
    `import { rmSync } from "node:fs";
import { join } from "node:path";
const [dir] = process.argv.slice(2);
const out = join(dir, ".trail", "cache");
setTimeout(() => rmSync(join(out, ".cache", ".sync.lock"), { force: true }), ${holdMs});
`,
  );
  process.env.GRAFT_TEST_SYNC_RUN = stub;
  return () => { delete process.env.GRAFT_TEST_SYNC_RUN; };
}

test('buildingStatus：没有状态文件 → 不在建图', () => {
  const d = repo();
  try {
    const s = buildingStatus(d);
    assert.equal(s.building, false);
    assert.equal(s.root, d);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('buildingStatus：新鲜状态文件 → 建图中，带已耗时与 pid', () => {
  const d = repo();
  try {
    mkdirSync(join(d, 'graft', '.graph'), { recursive: true });
    const startedAt = new Date(Date.now() - 3_000).toISOString();
    writeFileSync(markerOf(d), JSON.stringify({ startedAt, pid: 4242, root: d }), 'utf8');
    const s = buildingStatus(d);
    assert.equal(s.building, true);
    assert.equal(s.pid, 4242);
    assert.ok((s.elapsedMs ?? 0) >= 2_000 && (s.elapsedMs ?? 0) < 60_000, `elapsedMs≈3s，实际 ${s.elapsedMs}`);
    assert.equal(s.stale, false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('buildingStatus：状态文件超过建图硬超时 → 判陈旧，不算建图中（不留永久假象）', () => {
  const d = repo();
  try {
    mkdirSync(join(d, 'graft', '.graph'), { recursive: true });
    const startedAt = new Date(Date.now() - 12 * 60_000).toISOString(); // 12 分钟 > 10min+60s
    writeFileSync(markerOf(d), JSON.stringify({ startedAt, pid: 1, root: d }), 'utf8');
    const s = buildingStatus(d);
    assert.equal(s.stale, true);
    assert.equal(s.building, false, '陈旧状态不得让面板永远显示"建图中"');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('P3-9：建图进程写状态 → 建图期间存在 → 结束即删除', () => {
  const d = repo();
  try {
    let seenDuringBuild: string | null = null;
    runSync(d, (dir) => {
      const p = markerOf(dir);
      seenDuringBuild = existsSync(p) ? readFileSync(p, 'utf8') : null;
    });
    assert.ok(seenDuringBuild, '建图进行中必须有 building.json（面板才有东西可显示）');
    assert.match(seenDuringBuild as unknown as string, /startedAt/);
    assert.equal(existsSync(markerOf(d)), false, '建图结束必须由建图进程自己删掉状态文件');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('P3-9：建图抛错也要删状态文件（不能留下永远"建图中"）', () => {
  const d = repo();
  try {
    runSync(d, () => {
      throw new Error('build blew up');
    });
    assert.equal(existsSync(markerOf(d)), false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('N13：GRAFT_MAX_FIRST_BUILD_WAIT_MS 生效，超时立刻返回并说清"还在建、建了多久、怎么重试"', async () => {
  const d = trailRepo();
  const restore = holdStub(d, 3_000);
  process.env.GRAFT_MAX_FIRST_BUILD_WAIT_MS = '300';
  try {
    const started = Date.now();
    const r = await ensureFreshGraph(d);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2_000, `等待窗口必须是 300ms 级，实测 ${elapsed}ms`);
    const note = r.note ?? '';
    assert.match(note, /building one in the background/, '必须说明在后台建图');
    assert.match(note, /still running after \d+s/, '必须给出已建了多久');
    assert.match(note, /run the same query again/, '必须给出可执行的重试指引');
  } finally {
    delete process.env.GRAFT_MAX_FIRST_BUILD_WAIT_MS;
    restore();
    await new Promise((r) => setTimeout(r, 3_200)); // 让 stub 自己放锁，避免影响其它用例
    rmSync(d, { recursive: true, force: true });
  }
});
