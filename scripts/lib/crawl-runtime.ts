export async function mapConcurrent<T, R>(items: T[], concurrency: number, run: (item: T) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) throw new Error("Concurrency must be an integer from 1 to 100");
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await run(items[index]); }
      catch (error) { failed = true; throw error; }
    }
  }
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(items.length, concurrency) }, worker));
  const failure = outcomes.find((outcome) => outcome.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results;
}

export function assertCoverage(expected: { domain: string }[], actual: { domain: string }[]): void {
  const domains = new Set(expected.map((entry) => entry.domain));
  if (!domains.size || domains.size !== expected.length || actual.length !== expected.length) throw new Error("Incomplete or duplicate crawl results");
  for (const entry of actual) {
    if (!domains.delete(entry.domain)) throw new Error("Unexpected or duplicate crawl result");
  }
  if (domains.size) throw new Error("Missing crawl results");
}

export function assertApprovedRemovals(previous: { domain: string }[], current: { domain: string }[], approved: Set<string>): void {
  const domains = new Set(current.map((entry) => entry.domain));
  const missing = previous.filter((entry) => !domains.has(entry.domain) && !approved.has(entry.domain));
  if (missing.length) throw new Error(`Refusing ${missing.length} unapproved snapshot removals; list reviewed domains explicitly in APPROVED_REMOVALS`);
}

export function assertSnapshot(snapshot: unknown): asserts snapshot is { generated_at: string; total: number; verified: number; unclaimed: number; entries: { domain: string; status: string; intent_count: number; intents: unknown[] }[] } {
  if (!snapshot || typeof snapshot !== "object") throw new Error("Invalid snapshot");
  const value = snapshot as Record<string, unknown>;
  if (typeof value.generated_at !== "string" || !Number.isFinite(Date.parse(value.generated_at)) || !Array.isArray(value.entries) || !value.entries.length) throw new Error("Invalid snapshot header");
  let verified = 0;
  let unclaimed = 0;
  const domains = new Set<string>();
  for (const entry of value.entries) {
    if (!entry || typeof entry.domain !== "string" || !entry.domain || domains.has(entry.domain)
      || !Array.isArray(entry.intents) || !Number.isInteger(entry.intent_count)
      || entry.intent_count < entry.intents.length) throw new Error("Invalid snapshot entry");
    domains.add(entry.domain);
    if (entry.status === "verified") verified++;
    else if (entry.status === "unclaimed") unclaimed++;
    else throw new Error("Invalid snapshot status");
  }
  if (value.total !== value.entries.length || value.verified !== verified || value.unclaimed !== unclaimed) throw new Error("Invalid snapshot totals");
}
