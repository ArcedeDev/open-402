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

for (const failMiddle of [false, true]) {
  test(`public RPC ranges are contiguous and bounded; middle failure=${failMiddle}`, { concurrency: false }, async () => {
    process.env.BASE_RPC_RETRIES = "0";
    process.env.BASE_LOG_QUERY_DELAY_MS = "0";
    const { verifyAddressesIncremental } = await import("./onchain-verifier.ts");
    const originalFetch = globalThis.fetch;
    const ranges: number[][] = [];
    globalThis.fetch = async (_input, init) => {
      const { method, params } = JSON.parse(String(init?.body));
      if (method === "eth_blockNumber") return jsonRpcResponse("0xff1"); // 4081
      assert.equal(method, "eth_getLogs");
      const range = [Number(params[0].fromBlock), Number(params[0].toBlock)];
      ranges.push(range);
      assert.ok(range[1] - range[0] + 1 <= 2_000);
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
      assert.deepEqual(ranges, [[81, 2080], [2081, 4080], [4081, 4081]]);
      const result = results.get(address)!;
      assert.equal(result.scanComplete, !failMiddle);
      assert.equal(result.lastScannedBlock, failMiddle ? 80 : 4081);
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
