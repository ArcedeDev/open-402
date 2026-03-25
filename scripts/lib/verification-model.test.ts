import test from "node:test";
import assert from "node:assert/strict";

import {
  addressKey,
  buildLegacyClaimsFromEntry,
  buildManifestClaims,
  buildVerificationStats,
  buildWatcherClaims,
  materializeEntryVerification,
  mergeClaims,
  seedAddressVerifications,
  type AddressVerificationRecord,
  type Claim,
} from "./verification-model.ts";

test("buildManifestClaims prefers x402/base/USDC and marks valid claims pending", () => {
  const claims = buildManifestClaims({
    payout_address: "0x1111111111111111111111111111111111111111",
    payments: {
      x402: {
        networks: [{ network: "base", asset: "USDC" }],
      },
      l402: {
        lightning_address: "alice@example.com",
      },
    },
  }, "2026-03-20", "2026-03-25T00:00:00.000Z");

  assert.equal(claims.length, 1);
  assert.equal(claims[0].protocol, "x402");
  assert.equal(claims[0].network, "base");
  assert.equal(claims[0].asset, "USDC");
  assert.equal(claims[0].verification_state, "pending");
});

test("buildWatcherClaims creates observed claims per address and ignores empties", () => {
  const claims = buildWatcherClaims("alpha.example", [
    {
      protocol: "mpp",
      resourceUrl: "https://alpha.example/api",
      domain: "alpha.example",
      sellerAddress: "acct_123",
      amount: "1",
      asset: "USD",
      network: "stripe",
      timestamp: "2026-03-25T00:00:00.000Z",
    },
    {
      protocol: "mpp",
      resourceUrl: "https://alpha.example/api",
      domain: "alpha.example",
      sellerAddress: "",
      amount: "1",
      asset: "USD",
      network: "stripe",
      timestamp: "2026-03-25T00:00:00.000Z",
    },
  ], "2026-03-20", "2026-03-25T00:00:00.000Z");

  assert.equal(claims.length, 1);
  assert.equal(claims[0].claim_source, "watcher");
  assert.equal(claims[0].verification_state, "unsupported");
  assert.equal(claims[0].verification_method, "watcher_observation");
});

test("materializeEntryVerification prefers authoritative verified claims", () => {
  const manifestClaim: Claim = {
    protocol: "x402",
    network: "base",
    asset: "USDC",
    address: "0x1111111111111111111111111111111111111111",
    claim_source: "manifest",
    source_detail: "manifest.payments.x402.networks",
    confidence: "authoritative",
    first_seen: "2026-03-20",
    last_seen: "2026-03-25T00:00:00.000Z",
    verification_state: "pending",
    verification_method: null,
    evidence: null,
  };
  const watcherClaim: Claim = {
    ...manifestClaim,
    claim_source: "watcher",
    confidence: "observed",
    source_detail: "watcher:x402",
    address: "0x2222222222222222222222222222222222222222",
  };

  const addressVerifications = new Map<string, AddressVerificationRecord>([
    [addressKey(manifestClaim), {
      protocol: manifestClaim.protocol,
      network: manifestClaim.network,
      asset: manifestClaim.asset,
      address: manifestClaim.address,
      verification_state: "verified",
      verification_method: "base_usdc_transfer_scan",
      tx_count: 5,
      volume_usd: 2.5,
      first_tx: "2026-03-21T00:00:00.000Z",
      last_tx: "2026-03-24T00:00:00.000Z",
      last_tx_hash: "0xabc",
      first_verified_at: "2026-03-24T00:00:00.000Z",
      last_verified_at: "2026-03-25T00:00:00.000Z",
      last_scanned_block: 123,
    }],
  ]);

  const materialized = materializeEntryVerification(
    [watcherClaim, manifestClaim],
    addressVerifications,
    new Map([[addressKey(manifestClaim), 2]])
  );

  assert.equal(materialized.verification.domain_state, "authoritative_verified");
  assert.equal(materialized.verification.canonical_claim_index, 0);
  assert.equal(materialized.verification.shared_domain_count, 2);
  assert.equal(materialized.claims[0].claim_source, "manifest");
  assert.equal(materialized.claims[0].verification_state, "verified");
  assert.equal(materialized.claims[0].evidence?.tx_count, 5);
});

test("mergeClaims preserves first_seen and refreshes last_seen", () => {
  const existing = buildLegacyClaimsFromEntry({
    first_seen: "2026-03-20",
    last_crawled: "2026-03-21T00:00:00.000Z",
    payout_address: "0x1111111111111111111111111111111111111111",
    protocols: ["x402"],
    networks: ["base"],
    assets: ["USDC"],
  });
  const next = buildManifestClaims({
    payout_address: "0x1111111111111111111111111111111111111111",
    payments: {
      x402: { networks: [{ network: "base", asset: "USDC" }] },
    },
  }, "2026-03-25", "2026-03-25T00:00:00.000Z");

  const merged = mergeClaims(existing, next);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].first_seen, "2026-03-20");
  assert.equal(merged[0].last_seen, "2026-03-25T00:00:00.000Z");
});

test("seedAddressVerifications dedupes shared addresses across domains", () => {
  const claims = [
    ...buildManifestClaims({
      payout_address: "0x1111111111111111111111111111111111111111",
      payments: { x402: { networks: [{ network: "base", asset: "USDC" }] } },
    }, "2026-03-20", "2026-03-25T00:00:00.000Z"),
    ...buildManifestClaims({
      payout_address: "0x1111111111111111111111111111111111111111",
      payments: { x402: { networks: [{ network: "base", asset: "USDC" }] } },
    }, "2026-03-21", "2026-03-25T00:00:00.000Z"),
  ];

  const addressVerifications = seedAddressVerifications(claims, new Map());
  assert.equal(addressVerifications.size, 1);
});

test("buildVerificationStats counts authoritative, observed, and no-claim domains", () => {
  const manifestClaims = buildManifestClaims({
    payout_address: "0x1111111111111111111111111111111111111111",
    payments: { x402: { networks: [{ network: "base", asset: "USDC" }] } },
  }, "2026-03-20", "2026-03-25T00:00:00.000Z");
  const watcherClaims = buildWatcherClaims("watcher.example", [{
    protocol: "mpp",
    resourceUrl: "https://watcher.example/api",
    domain: "watcher.example",
    sellerAddress: "acct_123",
    amount: "1",
    asset: "USD",
    network: "stripe",
    timestamp: "2026-03-25T00:00:00.000Z",
  }], "2026-03-20", "2026-03-25T00:00:00.000Z");

  const manifestMaterialized = materializeEntryVerification(manifestClaims, seedAddressVerifications(manifestClaims, new Map()), new Map());
  const watcherMaterialized = materializeEntryVerification(watcherClaims, seedAddressVerifications(watcherClaims, new Map()), new Map());
  const noClaimMaterialized = materializeEntryVerification([], new Map(), new Map());

  const stats = buildVerificationStats([
    { domain: "manifest.example", ...manifestMaterialized },
    { domain: "watcher.example", ...watcherMaterialized },
    { domain: "empty.example", ...noClaimMaterialized },
  ], seedAddressVerifications([...manifestClaims, ...watcherClaims], new Map()));

  assert.equal(stats.domains_with_authoritative_claims, 1);
  assert.equal(stats.domains_with_observed_claims, 1);
  assert.equal(stats.domains_with_no_claims, 1);
  assert.equal(stats.unique_addresses, 2);
});

test("materializeEntryVerification marks watcher-only verified domains as observed_verified", () => {
  const watcherClaims = buildWatcherClaims("watcher.example", [{
    protocol: "x402",
    resourceUrl: "https://watcher.example/pay",
    domain: "watcher.example",
    sellerAddress: "0x3333333333333333333333333333333333333333",
    amount: "1",
    asset: "USDC",
    network: "base",
    timestamp: "2026-03-25T00:00:00.000Z",
  }], "2026-03-20", "2026-03-25T00:00:00.000Z");

  const addressVerifications = seedAddressVerifications(watcherClaims, new Map());
  const key = addressKey(watcherClaims[0]);
  const existing = addressVerifications.get(key);
  assert.ok(existing);
  addressVerifications.set(key, {
    ...existing,
    verification_state: "verified",
    verification_method: "base_usdc_transfer_scan",
    tx_count: 2,
    volume_usd: 4.2,
    first_tx: "2026-03-21T00:00:00.000Z",
    last_tx: "2026-03-24T00:00:00.000Z",
    last_tx_hash: "0xdef",
    first_verified_at: "2026-03-24T00:00:00.000Z",
    last_verified_at: "2026-03-25T00:00:00.000Z",
    last_scanned_block: 456,
  });

  const materialized = materializeEntryVerification(
    watcherClaims,
    addressVerifications,
    new Map([[key, 1]])
  );

  assert.equal(materialized.verification.domain_state, "observed_verified");
  assert.equal(materialized.claims[0].verification_state, "verified");
});

test("materializeEntryVerification keeps manifest claims authoritative even when unverified", () => {
  const manifestClaims = buildManifestClaims({
    payout_address: "0x4444444444444444444444444444444444444444",
    payments: { x402: { networks: [{ network: "base", asset: "USDC" }] } },
  }, "2026-03-20", "2026-03-25T00:00:00.000Z");

  const materialized = materializeEntryVerification(
    manifestClaims,
    seedAddressVerifications(manifestClaims, new Map()),
    new Map([[addressKey(manifestClaims[0]), 1]])
  );

  assert.equal(materialized.verification.domain_state, "authoritative_unverified");
  assert.equal(materialized.claims[0].verification_state, "pending");
});
