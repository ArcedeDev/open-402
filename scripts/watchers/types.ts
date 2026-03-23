/**
 * On-Chain Watcher Types — Phase 2
 *
 * Each payment protocol gets its own watcher adapter that implements
 * PaymentRailWatcher. Adding a new protocol = writing a new adapter.
 */

export interface PaymentEvent {
  protocol: string;       // "x402" | "l402" | "mpp" | string
  resourceUrl: string;    // the API endpoint URL from the event
  domain: string;         // extracted & normalized domain
  sellerAddress: string;  // wallet/account that received payment
  amount: string;         // payment amount (human-readable)
  asset: string;          // "USDC", "BTC", "USD"
  network: string;        // "base", "lightning", "stripe"
  txHash?: string;        // on-chain tx hash (if applicable)
  timestamp: string;      // ISO timestamp
}

export interface PaymentRailWatcher {
  /** Unique protocol name e.g. "x402", "l402", "mpp" */
  protocol: string;

  /**
   * Fetch payment events since the given timestamp.
   * Returns new events discovered since lastCheckpoint.
   */
  fetchEvents(lastCheckpoint: string): Promise<PaymentEvent[]>;
}

/** Aggregated transaction stats per domain, per day */
export interface DomainTransactionStats {
  domain: string;
  date: string;           // YYYY-MM-DD
  protocol: string;
  txCount: number;
  volumeUsd: number;
}

/** Persisted watcher state — tracks where each watcher left off */
export interface WatcherCheckpoint {
  protocol: string;
  lastBlock?: number;     // for EVM chains
  lastTimestamp: string;  // ISO timestamp
  lastTxHash?: string;
}
