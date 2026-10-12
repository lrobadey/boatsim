// Stateless integer hashing for the economy (cargo-trade-spec §4.4). Never Math.random, never a
// streamed RNG: every shock and every shipment decision is a function of its integer arguments.

/** murmur3 32-bit finaliser. Input and output are unsigned 32-bit. */
export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Hash of integer arguments in order: h = fmix32(h ^ (x | 0) >>> 0), starting from h = 0 (the spec
 * does not give a start value; 0 is the closest literal reading). Returns h / 2^32 in [0, 1).
 * Negative arguments are fine.
 */
export function hash01(...ints: number[]): number {
  let h = 0;
  for (let i = 0; i < ints.length; i++) {
    h = fmix32((h ^ ((ints[i] | 0) >>> 0)) >>> 0);
  }
  return h / 4294967296;
}
