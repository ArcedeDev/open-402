import type { PaymentEvent } from "../watchers/types.ts";

export type ClaimSource = "manifest" | "watcher";
export type ClaimConfidence = "authoritative" | "observed";
export type VerificationState =
  | "verified"
  | "pending"
  | "unverified"
  | "observed"
  | "unsupported"
  | "invalid"
  | "incomplete";
export type VerificationMethod = "base_usdc_transfer_scan" | "watcher_observation" | null;
export type DomainVerificationState =
  | "authoritative_verified"
  | "authoritative_unverified"
  | "observed_verified"
  | "observed_only"
  | "no_claim";

export interface ClaimEvidence {
  tx_count: number;
  volume_usd: number;
  first_tx: string | null;
  last_tx: string | null;
  last_tx_hash: string | null;
  verified_at: string | null;
}

export interface Claim {
  protocol: string;
  network: string;
  asset: string;
  address: string;
  claim_source: ClaimSource;
  source_detail: string;
  confidence: ClaimConfidence;
  first_seen: string;
  last_seen: string;
  verification_state: VerificationState;
  verification_method: VerificationMethod;
  evidence: ClaimEvidence | null;
}

export interface VerificationSummary {
  domain_state: DomainVerificationState;
  canonical_claim_index: number | null;
  shared_domain_count: number;
}

export interface AddressVerificationRecord {
  protocol: string;
  network: string;
  asset: string;
  address: string;
  verification_state: VerificationState;
  verification_method: VerificationMethod;
  tx_count: number;
  volume_usd: number;
  first_tx: string | null;
  last_tx: string | null;
  last_tx_hash: string | null;
  first_verified_at: string | null;
  last_verified_at: string | null;
  last_scanned_block: number | null;
}

export interface VerificationStats {
  domains_with_authoritative_claims: number;
  domains_with_observed_claims: number;
  domains_with_verified_claims: number;
  domains_with_observed_verified_claims: number;
  domains_with_no_claims: number;
  unique_addresses: number;
  verified_addresses: number;
  unsupported_claims: number;
  invalid_claims: number;
}

export interface EntryLike {
  domain: string;
  claims: Claim[];
  verification: VerificationSummary;
}

const SUPPORTED_PROTOCOL = "x402";
const SUPPORTED_NETWORK = "base";
const SUPPORTED_ASSET = "USDC";

const BLOCKED_EVM_ADDRESSES = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
]);

function normalizeProtocol(value: string | null | undefined): string {
  return (value || "unknown").trim().toLowerCase() || "unknown";
}

function normalizeNetwork(value: string | null | undefined): string {
  return (value || "unknown").trim().toLowerCase() || "unknown";
}

function normalizeAsset(value: string | null | undefined): string {
  return (value || "unknown").trim().toUpperCase() || "UNKNOWN";
}

function normalizeAddress(value: string | null | undefined): string {
  return (value || "").trim();
}

function readIsoMax(a: string, b: string): string {
  return a >= b ? a : b;
}

function readIsoMin(a: string, b: string): string {
  return a <= b ? a : b;
}

export function isValidEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address) && !BLOCKED_EVM_ADDRESSES.has(address.toLowerCase());
}

export function isVerifierSupported(protocol: string, network: string, asset: string): boolean {
  return normalizeProtocol(protocol) === SUPPORTED_PROTOCOL
    && normalizeNetwork(network) === SUPPORTED_NETWORK
    && normalizeAsset(asset) === SUPPORTED_ASSET;
}

export function claimKey(claim: Pick<Claim, "protocol" | "network" | "asset" | "address" | "claim_source">): string {
  return [
    normalizeProtocol(claim.protocol),
    normalizeNetwork(claim.network),
    normalizeAsset(claim.asset),
    normalizeAddress(claim.address).toLowerCase(),
    claim.claim_source,
  ].join("|");
}

export function addressKey(
  value: Pick<Claim, "protocol" | "network" | "asset" | "address">
    | Pick<AddressVerificationRecord, "protocol" | "network" | "asset" | "address">
): string {
  return [
    normalizeProtocol(value.protocol),
    normalizeNetwork(value.network),
    normalizeAsset(value.asset),
    normalizeAddress(value.address).toLowerCase(),
  ].join("|");
}

function baseClaim(
  params: Omit<Claim, "verification_state" | "verification_method" | "evidence">
): Claim {
  const claim: Claim = {
    ...params,
    protocol: normalizeProtocol(params.protocol),
    network: normalizeNetwork(params.network),
    asset: normalizeAsset(params.asset),
    address: normalizeAddress(params.address),
    verification_state: "unsupported",
    verification_method: null,
    evidence: null,
  };

  if (!claim.address) {
    claim.verification_state = claim.claim_source === "watcher" ? "observed" : "unsupported";
    if (claim.claim_source === "watcher") claim.verification_method = "watcher_observation";
    return claim;
  }

  if (isVerifierSupported(claim.protocol, claim.network, claim.asset)) {
    claim.verification_state = isValidEvmAddress(claim.address) ? "pending" : "invalid";
    return claim;
  }

  if (claim.claim_source === "watcher") {
    claim.verification_state = "unsupported";
    claim.verification_method = "watcher_observation";
    return claim;
  }

  claim.verification_state = "unsupported";
  return claim;
}

function deriveManifestPaymentTarget(manifest: Record<string, unknown>): {
  protocol: string;
  network: string;
  asset: string;
  source_detail: string;
} {
  const payments = manifest.payments as Record<string, Record<string, unknown>> | undefined;
  const candidates: Array<{ protocol: string; network: string; asset: string; source_detail: string }> = [];

  if (payments && typeof payments === "object") {
    for (const [protocol, config] of Object.entries(payments)) {
      const normalizedProtocol = normalizeProtocol(protocol);
      const networks = Array.isArray(config?.networks) ? config.networks as Record<string, unknown>[] : [];
      if (networks.length === 0) {
        candidates.push({
          protocol: normalizedProtocol,
          network: "unknown",
          asset: "unknown",
          source_detail: `manifest.payments.${normalizedProtocol}`,
        });
      }
      for (const networkConfig of networks) {
        candidates.push({
          protocol: normalizedProtocol,
          network: normalizeNetwork(typeof networkConfig.network === "string" ? networkConfig.network : "unknown"),
          asset: normalizeAsset(typeof networkConfig.asset === "string" ? networkConfig.asset : "unknown"),
          source_detail: `manifest.payments.${normalizedProtocol}.networks`,
        });
      }
    }
  }

  const legacyX402 = manifest.x402 as Record<string, unknown> | undefined;
  if (legacyX402 && typeof legacyX402 === "object" && legacyX402.supported) {
    const legacyNetworks = Array.isArray(legacyX402.networks) ? legacyX402.networks as Record<string, unknown>[] : [];
    if (legacyNetworks.length === 0) {
      candidates.push({
        protocol: "x402",
        network: "unknown",
        asset: "unknown",
        source_detail: "manifest.x402",
      });
    }
    for (const networkConfig of legacyNetworks) {
      candidates.push({
        protocol: "x402",
        network: normalizeNetwork(typeof networkConfig.network === "string" ? networkConfig.network : "unknown"),
        asset: normalizeAsset(typeof networkConfig.asset === "string" ? networkConfig.asset : "unknown"),
        source_detail: "manifest.x402.networks",
      });
    }
  }

  const preferred = candidates.find((candidate) =>
    isVerifierSupported(candidate.protocol, candidate.network, candidate.asset)
  );
  if (preferred) return preferred;

  return candidates[0] || {
    protocol: "unknown",
    network: "unknown",
    asset: "unknown",
    source_detail: "manifest.payout_address",
  };
}

export function buildManifestClaims(
  manifest: Record<string, unknown>,
  firstSeen: string,
  lastSeen: string
): Claim[] {
  const payoutAddress = typeof manifest.payout_address === "string" ? manifest.payout_address : "";
  if (!payoutAddress.trim()) return [];

  const target = deriveManifestPaymentTarget(manifest);
  return [
    baseClaim({
      protocol: target.protocol,
      network: target.network,
      asset: target.asset,
      address: payoutAddress,
      claim_source: "manifest",
      source_detail: target.source_detail,
      confidence: "authoritative",
      first_seen: firstSeen,
      last_seen: lastSeen,
    }),
  ];
}

export function buildLegacyClaimsFromEntry(entry: {
  first_seen: string;
  last_crawled: string;
  payout_address?: string | null;
  protocols?: string[];
  networks?: string[];
  assets?: string[];
  source?: string;
  onchain?: {
    verified: boolean;
    total_transactions: number;
    total_volume_usdc: number;
    first_tx: string | null;
    last_tx: string | null;
    last_tx_hash: string | null;
    verified_at: string;
  };
}): Claim[] {
  const payoutAddress = normalizeAddress(entry.payout_address || "");
  if (!payoutAddress) return [];

  const protocol = normalizeProtocol(entry.protocols?.[0] || "unknown");
  const network = normalizeNetwork(entry.networks?.[0] || "unknown");
  const asset = normalizeAsset(entry.assets?.[0] || "unknown");

  const claim = baseClaim({
    protocol,
    network,
    asset,
    address: payoutAddress,
    claim_source: "manifest",
    source_detail: entry.source || "legacy_snapshot",
    confidence: "authoritative",
    first_seen: entry.first_seen,
    last_seen: entry.last_crawled,
  });

  if (entry.onchain) {
    claim.verification_state = entry.onchain.verified ? "verified" : "unverified";
    claim.verification_method = isVerifierSupported(protocol, network, asset) ? "base_usdc_transfer_scan" : null;
    claim.evidence = entry.onchain.verified ? {
      tx_count: entry.onchain.total_transactions,
      volume_usd: entry.onchain.total_volume_usdc,
      first_tx: entry.onchain.first_tx,
      last_tx: entry.onchain.last_tx,
      last_tx_hash: entry.onchain.last_tx_hash,
      verified_at: entry.onchain.verified_at,
    } : null;
  }

  return [claim];
}

export function buildWatcherClaims(
  domain: string,
  events: PaymentEvent[],
  existingFirstSeen: string,
  lastSeen: string
): Claim[] {
  const claims = new Map<string, Claim>();

  for (const event of events) {
    // Callers may pass pre-filtered events for this domain, or the full list.
    // Skip events that don't match either way.
    if (event.domain !== domain) continue;
    const address = normalizeAddress(event.sellerAddress);
    if (!address) continue;

    const claim = baseClaim({
      protocol: normalizeProtocol(event.protocol),
      network: normalizeNetwork(event.network),
      asset: normalizeAsset(event.asset),
      address,
      claim_source: "watcher",
      source_detail: `watcher:${normalizeProtocol(event.protocol)}`,
      confidence: "observed",
      first_seen: existingFirstSeen,
      last_seen: lastSeen,
    });

    claims.set(claimKey(claim), claim);
  }

  return Array.from(claims.values());
}

export function mergeClaims(existingClaims: Claim[], nextClaims: Claim[]): Claim[] {
  const merged = new Map<string, Claim>();

  for (const claim of existingClaims) {
    merged.set(claimKey(claim), { ...claim, evidence: claim.evidence ? { ...claim.evidence } : null });
  }

  for (const claim of nextClaims) {
    const key = claimKey(claim);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...claim });
      continue;
    }

    merged.set(key, {
      ...existing,
      ...claim,
      first_seen: readIsoMin(existing.first_seen, claim.first_seen),
      last_seen: readIsoMax(existing.last_seen, claim.last_seen),
      evidence: existing.evidence,
    });
  }

  return Array.from(merged.values());
}

function compareClaims(a: Claim, b: Claim): number {
  const sourceRank = (claim: Claim) => (claim.claim_source === "manifest" ? 0 : 1);
  const stateRank = (claim: Claim) => ({
    verified: 0,
    pending: 1,
    unverified: 2,
    incomplete: 3,
    observed: 4,
    unsupported: 5,
    invalid: 6,
  }[claim.verification_state]);
  const supportedRank = (claim: Claim) => (isVerifierSupported(claim.protocol, claim.network, claim.asset) ? 0 : 1);

  return (
    sourceRank(a) - sourceRank(b)
    || stateRank(a) - stateRank(b)
    || supportedRank(a) - supportedRank(b)
    || (a.last_seen < b.last_seen ? 1 : a.last_seen > b.last_seen ? -1 : 0)
    || a.address.localeCompare(b.address)
  );
}

export function seedAddressVerifications(
  claims: Claim[],
  existing: Map<string, AddressVerificationRecord>
): Map<string, AddressVerificationRecord> {
  const merged = new Map<string, AddressVerificationRecord>();

  for (const record of existing.values()) {
    merged.set(addressKey(record), { ...record });
  }

  for (const claim of claims) {
    if (!claim.address) continue;
    const key = addressKey(claim);
    const existingRecord = merged.get(key);
    if (existingRecord) continue;

    merged.set(key, {
      protocol: claim.protocol,
      network: claim.network,
      asset: claim.asset,
      address: claim.address,
      verification_state: claim.verification_state,
      verification_method: claim.verification_method,
      tx_count: claim.evidence?.tx_count || 0,
      volume_usd: claim.evidence?.volume_usd || 0,
      first_tx: claim.evidence?.first_tx || null,
      last_tx: claim.evidence?.last_tx || null,
      last_tx_hash: claim.evidence?.last_tx_hash || null,
      first_verified_at: claim.evidence?.verified_at || null,
      last_verified_at: claim.evidence?.verified_at || null,
      last_scanned_block: null,
    });
  }

  return merged;
}

export function materializeEntryVerification(
  claims: Claim[],
  addressVerifications: Map<string, AddressVerificationRecord>,
  sharedDomainCounts: Map<string, number>
): { claims: Claim[]; verification: VerificationSummary } {
  const materializedClaims = claims
    .map((claim) => {
      const record = addressVerifications.get(addressKey(claim));
      if (!record) return { ...claim };
      return {
        ...claim,
        verification_state: record.verification_state,
        verification_method: record.verification_method,
        evidence: record.verification_state === "verified" ? {
          tx_count: record.tx_count,
          volume_usd: record.volume_usd,
          first_tx: record.first_tx,
          last_tx: record.last_tx,
          last_tx_hash: record.last_tx_hash,
          verified_at: record.last_verified_at,
        } : null,
      };
    })
    .sort(compareClaims);

  if (materializedClaims.length === 0) {
    return {
      claims: [],
      verification: {
        domain_state: "no_claim",
        canonical_claim_index: null,
        shared_domain_count: 0,
      },
    };
  }

  const hasManifestClaims = materializedClaims.some((claim) => claim.claim_source === "manifest");
  const hasManifestVerified = materializedClaims.some(
    (claim) => claim.claim_source === "manifest" && claim.verification_state === "verified"
  );
  const hasWatcherVerified = materializedClaims.some(
    (claim) => claim.claim_source === "watcher" && claim.verification_state === "verified"
  );

  const canonical = materializedClaims[0];
  const sharedDomainCount = sharedDomainCounts.get(addressKey(canonical)) || 1;

  return {
    claims: materializedClaims,
    verification: {
      domain_state:
        hasManifestVerified ? "authoritative_verified"
          : hasManifestClaims ? "authoritative_unverified"
            : hasWatcherVerified ? "observed_verified"
              : "observed_only",
      canonical_claim_index: 0,
      shared_domain_count: sharedDomainCount,
    },
  };
}

export function buildVerificationStats(
  entries: EntryLike[],
  addressVerifications: Map<string, AddressVerificationRecord>
): VerificationStats {
  const allClaims = entries.flatMap((entry) => entry.claims);
  return {
    domains_with_authoritative_claims: entries.filter((entry) => entry.claims.some((claim) => claim.claim_source === "manifest")).length,
    domains_with_observed_claims: entries.filter((entry) => entry.claims.some((claim) => claim.claim_source === "watcher")).length,
    domains_with_verified_claims: entries.filter((entry) => entry.claims.some((claim) => claim.verification_state === "verified")).length,
    domains_with_observed_verified_claims: entries.filter((entry) => entry.verification.domain_state === "observed_verified").length,
    domains_with_no_claims: entries.filter((entry) => entry.verification.domain_state === "no_claim").length,
    unique_addresses: addressVerifications.size,
    verified_addresses: Array.from(addressVerifications.values()).filter((record) => record.verification_state === "verified").length,
    unsupported_claims: allClaims.filter((claim) => claim.verification_state === "unsupported").length,
    invalid_claims: allClaims.filter((claim) => claim.verification_state === "invalid").length,
  };
}
