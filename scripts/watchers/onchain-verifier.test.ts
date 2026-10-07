import test from "node:test";
import assert from "node:assert/strict";
import { runAddressVerificationQueue } from "../lib/address-scheduler.ts";
import { addressKey, type AddressVerificationRecord } from "../lib/verification-model.ts";

test("transient JSON-RPC retry classification survives redaction and aggregate failures stay bounded", { concurrency: false }, async () => {
  process.env.BASE_RPC_RETRIES = "1";
  process.env.BASE_RPC_BACKOFF_MS = "0";
  const { verifyAddressesIncremental, verifyPayoutAddresses } = await import("./onchain-verifier.ts");
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const messages: string[] = [];
  const marker = "PRIVATE_RETRY_CANARY_DO_NOT_LOG";
  const address = `0x${"1".repeat(40)}`;
  const failure = (message: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1,
    error: { code: -32000, message: `${message} ${marker}` },
  }), { status: 200 });
  console.log = (...args) => { messages.push(args.join(" ")); };
  try {
    for (const transient of ["rate limit", "temporarily unavailable"]) {
      let heads = 0;
      globalThis.fetch = async (_input, init) => {
        const { method } = JSON.parse(String(init?.body));
        if (method === "eth_blockNumber") return ++heads === 1 ? failure(transient) : jsonRpcResponse("0x64");
        assert.equal(method, "eth_getLogs");
        return jsonRpcResponse([]);
      };
      const results = await verifyAddressesIncremental([{ address, lastScannedBlock: 80 }]);
      assert.equal(heads, 2, "transient head error must retry before scanning");
      assert.equal(results.get(address)?.scanComplete, true);
      assert.equal(results.get(address)?.lastScannedBlock, 100);
      process.env.BASE_RPC_RETRIES = "0";
      globalThis.fetch = async () => failure(transient);
      await assert.rejects(verifyAddressesIncremental([{ address, lastScannedBlock: 80 }]), (error: Error & { retryable?: boolean }) => {
        assert.equal(error.message, "RPC error: provider_error");
        assert.equal(error.retryable, true);
        assert.ok(!String(error.stack).includes(marker));
        return true;
      });
      process.env.BASE_RPC_RETRIES = "1";
    }
    process.env.BASE_RPC_RETRIES = "0";
    globalThis.fetch = async () => { throw new Error(marker); };
    await assert.rejects(verifyPayoutAddresses([{ domain: "example.com", payoutAddress: address }]), (error: AggregateError) => {
      assert.equal(error.message, "Payout verification failed");
      assert.deepEqual(error.errors.map(cause => cause.message), ["unexpected_error"]);
      assert.ok(!error.errors.some(cause => String(cause.stack).includes(marker)));
      return true;
    });
    assert.ok(!messages.join("\n").includes(marker));
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    process.env.BASE_RPC_RETRIES = "0";
  }
});

test("provider-controlled errors never enter logs or persisted queue evidence", { concurrency: false }, async () => {
  process.env.BASE_RPC_RETRIES = "0";
  process.env.BASE_LOG_QUERY_DELAY_MS = "0";
  const { verifyAddressesIncremental } = await import("./onchain-verifier.ts");
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const messages: string[] = [];
  const marker = "PRIVATE_PROVIDER_CANARY_DO_NOT_LOG";
  const previousAt = "2026-09-01T00:00:00.000Z";
  const attemptAt = "2026-09-20T12:00:00.000Z";
  const prior: AddressVerificationRecord = {
    protocol: "x402", network: "base", asset: "USDC", address: `0x${"1".repeat(40)}`,
    verification_state: "verified", verification_method: "base_usdc_transfer_scan",
    tx_count: 3, volume_usd: 9.5, first_tx: previousAt, last_tx: previousAt, last_tx_hash: "0xabc",
    first_verified_at: previousAt, last_verified_at: previousAt, last_scanned_block: 80,
    last_scan_complete_at: previousAt,
  };
  const rpcError = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1,
    error: { code: -32000, message: marker, data: { secret: marker } },
  }), { status: 200 });
  console.log = (...args) => { messages.push(args.join(" ")); };
  try {
    for (const failure of ["rpc", "http", "transport", "json"]) {
      messages.length = 0;
      globalThis.fetch = async (_input, init) => {
        const { method } = JSON.parse(String(init?.body));
        if (method === "eth_blockNumber") return jsonRpcResponse("0x64");
        assert.equal(method, "eth_getLogs");
        if (failure === "rpc") return rpcError();
        if (failure === "http") return new Response(marker, { status: 429, statusText: marker });
        if (failure === "transport") throw new Error(marker);
        return new Response(marker, { status: 200 });
      };
      const records = new Map([[addressKey(prior), { ...prior }]]);
      const summary = await runAddressVerificationQueue(records, {
        limit: 5, concurrency: 1, verify: verifyAddressesIncremental, now: () => attemptAt,
      });
      assert.deepEqual(summary, { eligible: 1, attempted: 1, completed: 0, failed: 1 });
      assert.deepEqual(records.get(addressKey(prior)), {
        ...prior, last_scan_attempt_at: attemptAt, last_scan_error: "incomplete_scan",
      });
      assert.ok(messages.includes("[onchain]   Chunk 81-100 failed: incomplete_scan"), failure);
      assert.ok(!messages.join("\n").includes(marker), failure);
    }
    globalThis.fetch = async () => rpcError();
    await assert.rejects(verifyAddressesIncremental([{ address: prior.address, lastScannedBlock: 80 }]),
      (error: Error) => error.message === "RPC error: provider_error");
    globalThis.fetch = async () => new Response(marker, { status: 429, statusText: marker });
    await assert.rejects(verifyAddressesIncremental([{ address: prior.address, lastScannedBlock: 80 }]),
      (error: Error) => error.message === "RPC HTTP 429");
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

function transferLog(toAddress: string, changes: Record<string, unknown> = {}) {
  return {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    removed: false,
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      `0x${"0".repeat(24)}${"a".repeat(40)}`,
      `0x${toAddress.slice(2).padStart(64, "0")}`,
    ],
    data: `0x${(2_000_000).toString(16).padStart(64, "0")}`,
    blockNumber: "0x60",
    transactionHash: `0x${"f".repeat(64)}`,
    ...changes,
  };
}

function jsonRpcResponse(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("permanent provider failures stop at the failed chunk and preserve queued history", { concurrency: false }, async (t) => {
  process.env.BASE_RPC_RETRIES = "5";
  process.env.BASE_LOG_QUERY_DELAY_MS = "0";
  const { verifyAddressesIncremental } = await import("./onchain-verifier.ts");
  const previousAt = "2026-09-01T00:00:00.000Z";
  const attemptedAt = "2026-10-07T12:00:00.000Z";
  const prior: AddressVerificationRecord = {
    protocol: "x402", network: "base", asset: "USDC", address: `0x${"1".repeat(40)}`,
    verification_state: "verified", verification_method: "base_usdc_transfer_scan",
    tx_count: 3, volume_usd: 9.5, first_tx: previousAt, last_tx: previousAt, last_tx_hash: "0xabc",
    first_verified_at: previousAt, last_verified_at: previousAt, last_scanned_block: 80,
    last_scan_attempt_at: previousAt, last_scan_complete_at: previousAt, last_scan_error: null,
  };
  for (const [status, code, message] of [
    [413, -32614, "eth_getLogs is limited to a 500 range"],
    [200, -32614, "eth_getLogs is limited to a 500 range"],
    [200, -32602, "invalid params"],
  ] as const) {
    await t.test(`HTTP ${status}, JSON-RPC ${code}`, async (st) => {
      const ranges: number[][] = [];
      st.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
        const { method, params } = JSON.parse(String(init.body));
        if (method === "eth_blockNumber") return jsonRpcResponse("0x439");
        assert.equal(method, "eth_getLogs");
        ranges.push([Number(params[0].fromBlock), Number(params[0].toBlock)]);
        if (ranges.length === 1) return jsonRpcResponse([transferLog(prior.address)]);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message } }), { status });
      });
      const records = new Map([[addressKey(prior), { ...prior }]]);
      const summary = await runAddressVerificationQueue(records, {
        limit: 1, concurrency: 1, verify: verifyAddressesIncremental, now: () => attemptedAt,
      });
      assert.deepEqual(ranges, [[81, 580], [581, 1080]], "neither retry a permanent response nor scan past the gap");
      assert.deepEqual(summary, { eligible: 1, attempted: 1, completed: 0, failed: 1 });
      assert.deepEqual(records.get(addressKey(prior)), {
        ...prior, last_scan_attempt_at: attemptedAt, last_scan_error: "incomplete_scan",
      });
    });
  }
});

test("fresh scan fits the old request allowance; retries and peers share the hard cap", { concurrency: false }, async (t) => {
  process.env.BASE_RPC_RETRIES = "1";
  process.env.BASE_RPC_BACKOFF_MS = "0";
  process.env.BASE_LOG_QUERY_DELAY_MS = "0";
  const { verifyAddressesIncremental } = await import("./onchain-verifier.ts");
  t.mock.method(Math, "random", () => 0);
  for (const concurrency of [1, 2]) {
    for (const count of [1, 2]) {
      let calls = 0;
      let logCalls = 0;
      const inputs = Array.from({ length: count }, (_, i) => ({
        address: `0x${String(i + 1).repeat(40)}`, lastScannedBlock: null,
      }));
      t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
        calls++;
        const { method, params } = JSON.parse(String(init.body));
        if (calls === 1) return new Response("", { status: 429 });
        if (method === "eth_blockNumber") return jsonRpcResponse("0x186a00"); // 1,600,000
        assert.equal(method, "eth_getLogs");
        assert.ok(Number(params[0].toBlock) - Number(params[0].fromBlock) + 1 <= 500);
        logCalls++;
        return calls === 3500
          ? new Response("", { status: 429, headers: { "retry-after": "3600" } })
          : jsonRpcResponse([]);
      });
      const results = await verifyAddressesIncremental(inputs, concurrency);
      assert.equal(calls, count === 1 ? 2603 : 3500, "budget counts head requests and retries");
      assert.equal(logCalls, calls - 2);
      assert.equal(results.size, count);
      for (const result of results.values()) {
        if (result.scanComplete) {
          assert.equal(result.lastScannedBlock, 1_600_000);
        } else {
          assert.equal(result.lastScannedBlock, null);
          assert.equal(result.totalTransactions, 0);
          assert.equal(result.scanError, "budget_deferred");
        }
      }
      const completeCount = [...results.values()].filter(result => result.scanComplete).length;
      assert.equal(completeCount, concurrency === 1 || count === 1 ? 1 : 0);
    }
  }
});

test("permanent or malformed final responses are failures, not budget deferrals", { concurrency: false }, async (t) => {
  process.env.BASE_RPC_RETRIES = "5";
  process.env.BASE_LOG_QUERY_DELAY_MS = "0";
  const { verifyAddressesIncremental } = await import("./onchain-verifier.ts");
  const head = 2_000_000;
  for (const failure of ["http", "rpc", "malformed", "json", "null", "array"]) {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
      calls++;
      const { method } = JSON.parse(String(init.body));
      if (method === "eth_blockNumber") return jsonRpcResponse(`0x${head.toString(16)}`);
      assert.equal(method, "eth_getLogs");
      if (calls !== 3500) return jsonRpcResponse([]);
      if (failure === "malformed") return jsonRpcResponse([{}]);
      if (failure === "json") return new Response("{");
      if (failure === "null") return new Response("null");
      if (failure === "array") return new Response("[]");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1,
        error: { code: -32614, message: "eth_getLogs is limited to a 500 range" },
      }), { status: failure === "http" ? 413 : 200 });
    });
    const inputs = [head - 1, head - 3498 * 500, head - 1].map((lastScannedBlock, i) => ({
      address: `0x${String(i + 1).repeat(40)}`, lastScannedBlock,
    }));
    const results = await verifyAddressesIncremental(inputs, 1);
    assert.equal(calls, 3500);
    assert.equal(results.get(inputs[0].address)!.scanComplete, true);
    assert.equal(results.get(inputs[1].address)!.scanError, "incomplete_scan", failure);
    assert.equal(results.get(inputs[2].address)!.scanError, "budget_deferred", failure);
  }
});

test("malformed JSON and non-object RPC envelopes are not retried", { concurrency: false }, async (t) => {
  process.env.BASE_RPC_RETRIES = "5";
  process.env.BASE_LOG_QUERY_DELAY_MS = "0";
  const { verifyAddressesIncremental } = await import("./onchain-verifier.ts");
  const input = { address: `0x${"1".repeat(40)}`, lastScannedBlock: 99 };
  for (const body of ["{", "null", "[]", "true", "1", '"unexpected"']) {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return calls === 1 ? jsonRpcResponse("0x64") : new Response(body);
    });
    const result = (await verifyAddressesIncremental([input], 1)).get(input.address)!;
    assert.equal(calls, 2, body);
    assert.equal(result.scanComplete, false, body);
    assert.equal(result.scanError, "incomplete_scan", body);
    assert.equal(result.lastScannedBlock, input.lastScannedBlock, body);
  }
});

test("five sequential candidates retain completed scans and give deferrals a fresh allocation", { concurrency: false }, async (t) => {
  process.env.BASE_RPC_RETRIES = "0";
  process.env.BASE_LOG_QUERY_DELAY_MS = "0";
  const { verifyAddressesIncremental } = await import("./onchain-verifier.ts");
  const head = 1_600_000;
  const previousAt = "2026-09-01T00:00:00.000Z";
  const eventAt = "2026-09-15T00:00:00.000Z";
  const originals: AddressVerificationRecord[] = Array.from({ length: 5 }, (_, i) => {
    const fresh = i % 5 === 1;
    return {
      protocol: "x402", network: "base", asset: "USDC", address: `0x${(i + 1).toString(16).padStart(40, "0")}`,
      verification_state: fresh ? "pending" : "verified", verification_method: "base_usdc_transfer_scan",
      tx_count: fresh ? 0 : 3, volume_usd: fresh ? 0 : 9.5,
      first_tx: fresh ? null : previousAt, last_tx: fresh ? null : previousAt, last_tx_hash: fresh ? null : "0xabc",
      first_verified_at: fresh ? null : previousAt, last_verified_at: fresh ? null : previousAt,
      last_scanned_block: fresh ? null : i % 5 === 3 ? 0 : head - 500,
      last_scan_attempt_at: new Date(Date.parse(previousAt) + i * 1000).toISOString(),
      last_scan_complete_at: fresh ? null : previousAt, last_scan_error: null,
    };
  });
  let records = new Map(originals.map(record => [addressKey(record), record]));
  const attempts: string[] = [];
  for (let run = 0; run < 2; run++) {
    const attemptedAt = new Date(Date.parse("2026-10-07T00:00:00Z") + run * 86_400_000).toISOString();
    const completedAt = new Date(Date.parse(attemptedAt) + 60_000).toISOString();
    let calls = 0;
    let ticks = 0;
    const queried = new Set<string>();
    t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
      calls++;
      const { method, params } = JSON.parse(String(init.body));
      if (method === "eth_blockNumber") return jsonRpcResponse(`0x${head.toString(16)}`);
      if (method === "eth_getBlockByNumber") {
        return jsonRpcResponse({ timestamp: `0x${(Date.parse(eventAt) / 1000).toString(16)}` });
      }
      assert.equal(method, "eth_getLogs");
      const address = `0x${params[0].topics[2].slice(-40)}`;
      if (queried.has(address)) return jsonRpcResponse([]);
      queried.add(address);
      return jsonRpcResponse([transferLog(address, { blockNumber: params[0].fromBlock })]);
    });
    const summary = await runAddressVerificationQueue(records, {
      limit: 5, concurrency: 1, now: () => ticks++ === 0 ? attemptedAt : completedAt,
      verify: (inputs, concurrency) => {
        assert.equal(inputs.length, 5);
        assert.equal(concurrency, 1);
        attempts.push(...inputs.map(input => input.address));
        return verifyAddressesIncremental(inputs, concurrency);
      },
    });
    assert.ok(calls <= 3500);
    if (run === 0) {
      assert.equal(calls, 3500);
      assert.deepEqual(summary, { eligible: 5, attempted: 5, completed: 3, failed: 2 });
      originals.slice(run * 5, run * 5 + 5).forEach((prior, index) => {
        const updated = records.get(addressKey(prior))!;
        if (index < 3) {
          assert.equal(updated.last_scanned_block, head);
          assert.equal(updated.tx_count, prior.tx_count + 1);
          assert.equal(updated.volume_usd, prior.volume_usd + 2);
          assert.equal(updated.last_tx, eventAt);
          assert.equal(updated.first_tx, prior.first_tx ?? eventAt);
          assert.equal(updated.last_scan_complete_at, completedAt);
          assert.equal(updated.last_scan_error, null);
        } else {
          assert.deepEqual(updated, { ...prior, last_scan_attempt_at: attemptedAt, last_scan_error: "budget_deferred" });
          assert.equal(queried.has(prior.address), index === 3, "exhausted budget must not start the final candidate");
        }
      });
    } else {
      assert.deepEqual(summary, { eligible: 5, attempted: 5, completed: 5, failed: 0 });
      assert.equal(attempts[5], originals[3].address, "previously deferred cursor gets first use of the next budget");
    }
    // Exercise the same persisted attempt metadata that the next scheduled run reads.
    records = new Map((JSON.parse(JSON.stringify([...records.values()])) as AddressVerificationRecord[])
      .map(record => [addressKey(record), record]));
  }
  assert.deepEqual(attempts.slice(0, 5), originals.map(record => record.address));
  assert.ok([...records.values()].every(record => record.last_scan_attempt_at! >= "2026-10-07"));
});

test("moving-head mixed 38-address cohort completes without recurring allocation starvation", { concurrency: false }, async (t) => {
  process.env.BASE_RPC_RETRIES = "0";
  process.env.BASE_LOG_QUERY_DELAY_MS = "0";
  const { verifyAddressesIncremental } = await import("./onchain-verifier.ts");
  t.mock.method(console, "log", () => {});
  // Freeze the review snapshot's cursor/attempt cohorts, in equivalent address-key order.
  const cursors = [51984417, 52028280, 52070650, 52113172, 52156973, 52201239, 51941075];
  const cohorts = [3, 1, 4, 4, 1, 6, 4, 6, 4, 1, 2, 4, 5, 5, 5, 5, 7, 5, 7,
    2, 2, 3, 6, 6, 6, 2, 2, 7, 7, 0, 0, 0, 7, 3, 3, 1, 1, 3];
  const initial = cohorts.map((cohort, i): AddressVerificationRecord => ({
    protocol: "x402", network: "base", asset: "USDC", address: `0x${(i + 1).toString(16).padStart(40, "0")}`,
    verification_state: "verified", verification_method: "base_usdc_transfer_scan",
    tx_count: 3, volume_usd: 9.5, first_tx: null, last_tx: null, last_tx_hash: "0xabc",
    first_verified_at: null, last_verified_at: null,
    last_scanned_block: [5, 18, 32].includes(i) ? null : cursors[i === 27 ? 6 : cohort === 7 ? 0 : cohort],
    last_scan_attempt_at: new Date(Date.parse("2026-09-30T08:00:00Z") + cohort * 86_400_000).toISOString(),
  }));
  let records = new Map(initial.map(record => [addressKey(record), record]));
  const completions = new Map<string, number>();
  const lastCompleteDay = new Map<string, number>();
  let head = 52_306_979;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    calls++;
    const { method } = JSON.parse(String(init.body));
    assert.ok(method === "eth_blockNumber" || method === "eth_getLogs");
    return jsonRpcResponse(method === "eth_blockNumber" ? `0x${head.toString(16)}` : []);
  });
  for (let day = 0; day < 120; day++) {
    calls = 0;
    const now = new Date(Date.parse("2026-10-07T20:00:00Z") + day * 86_400_000).toISOString();
    const summary = await runAddressVerificationQueue(records, {
      limit: 5, concurrency: 1, verify: verifyAddressesIncremental, now: () => now,
    });
    assert.equal(summary.attempted, 5);
    assert.ok(calls <= 3500, `day ${day} exceeded the shared request allowance`);
    for (const record of records.values()) {
      assert.equal(record.tx_count, 3);
      assert.equal(record.volume_usd, 9.5);
      if (record.last_scanned_block === head) {
        completions.set(record.address, (completions.get(record.address) ?? 0) + 1);
        lastCompleteDay.set(record.address, day);
      }
    }
    records = new Map((JSON.parse(JSON.stringify([...records.values()])) as AddressVerificationRecord[])
      .map(record => [addressKey(record), record]));
    head += 43_200;
  }
  assert.equal(completions.size, 38, "every initially feasible address must complete under healthy RPC");
  for (const record of initial) {
    assert.ok(completions.get(record.address)! >= 5, "progress must continue after the first completion");
    assert.ok(lastCompleteDay.get(record.address)! >= 100, "no address may remain stuck through the final 20 days");
  }
});

test("a backlog exceeding the whole request budget remains incomplete on repeated attempts", { concurrency: false }, async (t) => {
  process.env.BASE_RPC_RETRIES = "0";
  process.env.BASE_LOG_QUERY_DELAY_MS = "0";
  const { verifyAddressesIncremental } = await import("./onchain-verifier.ts");
  const input = {
    address: `0x${"1".repeat(40)}`, lastScannedBlock: 80,
    priorTotals: {
      totalTransactions: 3, totalVolumeUsdc: 9.5, firstTxTimestamp: "2026-09-01T00:00:00.000Z",
      lastTxTimestamp: "2026-09-01T00:00:00.000Z", lastTxHash: "0xabc",
      firstVerifiedAt: "2026-09-01T00:00:00.000Z", lastVerifiedAt: "2026-09-01T00:00:00.000Z",
    },
  };
  for (let run = 0; run < 2; run++) {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
      calls++;
      const { method } = JSON.parse(String(init.body));
      if (method === "eth_blockNumber") return jsonRpcResponse("0x1e8480"); // 2,000,000
      assert.equal(method, "eth_getLogs");
      return jsonRpcResponse([]);
    });
    const result = (await verifyAddressesIncremental([input], 1)).get(input.address)!;
    assert.equal(calls, 3500);
    assert.deepEqual(result, {
      ...input.priorTotals, address: input.address, lastScannedBlock: 80,
      verificationState: "verified", scanComplete: false, scanError: "incomplete_scan",
    });
  }
});

test("an oversized deferred first candidate loses priority and cannot monopolize subsequent runs", { concurrency: false }, async (t) => {
  process.env.BASE_RPC_RETRIES = "0";
  process.env.BASE_LOG_QUERY_DELAY_MS = "0";
  const { verifyAddressesIncremental } = await import("./onchain-verifier.ts");
  const head = 2_000_000;
  const previousAt = "2026-09-01T00:00:00.000Z";
  const originals = Array.from({ length: 6 }, (_, i): AddressVerificationRecord => ({
    protocol: "x402", network: "base", asset: "USDC", address: `0x${(i + 1).toString(16).padStart(40, "0")}`,
    verification_state: "verified", verification_method: "base_usdc_transfer_scan",
    tx_count: 3, volume_usd: 9.5, first_tx: previousAt, last_tx: previousAt, last_tx_hash: "0xabc",
    first_verified_at: previousAt, last_verified_at: previousAt,
    last_scanned_block: i === 0 ? 80 : head - 1, last_scan_complete_at: previousAt,
    last_scan_attempt_at: previousAt, last_scan_error: i === 0 ? "budget_deferred" : null,
  }));
  const records = new Map(originals.map(record => [addressKey(record), record]));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    calls++;
    const { method } = JSON.parse(String(init.body));
    assert.ok(method === "eth_blockNumber" || method === "eth_getLogs");
    return jsonRpcResponse(method === "eth_blockNumber" ? `0x${head.toString(16)}` : []);
  });
  const attemptedAt = "2026-10-07T00:00:00.000Z";
  const first = await runAddressVerificationQueue(records, {
    limit: 5, concurrency: 1, verify: verifyAddressesIncremental, now: () => attemptedAt,
  });
  assert.deepEqual(first, { eligible: 6, attempted: 5, completed: 0, failed: 5 });
  assert.equal(calls, 3500);
  originals.slice(0, 5).forEach((prior, i) => assert.deepEqual(records.get(addressKey(prior)), {
    ...prior, last_scan_attempt_at: attemptedAt, last_scan_error: i === 0 ? "incomplete_scan" : "budget_deferred",
  }));
  const oversizedAfterFirst = records.get(addressKey(originals[0]));
  calls = 0;
  const second = await runAddressVerificationQueue(records, {
    limit: 5, concurrency: 1, verify: verifyAddressesIncremental, now: () => "2026-10-08T00:00:00.000Z",
  });
  assert.deepEqual(second, { eligible: 6, attempted: 5, completed: 5, failed: 0 });
  assert.equal(calls, 6);
  assert.deepEqual(records.get(addressKey(originals[0])), oversizedAfterFirst);
  for (const prior of originals.slice(1)) {
    assert.equal(records.get(addressKey(prior))!.last_scanned_block, head);
    assert.equal(records.get(addressKey(prior))!.last_scan_error, null);
  }
});

test("the invocation deadline retains completed entries and stops subsequent chunks and peers", { concurrency: false }, async (t) => {
  process.env.BASE_RPC_RETRIES = "5";
  process.env.BASE_LOG_QUERY_DELAY_MS = "0";
  const { verifyAddressesIncremental } = await import("./onchain-verifier.ts");
  const controller = new AbortController();
  const originalTimeout = AbortSignal.timeout;
  let deadlines = 0;
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    if (ms !== 900_000) return originalTimeout(ms);
    deadlines++;
    return controller.signal;
  });
  let logCalls = 0;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    const { method } = JSON.parse(String(init.body));
    if (method === "eth_blockNumber") return jsonRpcResponse("0x439");
    assert.equal(method, "eth_getLogs");
    logCalls++;
    if (logCalls === 1) return jsonRpcResponse([]);
    return new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      controller.abort();
    });
  });
  const results = await verifyAddressesIncremental([1, 2, 3].map(i => ({
    address: `0x${String(i).repeat(40)}`, lastScannedBlock: i === 1 ? 1080 : 80,
  })), 1);
  assert.equal(deadlines, 1);
  assert.equal(logCalls, 2);
  assert.equal(results.size, 3);
  assert.equal(results.get(`0x${"1".repeat(40)}`)!.scanComplete, true);
  assert.equal(results.get(`0x${"1".repeat(40)}`)!.lastScannedBlock, 1081);
  for (const result of [...results.values()].slice(1)) {
    assert.equal(result.scanComplete, false);
    assert.equal(result.lastScannedBlock, 80);
    assert.equal(result.scanError, "budget_deferred");
  }
});

test("deadline cancels Retry-After backoff and inter-chunk pacing", { concurrency: false }, async (t) => {
  const { verifyAddressesIncremental } = await import("./onchain-verifier.ts");
  for (const backoff of [true, false]) {
    await t.test(backoff ? "retry backoff" : "query pacing", async (st) => {
      process.env.BASE_RPC_RETRIES = "5";
      process.env.BASE_LOG_QUERY_DELAY_MS = "10000";
      const controller = new AbortController();
      const originalTimeout = AbortSignal.timeout;
      st.mock.method(AbortSignal, "timeout", (ms: number) => ms === 900_000 ? controller.signal : originalTimeout(ms));
      let logCalls = 0;
      st.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
        const { method } = JSON.parse(String(init.body));
        if (method === "eth_blockNumber") return jsonRpcResponse("0x439");
        logCalls++;
        setImmediate(() => controller.abort());
        return backoff
          ? new Response("", { status: 429, headers: { "retry-after": "3600" } })
          : jsonRpcResponse([]);
      });
      const address = `0x${"1".repeat(40)}`;
      const result = (await verifyAddressesIncremental([{ address, lastScannedBlock: 80 }])).get(address)!;
      assert.equal(logCalls, 1);
      assert.equal(result.scanComplete, false);
      assert.equal(result.lastScannedBlock, 80);
      assert.equal(result.scanError, "incomplete_scan", "the first candidate received the full time allocation");
    });
  }
  process.env.BASE_LOG_QUERY_DELAY_MS = "0";
});

test("missing and malformed block timestamps never fabricate transaction history", { concurrency: false }, async (t) => {
  process.env.BASE_RPC_RETRIES = "0";
  process.env.BASE_LOG_QUERY_DELAY_MS = "0";
  const { verifyAddressesIncremental, verifyPayoutAddress } = await import("./onchain-verifier.ts");
  const address = `0x${"1".repeat(40)}`;
  const previousAt = "2026-09-01T00:00:00.000Z";
  for (const block of [null, {}, { timestamp: null }, { timestamp: 1 }, { timestamp: "0x1junk" }, { timestamp: "0x20000000000000" }]) {
    t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
      const { method } = JSON.parse(String(init.body));
      if (method === "eth_blockNumber") return jsonRpcResponse("0x64");
      if (method === "eth_getLogs") return jsonRpcResponse([transferLog(address)]);
      assert.equal(method, "eth_getBlockByNumber");
      return jsonRpcResponse(block);
    });
    const single = await verifyPayoutAddress(address, 20);
    assert.equal(single.scanComplete, true);
    assert.equal(single.totalTransactions, 1);
    assert.equal(single.firstTxTimestamp, null);
    assert.equal(single.lastTxTimestamp, null);
    for (const prior of [false, true]) {
      const incremental = (await verifyAddressesIncremental([{
        address, lastScannedBlock: 80,
        ...(prior ? { priorTotals: {
          totalTransactions: 3, totalVolumeUsdc: 9.5,
          firstTxTimestamp: previousAt, lastTxTimestamp: previousAt, lastTxHash: "0xabc",
          firstVerifiedAt: previousAt, lastVerifiedAt: previousAt,
        } } : {}),
      }])).get(address)!;
      assert.equal(incremental.firstTxTimestamp, prior ? previousAt : null);
      assert.equal(incremental.lastTxTimestamp, prior ? previousAt : null);
      assert.equal(incremental.totalTransactions, prior ? 4 : 1);
      assert.equal(incremental.scanComplete, true);
      assert.equal(incremental.lastScannedBlock, 100);
    }
  }
});

for (const failMiddle of [false, true]) {
  test(`public RPC ranges are contiguous and bounded; middle failure=${failMiddle}`, { concurrency: false }, async () => {
    process.env.BASE_RPC_RETRIES = "0";
    process.env.BASE_LOG_QUERY_DELAY_MS = "0";
    const { verifyAddressesIncremental } = await import("./onchain-verifier.ts");
    const originalFetch = globalThis.fetch;
    const ranges: number[][] = [];
    globalThis.fetch = async (_input, init) => {
      const { method, params } = JSON.parse(String(init?.body));
      if (method === "eth_blockNumber") return jsonRpcResponse("0x439"); // 1081
      assert.equal(method, "eth_getLogs");
      const range = [Number(params[0].fromBlock), Number(params[0].toBlock)];
      ranges.push(range);
      assert.ok(range[1] - range[0] + 1 <= 500);
      if (failMiddle && ranges.length === 2) return new Response("range rejected", { status: 413 });
      return jsonRpcResponse(failMiddle ? [transferLog(`0x${"1".repeat(40)}`, {
        blockNumber: params[0].fromBlock,
      })] : []);
    };
    try {
      const address = "0x1111111111111111111111111111111111111111";
      const results = await verifyAddressesIncremental([{
        address,
        lastScannedBlock: 80,
        priorTotals: {
          totalTransactions: 3, totalVolumeUsdc: 9.5,
          firstTxTimestamp: null, lastTxTimestamp: null, lastTxHash: "0xabc",
          firstVerifiedAt: "2026-03-24T00:00:00.000Z", lastVerifiedAt: "2026-03-25T00:00:00.000Z",
        },
      }], 1);
      assert.deepEqual(ranges, failMiddle ? [[81, 580], [581, 1080]] : [[81, 580], [581, 1080], [1081, 1081]]);
      const result = results.get(address)!;
      assert.equal(result.scanComplete, !failMiddle);
      assert.equal(result.lastScannedBlock, failMiddle ? 80 : 1081);
      assert.equal(result.totalTransactions, 3);
      assert.equal(result.totalVolumeUsdc, 9.5);
      assert.equal(result.lastTxHash, "0xabc");
      assert.equal(result.verificationState, "verified");
      assert.equal(result.lastVerifiedAt, "2026-03-25T00:00:00.000Z");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test("verifyAddressesIncremental preserves prior verified evidence on incomplete scans", { concurrency: false }, async () => {
  process.env.BASE_RPC_RETRIES = "0";
  process.env.BASE_RPC_BACKOFF_MS = "0";
  process.env.BASE_LOG_QUERY_DELAY_MS = "0";
  const { verifyAddressesIncremental } = await import("./onchain-verifier.ts");
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const method = JSON.parse(String(init?.body || "{}")).method;
    if (method === "eth_blockNumber") return jsonRpcResponse("0x64");
    if (method === "eth_getLogs") {
      return new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
    }
    throw new Error(`Unexpected RPC method: ${method}`);
  };

  try {
    const results = await verifyAddressesIncremental([{
      address: "0x1111111111111111111111111111111111111111",
      lastScannedBlock: 80,
      priorTotals: {
        totalTransactions: 3,
        totalVolumeUsdc: 9.5,
        firstTxTimestamp: "2026-03-20T00:00:00.000Z",
        lastTxTimestamp: "2026-03-24T00:00:00.000Z",
        lastTxHash: "0xabc",
        firstVerifiedAt: "2026-03-24T00:00:00.000Z",
        lastVerifiedAt: "2026-03-25T00:00:00.000Z",
      },
    }], 1);

    const result = results.get("0x1111111111111111111111111111111111111111");
    assert.ok(result);
    assert.equal(result.verificationState, "verified");
    assert.equal(result.scanComplete, false);
    assert.equal(result.totalTransactions, 3);
    assert.equal(result.lastScannedBlock, 80);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verifyAddressesIncremental advances cursor and accumulates new activity", { concurrency: false }, async () => {
  process.env.BASE_RPC_RETRIES = "0";
  process.env.BASE_RPC_BACKOFF_MS = "0";
  process.env.BASE_LOG_QUERY_DELAY_MS = "0";
  const { verifyAddressesIncremental } = await import("./onchain-verifier.ts");
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    const method = body.method;

    if (method === "eth_blockNumber") return jsonRpcResponse("0x64");
    if (method === "eth_getLogs") {
      return jsonRpcResponse([transferLog(`0x${"5".repeat(40)}`)]);
    }
    if (method === "eth_getBlockByNumber") {
      const blockNumber = body.params?.[0];
      if (blockNumber === "0x60") return jsonRpcResponse({ timestamp: "0x67d0c400" });
      throw new Error(`Unexpected block request: ${blockNumber}`);
    }

    throw new Error(`Unexpected RPC method: ${method}`);
  };

  try {
    const results = await verifyAddressesIncremental([{
      address: "0x5555555555555555555555555555555555555555",
      lastScannedBlock: 80,
      priorTotals: {
        totalTransactions: 1,
        totalVolumeUsdc: 2,
        firstTxTimestamp: "2026-03-20T00:00:00.000Z",
        lastTxTimestamp: "2026-03-20T00:00:00.000Z",
        lastTxHash: "0xold",
        firstVerifiedAt: "2026-03-20T00:00:00.000Z",
        lastVerifiedAt: "2026-03-20T00:00:00.000Z",
      },
    }], 1);

    const result = results.get("0x5555555555555555555555555555555555555555");
    assert.ok(result);
    assert.equal(result.verificationState, "verified");
    assert.equal(result.scanComplete, true);
    assert.equal(result.totalTransactions, 2);
    assert.equal(result.totalVolumeUsdc, 4);
    assert.equal(result.lastTxHash, `0x${"f".repeat(64)}`);
    assert.equal(result.lastScannedBlock, 100);
    assert.equal(result.firstTxTimestamp, new Date(parseInt("0x67d0c400", 16) * 1000).toISOString());
    assert.equal(result.lastTxTimestamp, "2026-03-20T00:00:00.000Z");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unexpected per-address failures return explicit incomplete results without dropping peers", { concurrency: false }, async () => {
  process.env.BASE_RPC_RETRIES = "0";
  process.env.BASE_LOG_QUERY_DELAY_MS = "0";
  const { verifyAddressesIncremental } = await import("./onchain-verifier.ts");
  const originalFetch = globalThis.fetch;
  const failing = `0x${"1".repeat(40)}`;
  const healthy = `0x${"2".repeat(40)}`;
  const priorTotals = {
    totalTransactions: 3, totalVolumeUsdc: 9.5, firstTxTimestamp: "2026-03-20T00:00:00Z",
    lastTxTimestamp: "2026-03-24T00:00:00Z", lastTxHash: "0xabc",
    firstVerifiedAt: "2026-03-24T00:00:00Z", lastVerifiedAt: "2026-03-25T00:00:00Z",
  };
  globalThis.fetch = async (_input, init) => {
    const { method } = JSON.parse(String(init?.body));
    if (method === "eth_blockNumber") return jsonRpcResponse("0x64");
    assert.equal(method, "eth_getLogs");
    return jsonRpcResponse([]);
  };
  try {
    let firstRead = true;
    const failingTotals = {
      ...priorTotals,
      get totalTransactions() {
        if (firstRead) { firstRead = false; throw new Error("unexpected aggregation failure"); }
        return priorTotals.totalTransactions;
      },
    };
    const results = await verifyAddressesIncremental([failing, healthy].map((address) => ({
      address, lastScannedBlock: 80, priorTotals: address === failing ? failingTotals : priorTotals,
    })), 2);
    assert.equal(results.size, 2);
    assert.deepEqual(results.get(failing), {
      address: failing, verificationState: "verified", scanComplete: false, scanError: "unexpected_error",
      ...priorTotals, lastScannedBlock: 80,
    });
    assert.equal(results.get(healthy)?.scanComplete, true);
    assert.equal(results.get(healthy)?.lastScannedBlock, 100);
  } finally { globalThis.fetch = originalFetch; }
});

test("malformed provider head fails explicitly rather than advancing a corrupt cursor", { concurrency: false }, async () => {
  const { verifyAddressesIncremental, verifyPayoutAddresses } = await import("./onchain-verifier.ts");
  const originalFetch = globalThis.fetch;
  try {
    for (const head of [null, "0xnope", "0x20000000000000"]) {
      globalThis.fetch = async () => jsonRpcResponse(head);
      await assert.rejects(verifyAddressesIncremental([{ address: `0x${"1".repeat(40)}`, lastScannedBlock: 80 }]), /Invalid RPC block number/);
    }
    await assert.rejects(verifyPayoutAddresses([{ domain: "example.com", payoutAddress: `0x${"1".repeat(40)}` }]), /Payout verification failed/);
  } finally { globalThis.fetch = originalFetch; }
});

test("empty input and invalid concurrency do not start an RPC request", { concurrency: false }, async () => {
  const { verifyAddressesIncremental } = await import("./onchain-verifier.ts");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { assert.fail("must not contact RPC"); };
  try {
    assert.equal((await verifyAddressesIncremental([])).size, 0);
    for (const concurrency of [0, -1, 1.5, Infinity]) {
      await assert.rejects(verifyAddressesIncremental([], concurrency), /Concurrency must be/);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("cursor ahead of the provider head is incomplete until the head catches up", { concurrency: false }, async () => {
  const { verifyAddressesIncremental } = await import("./onchain-verifier.ts");
  const originalFetch = globalThis.fetch;
  let head = 100;
  const input = {
    address: `0x${"1".repeat(40)}`, lastScannedBlock: 101,
    priorTotals: {
      totalTransactions: 3, totalVolumeUsdc: 9.5, firstTxTimestamp: "2026-03-20T00:00:00Z",
      lastTxTimestamp: "2026-03-24T00:00:00Z", lastTxHash: "0xabc",
      firstVerifiedAt: "2026-03-24T00:00:00Z", lastVerifiedAt: "2026-03-25T00:00:00Z",
    },
  };
  globalThis.fetch = async (_input, init) => {
    const { method } = JSON.parse(String(init?.body));
    assert.equal(method, "eth_blockNumber");
    return jsonRpcResponse(`0x${head.toString(16)}`);
  };
  try {
    const incomplete = (await verifyAddressesIncremental([input])).get(input.address)!;
    assert.deepEqual(incomplete, {
      address: input.address, verificationState: "verified", scanComplete: false, scanError: "cursor_ahead_of_head",
      ...input.priorTotals, lastScannedBlock: 101,
    });
    head = 101;
    const complete = (await verifyAddressesIncremental([input])).get(input.address)!;
    assert.equal(complete.scanComplete, true);
    assert.equal(complete.lastScannedBlock, 101);
    assert.equal(complete.totalTransactions, 3);
    assert.equal(complete.lastVerifiedAt, input.priorTotals.lastVerifiedAt);
  } finally { globalThis.fetch = originalFetch; }
});

test("actual verifier queue rejects malformed log responses without advancing historical evidence", { concurrency: false }, async (t) => {
  process.env.BASE_RPC_RETRIES = "0";
  process.env.BASE_LOG_QUERY_DELAY_MS = "0";
  const { verifyAddressesIncremental } = await import("./onchain-verifier.ts");
  const originalFetch = globalThis.fetch;
  const previousAt = "2026-09-01T00:00:00.000Z";
  const attemptedAt = "2026-09-20T12:00:00.000Z";
  const completedAt = "2026-09-20T12:01:00.000Z";
  const prior: AddressVerificationRecord = {
    protocol: "x402", network: "base", asset: "USDC", address: `0x${"1".repeat(40)}`,
    verification_state: "verified", verification_method: "base_usdc_transfer_scan",
    tx_count: 3, volume_usd: 9.5, first_tx: previousAt, last_tx: previousAt, last_tx_hash: "0xabc",
    first_verified_at: previousAt, last_verified_at: previousAt, last_scanned_block: 80,
    last_scan_attempt_at: previousAt, last_scan_complete_at: previousAt, last_scan_error: null,
  };
  const valid = transferLog(prior.address);
  const cases: [string, unknown][] = [
    ["null result", null], ["missing result", undefined], ["object result", {}], ["string result", ""],
    ["null log", [null]], ["primitive log", [1]], ["array log", [[]]], ["empty log", [{}]],
    ["mixed valid and malformed logs", [valid, null]],
    ...Object.keys(valid).map((field): [string, unknown] => [`missing ${field}`, [{ ...valid, [field]: undefined }]]),
    ["non-array topics", [{ ...valid, topics: {} }]],
    ["short topics", [{ ...valid, topics: valid.topics.slice(0, 2) }]],
    ["extra topics", [{ ...valid, topics: [...valid.topics, valid.topics[1]] }]],
    ["wrong event", [{ ...valid, topics: [valid.topics[1], ...valid.topics.slice(1)] }]],
    ["malformed sender", [{ ...valid, topics: [valid.topics[0], "0xabc", valid.topics[2]] }]],
    ["non-address sender", [{ ...valid, topics: [valid.topics[0], `0x${"a".repeat(64)}`, valid.topics[2]] }]],
    ["wrong recipient", [{ ...valid, topics: [valid.topics[0], valid.topics[1], valid.topics[1]] }]],
    ["wrong contract", [{ ...valid, address: prior.address }]],
    ["removed log", [{ ...valid, removed: true }]],
    ["nonboolean removed", [{ ...valid, removed: "false" }]],
    ["invalid amount", [{ ...valid, data: "0xnope" }]],
    ["truncated amount", [{ ...valid, data: "0x1e8480" }]],
    ["negative amount", [{ ...valid, data: "-1" }]],
    ["oversized amount", [{ ...valid, data: `0x${"f".repeat(66)}` }]],
    ["nonstring amount", [{ ...valid, data: 0 }]],
    ["invalid block", [{ ...valid, blockNumber: "0x60junk" }]],
    ["pending block", [{ ...valid, blockNumber: null }]],
    ["numeric block", [{ ...valid, blockNumber: 96 }]],
    ["noncanonical block", [{ ...valid, blockNumber: "0x060" }]],
    ["unsafe block", [{ ...valid, blockNumber: "0x20000000000000" }]],
    ["block before range", [{ ...valid, blockNumber: "0x50" }]],
    ["block after range", [{ ...valid, blockNumber: "0x65" }]],
    ["malformed transaction hash", [{ ...valid, transactionHash: "0xfeed" }]],
  ];
  try {
    for (const [name, payload] of [...cases, ["valid empty", []], ["valid transfer", [valid]]] as [string, unknown][]) {
      await t.test(name, async () => {
        let logCalls = 0;
        globalThis.fetch = async (_input, init) => {
          const { method, params } = JSON.parse(String(init?.body));
          if (method === "eth_blockNumber") return jsonRpcResponse("0x64");
          if (method === "eth_getLogs") {
            logCalls++;
            assert.equal(params[0].fromBlock, "0x51");
            assert.equal(params[0].toBlock, "0x64");
            assert.equal(params[0].topics[2], valid.topics[2]);
            return jsonRpcResponse(payload);
          }
          assert.equal(name, "valid transfer", "malformed logs must never reach timestamp resolution");
          assert.equal(method, "eth_getBlockByNumber");
          return jsonRpcResponse({ timestamp: "0x67d0c400" });
        };
        const records = new Map([[addressKey(prior), { ...prior }]]);
        let ticks = 0;
        const summary = await runAddressVerificationQueue(records, {
          limit: 5, concurrency: 1, verify: verifyAddressesIncremental,
          now: () => ticks++ === 0 ? attemptedAt : completedAt,
        });
        assert.equal(logCalls, 1);
        const updated = records.get(addressKey(prior))!;
        if (!name.startsWith("valid ")) {
          assert.deepEqual(summary, { eligible: 1, attempted: 1, completed: 0, failed: 1 });
          assert.deepEqual(updated, { ...prior, last_scan_attempt_at: attemptedAt, last_scan_error: "incomplete_scan" });
        } else {
          assert.deepEqual(summary, { eligible: 1, attempted: 1, completed: 1, failed: 0 });
          assert.equal(updated.last_scanned_block, 100);
          assert.equal(updated.last_scan_complete_at, completedAt);
          assert.equal(updated.last_scan_error, null);
          assert.equal(updated.tx_count, name === "valid transfer" ? 4 : 3);
          assert.equal(updated.volume_usd, name === "valid transfer" ? 11.5 : 9.5);
        }
      });
    }
  } finally { globalThis.fetch = originalFetch; }
});
