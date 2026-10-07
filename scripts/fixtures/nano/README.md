# Nano metadata fixture

`extract.paypercall.dev.agent.json` is a read-only, byte-for-byte copy of the
public manifest served at `https://extract.paypercall.dev/.well-known/agent.json`.

- Fetched: 2026-10-04T02:35:43Z (HTTP 200, `content-type: application/json`, 7636 bytes)
- SHA-256: `b8bbb94f8f7af0fae5bbc2fc3195ab64f975b527a26cdd3b5887aafe4f58e6bd`
- Validator: `agent-json-validate@1.4.0` reports `Valid agent.json (Tier 2)`, no errors, no warnings

The provider regenerates the manifest on each request (`x-updated` changes), so
this file is a dated snapshot and is not kept in sync with the live domain.
Do not edit it; `scripts/nano-metadata.test.ts` checks the hash.

## What the fixture is used for

`scripts/nano-metadata.test.ts` runs the snapshot through manifest validation,
claim building and snapshot-entry extraction, offline, and checks that the
provider-declared `x402` / `nano:mainnet` / `XNO` metadata is retained.

## What it does not show

- It is provider-declared metadata only. The claim built from it is
  `unsupported` with no verification method and no evidence, because the
  independent verifier supports x402/Base/USDC only.
- It does not show that any payment was made, that the domain controls the
  declared account, or that any API request was settled.
- It does not standardise Nano as an HTTP payment protocol.
- Per-intent XNO prices are carried in the provider's own `x-price` extension
  field, because `price.currency` in the validator accepts `USD` and `USDC`
  only. The indexer does not read `x-price`, so indexed intents have
  `price: null`.
