import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assertSyncReceipt, syncPublishedSnapshot } from "./sync.ts";

const expected = { commit: "a".repeat(40), generated_at: "2026-09-20T20:00:00.000Z", total: 9 };
const receipt = {
  snapshot_commit: expected.commit,
  snapshot_generated_at: expected.generated_at,
  total_snapshot_entries: expected.total,
  synced: 7, skipped: 2, errors: 0, unattempted: 0,
};
const base = { secret: "test-secret", readPublished: async () => expected };

test("sync is bound to an immutable publication and requires a complete matching receipt", async () => {
  const value = await syncPublishedSnapshot({ ...base, fetch: async (url, init) => {
    assert.equal(String(url), "https://agentinternetruntime.com/api/directory/sync");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-secret");
    assert.equal(init?.signal?.aborted, false);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      triggered_by: "directory-reconciliation", expected_commit: expected.commit,
      expected_generated_at: expected.generated_at, expected_total: expected.total,
    });
    return Response.json(receipt);
  } });
  assert.deepEqual(value, receipt);
});

test("receipts reject missing, negative, fractional, partial and mismatched accounting", () => {
  const bad = [
    null, [], {}, { ...receipt, errors: undefined }, { ...receipt, skipped: -1 },
    { ...receipt, synced: 7.5 }, { ...receipt, unattempted: undefined },
    { ...receipt, synced: 6 }, { ...receipt, synced: 6, errors: 1 },
    { ...receipt, synced: 6, unattempted: 1 }, { ...receipt, total_snapshot_entries: 10 },
    { ...receipt, snapshot_commit: "b".repeat(40) },
    { ...receipt, snapshot_generated_at: "2026-09-19T20:00:00.000Z" },
    { ...receipt, synced: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const value of bad) assert.throws(() => assertSyncReceipt(value, expected));
  assertSyncReceipt(receipt, expected);
});

test("missing configuration and unsafe URLs fail before reading or sending anything", async () => {
  const readPublished = async () => { throw new Error("Should not read"); };
  await assert.rejects(syncPublishedSnapshot({ secret: "", readPublished }), /SECRET is required/);
  for (const url of ["http://agentinternetruntime.com/api/directory/sync", "https://user:pass@vendor.io/", "https://vendor.io/#fragment", "broken"]) {
    await assert.rejects(syncPublishedSnapshot({ secret: "test", url, readPublished }), /HTTPS|Invalid URL/);
  }
});

test("partial success, malformed JSON, oversized receipt and failed HTTP never return success", async () => {
  for (const response of [
    new Response("untrusted detail", { status: 500 }), new Response("no", { status: 401 }),
    new Response("redirect", { status: 302 }), new Response(null, { status: 204 }),
    new Response("not JSON"), new Response(" ".repeat(32_769)),
    Response.json({ ...receipt, synced: 6, errors: 1 }),
  ]) {
    await assert.rejects(syncPublishedSnapshot({ ...base, fetch: async () => response }));
  }
  await assert.rejects(syncPublishedSnapshot({ ...base, fetch: async () => { throw new DOMException("timeout", "TimeoutError"); } }), /timeout/);
});

test("bad publication metadata never reaches the webhook", async () => {
  for (const value of [{ ...expected, commit: "main" }, { ...expected, total: 0 }, { ...expected, generated_at: "invalid" }]) {
    await assert.rejects(syncPublishedSnapshot({ ...base, readPublished: async () => value, fetch: async () => {
      throw new Error("Should not send");
    } }), /Invalid published revision/);
  }
});

test("the deadline includes a stalled response body", async () => {
  let cancelled = false;
  const keepAlive = setTimeout(() => {}, 1000);
  const started = Date.now();
  try {
    await assert.rejects(syncPublishedSnapshot({ ...base, timeoutMs: 20, fetch: async () => new Response(new ReadableStream({
      cancel() { cancelled = true; },
    })) }), { name: "TimeoutError" });
    assert.equal(cancelled, true);
    assert.ok(Date.now() - started < 1000);
  } finally { clearTimeout(keepAlive); }
  for (const timeoutMs of [0, -1, 90_001, NaN]) {
    await assert.rejects(syncPublishedSnapshot({ ...base, timeoutMs }), /Invalid sync timeout/);
  }
});

test("crawler handoff reads exactly its commit and rejects partial or mismatched metadata", { concurrency: false }, async () => {
  const keys = ["SYNC_SNAPSHOT_COMMIT", "SYNC_SNAPSHOT_GENERATED_AT", "SYNC_SNAPSHOT_TOTAL"] as const;
  const oldEnv = keys.map((key) => process.env[key]);
  const oldFetch = globalThis.fetch;
  const snapshot = { generated_at: expected.generated_at, total: 1, verified: 0, unclaimed: 1,
    entries: [{ domain: "api.vendor.io", status: "unclaimed", intent_count: 0, intents: [] }] };
  let reads = 0;
  try {
    process.env.SYNC_SNAPSHOT_COMMIT = expected.commit;
    process.env.SYNC_SNAPSHOT_GENERATED_AT = expected.generated_at;
    process.env.SYNC_SNAPSHOT_TOTAL = "1";
    globalThis.fetch = async (input) => {
      reads++;
      assert.ok(String(input).endsWith(`/contents/registry/snapshot.json?ref=${expected.commit}`));
      return Response.json({ sha: "blob", content: Buffer.from(JSON.stringify(snapshot)).toString("base64"), encoding: "base64" });
    };
    const fetch = async () => Response.json({ ...receipt, total_snapshot_entries: 1, synced: 1, skipped: 0 });
    await syncPublishedSnapshot({ secret: "test", fetch });
    assert.equal(reads, 1);
    process.env.SYNC_SNAPSHOT_TOTAL = "2";
    await assert.rejects(syncPublishedSnapshot({ secret: "test", fetch }), /differs from crawler handoff/);
    delete process.env.SYNC_SNAPSHOT_TOTAL;
    await assert.rejects(syncPublishedSnapshot({ secret: "test", fetch }), /Incomplete publication handoff/);
    assert.equal(reads, 2);
  } finally {
    globalThis.fetch = oldFetch;
    keys.forEach((key, i) => oldEnv[i] === undefined ? delete process.env[key] : process.env[key] = oldEnv[i]);
  }
});

test("sync-only CLI fails visibly and workflow isolates publisher from sync credentials", () => {
  const result = spawnSync(process.execPath, ["scripts/sync.ts"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 5000,
    env: { ...process.env, SYNC_WEBHOOK_SECRET: "" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SECRET is required/);
  const workflow = readFileSync(new URL("../.github/workflows/nightly-crawl.yml", import.meta.url), "utf8");
  assert.match(workflow, /if: inputs.mode != 'sync-only'/);
  const crawlerStep = workflow.split("- name: Run crawler")[1].split("- name: Reconcile published snapshot")[0];
  assert.doesNotMatch(crawlerStep, /SYNC_WEBHOOK/);
  const syncStep = workflow.split("- name: Reconcile published snapshot")[1];
  assert.match(syncStep, /run: node scripts\/sync.ts/);
  assert.match(syncStep, /SYNC_SNAPSHOT_COMMIT: \$\{\{ steps\.publish\.outputs\.snapshot_commit \}\}/);
  assert.doesNotMatch(syncStep, /DIRECTORY_GITHUB_TOKEN|continue-on-error/);
});
