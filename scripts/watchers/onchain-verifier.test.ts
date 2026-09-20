import test from "node:test";
import assert from "node:assert/strict";

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
      return jsonRpcResponse(failMiddle ? [{
        topics: [], data: "0xf4240", blockNumber: params[0].fromBlock,
        transactionHash: `0x${range[0].toString(16)}`,
      }] : []);
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
      return jsonRpcResponse([{
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "0x0000000000000000000000005555555555555555555555555555555555555555",
        ],
        data: "0x1e8480",
        blockNumber: "0x60",
        transactionHash: "0xfeed",
      }]);
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
    assert.equal(result.lastTxHash, "0xfeed");
    assert.equal(result.lastScannedBlock, 100);
    assert.equal(result.firstTxTimestamp, new Date(parseInt("0x67d0c400", 16) * 1000).toISOString());
    assert.equal(result.lastTxTimestamp, "2026-03-20T00:00:00.000Z");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
