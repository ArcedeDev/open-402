import test from "node:test";
import assert from "node:assert/strict";

import {
  buildUpdatedDomainsTxt,
  parseDomainsTxt,
  type RegistryEntryLike,
} from "./registry-utils.ts";

function sampleRegistry(entries: string[]): string {
  return [
    "# Open 402 Directory — Registry of known domains",
    "# Format: domain | status | source | added_date",
    `# Total domains: ${entries.length}`,
    "# Total endpoints: 3",
    ...entries,
  ].join("\n");
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
