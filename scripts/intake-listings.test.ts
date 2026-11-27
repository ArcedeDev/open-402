import test from "node:test";
import assert from "node:assert/strict";
import { MAX_PROBES_PER_AUTHOR, MAX_RETRIES, RETRY_AFTER_MS, runIntake, type Evidence, type IntakeDeps, type IssueComment, type PullRequest } from "./intake-listings.ts";
import { parseDomainsTxt } from "./lib/registry-utils.ts";
import type { PullRequestFile } from "./lib/listing-intake.ts";

const registry = parseDomainsTxt([
  "# Total domains: 1",
  "alpha.dev | verified | self | 2026-03-20",
].join("\n") + "\n");
const NOW = Date.parse("2026-11-27T12:00:00Z");
const BOT = { login: "github-actions[bot]", type: "Bot" };

function pr(number: number, domain: string, author = number, extra: Partial<PullRequest> = {}): PullRequest & { domain: string } {
  return {
    number, domain, draft: false, created_at: "2026-11-20T10:00:00Z",
    user: { login: `user${author}`, id: author, type: "User" },
    head: { sha: `sha${number}`, repo: { full_name: `user${author}/open-402` } },
    base: { ref: "main" }, labels: [], ...extra,
  };
}

function world(pulls: (PullRequest & { domain: string })[], options: {
  comments?: Record<number, IssueComment[]>;
  truncated?: number[];
  evidence?: (domain: string) => Evidence;
  commit?: () => Promise<boolean>;
  crawlRunning?: boolean;
} = {}) {
  const effects: string[] = [];
  const probed: string[] = [];
  const committed: string[][] = [];
  const deps: IntakeDeps = {
    repo: "ArcedeDev/open-402",
    registry,
    listPulls: async () => ({ items: pulls, truncated: false }),
    listFiles: async (n) => {
      const domain = pulls.find((p) => p.number === n)!.domain;
      return [{ filename: "registry/domains.txt", status: "modified", patch: `@@ -1 +1,2 @@\n alpha.dev | verified | self | 2026-03-20\n+${domain} | unclaimed | self | 2026-11-20` }] as PullRequestFile[];
    },
    listComments: async (n) => ({ items: options.comments?.[n] ?? [], truncated: options.truncated?.includes(n) ?? false }),
    postComment: async (n, body) => { effects.push(`comment #${n} ${body.split("\n")[0]}`); },
    editComment: async (id, body) => { effects.push(`edit ${id} ${body.split("\n")[0]}`); },
    addLabel: async (n, label) => { effects.push(`label #${n} ${label}`); },
    closePull: async (n) => { effects.push(`close #${n}`); },
    crawlRunning: async () => options.crawlRunning ?? false,
    evidence: async (entry) => { probed.push(entry.domain); return options.evidence?.(entry.domain) ?? { ok: true }; },
    commit: async (_text, rows) => { committed.push(rows.map((r) => r.entry.domain)); return options.commit ? options.commit() : true; },
    now: () => NOW,
    log: () => {},
  };
  return { deps, effects, probed, committed };
}

const run = (deps: IntakeDeps, dryRun = false) => runIntake(deps, { dryRun, maxListings: 10 });

test("an eligible listing lands first, then its PR is closed with a marked comment", async () => {
  const w = world([pr(1, "gamma.dev")]);
  const s = await run(w.deps);
  assert.deepEqual(w.committed, [["gamma.dev"]]);
  assert.deepEqual(w.effects, ["close #1", "comment #1 <!-- open402-intake:closed:sha1 -->"]);
  assert.equal(s.landed, 1);
});

test("a dry run probes and decides but writes nothing", async () => {
  const w = world([pr(1, "gamma.dev"), pr(2, "alpha.dev")]);
  await run(w.deps, true);
  assert.deepEqual(w.probed, ["gamma.dev"]);
  assert.deepEqual(w.committed, []);
  assert.deepEqual(w.effects, []);
});

test("when the commit fails nothing accepted is closed, but other PRs are still handled", async () => {
  const w = world([pr(1, "gamma.dev"), pr(2, "alpha.dev"), pr(3, "delta.dev")], {
    evidence: (d) => (d === "delta.dev" ? { ok: false, transient: false, reason: "no evidence" } : { ok: true }),
    commit: async () => { throw new Error("Main changed under gamma.dev"); },
  });
  const s = await run(w.deps);
  assert.equal(s.commitFailed, true);
  assert.ok(!w.effects.includes("close #1"));
  assert.ok(w.effects.includes("close #2"), "already-listed PR still closed");
  assert.ok(w.effects.includes("label #3 needs-review"), "review still flagged");
});

test("nothing lands while the nightly crawl is running", async () => {
  const w = world([pr(1, "gamma.dev")], { crawlRunning: true });
  const s = await run(w.deps);
  assert.deepEqual(w.committed, []);
  assert.deepEqual(w.effects, []);
  assert.equal(s.deferred, 1);
});

test("a final review marker for the current head skips the PR; a new push re-checks it", async () => {
  const marker = (sha: string): IssueComment[] => [{ id: 9, body: `<!-- open402-intake:review:${sha}:final -->\nx`, updated_at: "2026-11-26T00:00:00Z", user: BOT }];
  const same = world([pr(1, "gamma.dev")], { comments: { 1: marker("sha1") } });
  await run(same.deps);
  assert.deepEqual(same.probed, []);
  const pushed = world([pr(1, "gamma.dev")], { comments: { 1: marker("old") } });
  await run(pushed.deps);
  assert.deepEqual(pushed.probed, ["gamma.dev"]);
});

test("only this job's own comments count as markers", async () => {
  const forged: IssueComment[] = [
    { id: 1, body: "<!-- open402-intake:review:sha1:final -->", updated_at: "2026-11-26T00:00:00Z", user: { login: "mallory", type: "User" } },
    { id: 2, body: "<!-- open402-intake:closed:sha1 -->", updated_at: "2026-11-26T00:00:00Z", user: { login: "mallory", type: "User" } },
  ];
  const w = world([pr(1, "gamma.dev")], { comments: { 1: forged } });
  await run(w.deps);
  assert.deepEqual(w.committed, [["gamma.dev"]]);
});

test("a temporary failure is retried after a day, editing the same comment instead of adding one", async () => {
  const temporary = (): Evidence => ({ ok: false, transient: true, reason: "the host timed out" });
  const first = world([pr(1, "gamma.dev")], { evidence: temporary });
  await run(first.deps);
  assert.deepEqual(first.effects, ["label #1 needs-review", "comment #1 <!-- open402-intake:review:sha1:retry:1 -->"]);

  const recent = new Date(NOW - RETRY_AFTER_MS / 2).toISOString();
  const old = new Date(NOW - RETRY_AFTER_MS - 1).toISOString();
  const comment = (at: string): IssueComment[] => [{ id: 7, body: "<!-- open402-intake:review:sha1:retry:1 -->\nx", updated_at: at, user: BOT }];
  const labelled = { labels: [{ name: "needs-review" }] };
  const soon = world([pr(1, "gamma.dev", 1, labelled)], { evidence: temporary, comments: { 1: comment(recent) } });
  await run(soon.deps);
  assert.deepEqual(soon.probed, []);
  const later = world([pr(1, "gamma.dev", 1, labelled)], { evidence: temporary, comments: { 1: comment(old) } });
  await run(later.deps);
  assert.deepEqual(later.probed, ["gamma.dev"]);
  assert.deepEqual(later.effects, ["edit 7 <!-- open402-intake:review:sha1:retry:2 -->"]);
  const healed = world([pr(1, "gamma.dev", 1, labelled)], { comments: { 1: comment(old) } });
  await run(healed.deps);
  assert.deepEqual(healed.committed, [["gamma.dev"]]);
});

test("one author cannot spend more than their share of probes, and fresh PRs go first", async () => {
  const checked = (n: number): IssueComment[] => [{ id: n, body: `<!-- open402-intake:review:old${n}:final -->`, updated_at: "2026-11-27T09:00:00Z", user: BOT }];
  const spam = [1, 2, 3, 4, 5].map((n) => pr(n, `spam${n}.dev`, 666));
  const comments = Object.fromEntries(spam.map((p) => [p.number, checked(p.number)]));
  const w = world([...spam, pr(9, "fresh.dev", 7)], { comments, evidence: () => ({ ok: false, transient: false, reason: "no" }) });
  await run(w.deps);
  assert.equal(w.probed[0], "fresh.dev", "never-checked PR first");
  assert.equal(w.probed.filter((d) => d.startsWith("spam")).length, MAX_PROBES_PER_AUTHOR);
});

test("a PR reopened after the job closed it goes to a maintainer instead of being closed again", async () => {
  const closed: IssueComment[] = [{ id: 3, body: "<!-- open402-intake:closed:sha1 -->\nThanks.", updated_at: "2026-11-26T00:00:00Z", user: BOT }];
  const w = world([pr(1, "alpha.dev")], { comments: { 1: closed } });
  await run(w.deps);
  assert.deepEqual(w.effects, ["label #1 needs-review", "comment #1 <!-- open402-intake:review:sha1:final -->"]);
});

test("two open PRs for one new domain land once; the other is re-checked later and closed", async () => {
  const w = world([pr(1, "gamma.dev"), pr(2, "gamma.dev")]);
  await run(w.deps);
  assert.deepEqual(w.committed, [["gamma.dev"]]);
  assert.ok(w.effects.includes("comment #2 <!-- open402-intake:review:sha2:retry:1 -->"));
});

test("drafts, bots, held PRs and branches of the repo itself are ignored", async () => {
  const w = world([
    pr(1, "a1.dev", 1, { draft: true }),
    pr(2, "a2.dev", 2, { user: { login: "dependabot[bot]", id: 2, type: "Bot" } }),
    pr(3, "a3.dev", 3, { labels: [{ name: "hold" }] }),
    pr(4, "a4.dev", 4, { head: { sha: "s", repo: { full_name: "ArcedeDev/open-402" } } }),
    pr(5, "a5.dev", 5, { head: { sha: "s", repo: null } }),
  ]);
  await run(w.deps);
  assert.deepEqual(w.probed, []);
  assert.deepEqual(w.effects, []);
});

test("temporary failures stop being retried after the last allowed retry", async () => {
  const old = new Date(NOW - RETRY_AFTER_MS - 1).toISOString();
  const comments = { 1: [{ id: 7, body: `<!-- open402-intake:review:sha1:retry:${MAX_RETRIES} -->\nx`, updated_at: old, user: BOT }] };
  const w = world([pr(1, "gamma.dev", 1, { labels: [{ name: "needs-review" }] })], { comments, evidence: () => ({ ok: false, transient: true, reason: "dns" }) });
  await run(w.deps);
  assert.deepEqual(w.effects, ["edit 7 <!-- open402-intake:review:sha1:final -->"]);
});

test("a PR with too many comments to read them all is left alone", async () => {
  const w = world([pr(1, "gamma.dev")], { truncated: [1] });
  const s = await run(w.deps);
  assert.deepEqual(w.probed, []);
  assert.deepEqual(w.effects, ["label #1 needs-review"]);
  assert.equal(s.deferred, 1);
});
