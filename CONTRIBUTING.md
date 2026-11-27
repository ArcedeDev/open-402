# Contributing to the Open 402 Directory

Thank you for your interest in contributing to the Open 402 Directory. This registry is a public good — every domain you add makes the 402 ecosystem more discoverable for everyone.

## Ways to contribute

### 1. Add a domain

The most common contribution. If you know of an API that accepts HTTP 402 payments, add it.

**Three ways to add a domain:**
- **Web form** — Submit instantly at [open402.directory](https://open402.directory)
- **GitHub Issue** — Use the [Add a domain](../../issues/new?template=add-domain.yml) template
- **Pull Request** — Fork and edit `domains.txt` directly (below)

**Before submitting via PR, check that:**

- [ ] The domain is a real, publicly accessible API (not a test or localhost URL)
- [ ] The domain isn't already in `registry/domains.txt`
- [ ] If marking as `verified`, the domain serves a valid `agent.json` at `/.well-known/agent.json`

The directory uses the pinned `agent-json-validate` package and additionally requires the manifest's `origin` to equal the registered domain, ignoring case. An ancestor domain is not enough: a listing for `api.example.com` must declare `"origin": "api.example.com"`, not `"example.com"`. A standalone validator pass does not override this directory policy. Use a supported schema version and the required manifest fields; do not substitute an application version or invent payment details. CI checks newly verified listings without executing paid requests.

**How to submit:**

1. Fork this repository
2. Add a line to `registry/domains.txt` following the format:

```
yourdomain.com | verified | submit | YYYY-MM-DD
```

or, if the domain doesn't host `agent.json` yet:

```
yourdomain.com | unclaimed | submit | YYYY-MM-DD
```

3. Open a pull request using the provided template

**Source values:**

| Value | When to use |
|-------|-------------|
| `self` | You own or operate the domain |
| `submit` | You're submitting someone else's domain via PR or the web form |
| `402index` | Seeded from the 402index.io aggregator |
| `onchain-x402` | Auto-discovered from on-chain x402 payment activity |

When in doubt, use `submit`.

**One domain per PR.** This keeps the review process fast and the git history clean.

**Automatic intake.** Every three hours a job lands one-row listing PRs without waiting for a maintainer. A PR qualifies when its only change is one row in `registry/domains.txt` (or, to upgrade an `unclaimed` listing to `verified`, that domain's row replaced), the source is `self` or `submit`, and the live check on the domain itself passes:

- a `verified` row needs a valid `/.well-known/agent.json`;
- an `unclaimed` row needs a valid `agent.json`, or an x402 challenge from the domain: an HTTP 402 whose JSON body or `PAYMENT-REQUIRED` header names an `x402Version` and at least one payment option in `accepts`, at the root or on one of the first three same-host resources your `/.well-known/x402` document lists. A resource that answers GET with 405 is asked once more with an empty JSON POST. A bare 402 page, or a discovery document on its own, is not enough.

The row is dated by when you opened the PR. An upgrade keeps the listing's original source and date. The row lands on `main` with you credited as a co-author, and the PR is closed with a note. A PR for a domain already listed is closed as a duplicate. Anything else gets a `needs-review` label and one comment explaining why: a failure that may be temporary (a timeout, a server error) is checked again automatically within a day, and any other failure is checked again when you push a fix.

### 2. Report a problem

- **Dead domain** — The API no longer exists or returns errors. [Open an issue](../../issues/new?template=report-domain.yml).
- **Malicious domain** — The listing is spam, phishing, or serving harmful content. [Open an issue](../../issues/new?template=report-domain.yml) with urgency noted.
- **Incorrect status** — A domain is marked `unclaimed` but actually hosts `agent.json`, or vice versa. [Open an issue](../../issues/new?template=report-domain.yml).

### 3. Improve documentation

Found a typo or unclear section in the README? PRs welcome. No issue required for documentation fixes.

## What we accept

| Submission | Accepted? |
|-----------|-----------|
| Real API domain that accepts 402 payments | Yes |
| Domain that hosts `agent.json` | Yes |
| Well-known API provider (OpenAI, Stripe, etc.) as `unclaimed` | Yes |
| Domain you own and want to list | Yes |
| Test/staging domains (`localhost`, `.local`, `.test`, `.example`) | No |
| Domains that don't serve an API | No |
| Duplicate of an existing entry | No |
| Bulk additions (100+ domains in one PR) | Contact maintainers first |

## What we don't accept

- **Modifications to `snapshot.json`** — This file is auto-generated. Changes will be overwritten on the next crawl. If you need to fix metadata, update the `agent.json` on the domain itself.
- **Removal of domains without justification** — Domains are removed only if they are confirmed dead (30+ days unreachable), malicious, or at the owner's request.
- **Changes to the `domains.txt` format** — The format is standardized. Propose format changes via an issue first.

## Pull request guidelines

1. **Use the PR template** — It exists for a reason. Fill out every field.
2. **One domain per PR** — Makes review fast and reverts clean.
3. **Use today's date** — The `added_date` field should be the date of your PR, not a past date.
4. **Alphabetical insertion is not required** — Append to the end of the file. The nightly crawl sorts the registry.
5. **Don't modify `snapshot.json`** — It's auto-generated.

## Review process

- PRs that add a `verified` domain with a valid `agent.json` are typically merged within 24 hours.
- PRs that add an `unclaimed` domain are reviewed manually to prevent spam. Allow 48 hours.
- If your PR is not reviewed within 72 hours, leave a comment — we may have missed it.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold these standards.

## Questions?

- Open a [discussion](../../discussions) or [issue](../../issues)
- Visit the [agent.json spec](https://agentinternetruntime.com/spec/agent-json) for format details
- Use the [generator](https://agentinternetruntime.com/spec/agent-json/generator) to create your `agent.json`
