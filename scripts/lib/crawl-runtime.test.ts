import test from "node:test";
import assert from "node:assert/strict";
import { mapConcurrent, assertCoverage, assertSnapshot, assertApprovedRemovals } from "./crawl-runtime.ts";

test("worker pool accounts for 10,000 outcomes without exceeding concurrency", async () => {
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 10_000 }, (_, i) => ({ domain: `domain-${i}.io` }));
  const actual = await mapConcurrent(items, 50, async (item) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return item;
  });
  assert.equal(peak, 50);
  assert.equal(active, 0);
  assertCoverage(items, actual);
  assert.deepEqual(actual, items);
});

test("worker failure is propagated only after in-flight workers settle", async () => {
  let settled = false;
  await assert.rejects(mapConcurrent([0, 1, 2], 2, async (i) => {
    if (i === 0) throw new Error("worker failed");
    await new Promise((resolve) => setTimeout(resolve, 10));
    settled = true;
    return i;
  }), /worker failed/);
  assert.equal(settled, true);
});

test("coverage rejects empty, partial, extra and duplicate output", () => {
  const rows = [{ domain: "a.io" }, { domain: "b.io" }];
  for (const output of [[], [rows[0]], [rows[0], rows[0]], [rows[0], { domain: "c.io" }]]) {
    assert.throws(() => assertCoverage(rows, output));
  }
  assert.throws(() => assertCoverage([], []));
});

test("concurrency controls reject invalid values", async () => {
  for (const n of [0, -1, 1.5, NaN, 101]) await assert.rejects(mapConcurrent([1], n, async (i) => i));
  assert.deepEqual(await mapConcurrent([], 1, async (i) => i), []);
});

test("snapshot validation preserves historical aggregate counts while rejecting data loss", () => {
  const snapshot = { generated_at: "2026-09-20T00:00:00Z", total: 1, verified: 0, unclaimed: 1,
    entries: [{ domain: "a.io", status: "unclaimed", intent_count: 7, intents: [] }] };
  assertSnapshot(snapshot);
  for (const invalid of [null, {}, { ...snapshot, entries: [] }, { ...snapshot, total: 2 },
    { ...snapshot, entries: [snapshot.entries[0], snapshot.entries[0]] },
    { ...snapshot, entries: [{ ...snapshot.entries[0], status: "trusted" }] },
    { ...snapshot, entries: [{ ...snapshot.entries[0], intent_count: -1 }] }]) assert.throws(() => assertSnapshot(invalid));
});

test("any snapshot removal requires an exact explicit approval", () => {
  const previous = [{ domain: "a.io" }, { domain: "b.io" }];
  assert.throws(() => assertApprovedRemovals(previous, [previous[0]], new Set()));
  assert.throws(() => assertApprovedRemovals(previous, [previous[0]], new Set(["*"])));
  assertApprovedRemovals(previous, [previous[0]], new Set(["b.io"]));
});
