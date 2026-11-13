import { addressKey, isNanoClaim, isValidClaimAddress, isVerifierSupported, type AddressVerificationRecord } from "./verification-model.ts";
import type { IncrementalVerificationResult, verifyAddressesIncremental } from "../watchers/onchain-verifier.ts";

export async function runAddressVerificationQueue(
  records: Map<string, AddressVerificationRecord>,
  options: {
    limit: number;
    concurrency: number;
    verify: typeof verifyAddressesIncremental;
    /**
     * Verifier for x402 / nano:mainnet / XNO claims. Without it those addresses are not
     * selected, so a caller that only passes `verify` behaves exactly as before.
     */
    verifyNano?: typeof verifyAddressesIncremental;
    now?: () => string;
  }
): Promise<{ eligible: number; attempted: number; completed: number; failed: number }> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 5) {
    throw new Error("Address scan limit must be an integer from 1 to 5");
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 100) {
    throw new Error("Concurrency must be an integer from 1 to 100");
  }
  const now = options.now ?? (() => new Date().toISOString());
  const attemptedAt = now();
  const attemptedTime = Date.parse(attemptedAt);
  if (!Number.isFinite(attemptedTime)) throw new Error("Invalid scan attempt time");
  const attemptTime = (record: AddressVerificationRecord) => {
    const time = Date.parse(record.last_scan_attempt_at ?? "");
    return Number.isFinite(time) && time <= attemptedTime ? time : -Infinity;
  };
  const candidates = Array.from(records.values())
    .filter((record) => isVerifierSupported(record.protocol, record.network, record.asset)
      && (!isNanoClaim(record.protocol, record.network, record.asset) || options.verifyNano !== undefined)
      && isValidClaimAddress(record))
    .sort((a, b) => Number(b.last_scan_error === "budget_deferred") - Number(a.last_scan_error === "budget_deferred")
      || attemptTime(a) - attemptTime(b)
      || (a.last_scanned_block ?? -1) - (b.last_scanned_block ?? -1)
      || addressKey(a).localeCompare(addressKey(b)));
  const queued = candidates.slice(0, options.limit);
  const summary = { eligible: candidates.length, attempted: queued.length, completed: 0, failed: 0 };
  if (!queued.length) return summary;

  // Persist attempts before provider work so failures rotate out of the next batch.
  for (const record of queued) {
    records.set(addressKey(record), { ...record, last_scan_attempt_at: attemptedAt, last_scan_error: "scan_not_completed" });
  }
  const fail = (record: AddressVerificationRecord, error: string) => {
    records.set(addressKey(record), { ...record, last_scan_attempt_at: attemptedAt, last_scan_error: error });
    summary.failed++;
  };

  const toInput = (record: AddressVerificationRecord) => ({
    address: record.address,
    lastScannedBlock: record.last_scanned_block,
    priorTotals: {
      totalTransactions: record.tx_count,
      totalVolumeUsdc: record.volume_usd,
      firstTxTimestamp: record.first_tx,
      lastTxTimestamp: record.last_tx,
      lastTxHash: record.last_tx_hash,
      firstVerifiedAt: record.first_verified_at,
      lastVerifiedAt: record.last_verified_at,
    },
  });
  // One verifier per network family. A group whose verifier throws or answers something invalid
  // fails alone, so a Nano node outage cannot cost a Base address its scan, or the reverse.
  const isNano = (record: AddressVerificationRecord) => isNanoClaim(record.protocol, record.network, record.asset);
  const groups: Array<{ records: AddressVerificationRecord[]; verify: typeof verifyAddressesIncremental }> = [
    { records: queued.filter((record) => !isNano(record)), verify: options.verify },
    ...(options.verifyNano ? [{ records: queued.filter(isNano), verify: options.verifyNano }] : []),
  ].filter((group) => group.records.length > 0);
  const resultFor = new Map<AddressVerificationRecord, IncrementalVerificationResult | undefined>();
  for (const group of groups) {
    let groupResults: Awaited<ReturnType<typeof verifyAddressesIncremental>>;
    try {
      groupResults = await group.verify(group.records.map(toInput), options.concurrency);
    } catch {
      for (const record of group.records) fail(record, "verifier_failed");
      continue;
    }
    const expectedAddresses = new Set(group.records.map((record) => record.address.toLowerCase()));
    if (!(groupResults instanceof Map) || [...groupResults.keys()].some((key) => !expectedAddresses.has(key))) {
      for (const record of group.records) fail(record, "invalid_result");
      continue;
    }
    for (const record of group.records) resultFor.set(record, groupResults.get(record.address.toLowerCase()));
  }
  if (!resultFor.size) return summary;
  const completedAt = now();
  const completedTime = Date.parse(completedAt);
  for (const record of queued) {
    if (!resultFor.has(record)) continue; // its group already failed
    const result = resultFor.get(record);
    if (!result) { fail(record, "missing_result"); continue; }
    if (typeof result.address !== "string") { fail(record, "invalid_result"); continue; }
    if (result.address.toLowerCase() !== record.address.toLowerCase()) { fail(record, "result_mismatch"); continue; }
    if (result.scanComplete === false) { fail(record, result.scanError ?? "incomplete_scan"); continue; }
    if (result.verificationState === "invalid") { fail(record, "invalid_address"); continue; }
    if (result.scanComplete !== true || !Number.isFinite(completedTime) || completedTime < attemptedTime
      || typeof result.lastScannedBlock !== "number" || !Number.isSafeInteger(result.lastScannedBlock) || result.lastScannedBlock < 0
      || result.lastScannedBlock < (record.last_scanned_block ?? 0)
      || !Number.isSafeInteger(result.totalTransactions) || result.totalTransactions < 0 || result.totalTransactions < record.tx_count
      || !Number.isFinite(result.totalVolumeUsdc) || result.totalVolumeUsdc < 0 || result.totalVolumeUsdc < record.volume_usd
      || result.verificationState !== (result.totalTransactions > 0 ? "verified" : "unverified") || result.scanError) {
      fail(record, "invalid_result");
      continue;
    }
    records.set(addressKey(record), {
      ...record,
      verification_state: result.verificationState,
      verification_method: isNano(record) ? "nano_account_receive_scan" : "base_usdc_transfer_scan",
      tx_count: result.totalTransactions,
      volume_usd: result.totalVolumeUsdc,
      first_tx: result.firstTxTimestamp ?? record.first_tx,
      last_tx: result.lastTxTimestamp ?? record.last_tx,
      last_tx_hash: result.lastTxHash ?? record.last_tx_hash,
      first_verified_at: record.first_verified_at ?? result.firstVerifiedAt,
      last_verified_at: result.lastVerifiedAt ?? record.last_verified_at,
      last_scanned_block: result.lastScannedBlock,
      last_scan_attempt_at: attemptedAt,
      last_scan_complete_at: completedAt,
      last_scan_error: null,
    });
    summary.completed++;
  }
  return summary;
}
