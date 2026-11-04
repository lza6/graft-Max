/**
 * 联邦结果缓存（federation.ts 的 T4 缓存 + N6 的 P3-4/P3-6 修复）。
 *
 * 这里测的是缓存本身，不打任何真实后端：`cacheKey` / `cacheGet` / `cachePut` /
 * `getFedCacheStats` 就是 `callFederatedTool` 内部用的同一批函数，用假时钟推进
 * 就能断言 TTL、LRU 淘汰、错误不缓存、键序无关这四件事。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cacheKey,
  cacheGet,
  cachePut,
  getFedCacheStats,
  resetFedStateForTest,
  setFedClock,
} from "../src/mcp/federation.js";

const ok = (text: string) => ({ text, isError: false });

test("P3-4 键序无关：同参数不同键序命中同一条", () => {
  resetFedStateForTest();
  cachePut(cacheKey("max_find_docs", { query: "q", limit: 3 }, "/repo"), ok("hello"));
  const hit = cacheGet(cacheKey("max_find_docs", { limit: 3, query: "q" }, "/repo"));
  assert.deepEqual(hit, ok("hello"));
  assert.equal(getFedCacheStats().hits, 1);
  assert.equal(getFedCacheStats().misses, 0);
});

test("P3-4 键序无关递归到嵌套对象，数组顺序仍然算数", () => {
  resetFedStateForTest();
  const a = cacheKey("t", { outer: { b: 2, a: 1 }, list: [1, 2] }, "/r");
  const b = cacheKey("t", { list: [1, 2], outer: { a: 1, b: 2 } }, "/r");
  assert.equal(a, b);
  // 数组顺序变了是不同的问题，必须分开缓存
  assert.notEqual(cacheKey("t", { list: [2, 1] }, "/r"), cacheKey("t", { list: [1, 2] }, "/r"));
  // undefined 值按 JSON 老规矩丢掉，不会把两条相等语义拆成两条
  assert.equal(cacheKey("t", { a: 1, b: undefined }, "/r"), cacheKey("t", { a: 1 }, "/r"));
  // 不同 root 是不同缓存
  assert.notEqual(cacheKey("t", { a: 1 }, "/r1"), cacheKey("t", { a: 1 }, "/r2"));
});

test("TTL：60s 内命中，推进 61s 后未命中并重新执行", () => {
  resetFedStateForTest();
  let now = 1_000_000;
  setFedClock(() => now);
  const k = cacheKey("max_trace_arch", { query: "x" }, "/repo");
  cachePut(k, ok("v1"));
  assert.deepEqual(cacheGet(k), ok("v1"));
  now += 60_000; // TTL 边界内
  assert.deepEqual(cacheGet(k), ok("v1"));
  now += 1_000; // 61s：过期
  assert.equal(cacheGet(k), null);
  const s = getFedCacheStats();
  assert.equal(s.hits, 2);
  assert.equal(s.misses, 1);
  assert.equal(s.size, 0, "过期条目必须从表里删掉，不能只是返回 null");
});

test("错误结果不进缓存（isError 的重试必须真的重试）", () => {
  resetFedStateForTest();
  const k = cacheKey("max_find_docs", { query: "boom" }, "/repo");
  cachePut(k, { text: "后端挂了", isError: true });
  assert.equal(cacheGet(k), null);
  assert.equal(getFedCacheStats().size, 0);
});

test("LRU/容量上限：33 条起淘汰最旧的，size 不超 32，evictions 递增", () => {
  resetFedStateForTest();
  for (let i = 0; i < 40; i++) cachePut(cacheKey("t", { i }, "/r"), ok(`v${i}`));
  const s = getFedCacheStats();
  assert.equal(s.size, 32);
  assert.equal(s.evictions, 8);
  assert.equal(cacheGet(cacheKey("t", { i: 0 }, "/r")), null, "最旧的应被淘汰");
  assert.deepEqual(cacheGet(cacheKey("t", { i: 39 }, "/r")), ok("v39"), "最新的还在");
});

test("LRU：命中会刷新位置，最久没用的才被淘汰", () => {
  resetFedStateForTest();
  for (let i = 0; i < 32; i++) cachePut(cacheKey("t", { i }, "/r"), ok(`v${i}`));
  // 把最旧的一条读一次（它变成最新的），再塞一条触发淘汰
  assert.deepEqual(cacheGet(cacheKey("t", { i: 0 }, "/r")), ok("v0"));
  cachePut(cacheKey("t", { i: 32 }, "/r"), ok("v32"));
  assert.deepEqual(cacheGet(cacheKey("t", { i: 0 }, "/r")), ok("v0"), "刚用过的不该被淘汰");
  assert.equal(cacheGet(cacheKey("t", { i: 1 }, "/r")), null, "次旧的应被淘汰");
});

test("P3-6 getFedCacheStats 随操作变化", () => {
  resetFedStateForTest();
  assert.deepEqual(getFedCacheStats(), { hits: 0, misses: 0, evictions: 0, size: 0 });
  const k = cacheKey("t", { a: 1 }, "/r");
  assert.equal(cacheGet(k), null); // miss
  cachePut(k, ok("v"));
  assert.deepEqual(cacheGet(k), ok("v")); // hit
  const s = getFedCacheStats();
  assert.deepEqual(s, { hits: 1, misses: 1, evictions: 0, size: 1 });
});
