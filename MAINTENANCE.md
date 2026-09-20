# Registry Maintenance

Use Node 24.14.0 or later. Install the lockfile with `npm ci --ignore-scripts`, then run `npm test` and `npm run check:registry`.

## Read-only validation

`node scripts/crawl.ts --dry-run --limit 90` checks a uniform sample of the local registry. Omit `--limit` for a full read-only manifest crawl. Dry runs never publish, discover additional domains, verify payment activity, or call the sync webhook. Partial runs are refused unless dry-run mode is explicit.

`node scripts/check-registry.ts --base <40-character-commit-sha> --live` validates changed rows and checks the manifests of newly verified listings. Unclaimed services still need manual evidence of a real public API. Manifest verification is not a security, payment, or service-quality endorsement.

## Publication

The nightly workflow uses a single publication concurrency group. It runs tests, crawls every target, verifies exact target coverage, atomically updates the registry and snapshot, then reads the published snapshot back. A registry addition/removal during a crawl aborts publication; rerun against the updated registry. The crawler retains previous data on ordinary endpoint failures under the existing failure-count policy.

Before shipping a crawler change, test 1% and 10% read-only samples. Request-outcome logs distinguish freshly validated manifests, failures by reason, newly failing previously healthy verified entries, and deadline overruns from retained snapshot statuses. The health gate refuses zero fresh manifests, any request taking over nine seconds (eight-second deadline plus one-second scheduling tolerance), or more than 1% proposed demotions. Missing results fail independently. Investigate unexpected private-address attempts and newly failing verified services before proceeding. Confirm a full production run finishes inside the 30-minute workflow budget. Inspect enrichment and sync warnings separately: successful snapshot publication does not guarantee successful downstream sync. Address verification is capped at 25 per run, prioritizing older scan cursors within the existing claim-priority classes; deferred evidence remains unchanged.

The workflow sets `MAX_ONCHAIN_ADDRESSES_PER_RUN=25`. Direct local production runs must set this explicitly; the legacy local default is unlimited. Prefer the workflow for production publication.

Every removal of an already-published domain requires an exact name in the manual workflow's `approved_removals` input (`APPROVED_REMOVALS` locally). Review the removal justification first. Bulk additions, edits and deletions all count toward the 100-change PR review limit.

## Stop and Recovery

Run `node scripts/pause-publication.ts --confirm` to disable the workflow first, enumerate and cancel all active/queued publishers, and wait until every run is terminal. The command prints the actual main commit after cancellation. If it fails, do not restore data: inspect the remaining runs. Cancellation cannot undo a Git ref update or downstream sync that already completed; inspect the snapshot, commit history and sync logs before restoring anything. A cancelled run is not a successful refresh.

Record the pre-release code commit and last good snapshot commit before deployment. If code regresses, revert the maintenance commit through a reviewed PR. If a generated snapshot is wrong, pause the crawler, review a compensating commit based on the last good snapshot, and preserve any subsequent legitimate additions to `domains.txt`; never force-push or reset main. Validate the replacement snapshot and coverage before publishing. Re-enable with `gh workflow enable nightly-crawl.yml --repo ArcedeDev/open-402` only after a dry run passes.

After a production run, check `registry/snapshot.json` on main: its generation time must belong to that run, its totals must match the entries, and expected listing upgrades must be present. Review the sync log separately. A green badge without this evidence is not confirmation of recovery.

Registry PR checks run with read-only permissions and no secrets. Repository maintainers must require passing checks before merging; adding the workflow does not itself configure branch protection.
