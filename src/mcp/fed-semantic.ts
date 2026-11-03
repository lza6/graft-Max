/**
 * [graft-Max T5] max_search_semantic — cocoindex-code (`ccc`) semantic code
 * search as the 9th federated tool.
 *
 * Natural-language → code meaning, complementing the symbol graph (graft_ask,
 * structural) and BM25 docs (max_find_docs, prose). Backend: the `ccc` CLI,
 * which runs local sentence-transformers embeddings (snowflake-arctic-embed-xs
 * by default) — $0, offline, no API key, satisfying the paid-API red line.
 *
 * Design follows federation.ts's rules: never throws (soft isError), hard
 * timeout, probe-gated (tool hidden when `ccc` is absent or the repo isn't
 * indexed — zero schema cost), additive registration. Query goes through the
 * same runCli two-stage Windows shim resolver as the other federated tools.
 *
 * ccc search has no repo argument: it works on the CWD's project (its
 * `.cocoindex_code/` settings). The MCP server passes the repo root as cwd.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dlog, clip } from './devlog.js';
import { runCli } from './federation.js';

export const CCC_BACKEND = {
  probeCmd: ['ccc', ['--help']] as [string, string[]],
  installHint: 'install cocoindex-code: pip install cocoindex-code (then, per repo: ccc init && ccc index)',
};

/** The repo is indexed when its ccc settings dir exists (`ccc init` wrote it). */
export function cccIndexed(root: string): boolean {
  return existsSync(join(root, '.cocoindex_code'));
}

/** JSON shape of `ccc search --json` (the fields we read). */
interface CccResult {
  file_path: string;
  language?: string;
  content: string;
  start_line: number;
  end_line: number;
  score: number;
}

/** Run one semantic search; every failure is a soft isError answer. */
export async function runSemanticSearch(
  args: Record<string, unknown>,
  root: string,
): Promise<{ text: string; isError: boolean }> {
  const query = String(args.query ?? '').trim();
  if (!query) return { text: 'max_search_semantic requires a query', isError: true };
  const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit >= 1 ? Math.min(Math.floor(args.limit), 20) : 5;
  const cArgs = ['search', query, '--limit', String(limit), '--json'];
  if (typeof args.lang === 'string' && args.lang) cArgs.push('--lang', args.lang);
  if (typeof args.path === 'string' && args.path) cArgs.push('--path', args.path);
  const t0 = Date.now();
  const r = await runCli('ccc', cArgs, 60_000, root);
  dlog(`[fed] ccc search ${Date.now() - t0}ms ok=${r.ok} out=${clip(r.out, 120)}`);
  if (!r.ok && !r.out.trim()) {
    return { text: `graft-Max federation: semantic search unavailable — ${CCC_BACKEND.installHint}${r.err.trim() ? ` (${clip(r.err, 200)})` : ''}`, isError: true };
  }
  let parsed: { results?: CccResult[]; success?: boolean };
  try {
    parsed = JSON.parse(r.out.trim().split('\n').filter((l) => l.startsWith('{')).join('\n') || '{}');
  } catch {
    // Non-JSON output (daemon first-boot messages etc.): pass the readable text through.
    return { text: r.out.trim() || r.err.trim() || `no hits for: ${query}`, isError: !r.ok };
  }
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  if (!results.length) return { text: `no hits for: ${query}`, isError: false };
  const text = results
    .map((x) => {
      const span = x.end_line > x.start_line ? `L${x.start_line}-${x.end_line}` : `L${x.start_line}`;
      const head = `${x.file_path}:${span}${x.language ? ` (${x.language})` : ''} score=${(x.score ?? 0).toFixed(2)}`;
      return `${head}\n${clip((x.content ?? '').trim(), 500)}`;
    })
    .join('\n\n');
  return { text, isError: false };
}

/** The tool definition, registered alongside the other federated tools. */
export const SEMANTIC_TOOL = {
  name: 'max_search_semantic',
  description:
    'Semantic (embedding) code search over the CURRENT repo: finds code by MEANING, not keywords — "where do we retry with backoff", "input validation before parse". Complements max_find_code (exact symbols) and max_find_docs (prose). Requires the repo indexed once with `ccc init` + `ccc index` (free, local, no API key).',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'what the code should DO, in plain words (any language)' },
      limit: { type: 'number', description: 'max results, 1-20 (default 5)' },
      lang: { type: 'string', description: 'filter by language, e.g. python, typescript' },
      path: { type: 'string', description: 'filter by file path glob' },
    },
    required: ['query'],
  },
} as const;
