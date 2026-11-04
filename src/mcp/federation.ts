/**
 * graft-Max federation: sibling-tool proxies served through graft's own MCP
 * server, so an agent connects to ONE server and gets the whole local
 * toolchain. Part of the graft-Max aggregation plan (docs-selfdev/改造日志.md).
 *
 * Two proxied backends, both free-local, both CLIs we already ship:
 *   - qmd        → BM25 search over registered document collections
 *                  (notes/specs/READMEs — the "what did we write" half)
 *   - gitnexus   → architecture-level code graph queries
 *                  (dependencies/call chains/blast radius — the "what
 *                  breaks if I change this" half, complementary to graft's
 *                  symbol graph)
 *
 * Design rules, inherited from how this codebase thinks:
 *   - A proxy tool NEVER throws: every failure mode comes back as
 *     `{ text, isError: true }`, exactly like ./tools.ts. A missing backend
 *     binary is a soft error with the install command in the text, not a
 *     crash — the graft_* tools must keep working when a sibling is absent.
 *   - Hard timeouts on every child process. An MCP tool that hangs holds the
 *     agent's turn hostage; worse than a clean failure.
 *   - No stderr from the child leaks into the answer text. stdout only.
 *   - Registration is additive and self-contained: the graft vocabulary in
 *     ./tool-names.ts is untouched (isRepoTool() stays exact), so legacy
 *     aliases and trail_* names keep resolving as before.
 */
import { spawn } from 'node:child_process';
import { dlog, clip } from './devlog.js';
// [graft-Max T2] in-process qmd embed: SDK fast path, CLI spawn fallback.
import { qmdSearchInProcess, qmdEmbeddedAvailable, closeEmbeddedQmd } from './fed-qmd.js';

/** One proxied tool, in the shape ./tools.ts's ToolDef expects. */
export interface FederatedToolDef {
  name: string;
  description: string;
  inputSchema: object;
}

/** Kill switch + description metadata, checked at advertise time. */
interface Backend {
  /** Windows-safe availability probe: a bare `--version`-ish run. */
  probeCmd: [string, string[]];
  /** Human-facing fix when the probe fails. */
  installHint: string;
}

// [graft-Max T5] semantic search backend (fed-semantic.ts owns the runtime).
import { runSemanticSearch, SEMANTIC_TOOL, CCC_BACKEND, cccIndexed } from './fed-semantic.js';

const QMD: Backend = {
  probeCmd: ['qmd', ['--help']],
  installHint: 'install qmd: npm install -g @tobilu/qmd (then: qmd collection add <dir> --name <name> && qmd update)',
};

const GITNEXUS: Backend = {
  probeCmd: ['gitnexus', ['list']],
  installHint: 'install gitnexus: npm install -g gitnexus (then, per repo: npx gitnexus analyze)',
};

/** [N6 P2-4] stdout 上限：一个失控后端（或巨大的 `ccc --json` 结果集）能把 MCP
 * server 进程吃满内存——而 MCP server 是 agent 会话的生命线。超限即 kill，
 * 按软错误返回，绝不 throw。 */
export const FED_MAX_OUT = 8 * 1024 * 1024;
/** 超限软错误的固定文案（`err` / `text` 共用，调用点靠它判别）。 */
export const FED_OUT_OVERFLOW = '后端输出超过 8MB 上限，已中止';

/** 追加一块数据，超过 `max` 时截断并报告溢出（纯函数；单测直接覆盖）。 */
export function appendCapped(buf: string, chunk: string, max = FED_MAX_OUT): { buf: string; overflow: boolean } {
  const room = max - buf.length;
  if (chunk.length <= room) return { buf: buf + chunk, overflow: false };
  return { buf: buf + chunk.slice(0, Math.max(0, room)), overflow: true };
}

/** spawn 实现，测试可替换成假 child（见文件尾部的测试接缝）。 */
let spawnImpl: typeof spawn = spawn;

/** Run a CLI to completion; resolve stdout, never reject.
 * Windows note: npm-global CLIs are `.cmd` shims, which `spawn` cannot exec
 * without a shell. We resolve the real entry via `where`-style lookup: try the
 * bare name first (works where the shim is a real exe), then `cmd /c` as the
 * shim-aware fallback. */
export function runCli(cmd: string, args: string[], timeoutMs: number, cwd?: string): Promise<{ ok: boolean; out: string; err: string; overflow?: boolean }> {
  const attempt = (file: string, argv: string[], useShell: boolean) =>
    new Promise<{ ok: boolean; out: string; err: string; overflow?: boolean }>((resolve) => {
      let child;
      try {
        child = spawnImpl(file, argv, { cwd, windowsHide: true, shell: useShell });
      } catch (e) {
        resolve({ ok: false, out: '', err: e instanceof Error ? e.message : String(e) });
        return;
      }
      let out = '';
      let err = '';
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          child.kill('SIGKILL');
          resolve({ ok: false, out, err: `${cmd} timed out after ${timeoutMs}ms` });
        }
      }, timeoutMs);
      child.stdout?.on('data', (d: Buffer) => {
        if (done) return;
        const grown = appendCapped(out, d.toString());
        out = grown.buf;
        if (grown.overflow) {
          // 超限：立刻收工，不再等下一条数据（内存已经到顶了）。
          done = true;
          clearTimeout(timer);
          try {
            child.kill('SIGKILL');
          } catch {/* already gone */}
          resolve({ ok: false, out: '', err: FED_OUT_OVERFLOW, overflow: true });
        }
      });
      child.stderr?.on('data', (d: Buffer) => {
        err += d.toString();
      });
      child.on('error', (e: Error) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve({ ok: false, out, err: e.message });
        }
      });
      child.on('close', (code: number | null) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve({ ok: code === 0, out, err });
        }
      });
    });

  return (async () => {
    // 1) direct (works for real .exe entries)
    const direct = await attempt(cmd, args, false);
    if (direct.ok || !/ENOENT|not runnable/i.test(direct.err)) return direct;
    // 2) shell-resolved (finds .cmd shims on Windows; PATH is ours, not user-typed)
    return attempt(cmd, args, true);
  })();
}

/** "现在"的取用点。探针 TTL / 结果缓存 TTL / 会话负缓存都读它，测试可换成假时钟。 */
let fedClock: () => number = () => Date.now();

/** [N6 P2-3] 探针结果带 TTL：后端是可以在会话中途装上的（README 装完就该马上
 * 能用，而不是重启 MCP server 才看见工具）。成功 5 分钟——别为每次 tools/list
 * 反复 spawn；失败 30 秒——装好之后最迟半分钟就能被发现。 */
export const PROBE_OK_TTL_MS = 5 * 60_000;
export const PROBE_FAIL_TTL_MS = 30_000;

/** 探针缓存条目是否还在有效期内（纯函数，`now` 注入）。 */
export function probeFresh(e: { ok: boolean; at: number } | undefined, now: number): boolean {
  if (!e) return false;
  return now - e.at < (e.ok ? PROBE_OK_TTL_MS : PROBE_FAIL_TTL_MS);
}

const probeCache = new Map<Backend, { ok: boolean; at: number }>();

/** 后端"不可用 → 可用"的通知口。外层（server.ts）注册一个把
 * `KeptListing.refresh()` 打醒的回调，走 `notifications/tools/list_changed`。 */
type BackendsChangedCb = () => void;
const backendsChangedCbs = new Set<BackendsChangedCb>();

/** 注册"新后端上线"回调，返回注销函数。回调抛错只记日志，不影响探针。 */
export function onBackendsChanged(cb: BackendsChangedCb): () => void {
  backendsChangedCbs.add(cb);
  return () => {
    backendsChangedCbs.delete(cb);
  };
}

function announceBackendsChanged(): void {
  for (const cb of backendsChangedCbs) {
    try {
      cb();
    } catch (e) {
      dlog(`[fed] onBackendsChanged callback failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** 探针执行器（测试接缝：装上假探针就不用真 spawn）。 */
let probeRunner: ((cmd: string, args: string[]) => Promise<boolean>) | null = null;

async function backendAvailable(b: Backend): Promise<boolean> {
  const hit = probeCache.get(b);
  if (hit && probeFresh(hit, fedClock())) return hit.ok;
  const run = probeRunner ?? ((cmd: string, argv: string[]) => runCli(cmd, argv, 15_000).then((r) => r.ok));
  const ok = await run(b.probeCmd[0], b.probeCmd[1]);
  probeCache.set(b, { ok, at: fedClock() });
  // 只在"从不可用变成可用"时喊一嗓子：首次探测（没有前值）不喊，可用→可用也不喊。
  if (ok && hit && !hit.ok) {
    dlog('[fed] backend became available — announcing tools/list changed');
    announceBackendsChanged();
  }
  return ok;
}

/** The `command` string a soft error starts with, so agents can act on it. */
function backendDown(b: Backend, purpose: string): { text: string; isError: boolean } {
  return { text: `graft-Max federation: ${purpose} unavailable — ${b.installHint}`, isError: true };
}

// ---------------------------------------------------------------------------
// Tool definitions (advertised in tools/list alongside the graft_* six)
// ---------------------------------------------------------------------------

export const FEDERATED_TOOLS: FederatedToolDef[] = [
  {
    name: 'max_find_docs',
    description:
      'BM25 keyword search over your registered document collections (notes, specs, READMEs, transcripts — NOT code). Complements graft_find_code: that one understands code structure, this one finds what your docs SAY. Free, local, no model, millisecond-fast. Collections are registered once with `qmd collection add <dir> --name <name>`.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'keywords to search for' },
        collection: { type: 'string', description: 'narrow to one named collection (see `qmd collection list`)' },
        limit: { type: 'number', description: 'max results (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'max_trace_arch',
    description:
      'Architecture-level queries over the gitnexus code graph of the CURRENT repo: dependency chains, call chains, module coupling — what breaks if this changes, seen from module/architecture level (graft_trace_calls answers the same question at symbol level; use both for a full blast radius). Requires the repo to be indexed once with `npx gitnexus analyze`.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'natural-language architecture question, e.g. "what depends on the auth module"' },
      },
      required: ['query'],
    },
  },
  // [graft-Max T5] 9th tool: semantic code search (ccc / cocoindex-code).
  { ...SEMANTIC_TOOL },
];

/** Tool order in FEDERATED_TOOLS, for advertise-time gating by backend. */
const FED_INDEX = { docs: 0, arch: 1, semantic: 2 } as const;

// ---------------------------------------------------------------------------
// Tool execution (every path resolves {text, isError}, none throws)
// ---------------------------------------------------------------------------

/** qmd search -n <limit> [-c <collection>] <query> — output is
 * `qmd://collection/file:line #docid …` blocks; passed through trimmed. */
async function runQmdSearch(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const query = String(args.query ?? '').trim();
  if (!query) return { text: 'max_find_docs requires a query', isError: true };
  const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit >= 1 ? Math.floor(args.limit) : 5;
  const cArgs = ['search', query, '-n', String(limit)];
  if (typeof args.collection === 'string' && args.collection) cArgs.push('-c', args.collection);
  // [graft-Max T2] in-process SDK first (~3ms measured vs ~293ms spawn).
  // Only for the default collection-less shape we can reproduce faithfully;
  // -c filtering also works via searchLex options, so both paths embed.
  const embedded = await qmdSearchInProcess(query, limit, typeof args.collection === 'string' && args.collection ? args.collection : undefined);
  if (embedded !== null) return { text: embedded, isError: false };
  dlog(`[fed] qmd spawn: qmd ${cArgs.join(' ')}`);
  const r = await runCli('qmd', cArgs, 30_000);
  const flat = (s: string) => s.replaceAll('\n', ' ⏎ ');
  dlog(`[fed] qmd done ok=${r.ok} out="${flat(clip(r.out, 200))}" err="${flat(clip(r.err, 150))}"`);
  if (r.overflow) return { text: FED_OUT_OVERFLOW, isError: true };
  if (!r.ok && !r.out.trim()) {
    // A nonzero exit WITH output can still be useful (qmd warns on stderr);
    // only a truly empty answer is a failure worth an install hint.
    return backendDown(QMD, 'qmd');
  }
  const text = r.out.trim() || (r.err.trim() ? r.err.trim() : `no hits for: ${query}`);
  return { text, isError: !r.ok && !r.out.trim() };
}

/**
 * [graft-Max T3] gitnexus persistent session.
 *
 * The one-shot path above pays the full stdio handshake (~1.2s) per query.
 * A session keeps the child alive: handshake once (init → note → list), then
 * every query is a single tools/call with an incrementing id — measured
 * second-call latency drops to sub-300ms on this machine.
 *
 * Lifecycle rules (项目约束 §1.5 / stdin-leash spirit):
 *   - killed with the server (shutdown() below, wired to the same stdin-end
 *     path that tears down graft's own resources)
 *   - idle recycle after 10 min of no calls (same cadence as the leash)
 *   - one automatic rebuild after a child crash; a second consecutive
 *     failure degrades to the one-shot path so the tool never dead-ends
 */
const GNX_IDLE_MS = 10 * 60_000;
const GNX_HANDSHAKE_TIMEOUT_MS = 15_000;
const GNX_CALL_TIMEOUT_MS = 45_000;
/** 握手超时，测试可缩短（生产恒为 GNX_HANDSHAKE_TIMEOUT_MS）。 */
let gnxHandshakeTimeoutMs = GNX_HANDSHAKE_TIMEOUT_MS;
/** 启动失败的负缓存窗口（[S3]：装不上的后端不该每次调用都吃满握手超时）。 */
const GNX_START_FAIL_TTL_MS = 30_000;

interface GnxSession {
  child: ReturnType<typeof spawn>;
  nextId: number;
  idleTimer: NodeJS.Timeout | null;
}

/** [N6 P3-7] 会话按 cwd 分桶。旧实现是全局单例：`cwd` 只影响首次 spawn，之后
 * 拿 A 仓库的会话去回答 B 仓库的问题（错误的代码图答案）。一个 MCP server 进程
 * 通常只有一个 root，所以实际桶数就是 1；分桶只是让"换 root"不再是静默错误。 */
const gnxSessions = new Map<string, GnxSession>();
const gnxStarting = new Map<string, Promise<GnxSession | null>>();
const gnxConsecutiveFailures = new Map<string, number>();
const gnxStartFailedAt = new Map<string, number>();

/** 丢掉某 cwd 的会话（给了 `s` 就只在它才是当前会话时丢，避免误伤重建的会话）。 */
function gnxDrop(cwd: string, s?: GnxSession): void {
  if (!s || gnxSessions.get(cwd) === s) gnxSessions.delete(cwd);
}

function gnxKill(s: GnxSession | null): void {
  if (!s) return;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  try {
    s.child.kill('SIGKILL');
  } catch {/* already gone */}
}

export async function shutdownFederatedSessions(): Promise<void> {
  for (const s of gnxSessions.values()) gnxKill(s);
  gnxSessions.clear();
  await closeEmbeddedQmd();
}

function gnxArmIdle(s: GnxSession, cwd: string): void {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    dlog('[fed] gitnexus session idle recycle (10min)');
    gnxKill(s);
    gnxDrop(cwd, s);
  }, GNX_IDLE_MS);
  s.idleTimer.unref?.();
}

/** 子进程的最小形状：真 ChildProcess 与测试里的假 EventEmitter child 都满足。 */
interface GnxEmitter {
  on(ev: string, fn: (...a: any[]) => void): unknown;
  off?(ev: string, fn: (...a: any[]) => void): unknown;
}
interface GnxChildLike extends GnxEmitter {
  stdout?: GnxEmitter | null;
  stdin?: { write(s: string): unknown } | null;
}

/**
 * [N6 P2-2] gitnexus 常驻会话的握手：发 initialize + notifications/initialized，
 * 等 id 0 的答复。
 *
 * **settle 后立刻摘掉自己的 data 监听器并清空缓冲。** 旧实现让监听器活满整个
 * 会话（最长 10 分钟闲置回收），每来一块数据都要把累积的整串重新 split + 逐行
 * `JSON.parse`（O(n²)），`out` 也从不截断——内存单调上涨。会话期只留
 * `gnxSessionCall` 的临时监听器。
 *
 * 解析也改成"只吃完整行、尾巴留着"，而不是每次从头重解析。
 * 返回 true = 就绪；false = 超时 / 子进程挂了（调用方降级到 one-shot）。
 */
function handshakeGnxSession(child: GnxChildLike, opts: { timeoutMs: number; onFail?: (why: string) => void }): Promise<boolean> {
  return new Promise<boolean>((resolveHandshake) => {
    let buf = '';
    let settled = false;
    const finish = (ok: boolean, why = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off?.('data', onData);
      child.off?.('error', onErr);
      child.off?.('close', onClose);
      buf = ''; // P2-2：会话期不再背这个缓冲
      if (!ok && why) opts.onFail?.(why);
      resolveHandshake(ok);
    };
    const hit = (line: string): boolean => {
      try {
        const msg = JSON.parse(line);
        return msg.id === 0 && !msg.error;
      } catch {
        return false; // 不完整的一行，等下一块
      }
    };
    const onData = (d: Buffer | string) => {
      buf += d.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? ''; // 只保留未解析的尾巴
      for (const part of parts) {
        const line = part.trim();
        if (line.startsWith('{') && hit(line)) {
          finish(true);
          return;
        }
      }
      // 对端不带换行结尾（非标准，但便宜地兜住）
      const tail = buf.trim();
      if (tail.startsWith('{') && hit(tail)) {
        buf = '';
        finish(true);
      }
    };
    const onErr = (e: unknown) => finish(false, e instanceof Error ? e.message : String(e));
    const onClose = () => finish(false, 'child closed before handshake');
    const timer = setTimeout(() => finish(false, 'handshake timeout'), opts.timeoutMs);
    child.stdout?.on('data', onData);
    child.on('error', onErr);
    child.on('close', onClose);
    // Same staged-write pacing as the one-shot path (E2E pitfall #3).
    const write = (s2: string, delayMs: number) => setTimeout(() => {
      if (!settled) child.stdin?.write(s2 + '\n');
    }, delayMs);
    const initReq = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'graft-max', version: '1' } } });
    const note = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    write(initReq, 0);
    write(note, 300);
  });
}

/** Spawn + handshake once. Resolves null when the child can't start or the
 * handshake doesn't complete — caller degrades to the one-shot path. */
async function startGnxSession(cwd: string): Promise<GnxSession | null> {
  let child;
  try {
    child = spawnImpl('gitnexus', ['mcp'], { cwd, windowsHide: true, shell: true });
  } catch (e) {
    dlog(`[fed] gitnexus session spawn failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  const t0 = Date.now();
  const ok = await handshakeGnxSession(child, {
    timeoutMs: gnxHandshakeTimeoutMs,
    onFail: (why) => dlog(`[fed] gitnexus session start failed: ${why}`),
  });
  if (!ok) {
    try {
      child.kill('SIGKILL');
    } catch {/* already gone */}
    return null;
  }
  const s: GnxSession = { child, nextId: 10, idleTimer: null };
  child.on('close', () => {
    if (gnxSessions.get(cwd) === s) {
      dlog('[fed] gitnexus session child exited — session dropped');
      gnxDrop(cwd, s);
    }
  });
  child.stderr?.on('data', () => {/* diagnostics stay on stderr */});
  gnxArmIdle(s, cwd);
  dlog(`[fed] gitnexus session ready in ${Date.now() - t0}ms`);
  return s;
}

async function getGnxSession(cwd: string): Promise<GnxSession | null> {
  const cur = gnxSessions.get(cwd);
  if (cur) {
    gnxArmIdle(cur, cwd);
    return cur;
  }
  // [S3 review] negative cache after a failed start: a backend that was
  // uninstalled (or can't start) shouldn't cost a full handshake timeout on
  // every call until the advertise probe refreshes.
  const failedAt = gnxStartFailedAt.get(cwd) ?? 0;
  if (failedAt && fedClock() - failedAt < GNX_START_FAIL_TTL_MS) return null;
  let starting = gnxStarting.get(cwd);
  if (!starting) {
    starting = startGnxSession(cwd).finally(() => {
      gnxStarting.delete(cwd);
    });
    gnxStarting.set(cwd, starting);
  }
  const s = await starting;
  if (s) gnxSessions.set(cwd, s);
  else gnxStartFailedAt.set(cwd, fedClock());
  return s;
}

/** One tools/call over an existing session. Resolves null on transport-level
 * failure (session dead) so the caller can rebuild; content errors come back
 * as normal {text, isError}. */
function gnxSessionCall(
  s: GnxSession,
  query: string,
): Promise<{ text: string; isError: boolean } | null> {
  return new Promise((resolveCall) => {
    const id = s.nextId++;
    const callReq = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'query', arguments: { query } } });
    let settled = false;
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString();
      for (const line of buf.split('\n').filter((l) => l.trim().startsWith('{'))) {
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            cleanup();
            const c = msg.result?.content;
            if (Array.isArray(c)) resolveCall({ text: c.map((x: { text?: string }) => x.text ?? '').join('\n').trim(), isError: false });
            else if (msg.error) resolveCall({ text: `gitnexus error: ${msg.error.message ?? JSON.stringify(msg.error)}`, isError: true });
            else resolveCall({ text: 'gitnexus returned an empty answer', isError: true });
            return;
          }
        } catch {/* partial line */}
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolveCall(null); // transport-level stall → caller rebuilds
    }, GNX_CALL_TIMEOUT_MS);
    function cleanup() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      s.child.stdout?.off('data', onData);
    }
    s.child.stdout?.on('data', onData);
    s.child.stdin?.write(callReq + '\n');
  });
}

/** [M-假死修复] 单次工具调用的**总预算**。
 *
 * 为什么必须有：下面的每一段（会话握手 15s、单次会话调用 45s、one-shot 45s）各自有
 * 超时，但它们是**串联**的——一个"握手成功但 query 永远沉默"的假死后端会把
 * 会话调用 45s + 重建 45s + one-shot 45s 串成 **135s+**，对 agent 来说就是
 * "这个工具假死了"（实测 E2E 复现：100s 无回包）。host 的工具超时通常只有 60~120s，
 * 超过就直接判死，用户看到的是请求卡住。
 *
 * 契约：`max_trace_arch` 的**端到端耗时**永远 ≤ TOTAL_BUDGET_MS（当前 60s——
 * 留足一个正常大仓库查询的时间，又远低于 host 超时）。超预算立刻返回软错误，
 * 告诉用户重试（重试会走负缓存/降级路径，反而更快）。
 */
const TRACE_TOTAL_BUDGET_MS = 60_000;

/** 带总预算地跑一个异步任务。超预算返回 fallback（软错误），底层任务继续在后台
 * 自然结束（各段有自己的超时与清理，不会泄漏进程）。 */
function withTotalBudget<T>(p: Promise<T>, fallback: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback());
    }, TRACE_TOTAL_BUDGET_MS);
    t.unref?.();
    p.then(
      (v) => { if (!settled) { settled = true; clearTimeout(t); resolve(v); } },
      () => { if (!settled) { settled = true; clearTimeout(t); resolve(fallback()); } },
    );
  });
}

/** Session-first query with one-shot fallback (original implementation kept
 * verbatim as the degradation path). */
async function runGitnexusQuerySmart(args: Record<string, unknown>, cwd: string): Promise<{ text: string; isError: boolean }> {
  const query = String(args.query ?? '').trim();
  if (!query) return { text: 'max_trace_arch requires a query', isError: true };
  return withTotalBudget(
    runGitnexusQuerySmartInner(args, cwd, query),
    () => ({
      text: `gitnexus did not answer within ${Math.round(TRACE_TOTAL_BUDGET_MS / 1000)}s (backend may be hung) — retry the same query (a retry reuses the cached session state and fails faster), or run \`npx gitnexus analyze\` to (re)index this repo.`,
      isError: true,
    }),
  );
}

async function runGitnexusQuerySmartInner(args: Record<string, unknown>, cwd: string, query: string): Promise<{ text: string; isError: boolean }> {
  const s = await getGnxSession(cwd);
  if (s) {
    const t0 = Date.now();
    const r = await gnxSessionCall(s, query);
    dlog(`[fed] gitnexus session call ${Date.now() - t0}ms ok=${r !== null}`);
    if (r) {
      gnxConsecutiveFailures.set(cwd, 0);
      return r;
    }
    // Session stalled or died: drop it, rebuild once, then fall through to
    // the one-shot path if the rebuild also fails to answer.
    gnxKill(s);
    gnxDrop(cwd, s);
    const fails = (gnxConsecutiveFailures.get(cwd) ?? 0) + 1;
    gnxConsecutiveFailures.set(cwd, fails);
    if (fails <= 2) {
      const s2 = await getGnxSession(cwd);
      if (s2) {
        const r2 = await gnxSessionCall(s2, query);
        if (r2) {
          gnxConsecutiveFailures.set(cwd, 0);
          return r2;
        }
        gnxKill(s2);
        gnxDrop(cwd, s2);
      }
    }
    dlog('[fed] gitnexus session unusable — degrading to one-shot path');
  }
  return runGitnexusQuery(args, cwd);
}

/**
 * gitnexus has no one-shot `query` CLI subcommand; its answer channel is the
 * MCP server (`gitnexus mcp`) which exposes a query tool. Rather than embed a
 * full JSON-RPC client, we drive the standard MCP stdio handshake with one
 * tools/call — the same newline-delimited protocol graft's own server speaks.
 */
async function runGitnexusQuery(args: Record<string, unknown>, cwd: string): Promise<{ text: string; isError: boolean }> {
  const query = String(args.query ?? '').trim();
  if (!query) return { text: 'max_trace_arch requires a query', isError: true };
  const listReq = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const callReq = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'query', arguments: { query } } });
  // notifications/initialized is REQUIRED before the server accepts calls
  // (MCP spec; observed: without it gitnexus silently drops the tools/call).
  const note = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const initReq = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'graft-max', version: '1' } } });
  return new Promise((resolve) => {
    let child;
    try {
      // Same Windows shim reality as runCli: gitnexus is an npm .cmd shim, so
      // spawn it through the shell.
      child = spawnImpl('gitnexus', ['mcp'], { cwd, windowsHide: true, shell: true });
    } catch (e) {
      resolve(backendDown(GITNEXUS, 'gitnexus'));
      return;
    }
    let out = '';
    let settled = false;
    const finish = (r: { text: string; isError: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {/* already gone */}
      resolve(r);
    };
    // Per-write pacing matters: an all-at-once write + stdin.end() loses
    // messages through the cmd-shim pipe (observed: gitnexus answers
    // initialize but drops everything after). Staged writes with the pipe
    // held open are reliable.
    const write = (s: string, delayMs: number) => setTimeout(() => {
      if (settled) return;
      child.stdin?.write(s + '\n');
    }, delayMs);
    const timer = setTimeout(() => {
      finish({ text: `gitnexus mcp timed out after 45s — is the repo indexed? (npx gitnexus analyze)`, isError: true });
    }, 45_000);
    child.stdout?.on('data', (d: Buffer) => {
      // [N6 P2-4] 同一道 8MB 上限：一个失控的 gitnexus 也不能把 server 拖进 OOM。
      const grown = appendCapped(out, d.toString());
      out = grown.buf;
      if (grown.overflow) {
        finish({ text: FED_OUT_OVERFLOW, isError: true });
        return;
      }
      // Early exit the moment the tools/call answer lands — the child stays
      // alive otherwise, and a healthy call shouldn't burn the timeout.
      const lines = out.split('\n').filter((l) => l.trim().startsWith('{'));
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2) {
            const c = msg.result?.content;
            if (Array.isArray(c)) finish({ text: c.map((x: { text?: string }) => x.text ?? '').join('\n').trim(), isError: false });
            else if (msg.error) finish({ text: `gitnexus error: ${msg.error.message ?? JSON.stringify(msg.error)}`, isError: true });
            return;
          }
        } catch {/* partial line, more data coming */}
      }
    });
    child.stderr?.on('data', () => {/* diagnostics stay on stderr */});
    child.on('error', (e: Error) => {
      finish({ text: `gitnexus not runnable: ${e.message} — ${GITNEXUS.installHint}`, isError: true });
    });
    child.on('close', () => {
      finish(
        out.trim()
          ? { text: 'gitnexus closed before answering — repo not indexed? Run `npx gitnexus analyze` in the repo root first.', isError: true }
          : { text: 'gitnexus produced no output — is it installed? ' + GITNEXUS.installHint, isError: true },
      );
    });
    dlog(`[fed] gitnexus spawn (cwd=${cwd}) query="${clip(query, 100)}"`);
    write(initReq, 0);
    write(note, 300);
    write(listReq, 600);
    write(callReq, 900);
    dlog('[fed] gitnexus session: init@0ms note@300ms list@600ms call@900ms');
  });
}

/** Entry used by ./tools.ts. `root` is the repo the MCP server was started for. */

// ---------------------------------------------------------------------------
// [graft-Max T4] result cache: 60s TTL LRU keyed on tool+args(+repo).
// Same-question repeat calls in one session skip the backend entirely and
// come back annotated with a `[cached]` header line. TTL bounds staleness
// (BM25/arch indexes do change); no invalidation listening — deliberate,
// that would be over-engineering for a 60s window.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 32;
const resultCache = new Map<string, { at: number; r: { text: string; isError: boolean } }>();

/** [N6 P3-6] 缓存命中/未命中/淘汰计数（size 读时取真实值），供面板 `/stats` 消费。 */
const fedCacheCounters = { hits: 0, misses: 0, evictions: 0 };

export interface FedCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
}

/** 联邦结果缓存的当前观测值（面板 /stats 与单测共用）。 */
export function getFedCacheStats(): FedCacheStats {
  return { ...fedCacheCounters, size: resultCache.size };
}

/** 稳定序列化：对象键排序后展开（数组按序、基本类型原样走 JSON.stringify）。
 * undefined 值按 JSON.stringify 的老规矩丢掉，保证同一份语义只有一种写法。 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : stableStringify(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  const body = Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',');
  return `{${body}}`;
}

/** [N6 P3-4] 工具+仓库+参数 的缓存键。参数键排序后序列化，`{a,b}` 与 `{b,a}`
 * 命中同一条——旧实现用 JSON.stringify 原样拼，键序不同即漏命中。 */
export function cacheKey(name: string, args: Record<string, unknown>, root: string): string {
  return `${name}|${root}|${stableStringify(args)}`;
}

export function cacheGet(key: string): { text: string; isError: boolean } | null {
  const hit = resultCache.get(key);
  if (!hit) {
    fedCacheCounters.misses++;
    return null;
  }
  if (fedClock() - hit.at > CACHE_TTL_MS) {
    resultCache.delete(key);
    fedCacheCounters.misses++;
    return null;
  }
  // LRU refresh: re-insert to move to the back of the eviction order.
  resultCache.delete(key);
  resultCache.set(key, hit);
  fedCacheCounters.hits++;
  return hit.r;
}

export function cachePut(key: string, r: { text: string; isError: boolean }): void {
  if (r.isError) return; // errors are never cached — a retry must really retry
  resultCache.set(key, { at: fedClock(), r });
  while (resultCache.size > CACHE_MAX) {
    resultCache.delete(resultCache.keys().next().value as string);
    fedCacheCounters.evictions++;
  }
}

export async function callFederatedTool(
  name: string,
  args: Record<string, unknown>,
  root: string,
): Promise<{ text: string; isError: boolean } | null> {
  const key = cacheKey(name, args, root);
  const hit = cacheGet(key);
  if (hit) {
    dlog(`[fed] cache hit: ${name} (${clip(JSON.stringify(args), 80)})`);
    return { text: `[cached, 60s TTL]\n\n${hit.text}`, isError: hit.isError };
  }
  let r: { text: string; isError: boolean } | null;
  switch (name) {
    case 'max_find_docs':
      r = await runQmdSearch(args);
      break;
    case 'max_trace_arch':
      r = await runGitnexusQuerySmart(args, root);
      break;
    case 'max_search_semantic':
      r = await runSemanticSearch(args, root);
      break;
    default:
      return null; // not ours → caller falls through to graft tools
  }
  if (r) cachePut(key, r);
  return r;
}

/** Advertise-time filter: a backend that isn't installed hides its tool, the
 * same way ./server.ts hides graft tools in repos with no graph. Keeps the
 * agent's tool budget clean. */
/** [graft-Max] 联邦工具总开关：`GRAFT_MAX_FEDERATED=0|false` 一键关掉。
 *
 * 为什么需要它：联邦工具占 schema 预算（tools/list 是每轮都计费的 context），
 * 排查 graft 本体问题或换来更小的上下文时需要能一次关干净。`docs-selfdev/项目约束.md`
 * §4 早就把这个开关写成了既定能力，`test/mcp-server.test.ts` 也按它的语义写断言 ——
 * 但**代码里从来没实现过**，于是 CI 上那两条"advertises every tool"在装了后端的机器
 * 上多出两个工具、在没装后端的 runner 上少两个工具，两边都红（4050 pass / 2 fail）。
 * 现在是真开关。 */
export function federationDisabled(): boolean {
  const v = process.env.GRAFT_MAX_FEDERATED;
  return v === '0' || v === 'false';
}

export async function availableFederatedTools(root = ''): Promise<FederatedToolDef[]> {
  if (federationDisabled()) return [];
  const [qmdOk, gnxOk] = await Promise.all([backendAvailable(QMD), backendAvailable(GITNEXUS)]);
  // [graft-Max T2] embedded SDK counts as available even if the CLI shim
  // probe failed (e.g. PATH differences between shells) — the probe stays
  // for the spawn fallback path.
  const qmdAny = qmdOk || (await qmdEmbeddedAvailable());
  // [graft-Max T5] semantic search shows only when the repo is actually
  // indexed (a bare `ccc` install without `ccc init` here can't answer).
  const cccOk = root ? cccIndexed(root) && (await backendAvailable(CCC_BACKEND)) : false;
  const out: FederatedToolDef[] = [];
  if (qmdAny) out.push(FEDERATED_TOOLS[FED_INDEX.docs]);
  if (gnxOk) out.push(FEDERATED_TOOLS[FED_INDEX.arch]);
  if (cccOk) out.push(FEDERATED_TOOLS[FED_INDEX.semantic]);
  return out;
}

/** Cheap membership set for tools/call routing (no probe, no async). */
export const FEDERATED_TOOL_NAMES: ReadonlySet<string> = new Set(FEDERATED_TOOLS.map((t) => t.name));

// ---------------------------------------------------------------------------
// [N6] 测试接缝 —— 集中放文件尾部，避免打散上面的结构。
// 生产路径从不调用这些函数；它们只替换"时间/spawn/探针"三个外部边界，
// 让 TTL、8MB 上限、监听器摘除这些行为能用假时钟/假 child 直接验。
// ---------------------------------------------------------------------------

/** 用假时钟替换"现在"；`null` 恢复真实时钟。 */
export function setFedClock(now: (() => number) | null): void {
  fedClock = now ?? (() => Date.now());
}

/** 用假 spawn 替换子进程创建；`null` 恢复真实 spawn。 */
export function setFedSpawn(fn: typeof spawn | null): void {
  spawnImpl = fn ?? spawn;
}

/** 用假探针替换 `runCli` 探测；`null` 恢复真实探测。 */
export function setFedProbe(fn: ((cmd: string, args: string[]) => Promise<boolean>) | null): void {
  probeRunner = fn;
}

/** 缩短握手超时（单测里验降级/超时路径，不必真等 15 秒）；`null` 恢复默认。 */
export function setFedGnxHandshakeTimeout(ms: number | null): void {
  gnxHandshakeTimeoutMs = ms ?? GNX_HANDSHAKE_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// [N6 P2-3] 探针心跳：没有它，P2-3 只能"下次 tools/list 时才发现后端装上了"——
// 而客户端恰恰没有理由再问 tools/list。心跳把"中途装后端"变成"最迟 intervalMs
// 后发现"，通过 onBackendsChanged → KeptListing.refresh() → list_changed 通知出去。
//
// **默认不启动**：由外层接线决定（一行 `startFedProbeWatch()`）。没人注册回调时
// 它只是白花探针，不该在库里偷偷跑。
// ---------------------------------------------------------------------------
let probeWatchTimer: NodeJS.Timeout | null = null;

/** 启动探针心跳（幂等：重复调用返回同一个停止函数）。返回停止函数。 */
export function startFedProbeWatch(intervalMs = 60_000): () => void {
  if (probeWatchTimer) return stopFedProbeWatch;
  probeWatchTimer = setInterval(() => {
    void (async () => {
      for (const b of [QMD, GITNEXUS, CCC_BACKEND]) {
        try {
          await backendAvailable(b); // TTL 内的直接吃缓存，不会每拍都 spawn
        } catch {
          /* 探针自身永不抛出 */
        }
      }
    })();
  }, intervalMs);
  probeWatchTimer.unref?.();
  return stopFedProbeWatch;
}

export function stopFedProbeWatch(): void {
  if (probeWatchTimer) {
    clearInterval(probeWatchTimer);
    probeWatchTimer = null;
  }
}

/** 把所有模块级状态复位（时钟、spawn、探针、会话、缓存、计数），单测之间用它隔离。 */
export function resetFedStateForTest(): void {
  stopFedProbeWatch();
  fedClock = () => Date.now();
  spawnImpl = spawn;
  probeRunner = null;
  gnxHandshakeTimeoutMs = GNX_HANDSHAKE_TIMEOUT_MS;
  probeCache.clear();
  backendsChangedCbs.clear();
  for (const s of gnxSessions.values()) gnxKill(s);
  gnxSessions.clear();
  gnxStarting.clear();
  gnxConsecutiveFailures.clear();
  gnxStartFailedAt.clear();
  resultCache.clear();
  fedCacheCounters.hits = 0;
  fedCacheCounters.misses = 0;
  fedCacheCounters.evictions = 0;
}

// ---------------------------------------------------------------------------
// [N9 / N12] 联邦后端健康度：面板"联邦后端"卡的数据源。
//
// 探针结果本来只在进程内缓存（probeCache），面板看不到 —— 于是"我装了 qmd
// 为什么工具还没出现"只能靠猜。这里把缓存读出来（**只读，不触发探测**，
// 避免面板每 2s 轮询把三个后端的 --version 打成进程工厂），另外给一个显式的
// `reprobeBackends()` 供面板的「重试探针」按钮调用。
// ---------------------------------------------------------------------------

export interface FedBackendHealth {
  /** 后端短名（面板显示用）。 */
  name: string;
  /** true=就绪 / false=不可用 / null=本会话还没探过。 */
  ok: boolean | null;
  /** 探针结果距今多久（ms）；null=还没探过。 */
  ageMs: number | null;
  /** 距离下次允许重探还有多久（ms）；0=现在就能重探。 */
  retryInMs: number;
  /** 装不上时给人看的修复命令。 */
  installHint: string;
}

/** 后端名 → Backend 定义。顺序即面板显示顺序。 */
const BACKENDS: Array<[string, Backend]> = [
  ['qmd', QMD],
  ['gitnexus', GITNEXUS],
  ['ccc', CCC_BACKEND],
];

/** 探针快照（只读，不触发任何子进程）。面板轮询用这个。 */
export function fedBackendHealth(): FedBackendHealth[] {
  const now = fedClock();
  return BACKENDS.map(([name, b]) => {
    const hit = probeCache.get(b);
    const ttl = hit ? (hit.ok ? PROBE_OK_TTL_MS : PROBE_FAIL_TTL_MS) : 0;
    return {
      name,
      ok: hit ? hit.ok : null,
      ageMs: hit ? now - hit.at : null,
      retryInMs: hit ? Math.max(0, hit.at + ttl - now) : 0,
      installHint: b.installHint,
    };
  });
}

/** 显式重探（面板「重试探针」按钮 / N12）。清掉缓存后按真实探针跑一遍。
 * 永不 throw：探针失败就是 ok=false。 */
export async function reprobeBackends(): Promise<FedBackendHealth[]> {
  probeCache.clear();
  for (const [, b] of BACKENDS) {
    // 失败不打断其它后端：一个装坏了不该让整张卡片空白
    try {
      await backendAvailable(b);
    } catch (e) {
      dlog(`[fed] reprobe failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return fedBackendHealth();
}
