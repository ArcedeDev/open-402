/**
 * Nano activity verifier.
 *
 * Given a declared Nano payout account, reads its confirmed account chain from a public node and
 * counts the confirmed `receive` blocks (a receive/open block credits the account with a send
 * from another account). This is the Nano counterpart of the Base/USDC transfer scan and carries
 * the same, accurately labelled evidence: independently observed activity on a declared account,
 * NOT proof that a particular API request was settled, and not proof that the domain controls the
 * account beyond the manifest declaring it.
 *
 * What it reports: confirmed receive count, first/last receive time (the node's own first-seen
 * time), and the last receive's block hash. It reports no volume: `totalVolumeUsdc` is always 0
 * because XNO is not priced here.
 *
 * Reads only. Two RPC actions: `account_info` (with `include_confirmed`, for the confirmation
 * height that bounds what is counted) and `account_history` (`reverse`, paged with `offset`, the
 * number of blocks already scanned, which is the cursor). Blocks above the confirmation height or
 * flagged unconfirmed are never counted.
 *
 * Environment:
 *   NANO_RPC_URL      Nano node RPC endpoint (default: a public node). https, or loopback http.
 *   NANO_RPC_RETRIES  retries per request on transient failure (default 3)
 *   NANO_RPC_BACKOFF_MS  base back-off (default 1000)
 */

import { setTimeout as sleep } from "node:timers/promises";
import type { IncrementalVerificationInput, IncrementalVerificationResult } from "./onchain-verifier.ts";
import { isValidNanoAddress } from "../lib/verification-model.ts";

const DEFAULT_NANO_RPC_URL = "https://rainstorm.city/api";
const PAGE_SIZE = 500;
// Blocks read per address per run; the cursor carries the rest to the next run.
const MAX_PAGES_PER_ADDRESS = 20;
// Shared across all addresses of a run, retries included.
const REQUEST_BUDGET = 400;
const RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;

function log(message: string): void {
  console.log(`[nano] ${message}`);
}

function readNonNegativeIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

/** The node URL: https, or http on loopback only (a forged reply would admit false evidence). */
export function resolveNanoRpcUrl(value: string | undefined = process.env.NANO_RPC_URL): string {
  const raw = value && value.trim() ? value.trim() : DEFAULT_NANO_RPC_URL;
  const url = new URL(raw);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("NANO_RPC_URL must be https (http only on loopback)");
  }
  return url.toString();
}

class NodeRejected extends Error {
  reason: string;
  constructor(reason: string) {
    super(`node: ${reason}`);
    this.reason = reason;
  }
}

interface Budget {
  remaining: number;
  signal: AbortSignal;
}

async function nanoRpc(url: string, body: Record<string, string>, budget: Budget): Promise<Record<string, unknown>> {
  const retries = readNonNegativeIntEnv("NANO_RPC_RETRIES", 3);
  const backoff = readNonNegativeIntEnv("NANO_RPC_BACKOFF_MS", 1000);
  for (let attempt = 0; attempt <= retries; attempt++) {
    budget.signal.throwIfAborted();
    if (budget.remaining <= 0) throw new Error("budget_exhausted");
    budget.remaining--;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.any([budget.signal, AbortSignal.timeout(15_000)]),
      });
      if (!res.ok) throw Object.assign(new Error(`RPC HTTP ${res.status}`), { retryable: res.status === 429 || res.status >= 500 });
      const text = await res.text();
      if (text.length > RESPONSE_LIMIT_BYTES) throw Object.assign(new Error("RPC response too large"), { retryable: false });
      let data: unknown;
      try { data = JSON.parse(text); } catch { throw Object.assign(new Error("RPC error: invalid_json"), { retryable: false }); }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw Object.assign(new Error("RPC error: invalid_envelope"), { retryable: false });
      }
      const error = (data as { error?: unknown }).error;
      if (error !== undefined) {
        const reason = typeof error === "string" ? error : "unknown";
        // Provider text is never kept; only the two answers that mean something about the account.
        if (reason === "Bad account number" || reason === "Account not found") throw new NodeRejected(reason);
        throw Object.assign(new Error("RPC error: provider_error"), { retryable: /limit|busy|timeout|temporar/i.test(reason) });
      }
      return data as Record<string, unknown>;
    } catch (error) {
      if (error instanceof NodeRejected) throw error;
      const retryable = (error as { retryable?: boolean }).retryable
        ?? !(error instanceof Error && /^RPC HTTP 4/.test(error.message));
      if (budget.signal.aborted || attempt === retries || !retryable) throw error;
      await sleep(Math.min(15_000, backoff * 2 ** attempt), undefined, { signal: budget.signal });
    }
  }
  throw new Error("unreachable");
}

function isoFromSeconds(value: unknown): string | null {
  const seconds = typeof value === "string" && /^\d{1,12}$/.test(value) ? Number(value) : 0;
  return seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "string" && /^\d{1,12}$/.test(value) ? Number(value) : null;
}

function earlier(a: string | null, b: string | null): string | null {
  return a && b ? (a <= b ? a : b) : a ?? b;
}

function later(a: string | null, b: string | null): string | null {
  return a && b ? (a >= b ? a : b) : a ?? b;
}

function incomplete(
  input: IncrementalVerificationInput,
  scanError: NonNullable<IncrementalVerificationResult["scanError"]>
): IncrementalVerificationResult {
  const prior = input.priorTotals;
  return {
    address: input.address,
    verificationState: (prior?.totalTransactions ?? 0) > 0 ? "verified" : "incomplete",
    scanComplete: false,
    scanError,
    totalTransactions: prior?.totalTransactions ?? 0,
    totalVolumeUsdc: 0,
    firstTxTimestamp: prior?.firstTxTimestamp ?? null,
    lastTxTimestamp: prior?.lastTxTimestamp ?? null,
    lastTxHash: prior?.lastTxHash ?? null,
    firstVerifiedAt: prior?.firstVerifiedAt ?? null,
    lastVerifiedAt: prior?.lastVerifiedAt ?? null,
    lastScannedBlock: input.lastScannedBlock,
  };
}

async function verifyOne(
  url: string,
  input: IncrementalVerificationInput,
  budget: Budget,
  now: string
): Promise<IncrementalVerificationResult> {
  const prior = input.priorTotals;
  const priorTransactions = prior?.totalTransactions ?? 0;
  const cursor = input.lastScannedBlock ?? 0;
  const unchanged = (verified: boolean, lastScannedBlock: number): IncrementalVerificationResult => ({
    address: input.address,
    verificationState: verified ? "verified" : "unverified",
    scanComplete: true,
    totalTransactions: priorTransactions,
    totalVolumeUsdc: 0,
    firstTxTimestamp: prior?.firstTxTimestamp ?? null,
    lastTxTimestamp: prior?.lastTxTimestamp ?? null,
    lastTxHash: prior?.lastTxHash ?? null,
    firstVerifiedAt: verified ? prior?.firstVerifiedAt ?? now : null,
    lastVerifiedAt: verified ? prior?.lastVerifiedAt ?? prior?.firstVerifiedAt ?? now : null,
    lastScannedBlock,
  });

  if (!isValidNanoAddress(input.address)) {
    return { ...unchanged(priorTransactions > 0, input.lastScannedBlock ?? 0), verificationState: "invalid" };
  }

  let confirmedHeight: number;
  try {
    const info = await nanoRpc(url, { action: "account_info", account: input.address, include_confirmed: "true" }, budget);
    const height = nonNegativeInt(info.confirmed_height);
    if (height === null) return incomplete(input, "unexpected_error");
    confirmedHeight = height;
  } catch (error) {
    if (error instanceof NodeRejected) {
      // Never opened: nothing received yet. A bad checksum is the node saying the account is not an account.
      return error.reason === "Bad account number"
        ? { ...unchanged(false, cursor), verificationState: "invalid" }
        : unchanged(priorTransactions > 0, cursor);
    }
    return incomplete(input, budget.remaining <= 0 ? "budget_deferred" : "incomplete_scan");
  }
  if (cursor > confirmedHeight) return incomplete(input, "cursor_ahead_of_head");
  if (cursor === confirmedHeight) return unchanged(priorTransactions > 0, cursor);

  let scanned = cursor;
  let received = 0;
  let firstTx: string | null = null;
  let lastTx: string | null = null;
  let lastTxHash: string | null = null;
  for (let page = 0; page < MAX_PAGES_PER_ADDRESS && scanned < confirmedHeight; page++) {
    let history: Record<string, unknown>;
    try {
      history = await nanoRpc(url, {
        action: "account_history",
        account: input.address,
        count: String(PAGE_SIZE),
        reverse: "true",
        offset: String(scanned),
      }, budget);
    } catch (error) {
      if (page === 0 || error instanceof NodeRejected) {
        return incomplete(input, budget.remaining <= 0 ? "budget_deferred" : "incomplete_scan");
      }
      break; // keep what earlier pages proved; the cursor stops at the last whole page
    }
    const blocks = Array.isArray(history.history) ? history.history as Array<Record<string, unknown>> : [];
    if (blocks.length === 0) break;
    for (const block of blocks) {
      const height = nonNegativeInt(block.height);
      // Strictly the next block of the chain: a gap or a repeat means the node answered something else.
      if (height === null || height !== scanned + 1) return incomplete(input, "unexpected_error");
      // Blocks above the confirmation height are not counted yet; the next run takes them.
      if (height > confirmedHeight) break;
      if (block.confirmed === "false" || block.confirmed === false) return incomplete(input, "unexpected_error");
      scanned = height;
      if (block.type !== "receive") continue;
      if (typeof block.hash !== "string" || !/^[0-9A-Fa-f]{64}$/.test(block.hash)) return incomplete(input, "unexpected_error");
      received++;
      const at = isoFromSeconds(block.local_timestamp);
      firstTx = earlier(firstTx, at);
      lastTx = later(lastTx, at);
      lastTxHash = block.hash.toUpperCase();
    }
  }

  const totalTransactions = priorTransactions + received;
  const verified = totalTransactions > 0;
  return {
    address: input.address,
    verificationState: verified ? "verified" : "unverified",
    scanComplete: true,
    totalTransactions,
    totalVolumeUsdc: 0,
    firstTxTimestamp: earlier(prior?.firstTxTimestamp ?? null, firstTx),
    lastTxTimestamp: later(prior?.lastTxTimestamp ?? null, lastTx),
    lastTxHash: lastTxHash ?? prior?.lastTxHash ?? null,
    firstVerifiedAt: verified ? prior?.firstVerifiedAt ?? now : null,
    lastVerifiedAt: verified ? (received > 0 ? now : prior?.lastVerifiedAt ?? prior?.firstVerifiedAt ?? now) : null,
    lastScannedBlock: scanned,
  };
}

/**
 * Incremental verification of declared Nano payout accounts, same contract as
 * `verifyAddressesIncremental`: results keyed by lower-cased address; `lastScannedBlock` is the
 * confirmed chain height already counted (the cursor).
 */
export async function verifyNanoAddressesIncremental(
  addresses: IncrementalVerificationInput[],
  concurrency: number = 3
): Promise<Map<string, IncrementalVerificationResult>> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) throw new Error("Concurrency must be an integer from 1 to 100");
  const results = new Map<string, IncrementalVerificationResult>();
  if (!addresses.length) return results;
  const url = resolveNanoRpcUrl();
  const budget: Budget = { remaining: REQUEST_BUDGET, signal: AbortSignal.timeout(10 * 60 * 1000) };
  const now = new Date().toISOString();
  log(`Verifying ${addresses.length} Nano payout account(s) incrementally...`);

  for (let i = 0; i < addresses.length; i += concurrency) {
    const batch = addresses.slice(i, i + concurrency);
    const outcomes = await Promise.allSettled(batch.map((input) => verifyOne(url, input, budget, now)));
    for (const [index, outcome] of outcomes.entries()) {
      const input = batch[index];
      results.set(
        input.address.toLowerCase(),
        outcome.status === "fulfilled" ? outcome.value : incomplete(input, "unexpected_error")
      );
    }
  }
  const verifiedCount = Array.from(results.values()).filter((result) => result.verificationState === "verified").length;
  log(`Nano verification complete: ${verifiedCount}/${results.size} accounts verified`);
  return results;
}
