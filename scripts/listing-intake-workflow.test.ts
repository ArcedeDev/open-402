import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The intake job holds a token that can write main. It must only ever run main's own code.
test("listing intake workflow never runs contributor code", async () => {
  const workflow = await readFile(new URL("../.github/workflows/listing-intake.yml", import.meta.url), "utf8");
  const lines = workflow.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  assert.doesNotMatch(lines, /pull_request/, "no pull_request or pull_request_target trigger");
  assert.doesNotMatch(lines, /github\.event\.pull_request|head_ref|head\.sha|refs\/pull/, "no PR ref is checked out or used");
  assert.match(lines, /ref: main\n\s+persist-credentials: false/);
  assert.match(lines, /group: listing-intake\n\s+cancel-in-progress: false/);
  assert.match(lines, /^permissions:\n  contents: read\n  pull-requests: write\n  issues: write\n  actions: read\n(?!  )/m);
  assert.equal((lines.match(/secrets\./g) ?? []).length, 1, "only the publisher secret, in one step");
});
