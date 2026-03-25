/**
 * On-Chain Verifier — Root Source of Truth
 *
 * This is NOT a discovery mechanism. It's a verification layer.
 * Given a payout address (from a domain's agent.json), it queries
 * the Base blockchain for actual USDC transfer events to prove
 * the domain has processed real x402 payments.
 *
 * Architecture:
 *   Discovery (x402scan, 402index)  →  "this domain claims to accept payments"
 *   Verification (this module)      →  "this address has received $X in Y transactions"
 *
 * The on-chain record is immutable and verifiable. It's the foundation
 * that everything else is validated against.
 *
 * Environment:
 *   BASE_RPC_URL  — Base mainnet RPC endpoint (default: public)
 */

const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";

// USDC on Base (6 decimals)
const USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// ERC-20 Transfer(address indexed from, address indexed to, uint256 value)
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// How far back to look: ~30 days on Base (~2s blocks = ~1.3M blocks)
const DEFAULT_LOOKBACK_BLOCKS = 1_300_000;

// Max blocks per eth_getLogs request (some RPCs limit to 10k)
const BLOCKS_PER_QUERY = 10_000;
const RPC_RETRIES = parseInt(process.env.BASE_RPC_RETRIES || "5", 10) || 5;
const RPC_BACKOFF_MS = parseInt(process.env.BASE_RPC_BACKOFF_MS || "1000", 10) || 1000;
const LOG_QUERY_DELAY_MS = parseInt(process.env.BASE_LOG_QUERY_DELAY_MS || "150", 10) || 150;

/** Verified on-chain payment activity for a single payout address */
export interface OnChainVerification {
  payoutAddress: string;
  verified: boolean;          // true if at least 1 inbound USDC transfer exists
  scanComplete: boolean;      // false if one or more log chunks could not be read
  totalTransactions: number;  // count of inbound USDC transfers
  totalVolumeUsdc: number;    // sum of all inbound USDC (human-readable)
  firstTxTimestamp: string | null;  // ISO — earliest known transfer
  lastTxTimestamp: string | null;   // ISO — most recent transfer
  lastTxHash: string | null;        // most recent tx hash for auditability
  blockRangeScanned: {
    from: number;
    to: number;
  };
}

function log(msg: string): void {
  console.log(`[onchain] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableRpcMessage(message: string): boolean {
  return /429|rate limit|too many requests|timeout|temporar|header not found|busy|unavailable|gateway/i.test(message);
}

function getBackoffMs(attempt: number, retryAfterHeader: string | null = null): number {
  const retryAfterSeconds = Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }

  const jitterMs = Math.floor(Math.random() * 250);
  return Math.min(15_000, RPC_BACKOFF_MS * (2 ** attempt)) + jitterMs;
}

/* ── RPC Helpers ── */

async function rpcCall(method: string, params: unknown[], retries = RPC_RETRIES): Promise<unknown> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(BASE_RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const error = new Error(`RPC HTTP ${res.status}: ${res.statusText}`) as Error & {
          retryAfterHeader?: string | null;
        };
        error.retryAfterHeader = res.headers.get("retry-after");
        throw error;
      }
      const data = await res.json() as { result?: unknown; error?: { message: string } };
      if (data.error) throw new Error(`RPC error: ${data.error.message}`);
      return data.result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const retryAfterHeader =
        typeof e === "object" && e !== null && "retryAfterHeader" in e
          ? String((e as { retryAfterHeader?: string | null }).retryAfterHeader ?? "")
          : null;
      const retryable =
        isRetryableRpcMessage(message)
        || !(message.startsWith("RPC HTTP 4") && !message.startsWith("RPC HTTP 429"));

      if (attempt === retries || !retryable) throw e;
      await sleep(getBackoffMs(attempt, retryAfterHeader));
    }
  }
  throw new Error("unreachable");
}

async function getLatestBlock(): Promise<number> {
  const hex = (await rpcCall("eth_blockNumber", [])) as string;
  return parseInt(hex, 16);
}

async function getBlockTimestamp(blockHex: string): Promise<string> {
  const block = (await rpcCall("eth_getBlockByNumber", [blockHex, false])) as {
    timestamp: string;
  } | null;
  if (!block) return new Date().toISOString();
  return new Date(parseInt(block.timestamp, 16) * 1000).toISOString();
}

interface TransferLog {
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
}

async function getUsdcTransfersTo(
  toAddress: string,
  fromBlock: number,
  toBlock: number
): Promise<TransferLog[]> {
  const paddedTo = "0x" + toAddress.slice(2).toLowerCase().padStart(64, "0");

  const result = (await rpcCall("eth_getLogs", [
    {
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
      address: USDC_CONTRACT,
      topics: [
        TRANSFER_TOPIC,
        null,       // from: any sender
        paddedTo,   // to: the payout address
      ],
    },
  ])) as TransferLog[];

  return result || [];
}

/* ── Core Verification ── */

/**
 * Verify a single payout address against Base on-chain data.
 *
 * Queries USDC Transfer events where `to` = payoutAddress.
 * Returns transaction count, volume, and timestamps.
 */
// Addresses that should never be treated as real payout addresses
const BLOCKED_ADDRESSES = new Set([
  "0x0000000000000000000000000000000000000000", // zero/burn address
  "0x000000000000000000000000000000000000dead", // common burn address
  USDC_CONTRACT.toLowerCase(),                   // USDC contract itself
]);

export async function verifyPayoutAddress(
  payoutAddress: string,
  lookbackBlocks: number = DEFAULT_LOOKBACK_BLOCKS
): Promise<OnChainVerification> {
  const invalid = !payoutAddress
    || !payoutAddress.startsWith("0x")
    || payoutAddress.length !== 42
    || BLOCKED_ADDRESSES.has(payoutAddress.toLowerCase());

  if (invalid) {
    return {
      payoutAddress,
      verified: false,
      scanComplete: true,
      totalTransactions: 0,
      totalVolumeUsdc: 0,
      firstTxTimestamp: null,
      lastTxTimestamp: null,
      lastTxHash: null,
      blockRangeScanned: { from: 0, to: 0 },
    };
  }

  const latestBlock = await getLatestBlock();
  const fromBlock = Math.max(0, latestBlock - lookbackBlocks);

  let allLogs: TransferLog[] = [];
  let failedChunks = 0;

  // Scan in chunks to avoid RPC limits
  for (let start = fromBlock; start <= latestBlock; start += BLOCKS_PER_QUERY) {
    const end = Math.min(start + BLOCKS_PER_QUERY - 1, latestBlock);
    try {
      const logs = await getUsdcTransfersTo(payoutAddress, start, end);
      allLogs.push(...logs);
    } catch (e) {
      failedChunks++;
      log(`  Chunk ${start}-${end} failed: ${e instanceof Error ? e.message : e}`);
    }

    if (end < latestBlock && LOG_QUERY_DELAY_MS > 0) {
      await sleep(LOG_QUERY_DELAY_MS);
    }
  }

  const scanComplete = failedChunks === 0;

  if (allLogs.length === 0) {
    return {
      payoutAddress,
      verified: false,
      scanComplete,
      totalTransactions: 0,
      totalVolumeUsdc: 0,
      firstTxTimestamp: null,
      lastTxTimestamp: null,
      lastTxHash: null,
      blockRangeScanned: { from: fromBlock, to: latestBlock },
    };
  }

  // Sort by block number ascending
  allLogs.sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16));

  // Calculate total volume using BigInt arithmetic to avoid precision loss
  let totalVolumeRaw = BigInt(0);
  for (const txLog of allLogs) {
    try {
      totalVolumeRaw += BigInt(txLog.data || "0x0");
    } catch {
      // Skip malformed log data
    }
  }
  // Divide in BigInt space first, then convert the smaller number to Number
  const wholeDollars = totalVolumeRaw / BigInt(1_000_000);
  const remainder = totalVolumeRaw % BigInt(1_000_000);
  const totalVolumeUsdc = Number(wholeDollars) + Number(remainder) / 1_000_000;

  // Get timestamps for first and last transactions
  const firstLog = allLogs[0];
  const lastLog = allLogs[allLogs.length - 1];

  let firstTxTimestamp: string | null = null;
  let lastTxTimestamp: string | null = null;

  try {
    firstTxTimestamp = await getBlockTimestamp(firstLog.blockNumber);
    lastTxTimestamp = firstLog === lastLog
      ? firstTxTimestamp
      : await getBlockTimestamp(lastLog.blockNumber);
  } catch {
    // Timestamp resolution is best-effort
  }

  return {
    payoutAddress,
    verified: true,
    scanComplete,
    totalTransactions: allLogs.length,
    totalVolumeUsdc,
    firstTxTimestamp,
    lastTxTimestamp,
    lastTxHash: lastLog.transactionHash,
    blockRangeScanned: { from: fromBlock, to: latestBlock },
  };
}

/**
 * Batch verify multiple payout addresses.
 * Runs with controlled concurrency to respect RPC rate limits.
 */
export async function verifyPayoutAddresses(
  addresses: { domain: string; payoutAddress: string }[],
  concurrency: number = 3
): Promise<Map<string, OnChainVerification>> {
  const results = new Map<string, OnChainVerification>();

  // Deduplicate by address (multiple domains might share an address)
  const uniqueAddresses = new Map<string, string[]>(); // address → domains
  for (const { domain, payoutAddress } of addresses) {
    if (!payoutAddress) continue;
    const normalized = payoutAddress.toLowerCase();
    const existing = uniqueAddresses.get(normalized) || [];
    existing.push(domain);
    uniqueAddresses.set(normalized, existing);
  }

  log(`Verifying ${uniqueAddresses.size} unique payout addresses across ${addresses.length} domains...`);

  const entries = Array.from(uniqueAddresses.entries());

  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);

    const batchResults = await Promise.allSettled(
      batch.map(async ([address, domains]) => {
        const verification = await verifyPayoutAddress(address);

        // Map result to all domains sharing this address
        for (const domain of domains) {
          results.set(domain, verification);
        }

        if (!verification.scanComplete) {
          log(`  ${domains[0]}: partial on-chain scan, preserving prior data`);
        } else if (verification.verified) {
          log(`  ${domains[0]}: ${verification.totalTransactions} txs, $${verification.totalVolumeUsdc.toFixed(2)} USDC`);
        }

        return verification;
      })
    );

    // Log progress
    const done = Math.min(i + concurrency, entries.length);
    if (done % 10 === 0 || done === entries.length) {
      log(`  Progress: ${done}/${entries.length} addresses verified`);
    }
  }

  const verifiedCount = Array.from(results.values()).filter((v) => v.verified).length;
  const incompleteCount = Array.from(results.values()).filter((v) => !v.scanComplete).length;
  log(
    `Verification complete: ${verifiedCount}/${results.size} domains have on-chain activity`
      + (incompleteCount > 0 ? ` (${incompleteCount} incomplete scan(s))` : "")
  );

  return results;
}
