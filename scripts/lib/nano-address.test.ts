import test from "node:test";
import assert from "node:assert/strict";
import { blake2b, hasValidNanoChecksum, nanoPublicKey } from "./nano-address.ts";
import { isValidClaimAddress, isValidNanoAddress } from "./verification-model.ts";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

// Reference digests computed independently with Python's hashlib.blake2b(digest_size=n).
test("blake2b matches RFC 7693 and the reference implementation", () => {
  assert.equal(
    hex(blake2b(new TextEncoder().encode("abc"), 64)),
    "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
  );
  assert.equal(hex(blake2b(new Uint8Array(0), 5)), "7d64c5272e");
  assert.equal(hex(blake2b(new Uint8Array(128), 5)), "cf900bc0c2");
  const twoBlocks = Uint8Array.from({ length: 200 }, (_, i) => i);
  assert.equal(hex(blake2b(twoBlocks, 32)), "63c3d97a9f8894d5e043a707b0fee7f7ec4c049a23bbf1079df20b4165f9e22d");
  assert.throws(() => blake2b(new Uint8Array(0), 0), RangeError);
  assert.throws(() => blake2b(new Uint8Array(0), 65), RangeError);
});

const ADDRESS = "nano_3m8cz87zwxb1y16ob4bzp1eyek78qaig8ktohk7d45b18sh6u9exbowbnekr";
const OTHER = "nano_1434j1n4sin4cefs5njibag4tsmo596fmg3s6bdogtod3ndmdfez5yuebrh9";
const BURN = "nano_1111111111111111111111111111111111111111111111111111hifc8npp";

test("checksum: real accounts decode to their public key", () => {
  assert.equal(hex(nanoPublicKey(ADDRESS)!).toUpperCase(), "CCCAF98BFE7520F00954893FB019E648A6BA20E34B557C8AB10D20365E4D9D9D");
  assert.equal(hex(nanoPublicKey(OTHER)!).toUpperCase(), "082288282CC282531B91D2304A1C2D667519C8D9B8392257576AAB0D1735B59F");
  assert.equal(hex(nanoPublicKey(BURN)!), "0".repeat(64));
  assert.equal(hasValidNanoChecksum(ADDRESS.replace("nano_", "xrb_")), true);
});

test("checksum: a one-character typo keeps the shape but is refused", () => {
  const badChecksum = `${ADDRESS.slice(0, -1)}s`;
  const badKey = `${ADDRESS.slice(0, 20)}a${ADDRESS.slice(21)}`;
  for (const typo of [badChecksum, badKey]) {
    assert.match(typo, /^nano_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/);
    assert.equal(hasValidNanoChecksum(typo), false, typo);
    assert.equal(isValidNanoAddress(typo), false, typo);
    assert.equal(isValidClaimAddress({ protocol: "x402", network: "nano:mainnet", asset: "XNO", address: typo }), false);
  }
  assert.equal(nanoPublicKey("nano_short"), null);
  assert.equal(nanoPublicKey(ADDRESS.toUpperCase()), null);
});

test("isValidNanoAddress: valid checksum accepted, burn account still refused", () => {
  assert.equal(isValidNanoAddress(ADDRESS), true);
  assert.equal(isValidNanoAddress(OTHER), true);
  assert.equal(hasValidNanoChecksum(BURN), true);
  assert.equal(isValidNanoAddress(BURN), false);
  assert.equal(isValidClaimAddress({ protocol: "x402", network: "nano:mainnet", asset: "XNO", address: ADDRESS }), true);
});
