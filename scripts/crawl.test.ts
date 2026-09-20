import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

process.env.GITHUB_TOKEN = "offline-test-token";
const { crawlAll, parseCrawlOptions, main, githubCommitFilesAtomically } = await import("./crawl.ts");
const row = { domain: "api.vendor.io", status: "unclaimed" as const, source: "self", added_date: "2026-09-20" };

test("unexpected crawl exceptions fail the run instead of dropping a domain", async () => {
  await assert.rejects(crawlAll([row], new Map(), { crawl: async () => { throw new Error("extract failed"); } }), /extract failed/);
});

test("ordinary failures preserve existing metadata under the original demotion policy", async () => {
  const prior = { ...JSON.parse(readFileSync(new URL("../registry/snapshot.json", import.meta.url), "utf8")).entries[0],
    domain: row.domain, status: "verified", consecutive_failures: 0, display_name: "Preserve me" };
  const [result] = await crawlAll([row], new Map([[row.domain, prior]]), { crawl: async () => ({ success: false, error: "timeout" }) });
  assert.equal(result.status, "verified");
  assert.equal(result.display_name, "Preserve me");
  assert.equal(result.consecutive_failures, 1);
});

test("partial runs require explicit dry-run mode", async () => {
  for (const args of [["--limit", "10"], ["--dry-run", "--limit", "0"], ["--unknown"], ["--limit"]]) assert.throws(() => parseCrawlOptions(args));
  assert.deepEqual(parseCrawlOptions(["--dry-run", "--limit", "10"]), { dryRun: true, limit: 10 });
  await assert.rejects(main({ dryRun: false, limit: 1 }), /cannot publish/);
});

test("read-only canary cannot invoke GitHub, enrichment or sync", { concurrency: false }, async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Unexpected external API call in dry run"); };
  let crawled = 0;
  try {
    await main({ dryRun: true, limit: 3 }, async (domain) => { crawled++; return { success: true, manifest: { version: "1.3", origin: domain, payout_address: "wallet" } }; });
    assert.equal(crawled, 3);
  } finally { globalThis.fetch = previous; }
});

test("all-failed canaries fail even if prior verified statuses are retained", async () => {
  await assert.rejects(main({ dryRun: true, limit: 3 }, async () => ({ success: false, error: "blocked_address" })), /health gate failed/);
});

test("malformed payment metadata is rejected before extraction and preserves prior data", async () => {
  const { validateManifest } = await import("./lib/manifest.ts");
  const prior = { ...JSON.parse(readFileSync(new URL("../registry/snapshot.json", import.meta.url), "utf8")).entries[0],
    domain: row.domain, status: "verified", consecutive_failures: 0, display_name: "Keep me" };
  for (const protocol of ["custom", "l402", "mpp"]) {
    const value = { version: "1.3", origin: row.domain, payout_address: "wallet", payments: { [protocol]: { networks: [null] } } };
    const result = validateManifest(value, row.domain);
    assert.equal(result.success, false);
    const output = await crawlAll([row], new Map([[row.domain, prior]]), { crawl: async () => result });
    assert.equal(output[0].display_name, "Keep me");
    assert.equal(output.length, 1);
  }
});

test("CLI exits nonzero if its awaited main promise never settles", () => {
  const preload = "data:text/javascript," + encodeURIComponent("globalThis.fetch = () => new Promise(() => {});");
  const result = spawnSync(process.execPath, ["--import", preload, "scripts/crawl.ts"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 5000,
    env: { ...process.env, GITHUB_TOKEN: "offline-test-token" },
  });
  assert.equal(result.status, 13, result.stderr);
  assert.doesNotMatch(result.stdout, /Registry committed successfully/);
});

test("atomic publication retries a conflicting head without losing remote rows", { concurrency: false }, async () => {
  const previous = globalThis.fetch;
  let heads = 0;
  let updates = 0;
  const built: string[] = [];
  const payloads: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (url.includes("/git/ref/")) return json({ object: { sha: `head-${++heads}` } });
    if (url.includes("/contents/")) return json({ content: Buffer.from(`remote-${heads}`).toString("base64"), encoding: "base64", sha: `file-${heads}` });
    if (url.includes("/git/commits/") && !init?.method) return json({ tree: { sha: "tree" } });
    if (url.endsWith("/git/blobs")) { payloads.push(JSON.parse(String(init?.body))); return json({ sha: "blob" }); }
    if (url.endsWith("/git/trees")) return json({ sha: "tree-next" });
    if (url.endsWith("/git/commits")) return json({ sha: "commit-next" });
    if (url.includes("/git/refs/")) {
      assert.equal(JSON.parse(String(init?.body)).force, false);
      return json({}, ++updates === 1 ? 409 : 200);
    }
    throw new Error(`Unexpected API: ${url}`);
  };
  try {
    assert.equal(await githubCommitFilesAtomically(["registry/domains.txt"], "test", (files) => {
      const content = files.get("registry/domains.txt")!.content + "\nnew-row";
      built.push(content);
      return [{ path: "registry/domains.txt", content }];
    }, 2), true);
    assert.deepEqual(built, ["remote-1\nnew-row", "remote-2\nnew-row"]);
    assert.equal(payloads.length, 2);
  } finally { globalThis.fetch = previous; }
});

test("PR workflow is unprivileged and nightly uses awaited native execution", () => {
  const checks = readFileSync(new URL("../.github/workflows/registry-checks.yml", import.meta.url), "utf8");
  assert.match(checks, /pull_request:/);
  assert.match(checks, /contents: read/);
  assert.doesNotMatch(checks, /pull_request_target|secrets\.|contents: write/);
  const nightly = readFileSync(new URL("../.github/workflows/nightly-crawl.yml", import.meta.url), "utf8");
  assert.match(nightly, /cancel-in-progress: false/);
  assert.match(nightly, /run: node scripts\/crawl.ts/);
  assert.doesNotMatch(nightly, /npx tsx|npm install -g/);
});

test("rejected publication preconditions never write Git objects", { concurrency: false }, async () => {
  const previous = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = async (input, init) => {
    if (init?.method) { writes++; throw new Error("Unexpected write"); }
    if (String(input).includes("/git/ref/")) return Response.json({ object: { sha: "head" } });
    return Response.json({ content: Buffer.from("remote").toString("base64"), encoding: "base64", sha: "file" });
  };
  try {
    await assert.rejects(githubCommitFilesAtomically(["registry/domains.txt"], "test", () => { throw new Error("incomplete coverage"); }), /incomplete coverage/);
    assert.equal(writes, 0);
  } finally { globalThis.fetch = previous; }
});

test("publication refuses non-conflict errors without retrying or forcing", { concurrency: false }, async () => {
  const previous = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/git/ref/")) return Response.json({ object: { sha: "head" } });
    if (url.includes("/contents/")) return Response.json({ content: Buffer.from("remote").toString("base64"), encoding: "base64", sha: "file" });
    if (url.includes("/git/commits/") && !init?.method) return Response.json({ tree: { sha: "tree" } });
    if (url.includes("/git/refs/")) { attempts++; return Response.json({}, { status: 403 }); }
    return Response.json({ sha: "object" });
  };
  try {
    assert.equal(await githubCommitFilesAtomically(["registry/domains.txt"], "test", () => [{ path: "registry/domains.txt", content: "replacement" }], 3), false);
    assert.equal(attempts, 1);
  } finally { globalThis.fetch = previous; }
});
