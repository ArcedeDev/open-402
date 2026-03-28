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

function readNonNegativeIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

function getRpcRetries(): number {
  return readNonNegativeIntEnv("BASE_RPC_RETRIES", 5);
}

function getRpcBackoffMs(): number {
  return readNonNegativeIntEnv("BASE_RPC_BACKOFF_MS", 1000);
}

function getLogQueryDelayMs(): number {
  return readNonNegativeIntEnv("BASE_LOG_QUERY_DELAY_MS", 150);
}

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

export interface IncrementalVerificationInput {
  address: string;
  lastScannedBlock: number | null;
  priorTotals?: {
    totalTransactions: number;
    totalVolumeUsdc: number;
    firstTxTimestamp: string | null;
    lastTxTimestamp: string | null;
    lastTxHash: string | null;
    firstVerifiedAt: string | null;
    lastVerifiedAt: string | null;
  };
}

export interface IncrementalVerificationResult {
  address: string;
  verificationState: "verified" | "pending" | "unverified" | "invalid" | "incomplete";
  scanComplete: boolean;
  totalTransactions: number;
  totalVolumeUsdc: number;
  firstTxTimestamp: string | null;
  lastTxTimestamp: string | null;
  lastTxHash: string | null;
  firstVerifiedAt: string | null;
  lastVerifiedAt: string | null;
  lastScannedBlock: number | null;
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
  return Math.min(15_000, getRpcBackoffMs() * (2 ** attempt)) + jitterMs;
}

/* ── RPC Helpers ── */

async function rpcCall(method: string, params: unknown[], retries = getRpcRetries()): Promise<unknown> {
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

interface RangeScanResult {
  logs: TransferLog[];
  scanComplete: boolean;
  fromBlock: number;
  toBlock: number;
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

// Number of log query chunks to run concurrently within a single address scan.
// Kept low for public RPCs; increase for dedicated endpoints.
function getChunkConcurrency(): number {
  return Math.max(1, readNonNegativeIntEnv("BASE_CHUNK_CONCURRENCY", 3));
}

async function scanAddressRange(
  payoutAddress: string,
  fromBlock: number,
  latestBlock: number
): Promise<RangeScanResult> {
  let allLogs: TransferLog[] = [];
  let failedChunks = 0;

  if (fromBlock > latestBlock) {
    return {
      logs: [],
      scanComplete: true,
      fromBlock,
      toBlock: latestBlock,
    };
  }

  // Build the list of chunk ranges up front.
  const chunks: { start: number; end: number }[] = [];
  for (let start = fromBlock; start <= latestBlock; start += BLOCKS_PER_QUERY) {
    chunks.push({ start, end: Math.min(start + BLOCKS_PER_QUERY - 1, latestBlock) });
  }

  const chunkConcurrency = getChunkConcurrency();
  const queryDelayMs = getLogQueryDelayMs();

  // Process chunks in batches of chunkConcurrency.
  for (let i = 0; i < chunks.length; i += chunkConcurrency) {
    const batch = chunks.slice(i, i + chunkConcurrency);

    const results = await Promise.allSettled(
      batch.map(({ start, end }) =>
        getUsdcTransfersTo(payoutAddress, start, end)
      )
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === "fulfilled") {
        allLogs.push(...result.value);
      } else {
        failedChunks++;
        const { start, end } = batch[j];
        log(`  Chunk ${start}-${end} failed: ${result.reason instanceof Error ? result.reason.message : result.reason}`);
      }
    }

    // Delay between batches (not between individual chunks) to respect rate limits.
    const isLastBatch = i + chunkConcurrency >= chunks.length;
    if (!isLastBatch && queryDelayMs > 0) {
      await sleep(queryDelayMs);
    }
  }

  return {
    logs: allLogs,
    scanComplete: failedChunks === 0,
    fromBlock,
    toBlock: latestBlock,
  };
}

function aggregateLogs(logs: TransferLog[], presorted = false): {
  totalTransactions: number;
  totalVolumeUsdc: number;
  lastTxHash: string | null;
  firstLog: TransferLog | null;
  lastLog: TransferLog | null;
} {
  if (logs.length === 0) {
    return {
      totalTransactions: 0,
      totalVolumeUsdc: 0,
      lastTxHash: null,
      firstLog: null,
      lastLog: null,
    };
  }

  // Logs from scanAddressRange arrive in block order (sequential chunks,
  // RPC returns logs in order within each range). Skip the copy+sort when
  // the caller guarantees order.
  const sortedLogs = presorted
    ? logs
    : [...logs].sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16));
  let totalVolumeRaw = BigInt(0);
  for (const txLog of sortedLogs) {
    try {
      totalVolumeRaw += BigInt(txLog.data || "0x0");
    } catch {
      // Skip malformed log data
    }
  }

  const wholeDollars = totalVolumeRaw / BigInt(1_000_000);
  const remainder = totalVolumeRaw % BigInt(1_000_000);
  const totalVolumeUsdc = Number(wholeDollars) + Number(remainder) / 1_000_000;

  return {
    totalTransactions: sortedLogs.length,
    totalVolumeUsdc,
    lastTxHash: sortedLogs[sortedLogs.length - 1]?.transactionHash || null,
    firstLog: sortedLogs[0] || null,
    lastLog: sortedLogs[sortedLogs.length - 1] || null,
  };
}

function chooseEarlier(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

function chooseLater(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
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
  lookbackBlocks: number = DEFAULT_LOOKBACK_BLOCKS,
  cachedLatestBlock?: number
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

  const latestBlock = cachedLatestBlock ?? await getLatestBlock();
  const fromBlock = Math.max(0, latestBlock - lookbackBlocks);
  const rangeScan = await scanAddressRange(payoutAddress, fromBlock, latestBlock);
  const allLogs = rangeScan.logs;
  const scanComplete = rangeScan.scanComplete;

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
  const aggregated = aggregateLogs(allLogs, true);
  const firstLog = aggregated.firstLog;
  const lastLog = aggregated.lastLog;

  let firstTxTimestamp: string | null = null;
  let lastTxTimestamp: string | null = null;

  try {
    if (firstLog) firstTxTimestamp = await getBlockTimestamp(firstLog.blockNumber);
    lastTxTimestamp = firstLog === lastLog
      ? firstTxTimestamp
      : lastLog ? await getBlockTimestamp(lastLog.blockNumber) : null;
  } catch {
    // Timestamp resolution is best-effort
  }

  return {
    payoutAddress,
    verified: true,
    scanComplete,
    totalTransactions: aggregated.totalTransactions,
    totalVolumeUsdc: aggregated.totalVolumeUsdc,
    firstTxTimestamp,
    lastTxTimestamp,
    lastTxHash: aggregated.lastTxHash,
    blockRangeScanned: { from: fromBlock, to: latestBlock },
  };
}

export async function verifyAddressesIncremental(
  addresses: IncrementalVerificationInput[],
  concurrency: number = 3,
  lookbackBlocks: number = DEFAULT_LOOKBACK_BLOCKS
): Promise<Map<string, IncrementalVerificationResult>> {
  const results = new Map<string, IncrementalVerificationResult>();
  const latestBlock = await getLatestBlock();
  const now = new Date().toISOString();

  log(`Verifying ${addresses.length} unique payout addresses incrementally...`);

  for (let i = 0; i < addresses.length; i += concurrency) {
    const batch = addresses.slice(i, i + concurrency);
    await Promise.allSettled(batch.map(async (input) => {
      const normalized = input.address.toLowerCase();
      const prior = input.priorTotals;
      const invalid = !input.address
        || !input.address.startsWith("0x")
        || input.address.length !== 42
        || BLOCKED_ADDRESSES.has(normalized);

      if (invalid) {
        results.set(normalized, {
          address: input.address,
          verificationState: "invalid",
          scanComplete: true,
          totalTransactions: prior?.totalTransactions || 0,
          totalVolumeUsdc: prior?.totalVolumeUsdc || 0,
          firstTxTimestamp: prior?.firstTxTimestamp || null,
          lastTxTimestamp: prior?.lastTxTimestamp || null,
          lastTxHash: prior?.lastTxHash || null,
          firstVerifiedAt: prior?.firstVerifiedAt || null,
          lastVerifiedAt: prior?.lastVerifiedAt || null,
          lastScannedBlock: input.lastScannedBlock,
        });
        return;
      }

      const fromBlock = input.lastScannedBlock != null
        ? Math.min(input.lastScannedBlock + 1, latestBlock + 1)
        : Math.max(0, latestBlock - lookbackBlocks);

      if (fromBlock > latestBlock) {
        results.set(normalized, {
          address: input.address,
          verificationState: (prior?.totalTransactions || 0) > 0 ? "verified" : "unverified",
          scanComplete: true,
          totalTransactions: prior?.totalTransactions || 0,
          totalVolumeUsdc: prior?.totalVolumeUsdc || 0,
          firstTxTimestamp: prior?.firstTxTimestamp || null,
          lastTxTimestamp: prior?.lastTxTimestamp || null,
          lastTxHash: prior?.lastTxHash || null,
          firstVerifiedAt: prior?.firstVerifiedAt || null,
          lastVerifiedAt: prior?.lastVerifiedAt || null,
          lastScannedBlock: input.lastScannedBlock,
        });
        return;
      }

      const rangeScan = await scanAddressRange(input.address, fromBlock, latestBlock);
      if (!rangeScan.scanComplete) {
        results.set(normalized, {
          address: input.address,
          verificationState: prior ? ((prior.totalTransactions || 0) > 0 ? "verified" : "incomplete") : "incomplete",
          scanComplete: false,
          totalTransactions: prior?.totalTransactions || 0,
          totalVolumeUsdc: prior?.totalVolumeUsdc || 0,
          firstTxTimestamp: prior?.firstTxTimestamp || null,
          lastTxTimestamp: prior?.lastTxTimestamp || null,
          lastTxHash: prior?.lastTxHash || null,
          firstVerifiedAt: prior?.firstVerifiedAt || null,
          lastVerifiedAt: prior?.lastVerifiedAt || null,
          lastScannedBlock: input.lastScannedBlock,
        });
        return;
      }

      const aggregated = aggregateLogs(rangeScan.logs, true);
      let firstTxTimestamp = prior?.firstTxTimestamp || null;
      let lastTxTimestamp = prior?.lastTxTimestamp || null;

      try {
        const scannedFirst = aggregated.firstLog ? await getBlockTimestamp(aggregated.firstLog.blockNumber) : null;
        const scannedLast = aggregated.lastLog
          ? aggregated.firstLog === aggregated.lastLog
            ? scannedFirst
            : await getBlockTimestamp(aggregated.lastLog.blockNumber)
          : null;
        firstTxTimestamp = chooseEarlier(firstTxTimestamp, scannedFirst);
        lastTxTimestamp = chooseLater(lastTxTimestamp, scannedLast);
      } catch {
        // Timestamp resolution is best-effort
      }

      const totalTransactions = (prior?.totalTransactions || 0) + aggregated.totalTransactions;
      const totalVolumeUsdc = (prior?.totalVolumeUsdc || 0) + aggregated.totalVolumeUsdc;
      const verified = totalTransactions > 0;

      results.set(normalized, {
        address: input.address,
        verificationState: verified ? "verified" : "unverified",
        scanComplete: true,
        totalTransactions,
        totalVolumeUsdc,
        firstTxTimestamp,
        lastTxTimestamp,
        lastTxHash: aggregated.lastTxHash || prior?.lastTxHash || null,
        firstVerifiedAt: verified ? (prior?.firstVerifiedAt || now) : null,
        lastVerifiedAt: verified
          ? (aggregated.totalTransactions > 0 ? now : prior?.lastVerifiedAt || prior?.firstVerifiedAt || now)
          : null,
        lastScannedBlock: latestBlock,
      });
    }));

    const done = Math.min(i + concurrency, addresses.length);
    if (done % 10 === 0 || done === addresses.length) {
      log(`  Progress: ${done}/${addresses.length} addresses verified`);
    }
  }

  const verifiedCount = Array.from(results.values()).filter((result) => result.verificationState === "verified").length;
  const incompleteCount = Array.from(results.values()).filter((result) => !result.scanComplete).length;
  log(
    `Incremental verification complete: ${verifiedCount}/${results.size} addresses verified`
      + (incompleteCount > 0 ? ` (${incompleteCount} incomplete scan(s))` : "")
  );

  return results;
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

  // Fetch latest block once for the entire batch instead of per-address.
  const latestBlock = await getLatestBlock();
  const entries = Array.from(uniqueAddresses.entries());

  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);

    const batchResults = await Promise.allSettled(
      batch.map(async ([address, domains]) => {
        const verification = await verifyPayoutAddress(address, DEFAULT_LOOKBACK_BLOCKS, latestBlock);

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
