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

/** Run a CLI to completion; resolve stdout, never reject.
 * Windows note: npm-global CLIs are `.cmd` shims, which `spawn` cannot exec
 * without a shell. We resolve the real entry via `where`-style lookup: try the
 * bare name first (works where the shim is a real exe), then `cmd /c` as the
 * shim-aware fallback. */
export function runCli(cmd: string, args: string[], timeoutMs: number, cwd?: string): Promise<{ ok: boolean; out: string; err: string }> {
  const attempt = (file: string, argv: string[], useShell: boolean) =>
    new Promise<{ ok: boolean; out: string; err: string }>((resolve) => {
      let child;
      try {
        child = spawn(file, argv, { cwd, windowsHide: true, shell: useShell });
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
        out += d.toString();
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

/** Cache the probe result for the process lifetime: a backend doesn't appear
 * mid-session, and a probe per tools/list would burn ~1s each time. */
const probeCache = new Map<Backend, boolean>();

async function backendAvailable(b: Backend): Promise<boolean> {
  const hit = probeCache.get(b);
  if (hit !== undefined) return hit;
  const r = await runCli(b.probeCmd[0], b.probeCmd[1], 15_000);
  probeCache.set(b, r.ok);
  return r.ok;
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

interface GnxSession {
  child: ReturnType<typeof spawn>;
  nextId: number;
  idleTimer: NodeJS.Timeout | null;
}

let gnxSession: GnxSession | null = null;
let gnxStarting: Promise<GnxSession | null> | null = null;
let gnxConsecutiveFailures = 0;
let gnxStartFailedAt = 0; // [S3] negative-cache timestamp after a failed start

function gnxKill(s: GnxSession | null): void {
  if (!s) return;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  try {
    s.child.kill('SIGKILL');
  } catch {/* already gone */}
}

export async function shutdownFederatedSessions(): Promise<void> {
  gnxKill(gnxSession);
  gnxSession = null;
  await closeEmbeddedQmd();
}

function gnxArmIdle(s: GnxSession): void {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    dlog('[fed] gitnexus session idle recycle (10min)');
    gnxKill(s);
    if (gnxSession === s) gnxSession = null;
  }, GNX_IDLE_MS);
  s.idleTimer.unref?.();
}

/** Spawn + handshake once. Resolves null when the child can't start or the
 * handshake doesn't complete — caller degrades to the one-shot path. */
function startGnxSession(cwd: string): Promise<GnxSession | null> {
  return new Promise((resolveSession) => {
    let child;
    try {
      child = spawn('gitnexus', ['mcp'], { cwd, windowsHide: true, shell: true });
    } catch (e) {
      dlog(`[fed] gitnexus session spawn failed: ${e instanceof Error ? e.message : String(e)}`);
      resolveSession(null);
      return;
    }
    let out = '';
    let settled = false;
    const fail = (why: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {/* already gone */}
      dlog(`[fed] gitnexus session start failed: ${why}`);
      resolveSession(null);
    };
    const timer = setTimeout(() => fail('handshake timeout'), GNX_HANDSHAKE_TIMEOUT_MS);
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
      for (const line of out.split('\n').filter((l) => l.trim().startsWith('{'))) {
        try {
          const msg = JSON.parse(line);
          // initialize answer (id 0) is enough: tools/list (id 1) is optional
          // and some servers answer calls without it; initialized notification
          // (observed E2E pitfall #2) is sent after init lands.
          if (msg.id === 0 && !msg.error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const s: GnxSession = { child, nextId: 10, idleTimer: null };
            child.on('close', () => {
              if (gnxSession === s) {
                dlog('[fed] gitnexus session child exited — session dropped');
                gnxSession = null;
              }
            });
            child.stderr?.on('data', () => {/* diagnostics stay on stderr */});
            gnxArmIdle(s);
            dlog(`[fed] gitnexus session ready in ${Date.now() - (t0 ?? 0)}ms`);
            resolveSession(s);
            return;
          }
        } catch {/* partial line */}
      }
    });
    child.on('error', (e: Error) => fail(e.message));
    const t0 = Date.now();
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

async function getGnxSession(cwd: string): Promise<GnxSession | null> {
  if (gnxSession) {
    gnxArmIdle(gnxSession);
    return gnxSession;
  }
  // [S3 review] negative cache after a failed start: a backend that was
  // uninstalled (or can't start) shouldn't cost a full handshake timeout on
  // every call until the advertise probe refreshes.
  if (gnxStartFailedAt && Date.now() - gnxStartFailedAt < 30_000) return null;
  gnxStarting ??= startGnxSession(cwd).finally(() => {
    gnxStarting = null;
  });
  const s = await gnxStarting;
  if (s) gnxSession = s;
  else gnxStartFailedAt = Date.now();
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

/** Session-first query with one-shot fallback (original implementation kept
 * verbatim as the degradation path). */
async function runGitnexusQuerySmart(args: Record<string, unknown>, cwd: string): Promise<{ text: string; isError: boolean }> {
  const query = String(args.query ?? '').trim();
  if (!query) return { text: 'max_trace_arch requires a query', isError: true };
  const s = await getGnxSession(cwd);
  if (s) {
    const t0 = Date.now();
    const r = await gnxSessionCall(s, query);
    dlog(`[fed] gitnexus session call ${Date.now() - t0}ms ok=${r !== null}`);
    if (r) {
      gnxConsecutiveFailures = 0;
      return r;
    }
    // Session stalled or died: drop it, rebuild once, then fall through to
    // the one-shot path if the rebuild also fails to answer.
    gnxKill(s);
    gnxSession = null;
    gnxConsecutiveFailures++;
    if (gnxConsecutiveFailures <= 2) {
      const s2 = await getGnxSession(cwd);
      if (s2) {
        const r2 = await gnxSessionCall(s2, query);
        if (r2) {
          gnxConsecutiveFailures = 0;
          return r2;
        }
        gnxKill(s2);
        gnxSession = null;
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
      child = spawn('gitnexus', ['mcp'], { cwd, windowsHide: true, shell: true });
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
      out += d.toString();
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

function cacheKey(name: string, args: Record<string, unknown>, root: string): string {
  return `${name}|${root}|${JSON.stringify(args)}`;
}

function cacheGet(key: string): { text: string; isError: boolean } | null {
  const hit = resultCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    resultCache.delete(key);
    return null;
  }
  // LRU refresh: re-insert to move to the back of the eviction order.
  resultCache.delete(key);
  resultCache.set(key, hit);
  return hit.r;
}

function cachePut(key: string, r: { text: string; isError: boolean }): void {
  if (r.isError) return; // errors are never cached — a retry must really retry
  resultCache.set(key, { at: Date.now(), r });
  while (resultCache.size > CACHE_MAX) {
    resultCache.delete(resultCache.keys().next().value as string);
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
export async function availableFederatedTools(root = ''): Promise<FederatedToolDef[]> {
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
