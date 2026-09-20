#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { githubGet, githubGetBranchHead } from "./crawl.ts";
import { assertSnapshot } from "./lib/crawl-runtime.ts";

export interface PublishedSnapshot {
  commit: string;
  generated_at: string;
  total: number;
}

interface SyncReceipt {
  snapshot_commit: string;
  snapshot_generated_at: string;
  total_snapshot_entries: number;
  synced: number;
  skipped: number;
  errors: number;
  unattempted: number;
}

async function readPublishedSnapshot(): Promise<PublishedSnapshot> {
  const expectedCommit = process.env.SYNC_SNAPSHOT_COMMIT;
  const expectedGeneration = process.env.SYNC_SNAPSHOT_GENERATED_AT;
  const expectedTotal = process.env.SYNC_SNAPSHOT_TOTAL;
  if ([expectedCommit, expectedGeneration, expectedTotal].some(Boolean)
    && !(expectedCommit && expectedGeneration && expectedTotal)) throw new Error("Incomplete publication handoff");
  if (expectedCommit && !/^[a-f0-9]{40}$/.test(expectedCommit)) throw new Error("Invalid publication handoff commit");
  const commit = expectedCommit || await githubGetBranchHead();
  const file = await githubGet("registry/snapshot.json", commit);
  if (!file) throw new Error("Published snapshot is missing");
  const snapshot: unknown = JSON.parse(file.content);
  assertSnapshot(snapshot);
  if (expectedCommit && (snapshot.generated_at !== expectedGeneration || String(snapshot.total) !== expectedTotal)) {
    throw new Error("Published snapshot differs from crawler handoff");
  }
  return { commit, generated_at: snapshot.generated_at, total: snapshot.total };
}

export function assertSyncReceipt(value: unknown, expected: PublishedSnapshot): asserts value is SyncReceipt {
  if (!value || typeof value !== "object") throw new Error("Invalid sync receipt");
  const receipt = value as Record<string, unknown>;
  if (receipt.snapshot_commit !== expected.commit || receipt.snapshot_generated_at !== expected.generated_at
    || receipt.total_snapshot_entries !== expected.total) throw new Error("Sync receipt revision mismatch");
  const fields = ["synced", "skipped", "errors", "unattempted"] as const;
  for (const field of fields) {
    if (!Number.isSafeInteger(receipt[field]) || (receipt[field] as number) < 0) throw new Error("Invalid sync receipt counts");
  }
  if (fields.reduce((sum, field) => sum + (receipt[field] as number), 0) !== expected.total) throw new Error("Incomplete sync receipt accounting");
  if (receipt.errors !== 0 || receipt.unattempted !== 0) throw new Error("Snapshot reconciliation is incomplete");
}

async function readReceipt(response: Response, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  if (!response.body) throw new Error("Empty sync receipt");
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.length;
      if (bytes > 32_768) {
        await reader.cancel();
        throw new Error("Sync receipt exceeds size limit");
      }
      chunks.push(result.value);
    }
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Malformed sync receipt"); }
}

export async function syncPublishedSnapshot(options: {
  secret?: string;
  url?: string;
  fetch?: typeof fetch;
  readPublished?: () => Promise<PublishedSnapshot>;
  timeoutMs?: number;
} = {}): Promise<SyncReceipt> {
  const secret = options.secret ?? process.env.SYNC_WEBHOOK_SECRET;
  if (!secret?.trim()) throw new Error("SYNC_WEBHOOK_SECRET is required");
  const url = new URL(options.url ?? (process.env.SYNC_WEBHOOK_URL || "https://agentinternetruntime.com/api/directory/sync"));
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Sync URL must be credential-free HTTPS");
  const timeoutMs = options.timeoutMs ?? 90_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90_000) throw new Error("Invalid sync timeout");
  const expected = await (options.readPublished ?? readPublishedSnapshot)();
  if (!/^[a-f0-9]{40}$/.test(expected.commit) || !Number.isSafeInteger(expected.total) || expected.total < 1
    || !Number.isFinite(Date.parse(expected.generated_at))) throw new Error("Invalid published revision");
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await (options.fetch ?? fetch)(url, {
    method: "POST",
    redirect: "error",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      triggered_by: "directory-reconciliation",
      expected_commit: expected.commit,
      expected_generated_at: expected.generated_at,
      expected_total: expected.total,
    }),
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Sync HTTP ${response.status}`);
  }
  const receipt = await readReceipt(response, signal);
  assertSyncReceipt(receipt, expected);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const receipt = await syncPublishedSnapshot();
    console.log(`[sync] ${receipt.snapshot_commit}: ${receipt.synced} synced, ${receipt.skipped} skipped, 0 errors, 0 unattempted`);
  } catch (error) {
    console.error(`[sync] Failed: ${error instanceof Error ? error.message : "request failed"}`);
    process.exitCode = 1;
  }
}
