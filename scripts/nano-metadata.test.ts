import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { validateManifest } from "./lib/manifest.ts";
import {
  buildManifestClaims,
  buildVerificationStats,
  isVerifierSupported,
  materializeEntryVerification,
  seedAddressVerifications,
} from "./lib/verification-model.ts";

process.env.GITHUB_TOKEN = "offline-test-token";
const { crawlAll } = await import("./crawl.ts");

// Read-only snapshot of a real provider's public manifest; see fixtures/nano/README.md.
const FIXTURE_SHA256 = "b8bbb94f8f7af0fae5bbc2fc3195ab64f975b527a26cdd3b5887aafe4f58e6bd";
const domain = "extract.paypercall.dev";
const raw = readFileSync(new URL("./fixtures/nano/extract.paypercall.dev.agent.json", import.meta.url));
const load = (): Record<string, any> => JSON.parse(raw.toString("utf8"));
const row = { domain, status: "unclaimed" as const, source: "self", added_date: "2026-09-25" };
const now = () => new Date("2026-10-04T02:35:43Z");

async function index(manifest: unknown) {
  const [entry] = await crawlAll([row], new Map(), { crawl: async () => validateManifest(manifest, domain), now });
  return entry;
}

test("Nano fixture is the unmodified dated snapshot", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), FIXTURE_SHA256);
});

test("real provider manifest declaring nano:mainnet/XNO passes manifest validation", () => {
  const manifest = load();
  const result = validateManifest(manifest, domain);
  assert.equal(result.success, true);
  assert.deepEqual(manifest.payments, {
    x402: { recipient: manifest.payout_address, networks: [{ network: "nano:mainnet", asset: "XNO" }] },
  });
});

test("provider-declared Nano metadata survives claim building as an unsupported claim", () => {
  const manifest = load();
  const claims = buildManifestClaims(manifest, "2026-10-04", "2026-10-04T02:35:43.000Z");
  assert.equal(claims.length, 1);
  assert.deepEqual(claims[0], {
    protocol: "x402",
    network: "nano:mainnet",
    asset: "XNO",
    address: manifest.payout_address,
    claim_source: "manifest",
    source_detail: "manifest.payments.x402.networks",
    confidence: "authoritative",
    first_seen: "2026-10-04",
    last_seen: "2026-10-04T02:35:43.000Z",
    verification_state: "unsupported",
    verification_method: null,
    evidence: null,
  });
  assert.equal(isVerifierSupported(claims[0].protocol, claims[0].network, claims[0].asset), false);
});

test("provider-declared Nano metadata survives indexing without any verification evidence", async () => {
  const entry = await index(load());
  assert.equal(entry.status, "verified"); // registry status: a valid agent.json is served
  assert.equal(entry.version, "1.3");
  assert.equal(entry.intent_count, 14);
  assert.deepEqual(entry.protocols, ["x402"]);
  assert.deepEqual(entry.networks, ["nano:mainnet"]);
  assert.deepEqual(entry.assets, ["XNO"]);
  assert.ok(entry.intents.every((intent) => intent.price === null));

  const records = seedAddressVerifications(entry.claims, new Map());
  const { claims, verification } = materializeEntryVerification(entry.claims, records, new Map());
  assert.equal(claims.length, 1);
  assert.equal(claims[0].verification_state, "unsupported");
  assert.equal(claims[0].verification_method, null);
  assert.equal(claims[0].evidence, null);
  assert.equal(verification.domain_state, "authoritative_unverified");

  const stats = buildVerificationStats([{ domain, claims, verification }], records);
  assert.equal(stats.domains_with_authoritative_claims, 1);
  assert.equal(stats.domains_with_verified_claims, 0);
  assert.equal(stats.verified_addresses, 0);
  assert.equal(stats.unsupported_claims, 1);
});

test("Nano manifest without a payout address fails validation and builds no claim", async () => {
  for (const payout_address of [undefined, ""]) {
    const manifest = { ...load(), payout_address };
    if (payout_address === undefined) delete manifest.payout_address;
    assert.deepEqual(validateManifest(manifest, domain), { success: false, error: "invalid_manifest" });
    assert.deepEqual(buildManifestClaims(manifest, "2026-10-04", "2026-10-04"), []);
    const entry = await index(manifest);
    assert.equal(entry.status, "unclaimed");
    assert.deepEqual([entry.protocols, entry.networks, entry.assets, entry.claims], [[], [], [], []]);
  }
});

test("Nano manifest served from another origin or with malformed networks is rejected", () => {
  assert.equal(validateManifest(load(), "check.paypercall.dev").success, false);
  const malformed = load();
  malformed.payments.x402.networks = [null];
  assert.equal(validateManifest(malformed, domain).success, false);
  const noAsset = load();
  noAsset.payments.x402.networks = [{ network: "nano:mainnet" }];
  assert.deepEqual(validateManifest(noAsset, domain), { success: false, error: "invalid_manifest" });
});

test("flat network/asset declaration is valid but does not carry Nano metadata into the claim", async () => {
  const manifest = load();
  manifest.payments = { x402: { recipient: manifest.payout_address, network: "nano:mainnet", asset: "XNO" } };
  assert.equal(validateManifest(manifest, domain).success, true);
  const entry = await index(manifest);
  assert.deepEqual([entry.claims[0].network, entry.claims[0].asset], ["unknown", "UNKNOWN"]);
  assert.equal(entry.claims[0].verification_state, "unsupported");
  assert.equal(entry.networks.includes("nano:mainnet"), false);
});
