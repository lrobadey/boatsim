// Market shocks (cargo-trade-spec §4.4 Shocks). A pure function of (seed, port, good, T): a save never
// stores shocks.

import { hash01 } from './hash';
import type { Good } from './goods';

export interface ShockMultipliers {
  /** production multiplier (1 when no production shock is active) */
  p: number;
  /** demand multiplier (1 when no demand shock is active) */
  d: number;
}

/** The shock of one epoch, if it has one. */
interface EpochShock {
  /** true: production shock; false: demand shock */
  prod: boolean;
  /** z = 2·(2·hash − 1), in [−2, 2) */
  z: number;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Shock envelope over the phase φ in [0, 1): zero at both ends of the epoch, flat in between. */
function envelope(phi: number): number {
  return smoothstep(0, 0.2, phi) * (1 - smoothstep(0.8, 1, phi));
}

/**
 * Per (port, good) shock track. Caches the current epoch so the economy's hourly loop does not
 * re-hash each hour. The values are identical to the uncached shockMultipliers().
 */
export class ShockTrack {
  private readonly seed: number;
  private readonly port: number;
  private readonly gi: number;
  private readonly good: Good;
  /** epoch offset in days, in [0, epochDays) */
  private readonly off: number;
  private curK = NaN;
  private curShock: EpochShock | null = null;

  constructor(seed: number, port: number, gi: number, good: Good) {
    this.seed = seed;
    this.port = port;
    this.gi = gi;
    this.good = good;
    this.off = hash01(seed, port, gi, 0x0ff) * good.epochDays;
  }

  /** Multipliers at absolute game hour T (any real number; fractional hours are fine). */
  at(T: number): ShockMultipliers {
    const g = this.good;
    const x = (T / 24 + this.off) / g.epochDays;
    const k = Math.floor(x);
    const phi = x - k;
    if (k !== this.curK) {
      this.curK = k;
      this.curShock = this.epochShock(k);
    }
    const s = this.curShock;
    if (s === null) return { p: 1, d: 1 };
    const m = Math.exp(g.shockAmp * s.z * envelope(phi));
    return s.prod ? { p: m, d: 1 } : { p: 1, d: m };
  }

  private epochShock(k: number): EpochShock | null {
    const { seed, port, gi, good } = this;
    const u = hash01(seed, port, gi, k, 0);
    if (!(u < good.shockChance)) return null;
    const prod = hash01(seed, port, gi, k, 1) < 0.6;
    const z = 2 * (2 * hash01(seed, port, gi, k, 2) - 1);
    return { prod, z };
  }
}

/**
 * Shock multipliers for one (port, good index, good) at absolute game hour T. The economy uses
 * ShockTrack, which gives the same values with caching.
 */
export function shockMultipliers(seed: number, port: number, gi: number, good: Good, T: number): ShockMultipliers {
  return new ShockTrack(seed, port, gi, good).at(T);
}
