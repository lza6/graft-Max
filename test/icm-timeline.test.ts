/**
 * [graft-Max N3] ICM 时序批量化：JSONL 先落地 / 满 32 行或 60s 才 spawn 一次 /
 * 5s 硬超时 / 并发 1 / 失败静默丢批次。
 *
 * 关键契约（P1-2 的验收）：**连续 N 次工具调用只产生 1 个 icm 子进程**，且
 * 即使 icm 不存在，本地 JSONL 也有完整 N 行 —— 数据不丢、热路径不遭罪。
 *
 * 默认 GRAFT_MAX_ICM=2（干跑：只计数不 spawn），需要断言 spawn 参数时用
 * `__setIcmSpawnForTest` 注入假 spawn。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'gm-icm-'));
process.env.USERPROFILE = home;
process.env.HOME = home;
mkdirSync(join(home, '.graft-max'), { recursive: true });
process.env.GRAFT_MAX_ICM = '2';
delete process.env.GRAFT_TEST;
delete process.env.GRAFT_MAX_ICM_TIMEOUT_MS;

const icm = await import('../src/mcp/icm-timeline.js');
const { recordTimeline, flushTimeline, icmTimelineStats, timelinePath, __resetIcmTimelineForTest, __setIcmSpawnForTest } = icm;

const jsonlLines = (): string[] => {
  const p = timelinePath();
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean);
};

interface FakeChild extends EventEmitter {
  kill: () => void;
  killed: boolean;
}
function fakeChild(): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.killed = false;
  c.kill = () => {
    c.killed = true;
    c.emit('exit', null);
  };
  return c;
}

test('每行都进本地 JSONL；未满批不 spawn', () => {
  __resetIcmTimelineForTest();
  process.env.GRAFT_MAX_ICM = '2';
  for (let i = 0; i < 10; i++) recordTimeline('max_find_code', { query: `q${i}` }, 12, false);
  assert.equal(jsonlLines().length, 10, '10 次调用 → JSONL 10 行（后端挂了也不丢）');
  const s = icmTimelineStats();
  assert.equal(s.lines, 10);
  assert.equal(s.buffered, 10, '还没到 32 行，缓冲着');
  assert.equal(s.spawns, 0, '未满批不得 spawn');
});

test('flush 把整批合成 1 次提交（不是 N 次）', async () => {
  __resetIcmTimelineForTest();
  for (let i = 0; i < 5; i++) recordTimeline('max_trace_arch', { module: 'src/mcp' }, 30, false);
  await flushTimeline();
  const s = icmTimelineStats();
  assert.equal(s.buffered, 0, 'flush 后缓冲清空');
  assert.equal(s.batches, 1, '5 次调用 → 1 批');
  assert.equal(s.spawns, 0, '干跑模式不 spawn');
});

test('满 32 行自动触发 flush', () => {
  __resetIcmTimelineForTest();
  for (let i = 0; i < 32; i++) recordTimeline('graft_find_code', { q: i }, 5, false);
  const s = icmTimelineStats();
  assert.equal(s.buffered, 0, '到阈值立刻 flush');
  assert.ok(s.batches >= 1, '至少提交了一批');
});

test('GRAFT_MAX_ICM=0 一键关闭：不写 JSONL、不 spawn', () => {
  __resetIcmTimelineForTest();
  const before = jsonlLines().length;
  process.env.GRAFT_MAX_ICM = '0';
  recordTimeline('graft_find_all', { pattern: 'x' }, 3, false);
  assert.equal(jsonlLines().length, before, '关闭后不得写盘');
  assert.equal(icmTimelineStats().buffered, 0);
  process.env.GRAFT_MAX_ICM = '2';
});

test('真实 spawn 路径：参数正确（store -t tool-timeline -c <批量>），成功计 1 批', async () => {
  __resetIcmTimelineForTest();
  process.env.GRAFT_MAX_ICM = '1';
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const kids: FakeChild[] = [];
  __setIcmSpawnForTest(((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const c = fakeChild();
    kids.push(c);
    setImmediate(() => c.emit('exit', 0));
    return c as unknown as ReturnType<typeof import('node:child_process').spawn>;
  }) as unknown as typeof import('node:child_process').spawn);
  try {
    recordTimeline('max_find_docs', { query: 'atomic write' }, 7, false);
    recordTimeline('max_find_docs', { query: 'rename' }, 9, true);
    await flushTimeline();
    assert.equal(calls.length, 1, '两条缓冲 → 只起 1 个进程');
    assert.equal(calls[0].cmd, 'icm.exe');
    assert.deepEqual(calls[0].args.slice(0, 5), ['store', '-t', 'tool-timeline', '-c', calls[0].args[4]]);
    assert.match(calls[0].args[4], /max_find_docs 7ms isError=false/, '批量内容含第一条');
    assert.match(calls[0].args[4], /isError=true/, '批量内容含 isError 标记');
    const s = icmTimelineStats();
    assert.equal(s.spawns, 1);
    assert.equal(s.batches, 1);
    assert.equal(s.dropped, 0);
  } finally {
    __setIcmSpawnForTest(null);
    process.env.GRAFT_MAX_ICM = '2';
  }
});

test('子进程非 0 退出 → 记 dropped，不重试、不抛', async () => {
  __resetIcmTimelineForTest();
  process.env.GRAFT_MAX_ICM = '1';
  __setIcmSpawnForTest(((..._a: unknown[]) => {
    const c = fakeChild();
    setImmediate(() => c.emit('exit', 3));
    return c as unknown as ReturnType<typeof import('node:child_process').spawn>;
  }) as unknown as typeof import('node:child_process').spawn);
  try {
    recordTimeline('graft_trace_calls', {}, 1, false);
    await flushTimeline();
    const s = icmTimelineStats();
    assert.equal(s.dropped, 1);
    assert.equal(s.batches, 0);
    assert.equal(s.spawns, 1, '只试一次，不重试');
  } finally {
    __setIcmSpawnForTest(null);
    process.env.GRAFT_MAX_ICM = '2';
  }
});

test('spawn error（icm 不在 PATH）→ 静默丢批次', async () => {
  __resetIcmTimelineForTest();
  process.env.GRAFT_MAX_ICM = '1';
  __setIcmSpawnForTest(((..._a: unknown[]) => {
    const c = fakeChild();
    setImmediate(() => c.emit('error', new Error('ENOENT')));
    return c as unknown as ReturnType<typeof import('node:child_process').spawn>;
  }) as unknown as typeof import('node:child_process').spawn);
  try {
    recordTimeline('graft_repo_map', {}, 1, false);
    await flushTimeline();
    assert.equal(icmTimelineStats().dropped, 1);
  } finally {
    __setIcmSpawnForTest(null);
    process.env.GRAFT_MAX_ICM = '2';
  }
});

test('5s 硬超时（此处调到 40ms）：超时 kill 子进程并丢批次', async () => {
  __resetIcmTimelineForTest();
  process.env.GRAFT_MAX_ICM = '1';
  process.env.GRAFT_MAX_ICM_TIMEOUT_MS = '40';
  const kids: FakeChild[] = [];
  __setIcmSpawnForTest((() => {
    const c = fakeChild();
    kids.push(c);
    return c as unknown as ReturnType<typeof import('node:child_process').spawn>;
  }) as unknown as typeof import('node:child_process').spawn);
  try {
    recordTimeline('graft_file_api', {}, 1, false);
    await flushTimeline();
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(kids.length, 1);
    assert.equal(kids[0].killed, true, '超时必须 kill，不能挂着一个 3 秒顽固进程');
    assert.equal(icmTimelineStats().dropped, 1);
  } finally {
    __setIcmSpawnForTest(null);
    delete process.env.GRAFT_MAX_ICM_TIMEOUT_MS;
    process.env.GRAFT_MAX_ICM = '2';
  }
});

test('cleanup', () => {
  rmSync(home, { recursive: true, force: true });
});
