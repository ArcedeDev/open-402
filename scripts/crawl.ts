#!/usr/bin/env npx tsx
/**
 * Nightly Crawler for the Open 402 Directory
 *
 * Reads domains.txt from the public registry repo, crawls each domain's
 * /.well-known/agent.json, rebuilds snapshot.json, and commits the results.
 *
 * This script is PRIVATE — it runs in our infrastructure (GitHub Action or cron)
 * and pushes to the public repo. The public repo never sees this code.
 *
 * Usage:
 *   npx tsx scripts/crawler/crawl.ts
 *
 * Environment:
 *   GITHUB_TOKEN    — PAT with write access to the public repo
 *   GITHUB_REPO     — e.g., "ArcedeDev/open-402" (default)
 *   CONCURRENCY     — Max parallel crawls (default: 15)
 *   STALE_DAYS      — Days of 404 before marking stale (default: 7)
 *   DEMOTE_DAYS     — Days of 404 before demoting to unclaimed (default: 30)
 */

const GITHUB_REPO = process.env.GITHUB_REPO || "ArcedeDev/open-402";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "15", 10) || 15;
const STALE_DAYS = parseInt(process.env.STALE_DAYS || "7", 10) || 7;
const DEMOTE_DAYS = parseInt(process.env.DEMOTE_DAYS || "30", 10) || 30;

const API_BASE = `https://api.github.com/repos/${GITHUB_REPO}`;

/* ── Types ── */

interface DomainEntry {
  domain: string;
  status: "verified" | "unclaimed";
  source: string;
  added_date: string;
}

interface SnapshotEntry {
  domain: string;
  status: "verified" | "unclaimed";
  display_name: string;
  description: string | null;
  version: string | null;
  payout_address: string | null;
  intent_count: number;
  intents: Intent[];
  protocols: string[];
  networks: string[];
  assets: string[];
  source: string;
  first_seen: string;
  last_crawled: string;
  consecutive_failures?: number;
  // On-chain verification (root source of truth)
  onchain?: {
    verified: boolean;          // has real on-chain USDC transfers
    total_transactions: number;
    total_volume_usdc: number;
    first_tx: string | null;    // ISO timestamp of earliest transfer
    last_tx: string | null;     // ISO timestamp of most recent transfer
    last_tx_hash: string | null;
    verified_at: string;        // when we last checked
  };
}

interface Intent {
  name: string;
  description: string;
  endpoint?: string;
  method?: string;
  price?: { amount: number; currency: string } | null;
}

interface EcosystemStats {
  verified_at: string;
  facilitators: { name: string; base_addresses: string[]; transactions: number; volume_usdc: number }[];
  totals: {
    transactions_24h: number; volume_usdc_24h: number; buyers_24h: number; sellers_24h: number;
    transactions_7d: number; volume_usdc_7d: number; buyers_7d: number; sellers_7d: number;
    transactions_30d: number; volume_usdc_30d: number; buyers_30d: number; sellers_30d: number;
  };
}

interface DailyHistoryPoint {
  date: string;        // YYYY-MM-DD
  transactions: number;
  volume_usdc: number;
  buyers: number;
  sellers: number;
}

interface Snapshot {
  generated_at: string;
  total: number;
  verified: number;
  unclaimed: number;
  entries: SnapshotEntry[];
  ecosystem_stats?: EcosystemStats;
  daily_history?: DailyHistoryPoint[];
}

/* ── Helpers ── */

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

function sanitize(s: unknown, maxLen: number): string {
  if (typeof s !== "string") return "";
  return stripHtml(s).slice(0, maxLen).trim();
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

/* ── Parse domains.txt ── */

function parseDomainsTxt(content: string): DomainEntry[] {
  return content
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => {
      const parts = line.split("|").map((p) => p.trim());
      return {
        domain: parts[0] || "",
        status: (parts[1] === "verified" ? "verified" : "unclaimed") as "verified" | "unclaimed",
        source: parts[2] || "unknown",
        added_date: parts[3] || new Date().toISOString().split("T")[0],
      };
    })
    .filter((e) => e.domain);
}

/* ── Crawl a single domain ── */

function isCrawlBlocked(domain: string): boolean {
  const lower = domain.toLowerCase().split(":")[0];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(lower)) return true;
  if (lower.startsWith("[") || lower.includes("::")) return true;
  const blocked = ["localhost", "127.0.0.1", "0.0.0.0", "metadata.google.internal", "169.254.169.254"];
  if (blocked.includes(lower)) return true;
  const blockedSuffix = [".local", ".internal", ".localhost", ".test", ".invalid", ".example", ".corp", ".lan"];
  if (blockedSuffix.some((s) => lower.endsWith(s))) return true;
  if (!lower.includes(".")) return true;
  return false;
}

async function crawlDomain(domain: string): Promise<{
  success: boolean;
  manifest?: Record<string, unknown>;
  error?: string;
}> {
  if (isCrawlBlocked(domain)) return { success: false, error: "blocked" };
  const url = `https://${domain}/.well-known/agent.json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000); // 8s for nightly (more generous)

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "Open402DirectoryCrawler/1.0" },
      redirect: "manual", // Don't auto-follow — validate redirect target
    });

    // Handle redirects safely — verify target isn't internal
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (location) {
        try {
          const target = new URL(location, url);
          if (isCrawlBlocked(target.hostname)) return { success: false, error: "redirect_blocked" };
          // Follow the redirect manually
          const redirectRes = await fetch(target.href, {
            signal: controller.signal,
            headers: { Accept: "application/json", "User-Agent": "Open402DirectoryCrawler/1.0" },
            redirect: "manual",
          });
          if (!redirectRes.ok) return { success: false, error: `HTTP ${redirectRes.status}` };
          const ct = redirectRes.headers.get("content-type") || "";
          if (!ct.includes("json")) return { success: false, error: "not_json" };
          const text = await redirectRes.text();
          if (text.length > 100_000) return { success: false, error: "too_large" };
          const manifest = JSON.parse(text);
          if (!manifest.version) return { success: false, error: "missing_version" };
          clearTimeout(timeout);
          return { success: true, manifest };
        } catch { return { success: false, error: "redirect_failed" }; }
      }
      return { success: false, error: "redirect_no_location" };
    }
    clearTimeout(timeout);

    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("json")) return { success: false, error: "not_json" };

    const text = await res.text();
    if (text.length > 100_000) return { success: false, error: "too_large" };

    const manifest = JSON.parse(text);
    if (!manifest.version) return { success: false, error: "missing_version" };

    return { success: true, manifest };
  } catch (e) {
    clearTimeout(timeout);
    return { success: false, error: e instanceof Error ? e.name : "unknown" };
  }
}

/* ── Extract metadata from manifest ── */

function extractEntry(
  domain: string,
  manifest: Record<string, unknown>,
  existing: SnapshotEntry | undefined,
  source: string
): SnapshotEntry {
  // Protocol extraction (same logic as web/app/directory/crawler.ts)
  const protocols: string[] = [];
  const networks: string[] = [];
  const assets: string[] = [];

  // Known payment protocols — only extract these, ignore junk field names
  const KNOWN_PROTOCOLS = new Set(["x402", "l402", "mpp"]);

  const payments = manifest.payments as Record<string, Record<string, unknown>> | undefined;
  if (payments && typeof payments === "object") {
    protocols.push(...Object.keys(payments).filter((k) => KNOWN_PROTOCOLS.has(k.toLowerCase())));
    for (const config of Object.values(payments)) {
      if (config && typeof config === "object" && Array.isArray((config as Record<string, unknown>).networks)) {
        for (const n of (config as Record<string, unknown>).networks as Record<string, unknown>[]) {
          if (typeof n.network === "string") networks.push(n.network);
          if (typeof n.asset === "string") assets.push(n.asset);
        }
      }
    }
  } else if (manifest.x402 && typeof manifest.x402 === "object" && (manifest.x402 as Record<string, unknown>).supported) {
    protocols.push("x402");
    const x402 = manifest.x402 as Record<string, unknown>;
    if (Array.isArray(x402.networks)) {
      for (const n of x402.networks as Record<string, unknown>[]) {
        if (typeof n.network === "string") networks.push(n.network);
        if (typeof n.asset === "string") assets.push(n.asset);
      }
    }
  }

  // Intents (cap at 200)
  const rawIntents = (Array.isArray(manifest.intents) ? manifest.intents : [])
    .filter((i: unknown): i is Record<string, unknown> => i != null && typeof i === "object")
    .slice(0, 200);

  const intents: Intent[] = rawIntents.map((i: Record<string, unknown>) => ({
    name: sanitize(i.name, 100),
    description: sanitize(i.description, 500),
    endpoint: typeof i.endpoint === "string" ? i.endpoint : undefined,
    method: typeof i.method === "string" ? i.method : undefined,
    price:
      i.price && typeof i.price === "object"
        ? {
            amount: Number((i.price as Record<string, unknown>).amount) || 0,
            currency: String((i.price as Record<string, unknown>).currency || "USD"),
          }
        : null,
  }));

  return {
    domain,
    status: "verified",
    display_name: sanitize(manifest.display_name, 100) || domain,
    description: sanitize(manifest.description, 500) || null,
    version: typeof manifest.version === "string" ? manifest.version : String(manifest.version),
    payout_address: typeof manifest.payout_address === "string" ? manifest.payout_address : null,
    intent_count: intents.length,
    intents,
    protocols: [...new Set(protocols)],
    networks: [...new Set(networks)],
    assets: [...new Set(assets)],
    source,
    first_seen: existing?.first_seen || new Date().toISOString().split("T")[0],
    last_crawled: new Date().toISOString(),
    consecutive_failures: 0,
    // Carry forward on-chain verification data until next verification run
    onchain: existing?.onchain,
  };
}

/* ── Concurrency-limited batch crawler ── */

async function crawlAll(
  domains: DomainEntry[],
  existingSnapshot: Map<string, SnapshotEntry>
): Promise<SnapshotEntry[]> {
  const results: SnapshotEntry[] = [];
  let completed = 0;
  const total = domains.length;

  // Process in batches
  for (let i = 0; i < domains.length; i += CONCURRENCY) {
    const batch = domains.slice(i, i + CONCURRENCY);

    const batchResults = await Promise.allSettled(
      batch.map(async (entry) => {
        const existing = existingSnapshot.get(entry.domain);
        const result = await crawlDomain(entry.domain);

        if (result.success && result.manifest) {
          // Success — verified with fresh metadata
          return extractEntry(entry.domain, result.manifest, existing, entry.source);
        }

        // Failed to crawl
        if (existing) {
          // Domain was previously in snapshot
          const failures = (existing.consecutive_failures || 0) + 1;

          if (existing.status === "verified" && failures >= DEMOTE_DAYS) {
            // 30+ consecutive days of failure — demote but preserve metadata
            log(`  DEMOTE ${entry.domain} (${failures} consecutive failures)`);
            return {
              ...existing,
              status: "unclaimed" as const,
              last_crawled: new Date().toISOString(),
              consecutive_failures: failures,
            };
          }

          if (existing.status === "verified" && failures >= STALE_DAYS) {
            log(`  STALE ${entry.domain} (${failures} consecutive failures)`);
          }

          // Keep existing data but increment failure counter
          return {
            ...existing,
            last_crawled: new Date().toISOString(),
            consecutive_failures: failures,
          };
        }

        // New unclaimed domain — no agent.json found
        return {
          domain: entry.domain,
          status: "unclaimed" as const,
          display_name: entry.domain,
          description: null,
          version: null,
          payout_address: null,
          intent_count: 0,
          intents: [],
          protocols: [],
          networks: [],
          assets: [],
          source: entry.source,
          first_seen: entry.added_date,
          last_crawled: new Date().toISOString(),
          consecutive_failures: 0,
        };
      })
    );

    for (const r of batchResults) {
      if (r.status === "fulfilled") {
        results.push(r.value);
      }
    }

    completed += batch.length;
    if (completed % 50 === 0 || completed === total) {
      log(`Progress: ${completed}/${total} domains crawled`);
    }
  }

  return results;
}

/* ── GitHub API helpers ── */

async function githubGet(path: string): Promise<{ content: string; sha: string } | null> {
  // Get SHA from Contents API
  const metaRes = await fetch(`${API_BASE}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!metaRes.ok) return null;
  const meta = await metaRes.json();
  const sha = meta.sha;

  // Small files: content is inline as base64
  if (meta.content && meta.encoding === "base64") {
    return { content: Buffer.from(meta.content, "base64").toString("utf-8"), sha };
  }

  // Large files (>1MB): GitHub omits content. Fetch via raw CDN.
  const rawUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/${path}`;
  const rawRes = await fetch(rawUrl, { signal: AbortSignal.timeout(30_000) });
  if (!rawRes.ok) return null;
  return { content: await rawRes.text(), sha };
}

async function githubPut(path: string, content: string, sha: string | null, message: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github.v3+json",
    },
    body: JSON.stringify({
      message,
      content: Buffer.from(content).toString("base64"),
      ...(sha ? { sha } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = await res.text();
    log(`GitHub PUT failed for ${path}: ${err}`);
  }
  return res.ok;
}

/* ── Main ── */

async function main(): Promise<void> {
  log("=== Open 402 Directory — Nightly Crawl ===");

  if (!GITHUB_TOKEN) {
    log("ERROR: GITHUB_TOKEN not set. Cannot read/write to the public repo.");
    process.exit(1);
  }

  // 1. Read domains.txt from the public repo
  log("Fetching domains.txt...");
  const domainsFile = await githubGet("registry/domains.txt");
  if (!domainsFile) {
    log("ERROR: Could not read domains.txt from repo.");
    process.exit(1);
  }

  const domains = parseDomainsTxt(domainsFile.content);
  log(`Found ${domains.length} domains in registry.`);

  // 2. Read existing snapshot.json for preserving first_seen and failure counts
  log("Fetching existing snapshot.json...");
  const snapshotFile = await githubGet("registry/snapshot.json");
  const existingSnapshot = new Map<string, SnapshotEntry>();

  if (snapshotFile) {
    try {
      const snap: Snapshot = JSON.parse(snapshotFile.content);
      for (const entry of snap.entries) {
        existingSnapshot.set(entry.domain, entry);
      }
      log(`Loaded ${existingSnapshot.size} existing entries from snapshot.`);
    } catch {
      log("WARNING: Could not parse existing snapshot. Starting fresh.");
    }
  }

  // 3. Run on-chain watchers (Phase 2) — discover new domains from payment events
  let onchainDiscoveries = 0;
  try {
    const { runWatchers } = await import("./watchers/index");
    log("Running on-chain watchers...");
    const watcherResult = await runWatchers();

    // Add newly discovered domains to the crawl list
    const existingDomainSet = new Set(domains.map((d) => d.domain));
    for (const discovered of watcherResult.newDomains) {
      if (discovered.domain && !existingDomainSet.has(discovered.domain)) {
        domains.push({
          domain: discovered.domain,
          status: "unclaimed",
          source: discovered.source,
          added_date: new Date().toISOString().split("T")[0],
        });
        existingDomainSet.add(discovered.domain);
        onchainDiscoveries++;
      }
    }

    if (onchainDiscoveries > 0) {
      log(`On-chain watchers discovered ${onchainDiscoveries} new domain(s).`);
    } else {
      log("On-chain watchers: no new domains discovered.");
    }

    // TODO: Persist watcherResult.transactionStats to feed the growth chart
    // This will populate the TransactionVolumePoint[] data in the snapshot
    // once the stats storage format is finalized.
  } catch (e) {
    log(`WARNING: On-chain watchers failed (non-fatal): ${e}`);
  }

  // 4. Crawl all domains (including any newly discovered ones)
  log(`Crawling ${domains.length} domains (concurrency: ${CONCURRENCY})...`);
  const startTime = Date.now();
  const entries = await crawlAll(domains, existingSnapshot);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const verified = entries.filter((e) => e.status === "verified").length;
  const unclaimed = entries.filter((e) => e.status === "unclaimed").length;

  log(`Crawl complete in ${elapsed}s: ${verified} verified, ${unclaimed} unclaimed`);

  // 5. Check for newly verified domains (unclaimed → verified upgrade)
  let upgrades = 0;
  for (const entry of entries) {
    const old = existingSnapshot.get(entry.domain);
    if (old && old.status === "unclaimed" && entry.status === "verified") {
      upgrades++;
      log(`  UPGRADE ${entry.domain}: unclaimed → verified`);
    }
  }
  if (upgrades > 0) log(`${upgrades} domain(s) upgraded to verified.`);

  // 5b. On-chain verification — validate payout addresses against Base
  // This is the ROOT SOURCE OF TRUTH. Aggregator data (x402scan, 402index)
  // tells us what domains CLAIM to accept payments. On-chain data PROVES it.
  try {
    const { verifyPayoutAddresses } = await import("./watchers/onchain-verifier");

    // Collect all verified domains with real payout addresses (skip zero/burn)
    const SKIP_ADDRESSES = new Set([
      "0x0000000000000000000000000000000000000000",
      "0x000000000000000000000000000000000000dead",
    ]);
    const toVerify = entries
      .filter((e) => e.status === "verified" && e.payout_address
        && !SKIP_ADDRESSES.has(e.payout_address.toLowerCase()))
      .map((e) => ({ domain: e.domain, payoutAddress: e.payout_address! }));

    if (toVerify.length > 0) {
      log(`Verifying ${toVerify.length} payout addresses against Base on-chain data...`);
      const verifications = await verifyPayoutAddresses(toVerify, 3);

      // Enrich entries with on-chain verification
      for (const entry of entries) {
        const v = verifications.get(entry.domain);
        if (v) {
          entry.onchain = {
            verified: v.verified,
            total_transactions: v.totalTransactions,
            total_volume_usdc: v.totalVolumeUsdc,
            first_tx: v.firstTxTimestamp,
            last_tx: v.lastTxTimestamp,
            last_tx_hash: v.lastTxHash,
            verified_at: new Date().toISOString(),
          };
        } else if (entry.onchain) {
          // Preserve previous on-chain data if verification didn't run for this domain
        }
      }

      const onchainVerified = entries.filter((e) => e.onchain?.verified).length;
      log(`On-chain verification: ${onchainVerified}/${toVerify.length} domains have real transactions`);
    }
  } catch (e) {
    log(`WARNING: On-chain verification failed (non-fatal): ${e}`);
    // Preserve existing onchain data from previous snapshot
    for (const entry of entries) {
      const existing = existingSnapshot.get(entry.domain);
      if (existing?.onchain && !entry.onchain) {
        entry.onchain = existing.onchain;
      }
    }
  }

  // 6. Fetch ecosystem-wide stats from x402scan (cached fallback for the UI)
  let ecosystemStats: EcosystemStats | undefined;
  try {
    log("Fetching ecosystem-wide stats from x402scan for fallback cache...");

    async function fetchX402Period(period: number) {
      const input = encodeURIComponent(
        JSON.stringify({ "0": { json: { pagination: { page: 0, pageSize: 50 }, timeframe: { period } } } }),
      );
      const res = await fetch(
        `https://www.x402scan.com/api/trpc/public.facilitators.list?batch=1&input=${input}`,
        { headers: { Accept: "application/json", "User-Agent": "Open402DirectoryCrawler/1.0" }, signal: AbortSignal.timeout(15_000) },
      );
      if (!res.ok) return [];
      const data = await res.json();
      return data?.[0]?.result?.data?.json?.items || [];
    }

    function agg(items: Array<{ tx_count: number; total_amount: number; unique_buyers: number; unique_sellers: number }>) {
      return {
        transactions: items.reduce((s, i) => s + i.tx_count, 0),
        volume_usdc: Math.round(items.reduce((s, i) => s + i.total_amount, 0) / 1_000_000 * 100) / 100,
        buyers: items.reduce((s, i) => s + i.unique_buyers, 0),
        sellers: items.reduce((s, i) => s + i.unique_sellers, 0),
      };
    }

    const [items1d, items7d, items30d] = await Promise.all([
      fetchX402Period(1),
      fetchX402Period(7),
      fetchX402Period(30),
    ]);

    const s1d = agg(items1d);
    const s7d = agg(items7d);
    const s30d = agg(items30d);

    // Extract facilitator addresses for future RPC verification
    const facilitators = (items30d.length > 0 ? items30d : items7d).map((item: Record<string, unknown>) => ({
      name: (item.facilitator as Record<string, unknown>)?.name as string || item.facilitator_id as string,
      base_addresses: ((item.facilitator as Record<string, unknown>)?.addresses as Record<string, string[]>)?.base || [],
      transactions: item.tx_count as number,
      volume_usdc: Math.round((item.total_amount as number) / 1_000_000 * 100) / 100,
    }));

    ecosystemStats = {
      verified_at: new Date().toISOString(),
      facilitators,
      totals: {
        transactions_24h: s1d.transactions, volume_usdc_24h: s1d.volume_usdc, buyers_24h: s1d.buyers, sellers_24h: s1d.sellers,
        transactions_7d: s7d.transactions, volume_usdc_7d: s7d.volume_usdc, buyers_7d: s7d.buyers, sellers_7d: s7d.sellers,
        transactions_30d: s30d.transactions, volume_usdc_30d: s30d.volume_usdc, buyers_30d: s30d.buyers, sellers_30d: s30d.sellers,
      },
    };

    log(`Ecosystem stats: ${s30d.transactions} txs (30d), $${s30d.volume_usdc} vol, ${facilitators.length} facilitators`);
  } catch (e) {
    log(`WARNING: Ecosystem stats fetch failed (non-fatal): ${e}`);
    // Preserve previous ecosystem stats from existing snapshot
    if (snapshotFile) {
      try {
        const prevSnap: Snapshot = JSON.parse(snapshotFile.content);
        ecosystemStats = prevSnap.ecosystem_stats;
        if (ecosystemStats) log("Preserved previous ecosystem stats from snapshot.");
      } catch { /* ignore */ }
    }
  }

  // 6b. Build daily history — append today's 24h stats for sparkline trends
  let dailyHistory: DailyHistoryPoint[] = [];
  if (snapshotFile) {
    try {
      const prevSnap: Snapshot = JSON.parse(snapshotFile.content);
      dailyHistory = prevSnap.daily_history || [];
    } catch { /* ignore */ }
  }
  if (ecosystemStats?.totals) {
    const today = new Date().toISOString().split("T")[0];
    // Replace today's entry if crawl runs twice in one day, otherwise append
    const existingIdx = dailyHistory.findIndex((p) => p.date === today);
    const point: DailyHistoryPoint = {
      date: today,
      transactions: ecosystemStats.totals.transactions_24h,
      volume_usdc: ecosystemStats.totals.volume_usdc_24h,
      buyers: ecosystemStats.totals.buyers_24h,
      sellers: ecosystemStats.totals.sellers_24h,
    };
    if (existingIdx !== -1) {
      dailyHistory[existingIdx] = point;
    } else {
      dailyHistory.push(point);
    }
    // Keep last 30 days
    dailyHistory = dailyHistory.slice(-30);
    log(`Daily history: ${dailyHistory.length} data point(s) stored.`);
  }

  // 7. Build new snapshot
  const snapshot: Snapshot = {
    generated_at: new Date().toISOString(),
    total: entries.length,
    verified,
    unclaimed,
    entries,
    ecosystem_stats: ecosystemStats,
    daily_history: dailyHistory.length > 0 ? dailyHistory : undefined,
  };

  const snapshotJson = JSON.stringify(snapshot, null, 2);

  // 8. Update domains.txt if any statuses changed (+ append on-chain discoveries)
  let domainsChanged = false;
  const domainStatusMap = new Map(entries.map((e) => [e.domain, e.status]));
  const updatedLines: string[] = [];

  for (const line of domainsFile.content.split("\n")) {
    if (line.startsWith("#") || !line.trim()) {
      // Preserve comments, but update the counts
      if (line.startsWith("# Total domains:")) {
        updatedLines.push(`# Total domains: ${entries.length}`);
        domainsChanged = true;
      } else if (line.startsWith("# Total endpoints:")) {
        const totalEndpoints = entries.reduce((sum, e) => sum + e.intent_count, 0);
        updatedLines.push(`# Total endpoints: ${totalEndpoints}`);
        domainsChanged = true;
      } else {
        updatedLines.push(line);
      }
      continue;
    }

    const parts = line.split("|").map((p) => p.trim());
    const domain = parts[0];
    const currentStatus = parts[1];
    const newStatus = domainStatusMap.get(domain);

    if (newStatus && newStatus !== currentStatus) {
      // Status changed — update the line
      parts[1] = ` ${newStatus} `;
      updatedLines.push(parts.join("|"));
      domainsChanged = true;
      log(`  STATUS ${domain}: ${currentStatus} → ${newStatus}`);
    } else {
      updatedLines.push(line);
    }
  }

  // Append on-chain discovered domains to domains.txt
  if (onchainDiscoveries > 0) {
    // Build exact domain set from parsed entries to avoid substring false matches
    const existingDomains = new Set(parseDomainsTxt(domainsFile.content).map((d) => d.domain));
    const date = new Date().toISOString().split("T")[0];
    for (const entry of entries) {
      if (entry.source.startsWith("onchain-") && !existingDomains.has(entry.domain)) {
        updatedLines.push(`${entry.domain} | ${entry.status} | ${entry.source} | ${date}`);
        domainsChanged = true;
      }
    }
  }

  // 9. Commit to the public repo
  log("Committing snapshot.json...");
  const snapshotOk = await githubPut(
    "registry/snapshot.json",
    snapshotJson,
    snapshotFile?.sha || null,
    `chore: nightly crawl — ${verified} verified, ${unclaimed} unclaimed`
  );

  if (domainsChanged) {
    log("Committing domains.txt (status changes detected)...");
    const domainsOk = await githubPut(
      "registry/domains.txt",
      updatedLines.join("\n"),
      domainsFile.sha,
      `chore: update domain statuses (${upgrades} upgrades)`
    );
    if (!domainsOk) log("WARNING: Failed to commit domains.txt");
  }

  if (snapshotOk) {
    log("Done. Snapshot committed successfully.");
  } else {
    log("ERROR: Failed to commit snapshot.json.");
    process.exit(1);
  }

  // 10. Notify web app to sync snapshot → Supabase (fire-and-forget)
  const webhookSecret = process.env.SYNC_WEBHOOK_SECRET;
  const webhookUrl =
    process.env.SYNC_WEBHOOK_URL ||
    "https://agentinternetruntime.com/api/directory/sync";
  if (webhookSecret) {
    try {
      const syncRes = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${webhookSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          triggered_by: "nightly-crawl",
          timestamp: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const syncData = (await syncRes.json().catch(() => ({}))) as Record<string, unknown>;
      if (syncRes.ok) {
        log(
          `[sync] OK: ${syncData.synced ?? 0} synced, ${syncData.skipped ?? 0} skipped, ${syncData.errors ?? 0} errors`
        );
      } else {
        log(
          `[sync] FAILED (${syncRes.status}): ${syncData.error ?? "unknown error"}`
        );
      }
    } catch (e) {
      log(`[sync] Webhook failed (non-fatal): ${e}`);
    }
  }
}

main().catch((e) => {
  log(`FATAL: ${e}`);
  process.exit(1);
});
