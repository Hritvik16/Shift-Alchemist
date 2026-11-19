/**
 * Deterministic 32-bit integer hash (murmur3 fmix32) for bit-exact replays.
 * Uses only integer/IEEE-exact ops — never Math.random/sin/cos/pow.
 */
export function hash32(a: number, b: number, c: number): number {
  let h = ((a | 0) ^ Math.imul(b | 0, 0x9e3779b1) ^ Math.imul(c | 0, 0x85ebca77)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export function hashUnitFloat(a: number, b: number, c: number): number {
  return (hash32(a, b, c) & 0x00ffffff) / 0x01000000;
}
