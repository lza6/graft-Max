/**
 * N5 / P1-4: the embedded qmd path must return *the same bytes* the qmd CLI
 * prints, so an agent that learned one shape isn't broken by the other path.
 *
 * The contract baseline is `test/fixtures/qmd-cli-sample.txt` — a real,
 * unmodified CLI run captured on this machine:
 *
 *     qmd search "逆向" -n 2 > test/fixtures/qmd-cli-sample.txt     # qmd 2.8.3
 *
 * (deterministic: two consecutive runs are byte-identical). The tests below
 * rebuild the two documents from that fixture — header/title/score lines are
 * taken verbatim, and the bodies are the fixture's own snippet lines padded to
 * the line counts its `@@ -start,count @@ (before before, after after)` hunk
 * header reports — then assert `formatResults()` reproduces the whole file,
 * character for character. No qmd install, no index, no network: the fake store
 * injects hits the same way the SDK would.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  NO_RESULTS,
  formatResults,
  extractSnippetLocal,
  indexRepairMessage,
  isIndexUnusableError,
  qmdSearchEmbedded,
  qmdSearchInProcess,
  type QmdHit,
  type QmdRuntime,
} from '../src/mcp/fed-qmd.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/qmd-cli-sample.txt', import.meta.url));
/** The query the fixture was captured with. */
const QUERY = '逆向';

const HEADER_RE = /^qmd:\/\/(.+?):(\d+) #(\S+)$/;
const HUNK_RE = /^@@ -(\d+),(\d+) @@ \((\d+) before, (\d+) after\)$/;
const SCORE_RE = /^Score: +(\d+)%$/;

/** One block of the CLI sample, parsed without assuming fixed widths. */
interface SampleBlock {
  header: string;
  displayPath: string;
  line: number;
  docid: string;
  title: string;
  scorePct: number;
  snippetLines: string[];
  linesBefore: number;
  linesAfter: number;
}

function parseSample(text: string): SampleBlock[] {
  const lines = text.replace(/\n+$/, '').split('\n');
  const starts = lines.flatMap((l, i) => (HEADER_RE.test(l) ? [i] : []));
  return starts.map((start, idx) => {
    const block = lines.slice(start, idx + 1 < starts.length ? starts[idx + 1] : lines.length);
    while (block.length > 0 && block[block.length - 1] === '') block.pop(); // the CLI's 2 blank separators
    const header = block[0] ?? '';
    const m = HEADER_RE.exec(header);
    assert.ok(m, `unparseable header in fixture: ${header}`);
    const scoreLine = block.find((l) => SCORE_RE.test(l));
    assert.ok(scoreLine, `no Score line in fixture block: ${header}`);
    const hunkIdx = block.findIndex((l) => HUNK_RE.test(l));
    assert.ok(hunkIdx > 0, `no snippet hunk in fixture block: ${header}`);
    const h = HUNK_RE.exec(block[hunkIdx] ?? '');
    assert.ok(h);
    return {
      header,
      displayPath: m[1] ?? '',
      line: Number(m[2]),
      docid: m[3] ?? '',
      title: (block[1] ?? '').replace(/^Title: /, ''),
      scorePct: Number(SCORE_RE.exec(scoreLine)?.[1] ?? '0'),
      snippetLines: block.slice(hunkIdx + 1),
      linesBefore: Number(h[3]),
      linesAfter: Number(h[4]),
    };
  });
}

/**
 * Rebuild the document a sample block came from: the snippet's own lines in
 * place, padded with filler so the line counts match the hunk header. Filler
 * never contains a query term, so best-line selection stays on line 1 exactly
 * as it did for the CLI.
 */
function bodyFor(b: SampleBlock): string {
  const snippetStart = b.linesBefore + 1;
  const total = snippetStart + b.snippetLines.length - 1 + b.linesAfter;
  const head = Array.from({ length: snippetStart - 1 }, (_, i) => `filler line ${i + 1}`);
  const tail = Array.from(
    { length: b.linesAfter },
    (_, i) => `filler line ${snippetStart + b.snippetLines.length + i}`,
  );
  return [...head, ...b.snippetLines, ...tail].join('\n');
}

const SAMPLE = parseSample(readFileSync(FIXTURE, 'utf8'));

/** The two hits the CLI printed, in the order it printed them. */
const SAMPLE_HITS: QmdHit[] = SAMPLE.map((b) => ({
  filepath: `qmd://${b.displayPath}`,
  displayPath: b.displayPath,
  docid: b.docid,
  title: b.title,
  collectionName: b.displayPath.split('/')[0],
  context: null,
  body: bodyFor(b),
  score: b.scorePct / 100,
}));

/** Expected tool text: the CLI's stdout minus its trailing newline — exactly
 * what federation.ts hands to the agent (the spawn path does `r.out.trim()`). */
const EXPECTED = readFileSync(FIXTURE, 'utf8').replace(/\n+$/, '');

// ---------------------------------------------------------------------------
// 1. The contract: byte-identical to the real CLI
// ---------------------------------------------------------------------------

test('fixture is a real 2-hit CLI sample we can lean on', () => {
  assert.equal(SAMPLE.length, 2, 'expected the captured sample to hold 2 hits');
  assert.equal(SAMPLE[0]?.line, 1);
  assert.equal(SAMPLE[1]?.line, 1);
});

test('formatResults reproduces the CLI sample character for character', () => {
  assert.equal(formatResults(SAMPLE_HITS, QUERY), EXPECTED);
});

test('every hit line follows the qmd://<collection>/<path>:<line> #<docid> contract', () => {
  const out = formatResults(SAMPLE_HITS, QUERY).split('\n');
  const headers = out.filter((l) => l.startsWith('qmd://'));
  assert.deepEqual(headers, SAMPLE.map((b) => b.header));
  for (const h of headers) assert.match(h, /^qmd:\/\/rules\/.+:\d+ #[0-9a-f]{6}$/);
});

test('title and score lines match the CLI (score is a 3-wide percentage)', () => {
  const out = formatResults(SAMPLE_HITS, QUERY).split('\n');
  assert.deepEqual(out.filter((l) => l.startsWith('Title: ')), SAMPLE.map((b) => `Title: ${b.title}`));
  assert.deepEqual(out.filter((l) => l.startsWith('Score: ')), ['Score:   0%', 'Score:   0%']);
  // 0.82 → " 82%", 0.005 → "  1%": same rounding the CLI does, no trailing space games
  assert.equal(formatResults([{ ...SAMPLE_HITS[0], score: 0.82, body: undefined }], QUERY).split('\n').at(-1), 'Score:  82%');
});

test("the SDK's own extractSnippet is preferred when the runtime provides it", () => {
  // Same algorithm, injected the way the embedded path injects the SDK's export.
  const out = formatResults(SAMPLE_HITS, QUERY, { extractSnippet: extractSnippetLocal });
  assert.equal(out, EXPECTED);
});

test('a hit with no body keeps header/title/score and drops snippet + :line', () => {
  const out = formatResults([{ ...SAMPLE_HITS[0], body: undefined }], QUERY);
  // no body → no snippet → nothing to anchor a line on, so the CLI's conditional
  // `:line` is absent (it is derived from the snippet, not from the row)
  assert.deepEqual(out.split('\n'), [
    `qmd://${SAMPLE[0]?.displayPath} #${SAMPLE[0]?.docid}`,
    `Title: ${SAMPLE[0]?.title}`,
    'Score:   0%',
  ]);
});

// ---------------------------------------------------------------------------
// 2. Empty results are a clean answer, not an error
// ---------------------------------------------------------------------------

test('no hits → the CLI\'s own empty sentence, no error flag', async () => {
  assert.equal(formatResults([], QUERY), NO_RESULTS);
  assert.equal(NO_RESULTS, 'No results found.');
  const r = await qmdSearchEmbedded(QUERY, 5, undefined, fakeRuntime(async () => []));
  assert.deepEqual(r, { text: 'No results found.', isError: false });
});

// ---------------------------------------------------------------------------
// 3. Degradation rules stay as they were (§3: 永不 throw)
// ---------------------------------------------------------------------------

/** A runtime whose SDK candidates all blow up on import. */
const NO_SDK: QmdRuntime = {
  dbPath: () => 'C:/tmp/index.sqlite',
  fileExists: () => true,
  importModule: async (spec) => {
    throw new Error(`ERR_MODULE_NOT_FOUND: Cannot find package '${spec}'`);
  },
};

function fakeRuntime(searchLex: (q: string, o?: unknown) => Promise<QmdHit[]>, mod: Record<string, unknown> = {}) {
  const store = { searchLex, close: async () => {} };
  const rt: QmdRuntime = {
    dbPath: () => 'C:/tmp/index.sqlite',
    fileExists: () => true,
    importModule: async () => ({ createStore: async () => store, ...mod }),
  };
  return rt;
}

test('SDK not resolvable → null, i.e. the caller spawns the CLI (behavior unchanged)', async () => {
  assert.equal(await qmdSearchEmbedded(QUERY, 5, undefined, NO_SDK), null);
  // the compat wrapper federation.ts calls maps every non-ready outcome to
  // "spawn the CLI", which is exactly what it did before N5.
  assert.equal(await qmdSearchInProcess(QUERY, 5, undefined, NO_SDK), null);
});

test('index file absent → actionable soft error, never a throw', async () => {
  const rt: QmdRuntime = { ...NO_SDK, fileExists: () => false };
  const r = await qmdSearchEmbedded(QUERY, 5, undefined, rt);
  assert.ok(r && r.isError === true);
  assert.match(r.text, /qmd update/);
  assert.match(r.text, /qmd collection add/);
  assert.match(r.text, /C:\/tmp\/index\.sqlite/);
  // the compat wrapper turns it back into a spawn fallback: routing untouched
  assert.equal(await qmdSearchInProcess(QUERY, 5, undefined, rt), null);
});

test('broken index (sqlite "no such table") → soft error with the repair commands', async () => {
  const rt = fakeRuntime(async () => {
    throw new Error('SqliteError: no such table: documents_fts');
  });
  const r = await qmdSearchEmbedded(QUERY, 5, undefined, rt);
  assert.ok(r && r.isError === true);
  assert.match(r.text, /qmd update/);
  assert.match(r.text, /no such table: documents_fts/);
  assert.equal(isIndexUnusableError(new Error('unable to open database file')), true);
  assert.equal(isIndexUnusableError(new Error('boom: unrelated')), false);
});

test('any other embedded failure → null (spawn fallback), not a throw', async () => {
  const rt = fakeRuntime(async () => {
    throw new Error('boom: unrelated');
  });
  assert.equal(await qmdSearchEmbedded(QUERY, 5, undefined, rt), null);
});

test('repair text names commands that exist in the CLI', () => {
  const msg = indexRepairMessage('C:/x/index.sqlite');
  assert.match(msg, /qmd update/);
  assert.match(msg, /qmd collection add/);
  assert.match(msg, /qmd init/);
  assert.doesNotMatch(msg, /^ {2}qmd index$/m, '`qmd index` is not a command this CLI has');
});

// ---------------------------------------------------------------------------
// 4. The store seam feeds the same formatter (one code path, C5)
// ---------------------------------------------------------------------------

test('qmdSearchEmbedded → same bytes as the CLI for a store that returns the sample hits', async () => {
  const seen: Array<{ q: string; o?: unknown }> = [];
  const rt = fakeRuntime(async (q, o) => {
    seen.push({ q, o });
    return SAMPLE_HITS;
  });
  const r = await qmdSearchEmbedded(QUERY, 2, 'rules', rt);
  assert.deepEqual(r, { text: EXPECTED, isError: false });
  assert.deepEqual(seen, [{ q: QUERY, o: { limit: 2, collection: 'rules' } }]);
});

test('limit/collection reach the SDK exactly as the CLI flags would', async () => {
  const seen: unknown[] = [];
  const rt = fakeRuntime(async (_q, o) => {
    seen.push(o);
    return [];
  });
  await qmdSearchEmbedded(QUERY, 3, undefined, rt);
  assert.deepEqual(seen, [{ limit: 3 }]);
});

test('an SDK missing its extractSnippet export still produces the CLI shape', async () => {
  const rt = fakeRuntime(async () => SAMPLE_HITS); // no extractSnippet on the fake module
  const r = await qmdSearchEmbedded(QUERY, 2, undefined, rt);
  assert.equal(r?.text, EXPECTED);
});
