/**
 * Listing intake: land eligible one-row contributor PRs without a maintainer.
 *
 * Usage:
 *   node scripts/intake-listings.ts            # land, comment and close
 *   node scripts/intake-listings.ts --dry-run  # print decisions only
 *
 * Environment:
 *   GITHUB_TOKEN          — publisher token, used only for the registry commit (as in crawl.ts)
 *   PR_TOKEN              — token for reading PRs and for comments, labels and closing
 *   GITHUB_REPO           — default "ArcedeDev/open-402"
 *   MAX_LISTINGS_PER_RUN  — default 10 (and at most 2 per PR author per run)
 *
 * Safety: contributor code is never checked out or run. Each PR is judged from its file list and
 * patch text (scripts/lib/listing-intake.ts), then by the same live checks CI uses: a verified row
 * needs a valid manifest (crawlDomain); an unclaimed row needs a live x402 discovery document or a
 * valid manifest. Rows land through the crawler's atomic commit, which re-applies them to the newest
 * main, refuses the batch if main no longer holds the row each one expects, and is a no-op on retry.
 * Anything else gets a `needs-review` label, once per head commit. A run stops probing after
 * MAX_PROBES_PER_RUN evidence checks or RUN_BUDGET_MS, lands what it accepted, and leaves the rest
 * for the next run. An error on one PR never stops the others.
 */
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { githubCommitFilesAtomically } from "./crawl.ts";
import { crawlDomain, probeX402Discovery } from "./lib/manifest.ts";
import { parseDomainsTxt, type DomainEntry } from "./lib/registry-utils.ts";
import { applyRows, classifyPullRequest, coAuthorTrailer, REGISTRY_PATH, type Decision, type IntakeRow, type PullRequestFile } from "./lib/listing-intake.ts";

const GITHUB_REPO = process.env.GITHUB_REPO || "ArcedeDev/open-402";
const PR_TOKEN = process.env.PR_TOKEN || "";
const MAX_LISTINGS_PER_RUN = Number(process.env.MAX_LISTINGS_PER_RUN || "10");
const API = `https://api.github.com/repos/${GITHUB_REPO}`;
const MAX_PER_AUTHOR = 2;
const MAX_PROBES_PER_RUN = 25;
const RUN_BUDGET_MS = 8 * 60_000;
const MAX_PR_PAGES = 5;
const REVIEW_LABEL = "needs-review";
const HOLD_LABEL = "hold";

interface PullRequest {
  number: number;
  draft: boolean;
  created_at: string;
  user: { login: string; id: number; type: string };
  head: { sha: string; repo: { full_name: string } | null };
  base: { ref: string };
  labels: { name: string }[];
}

const log = (message: string) => console.log(`[intake] ${message}`);
const reviewMarker = (pr: PullRequest) => `<!-- open402-intake:review:${pr.head.sha} -->`;
const closeMarker = "<!-- open402-intake:closed -->";

async function gh<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path.startsWith("https://") ? path : `${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      ...(PR_TOKEN ? { Authorization: `Bearer ${PR_TOKEN}` } : {}),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path}: HTTP ${res.status}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

async function listAll<T>(path: string, maxPages: number): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await gh<T[]>(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return { items, truncated: false };
  }
  return { items, truncated: true };
}

async function hasComment(pr: PullRequest, marker: string): Promise<boolean> {
  const { items } = await listAll<{ body?: string }>(`/issues/${pr.number}/comments`, 3);
  return items.some((comment) => comment.body?.includes(marker));
}

async function evidence(entry: { domain: string; status: string }): Promise<string | null> {
  const manifest = await crawlDomain(entry.domain);
  if (manifest.success) return null;
  if (entry.status === "verified") return `the live manifest check failed (${manifest.error}); use \`unclaimed\` until a valid manifest is served`;
  const discovery = await probeX402Discovery(entry.domain);
  if (discovery.success) return null;
  return `there is no live evidence of an x402 service on the domain itself (\`/.well-known/x402\`: ${discovery.error}; \`/.well-known/agent.json\`: ${manifest.error})`;
}

async function close(pr: PullRequest, body: string): Promise<void> {
  if (!await hasComment(pr, closeMarker)) {
    await gh(`/issues/${pr.number}/comments`, { method: "POST", body: JSON.stringify({ body: `${closeMarker}\n${body}` }) });
  }
  await gh(`/pulls/${pr.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
}

async function flagForReview(pr: PullRequest, reason: string): Promise<void> {
  if (!pr.labels.some((label) => label.name === REVIEW_LABEL)) {
    await gh(`/issues/${pr.number}/labels`, { method: "POST", body: JSON.stringify({ labels: [REVIEW_LABEL] }) });
  }
  await gh(`/issues/${pr.number}/comments`, { method: "POST", body: JSON.stringify({ body: `${reviewMarker(pr)}\nThanks for the contribution. This PR cannot be landed automatically because ${reason}, so a maintainer will review it. One-row listing PRs that pass the checks in CONTRIBUTING.md are landed automatically.` }) });
}

export async function main(dryRun: boolean): Promise<void> {
  if (!Number.isSafeInteger(MAX_LISTINGS_PER_RUN) || MAX_LISTINGS_PER_RUN < 1 || MAX_LISTINGS_PER_RUN > 25) throw new Error("MAX_LISTINGS_PER_RUN must be 1..25");
  if (!dryRun && (!PR_TOKEN || !process.env.GITHUB_TOKEN)) throw new Error("PR_TOKEN and GITHUB_TOKEN are required unless --dry-run");
  const started = Date.now();
  const registry = parseDomainsTxt(await readFile(new URL(`../${REGISTRY_PATH}`, import.meta.url), "utf8"));

  const listed = await listAll<PullRequest>("/pulls?state=open&base=main&sort=created&direction=asc", MAX_PR_PAGES);
  if (listed.truncated) log(`more than ${MAX_PR_PAGES * 100} open PRs; only the oldest ${listed.items.length} are considered this run`);
  const pulls = listed.items.filter((pr) => !pr.draft && pr.base.ref === "main" && pr.user.type !== "Bot"
    && pr.head.repo !== null && pr.head.repo.full_name !== GITHUB_REPO
    && !pr.labels.some((label) => label.name === HOLD_LABEL));
  log(`${pulls.length} open contributor PRs`);

  const accepted: { pr: PullRequest; row: IntakeRow }[] = [];
  const closures: { pr: PullRequest; body: string }[] = [];
  const reviews: { pr: PullRequest; reason: string }[] = [];
  const perAuthor = new Map<number, number>();
  let probes = 0;
  let skipped = 0;
  let failed = 0;

  for (const pr of pulls) {
    if (Date.now() - started > RUN_BUDGET_MS || probes >= MAX_PROBES_PER_RUN) { skipped++; continue; }
    try {
      // Already told, and nothing pushed since: do not spend probes on it again.
      if (pr.labels.some((label) => label.name === REVIEW_LABEL) && await hasComment(pr, reviewMarker(pr))) { skipped++; continue; }
      const { items: files } = await listAll<PullRequestFile>(`/pulls/${pr.number}/files`, 1);
      let decision: Decision = classifyPullRequest(files, registry, pr.created_at.slice(0, 10));
      if (decision.kind === "eligible") {
        const { entry } = decision.row;
        if (accepted.some(({ row }) => row.entry.domain === entry.domain)) {
          decision = { kind: "review", reason: "another open PR lists the same domain" };
        } else if (accepted.length >= MAX_LISTINGS_PER_RUN || (perAuthor.get(pr.user.id) ?? 0) >= MAX_PER_AUTHOR) {
          log(`#${pr.number}: eligible, deferred to the next run`);
          skipped++;
          continue;
        } else {
          probes++;
          const missing = await evidence(entry);
          if (missing) decision = { kind: "review", reason: missing };
        }
      }
      switch (decision.kind) {
        case "eligible":
          log(`#${pr.number}: eligible ${decision.mode} ${decision.row.entry.domain} (${decision.row.entry.status})`);
          accepted.push({ pr, row: decision.row });
          perAuthor.set(pr.user.id, (perAuthor.get(pr.user.id) ?? 0) + 1);
          break;
        case "landed":
          log(`#${pr.number}: ${decision.entry.domain} is already on main`);
          closures.push({ pr, body: `Thanks. \`${decision.entry.domain}\` is on main, so this PR is closed.` });
          break;
        case "duplicate":
          log(`#${pr.number}: duplicate of ${decision.domain}`);
          closures.push({ pr, body: `Thanks. \`${decision.domain}\` is already listed as \`${decision.existing.status}\`, so this PR is closed as a duplicate. To upgrade an unclaimed listing, submit it as \`verified\` once \`/.well-known/agent.json\` validates. To correct an existing listing, open an issue.` });
          break;
        case "review":
          log(`#${pr.number}: needs review (${decision.reason})`);
          reviews.push({ pr, reason: decision.reason });
          break;
      }
    } catch (error) {
      failed++;
      log(`#${pr.number}: skipped after an error (${error instanceof Error ? error.message : error})`);
    }
  }

  // Land first, so nothing below can cost the accepted rows their run.
  if (accepted.length) {
    const trailers = [...new Set(accepted.map(({ pr }) => coAuthorTrailer(pr.user.login, pr.user.id)).filter(Boolean))];
    const message = [
      `Add ${accepted.length === 1 ? "a community listing" : "community listings"} (${accepted.map(({ pr }) => `#${pr.number}`).join(", ")})`,
      "",
      ...accepted.map(({ pr, row }) => `- #${pr.number} ${row.entry.domain} (${row.prior ? "upgraded to verified" : `${row.entry.status}, ${row.entry.source}`})`),
      "",
      "Landed by the listing intake job after the registry and live checks passed.",
      ...(trailers.length ? ["", ...trailers] : []),
    ].join("\n");
    if (dryRun) {
      log(`would commit:\n${message}`);
    } else {
      const ok = await githubCommitFilesAtomically([REGISTRY_PATH], message, (remote) => {
        const current = remote.get(REGISTRY_PATH)?.content;
        if (!current) throw new Error("registry missing on main");
        return [{ path: REGISTRY_PATH, content: applyRows(current, accepted.map(({ row }) => row)) }];
      });
      if (!ok) throw new Error("registry commit failed; nothing was closed");
      for (const { pr, row } of accepted) {
        closures.push({ pr, body: `Thanks. \`${row.entry.domain}\` passed the registry and live checks and is now on main, with you credited as a co-author. Your branch itself is not merged, because the nightly crawl rewrites \`${REGISTRY_PATH}\`.` });
      }
    }
  }

  for (const { pr, body } of closures) {
    log(`#${pr.number}: ${dryRun ? "would close" : "closing"}`);
    if (dryRun) continue;
    try { await close(pr, body); } catch (error) { failed++; log(`#${pr.number}: close failed (${error instanceof Error ? error.message : error})`); }
  }
  for (const { pr, reason } of reviews) {
    if (dryRun) continue;
    try { await flagForReview(pr, reason); } catch (error) { failed++; log(`#${pr.number}: review flag failed (${error instanceof Error ? error.message : error})`); }
  }

  const existingClosed = closures.length - (dryRun ? 0 : accepted.length);
  const summary = `Listing intake${dryRun ? " (dry run)" : ""}: ${accepted.length} ${dryRun ? "would land" : "landed"}, ${existingClosed} already listed, ${reviews.length} need review, ${skipped} skipped or deferred, ${failed} errors, ${probes} probes in ${Math.round((Date.now() - started) / 1000)} s.`;
  log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--dry-run")) throw new Error("Unknown intake argument");
  try {
    await main(args.includes("--dry-run"));
  } catch (error) {
    console.error(`[intake] FATAL: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
