/**
 * 联邦后端健壮性（N6：P2-2 握手后摘监听器 / P2-3 探针 TTL / P2-4 stdout 8MB 上限
 * / P3-7 会话按 cwd 分桶）。
 *
 * 全部用假 child（EventEmitter）与假时钟替代外部边界，不起任何真实后端进程——
 * 这样"监听器到底摘没摘""8MB 到底 kill 没 kill"能被直接断言，而不是靠感觉。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import {
  callFederatedTool,
  runCli,
  appendCapped,
  availableFederatedTools,
  onBackendsChanged,
  resetFedStateForTest,
  setFedClock,
  setFedGnxHandshakeTimeout,
  setFedProbe,
  setFedSpawn,
  startFedProbeWatch,
  FED_MAX_OUT,
  FED_OUT_OVERFLOW,
} from "../src/mcp/federation.js";

/** 一个假子进程：stdout/stderr 是 EventEmitter，stdin.write 交给测试的 handler。 */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin: { write(s: string): void } = { write: () => {} };
  killed: string[] = [];
  /** 这个 child 收到的每一行 stdin（按到达顺序）。 */
  written: string[] = [];
  cwd: string | undefined;
  handler: (line: string) => void = () => {};

  constructor(cwd?: string) {
    super();
    this.cwd = cwd;
    this.stdin = {
      write: (s: string) => {
        this.written.push(s);
        this.handler(s);
      },
    };
  }

  kill(sig?: string): boolean {
    this.killed.push(sig ?? 'SIGTERM');
    return true;
  }

  /** 假装子进程回了某个 JSON-RPC 消息（下一 tick 到，模拟异步 pipe）。 */
  reply(msg: unknown): void {
    setTimeout(() => this.stdout.emit('data', Buffer.from(JSON.stringify(msg) + '\n')), 0);
  }

  /** 这个 child 收到的 tools/call query 列表。 */
  queries(): string[] {
    const out: string[] = [];
    for (const line of this.written) {
      try {
        const m = JSON.parse(line);
        if (m.method === 'tools/call') out.push(String(m.params?.arguments?.query));
      } catch {/* 非 JSON 行忽略 */}
    }
    return out;
  }
}

/** 一个"听话的" gitnexus MCP：握手答 id 0，tools/call 原样回显 query。 */
function behaving(child: FakeChild): FakeChild {
  child.handler = (line: string) => {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.method === 'initialize') child.reply({ jsonrpc: '2.0', id: 0, result: { protocolVersion: '2024-11-05' } });
    if (m.method === 'tools/call') {
      child.reply({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `answer:${m.params?.arguments?.query}` }] } });
    }
  };
  return child;
}

/** 装上假 spawn，返回造出来的 children（按创建顺序）。 */
function installFakeSpawn(factory: (cwd?: string) => FakeChild): { children: FakeChild[] } {
  const children: FakeChild[] = [];
  const fake = (file: string, argv: readonly string[], opts?: { cwd?: string }) => {
    void file;
    void argv;
    const c = factory(opts?.cwd);
    children.push(c);
    return c;
  };
  setFedSpawn(fake as unknown as typeof spawn);
  return { children };
}

async function waitUntil(cond: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------
// P2-2 握手后摘监听器
// ---------------------------------------------------------------------------

test('P2-2 握手完成后 stdout 上没有残留 data 监听器，会话期只留临时监听器', async () => {
  resetFedStateForTest();
  const { children } = installFakeSpawn((cwd) => behaving(new FakeChild(cwd)));

  const r = await callFederatedTool('max_trace_arch', { query: 'hello' }, '/repo-a');
  assert.deepEqual(r, { text: 'answer:hello', isError: false });
  assert.equal(children.length, 1);

  const child = children[0];
  assert.equal(child.stdout.listenerCount('data'), 0, '握手 + 一次调用之后不该有任何常驻 data 监听器');

  // 会话还活着：再来一块没人要的数据，既不该被吞进缓冲，也不该挂回监听器
  child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":999,"result":{}}\n'));
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.deepEqual(child.killed, [], '会话健康时不该被杀');
});

test('P2-2 一次握手把整段缓冲清空：连续多次调用不会重解析历史行', async () => {
  resetFedStateForTest();
  const { children } = installFakeSpawn((cwd) => behaving(new FakeChild(cwd)));

  for (const q of ['q1', 'q2', 'q3']) {
    const r = await callFederatedTool('max_trace_arch', { query: q }, '/repo-b');
    assert.deepEqual(r, { text: `answer:${q}`, isError: false });
  }
  const child = children[0];
  assert.equal(children.length, 1, '同一 cwd 只该有一个会话');
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.deepEqual(child.queries(), ['q1', 'q2', 'q3']);
});

// ---------------------------------------------------------------------------
// P3-7 会话按 cwd 分桶
// ---------------------------------------------------------------------------

test('P3-7 两个 root 各起一个会话，问题不会串仓', async () => {
  resetFedStateForTest();
  const { children } = installFakeSpawn((cwd) => behaving(new FakeChild(cwd)));

  const a = await callFederatedTool('max_trace_arch', { query: 'ask-A' }, '/repo-a');
  const b = await callFederatedTool('max_trace_arch', { query: 'ask-B' }, '/repo-b');

  assert.deepEqual(a, { text: 'answer:ask-A', isError: false });
  assert.deepEqual(b, { text: 'answer:ask-B', isError: false });
  assert.equal(children.length, 2, '两个 cwd 必须各起一个 gitnexus 会话');
  assert.deepEqual(children.map((c) => c.cwd), ['/repo-a', '/repo-b']);
  assert.deepEqual(children[0].queries(), ['ask-A']);
  assert.deepEqual(children[1].queries(), ['ask-B']);
});

// ---------------------------------------------------------------------------
// P2-3 探针 TTL + 上线通知
// ---------------------------------------------------------------------------

test('P2-3 探针失败 30s 内不重试，31s 后重试；可用后 5 分钟内不再探', async () => {
  resetFedStateForTest();
  let now = 1_000_000;
  setFedClock(() => now);

  let calls = 0;
  const perCmd: Record<string, number> = { qmd: 0, gitnexus: 0 };
  let upgrade = false;
  // 只让 gitnexus 变可用，qmd 一直不可用 → 通知只该发一次
  setFedProbe(async (cmd: string) => {
    calls++;
    perCmd[cmd] = (perCmd[cmd] ?? 0) + 1;
    return cmd === 'gitnexus' ? upgrade : false;
  });

  let announced = 0;
  const off = onBackendsChanged(() => announced++);
  onBackendsChanged(() => {
    throw new Error('a broken listener must not break the probe');
  });

  const hasArch = (ts: { name: string }[]) => ts.some((t) => t.name === 'max_trace_arch');

  // 第一次：失败，工具不出现
  assert.equal(hasArch(await availableFederatedTools('')), false);
  assert.equal(calls, 2, 'qmd + gitnexus 各探一次');
  assert.equal(announced, 0, '首次探测不是"变可用"，不该发通知');

  // 立刻再问：仍在 30s 失败 TTL 内，不再 spawn
  assert.equal(hasArch(await availableFederatedTools('')), false);
  assert.equal(calls, 2, '失败态 30s 内必须吃缓存');

  // 推进 31s：允许重试，且这次 gitnexus 装上了
  now += 31_000;
  upgrade = true;
  assert.equal(hasArch(await availableFederatedTools('')), true);
  assert.deepEqual(perCmd, { qmd: 2, gitnexus: 2 }, 'TTL 过期后必须重新探测');
  assert.equal(announced, 1, '不可用 → 可用必须发一次 tools/list 变更通知');

  // 成功态 TTL 5 分钟：gitnexus 299s 内不再探（qmd 仍是失败态，按 30s TTL 重探）
  now += 299_000;
  await availableFederatedTools('');
  assert.equal(perCmd.gitnexus, 2, '成功态 5 分钟内不该反复 spawn 探针');
  assert.equal(perCmd.qmd, 3, '失败态继续按 30s 重试');
  // 过了 5 分钟：重探（仍可用，所以不发通知）
  now += 2_000;
  await availableFederatedTools('');
  assert.equal(perCmd.gitnexus, 3, '超过 5 分钟必须重探');
  assert.equal(announced, 1, '可用 → 可用不该发通知');

  off();
});

test('P2-3 探针心跳：中途装上后端会被自动发现并通知（心跳是 opt-in）', async () => {
  resetFedStateForTest();
  let now = 1_000_000;
  setFedClock(() => now);
  // 每拍把假时钟推过失败 TTL，模拟"心跳一轮又一轮"
  let probes = 0;
  let upgrade = false;
  setFedProbe(async (cmd: string) => {
    probes++;
    now += 31_000;
    return cmd === 'gitnexus' && upgrade;
  });
  let announced = 0;
  onBackendsChanged(() => announced++);

  const stop = startFedProbeWatch(10);
  await waitUntil(() => probes >= 3, 2_000);
  assert.equal(announced, 0, '后端还没装上，不该有通知');

  upgrade = true;
  await waitUntil(() => announced === 1, 2_000);
  assert.equal(announced, 1, '心跳发现"不可用 → 可用"必须通知一次');

  stop();
  await new Promise((r) => setTimeout(r, 30)); // 让在飞的那一拍落地
  const settled = probes;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(probes, settled, 'stop 之后不该再有探针');
  resetFedStateForTest();
});

// ---------------------------------------------------------------------------
// P2-4 stdout 上限
// ---------------------------------------------------------------------------

test('appendCapped 纯函数：超限截断并报告溢出', () => {
  assert.deepEqual(appendCapped('a', 'b', 4), { buf: 'ab', overflow: false });
  assert.deepEqual(appendCapped('abc', 'def', 4), { buf: 'abcd', overflow: true });
  assert.deepEqual(appendCapped('abcd', 'x', 4), { buf: 'abcd', overflow: true });
});

test('P2-4 runCli 收到 >8MB stdout：kill 子进程 + 软错误（不 throw）', async () => {
  resetFedStateForTest();
  const { children } = installFakeSpawn(() => new FakeChild());

  const pending = runCli('fake-backend', ['x'], 5_000);
  const child = children[0];
  child.stdout.emit('data', Buffer.alloc(FED_MAX_OUT + 1024 * 1024, 0x61));
  const r = await pending;

  assert.equal(r.ok, false);
  assert.equal(r.overflow, true);
  assert.equal(r.err, FED_OUT_OVERFLOW);
  assert.equal(r.out, '', '超限时不该把 8MB 再往外传');
  assert.deepEqual(child.killed, ['SIGKILL'], '超限必须立刻杀掉子进程');
});

test('runCli 超时走软错误，绝不 reject', async () => {
  resetFedStateForTest();
  const { children } = installFakeSpawn(() => new FakeChild());

  const r = await runCli('fake-backend', [], 40);
  assert.equal(r.ok, false);
  assert.match(r.err, /timed out after 40ms/);
  assert.deepEqual(children[0].killed, ['SIGKILL']);
});

test('spawn 直接抛错也是软错误（永不 throw）', async () => {
  resetFedStateForTest();
  setFedSpawn((() => {
    throw new Error('spawn kaboom');
  }) as unknown as typeof spawn);

  const r = await runCli('fake-backend', [], 1_000);
  assert.equal(r.ok, false);
  assert.match(r.err, /spawn kaboom/);
});

test('P2-4 one-shot gitnexus 也受 8MB 上限保护（会话起不来时的降级路径）', async () => {
  resetFedStateForTest();
  const { children } = installFakeSpawn(() => new FakeChild()); // 全静默：握手必失败
  setFedGnxHandshakeTimeout(30);

  const pending = callFederatedTool('max_trace_arch', { query: 'overflow-me' }, '/repo-x');
  await waitUntil(() => children.length >= 2, 2_000);
  const oneShot = children[1];
  oneShot.stdout.emit('data', Buffer.alloc(FED_MAX_OUT + 1024 * 1024, 0x62));
  const r = await pending;

  assert.deepEqual(r, { text: FED_OUT_OVERFLOW, isError: true });
  assert.ok(oneShot.killed.includes('SIGKILL'), 'one-shot 超限也要 kill');
  assert.equal(children[0].killed.includes('SIGKILL'), true, '握手失败的会话子进程要收尸');
});

test('会话握手失败 + one-shot 失败时整体仍是软错误', async () => {
  resetFedStateForTest();
  const { children } = installFakeSpawn(() => new FakeChild());
  setFedGnxHandshakeTimeout(30);

  const pending = callFederatedTool('max_trace_arch', { query: 'nobody-home' }, '/repo-y');
  await waitUntil(() => children.length >= 2, 2_000);
  // one-shot 子进程什么都不说就关闭
  setTimeout(() => children[1].emit('close', 1), 5);
  const r = await pending;

  assert.equal(r?.isError, true);
  assert.match(r?.text ?? '', /gitnexus/i);
});
