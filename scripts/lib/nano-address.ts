/**
 * Nano account checksum, with no dependency beyond the language.
 *
 * An account is `nano_` (or the legacy `xrb_`) plus 60 characters of Nano's base32 alphabet:
 * 52 characters carry 4 zero bits and the 256-bit public key, and the last 8 carry a 40-bit
 * checksum, which is BLAKE2b of the key with a 5-byte digest, bytes in reverse order. A typo in a
 * declared payout account keeps the shape but breaks the checksum, so it is refused here, before
 * it takes a slot in the verification queue.
 *
 * BLAKE2b follows RFC 7693 (unkeyed, one digest length); Node's `crypto` only offers the fixed
 * 64-byte `blake2b512`, and a truncated 64-byte digest is not the 5-byte digest.
 */

const ALPHABET = "13456789abcdefghijkmnopqrstuwxyz";
const ACCOUNT = /^(?:nano|xrb)_([13][13456789abcdefghijkmnopqrstuwxyz]{51})([13456789abcdefghijkmnopqrstuwxyz]{8})$/;

const MASK = (1n << 64n) - 1n;
const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const rotr = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & MASK;

function compress(h: bigint[], block: Uint8Array, counter: bigint, last: boolean): void {
  const m: bigint[] = [];
  for (let i = 0; i < 16; i++) {
    let w = 0n;
    for (let b = 7; b >= 0; b--) w = (w << 8n) | BigInt(block[i * 8 + b]);
    m.push(w);
  }
  const v = [...h, ...IV];
  v[12] ^= counter & MASK;
  v[13] ^= counter >> 64n;
  if (last) v[14] ^= MASK;
  const g = (a: number, b: number, c: number, d: number, x: bigint, y: bigint) => {
    v[a] = (v[a] + v[b] + x) & MASK; v[d] = rotr(v[d] ^ v[a], 32n);
    v[c] = (v[c] + v[d]) & MASK; v[b] = rotr(v[b] ^ v[c], 24n);
    v[a] = (v[a] + v[b] + y) & MASK; v[d] = rotr(v[d] ^ v[a], 16n);
    v[c] = (v[c] + v[d]) & MASK; v[b] = rotr(v[b] ^ v[c], 63n);
  };
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10];
    g(0, 4, 8, 12, m[s[0]], m[s[1]]);
    g(1, 5, 9, 13, m[s[2]], m[s[3]]);
    g(2, 6, 10, 14, m[s[4]], m[s[5]]);
    g(3, 7, 11, 15, m[s[6]], m[s[7]]);
    g(0, 5, 10, 15, m[s[8]], m[s[9]]);
    g(1, 6, 11, 12, m[s[10]], m[s[11]]);
    g(2, 7, 8, 13, m[s[12]], m[s[13]]);
    g(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
}

/** Unkeyed BLAKE2b (RFC 7693) with an `outLength`-byte digest, 1 to 64. */
export function blake2b(input: Uint8Array, outLength: number): Uint8Array {
  if (!Number.isInteger(outLength) || outLength < 1 || outLength > 64) throw new RangeError("outLength must be 1..64");
  const h = [...IV];
  h[0] ^= 0x01010000n ^ BigInt(outLength);
  let offset = 0;
  while (input.length - offset > 128) {
    compress(h, input.subarray(offset, offset + 128), BigInt(offset + 128), false);
    offset += 128;
  }
  const lastBlock = new Uint8Array(128);
  lastBlock.set(input.subarray(offset));
  compress(h, lastBlock, BigInt(input.length), true);
  const out = new Uint8Array(outLength);
  for (let i = 0; i < outLength; i++) out[i] = Number((h[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn);
  return out;
}

function decode(chars: string): bigint {
  let n = 0n;
  for (const c of chars) n = (n << 5n) | BigInt(ALPHABET.indexOf(c));
  return n;
}

/** The 32-byte public key of a well-formed account whose checksum matches, else null. */
export function nanoPublicKey(address: string): Uint8Array | null {
  const parts = ACCOUNT.exec(address);
  if (!parts) return null;
  const keyBits = decode(parts[1]);
  if (keyBits >> 256n !== 0n) return null;
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = Number((keyBits >> BigInt(8 * (31 - i))) & 0xffn);
  const digest = blake2b(key, 5);
  let expected = 0n;
  for (let i = 4; i >= 0; i--) expected = (expected << 8n) | BigInt(digest[i]);
  return decode(parts[2]) === expected ? key : null;
}

/** Whether `address` is a Nano account whose checksum matches its public key. */
export function hasValidNanoChecksum(address: string): boolean {
  return nanoPublicKey(address) !== null;
}
