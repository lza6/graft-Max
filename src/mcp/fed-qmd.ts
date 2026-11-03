/**
 * [graft-Max] In-process qmd embed (改进指南 T2).
 *
 * Replaces the spawn-based max_find_docs hot path with a direct import of the
 * qmd SDK when it can be located — measured on this machine: spawn ~293ms vs
 * in-process createStore(6ms) + searchLex(3ms). Falls back to the original
 * spawn path when the SDK isn't resolvable (qmd installed but not as a
 * resolvable package), so behavior never regresses.
 *
 * Output format stays byte-compatible with the CLI (qmd://collection/file
 * headers), which e2e/e2e-federation.mjs asserts on.
 *
 * Windows notes inherited from federation.ts: the SDK import avoids the .cmd
 * shim entirely; INDEX_PATH is required by the SDK's own guard (it refuses to
 * guess the global index from library mode), so we resolve the same default
 * the CLI uses (~/.cache/qmd/index.sqlite, XDG_CACHE_HOME aware) ourselves.
 */
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { delimiter, join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dlog, clip } from './devlog.js';

/** Shape of the pieces of the qmd SDK we use. Kept loose on purpose — the
 * SDK is a global-install dependency, not a bundled one. */
interface QmdStore {
  searchLex(query: string, options?: { limit?: number; collection?: string | string[] }): Promise<
    Array<{ filepath: string; displayPath?: string; title?: string; docid?: string; collectionName?: string; body?: string }>
  >;
  close(): Promise<void>;
}
type QmdModule = { createStore(options: { dbPath: string }): Promise<QmdStore> };

/** Resolve the same default index path the qmd CLI uses (cli/qmd.js getDbPath
 * → getDefaultDbPath → ~/.cache/qmd/index.sqlite, honoring XDG_CACHE_HOME). */
function qmdDbPath(): string {
  if (process.env.QMD_INDEX_PATH) return resolvePath(process.env.QMD_INDEX_PATH);
  const cacheDir = process.env.XDG_CACHE_HOME
    ? join(process.env.XDG_CACHE_HOME, 'qmd')
    : join(homedir(), '.cache', 'qmd');
  return join(cacheDir, 'index.sqlite');
}

/** Candidate specifiers for the SDK, tried in order: a local node_modules
 * (repo vendored it), then every npm global root on this machine's PATH. */
function qmdCandidates(): string[] {
  const out: string[] = ['@tobilu/qmd'];
  const paths = (process.env.PATH ?? '').split(delimiter);
  for (const p of paths) {
    // `...\npm` is the npm global prefix on Windows; global packages live in ./node_modules under it
    if (/[\\/]npm$/i.test(p)) out.push(join(p, 'node_modules', '@tobilu', 'qmd', 'dist', 'index.js'));
  }
  return out;
}

let storePromise: Promise<QmdStore | null> | null = null;
let lastFailedAt = 0;
/** [R4 review] A failed/absent store must not be cached forever: the index may
 * be created (or the SDK installed) mid-session. Retry at most this often. */
const RETRY_AFTER_MS = 60_000;

/** Lazily create (and keep) the in-process store. Resolves null when the SDK
 * or the index can't be located — callers fall back to spawning the CLI. */
function getStore(): Promise<QmdStore | null> {
  if (!storePromise && Date.now() - lastFailedAt < RETRY_AFTER_MS) return Promise.resolve(null);
  storePromise ??= (async () => {
    const dbPath = qmdDbPath();
    if (!existsSync(dbPath)) {
      dlog(`[fed-qmd] index not found at ${dbPath} — spawn fallback (retry in ${RETRY_AFTER_MS / 1000}s)`);
      lastFailedAt = Date.now();
      storePromise = null;
      return null;
    }
    for (const spec of qmdCandidates()) {
      try {
        // Dynamic import, not createRequire: qmd is a top-level-await ESM and
        // sync require throws ERR_REQUIRE_ASYNC_MODULE on it (observed). A
        // bare specifier resolves from our own tree; an absolute path needs a
        // file:// URL on Windows.
        const url = /^[A-Za-z]:[\\/]/.test(spec) ? pathToFileURL(spec).href : spec;
        const mod = (await import(url)) as QmdModule & { default?: QmdModule };
        const m2 = mod;
        const api: QmdModule | undefined = typeof m2.createStore === 'function' ? m2 : m2.default;
        if (!api || typeof api.createStore !== 'function') continue;
        const t0 = Date.now();
        const store = await api.createStore({ dbPath });
        dlog(`[fed-qmd] in-process store ready (${dbPath}) in ${Date.now() - t0}ms`);
        return store;
      } catch (e) {
        dlog(`[fed-qmd] candidate ${spec} failed: ${clip(e instanceof Error ? e.message : String(e), 120)}`);
      }
    }
    dlog('[fed-qmd] no resolvable qmd SDK — spawn fallback (retry in 60s)');
    lastFailedAt = Date.now();
    storePromise = null; // [R4] transient failure: let a later call retry
    return null;
  })();
  return storePromise;
}

/** Close the embedded store (called from the same lifecycle hooks that tear
 * down the rest of the server, so the sqlite handle never leaks). */
export async function closeEmbeddedQmd(): Promise<void> {
  const store = await (storePromise ?? Promise.resolve(null));
  storePromise = null;
  try {
    // [review P3] a wedged sqlite close must not hold the exit path hostage
    await Promise.race([
      store?.close(),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
  } catch {/* already closed */}
}

/** Format SDK results into the same `qmd://collection/file #docid` block
 * layout the CLI prints (with :line when the body can anchor one). */
function formatResults(
  results: Awaited<ReturnType<QmdStore['searchLex']>>,
  query: string,
): string {
  if (!results.length) return `no hits for: ${query}`;
  return results
    .map((r) => {
      const body = r.body ?? '';
      const firstLine = body.split('\n', 1)[0] ?? '';
      const title = r.title ?? firstLine.replace(/^#+\s*/, '');
      const lines = [
        `${r.filepath}${r.docid ? ` #${r.docid}` : ''}`,
        `Title: ${title}`,
      ];
      if (body) lines.push('', clip(body.trim(), 600));
      return lines.join('\n');
    })
    .join('\n\n');
}

/** Try the embedded path; return null when unavailable (spawn fallback). */
export async function qmdSearchInProcess(
  query: string,
  limit: number,
  collection?: string,
): Promise<string | null> {
  const store = await getStore();
  if (!store) return null;
  const t0 = Date.now();
  try {
    const results = await store.searchLex(query, { limit, ...(collection ? { collection } : {}) });
    dlog(`[fed-qmd] searchLex ${Date.now() - t0}ms hits=${results.length}`);
    return formatResults(results, query);
  } catch (e) {
    // A broken embedded path must never break the tool: log and let the
    // caller retry via the CLI spawn.
    dlog(`[fed-qmd] searchLex failed: ${clip(e instanceof Error ? e.message : String(e), 200)} — spawn fallback`);
    return null;
  }
}

/** Probe without running a child: embedded path is usable when both the SDK
 * resolves and the index file exists. */
export async function qmdEmbeddedAvailable(): Promise<boolean> {
  return (await getStore()) !== null;
}
