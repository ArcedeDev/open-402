import test from "node:test";
import assert from "node:assert/strict";
import { pausePublication } from "./pause-publication.ts";

test("pause disables scheduling first, drains active and queued runs, and reports actual head", async () => {
  let disabled = false;
  let head = "before-publication";
  const active = new Set(["1", "2"]);
  const cancelled: string[] = [];
  const result = await pausePublication((args) => {
    if (args[0] === "workflow") { disabled = true; return ""; }
    assert.equal(disabled, true);
    if (args[0] === "run") {
      cancelled.push(args[2]);
      active.delete(args[2]);
      if (args[2] === "1") { active.add("3"); head = "accepted-before-cancellation"; }
      return "";
    }
    return args.includes("--paginate") ? [...active].join("\n") : head;
  }, async () => {});
  assert.deepEqual(cancelled, ["1", "2", "3"]);
  assert.equal(result, "accepted-before-cancellation");
});

test("pause fails closed when cancellation cannot drain publishers", async () => {
  await assert.rejects(pausePublication((args) => {
    if (args[0] === "run") throw new Error("Forbidden");
    return args.includes("--paginate") ? "123" : "";
  }, async () => {}), /not confirmed stopped/);
});
