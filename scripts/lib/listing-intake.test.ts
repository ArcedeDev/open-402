import test from "node:test";
import assert from "node:assert/strict";
import { applyRows, classifyPullRequest, coAuthorTrailer, patchRows, type IntakeRow, type PullRequestFile } from "./listing-intake.ts";
import { parseDomainsTxt } from "./registry-utils.ts";

const registryText = [
  "# Open 402 Directory — Registry of known domains",
  "# Format: domain | status | source | added_date",
  "# Total domains: 2",
  "# Total endpoints: 3",
  "alpha.dev | verified | self | 2026-03-20",
  "beta.dev | unclaimed | onchain-x402 | 2026-03-21",
].join("\n") + "\n";
const main = parseDomainsTxt(registryText);
const today = "2026-11-27";

function file(patch: string, overrides: Partial<PullRequestFile> = {}): PullRequestFile[] {
  return [{ filename: "registry/domains.txt", status: "modified", patch, ...overrides }];
}
const add = (row: string) => `@@ -5,2 +5,3 @@\n alpha.dev | verified | self | 2026-03-20\n beta.dev | unclaimed | onchain-x402 | 2026-03-21\n+${row}`;

test("patchRows reads added and removed rows and skips headers and comments", () => {
  assert.deepEqual(patchRows("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-# Total domains: 2\n+# Total domains: 3\n-old.dev | unclaimed | self | 2026-01-01\n+new.dev | unclaimed | self | 2026-01-01\n ctx"), {
    added: ["new.dev | unclaimed | self | 2026-01-01"],
    removed: ["old.dev | unclaimed | self | 2026-01-01"],
  });
});

test("one new well-formed row from a contributor is eligible", () => {
  assert.deepEqual(classifyPullRequest(file(add("gamma.dev | unclaimed | submit | 2026-11-27")), main, today), {
    kind: "eligible", mode: "add", row: { entry: { domain: "gamma.dev", status: "unclaimed", source: "submit", added_date: "2026-11-27" }, prior: null },
  });
});

test("a new row is dated by the PR, not by what the contributor typed", () => {
  const decision = classifyPullRequest(file(add("gamma.dev | unclaimed | self | 2030-01-01")), main, "2026-11-20");
  assert.equal(decision.kind, "eligible");
  assert.equal((decision as { row: IntakeRow }).row.entry.added_date, "2026-11-20");
});

test("anything beyond one row in the registry goes to a maintainer", () => {
  const cases: [PullRequestFile[], RegExp][] = [
    [[...file(add("gamma.dev | unclaimed | self | 2026-11-27")), { filename: "scripts/crawl.ts", status: "modified", patch: "+x" }], /other than/],
    [file(add("gamma.dev | unclaimed | self | 2026-11-27"), { filename: "README.md" }), /other than/],
    [file(add("gamma.dev | unclaimed | self | 2026-11-27"), { status: "renamed" }), /other than/],
    [file("", { patch: undefined }), /too large/],
    [file(`${add("gamma.dev | unclaimed | self | 2026-11-27")}\n+delta.dev | unclaimed | self | 2026-11-27`), /one registry row/],
    [file(add("gamma.dev|unclaimed|self|2026-11-27")), /does not match/],
    [file(add("Gamma.dev | unclaimed | self | 2026-11-27")), /lowercase public/],
    [file(add("localhost | unclaimed | self | 2026-11-27")), /lowercase public/],
    [file(add("api.example.com | unclaimed | self | 2026-11-27")), /lowercase public/],
    [file(add("10.0.0.1 | unclaimed | self | 2026-11-27")), /lowercase public/],
    [file(add("gamma.dev | unclaimed | onchain-x402 | 2026-11-27")), /source/],
    [file(`-alpha.dev | verified | self | 2026-03-20\n+gamma.dev | unclaimed | self | 2026-11-27`), /different domain/],
    [file(`-beta.dev | unclaimed | onchain-x402 | 2026-03-21\n-alpha.dev | verified | self | 2026-03-20\n+beta.dev | verified | self | 2026-11-27`), /more than one/],
    [file(`-alpha.dev | verified | self | 2026-03-20\n+alpha.dev | unclaimed | self | 2026-11-27`), /other than upgrading/],
  ];
  for (const [files, reason] of cases) {
    const decision = classifyPullRequest(files, main, today);
    assert.equal(decision.kind, "review", JSON.stringify(files));
    assert.match((decision as { reason: string }).reason, reason);
  }
});

test("an upgrade to verified keeps main's source and date, with or without removing the old row", () => {
  for (const patch of [`-beta.dev | unclaimed | onchain-x402 | 2026-03-21\n+beta.dev | verified | self | 2026-11-27`, add("beta.dev | verified | self | 2026-11-27")]) {
    assert.deepEqual(classifyPullRequest(file(patch), main, today), {
      kind: "eligible", mode: "upgrade",
      row: {
        entry: { domain: "beta.dev", status: "verified", source: "onchain-x402", added_date: "2026-03-21" },
        prior: { domain: "beta.dev", status: "unclaimed", source: "onchain-x402", added_date: "2026-03-21" },
      },
    });
  }
});

test("existing rows are matched without regard to case", () => {
  const upper = parseDomainsTxt(registryText.replace("alpha.dev |", "Alpha.dev |"));
  assert.notEqual(classifyPullRequest(file(add("alpha.dev | unclaimed | self | 2026-11-27")), upper, today).kind, "eligible");
});

test("rows already on main are recognised as landed or duplicate", () => {
  assert.equal(classifyPullRequest(file(add("alpha.dev | verified | self | 2026-03-20")), main, today).kind, "landed");
  assert.equal(classifyPullRequest(file(add("alpha.dev | unclaimed | submit | 2026-11-27")), main, today).kind, "duplicate");
  assert.equal(classifyPullRequest(file(add("beta.dev | unclaimed | self | 2026-11-27")), main, today).kind, "duplicate");
  // After an upgrade lands with main's source kept, a retry of that PR reads as landed, not duplicate.
  const upgraded = parseDomainsTxt(registryText.replace("beta.dev | unclaimed", "beta.dev | verified"));
  assert.equal(classifyPullRequest(file(add("beta.dev | verified | self | 2026-11-27")), upgraded, today).kind, "landed");
  // So does the row-replacing form, including when the nightly crawl verified the domain first.
  assert.equal(classifyPullRequest(file(`-beta.dev | unclaimed | onchain-x402 | 2026-03-21\n+beta.dev | verified | self | 2026-11-27`), upgraded, today).kind, "landed");
});

const gamma: IntakeRow = { entry: { domain: "gamma.dev", status: "unclaimed", source: "submit", added_date: "2026-11-27" }, prior: null };
const betaUp: IntakeRow = {
  entry: { domain: "beta.dev", status: "verified", source: "onchain-x402", added_date: "2026-03-21" },
  prior: { domain: "beta.dev", status: "unclaimed", source: "onchain-x402", added_date: "2026-03-21" },
};

test("applyRows adds, upgrades in place and recounts, and changes nothing else", () => {
  const next = applyRows(registryText, [gamma, betaUp]);
  assert.equal(next, [
    "# Open 402 Directory — Registry of known domains",
    "# Format: domain | status | source | added_date",
    "# Total domains: 3",
    "# Total endpoints: 3",
    "alpha.dev | verified | self | 2026-03-20",
    "beta.dev | verified | onchain-x402 | 2026-03-21",
    "gamma.dev | unclaimed | submit | 2026-11-27",
  ].join("\n") + "\n");
  assert.throws(() => applyRows(registryText, [gamma, { ...gamma, entry: { ...gamma.entry, status: "verified" } }]), /[Dd]uplicate/);
  // A retry after a commit that already landed is a no-op.
  assert.equal(applyRows(next, [gamma, betaUp]), next);
});

test("applyRows refuses when main changed under a pending row", () => {
  const moved = registryText.replace("beta.dev | unclaimed | onchain-x402 | 2026-03-21", "beta.dev | verified | self | 2026-11-01");
  assert.throws(() => applyRows(moved, [betaUp]), /Main changed under beta.dev/);
  const crawled = registryText.replace("# Total domains: 2", "# Total domains: 3") + "gamma.dev | unclaimed | onchain-x402 | 2026-11-26\n";
  assert.throws(() => applyRows(crawled, [gamma]), /Main changed under gamma.dev/);
});

test("coAuthorTrailer credits the PR author's GitHub account only", () => {
  assert.equal(coAuthorTrailer("ana-b", 7), "Co-authored-by: ana-b <7+ana-b@users.noreply.github.com>");
  assert.equal(coAuthorTrailer("ana>\nCo-authored-by: x", 7), "");
  assert.equal(coAuthorTrailer("ana", 0), "");
});
