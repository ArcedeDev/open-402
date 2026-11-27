/**
 * Listing intake: land eligible one-row contributor PRs without a maintainer.
 *
 * Usage:
 *   node scripts/intake-listings.ts            # land, comment and close
 *   node scripts/intake-listings.ts --dry-run  # print decisions only
 *
 * Environment:
 *   GITHUB_TOKEN          — publisher token, used only for the registry commit (as in crawl.ts)
 *   PR_TOKEN              — token for reading PRs and runs, and for comments, labels and closing
 *   GITHUB_REPO           — default "ArcedeDev/open-402"
 *   MAX_LISTINGS_PER_RUN  — default 10
 *
 * Safety: contributor code is never checked out or run. Each PR is judged from its file list and
 * patch text (scripts/lib/listing-intake.ts), then by live evidence on the domain itself: a verified
 * row needs a valid manifest (crawlDomain); an unclaimed row needs a valid manifest or a live x402
 * challenge (probeX402Discovery). Rows land through the crawler's atomic commit, which re-applies
 * them to the newest main, refuses the batch if main no longer holds the row each one expects, and
 * is a no-op on retry. A PR is closed only after its row is on main. Nothing lands while the
 * nightly crawl is running, because the crawl refuses a registry that changed under it.
 *
 * Anything that cannot land gets a `needs-review` label and one comment per head commit, which is
 * edited rather than repeated. A failure that may be temporary (a timeout, a 5xx, a duplicate open
 * PR) is checked again after a day; any other failure waits for a push or a maintainer. Only
 * comments written by this job's own account count as its markers.
 *
 * Fairness: PRs never checked come first, then the least recently checked. A run makes at most
 * MAX_PROBES_PER_RUN evidence checks, at most MAX_PROBES_PER_AUTHOR per author, within
 * RUN_BUDGET_MS. An error on one PR never stops the others.
 */
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { githubCommitFilesAtomically } from "./crawl.ts";
import { crawlDomain, isTransientFetchError, probeX402Discovery } from "./lib/manifest.ts";
import { parseDomainsTxt, type DomainEntry } from "./lib/registry-utils.ts";
import { applyRows, classifyPullRequest, coAuthorTrailer, REGISTRY_PATH, type Decision, type IntakeRow, type PullRequestFile } from "./lib/listing-intake.ts";

export const MAX_PROBES_PER_RUN = 25;
export const MAX_PROBES_PER_AUTHOR = 2;
export const RUN_BUDGET_MS = 8 * 60_000;
export const RETRY_AFTER_MS = 24 * 60 * 60_000;
const MAX_PR_PAGES = 5;
const REVIEW_LABEL = "needs-review";
const HOLD_LABEL = "hold";
const BOT_LOGIN = "github-actions[bot]";
const CRAWL_WORKFLOW = "nightly-crawl.yml";

export interface PullRequest {
  number: number;
  draft: boolean;
  created_at: string;
  user: { login: string; id: number; type: string };
  head: { sha: string; repo: { full_name: string } | null };
  base: { ref: string };
  labels: { name: string }[];
}

export interface IssueComment {
  id: number;
  body?: string;
  updated_at: string;
  user: { login: string; type: string } | null;
}

export type Evidence = { ok: true } | { ok: false; transient: boolean; reason: string };

/** Everything the intake does to the outside world, so the rules can be tested without it. */
export interface IntakeDeps {
  repo: string;
  registry: DomainEntry[];
  listPulls(): Promise<{ items: PullRequest[]; truncated: boolean }>;
  listFiles(pr: number): Promise<PullRequestFile[]>;
  listComments(pr: number): Promise<IssueComment[]>;
  postComment(pr: number, body: string): Promise<void>;
  editComment(id: number, body: string): Promise<void>;
  addLabel(pr: number, label: string): Promise<void>;
  closePull(pr: number): Promise<void>;
  crawlRunning(): Promise<boolean>;
  evidence(entry: DomainEntry): Promise<Evidence>;
  /** Commit the rows to main; true once they are on main. */
  commit(message: string, rows: IntakeRow[]): Promise<boolean>;
  now(): number;
  log(message: string): void;
}

export interface IntakeSummary {
  landed: number;
  closed: number;
  review: number;
  deferred: number;
  errors: number;
  probes: number;
  commitFailed: boolean;
}

const MARK = "open402-intake";
const reviewMarker = (sha: string, retry: boolean) => `<!-- ${MARK}:review:${sha}:${retry ? "retry" : "final"} -->`;
const closeMarker = (sha: string) => `<!-- ${MARK}:closed:${sha} -->`;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface Review { reason: string; retry: boolean }

export async function runIntake(deps: IntakeDeps, options: { dryRun: boolean; maxListings: number }): Promise<IntakeSummary> {
  const { log } = deps;
  const started = deps.now();
  const summary: IntakeSummary = { landed: 0, closed: 0, review: 0, deferred: 0, errors: 0, probes: 0, commitFailed: false };

  const listed = await deps.listPulls();
  if (listed.truncated) log(`more than ${MAX_PR_PAGES * 100} open PRs; only the oldest ${listed.items.length} are considered this run`);
  const pulls = listed.items.filter((pr) => !pr.draft && pr.base.ref === "main" && pr.user.type !== "Bot"
    && pr.head.repo !== null && pr.head.repo.full_name !== deps.repo
    && !pr.labels.some((label) => label.name === HOLD_LABEL));
  log(`${pulls.length} open contributor PRs`);

  // Read this job's own comments on each PR first: they say what it has already done.
  const mine = new Map<number, IssueComment[]>();
  for (const pr of pulls) {
    try {
      mine.set(pr.number, (await deps.listComments(pr.number)).filter((c) => c.user?.login === BOT_LOGIN && c.user.type === "Bot"));
    } catch (error) {
      summary.errors++;
      log(`#${pr.number}: could not read comments (${message(error)})`);
    }
  }
  const lastChecked = (pr: PullRequest) => Math.max(0, ...(mine.get(pr.number) ?? [])
    .filter((c) => c.body?.includes(`<!-- ${MARK}:`)).map((c) => Date.parse(c.updated_at) || 0));
  const queue = pulls.filter((pr) => mine.has(pr.number)).sort((a, b) => lastChecked(a) - lastChecked(b) || a.number - b.number);

  const accepted: { pr: PullRequest; row: IntakeRow }[] = [];
  const closures: { pr: PullRequest; body: string }[] = [];
  const reviews: { pr: PullRequest; review: Review }[] = [];
  const probesByAuthor = new Map<number, number>();

  for (const pr of queue) {
    try {
      const comments = mine.get(pr.number)!;
      const sha = pr.head.sha;
      const marked = (marker: string) => comments.find((c) => c.body?.includes(marker));
      if (marked(reviewMarker(sha, false))) continue; // Told already; waits for a push or a maintainer.
      const retry = marked(reviewMarker(sha, true));
      if (retry && deps.now() - (Date.parse(retry.updated_at) || 0) < RETRY_AFTER_MS) continue;
      if (comments.some((c) => c.body?.includes(`<!-- ${MARK}:closed:`))) {
        reviews.push({ pr, review: { reason: "it was reopened after the intake job closed it", retry: false } });
        continue;
      }

      let decision: Decision = classifyPullRequest(await deps.listFiles(pr.number), deps.registry, pr.created_at.slice(0, 10));
      if (decision.kind === "eligible") {
        const { entry } = decision.row;
        if (accepted.some(({ row }) => row.entry.domain === entry.domain)) {
          reviews.push({ pr, review: { reason: "another open PR lists the same domain", retry: true } });
          continue;
        }
        const authorProbes = probesByAuthor.get(pr.user.id) ?? 0;
        if (accepted.length >= options.maxListings || summary.probes >= MAX_PROBES_PER_RUN
          || authorProbes >= MAX_PROBES_PER_AUTHOR || deps.now() - started > RUN_BUDGET_MS) {
          log(`#${pr.number}: eligible, deferred to the next run`);
          summary.deferred++;
          continue;
        }
        summary.probes++;
        probesByAuthor.set(pr.user.id, authorProbes + 1);
        const evidence = await deps.evidence(entry);
        if (!evidence.ok) {
          reviews.push({ pr, review: { reason: evidence.reason, retry: evidence.transient } });
          continue;
        }
      }
      switch (decision.kind) {
        case "eligible":
          log(`#${pr.number}: eligible ${decision.mode} ${decision.row.entry.domain} (${decision.row.entry.status})`);
          accepted.push({ pr, row: decision.row });
          break;
        case "landed":
          closures.push({ pr, body: `Thanks. \`${decision.entry.domain}\` is on main, so this PR is closed.` });
          break;
        case "duplicate":
          closures.push({ pr, body: `Thanks. \`${decision.domain}\` is already listed as \`${decision.existing.status}\`, so this PR is closed as a duplicate. To upgrade an unclaimed listing, submit it as \`verified\` once \`/.well-known/agent.json\` validates. To correct an existing listing, open an issue.` });
          break;
        case "review":
          reviews.push({ pr, review: { reason: decision.reason, retry: false } });
          break;
      }
    } catch (error) {
      summary.errors++;
      log(`#${pr.number}: skipped after an error (${message(error)})`);
    }
  }

  // Land first. If that fails, the accepted PRs stay open and everything else still goes ahead.
  if (accepted.length) {
    if (await deps.crawlRunning().catch(() => true)) {
      log(`the nightly crawl is running; ${accepted.length} accepted listings wait for the next run`);
      summary.deferred += accepted.length;
    } else {
      const trailers = [...new Set(accepted.map(({ pr }) => coAuthorTrailer(pr.user.login, pr.user.id)).filter(Boolean))];
      const text = [
        `Add ${accepted.length === 1 ? "a community listing" : "community listings"} (${accepted.map(({ pr }) => `#${pr.number}`).join(", ")})`,
        "",
        ...accepted.map(({ pr, row }) => `- #${pr.number} ${row.entry.domain} (${row.prior ? "upgraded to verified" : `${row.entry.status}, ${row.entry.source}`})`),
        "",
        "Landed by the listing intake job after the registry and live checks passed.",
        ...(trailers.length ? ["", ...trailers] : []),
      ].join("\n");
      if (options.dryRun) {
        log(`would commit:\n${text}`);
      } else {
        let ok = false;
        try { ok = await deps.commit(text, accepted.map(({ row }) => row)); }
        catch (error) { log(`registry commit failed (${message(error)})`); }
        if (ok) {
          summary.landed = accepted.length;
          for (const { pr, row } of accepted) {
            closures.push({ pr, body: `Thanks. \`${row.entry.domain}\` passed the registry and live checks and is now on main, with you credited as a co-author. Your branch itself is not merged, because the nightly crawl rewrites \`${REGISTRY_PATH}\`.` });
          }
        } else {
          summary.commitFailed = true;
          log("registry commit failed; the accepted PRs stay open for the next run");
        }
      }
    }
  }

  for (const { pr, body } of closures) {
    log(`#${pr.number}: ${options.dryRun ? "would close" : "closing"}`);
    if (options.dryRun) continue;
    try {
      // Close first: a close marker on an open PR then always means it was reopened.
      await deps.closePull(pr.number);
      await deps.postComment(pr.number, `${closeMarker(pr.head.sha)}\n${body}`);
      summary.closed++;
    } catch (error) {
      summary.errors++;
      log(`#${pr.number}: close failed (${message(error)})`);
    }
  }

  for (const { pr, review } of reviews) {
    log(`#${pr.number}: needs review (${review.reason})${review.retry ? ", retried in a day" : ""}`);
    summary.review++;
    if (options.dryRun) continue;
    try {
      if (!pr.labels.some((label) => label.name === REVIEW_LABEL)) await deps.addLabel(pr.number, REVIEW_LABEL);
      const next = review.retry
        ? "This may be temporary, so it will be checked again automatically within a day."
        : "Push a fix to run the checks again, or a maintainer will review it.";
      const body = `${reviewMarker(pr.head.sha, review.retry)}\nThanks for the contribution. This PR cannot be landed automatically yet because ${review.reason}. ${next} One-row listing PRs that pass the checks in CONTRIBUTING.md are landed automatically.`;
      // One comment per head commit, edited on each retry so its time records the last check.
      const existing = mine.get(pr.number)?.find((c) => c.body?.includes(`<!-- ${MARK}:review:${pr.head.sha}:`));
      if (existing) await deps.editComment(existing.id, body);
      else await deps.postComment(pr.number, body);
    } catch (error) {
      summary.errors++;
      log(`#${pr.number}: review flag failed (${message(error)})`);
    }
  }
  return summary;
}

/** Live evidence for one accepted row (see the header). */
export async function liveEvidence(entry: DomainEntry): Promise<Evidence> {
  const manifest = await crawlDomain(entry.domain);
  if (manifest.success) return { ok: true };
  if (entry.status === "verified") {
    return { ok: false, transient: isTransientFetchError(manifest.error), reason: `the live manifest check failed (${manifest.error}); use \`unclaimed\` until a valid manifest is served` };
  }
  const discovery = await probeX402Discovery(entry.domain);
  if (discovery.success) return { ok: true };
  return {
    ok: false,
    transient: Boolean(discovery.transient) || isTransientFetchError(manifest.error),
    reason: `there is no live evidence of an x402 service on the domain itself: no paid resource answered with an x402 challenge (\`${discovery.error}\`), and \`/.well-known/agent.json\` did not validate (\`${manifest.error}\`)`,
  };
}

function githubDeps(repo: string, token: string, registry: DomainEntry[]): IntakeDeps {
  const api = `https://api.github.com/repos/${repo}`;
  async function gh<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${api}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
  return {
    repo,
    registry,
    listPulls: () => listAll<PullRequest>("/pulls?state=open&base=main&sort=created&direction=asc", MAX_PR_PAGES),
    listFiles: async (pr) => (await listAll<PullRequestFile>(`/pulls/${pr}/files`, 1)).items,
    listComments: async (pr) => (await listAll<IssueComment>(`/issues/${pr}/comments`, 3)).items,
    postComment: async (pr, body) => { await gh(`/issues/${pr}/comments`, { method: "POST", body: JSON.stringify({ body }) }); },
    editComment: async (id, body) => { await gh(`/issues/comments/${id}`, { method: "PATCH", body: JSON.stringify({ body }) }); },
    addLabel: async (pr, label) => { await gh(`/issues/${pr}/labels`, { method: "POST", body: JSON.stringify({ labels: [label] }) }); },
    closePull: async (pr) => { await gh(`/pulls/${pr}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) }); },
    crawlRunning: async () => {
      for (const status of ["in_progress", "queued"]) {
        const runs = await gh<{ total_count: number }>(`/actions/workflows/${CRAWL_WORKFLOW}/runs?status=${status}&per_page=1`);
        if (runs.total_count > 0) return true;
      }
      return false;
    },
    evidence: liveEvidence,
    commit: (text, rows) => githubCommitFilesAtomically([REGISTRY_PATH], text, (remote) => {
      const current = remote.get(REGISTRY_PATH)?.content;
      if (!current) throw new Error("registry missing on main");
      return [{ path: REGISTRY_PATH, content: applyRows(current, rows) }];
    }),
    now: () => Date.now(),
    log: (text) => console.log(`[intake] ${text}`),
  };
}

export async function main(dryRun: boolean): Promise<IntakeSummary> {
  const repo = process.env.GITHUB_REPO || "ArcedeDev/open-402";
  const token = process.env.PR_TOKEN || "";
  const maxListings = Number(process.env.MAX_LISTINGS_PER_RUN || "10");
  if (!Number.isSafeInteger(maxListings) || maxListings < 1 || maxListings > 25) throw new Error("MAX_LISTINGS_PER_RUN must be 1..25");
  if (!dryRun && (!token || !process.env.GITHUB_TOKEN)) throw new Error("PR_TOKEN and GITHUB_TOKEN are required unless --dry-run");
  const registry = parseDomainsTxt(await readFile(new URL(`../${REGISTRY_PATH}`, import.meta.url), "utf8"));
  const started = Date.now();
  const s = await runIntake(githubDeps(repo, token, registry), { dryRun, maxListings });
  const line = `Listing intake${dryRun ? " (dry run)" : ""}: ${s.landed} landed, ${s.closed} closed, ${s.review} need review, ${s.deferred} deferred, ${s.errors} errors, ${s.probes} probes in ${Math.round((Date.now() - started) / 1000)} s.`;
  console.log(`[intake] ${line}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  return s;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--dry-run")) throw new Error("Unknown intake argument");
  try {
    // Only a failed landing turns the run red; per-PR errors are logged and retried next run.
    if ((await main(args.includes("--dry-run"))).commitFailed) process.exitCode = 1;
  } catch (error) {
    console.error(`[intake] FATAL: ${message(error)}`);
    process.exitCode = 1;
  }
}
