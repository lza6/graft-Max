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
function runCli(cmd: string, args: string[], timeoutMs: number, cwd?: string): Promise<{ ok: boolean; out: string; err: string }> {
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
];

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
  const r = await runCli('qmd', cArgs, 30_000);
  if (!r.ok && !r.out.trim()) {
    // A nonzero exit WITH output can still be useful (qmd warns on stderr);
    // only a truly empty answer is a failure worth an install hint.
    return backendDown(QMD, 'qmd');
  }
  const text = r.out.trim() || (r.err.trim() ? r.err.trim() : `no hits for: ${query}`);
  return { text, isError: !r.ok && !r.out.trim() };
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
    write(initReq, 0);
    write(note, 300);
    write(listReq, 600);
    write(callReq, 900);
  });
}

/** Entry used by ./tools.ts. `root` is the repo the MCP server was started for. */
export async function callFederatedTool(
  name: string,
  args: Record<string, unknown>,
  root: string,
): Promise<{ text: string; isError: boolean } | null> {
  switch (name) {
    case 'max_find_docs':
      return runQmdSearch(args);
    case 'max_trace_arch':
      return runGitnexusQuery(args, root);
    default:
      return null; // not ours → caller falls through to graft tools
  }
}

/** Advertise-time filter: a backend that isn't installed hides its tool, the
 * same way ./server.ts hides graft tools in repos with no graph. Keeps the
 * agent's tool budget clean. */
export async function availableFederatedTools(): Promise<FederatedToolDef[]> {
  const [qmdOk, gnxOk] = await Promise.all([backendAvailable(QMD), backendAvailable(GITNEXUS)]);
  const out: FederatedToolDef[] = [];
  if (qmdOk) out.push(FEDERATED_TOOLS[0]);
  if (gnxOk) out.push(FEDERATED_TOOLS[1]);
  return out;
}

/** Cheap membership set for tools/call routing (no probe, no async). */
export const FEDERATED_TOOL_NAMES: ReadonlySet<string> = new Set(FEDERATED_TOOLS.map((t) => t.name));
