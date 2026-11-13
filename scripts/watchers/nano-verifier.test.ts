import test from "node:test";
import assert from "node:assert/strict";
import { runAddressVerificationQueue } from "../lib/address-scheduler.ts";
import {
  addressKey,
  isNanoClaim,
  isValidNanoAddress,
  isVerifierSupported,
  materializeEntryVerification,
  seedAddressVerifications,
  type Claim,
} from "../lib/verification-model.ts";
import { resolveNanoRpcUrl, verifyNanoAddressesIncremental } from "./nano-verifier.ts";

// A real, public account (its history is on the Nano ledger); the chain below is a synthetic
// stand-in for it so the tests stay offline and deterministic.
const ADDRESS = "nano_3m8cz87zwxb1y16ob4bzp1eyek78qaig8ktohk7d45b18sh6u9exbowbnekr";
const OTHER = "nano_1434j1n4sin4cefs5njibag4tsmo596fmg3s6bdogtod3ndmdfez5yuebrh9";
const BURN = "nano_1111111111111111111111111111111111111111111111111111hifc8npp";
const hash = (n: number) => n.toString(16).toUpperCase().padStart(64, "0");

process.env.NANO_RPC_URL = "http://127.0.0.1:7076";
process.env.NANO_RPC_BACKOFF_MS = "0";
process.env.NANO_RPC_RETRIES = "1";

interface Block { type: string; amount?: string; local_timestamp: string; confirmed?: string }
/** A chain: block i+1 has type blocks[i]; `confirmedHeight` bounds what the node calls confirmed. */
function node(blocks: Block[], confirmedHeight = blocks.length, opts: { account?: string } = {}) {
  const calls: Array<Record<string, string>> = [];
  const fetchStub = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    calls.push(body);
    const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (opts.account !== undefined && body.account !== opts.account) return reply({ error: "Bad account number" });
    if (body.action === "account_info") return reply({ confirmed_height: String(confirmedHeight), block_count: String(blocks.length) });
    assert.equal(body.action, "account_history");
    assert.equal(body.reverse, "true");
    const offset = Number(body.offset);
    const count = Number(body.count);
    const history = blocks.slice(offset, offset + count).map((block, index) => ({
      type: block.type, account: OTHER, amount: block.amount ?? "1", local_timestamp: block.local_timestamp,
      height: String(offset + index + 1), hash: hash(offset + index + 1), confirmed: block.confirmed ?? "true",
    }));
    return reply({ account: body.account, history });
  };
  return { calls, fetchStub };
}

async function withFetch<T>(stub: unknown, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = stub as typeof fetch;
  console.log = () => {};
  try { return await run(); } finally { globalThis.fetch = original; console.log = originalLog; }
}

const verify = (stub: unknown, inputs: Parameters<typeof verifyNanoAddressesIncremental>[0]) =>
  withFetch(stub, () => verifyNanoAddressesIncremental(inputs, 2));

const T0 = "1790104521"; // 2026-09-23T...Z in the node's clock
const T1 = "1790137652";
const iso = (seconds: string) => new Date(Number(seconds) * 1000).toISOString();

test("shape check: nano_/xrb_ accounts only, the burn account refused", () => {
  assert.equal(isValidNanoAddress(ADDRESS), true);
  assert.equal(isValidNanoAddress(ADDRESS.replace("nano_", "xrb_")), true);
  for (const bad of ["", BURN, ADDRESS.slice(0, -1), ADDRESS.replace("nano_", "ban_"), ADDRESS.toUpperCase(), `0x${"1".repeat(40)}`, `${ADDRESS}0`]) {
    assert.equal(isValidNanoAddress(bad), false, bad);
  }
  assert.equal(isNanoClaim("x402", "nano:mainnet", "xno"), true);
  assert.equal(isNanoClaim("x402", "nano:mainnet", "USDC"), false);
  assert.equal(isVerifierSupported("x402", "nano:mainnet", "XNO"), true);
  assert.equal(isVerifierSupported("mpp", "nano:mainnet", "XNO"), false);
});

test("first scan counts only confirmed receive blocks and reports activity, not volume", async () => {
  const chain = node([
    { type: "receive", local_timestamp: T0 },
    { type: "send", local_timestamp: "1790104954" },
    { type: "receive", local_timestamp: T1 },
    { type: "change", local_timestamp: "1790137700" },
  ]);
  const results = await verify(chain.fetchStub, [{ address: ADDRESS, lastScannedBlock: null }]);
  const r = results.get(ADDRESS)!;
  assert.equal(r.verificationState, "verified");
  assert.equal(r.scanComplete, true);
  assert.equal(r.totalTransactions, 2);
  assert.equal(r.totalVolumeUsdc, 0);
  assert.equal(r.firstTxTimestamp, iso(T0));
  assert.equal(r.lastTxTimestamp, iso(T1));
  assert.equal(r.lastTxHash, hash(3));
  assert.equal(r.lastScannedBlock, 4);
  assert.deepEqual(chain.calls.map((c) => [c.action, c.offset]), [["account_info", undefined], ["account_history", "0"]]);
});

test("incremental scan starts at the cursor and adds to the prior totals", async () => {
  const chain = node([
    { type: "receive", local_timestamp: T0 },
    { type: "send", local_timestamp: "1790104954" },
    { type: "receive", local_timestamp: T1 },
  ]);
  const priorFirst = "2026-09-01T00:00:00.000Z";
  const results = await verify(chain.fetchStub, [{
    address: ADDRESS, lastScannedBlock: 2,
    priorTotals: { totalTransactions: 1, totalVolumeUsdc: 0, firstTxTimestamp: priorFirst, lastTxTimestamp: iso(T0), lastTxHash: hash(1), firstVerifiedAt: priorFirst, lastVerifiedAt: priorFirst },
  }]);
  const r = results.get(ADDRESS)!;
  assert.equal(chain.calls.at(-1)!.offset, "2");
  assert.equal(r.totalTransactions, 2);
  assert.equal(r.firstTxTimestamp, priorFirst);
  assert.equal(r.lastTxTimestamp, iso(T1));
  assert.equal(r.lastTxHash, hash(3));
  assert.equal(r.firstVerifiedAt, priorFirst);
  assert.equal(r.lastScannedBlock, 3);

  // Nothing new: no history request, evidence kept.
  const quiet = node([{ type: "receive", local_timestamp: T0 }]);
  const same = (await verify(quiet.fetchStub, [{
    address: ADDRESS, lastScannedBlock: 1,
    priorTotals: { totalTransactions: 1, totalVolumeUsdc: 0, firstTxTimestamp: iso(T0), lastTxTimestamp: iso(T0), lastTxHash: hash(1), firstVerifiedAt: priorFirst, lastVerifiedAt: priorFirst },
  }])).get(ADDRESS)!;
  assert.deepEqual(quiet.calls.map((c) => c.action), ["account_info"]);
  assert.equal(same.verificationState, "verified");
  assert.equal(same.totalTransactions, 1);
  assert.equal(same.lastVerifiedAt, priorFirst);
});

test("blocks above the confirmation height are never counted, and the cursor stops at it", async () => {
  const chain = node([
    { type: "receive", local_timestamp: T0 },
    { type: "receive", local_timestamp: T1, confirmed: "false" },
  ], 1);
  const r = (await verify(chain.fetchStub, [{ address: ADDRESS, lastScannedBlock: null }])).get(ADDRESS)!;
  assert.equal(r.totalTransactions, 1);
  assert.equal(r.lastScannedBlock, 1);

  // A block at or below the confirmation height that the node itself flags unconfirmed is a contradiction.
  const odd = node([{ type: "receive", local_timestamp: T0, confirmed: "false" }], 1);
  const bad = (await verify(odd.fetchStub, [{ address: ADDRESS, lastScannedBlock: null }])).get(ADDRESS)!;
  assert.equal(bad.scanComplete, false);
  assert.equal(bad.scanError, "unexpected_error");
});

test("pages through a long chain with the offset as the cursor", async () => {
  const blocks: Block[] = Array.from({ length: 1203 }, (_, i) => ({ type: i % 3 === 0 ? "receive" : "send", local_timestamp: String(1790000000 + i) }));
  const chain = node(blocks);
  const r = (await verify(chain.fetchStub, [{ address: ADDRESS, lastScannedBlock: null }])).get(ADDRESS)!;
  assert.deepEqual(chain.calls.filter((c) => c.action === "account_history").map((c) => c.offset), ["0", "500", "1000"]);
  assert.equal(r.totalTransactions, 401);
  assert.equal(r.lastScannedBlock, 1203);
  assert.equal(r.lastTxHash, hash(1201));
});

test("an unopened account is unverified at height 0; a bad checksum is invalid", async () => {
  const unopened = async () => new Response(JSON.stringify({ error: "Account not found" }), { status: 200 });
  const none = (await verify(unopened, [{ address: ADDRESS, lastScannedBlock: null }])).get(ADDRESS)!;
  assert.equal(none.verificationState, "unverified");
  assert.equal(none.scanComplete, true);
  assert.equal(none.lastScannedBlock, 0);
  assert.equal(none.totalTransactions, 0);

  const wrongChecksum = ADDRESS.slice(0, -1) + (ADDRESS.endsWith("a") ? "b" : "a");
  const bad = node([], 0, { account: ADDRESS });
  const invalid = (await verify(bad.fetchStub, [{ address: wrongChecksum, lastScannedBlock: null }])).get(wrongChecksum.toLowerCase())!;
  assert.equal(invalid.verificationState, "invalid");

  // Shape errors never reach the node.
  const silent = node([]);
  const shape = (await verify(silent.fetchStub, [{ address: BURN, lastScannedBlock: null }])).get(BURN)!;
  assert.equal(shape.verificationState, "invalid");
  assert.equal(silent.calls.length, 0);
});

test("a gap in heights, a cursor ahead of the chain and an unreachable node keep prior evidence and report incomplete", async () => {
  const prior = { totalTransactions: 2, totalVolumeUsdc: 0, firstTxTimestamp: iso(T0), lastTxTimestamp: iso(T1), lastTxHash: hash(2), firstVerifiedAt: iso(T0), lastVerifiedAt: iso(T1) };
  const gap = async (_u: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(body.action === "account_info"
      ? { confirmed_height: "10" }
      : { history: [{ type: "receive", height: "5", hash: hash(5), local_timestamp: T0, confirmed: "true" }] }));
  };
  const g = (await verify(gap, [{ address: ADDRESS, lastScannedBlock: 2, priorTotals: prior }])).get(ADDRESS)!;
  assert.deepEqual([g.scanComplete, g.scanError, g.verificationState, g.totalTransactions, g.lastScannedBlock], [false, "unexpected_error", "verified", 2, 2]);

  const ahead = node([{ type: "receive", local_timestamp: T0 }]);
  const a = (await verify(ahead.fetchStub, [{ address: ADDRESS, lastScannedBlock: 9, priorTotals: prior }])).get(ADDRESS)!;
  assert.deepEqual([a.scanComplete, a.scanError], [false, "cursor_ahead_of_head"]);

  let attempts = 0;
  const down = async () => { attempts++; return new Response("busy", { status: 503 }); };
  const d = (await verify(down, [{ address: ADDRESS, lastScannedBlock: 2, priorTotals: prior }])).get(ADDRESS)!;
  assert.deepEqual([d.scanComplete, d.scanError, d.totalTransactions], [false, "incomplete_scan", 2]);
  assert.equal(attempts, 2); // one retry
});

test("provider-controlled text never reaches the logs", async () => {
  const marker = "PRIVATE_NANO_PROVIDER_CANARY_DO_NOT_LOG";
  const lines: string[] = [];
  const original = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: marker }), { status: 200 })) as typeof fetch;
  console.log = (...args) => { lines.push(args.join(" ")); };
  try {
    const r = (await verifyNanoAddressesIncremental([{ address: ADDRESS, lastScannedBlock: null }])).get(ADDRESS)!;
    assert.equal(r.scanComplete, false);
  } finally { globalThis.fetch = original; console.log = originalLog; }
  assert.ok(!lines.join("\n").includes(marker));
});

test("node URL: https or loopback http only", () => {
  assert.equal(resolveNanoRpcUrl("https://node.example/rpc"), "https://node.example/rpc");
  assert.equal(resolveNanoRpcUrl("http://127.0.0.1:7076"), "http://127.0.0.1:7076/");
  assert.throws(() => resolveNanoRpcUrl("http://node.example/rpc"), /https/);
  assert.throws(() => resolveNanoRpcUrl("ftp://node.example"), /https/);
});

test("queue: a Nano claim is only selected with a Nano verifier, then verified under its own method", async () => {
  const claim = (address: string): Claim => ({
    protocol: "x402", network: "nano:mainnet", asset: "XNO", address, claim_source: "manifest", source_detail: "manifest.payments.x402.networks",
    confidence: "authoritative", first_seen: "2026-10-04", last_seen: "2026-10-04T00:00:00.000Z", verification_state: "pending", verification_method: null, evidence: null,
  });
  const claims = [claim(ADDRESS)];
  const never = async () => { throw new Error("the Base verifier must not see a Nano address"); };

  const withoutVerifier = seedAddressVerifications(claims, new Map());
  const none = await runAddressVerificationQueue(withoutVerifier, { limit: 5, concurrency: 2, verify: never as never });
  assert.deepEqual(none, { eligible: 0, attempted: 0, completed: 0, failed: 0 });

  const records = seedAddressVerifications(claims, new Map());
  const chain = node([{ type: "receive", local_timestamp: T0 }, { type: "receive", local_timestamp: T1 }]);
  const summary = await withFetch(chain.fetchStub, () => runAddressVerificationQueue(records, {
    limit: 5, concurrency: 2, verify: never as never, verifyNano: verifyNanoAddressesIncremental,
    now: () => "2026-10-05T00:00:00.000Z",
  }));
  assert.deepEqual(summary, { eligible: 1, attempted: 1, completed: 1, failed: 0 });
  const record = records.get(addressKey(claims[0]))!;
  assert.deepEqual(
    [record.verification_state, record.verification_method, record.tx_count, record.volume_usd, record.last_scanned_block, record.last_scan_error],
    ["verified", "nano_account_receive_scan", 2, 0, 2, null],
  );

  const { claims: out, verification } = materializeEntryVerification(claims, records, new Map());
  assert.equal(out[0].verification_state, "verified");
  assert.equal(out[0].evidence?.tx_count, 2);
  assert.equal(out[0].evidence?.last_tx_hash, hash(2));
  assert.equal(verification.domain_state, "authoritative_verified");
});

test("queue: a Nano outage fails only the Nano addresses, never a Base address in the same batch", async () => {
  const base = { protocol: "x402", network: "base", asset: "USDC", address: `0x${"1".repeat(40)}`, verification_state: "pending" as const, verification_method: null, tx_count: 0, volume_usd: 0, first_tx: null, last_tx: null, last_tx_hash: null, first_verified_at: null, last_verified_at: null, last_scanned_block: null };
  const nano = { ...base, network: "nano:mainnet", asset: "XNO", address: ADDRESS };
  const records = new Map([[addressKey(base), base], [addressKey(nano), nano]]);
  const summary = await runAddressVerificationQueue(records, {
    limit: 5, concurrency: 2, now: () => "2026-10-05T00:00:00.000Z",
    verify: async (inputs) => new Map(inputs.map((input) => [input.address.toLowerCase(), {
      address: input.address, verificationState: "unverified" as const, scanComplete: true, totalTransactions: 0, totalVolumeUsdc: 0,
      firstTxTimestamp: null, lastTxTimestamp: null, lastTxHash: null, firstVerifiedAt: null, lastVerifiedAt: null, lastScannedBlock: 100,
    }])),
    verifyNano: async () => { throw new Error("node down"); },
  });
  assert.deepEqual(summary, { eligible: 2, attempted: 2, completed: 1, failed: 1 });
  assert.equal(records.get(addressKey(base))!.verification_method, "base_usdc_transfer_scan");
  assert.equal(records.get(addressKey(nano))!.last_scan_error, "verifier_failed");
  assert.equal(records.get(addressKey(nano))!.verification_method, null);
});
