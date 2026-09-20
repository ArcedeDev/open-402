import test from "node:test";
import assert from "node:assert/strict";

import {
  buildUpdatedDomainsTxt,
  parseDomainsTxt,
  registryChanges,
  formatDomainLine,
  type RegistryEntryLike,
} from "./registry-utils.ts";

function sampleRegistry(entries: string[]): string {
  return [
    "# Open 402 Directory — Registry of known domains",
    "# Format: domain | status | source | added_date",
    `# Total domains: ${entries.length}`,
    "# Total endpoints: 3",
    ...entries,
  ].join("\n") + "\n";
}

test("parseDomainsTxt ignores comments and blank lines", () => {
  const parsed = parseDomainsTxt([
    "# comment",
    "",
    "alpha.example | verified | self | 2026-03-20",
  ].join("\n"));

  assert.deepEqual(parsed, [
    {
      domain: "alpha.example",
      status: "verified",
      source: "self",
      added_date: "2026-03-20",
    },
  ]);
});

test("buildUpdatedDomainsTxt is a no-op when registry content already matches", () => {
  const current = sampleRegistry([
    "alpha.example | verified | self | 2026-03-20",
    "beta.example | unclaimed | 402index | 2026-03-21",
  ]);
  const entries: RegistryEntryLike[] = [
    { domain: "alpha.example", status: "verified", source: "self", intent_count: 1 },
    { domain: "beta.example", status: "unclaimed", source: "402index", intent_count: 2 },
  ];

  const updated = buildUpdatedDomainsTxt(current, entries);

  assert.equal(updated.changed, false);
  assert.equal(updated.content, current);
});

test("buildUpdatedDomainsTxt updates statuses, preserves remote lines, and appends discoveries", () => {
  const current = sampleRegistry([
    "alpha.example | unclaimed | self | 2026-03-20",
    "remote.example | verified | manual | 2026-03-18",
  ]);
  const entries: RegistryEntryLike[] = [
    { domain: "alpha.example", status: "verified", source: "self", intent_count: 3 },
    { domain: "new.example", status: "verified", source: "onchain-base", intent_count: 4 },
  ];
  const logs: string[] = [];

  const updated = buildUpdatedDomainsTxt(current, entries, {
    logStatusChanges: (message) => logs.push(message),
  });

  assert.equal(updated.changed, true);
  assert.ok(updated.content.includes("alpha.example | verified | self | 2026-03-20"));
  assert.ok(updated.content.includes("remote.example | verified | manual | 2026-03-18"));
  assert.ok(updated.content.includes("new.example | verified | onchain-base | "));
  assert.ok(updated.content.includes("# Total domains: 3"));
  assert.ok(updated.content.includes("# Total endpoints: 7"));
  assert.deepEqual(logs, ["STATUS alpha.example: unclaimed → verified"]);
});

test("registry rows reject malformed fields, dates, status and duplicates", () => {
  for (const row of [
    "one.io | verified | self | 2026-07-06two.io | verified | self | 2026-07-06",
    "one.io | yes | self | 2026-07-06",
    "one.io | verified | self | 2026-02-30",
    "one.io | verified | self | tomorrow",
    "https://one.io | verified | self | 2026-07-06",
    "one.io | verified | | 2026-07-06",
    "one.io | verified | self | 2026-07-06\nONE.io | unclaimed | self | 2026-07-06",
  ]) assert.throws(() => parseDomainsTxt(row));
});

test("generated registry always ends with a newline", () => {
  const current = "one.io | unclaimed | self | 2026-07-06";
  const updated = buildUpdatedDomainsTxt(current, []);
  assert.equal(updated.content, current + "\n");
  assert.equal(updated.changed, true);
  assert.equal(buildUpdatedDomainsTxt(updated.content, []).changed, false);
});

test("generated rows are validated before they can poison the next crawl", () => {
  const current = "one.io | unclaimed | self | 2026-07-06\n";
  assert.throws(() => buildUpdatedDomainsTxt(current, [
    { domain: "new.vendor.io", status: "unclaimed", source: "onchain-X402", intent_count: 0 },
  ]), /Invalid registry row/);
  const result = buildUpdatedDomainsTxt(current, [
    { domain: "new.vendor.io", status: "unclaimed", source: "onchain-x402", intent_count: 0 },
  ]);
  assert.equal(parseDomainsTxt(result.content).length, 2);
});

test("bulk removals count toward listing change review", () => {
  const previous = Array.from({ length: 6_673 }, (_, i) => ({ domain: `domain-${i}.io`, status: "unclaimed" as const, source: "self", added_date: "2026-09-20" }));
  assert.throws(() => registryChanges(previous, previous.slice(0, 1)), /Bulk/);
  assert.equal(registryChanges(previous, previous.slice(1)).removed.length, 1);
});

test("source and other fields cannot inject syntactically valid uncrawled rows", () => {
  const row = { domain: "one.io", status: "unclaimed" as const, source: "self", added_date: "2026-09-20" };
  const injected = "onchain-x402 | 2026-09-20\nevil.vendor.io | verified | self";
  assert.throws(() => buildUpdatedDomainsTxt("one.io | unclaimed | self | 2026-09-20\n", [
    { domain: "new.vendor.io", status: "unclaimed", source: injected, intent_count: 0 },
  ]), /delimiters/);
  for (const field of ["domain", "status", "source", "added_date"]) {
    assert.throws(() => formatDomainLine({ ...row, [field]: injected }), /delimiters/);
  }
});
