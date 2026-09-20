# Registry Maintenance

Use Node 24.14.0 or later. Install the lockfile with `npm ci --ignore-scripts`, then run `npm test` and `npm run check:registry`.

## Read-only validation

`node scripts/crawl.ts --dry-run --limit 90` checks a uniform sample of the local registry. Omit `--limit` for a full read-only manifest crawl. Dry runs never publish, discover additional domains, verify payment activity, or call the sync webhook. Partial runs are refused unless dry-run mode is explicit.

`node scripts/check-registry.ts --base <40-character-commit-sha> --live` validates changed rows and checks the manifests of newly verified listings. Unclaimed services still need manual evidence of a real public API. Manifest verification is not a security, payment, or service-quality endorsement.

## Publication

The nightly workflow uses a single publication concurrency group. It runs tests, crawls every target, verifies exact target coverage, atomically updates the registry and snapshot, then reads the published snapshot back. A registry addition/removal during a crawl aborts publication; rerun against the updated registry. Failed manifest observations preserve existing metadata, capabilities and payment evidence.

### Manifest Health

`manifest_health` describes the manifest observation, not runtime service availability or payment correctness. `healthy` means the latest observation validated successfully; a failed previously verified listing becomes `stale` immediately while retaining its listing status and metadata. Failed unclaimed listings with no known successful observation are `unavailable`. Legacy or incoherent observation data is `unknown`; neither old attempt counts nor `last_crawled` establish a successful validation time.

Readers apply a 48-hour freshness window: a stored healthy observation older than 48 hours is displayed as stale. This reader-side expiry is not a new failed observation, does not increment `failure_days`, and does not by itself demote a listing. Importing or replaying a snapshot must not reset the observation time or refresh this window.

The observation stores canonical UTC ISO timestamps: `checked_at`, `last_success_at`, `failure_since` and `demoted_at`, each nullable when unknown. `failure_days` counts distinct observed UTC failure dates since the last success. Same-day retries do not increment it, and unobserved dates do not count. Success resets the failure streak and error, but preserves `demoted_at` so recovery cannot replenish the day's allowance. `error` is a bounded category; provider bodies are never stored in it. The legacy `consecutive_failures` attempt counter remains for compatibility and never determines failure days or demotion eligibility. `STALE_DAYS` is superseded by immediate observed staleness.

After `DEMOTE_DAYS` observed failure dates (default 30), stale verified listings enter a queue ordered by oldest `failure_since`, then domain. At most `min(25, floor(target count * 0.01))` listings may be demoted per UTC date, including already-demoted listings even if they recover during that date. Excess candidates remain stale and queued; their metadata and evidence are retained. Fewer than 100 targets gives a zero allowance and holds demotions for explicit review without failing merely because the queue is nonempty. The independent 1% publication guard remains. Sample dry runs use the sample's target count and never persist observations or consume the real daily allowance.

The snapshot-level `manifest_demotion_budget` ledger stores `{date: "YYYY-MM-DD", used: integer}` independently of domain rows. Today's consumed allowance is the maximum of the persisted count and the distinct domains with visible same-day `demoted_at` markers; newly selected demotions are added before publication. Approved removal of a demoted row therefore cannot replenish quota on a subsequent run. Missing legacy ledgers derive usage from visible markers. A ledger from an earlier UTC date resets its count to zero; malformed dates, future dates, and non-integer or negative counts refuse the crawl. Counts already above a reduced registry's daily limit are preserved, with further demotions held rather than failed.

Before shipping a crawler change, test 1% and 10% read-only samples. Request-outcome logs distinguish freshly validated manifests, failures by reason, newly failing previously healthy verified entries, and deadline overruns from retained snapshot statuses. The health gate refuses zero fresh manifests, any request taking over nine seconds (eight-second deadline plus one-second scheduling tolerance), or more than 1% proposed demotions. Missing results fail independently. Investigate unexpected private-address attempts and newly failing verified services before proceeding. Confirm a full production run finishes inside the 30-minute workflow budget. Git publication and required downstream reconciliation are separate workflow steps; publication alone is not a successful full run. Address verification is capped at 5 per run; deferred evidence remains unchanged.

The workflow sets `MAX_ONCHAIN_ADDRESSES_PER_RUN=5`. The crawler also uses five when this setting is unset or zero; the scheduler accepts only integer limits from 1 to 5 and integer concurrency from 1 to 100. Prefer the workflow for production publication. Log queries use at most 2,000 blocks to respect the default public Base RPC limit. The smaller address batch offsets the smaller block range: five fresh 1,300,001-block scans require at most 3,255 log queries before retries, versus 3,275 for the former 25-address/10,000-block configuration. Older persisted cursors, retries and block timestamp lookups can require more requests; the workflow time limit still applies. Incomplete scans preserve prior totals and cursors and are not fresh verification.

Every removal of an already-published domain requires an exact name in the manual workflow's `approved_removals` input (`APPROVED_REMOVALS` locally). Review the removal justification first. Bulk additions, edits and deletions all count toward the 100-change PR review limit.

### Payment Verification Queue

Supported, valid payout addresses share one queue across manifest and watcher claims. Selection orders by oldest `last_scan_attempt_at`, then oldest `last_scanned_block`, then address key. Missing, malformed or future attempt times count as never attempted; a missing cursor sorts first within an attempt-time tie. Deferred and unsupported records remain unchanged.

The following optional address-verification fields distinguish scan freshness from historical payment evidence. Missing fields remain unknown until an actual attempt or completion; `last_verified_at` is not a substitute for scan completion.

| Field | Meaning |
| --- | --- |
| `last_scan_attempt_at` | UTC ISO batch-start time recorded before provider work, including attempts that throw or remain incomplete. |
| `last_scan_complete_at` | Time of an accepted complete result; must parse to a finite time at or after the attempt. Retained unchanged on failure. |
| `last_scan_error` | Failure category, or `null` after an accepted complete result. Raw provider error bodies are not stored here. |

Attempts rotate failed addresses behind less recently attempted addresses. Metadata becomes durable with the next successful snapshot publication; an aborted publication cannot persist rotation. Throws, incomplete scans and missing or mismatched results preserve prior evidence, cursor and completion time while recording the attempt and error. Unexpected result keys invalidate the batch. Complete results require a nonnegative safe-integer cursor and transaction count, finite nonnegative volume, and no regression from prior values; malformed results or invalid completion times produce `invalid_result` without replacing historical evidence. A cursor ahead of the actual provider head produces incomplete `cursor_ahead_of_head` until the head catches up, rather than falsely refreshing completion. A valid complete scan may find no new transfers.

## Required Reconciliation

After publication, `node scripts/sync.ts` reads the current published revision and requests reconciliation of that immutable commit. `SYNC_WEBHOOK_SECRET` is mandatory; absence fails the step. The webhook request and response body share a 90-second deadline. Timeout, failed HTTP, malformed or oversized receipt, or incomplete accounting fails the workflow.

The receipt must match the requested commit, snapshot generation timestamp and total entry count exactly. `synced`, `skipped`, `errors` and `unattempted` must be nonnegative integers whose sum equals the snapshot total; success additionally requires zero `errors` and zero `unattempted`. An HTTP 200 alone is insufficient. A skip must reflect the consumer's evidence-preservation policy, not a fresh successful manifest observation.

If reconciliation fails, Git publication may already be accepted. Do not roll it back automatically or infer that a timed-out server stopped writing. Diagnose the failure, fix its cause, and reconcile the current published revision with:

```sh
gh workflow run nightly-crawl.yml --repo ArcedeDev/open-402 -f mode=sync-only
```

This mode runs checks and required reconciliation without crawling providers, aging manifest failure days, consuming demotion allowance, scanning payment addresses or adding provider load. It resolves the current main revision when reconciliation begins, so verify the returned receipt against that revision rather than assuming the original failed run's commit is still current.

## Stop and Recovery

Run `node scripts/pause-publication.ts --confirm` to disable the workflow first, enumerate and cancel all active/queued publishers, and wait until every run is terminal. The command prints the actual main commit after cancellation. If it fails, do not restore data: inspect the remaining runs. Cancellation cannot undo a Git ref update or downstream sync that already completed; inspect the snapshot, commit history and sync logs before restoring anything. A cancelled run is not a successful refresh.

Record the pre-release code commit and last good snapshot commit before deployment. If code regresses, revert the maintenance commit through a reviewed PR. If a generated snapshot is wrong, pause the crawler, review a compensating commit based on the last good snapshot, and preserve any subsequent legitimate additions to `domains.txt`; never force-push or reset main. Validate the replacement snapshot and coverage before publishing. Re-enable with `gh workflow enable nightly-crawl.yml --repo ArcedeDev/open-402` only after a dry run passes.

After a full production run, check `registry/snapshot.json` on main: its generation time must belong to that crawl, its totals must match the entries, and expected listing upgrades must be present. Confirm the required reconciliation receipt matches the published revision and reports zero errors and unattempted entries. A sync-only retry preserves the original snapshot generation time. A green badge without matching publication and reconciliation evidence is not confirmation of recovery.

Registry PR checks run with read-only permissions and no secrets. Repository maintainers must require passing checks before merging; adding the workflow does not itself configure branch protection.
