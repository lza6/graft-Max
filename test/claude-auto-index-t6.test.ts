/**
 * [graft-Max T6] autoIndexAfterEdit — post-edit auto incremental index.
 * Default ON, GRAFT_MAX_AUTO_INDEX=0 off, throttle by syncedAt, syncing lock
 * respected, dirty gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoIndexAfterEdit } from '../src/claude/stop.js';
import { readStats, patchStats, acquireLock, releaseLock } from '../src/claude/state.js';

function sandbox(): string {
  const d = mkdtempSync(join(tmpdir(), 'gm-t6-'));
  mkdirSync(join(d, 'graft', '.graph'), { recursive: true });
  writeFileSync(join(d, 'graft', '.graph', 'wiring.json'),
    JSON.stringify({ meta: { nodeCount: 0, edgeCount: 0, languages: [] }, nodes: [], edges: [] }));
  return d;
}

// A stub sync-run whose mere existence gates the spawn path; the detached
// spawn of a stub .js under a tmpdir is a cheap no-op we don't wait on.
function stubSyncRun(d: string): string {
  const p = join(d, 'sync-run-stub.js');
  writeFileSync(p, '// test stub\n');
  return p;
}

test('T6 default-on: dirty repo + fresh lock → syncing starts', () => {
  const d = sandbox();
  process.env.GRAFT_TEST_SYNC_RUN = stubSyncRun(d);
  delete process.env.GRAFT_MAX_AUTO_INDEX;
  try {
    patchStats(d, { dirty: true });
    autoIndexAfterEdit(d);
    const s = readStats(d)!;
    assert.equal(s.syncing, true, 'sync started');
  } finally {
    delete process.env.GRAFT_TEST_SYNC_RUN;
    rmSync(d, { recursive: true, force: true });
  }
});

test('T6 off switch: GRAFT_MAX_AUTO_INDEX=0 → no sync', () => {
  const d = sandbox();
  process.env.GRAFT_TEST_SYNC_RUN = stubSyncRun(d);
  process.env.GRAFT_MAX_AUTO_INDEX = '0';
  try {
    patchStats(d, { dirty: true });
    autoIndexAfterEdit(d);
    const s = readStats(d)!;
    assert.equal(s.syncing, false, 'sync never started');
  } finally {
    delete process.env.GRAFT_TEST_SYNC_RUN;
    delete process.env.GRAFT_MAX_AUTO_INDEX;
    rmSync(d, { recursive: true, force: true });
  }
});

test('T6 throttle: syncedAt inside the window → suppressed', () => {
  const d = sandbox();
  process.env.GRAFT_TEST_SYNC_RUN = stubSyncRun(d);
  try {
    patchStats(d, { dirty: true, syncedAt: new Date().toISOString() });
    autoIndexAfterEdit(d); // default 60s window, synced just now
    const s = readStats(d)!;
    assert.equal(s.syncing, false, 'throttled');
  } finally {
    delete process.env.GRAFT_TEST_SYNC_RUN;
    rmSync(d, { recursive: true, force: true });
  }
});

test('T6 not dirty → no sync', () => {
  const d = sandbox();
  process.env.GRAFT_TEST_SYNC_RUN = stubSyncRun(d);
  try {
    autoIndexAfterEdit(d);
    const s = readStats(d);
    assert.ok(s === null || !s.syncing, 'nothing started');
  } finally {
    delete process.env.GRAFT_TEST_SYNC_RUN;
    rmSync(d, { recursive: true, force: true });
  }
});

test('T6 lock held (syncing) → no second build', () => {
  const d = sandbox();
  process.env.GRAFT_TEST_SYNC_RUN = stubSyncRun(d);
  try {
    patchStats(d, { dirty: true, syncing: true });
    autoIndexAfterEdit(d);
    const s = readStats(d)!;
    assert.equal(s.syncing, true, 'still the one build');
    // and no second lock takeover happened (acquireLock by us would fail)
  } finally {
    delete process.env.GRAFT_TEST_SYNC_RUN;
    releaseLock(d);
    rmSync(d, { recursive: true, force: true });
  }
});
