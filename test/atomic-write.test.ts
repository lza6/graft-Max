/**
 * [graft-Max][N2] `src/util/atomic-write.ts` 的回归网。
 *
 * 这些用例守的是那条血的事故（~/.claude.json 246KB → 852B）：任何一次写入失败都
 * 不能让目标文件变成半截，任何一次正常写入都要留下上一版。全部用 mkdtemp 假目录，
 * 绝不碰真实的 ~/.claude / ~/.claude.json。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, atomicWriteSync } from '../src/util/atomic-write.js';

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'gm-aw-'));
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } });

const WIN = process.platform === 'win32';

/** 目录里遗留的 tmp 文件（任何失败的写入都不许留）。 */
function leftoverTmp(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.tmp'));
}

test('正常写入 → 内容正确；再写一次 → .bak 存在且是第一版', () => {
  const dir = scratch();
  const path = join(dir, 'note.md');
  atomicWriteSync(path, 'version-1\n');
  assert.equal(readFileSync(path, 'utf8'), 'version-1\n');
  assert.equal(existsSync(`${path}.bak`), false, '首写没有上一版，不该生成 .bak');

  atomicWriteSync(path, 'version-2\n');
  assert.equal(readFileSync(path, 'utf8'), 'version-2\n');
  assert.equal(readFileSync(`${path}.bak`, 'utf8'), 'version-1\n');
  assert.equal(existsSync(`${path}.bak.1`), false, '两代还不够，不该出现 .bak.1');
  assert.deepEqual(leftoverTmp(dir), [], '不允许遗留 tmp 文件');
});

test('backup:false → 不留任何 .bak', () => {
  const dir = scratch();
  const path = join(dir, 'nobak.txt');
  atomicWriteSync(path, 'a', { backup: false });
  atomicWriteSync(path, 'b', { backup: false });
  assert.equal(readFileSync(path, 'utf8'), 'b');
  assert.deepEqual(readdirSync(dir).sort(), ['nobak.txt']);
});

test('validateJson:true + 非法 JSON → throw 且原文件字节不变', () => {
  const dir = scratch();
  const path = join(dir, 'cfg.json');
  const original = '{\n  "keep": true\n}\n';
  atomicWriteSync(path, original, { validateJson: true });
  const before = readFileSync(path);

  assert.throws(
    () => atomicWriteSync(path, '{ "broken": ', { validateJson: true }),
    /refusing to write invalid JSON to/,
  );
  assert.deepEqual(readFileSync(path), before, '字节必须一模一样');
  assert.deepEqual(leftoverTmp(dir), []);
  // 校验在写之前：连 .bak 都不该被这张坏内容动过
  assert.equal(existsSync(`${path}.bak`), false);
});

test('写入失败 → throw、原文件字节不变、tmp 被清理', () => {
  const dir = scratch();
  const path = join(dir, 'cfg.json');
  const original = '{"v":1}\n';
  atomicWriteSync(path, original, { backup: false });
  const before = readFileSync(path);

  // 让落盘必然失败：Windows 上 rename 覆盖只读文件会被拒绝（EPERM）；
  // POSIX 上把目录改成只读，tmp 文件根本创建不出来（EACCES）。
  const restore = WIN
    ? () => chmodSync(path, 0o666)
    : () => chmodSync(dir, 0o700);
  if (WIN) chmodSync(path, 0o444); else chmodSync(dir, 0o500);

  let error: unknown;
  try {
    atomicWriteSync(path, '{"v":2}\n', { backup: false });
  } catch (e) {
    error = e;
  } finally {
    try { restore(); } catch { /* ignore */ }
  }

  if (error === undefined) {
    // POSIX 特权环境（例如 root）能绕过权限位：这条模拟在此环境不可用，不假装通过。
    // Windows 上 rename 覆盖只读文件必然 EPERM，走不到这里。
    assert.ok(!WIN, 'Windows 上 rename 覆盖只读文件必须失败，这条模拟不该静默通过');
    return;
  }
  assert.ok(error instanceof Error);
  assert.deepEqual(readFileSync(path), before, '失败后原文件必须一字节不动');
  assert.deepEqual(leftoverTmp(dir), [], '失败路径必须删掉 tmp');
});

test('.bak 轮转：连写 5 次 → .bak/.bak.1/.bak.2 存在且不产生 .bak.3', () => {
  const dir = scratch();
  const path = join(dir, 'rotate.txt');
  for (let i = 1; i <= 5; i++) atomicWriteSync(path, `v${i}`);
  assert.equal(readFileSync(path, 'utf8'), 'v5');
  assert.equal(readFileSync(`${path}.bak`, 'utf8'), 'v4', '.bak 永远是上一版');
  assert.equal(readFileSync(`${path}.bak.1`, 'utf8'), 'v3');
  assert.equal(readFileSync(`${path}.bak.2`, 'utf8'), 'v2', '.bak.2 是最老的一代保留');
  assert.equal(existsSync(`${path}.bak.3`), false, '绝不产生第 4 代');
});

test('幂等：同一内容连写 3 次 → 字节与行数都不变', () => {
  const dir = scratch();
  const path = join(dir, 'same.md');
  const body = 'line-1\nline-2\nline-3\n';
  for (let i = 0; i < 3; i++) atomicWriteSync(path, body);
  assert.equal(readFileSync(path, 'utf8'), body);
  assert.equal(readFileSync(path, 'utf8').split('\n').length, body.split('\n').length);
  assert.equal(readFileSync(`${path}.bak`, 'utf8'), body);
});

test('atomicWrite（异步版）同样原子：内容 + .bak + validateJson', async () => {
  const dir = scratch();
  const path = join(dir, 'async.json');
  await atomicWrite(path, '{"a":1}\n', { validateJson: true });
  await atomicWrite(path, '{"a":2}\n', { validateJson: true });
  assert.equal(readFileSync(path, 'utf8'), '{"a":2}\n');
  assert.equal(readFileSync(`${path}.bak`, 'utf8'), '{"a":1}\n');
  await assert.rejects(
    () => atomicWrite(path, 'not json', { validateJson: true }),
    /refusing to write invalid JSON to/,
  );
  assert.equal(readFileSync(path, 'utf8'), '{"a":2}\n');
  assert.deepEqual(leftoverTmp(dir), []);
});

test('目标在一张不存在的子目录下 → 自动 mkdir -p（不再依赖调用方）', () => {
  const dir = scratch();
  const path = join(dir, 'a', 'b', 'c', 'cfg.json');
  atomicWriteSync(path, '{"nested":true}\n', { validateJson: true });
  assert.equal(readFileSync(path, 'utf8'), '{"nested":true}\n');
});
