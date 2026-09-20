import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  applyDailyDemotions, categorizeManifestError, normalizeManifestDemotionBudget, normalizeManifestHealth, observeManifestHealth,
  type ManifestDemotionBudget, type ManifestHealth,
} from "./manifest-health.ts";
import { crawlAll } from "../crawl.ts";

const now = new Date("2026-09-20T12:00:00.000Z");
const failed = { success: false, error: "timeout" };
const healthy = observeManifestHealth(undefined, "unclaimed", { success: true }, now);
const stale: ManifestHealth = {
  status: "stale", checked_at: now.toISOString(), last_success_at: "2026-07-01T00:00:00.000Z",
  failure_since: "2026-08-01T00:00:00.000Z", failure_days: 30, error: "timeout", demoted_at: null,
};

function listing(domain = "api.vendor.io", manifest_health: ManifestHealth = stale) {
  return {
    domain, status: "verified" as "verified" | "unclaimed", display_name: "Retained name",
    description: "Retained description", version: "1.3", intent_count: 1,
    intents: [{ name: "historical", description: "Historical capability" }],
    protocols: ["x402"], networks: ["base"], assets: ["USDC"], source: "self",
    first_seen: "2026-07-01", last_crawled: "2026-09-19T00:00:00.000Z", consecutive_failures: 90,
    claims: [], verification: { domain_state: "no_claim" as const, canonical_claim_index: null, shared_domain_count: 0 },
    manifest_health,
  };
}

test("legacy counters and timestamps never become successful observations or failure days", async () => {
  const prior = listing();
  delete (prior as Partial<typeof prior>).manifest_health;
  const row = { domain: prior.domain, status: prior.status, source: "self", added_date: "2026-07-01" };
  const [entry] = await crawlAll([row], new Map([[prior.domain, prior]]), { crawl: async () => failed, now: () => now });
  assert.equal(entry.status, "verified");
  assert.equal(entry.consecutive_failures, 91);
  assert.deepEqual(entry.manifest_health, {
    status: "stale", checked_at: now.toISOString(), last_success_at: null,
    failure_since: now.toISOString(), failure_days: 1, error: "timeout", demoted_at: null,
  });
  assert.equal(entry.last_crawled, now.toISOString());
  for (const key of ["first_seen", "display_name", "description", "version", "intents", "claims", "verification"] as const) {
    assert.deepEqual(entry[key], prior[key]);
  }
});

test("normalization accepts coherent UTC evidence and refuses fabricated dates and ages", () => {
  assert.deepEqual(normalizeManifestHealth(stale, now), stale);
  assert.deepEqual(normalizeManifestHealth(healthy, now), healthy);
  for (const value of [undefined, null, {}, { consecutive_failures: 1000, last_crawled: now.toISOString() },
    { ...stale, checked_at: "2026-09-21T00:00:00.000Z" },
    { ...stale, failure_since: "2026-09-21T00:00:00.000Z" },
    { ...stale, failure_since: "2026-02-30T00:00:00.000Z" },
    { ...stale, failure_days: -1 }, { ...stale, failure_days: 1.5 },
    { ...stale, failure_days: 1000 }, { ...stale, failure_days: "30" },
    { ...healthy, last_success_at: "2026-09-22T00:00:00.000Z" },
    { ...stale, last_success_at: now.toISOString() },
  ]) {
    const result = normalizeManifestHealth(value, now);
    assert.equal(result.status, "unknown");
    assert.equal(result.failure_days, 0);
    assert.equal(result.failure_since, null);
  }
  const seconds = { ...healthy, checked_at: "2026-09-20T12:00:00Z", last_success_at: "2026-09-20T12:00:00Z" };
  assert.deepEqual(normalizeManifestHealth(seconds, now), healthy);
  assert.equal(normalizeManifestHealth({ ...stale, checked_at: "malformed" }, now).last_success_at, stale.last_success_at);
  assert.equal(normalizeManifestHealth({ ...stale, last_success_at: "2026-10-01T00:00:00.000Z" }, now).status, "unknown");
});

test("only distinct observed UTC failure dates advance the streak", () => {
  const beforeMidnight = new Date("2026-09-01T23:59:59.999Z");
  const first = observeManifestHealth(undefined, "verified", failed, beforeMidnight);
  assert.equal(observeManifestHealth(first, "verified", failed, beforeMidnight).failure_days, 1);
  const next = observeManifestHealth(first, "verified", failed, new Date("2026-09-02T00:00:00.000Z"));
  assert.equal(next.failure_days, 2);
  const later = observeManifestHealth(next, "verified", failed, now);
  assert.equal(later.failure_days, 3);
  assert.equal(later.failure_since, first.failure_since);
  assert.equal(observeManifestHealth(later, "verified", failed, now).failure_days, 3);
});

test("success resets failure evidence while preserving past success on later failures", () => {
  const success = observeManifestHealth(stale, "verified", { success: true }, now);
  assert.equal(success.status, "healthy");
  assert.equal(success.failure_days, 0);
  assert.equal(success.failure_since, null);
  assert.equal(success.error, null);
  const failureTime = new Date("2026-09-20T13:00:00.000Z");
  const failure = observeManifestHealth(success, "verified", failed, failureTime);
  assert.equal(failure.status, "stale");
  assert.equal(failure.failure_days, 1);
  assert.equal(failure.last_success_at, now.toISOString());
  assert.equal(failure.failure_since, failureTime.toISOString());
  assert.equal(observeManifestHealth(undefined, "unclaimed", failed, now).status, "unavailable");
  const simultaneousFailure = observeManifestHealth(success, "verified", failed, now);
  const tomorrow = new Date("2026-09-21T12:00:00.000Z");
  assert.equal(observeManifestHealth(simultaneousFailure, "verified", failed, tomorrow).failure_days, 2);
});

test("errors are a bounded category rather than provider response content", () => {
  const cases = [
    ["HTTP 404", "not_found"], ["HTTP 410", "not_found"], ["HTTP 429", "rate_limited"],
    ["HTTP 503", "http_error"], ["origin_mismatch", "invalid_manifest"],
    ["invalid_payment_networks", "invalid_manifest"], ["blocked_address", "blocked"],
    ["body_aborted", "unreachable"], ["request_failed", "unreachable"],
    ["invalid_json", "invalid_response"], ["too_large", "invalid_response"],
    ["timeout", "timeout"], ["token=private-provider-body", "unknown"],
  ];
  for (const [error, category] of cases) assert.equal(categorizeManifestError(error), category);
});

test("154 eligible entries drain in bounded daily cohorts with stable ordering and no evidence loss", () => {
  const initial = Array.from({ length: 8888 }, (_, i) => listing(`domain-${String(i).padStart(4, "0")}.io`, i < 154 ? stale : healthy)).reverse();
  const before = structuredClone(initial);
  let entries = initial;
  let previousBudget: ManifestDemotionBudget | undefined;
  for (let day = 0; day < 7; day++) {
    const date = new Date(now.getTime() + day * 86_400_000);
    const result = applyDailyDemotions(entries, entries, { now: date, previousBudget });
    assert.equal(result.dailyLimit, 25);
    assert.equal(result.demoted, day === 6 ? 4 : 25);
    assert.ok(result.demoted / entries.length <= 0.01);
    const expectedDomains = Array.from({ length: result.demoted }, (_, i) => `domain-${String(day * 25 + i).padStart(4, "0")}.io`);
    const demotedDomains = result.entries.filter((e) => e.manifest_health.demoted_at === date.toISOString()).map((e) => e.domain).sort();
    assert.deepEqual(demotedDomains, expectedDomains);
    const repeat = applyDailyDemotions(result.entries, result.entries, { now: date, previousBudget: result.budget });
    assert.equal(repeat.demoted, 0);
    entries = result.entries;
    previousBudget = result.budget;
  }
  assert.equal(entries.filter((e) => e.status === "unclaimed").length, 154);
  assert.deepEqual(initial, before);
  for (const entry of entries) {
    assert.equal(entry.description, "Retained description");
    assert.deepEqual(entry.intents, before[0].intents);
    assert.deepEqual(entry.claims, before[0].claims);
    assert.deepEqual(entry.verification, before[0].verification);
  }
});

test("queue prioritizes oldest failure then domain, not input order or attempt count", () => {
  const entries = Array.from({ length: 100 }, (_, i) => listing(`z-${i}.io`, healthy));
  entries[0] = listing("b.io", { ...stale, failure_since: "2026-07-10T00:00:00.000Z" });
  entries[1] = listing("a.io", { ...stale, failure_since: "2026-07-10T00:00:00.000Z" });
  entries[2] = listing("earlier-alphabet.io", stale);
  const result = applyDailyDemotions(entries, [], { now });
  assert.equal(result.demoted, 1);
  assert.equal(result.entries.find((e) => e.status === "unclaimed")?.domain, "a.io");
  assert.equal(result.held, 2);
});

test("small registries hold for review and healthy or legacy entries cannot be demoted", () => {
  const entries = Array.from({ length: 99 }, (_, i) => listing(`domain-${i}.io`));
  const result = applyDailyDemotions(entries, [], { now });
  assert.equal(result.dailyLimit, 0);
  assert.equal(result.demoted, 0);
  assert.equal(result.held, 99);
  const larger = Array.from({ length: 100 }, (_, i) => listing(`domain-${i}.io`, healthy));
  larger[0].manifest_health = normalizeManifestHealth(undefined, now);
  assert.equal(applyDailyDemotions(larger, [], { now }).demoted, 0);
  for (const thresholdDays of [0, -1, 1.5, NaN]) {
    assert.throws(() => applyDailyDemotions(entries, [], { now, thresholdDays }), /threshold/);
  }
});

test("same-day recovery, retries and removed listings cannot replenish the daily allowance", async () => {
  const entries = Array.from({ length: 100 }, (_, i) => listing(`domain-${i}.io`));
  const result = applyDailyDemotions(entries, entries, { now });
  const demoted = result.entries.find((e) => e.status === "unclaimed")!;
  const recoveryTime = new Date("2026-09-20T13:00:00.000Z");
  const row = { domain: demoted.domain, status: demoted.status, source: "self", added_date: "2026-07-01" };
  const [recovered] = await crawlAll([row], new Map([[demoted.domain, demoted]]), {
    now: () => recoveryTime,
    crawl: async () => ({ success: true, manifest: { version: "1.3", origin: demoted.domain, payout_address: "wallet" } }),
  });
  assert.equal(recovered.status, "verified");
  assert.equal(recovered.manifest_health?.status, "healthy");
  assert.equal(recovered.manifest_health?.demoted_at, now.toISOString());
  const recoveredEntries = result.entries.map((entry) => entry.domain === recovered.domain ? recovered : entry);
  const repeat = applyDailyDemotions(recoveredEntries, recoveredEntries, { now: recoveryTime });
  assert.equal(repeat.alreadyDemotedToday, 1);
  assert.equal(repeat.demoted, 0);
  assert.equal(applyDailyDemotions(entries, result.entries, { now }).demoted, 0);
  const fullBudget = entries.slice(0, 2).map((entry) => ({ ...entry, manifest_health: { ...stale, demoted_at: now.toISOString() } }));
  assert.equal(applyDailyDemotions(entries, fullBudget, { now }).demoted, 0);
});

test("crawl cannot manufacture healthy evidence from a success missing its manifest", async () => {
  const row = { domain: "api.vendor.io", status: "unclaimed" as const, source: "self", added_date: "2026-07-01" };
  await assert.rejects(crawlAll([row], new Map(), {
    now: () => now, crawl: async () => ({ success: true }),
  }), /Successful crawl has no manifest/);
});

test("approved removals cannot replenish the daily budget after serialization and replay", () => {
  const entries = Array.from({ length: 1000 }, (_, i) => listing(`domain-${String(i).padStart(4, "0")}.io`));
  const first = applyDailyDemotions(entries, entries, { now });
  assert.equal(first.demoted, 10);
  assert.deepEqual(first.budget, { date: "2026-09-20", used: 10 });
  const remaining = first.entries.filter((entry) => entry.status === "verified");
  const removed = applyDailyDemotions(remaining, first.entries, { now, previousBudget: first.budget });
  assert.equal(removed.demoted, 0);
  assert.equal(removed.dailyLimit, 9);
  const published = JSON.parse(JSON.stringify({
    entries: removed.entries, manifest_demotion_budget: removed.budget,
  }));
  assert.equal(published.entries.length, 990);
  assert.ok(published.entries.every((entry) => entry.manifest_health.demoted_at === null));
  const replay = applyDailyDemotions(published.entries, published.entries, {
    now, previousBudget: published.manifest_demotion_budget,
  });
  assert.equal(replay.alreadyDemotedToday, 10);
  assert.equal(replay.demoted, 0);
  assert.equal(replay.held, 990);
  assert.deepEqual(replay.budget, first.budget);
  const tomorrow = applyDailyDemotions(replay.entries, replay.entries, {
    now: new Date("2026-09-21T00:00:00.000Z"), previousBudget: replay.budget,
  });
  assert.equal(tomorrow.alreadyDemotedToday, 0);
  assert.equal(tomorrow.demoted, 9);
  assert.deepEqual(tomorrow.budget, { date: "2026-09-21", used: 9 });
});

test("budget reconciles with distinct visible markers using the maximum, never their sum", () => {
  const entries = Array.from({ length: 1000 }, (_, i) => listing(`domain-${String(i).padStart(4, "0")}.io`));
  for (const entry of entries.slice(0, 4)) entry.manifest_health = { ...stale, demoted_at: now.toISOString() };
  for (const [persisted, consumed] of [[undefined, 4], [2, 4], [7, 7]] as const) {
    const result = applyDailyDemotions(entries, entries, {
      now, previousBudget: persisted === undefined ? undefined : { date: "2026-09-20", used: persisted },
    });
    assert.equal(result.alreadyDemotedToday, consumed);
    assert.equal(result.demoted, 10 - consumed);
    assert.deepEqual(result.budget, { date: "2026-09-20", used: 10 });
  }
});

test("invalid and future ledgers fail closed even when the queue is empty", () => {
  for (const previousBudget of [null, [], "2026-09-20", {}, { date: "2026-09-20" },
    { date: "2026-09-21", used: 0 }, { date: "2026-02-30", used: 0 },
    { date: "2026-09-20T00:00:00Z", used: 0 }, { date: "2026-9-20", used: 0 },
    ...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "10"].map((used) => ({ date: "2026-09-20", used })),
    { date: "2026-09-19", used: -1 },
  ]) {
    assert.throws(() => applyDailyDemotions([], [], { now, previousBudget }), /demotion budget/);
  }
  assert.deepEqual(normalizeManifestDemotionBudget(undefined, now), { date: "2026-09-20", used: 0 });
  assert.deepEqual(normalizeManifestDemotionBudget({ date: "2024-02-29", used: 25 }, now), { date: "2026-09-20", used: 0 });
  assert.deepEqual(applyDailyDemotions([], [], { now, previousBudget: { date: "2026-09-20", used: 10 } }).budget,
    { date: "2026-09-20", used: 10 });
});

test("main preserves the daily ledger through enrichment, approved removals and serialized publication", () => {
  const script = `
    import assert from "node:assert/strict";
    import http from "node:http";
    import https from "node:https";
    import { syncBuiltinESMExports } from "node:module";
    const RealDate = Date;
    const instant = RealDate.parse(${JSON.stringify(now.toISOString())});
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [instant])); }
      static now() { return instant; }
    };
    const deny = () => { throw new Error("Unexpected native network request"); };
    http.request = deny; http.get = deny; https.request = deny; https.get = deny;
    syncBuiltinESMExports();
    delete process.env.GITHUB_OUTPUT;
    process.env.GITHUB_TOKEN = "offline-token";
    process.env.GITHUB_REPO = "ArcedeDev/open-402";
    process.env.DEMOTE_DAYS = "30";
    const template = ${JSON.stringify(listing())};
    const entries = Array.from({ length: 1000 }, (_, i) => ({ ...template, domain: "domain-" + String(i).padStart(4, "0") + ".io" }));
    const files = new Map([
      ["registry/domains.txt", entries.map(e => e.domain + " | verified | self | 2026-07-01").join("\\n") + "\\n"],
      ["registry/snapshot.json", JSON.stringify({ generated_at: new Date().toISOString(), total: 1000, verified: 1000, unclaimed: 0, entries })],
    ]);
    const blobs = new Map();
    let tree = [];
    let sequence = 1;
    let head = "1".repeat(40);
    let writes = 0;
    let providerMocks = 0;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname !== "api.github.com") { providerMocks++; return Response.json({ items: [], services: [], data: [], total: 0 }); }
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (init?.method) writes++;
      if (url.pathname.includes("/git/ref/")) return Response.json({ object: { sha: head } });
      if (url.pathname.includes("/contents/")) {
        const content = files.get(url.pathname.split("/contents/")[1]);
        assert.ok(content);
        return Response.json({ sha: "file", content: Buffer.from(content).toString("base64"), encoding: "base64" });
      }
      if (url.pathname.includes("/git/commits/")) return Response.json({ tree: { sha: "base-tree" } });
      if (url.pathname.endsWith("/git/blobs")) {
        const sha = "blob-" + (++sequence); blobs.set(sha, body.content); return Response.json({ sha });
      }
      if (url.pathname.endsWith("/git/trees")) { tree = body.tree; return Response.json({ sha: "tree" }); }
      if (url.pathname.endsWith("/git/commits")) return Response.json({ sha: String(++sequence).padStart(40, "0") });
      if (url.pathname.includes("/git/refs/")) {
        assert.equal(body.force, false);
        for (const entry of tree) files.set(entry.path, blobs.get(entry.sha));
        head = body.sha; return Response.json({});
      }
      throw new Error("Unexpected mocked GitHub route");
    };
    const { main } = await import("./scripts/crawl.ts");
    let crawled = 0;
    const crawl = async domain => {
      crawled++;
      return domain === "domain-0999.io"
        ? { success: true, manifest: { version: "1.3", origin: domain, payout_address: "wallet" } }
        : { success: false, error: "timeout" };
    };
    await main({ dryRun: false }, crawl);
    const first = JSON.parse(files.get("registry/snapshot.json"));
    assert.deepEqual(first.manifest_demotion_budget, { date: "2026-09-20", used: 10 });
    const removed = first.entries.filter(e => e.status === "unclaimed").map(e => e.domain);
    assert.equal(removed.length, 10);
    process.env.APPROVED_REMOVALS = removed.join(",");
    files.set("registry/domains.txt", files.get("registry/domains.txt").split("\\n")
      .filter(line => !removed.includes(line.split("|")[0].trim())).join("\\n"));
    await main({ dryRun: false }, crawl);
    const second = JSON.parse(files.get("registry/snapshot.json"));
    assert.equal(second.entries.length, 990);
    assert.deepEqual(second.manifest_demotion_budget, first.manifest_demotion_budget);
    delete process.env.APPROVED_REMOVALS;
    await main({ dryRun: false }, crawl);
    const third = JSON.parse(files.get("registry/snapshot.json"));
    assert.equal(third.unclaimed, 0);
    assert.deepEqual(third.manifest_demotion_budget, first.manifest_demotion_budget);
    third.manifest_demotion_budget.date = "2026-09-21";
    files.set("registry/snapshot.json", JSON.stringify(third));
    const counters = [crawled, writes, providerMocks];
    await assert.rejects(main({ dryRun: false }, crawl), /Existing snapshot is invalid/);
    assert.deepEqual([crawled, writes, providerMocks], counters);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("../..", import.meta.url), encoding: "utf8", timeout: 15_000,
  });
  assert.equal(child.status, 0, child.stdout + child.stderr);
});
