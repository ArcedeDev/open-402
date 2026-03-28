#!/usr/bin/env npx tsx
import { pathToFileURL } from "node:url";

import {
  buildUpdatedDomainsTxt,
  parseDomainsTxt,
  type DomainEntry,
} from "./lib/registry-utils.ts";
import {
  addressKey,
  buildLegacyClaimsFromEntry,
  buildManifestClaims,
  buildVerificationStats,
  buildWatcherClaims,
  isValidEvmAddress,
  isVerifierSupported,
  materializeEntryVerification,
  mergeClaims,
  seedAddressVerifications,
  type AddressVerificationRecord,
  type Claim,
  type VerificationStats,
  type VerificationSummary,
} from "./lib/verification-model.ts";
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
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_COMMIT_RETRIES = parseInt(process.env.GITHUB_COMMIT_RETRIES || "3", 10) || 3;
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "15", 10) || 15;
const STALE_DAYS = parseInt(process.env.STALE_DAYS || "7", 10) || 7;
const DEMOTE_DAYS = parseInt(process.env.DEMOTE_DAYS || "30", 10) || 30;
const ONCHAIN_CONCURRENCY = parseInt(process.env.ONCHAIN_CONCURRENCY || "3", 10) || 3;
const MAX_ONCHAIN_ADDRESSES_PER_RUN = parseInt(process.env.MAX_ONCHAIN_ADDRESSES_PER_RUN || "0", 10) || 0;

const API_BASE = `https://api.github.com/repos/${GITHUB_REPO}`;

/* ── Types ── */

interface SnapshotEntry {
  domain: string;
  status: "verified" | "unclaimed";
  display_name: string;
  description: string | null;
  version: string | null;
  intent_count: number;
  intents: Intent[];
  protocols: string[];
  networks: string[];
  assets: string[];
  source: string;
  first_seen: string;
  last_crawled: string;
  consecutive_failures?: number;
  claims: Claim[];
  verification: VerificationSummary;
  // Legacy fields accepted when reading old snapshots.
  payout_address?: string | null;
  onchain?: {
    verified: boolean;
    total_transactions: number;
    total_volume_usdc: number;
    first_tx: string | null;
    last_tx: string | null;
    last_tx_hash: string | null;
    verified_at: string;
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
  address_verifications?: AddressVerificationRecord[];
  verification_stats?: VerificationStats;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultVerification(): VerificationSummary {
  return {
    domain_state: "no_claim",
    canonical_claim_index: null,
    shared_domain_count: 0,
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value && value !== "unknown" && value !== "UNKNOWN"))];
}

function mergeClaimMetadata(
  entry: Pick<SnapshotEntry, "protocols" | "networks" | "assets">,
  claims: Claim[]
): Pick<SnapshotEntry, "protocols" | "networks" | "assets"> {
  return {
    protocols: uniqueStrings([...entry.protocols, ...claims.map((claim) => claim.protocol)]),
    networks: uniqueStrings([...entry.networks, ...claims.map((claim) => claim.network)]),
    assets: uniqueStrings([...entry.assets, ...claims.map((claim) => claim.asset)]),
  };
}

function normalizeSnapshotEntry(raw: SnapshotEntry): SnapshotEntry {
  const claims = Array.isArray(raw.claims)
    ? raw.claims
    : buildLegacyClaimsFromEntry(raw);
  const seededAddressVerifications = seedAddressVerifications(claims, new Map());
  const sharedDomainCounts = new Map<string, number>();
  for (const claim of claims) {
    if (claim.address) sharedDomainCounts.set(addressKey(claim), 1);
  }
  const materialized = raw.verification
    ? { claims, verification: raw.verification }
    : materializeEntryVerification(claims, seededAddressVerifications, sharedDomainCounts);
  const metadata = mergeClaimMetadata({
    protocols: Array.isArray(raw.protocols) ? raw.protocols : [],
    networks: Array.isArray(raw.networks) ? raw.networks : [],
    assets: Array.isArray(raw.assets) ? raw.assets : [],
  }, materialized.claims);

  return {
    domain: raw.domain,
    status: raw.status === "verified" ? "verified" : "unclaimed",
    display_name: raw.display_name || raw.domain,
    description: raw.description ?? null,
    version: raw.version ?? null,
    intent_count: Number(raw.intent_count) || 0,
    intents: Array.isArray(raw.intents) ? raw.intents : [],
    protocols: metadata.protocols,
    networks: metadata.networks,
    assets: metadata.assets,
    source: typeof raw.source === "string" ? raw.source : "legacy_snapshot",
    first_seen: typeof raw.first_seen === "string" ? raw.first_seen : new Date().toISOString().split("T")[0],
    last_crawled: typeof raw.last_crawled === "string" ? raw.last_crawled : new Date().toISOString(),
    consecutive_failures: Number(raw.consecutive_failures) || 0,
    claims: materialized.claims,
    verification: materialized.verification,
  };
}

function sanitizeSnapshotEntry(entry: SnapshotEntry): SnapshotEntry {
  return {
    domain: entry.domain,
    status: entry.status,
    display_name: entry.display_name,
    description: entry.description,
    version: entry.version,
    intent_count: entry.intent_count,
    intents: entry.intents,
    protocols: entry.protocols,
    networks: entry.networks,
    assets: entry.assets,
    source: entry.source,
    first_seen: entry.first_seen,
    last_crawled: entry.last_crawled,
    consecutive_failures: entry.consecutive_failures,
    claims: entry.claims,
    verification: entry.verification,
  };
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
  const firstSeen = existing?.first_seen || new Date().toISOString().split("T")[0];
  const lastCrawled = new Date().toISOString();
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

  const claims = mergeClaims(existing?.claims || [], buildManifestClaims(manifest, firstSeen, lastCrawled));
  const claimMetadata = mergeClaimMetadata({ protocols, networks, assets }, claims);

  return {
    domain,
    status: "verified",
    display_name: sanitize(manifest.display_name, 100) || domain,
    description: sanitize(manifest.description, 500) || null,
    version: typeof manifest.version === "string" ? manifest.version : String(manifest.version),
    intent_count: intents.length,
    intents,
    protocols: claimMetadata.protocols,
    networks: claimMetadata.networks,
    assets: claimMetadata.assets,
    source,
    first_seen: firstSeen,
    last_crawled: lastCrawled,
    consecutive_failures: 0,
    claims,
    verification: existing?.verification || defaultVerification(),
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
          intent_count: 0,
          intents: [],
          protocols: [],
          networks: [],
          assets: [],
          source: entry.source,
          first_seen: entry.added_date,
          last_crawled: new Date().toISOString(),
          consecutive_failures: 0,
          claims: [],
          verification: defaultVerification(),
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

interface GitHubFile {
  content: string;
  sha: string;
}

interface GitHubApiResult {
  ok: boolean;
  status: number;
}

interface GitHubTreeItem {
  path: string;
  mode: "100644";
  type: "blob";
  sha: string;
}

interface GitHubFileUpdate {
  path: string;
  content: string;
}

async function githubGet(path: string, ref: string = GITHUB_BRANCH): Promise<GitHubFile | null> {
  // Get SHA from Contents API
  const metaRes = await fetch(`${API_BASE}/contents/${path}?ref=${encodeURIComponent(ref)}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (metaRes.status === 404) return null;
  if (!metaRes.ok) {
    throw new Error(`GitHub GET failed for ${path}: HTTP ${metaRes.status} ${metaRes.statusText}`);
  }
  const meta = await metaRes.json();
  const sha = meta.sha;

  // Small files: content is inline as base64
  if (meta.content && meta.encoding === "base64") {
    return { content: Buffer.from(meta.content, "base64").toString("utf-8"), sha };
  }

  // Large files (>1MB): fetch the exact blob by SHA to avoid ref drift.
  const blobRes = await fetch(`${API_BASE}/git/blobs/${sha}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!blobRes.ok) {
    throw new Error(`GitHub blob GET failed for ${path}: HTTP ${blobRes.status} ${blobRes.statusText}`);
  }
  const blob = await blobRes.json() as { content?: string; encoding?: string };
  if (!blob.content || blob.encoding !== "base64") {
    throw new Error(`GitHub blob GET returned no content for ${path}`);
  }
  return { content: Buffer.from(blob.content, "base64").toString("utf-8"), sha };
}

async function githubGetBranchHead(): Promise<string> {
  const ref = encodeURIComponent(`heads/${GITHUB_BRANCH}`);
  const res = await fetch(`${API_BASE}/git/ref/${ref}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`GitHub ref GET failed: HTTP ${res.status} ${res.statusText}`);
  }
  const data = await res.json() as { object?: { sha?: string } };
  const sha = data.object?.sha;
  if (!sha) throw new Error("GitHub ref GET returned no commit SHA");
  return sha;
}

async function githubGetCommitTree(commitSha: string): Promise<string> {
  const res = await fetch(`${API_BASE}/git/commits/${commitSha}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`GitHub commit GET failed: HTTP ${res.status} ${res.statusText}`);
  }
  const data = await res.json() as { tree?: { sha?: string } };
  const treeSha = data.tree?.sha;
  if (!treeSha) throw new Error("GitHub commit GET returned no tree SHA");
  return treeSha;
}

async function githubCreateBlob(content: string): Promise<string> {
  const res = await fetch(`${API_BASE}/git/blobs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github.v3+json",
    },
    body: JSON.stringify({
      content,
      encoding: "utf-8",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub blob POST failed: ${err}`);
  }
  const data = await res.json() as { sha?: string };
  if (!data.sha) throw new Error("GitHub blob POST returned no SHA");
  return data.sha;
}

async function githubCreateTree(baseTree: string, tree: GitHubTreeItem[]): Promise<string> {
  const res = await fetch(`${API_BASE}/git/trees`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github.v3+json",
    },
    body: JSON.stringify({
      base_tree: baseTree,
      tree,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub tree POST failed: ${err}`);
  }
  const data = await res.json() as { sha?: string };
  if (!data.sha) throw new Error("GitHub tree POST returned no SHA");
  return data.sha;
}

async function githubCreateCommit(
  message: string,
  parentCommitSha: string,
  treeSha: string
): Promise<string> {
  const res = await fetch(`${API_BASE}/git/commits`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github.v3+json",
    },
    body: JSON.stringify({
      message,
      tree: treeSha,
      parents: [parentCommitSha],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub commit POST failed: ${err}`);
  }
  const data = await res.json() as { sha?: string };
  if (!data.sha) throw new Error("GitHub commit POST returned no SHA");
  return data.sha;
}

async function githubUpdateBranchHead(commitSha: string): Promise<GitHubApiResult> {
  const ref = encodeURIComponent(`heads/${GITHUB_BRANCH}`);
  const res = await fetch(`${API_BASE}/git/refs/${ref}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github.v3+json",
    },
    body: JSON.stringify({
      sha: commitSha,
      force: false,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = await res.text();
    log(`GitHub ref update failed: ${err}`);
  }
  return { ok: res.ok, status: res.status };
}

async function githubCommitFilesAtomically(
  paths: string[],
  message: string,
  buildFiles: (remoteFiles: Map<string, GitHubFile | null>) => Promise<GitHubFileUpdate[]> | GitHubFileUpdate[],
  maxAttempts: number = GITHUB_COMMIT_RETRIES
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const headSha = await githubGetBranchHead();
    const remoteFiles = new Map<string, GitHubFile | null>();
    const fetchedFiles = await Promise.all(paths.map(async (path) => [path, await githubGet(path, headSha)] as const));
    for (const [path, file] of fetchedFiles) {
      remoteFiles.set(path, file);
    }

    const desiredFiles = await buildFiles(remoteFiles);
    const changedFiles = desiredFiles.filter((file) => remoteFiles.get(file.path)?.content !== file.content);

    if (changedFiles.length === 0) {
      log("Skipping registry publish; already up to date.");
      return true;
    }

    const baseTree = await githubGetCommitTree(headSha);
    const tree = await Promise.all(
      changedFiles.map(async (file) => ({
        path: file.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: await githubCreateBlob(file.content),
      }))
    );
    const treeSha = await githubCreateTree(baseTree, tree);
    const commitSha = await githubCreateCommit(message, headSha, treeSha);
    const result = await githubUpdateBranchHead(commitSha);
    if (result.ok) return true;
    if ((result.status !== 409 && result.status !== 422) || attempt === maxAttempts) return false;

    log(`Retrying atomic registry publish after remote update (${attempt}/${maxAttempts - 1})...`);
    await sleep(500 * attempt);
  }

  return false;
}

/* ── Ecosystem stats (runs concurrently with domain crawl) ── */

async function fetchEcosystemStats(): Promise<EcosystemStats | null> {
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

    const facilitators = (items30d.length > 0 ? items30d : items7d).map((item: Record<string, unknown>) => ({
      name: (item.facilitator as Record<string, unknown>)?.name as string || item.facilitator_id as string,
      base_addresses: ((item.facilitator as Record<string, unknown>)?.addresses as Record<string, string[]>)?.base || [],
      transactions: item.tx_count as number,
      volume_usdc: Math.round((item.total_amount as number) / 1_000_000 * 100) / 100,
    }));

    const stats: EcosystemStats = {
      verified_at: new Date().toISOString(),
      facilitators,
      totals: {
        transactions_24h: s1d.transactions, volume_usdc_24h: s1d.volume_usdc, buyers_24h: s1d.buyers, sellers_24h: s1d.sellers,
        transactions_7d: s7d.transactions, volume_usdc_7d: s7d.volume_usdc, buyers_7d: s7d.buyers, sellers_7d: s7d.sellers,
        transactions_30d: s30d.transactions, volume_usdc_30d: s30d.volume_usdc, buyers_30d: s30d.buyers, sellers_30d: s30d.sellers,
      },
    };

    log(`Ecosystem stats: ${s30d.transactions} txs (30d), $${s30d.volume_usdc} vol, ${facilitators.length} facilitators`);
    return stats;
  } catch (e) {
    log(`WARNING: Ecosystem stats fetch failed (non-fatal): ${e}`);
    return null;
  }
}

/* ── Main ── */

export async function main(): Promise<void> {
  log("=== Open 402 Directory — Nightly Crawl ===");

  if (!GITHUB_TOKEN) {
    log("ERROR: GITHUB_TOKEN not set. Cannot read/write to the public repo.");
    process.exit(1);
  }

  // 1. Read domains.txt from the public repo
  log("Fetching domains.txt...");
  const initialHeadSha = await githubGetBranchHead();
  const domainsFile = await githubGet("registry/domains.txt", initialHeadSha);
  if (!domainsFile) {
    log("ERROR: Could not read domains.txt from repo.");
    process.exit(1);
  }

  const domains = parseDomainsTxt(domainsFile.content);
  log(`Found ${domains.length} domains in registry.`);

  // 2. Read existing snapshot.json for preserving first_seen and failure counts
  log("Fetching existing snapshot.json...");
  const snapshotFile = await githubGet("registry/snapshot.json", initialHeadSha);
  const existingSnapshot = new Map<string, SnapshotEntry>();
  let previousSnapshot: Snapshot | null = null;
  let existingAddressVerifications = new Map<string, AddressVerificationRecord>();

  if (snapshotFile) {
    try {
      const snap: Snapshot = JSON.parse(snapshotFile.content);
      previousSnapshot = snap;
      for (const entry of snap.entries || []) {
        existingSnapshot.set(entry.domain, normalizeSnapshotEntry(entry));
      }
      if (Array.isArray(snap.address_verifications)) {
        existingAddressVerifications = new Map(
          snap.address_verifications.map((record) => [addressKey(record), { ...record }])
        );
      }
      existingAddressVerifications = seedAddressVerifications(
        Array.from(existingSnapshot.values()).flatMap((entry) => entry.claims),
        existingAddressVerifications
      );
      log(`Loaded ${existingSnapshot.size} existing entries from snapshot.`);
    } catch {
      log("WARNING: Could not parse existing snapshot. Starting fresh.");
    }
  }

  // 3. Run on-chain watchers (Phase 2) — discover new domains from payment events
  let onchainDiscoveries = 0;
  let watcherEvents: import("./watchers/types.ts").PaymentEvent[] = [];
  try {
    const { runWatchers } = await import("./watchers/index");
    log("Running on-chain watchers...");
    const watcherResult = await runWatchers();
    watcherEvents = watcherResult.events;

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
  //    Kick off ecosystem stats fetch concurrently — it hits x402scan.com
  //    which is independent of the domain crawl.
  const ecosystemStatsPromise = fetchEcosystemStats();
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

  // 5b. Normalize manifest + watcher claims, then verify unique addresses incrementally.
  // Pre-index watcher events by domain to avoid O(entries × events) iteration.
  let computedVerificationStats: VerificationStats | null = null;
  const eventsByDomain = new Map<string, import("./watchers/types.ts").PaymentEvent[]>();
  for (const event of watcherEvents) {
    if (!event.domain) continue;
    const list = eventsByDomain.get(event.domain);
    if (list) list.push(event);
    else eventsByDomain.set(event.domain, [event]);
  }

  try {
    const normalizedAt = new Date().toISOString();
    for (const entry of entries) {
      const watcherClaims = buildWatcherClaims(
        entry.domain,
        eventsByDomain.get(entry.domain) || [],
        entry.first_seen,
        normalizedAt
      );
      entry.claims = mergeClaims(entry.claims, watcherClaims);
      const metadata = mergeClaimMetadata(entry, entry.claims);
      entry.protocols = metadata.protocols;
      entry.networks = metadata.networks;
      entry.assets = metadata.assets;
    }

    const allClaims = entries.flatMap((entry) => entry.claims);
    const addressVerifications = seedAddressVerifications(allClaims, existingAddressVerifications);
    const addressDomainMap = new Map<string, Set<string>>();
    const addressClaimSourceMap = new Map<string, { manifest: boolean; watcher: boolean }>();

    for (const entry of entries) {
      for (const claim of entry.claims) {
        if (!claim.address) continue;
        const key = addressKey(claim);
        const domainsForAddress = addressDomainMap.get(key) || new Set<string>();
        domainsForAddress.add(entry.domain);
        addressDomainMap.set(key, domainsForAddress);

        const existingSources = addressClaimSourceMap.get(key) || { manifest: false, watcher: false };
        if (claim.claim_source === "manifest") existingSources.manifest = true;
        if (claim.claim_source === "watcher") existingSources.watcher = true;
        addressClaimSourceMap.set(key, existingSources);
      }
    }

    const verifierCandidates = Array.from(addressVerifications.values())
      .filter((record) =>
        isVerifierSupported(record.protocol, record.network, record.asset)
        && isValidEvmAddress(record.address)
      )
      .sort((a, b) => {
        const aSources = addressClaimSourceMap.get(addressKey(a)) || { manifest: false, watcher: false };
        const bSources = addressClaimSourceMap.get(addressKey(b)) || { manifest: false, watcher: false };
        const aRank = aSources.manifest ? 0 : a.last_scanned_block != null ? 1 : 2;
        const bRank = bSources.manifest ? 0 : b.last_scanned_block != null ? 1 : 2;
        return aRank - bRank || a.address.localeCompare(b.address);
      });

    const verifierQueued = MAX_ONCHAIN_ADDRESSES_PER_RUN > 0
      ? verifierCandidates.slice(0, MAX_ONCHAIN_ADDRESSES_PER_RUN)
      : verifierCandidates;
    const queueTarget = verifierQueued.length;
    const deferredCount = verifierCandidates.length - queueTarget;

    log(
      `Address verification queue: ${queueTarget}/${verifierCandidates.length} supported unique addresses`
        + (deferredCount > 0 ? ` (${deferredCount} deferred by MAX_ONCHAIN_ADDRESSES_PER_RUN)` : "")
    );

    if (verifierQueued.length > 0) {
      const { verifyAddressesIncremental } = await import("./watchers/onchain-verifier");
      const results = await verifyAddressesIncremental(
        verifierQueued.map((record) => ({
          address: record.address,
          lastScannedBlock: record.last_scanned_block,
          priorTotals: {
            totalTransactions: record.tx_count,
            totalVolumeUsdc: record.volume_usd,
            firstTxTimestamp: record.first_tx,
            lastTxTimestamp: record.last_tx,
            lastTxHash: record.last_tx_hash,
            firstVerifiedAt: record.first_verified_at,
            lastVerifiedAt: record.last_verified_at,
          },
        })),
        ONCHAIN_CONCURRENCY
      );

      for (const record of verifierQueued) {
        const result = results.get(record.address.toLowerCase());
        if (!result) continue;

        addressVerifications.set(addressKey(record), {
          ...record,
          verification_state: result.verificationState,
          verification_method: result.verificationState === "invalid" ? null : "base_usdc_transfer_scan",
          tx_count: result.totalTransactions,
          volume_usd: result.totalVolumeUsdc,
          first_tx: result.firstTxTimestamp,
          last_tx: result.lastTxTimestamp,
          last_tx_hash: result.lastTxHash,
          first_verified_at: result.firstVerifiedAt,
          last_verified_at: result.lastVerifiedAt,
          last_scanned_block: result.lastScannedBlock,
        });
      }
    }

    const sharedDomainCounts = new Map<string, number>();
    for (const [key, domainsForAddress] of addressDomainMap.entries()) {
      sharedDomainCounts.set(key, domainsForAddress.size);
    }

    const materializedEntries = entries
      .map((entry) => {
        const materialized = materializeEntryVerification(entry.claims, addressVerifications, sharedDomainCounts);
        const metadata = mergeClaimMetadata(entry, materialized.claims);
        return sanitizeSnapshotEntry({
          ...entry,
          protocols: metadata.protocols,
          networks: metadata.networks,
          assets: metadata.assets,
          claims: materialized.claims,
          verification: materialized.verification,
        });
      })
      .sort((a, b) => a.domain.localeCompare(b.domain));

    computedVerificationStats = buildVerificationStats(materializedEntries, addressVerifications);
    const verifiedDomainsMissingClaims = materializedEntries.filter(
      (entry) => entry.status === "verified" && !entry.claims.some((claim) => claim.claim_source === "manifest")
    ).length;
    const verifiedDomainsWithInvalidClaims = materializedEntries.filter(
      (entry) => entry.status === "verified" && entry.claims.some((claim) => claim.verification_state === "invalid")
    ).length;
    const sharedAddressClusters = Array.from(sharedDomainCounts.values()).filter((count) => count > 1);
    const observedOnlyByProtocol = new Map<string, number>();
    for (const entry of materializedEntries) {
      if (entry.verification.domain_state !== "observed_only") continue;
      const protocols = uniqueStrings(entry.claims.map((claim) => claim.protocol));
      for (const protocol of protocols) {
        observedOnlyByProtocol.set(protocol, (observedOnlyByProtocol.get(protocol) || 0) + 1);
      }
    }

    log(`Verification stats: ${computedVerificationStats.verified_addresses}/${computedVerificationStats.unique_addresses} unique addresses verified`);
    log(`Operator summary: ${verifiedDomainsMissingClaims} verified domains missing manifest claims, ${verifiedDomainsWithInvalidClaims} with invalid claims`);
    log(
      `Shared-address clusters: ${sharedAddressClusters.length}`
        + (sharedAddressClusters.length > 0 ? ` (largest cluster ${Math.max(...sharedAddressClusters)} domains)` : "")
    );
    if (observedOnlyByProtocol.size > 0) {
      log(
        `Observed-only domains by protocol: ${Array.from(observedOnlyByProtocol.entries()).map(([protocol, count]) => `${protocol}:${count}`).join(", ")}`
      );
    }

    entries.length = 0;
    entries.push(...materializedEntries);
    existingAddressVerifications = addressVerifications;
    previousSnapshot = {
      ...(previousSnapshot || {
        generated_at: normalizedAt,
        total: 0,
        verified: 0,
        unclaimed: 0,
        entries: [],
      }),
      entries: materializedEntries,
      address_verifications: Array.from(addressVerifications.values()),
      verification_stats: computedVerificationStats,
    };
  } catch (e) {
    log(`WARNING: Address-centric verification failed (non-fatal): ${e}`);
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const watcherClaims = buildWatcherClaims(entry.domain, eventsByDomain.get(entry.domain) || [], entry.first_seen, new Date().toISOString());
      const mergedClaims = mergeClaims(entry.claims, watcherClaims);
      const metadata = mergeClaimMetadata(entry, mergedClaims);
      const materialized = materializeEntryVerification(
        mergedClaims,
        existingAddressVerifications,
        new Map(
          mergedClaims
            .filter((claim) => claim.address)
            .map((claim) => [addressKey(claim), 1])
        )
      );
      entries[index] = sanitizeSnapshotEntry({
        ...entry,
        protocols: metadata.protocols,
        networks: metadata.networks,
        assets: metadata.assets,
        claims: materialized.claims,
        verification: materialized.verification,
      });
    }
  }

  // 6. Await ecosystem stats (kicked off concurrently with crawl in step 4)
  let ecosystemStats: EcosystemStats | undefined = (await ecosystemStatsPromise) || undefined;
  if (!ecosystemStats && previousSnapshot?.ecosystem_stats) {
    ecosystemStats = previousSnapshot.ecosystem_stats;
    log("Preserved previous ecosystem stats from snapshot.");
  }

  // 6b. Build daily history — append today's 24h stats for sparkline trends
  let dailyHistory: DailyHistoryPoint[] = previousSnapshot?.daily_history || [];
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
  // In the normal path, entries are already sanitized from step 5b. The error
  // recovery path also sanitizes. Either way a second pass is redundant.
  const finalEntries = entries;
  const verifiedNow = finalEntries.filter((entry) => entry.status === "verified").length;
  const unclaimedNow = finalEntries.filter((entry) => entry.status === "unclaimed").length;
  const addressVerificationList = Array.from(existingAddressVerifications.values())
    .sort((a, b) => addressKey(a).localeCompare(addressKey(b)));
  // Reuse stats from step 5b when available; only recompute on error recovery path.
  const verificationStats = computedVerificationStats || buildVerificationStats(finalEntries, existingAddressVerifications);
  const snapshot: Snapshot = {
    generated_at: new Date().toISOString(),
    total: finalEntries.length,
    verified: verifiedNow,
    unclaimed: unclaimedNow,
    entries: finalEntries,
    address_verifications: addressVerificationList,
    verification_stats: verificationStats,
    ecosystem_stats: ecosystemStats,
    daily_history: dailyHistory.length > 0 ? dailyHistory : undefined,
  };

  const snapshotJson = JSON.stringify(snapshot, null, 2);

  // 8. Plan domains.txt updates against the crawl-start snapshot for logging,
  // then rebuild against the latest branch head right before the atomic publish.
  const plannedDomains = buildUpdatedDomainsTxt(domainsFile.content, finalEntries, {
    logStatusChanges: (message) => log(`  ${message}`),
  });

  // 9. Commit to the public repo
  log("Publishing registry update atomically...");
  const publishOk = await githubCommitFilesAtomically(
    ["registry/snapshot.json", "registry/domains.txt"],
    `chore: nightly crawl — ${verifiedNow} verified, ${unclaimedNow} unclaimed`,
    (remoteFiles) => {
      const remoteDomains = remoteFiles.get("registry/domains.txt");
      if (!remoteDomains) {
        throw new Error("Could not read domains.txt from repo during publish.");
      }

      const files: GitHubFileUpdate[] = [
        { path: "registry/snapshot.json", content: snapshotJson },
      ];
      const mergedDomains = buildUpdatedDomainsTxt(remoteDomains.content, finalEntries);

      if (plannedDomains.changed || mergedDomains.changed) {
        files.push({ path: "registry/domains.txt", content: mergedDomains.content });
      }

      return files;
    }
  );

  if (publishOk) {
    log("Done. Registry committed successfully.");
  } else {
    log("ERROR: Failed to publish registry update.");
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    log(`FATAL: ${e}`);
    process.exit(1);
  });
}
