/**
 * Watcher Orchestrator — Phase 2
 *
 * Runs all registered payment rail watchers, collects discovered domains
 * and transaction stats, and feeds them back into the registry.
 *
 * Called by the nightly crawl job. Can also run standalone:
 *   npx tsx scripts/crawler/watchers/index.ts
 */

import type { PaymentEvent, PaymentRailWatcher, DomainTransactionStats, WatcherCheckpoint } from "./types";
import { X402Watcher } from "./x402";
import { Index402Watcher } from "./index402";

/* ── Registry of all watcher adapters ── */

const WATCHERS: PaymentRailWatcher[] = [
  new X402Watcher(),       // x402scan.com (~1,900 domains) + 402index.io x402 services
  new Index402Watcher(),   // 402index.io L402 + MPP services
];

/* ── Checkpoint persistence (via GitHub repo file) ── */

const DEFAULT_CHECKPOINT: WatcherCheckpoint = {
  protocol: "",
  lastTimestamp: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // 24h ago
};

/**
 * Run all watchers and return discovered domains + transaction stats.
 */
export async function runWatchers(checkpoints?: Map<string, WatcherCheckpoint>): Promise<{
  newDomains: { domain: string; source: string }[];
  transactionStats: DomainTransactionStats[];
  events: PaymentEvent[];
  updatedCheckpoints: Map<string, WatcherCheckpoint>;
}> {
  const allEvents: PaymentEvent[] = [];
  const updatedCheckpoints = new Map<string, WatcherCheckpoint>();

  // Run all watchers in parallel — they hit independent API endpoints
  // and share no mutable state.
  const watcherJobs = WATCHERS.map((watcher) => {
    const checkpoint = checkpoints?.get(watcher.protocol) || {
      ...DEFAULT_CHECKPOINT,
      protocol: watcher.protocol,
    };
    console.log(`[watcher] Running ${watcher.protocol} watcher (since ${checkpoint.lastTimestamp})...`);
    return { watcher, checkpoint };
  });

  const results = await Promise.allSettled(
    watcherJobs.map(({ watcher, checkpoint }) =>
      watcher.fetchEvents(checkpoint.lastTimestamp).then((events) => ({
        watcher,
        checkpoint,
        events,
      }))
    )
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const { watcher, checkpoint } = watcherJobs[i];

    if (result.status === "fulfilled") {
      const { events } = result.value;
      console.log(`[watcher] ${watcher.protocol}: ${events.length} events found`);
      allEvents.push(...events);
      updatedCheckpoints.set(watcher.protocol, {
        protocol: watcher.protocol,
        lastTimestamp: new Date().toISOString(),
      });
    } else {
      console.error(`[watcher] ${watcher.protocol} failed:`, result.reason);
      // Keep old checkpoint on failure
      updatedCheckpoints.set(watcher.protocol, checkpoint);
    }
  }

  // Aggregate: extract unique domains
  const domainSet = new Map<string, string>(); // domain → source
  for (const event of allEvents) {
    if (event.domain && !domainSet.has(event.domain)) {
      domainSet.set(event.domain, `onchain-${event.protocol}`);
    }
  }

  const newDomains = Array.from(domainSet.entries()).map(([domain, source]) => ({
    domain,
    source,
  }));

  // Aggregate: transaction stats per domain per day
  // Only count USDC/USD amounts — skip BTC/other assets to avoid unit confusion
  const statsMap = new Map<string, DomainTransactionStats>();
  for (const event of allEvents) {
    if (!event.domain) continue;
    const date = event.timestamp.split("T")[0];
    const key = `${event.domain}:${date}:${event.protocol}`;

    const existing = statsMap.get(key) || {
      domain: event.domain,
      date,
      protocol: event.protocol,
      txCount: 0,
      volumeUsd: 0,
    };

    existing.txCount++;
    // Only aggregate USD-denominated amounts (USDC, USD). Skip BTC, etc.
    const asset = event.asset.toUpperCase();
    if (asset === "USDC" || asset === "USD" || asset === "USDT") {
      existing.volumeUsd += parseFloat(event.amount) || 0;
    }
    statsMap.set(key, existing);
  }

  const transactionStats = Array.from(statsMap.values());

  return { newDomains, transactionStats, events: allEvents, updatedCheckpoints };
}

/* ── Standalone execution ── */
/* Run directly: npx tsx scripts/crawler/watchers/index.ts */

const isMain = typeof require !== "undefined"
  ? require.main === module
  : process.argv[1]?.includes("watchers/index");

if (isMain) {
  (async () => {
    console.log("=== On-Chain Watcher — Standalone Run ===");
    const result = await runWatchers();
    console.log(`Discovered ${result.newDomains.length} domains:`);
    for (const d of result.newDomains) {
      console.log(`  ${d.domain} (${d.source})`);
    }
    console.log(`Transaction stats: ${result.transactionStats.length} domain-day records`);
    console.log(`Total events: ${result.events.length}`);
  })().catch(console.error);
}
