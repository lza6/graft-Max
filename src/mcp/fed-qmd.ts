/**
 * [graft-Max] In-process qmd embed (改进指南 T2; output contract aligned in N5).
 *
 * Replaces the spawn-based max_find_docs hot path with a direct import of the
 * qmd SDK when it can be located — measured on this machine: spawn ~293ms vs
 * in-process createStore(6ms) + searchLex(3ms). Falls back to the original
 * spawn path when the SDK isn't resolvable (qmd installed but not as a
 * resolvable package), so behavior never regresses.
 *
 * Output contract (N5 / P1-4): `formatResults()` below is the ONE place that
 * turns hits into text, and it reproduces the CLI's `outputResults()` (format
 * "cli") byte for byte:
 *
 *     qmd://<collection>/<path>:<line> #<docid>
 *     Title: <title>            (omitted when the row has no title)
 *     Context: <context>        (omitted when the row has no context)
 *     Score: <pct>%             (pct = (score*100).toFixed(0).padStart(3))
 *                               (blank line)
 *     @@ -<start>,<n> @@ (<before> before, <after> after)
 *     <snippet lines>
 *
 * with two blank lines between hits (the CLI's `console.log()` + `console.log('\n')`
 * pair) and `No results found.` for an empty result set. `:line` appears only
 * when a query term is found in the snippet body — same rule as the CLI.
 * The spawn path adds no formatting of its own: federation.ts passes the CLI's
 * own bytes through, so both paths agree by construction.
 *
 * `test/fixtures/qmd-cli-sample.txt` is a captured real CLI run (qmd 2.8.3,
 * `qmd search "逆向" -n 2`) and `test/fed-qmd.test.ts` asserts this formatter
 * reproduces it character for character.
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

// ---------------------------------------------------------------------------
// Hit shape + formatter (pure; the contract surface N5 pins down)
// ---------------------------------------------------------------------------

/** One hit, as the qmd SDK's `searchLex()` (→ `searchFTS()`) returns it. Kept
 * loose on purpose — the SDK is a global-install dependency, not a bundled one. */
export interface QmdHit {
  /** `qmd://<collection>/<path>` (the SDK builds this in SQL). */
  filepath?: string;
  /** `<collection>/<path>`. */
  displayPath?: string;
  title?: string;
  docid?: string;
  hash?: string;
  collectionName?: string;
  context?: string | null;
  body?: string;
  score?: number;
  chunkPos?: number;
  chunkLen?: number;
}

/** The SDK's exported `extractSnippet`. Injected rather than imported at the
 * top level so the formatter stays pure and unit-testable without the optional
 * global install. */
export type SnippetExtractor = (
  body: string,
  query: string,
  maxLen?: number,
  chunkPos?: number,
  chunkLen?: number,
) => { line: number; snippet: string };

export interface FormatOptions {
  /** When the SDK is loaded we pass its own `extractSnippet`, so snippets stay
   * byte-identical to the CLI even if upstream changes the algorithm. Absent
   * (unit tests, or an SDK that stops exporting it) → the local port below,
   * which reproduces qmd 2.8.3's simple path. */
  extractSnippet?: SnippetExtractor;
}

/** `printEmptySearchResults()` for format "cli" — verbatim, including the period. */
export const NO_RESULTS = 'No results found.';

/** The CLI's snippet window: `extractSnippet(row.body, query, 500, …)`. */
const SNIPPET_MAX_LEN = 500;

/** `formatScore()` without color: `${(score*100).toFixed(0).padStart(3)}%`. */
function formatScore(score: number | undefined): string {
  return `${((score ?? 0) * 100).toFixed(0).padStart(3)}%`;
}

/** The row's `qmd://` identifier. The SDK already hands us the URI in
 * `filepath`; `displayPath` (`<collection>/<path>`) is the fallback because that
 * is exactly what the CLI feeds `buildVirtualPath()` for the default index. */
function qmdUri(hit: QmdHit): string {
  const fp = hit.filepath ?? '';
  if (fp.startsWith('qmd://')) return fp;
  const dp = hit.displayPath ?? fp;
  if (!dp) return hit.collectionName ? `qmd://${hit.collectionName}/` : 'qmd://';
  const prefixed = hit.collectionName && !dp.startsWith(`${hit.collectionName}/`);
  return `qmd://${prefixed ? `${hit.collectionName}/${dp}` : dp}`;
}

/** The CLI prints `:line` only when a query term survives in the snippet body
 * (the hunk header line is excluded from that test). */
function snippetHasTerm(snippet: string, query: string): boolean {
  const body = snippet.split('\n').slice(1).join('\n').toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .some((t) => t.length > 0 && body.includes(t));
}

/**
 * Local port of the qmd CLI's `extractSnippet()` (v2.8.3), minimal path: best
 * matching line ±1 line of context, rendered as the diff-style
 * `@@ -start,count @@ (before before, after after)` hunk the CLI prints.
 *
 * Deliberately without the `chunkPos` windowing and `intent` weighting: those
 * only apply to hybrid/vector hits, which this module never produces
 * (`searchLex` = FTS only, no `chunkPos`). When the SDK is loaded its own
 * `extractSnippet` is used instead, so parity holds regardless.
 */
export function extractSnippetLocal(
  body: string,
  query: string,
  maxLen = SNIPPET_MAX_LEN,
): { line: number; snippet: string } {
  const lines = body.split('\n');
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  let bestLine = 0;
  let bestScore = -1;
  for (let i = 0; i < lines.length; i++) {
    const lineLower = (lines[i] ?? '').toLowerCase();
    let score = 0;
    for (const term of terms) if (lineLower.includes(term)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }
  const start = Math.max(0, bestLine - 1);
  const end = Math.min(lines.length, bestLine + 3);
  const snippetLines = lines.slice(start, end);
  let snippetText = snippetLines.join('\n');
  if (snippetText.length > maxLen) snippetText = `${snippetText.substring(0, maxLen - 3)}...`;
  const absoluteStart = start + 1; // 1-indexed
  const linesBefore = absoluteStart - 1;
  const linesAfter = lines.length - (absoluteStart + snippetLines.length - 1);
  const header = `@@ -${absoluteStart},${snippetLines.length} @@ (${linesBefore} before, ${linesAfter} after)`;
  return { line: bestLine + 1, snippet: `${header}\n${snippetText}` };
}

/** One hit → its CLI block (no trailing separator). */
function formatHit(hit: QmdHit, query: string, opts: FormatOptions): string {
  const extracted = hit.body
    ? (opts.extractSnippet ?? extractSnippetLocal)(hit.body, query, SNIPPET_MAX_LEN)
    : undefined;
  const lineInfo = extracted && snippetHasTerm(extracted.snippet, query) ? `:${extracted.line}` : '';
  const docid = hit.docid ?? hit.hash?.slice(0, 6);
  const lines = [`${qmdUri(hit)}${lineInfo}${docid ? ` #${docid}` : ''}`];
  if (hit.title) lines.push(`Title: ${hit.title}`);
  if (hit.context) lines.push(`Context: ${hit.context}`);
  lines.push(`Score: ${formatScore(hit.score)}`);
  if (extracted) lines.push('', extracted.snippet);
  return lines.join('\n');
}

/**
 * Hits → the exact text the qmd CLI would have printed (already trimmed, i.e.
 * what the tool should return as `text`). Pure: no store, no I/O, no module
 * state — the two search paths and the unit tests all go through here.
 */
export function formatResults(hits: QmdHit[], query: string, opts: FormatOptions = {}): string {
  if (!hits || hits.length === 0) return NO_RESULTS;
  return hits.map((hit) => formatHit(hit, query, opts)).join('\n\n\n');
}

// ---------------------------------------------------------------------------
// Store acquisition (SDK import + cache)
// ---------------------------------------------------------------------------

/** The SDK pieces we use. */
interface QmdStore {
  searchLex(
    query: string,
    options?: { limit?: number; collection?: string | string[] },
  ): Promise<QmdHit[]>;
  close(): Promise<void>;
}
type QmdModule = {
  createStore(options: { dbPath: string }): Promise<QmdStore>;
  extractSnippet?: SnippetExtractor;
};

/** Everything the embedded path touches from the outside world, injectable so
 * the degradation rules (no SDK / no index / broken index) are testable without
 * a global qmd install. */
export interface QmdRuntime {
  dbPath(): string;
  fileExists(path: string): boolean;
  importModule(spec: string): Promise<unknown>;
}

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

const REAL_RUNTIME: QmdRuntime = {
  dbPath: qmdDbPath,
  fileExists: existsSync,
  importModule(spec: string): Promise<unknown> {
    // Dynamic import, not createRequire: qmd is a top-level-await ESM and sync
    // require throws ERR_REQUIRE_ASYNC_MODULE on it (observed). A bare
    // specifier resolves from our own tree; an absolute path needs a file://
    // URL on Windows.
    const target = /^[A-Za-z]:[\\/]/.test(spec) ? pathToFileURL(spec).href : spec;
    return import(target);
  },
};

/** Outcome of trying to stand up the embedded path. `no-index` is the actionable
 * soft error; `unavailable` means "spawn the CLI" (broken indexes are caught
 * later, when the search actually runs — see qmdSearchEmbedded). */
type StoreState =
  | { kind: 'ready'; store: QmdStore; dbPath: string; extractSnippet?: SnippetExtractor }
  | { kind: 'no-index'; dbPath: string }
  | { kind: 'unavailable'; reason: string };

/** Repair commands the user can actually run — `qmd index` does not exist;
 * `qmd init` (project-local index), `qmd collection add` + `qmd update` do. */
export function indexRepairMessage(dbPath: string): string {
  return [
    `qmd index is not usable: ${dbPath}`,
    'fix it with one of:',
    '  qmd collection add <docs-dir> --name <name>   # register a folder (once)',
    '  qmd update                                    # build / refresh the index',
    '  qmd init                                      # … or create a project-local .qmd index',
    '  qmd status                                    # verify',
    `or point QMD_INDEX_PATH at an existing index file (currently ${dbPath}).`,
  ].join('\n');
}

/** Errors sqlite/the SDK raise when the DB exists but cannot be queried. */
export function isIndexUnusableError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.message} ${(e as { code?: unknown }).code ?? ''}` : String(e);
  return /no such table|unable to open database|not a database|sqlite_cantopen|sqlite_notadb|no such module|malformed/i.test(
    msg,
  );
}

async function loadState(rt: QmdRuntime): Promise<StoreState> {
  const dbPath = rt.dbPath();
  if (!rt.fileExists(dbPath)) {
    dlog(`[fed-qmd] index not found at ${dbPath} — spawn fallback (retry in ${RETRY_AFTER_MS / 1000}s)`);
    return { kind: 'no-index', dbPath };
  }
  const failures: string[] = [];
  for (const spec of qmdCandidates()) {
    try {
      const mod = (await rt.importModule(spec)) as QmdModule & { default?: QmdModule };
      const api: QmdModule | undefined = typeof mod.createStore === 'function' ? mod : mod.default;
      if (!api || typeof api.createStore !== 'function') {
        failures.push(`${spec}: no createStore`);
        continue;
      }
      const t0 = Date.now();
      const store = await api.createStore({ dbPath });
      const extractSnippet =
        typeof mod.extractSnippet === 'function' ? mod.extractSnippet : mod.default?.extractSnippet;
      dlog(`[fed-qmd] in-process store ready (${dbPath}) in ${Date.now() - t0}ms`);
      return { kind: 'ready', store, dbPath, extractSnippet };
    } catch (e) {
      const why = clip(e instanceof Error ? e.message : String(e), 120);
      failures.push(`${spec}: ${why}`);
      dlog(`[fed-qmd] candidate ${spec} failed: ${why}`);
    }
  }
  dlog('[fed-qmd] no resolvable qmd SDK — spawn fallback (retry in 60s)');
  return { kind: 'unavailable', reason: failures.join(' | ') || 'no qmd SDK candidate' };
}

let cachedState: Promise<StoreState> | null = null;
let lastFailedAt = 0;
/** [R4 review] A failed/absent store must not be cached forever: the index may
 * be created (or the SDK installed) mid-session. Retry at most this often. */
const RETRY_AFTER_MS = 60_000;

/** Lazily resolve (and keep) the in-process store. `cache` is false for
 * injected runtimes so tests always see the real outcome. */
async function stateOf(rt: QmdRuntime, cache: boolean): Promise<StoreState> {
  if (!cache) return loadState(rt);
  if (cachedState) return cachedState;
  if (Date.now() - lastFailedAt < RETRY_AFTER_MS) return { kind: 'unavailable', reason: 'retry window' };
  const pending = loadState(rt).then((state) => {
    if (state.kind !== 'ready') {
      lastFailedAt = Date.now();
      cachedState = null; // [R4] transient failure: let a later call retry
    }
    return state;
  });
  cachedState = pending;
  return pending;
}

/** Close the embedded store (called from the same lifecycle hooks that tear
 * down the rest of the server, so the sqlite handle never leaks). */
export async function closeEmbeddedQmd(): Promise<void> {
  const state = await (cachedState ?? Promise.resolve(null));
  cachedState = null;
  if (!state || state.kind !== 'ready') return;
  try {
    // [review P3] a wedged sqlite close must not hold the exit path hostage
    await Promise.race([state.store.close(), new Promise((r) => setTimeout(r, 3000))]);
  } catch {/* already closed */}
}

// ---------------------------------------------------------------------------
// Search entry points
// ---------------------------------------------------------------------------

/** Text + soft-error flag, the shape federation.ts hands back to the tool. */
export interface QmdResult {
  text: string;
  isError: boolean;
}

/**
 * Embedded search, full contract: `null` means "not available, spawn the CLI";
 * otherwise the text is byte-identical to what the CLI would print and the only
 * `isError` outcomes are actionable soft errors (broken index), never a throw —
 * §3 of docs-selfdev/项目约束.md: 联邦工具永不 throw。
 *
 * NOTE (N5 scope): federation.ts still calls `qmdSearchInProcess()` below,
 * which maps an `isError` result back to `null` (spawn) and so keeps today's
 * routing untouched. Switching its call site to this function is a one-line
 * change owned by another task.
 */
export async function qmdSearchEmbedded(
  query: string,
  limit: number,
  collection?: string,
  runtime: QmdRuntime = REAL_RUNTIME,
): Promise<QmdResult | null> {
  const state = await stateOf(runtime, runtime === REAL_RUNTIME);
  if (state.kind === 'no-index') return { text: indexRepairMessage(state.dbPath), isError: true };
  if (state.kind === 'unavailable') return null;
  const t0 = Date.now();
  try {
    const hits = await state.store.searchLex(query, { limit, ...(collection ? { collection } : {}) });
    dlog(`[fed-qmd] searchLex ${Date.now() - t0}ms hits=${hits.length}`);
    return {
      text: formatResults(hits, query, { extractSnippet: state.extractSnippet }),
      isError: false,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A broken index is final — retrying via the CLI spawn would fail the same
    // way 293ms (or 30s) later, so answer with the repair commands instead.
    if (isIndexUnusableError(e)) {
      dlog(`[fed-qmd] index unusable: ${clip(msg, 200)}`);
      return { text: `${indexRepairMessage(state.dbPath)}\n\nlast error: ${msg}`, isError: true };
    }
    // Any other embedded failure must never break the tool: let the caller retry
    // through the CLI spawn (behavior unchanged from before N5).
    dlog(`[fed-qmd] searchLex failed: ${clip(msg, 200)} — spawn fallback`);
    return null;
  }
}

/** Compat wrapper for federation.ts: text, or `null` to fall back to spawning
 * the CLI (which is what a broken/absent index does today). `runtime` is only
 * for tests. */
export async function qmdSearchInProcess(
  query: string,
  limit: number,
  collection?: string,
  runtime: QmdRuntime = REAL_RUNTIME,
): Promise<string | null> {
  const r = await qmdSearchEmbedded(query, limit, collection, runtime);
  return r && !r.isError ? r.text : null;
}

/** Probe without running a child: embedded path is usable when both the SDK
 * resolves and the index file exists. */
export async function qmdEmbeddedAvailable(): Promise<boolean> {
  return (await stateOf(REAL_RUNTIME, true)).kind === 'ready';
}
