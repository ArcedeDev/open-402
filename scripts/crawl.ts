#!/usr/bin/env npx tsx
/**
 * Nightly Crawler for the Open 402 Directory
 *
 * Reads registry/domains.txt, crawls each domain's /.well-known/agent.json,
 * rebuilds registry/snapshot.json, and commits the results.
 *
 * Usage:
 *   npx tsx scripts/crawl.ts
 *
 * Environment:
 *   GITHUB_TOKEN  — PAT with write access to this repo
 *   GITHUB_REPO   — e.g., "ArcedeDev/open-402" (default)
 *   CONCURRENCY   — Max parallel crawls (default: 15)
 */

const GITHUB_REPO = process.env.GITHUB_REPO || "ArcedeDev/open-402";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "15", 10);
const STALE_THRESHOLD = 7;  // consecutive failures before marking stale
const DEMOTE_THRESHOLD = 30; // consecutive failures before demoting to unclaimed

const API_BASE = `https://api.github.com/repos/${GITHUB_REPO}`;

/* ── Types ── */

interface DomainEntry {
  domain: string;
  status: "verified" | "unclaimed";
  source: string;
  added_date: string;
}

interface Intent {
  name: string;
  description: string;
  endpoint?: string;
  method?: string;
  price?: { amount: number; currency: string } | null;
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
}

interface Snapshot {
  generated_at: string;
  total: number;
  verified: number;
  unclaimed: number;
  entries: SnapshotEntry[];
}

/* ── Helpers ── */

function sanitize(s: unknown, maxLen: number): string {
  if (typeof s !== "string") return "";
  return s.replace(/<[^>]*>/g, "").slice(0, maxLen).trim();
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

async function crawlDomain(domain: string): Promise<{
  success: boolean;
  manifest?: Record<string, unknown>;
  error?: string;
}> {
  const url = `https://${domain}/.well-known/agent.json`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
      headers: { Accept: "application/json", "User-Agent": "Open402DirectoryCrawler/1.0" },
      redirect: "follow",
    });

    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("json")) return { success: false, error: "not_json" };

    const text = await res.text();
    if (text.length > 100_000) return { success: false, error: "too_large" };

    const manifest = JSON.parse(text);
    if (!manifest.version) return { success: false, error: "missing_version" };

    return { success: true, manifest };
  } catch {
    return { success: false, error: "fetch_failed" };
  }
}

/* ── Extract metadata from manifest ── */

function extractEntry(
  domain: string,
  manifest: Record<string, unknown>,
  existing: SnapshotEntry | undefined,
  source: string
): SnapshotEntry {
  const protocols: string[] = [];
  const networks: string[] = [];
  const assets: string[] = [];

  const payments = manifest.payments as Record<string, Record<string, unknown>> | undefined;
  if (payments && typeof payments === "object") {
    protocols.push(...Object.keys(payments));
    for (const config of Object.values(payments)) {
      if (config && typeof config === "object" && Array.isArray(config.networks)) {
        for (const n of config.networks as Record<string, unknown>[]) {
          if (typeof n.network === "string") networks.push(n.network);
          if (typeof n.asset === "string") assets.push(n.asset);
        }
      }
    }
  } else if (manifest.x402 && typeof manifest.x402 === "object") {
    protocols.push("x402");
    const x402 = manifest.x402 as Record<string, unknown>;
    if (Array.isArray(x402.networks)) {
      for (const n of x402.networks as Record<string, unknown>[]) {
        if (typeof n.network === "string") networks.push(n.network);
        if (typeof n.asset === "string") assets.push(n.asset);
      }
    }
  }

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
  };
}

/* ── Batch crawler ── */

async function crawlAll(
  domains: DomainEntry[],
  existingSnapshot: Map<string, SnapshotEntry>
): Promise<SnapshotEntry[]> {
  const results: SnapshotEntry[] = [];
  let completed = 0;

  for (let i = 0; i < domains.length; i += CONCURRENCY) {
    const batch = domains.slice(i, i + CONCURRENCY);

    const batchResults = await Promise.allSettled(
      batch.map(async (entry) => {
        const existing = existingSnapshot.get(entry.domain);
        const result = await crawlDomain(entry.domain);

        if (result.success && result.manifest) {
          return extractEntry(entry.domain, result.manifest, existing, entry.source);
        }

        if (existing) {
          const failures = (existing.consecutive_failures || 0) + 1;

          if (existing.status === "verified" && failures >= DEMOTE_THRESHOLD) {
            log(`  DEMOTE ${entry.domain} (${failures} consecutive failures)`);
            // Preserve metadata (intents, protocols, etc.) even on demotion
            return { ...existing, status: "unclaimed" as const, last_crawled: new Date().toISOString(), consecutive_failures: failures };
          }

          if (existing.status === "verified" && failures >= STALE_THRESHOLD) {
            log(`  STALE ${entry.domain} (${failures} consecutive failures)`);
          }

          // Preserve ALL existing metadata — only update crawl timestamp and failure count
          return { ...existing, last_crawled: new Date().toISOString(), consecutive_failures: failures };
        }

        // Truly new domain with no prior data — create minimal entry
        return {
          domain: entry.domain, status: "unclaimed" as const, display_name: entry.domain,
          description: null, version: null, payout_address: null, intent_count: 0,
          intents: [], protocols: [], networks: [], assets: [],
          source: entry.source, first_seen: entry.added_date,
          last_crawled: new Date().toISOString(), consecutive_failures: 0,
        };
      })
    );

    for (const r of batchResults) {
      if (r.status === "fulfilled") results.push(r.value);
    }

    completed += batch.length;
    if (completed % 100 === 0 || completed === domains.length) {
      log(`Progress: ${completed}/${domains.length}`);
    }
  }

  return results;
}

/* ── GitHub API ── */

async function githubGet(path: string): Promise<{ content: string; sha: string } | null> {
  // Get SHA from Contents API (works for any file size)
  const metaRes = await fetch(`${API_BASE}/contents/${path}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!metaRes.ok) return null;
  const meta = await metaRes.json();
  const sha = meta.sha;

  // For small files, content is inline as base64
  if (meta.content && meta.encoding === "base64") {
    return { content: Buffer.from(meta.content, "base64").toString("utf-8"), sha };
  }

  // For large files (>1MB), GitHub omits content. Fetch via raw CDN instead.
  const rawUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/${path}`;
  const rawRes = await fetch(rawUrl, { signal: AbortSignal.timeout(30_000) });
  if (!rawRes.ok) return null;
  return { content: await rawRes.text(), sha };
}

async function githubPut(path: string, content: string, sha: string | null, message: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/contents/${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, "Content-Type": "application/json", Accept: "application/vnd.github.v3+json" },
    body: JSON.stringify({ message, content: Buffer.from(content).toString("base64"), ...(sha ? { sha } : {}) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) log(`GitHub PUT failed for ${path}: ${await res.text()}`);
  return res.ok;
}

/* ── Main ── */

async function main(): Promise<void> {
  log("=== Open 402 Directory — Nightly Crawl ===");

  if (!GITHUB_TOKEN) {
    log("ERROR: GITHUB_TOKEN not set.");
    process.exit(1);
  }

  // 1. Read domains.txt
  log("Fetching domains.txt...");
  const domainsFile = await githubGet("registry/domains.txt");
  if (!domainsFile) { log("ERROR: Could not read domains.txt."); process.exit(1); }

  const domains = parseDomainsTxt(domainsFile.content);
  log(`Found ${domains.length} domains.`);

  // 2. Read existing snapshot
  log("Fetching snapshot.json...");
  const snapshotFile = await githubGet("registry/snapshot.json");
  const existingSnapshot = new Map<string, SnapshotEntry>();

  if (snapshotFile) {
    try {
      const snap: Snapshot = JSON.parse(snapshotFile.content);
      for (const entry of snap.entries) existingSnapshot.set(entry.domain, entry);
      log(`Loaded ${existingSnapshot.size} existing entries.`);
    } catch { log("WARNING: Could not parse existing snapshot."); }
  }

  // 3. Crawl all domains
  log(`Crawling ${domains.length} domains (concurrency: ${CONCURRENCY})...`);
  const startTime = Date.now();
  const entries = await crawlAll(domains, existingSnapshot);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const verified = entries.filter((e) => e.status === "verified").length;
  const unclaimed = entries.filter((e) => e.status === "unclaimed").length;
  log(`Crawl complete in ${elapsed}s: ${verified} verified, ${unclaimed} unclaimed`);

  // 4. Log upgrades
  let upgrades = 0;
  for (const entry of entries) {
    const old = existingSnapshot.get(entry.domain);
    if (old && old.status === "unclaimed" && entry.status === "verified") {
      upgrades++;
      log(`  UPGRADE ${entry.domain}: unclaimed → verified`);
    }
  }
  if (upgrades > 0) log(`${upgrades} domain(s) upgraded to verified.`);

  // 5. Build snapshot
  const snapshot: Snapshot = { generated_at: new Date().toISOString(), total: entries.length, verified, unclaimed, entries };
  const snapshotJson = JSON.stringify(snapshot, null, 2);

  // 6. Update domains.txt header counts
  let domainsChanged = false;
  const updatedLines: string[] = [];

  for (const line of domainsFile.content.split("\n")) {
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
  }

  // Update statuses in domains.txt
  const domainStatusMap = new Map(entries.map((e) => [e.domain, e.status]));
  const finalLines: string[] = [];
  for (const line of updatedLines) {
    if (line.startsWith("#") || !line.trim()) { finalLines.push(line); continue; }
    const parts = line.split("|").map((p) => p.trim());
    const domain = parts[0];
    const currentStatus = parts[1];
    const newStatus = domainStatusMap.get(domain);
    if (newStatus && newStatus !== currentStatus) {
      parts[1] = ` ${newStatus} `;
      finalLines.push(parts.join("|"));
      domainsChanged = true;
    } else {
      finalLines.push(line);
    }
  }

  // 7. Commit
  log("Committing snapshot.json...");
  const snapshotOk = await githubPut(
    "registry/snapshot.json", snapshotJson, snapshotFile?.sha || null,
    `chore: nightly crawl — ${verified} verified, ${unclaimed} unclaimed`
  );

  if (domainsChanged) {
    log("Committing domains.txt...");
    await githubPut("registry/domains.txt", finalLines.join("\n"), domainsFile.sha,
      `chore: update domain statuses (${upgrades} upgrades)`
    );
  }

  if (snapshotOk) {
    log("Done. Snapshot committed.");
  } else {
    log("ERROR: Failed to commit snapshot.json.");
    process.exit(1);
  }
}

main().catch((e) => { log(`FATAL: ${e}`); process.exit(1); });
