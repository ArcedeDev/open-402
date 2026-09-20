import test from "node:test";
import assert from "node:assert/strict";
import { runAddressVerificationQueue } from "./address-scheduler.ts";
import { addressKey, seedAddressVerifications, type AddressVerificationRecord, type Claim } from "./verification-model.ts";
import type { IncrementalVerificationInput, IncrementalVerificationResult } from "../watchers/onchain-verifier.ts";

const attemptAt = "2026-09-20T12:00:00.000Z";
const completeAt = "2026-09-20T12:01:00.000Z";
const previousAt = "2026-09-01T00:00:00.000Z";

function record(id: number, changes: Partial<AddressVerificationRecord> = {}): AddressVerificationRecord {
  return {
    protocol: "x402", network: "base", asset: "USDC", address: `0x${id.toString(16).padStart(40, "0")}`,
    verification_state: "verified", verification_method: "base_usdc_transfer_scan",
    tx_count: 3, volume_usd: 9.5, first_tx: previousAt, last_tx: previousAt, last_tx_hash: "0xabc",
    first_verified_at: previousAt, last_verified_at: previousAt, last_scanned_block: 80,
    ...changes,
  };
}

function recordsMap(records: AddressVerificationRecord[]): Map<string, AddressVerificationRecord> {
  return new Map(records.map((value) => [addressKey(value), value]));
}

function result(input: IncrementalVerificationInput, changes: Partial<IncrementalVerificationResult> = {}): IncrementalVerificationResult {
  const prior = input.priorTotals!;
  return {
    address: input.address, verificationState: prior.totalTransactions > 0 ? "verified" : "unverified", scanComplete: true,
    ...prior, lastScannedBlock: 100, ...changes,
  };
}

test("queue orders all classes by oldest attempt, then cursor and stable address", async () => {
  const values = [
    record(1, { last_scan_attempt_at: "2026-09-19T00:00:00Z", last_scanned_block: 0 }),
    record(2, { last_scan_attempt_at: "2026-09-18T00:00:00Z", last_scanned_block: 99, verification_state: "observed" }),
    record(3, { last_scan_attempt_at: "2026-09-18T00:00:00Z", last_scanned_block: 50 }),
    record(4, { last_scanned_block: 40 }), record(6, { last_scanned_block: null }), record(5, { last_scanned_block: null }),
    record(7, { protocol: "mpp" }), record(8, { address: `0x${"0".repeat(40)}` }),
  ];
  const records = recordsMap(values);
  const summary = await runAddressVerificationQueue(records, {
    limit: 5, concurrency: 3, now: () => attemptAt,
    verify: async (inputs, concurrency) => {
      assert.equal(concurrency, 3);
      assert.deepEqual(inputs.map((input) => input.address), [5, 6, 4, 3, 2].map((id) => record(id).address));
      for (const input of inputs) {
        const selected = [...records.values()].find((value) => value.address === input.address)!;
        assert.equal(selected.last_scan_attempt_at, attemptAt);
      }
      return new Map(inputs.map((input) => [input.address, result(input)]));
    },
  });
  assert.deepEqual(summary, { eligible: 6, attempted: 5, completed: 5, failed: 0 });
  for (const value of [values[0], values[6], values[7]]) assert.deepEqual(records.get(addressKey(value)), value);
});

test("legacy, malformed and future attempt times cannot starve an address", async () => {
  const records = recordsMap([
    record(1, { last_scan_attempt_at: attemptAt, last_scanned_block: 0 }),
    record(2, { last_scan_attempt_at: "bad", last_scanned_block: 30 }),
    record(3, { last_scan_attempt_at: "2099-01-01T00:00:00Z", last_scanned_block: 20 }),
    record(4, { last_scan_attempt_at: null, last_scanned_block: 10 }),
  ]);
  await runAddressVerificationQueue(records, {
    limit: 3, concurrency: 1, now: () => attemptAt,
    verify: async (inputs) => {
      assert.deepEqual(inputs.map((input) => input.address), [4, 3, 2].map((id) => record(id).address));
      return new Map();
    },
  });
});

test("scan budget rejects invalid or more-than-five limits before mutation or RPC", async () => {
  for (const limit of [0, -1, 6, 1.5, Infinity, NaN]) {
    const records = recordsMap([record(1)]);
    const before = structuredClone(records);
    await assert.rejects(runAddressVerificationQueue(records, {
      limit, concurrency: 1, verify: async () => { assert.fail("must not call verifier"); },
    }), /integer from 1 to 5/);
    assert.deepEqual(records, before);
  }
});

test("incomplete, missing, mismatched and unexpected results preserve all historical evidence", async () => {
  const values = Array.from({ length: 4 }, (_, i) => record(i + 1, { last_scan_complete_at: previousAt }));
  const records = recordsMap(values);
  const summary = await runAddressVerificationQueue(records, {
    limit: 5, concurrency: 3, now: () => attemptAt,
    verify: async (inputs) => new Map([
      [inputs[0].address, result(inputs[0], { scanComplete: false, totalTransactions: 0, totalVolumeUsdc: 0, lastScannedBlock: null })],
      [inputs[1].address, result(inputs[1], { scanComplete: false, scanError: "unexpected_error" })],
      [inputs[3].address, result(inputs[3], { address: record(99).address })],
    ]),
  });
  assert.deepEqual(summary, { eligible: 4, attempted: 4, completed: 0, failed: 4 });
  const errors = ["incomplete_scan", "unexpected_error", "missing_result", "result_mismatch"];
  values.forEach((value, i) => assert.deepEqual(records.get(addressKey(value)), {
    ...value, last_scan_attempt_at: attemptAt, last_scan_error: errors[i],
  }));
});

test("whole verifier failure rotates the selected batch and persists only safe error codes", async () => {
  const values = Array.from({ length: 7 }, (_, i) => record(i + 1, { last_scan_complete_at: previousAt }));
  const records = recordsMap(values);
  const summary = await runAddressVerificationQueue(records, {
    limit: 5, concurrency: 3, now: () => attemptAt,
    verify: async () => { throw new Error("private provider URL or credentials must not be published"); },
  });
  assert.deepEqual(summary, { eligible: 7, attempted: 5, completed: 0, failed: 5 });
  values.slice(0, 5).forEach((value) => assert.deepEqual(records.get(addressKey(value)), {
    ...value, last_scan_attempt_at: attemptAt, last_scan_error: "verifier_failed",
  }));
  await runAddressVerificationQueue(records, {
    limit: 2, concurrency: 1, now: () => completeAt,
    verify: async (inputs) => {
      assert.deepEqual(inputs.map((input) => input.address), values.slice(5).map((value) => value.address));
      return new Map(inputs.map((input) => [input.address, result(input)]));
    },
  });
});

test("only completed scans update completion time and clear the previous error", async () => {
  const value = record(1, { last_scan_complete_at: previousAt, last_scan_error: "incomplete_scan" });
  const records = recordsMap([value]);
  let ticks = 0;
  await runAddressVerificationQueue(records, {
    limit: 1, concurrency: 1, now: () => ticks++ === 0 ? attemptAt : completeAt,
    verify: async (inputs) => new Map([[inputs[0].address, result(inputs[0])]]),
  });
  assert.deepEqual(records.get(addressKey(value)), {
    ...value, last_scanned_block: 100, last_scan_attempt_at: attemptAt, last_scan_complete_at: completeAt, last_scan_error: null,
  });
});

test("persisted mixed-claim cohort is fully attempted despite recurring incomplete scans and throws", async () => {
  const claims: Claim[] = Array.from({ length: 18 }, (_, i) => ({
    protocol: "x402", network: "base", asset: "USDC", address: record(i + 1).address,
    claim_source: i < 6 ? "manifest" : "watcher", source_detail: "test", confidence: i < 6 ? "authoritative" : "observed",
    first_seen: previousAt, last_seen: previousAt, verification_state: i < 6 ? "pending" : "observed",
    verification_method: null, evidence: null,
  }));
  let records = seedAddressVerifications(claims, new Map());
  const attempts: string[] = [];
  for (let run = 0; run < 4; run++) {
    await runAddressVerificationQueue(records, {
      limit: 5, concurrency: 3, now: () => new Date(Date.parse(attemptAt) + run * 60_000).toISOString(),
      verify: async (inputs) => {
        assert.equal(inputs.length, 5);
        attempts.push(...inputs.map((input) => input.address));
        if (run % 2) throw new Error("provider unavailable");
        return new Map(inputs.map((input) => [input.address, result(input, { scanComplete: false })]));
      },
    });
    records = seedAddressVerifications(claims, recordsMap(JSON.parse(JSON.stringify([...records.values()]))));
  }
  assert.equal(new Set(attempts.slice(0, 18)).size, 18);
  for (const value of records.values()) {
    assert.ok(value.last_scan_attempt_at);
    assert.ok(value.last_scan_error);
    assert.equal(value.last_scan_complete_at, undefined);
    assert.equal(value.last_scanned_block, null);
    assert.equal(value.tx_count, 0);
  }
});

test("empty eligible queue does not contact the verifier", async () => {
  const summary = await runAddressVerificationQueue(recordsMap([record(1, { network: "unsupported" })]), {
    limit: 5, concurrency: 3, verify: async () => { assert.fail("must not call verifier"); },
  });
  assert.deepEqual(summary, { eligible: 0, attempted: 0, completed: 0, failed: 0 });
});

test("invalid concurrency is rejected before attempts or verifier calls", async () => {
  for (const concurrency of [0, -1, 101, 1.5, Infinity, NaN]) {
    const records = recordsMap([record(1)]);
    const before = structuredClone(records);
    await assert.rejects(runAddressVerificationQueue(records, {
      limit: 5, concurrency, verify: async () => { assert.fail("must not call verifier"); },
    }), /Concurrency must be an integer from 1 to 100/);
    assert.deepEqual(records, before);
  }
  await runAddressVerificationQueue(new Map(), {
    limit: 5, concurrency: 100, verify: async () => { assert.fail("empty queue"); },
  });
});

test("malformed or regressive complete results retain history and rotate out of the next batch", async () => {
  const malformed: Partial<IncrementalVerificationResult>[] = [
    ...[null, -1, 79, 80.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1].map((lastScannedBlock) => ({ lastScannedBlock })),
    ...[-1, 0, 2, 3.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1].map((totalTransactions) => ({ totalTransactions })),
    ...[-1, 0, 9, Infinity, NaN].map((totalVolumeUsdc) => ({ totalVolumeUsdc })),
    { scanComplete: "true" as unknown as boolean }, { verificationState: "incomplete" }, { scanError: "unexpected_error" },
  ];
  for (const changes of malformed) {
    const original = record(1, { last_scan_complete_at: previousAt });
    const records = recordsMap([original, record(2)]);
    const summary = await runAddressVerificationQueue(records, {
      limit: 1, concurrency: 1, now: () => attemptAt,
      verify: async (inputs) => new Map([[inputs[0].address, result(inputs[0], changes)]]),
    });
    assert.deepEqual(summary, { eligible: 2, attempted: 1, completed: 0, failed: 1 });
    assert.deepEqual(records.get(addressKey(original)), {
      ...original, last_scan_attempt_at: attemptAt, last_scan_error: "invalid_result",
    });
    await runAddressVerificationQueue(records, {
      limit: 1, concurrency: 1, now: () => completeAt,
      verify: async (inputs) => {
        assert.equal(inputs[0].address, record(2).address);
        return new Map([[inputs[0].address, result(inputs[0])]]);
      },
    });
  }
});

test("invalid or backwards completion clock cannot mark a scan complete", async () => {
  for (const completion of ["bad", "2026-09-20T11:59:59.999Z"]) {
    const original = record(1, { last_scan_complete_at: previousAt });
    const records = recordsMap([original]);
    let ticks = 0;
    await runAddressVerificationQueue(records, {
      limit: 1, concurrency: 1, now: () => ticks++ === 0 ? attemptAt : completion,
      verify: async (inputs) => new Map([[inputs[0].address, result(inputs[0])]]),
    });
    assert.deepEqual(records.get(addressKey(original)), {
      ...original, last_scan_attempt_at: attemptAt, last_scan_error: "invalid_result",
    });
  }
});

test("partial result coverage keeps valid peers and missing outcomes rotate normally", async () => {
  const records = recordsMap([record(1), record(2), record(3)]);
  const summary = await runAddressVerificationQueue(records, {
    limit: 2, concurrency: 1, now: () => attemptAt,
    verify: async (inputs) => new Map([[inputs[0].address, result(inputs[0])]]),
  });
  assert.deepEqual(summary, { eligible: 3, attempted: 2, completed: 1, failed: 1 });
  assert.equal(records.get(addressKey(record(1)))?.last_scan_complete_at, attemptAt);
  assert.equal(records.get(addressKey(record(2)))?.last_scan_error, "missing_result");
  await runAddressVerificationQueue(records, {
    limit: 1, concurrency: 1, now: () => completeAt,
    verify: async (inputs) => {
      assert.equal(inputs[0].address, record(3).address);
      return new Map();
    },
  });
});

test("extra results fail the selected batch without modifying unrelated records", async () => {
  const values = [record(1), record(2), record(3)];
  const records = recordsMap(values);
  const summary = await runAddressVerificationQueue(records, {
    limit: 2, concurrency: 1, now: () => attemptAt,
    verify: async (inputs) => new Map([
      ...inputs.map((input) => [input.address, result(input)] as const),
      [record(99).address, result(inputs[0], { address: record(99).address })],
    ]),
  });
  assert.deepEqual(summary, { eligible: 3, attempted: 2, completed: 0, failed: 2 });
  for (const value of values.slice(0, 2)) assert.deepEqual(records.get(addressKey(value)), {
    ...value, last_scan_attempt_at: attemptAt, last_scan_error: "invalid_result",
  });
  assert.deepEqual(records.get(addressKey(values[2])), values[2]);
});
