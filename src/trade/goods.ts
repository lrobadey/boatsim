// Goods table (cargo-trade-spec §4.2). Pure data: no DOM, three.js or game imports, because the
// world worker imports this file for the GoodId type and the port profile features.

export type GoodId = 'wine' | 'oil' | 'wheat' | 'almonds' | 'fish' | 'honey' | 'firewood' | 'pitch';

export interface Good {
  id: GoodId;
  /** ledger name, sentence case */ name: string;
  /** unit word, singular / plural */ unit: [string, string];
  /** full unit mass, kg */ mass: number;
  /** hold volume one unit takes including broken stowage, m³ */ stow: number;
  /** reference price, centidrachmas per unit */ pRef: number;
  /** price elasticity to stock */ eta: number;
  /** consumption per person per game day, units */ perCapita: number;
  /** stock buffer at reference: S_ref = D_ref · bufferDays */ bufferDays: number;
  /** archipelago self-sufficiency at reference */ base: number;
  /** shock epoch length, game days; shock chance per epoch; log-amplitude */ epochDays: number; shockChance: number; shockAmp: number;
  /** harvest: peak day of year, half-width days, amplitude (0 = no season) */ season: [number, number, number];
  /** visual kind for the hold and the quay */ look: 'amphora' | 'jar' | 'sack' | 'bundle';
  /** model tint (hex) */ tint: number;
}

/** Table order is the order of GOODS, GOOD_IDS and every per-good loop (goodIndex). */
export const GOODS: readonly Good[] = [
  {
    id: 'wine', name: 'Wine', unit: ['jar', 'jars'], mass: 42, stow: 0.075, pRef: 800, eta: 0.8,
    perCapita: 0.012, bufferDays: 40, base: 1.0, epochDays: 15, shockChance: 0.3, shockAmp: 0.35,
    season: [270, 25, 0.5], look: 'amphora', tint: 0xa8603a,
  },
  {
    id: 'oil', name: 'Olive oil', unit: ['jar', 'jars'], mass: 40, stow: 0.075, pRef: 2400, eta: 0.7,
    perCapita: 0.0025, bufferDays: 60, base: 0.9, epochDays: 20, shockChance: 0.3, shockAmp: 0.4,
    season: [340, 40, 0.5], look: 'amphora', tint: 0xb8885a,
  },
  {
    id: 'wheat', name: 'Wheat', unit: ['sack', 'sacks'], mass: 40, stow: 0.065, pRef: 600, eta: 1.1,
    perCapita: 0.021, bufferDays: 30, base: 0.85, epochDays: 12, shockChance: 0.35, shockAmp: 0.45,
    season: [165, 25, 0.6], look: 'sack', tint: 0xcdbb94,
  },
  {
    id: 'almonds', name: 'Almonds', unit: ['jar', 'jars'], mass: 30, stow: 0.075, pRef: 900, eta: 0.6,
    perCapita: 0.003, bufferDays: 40, base: 1.0, epochDays: 15, shockChance: 0.25, shockAmp: 0.35,
    season: [230, 20, 0.5], look: 'amphora', tint: 0xc49a6c,
  },
  {
    id: 'fish', name: 'Salt fish', unit: ['jar', 'jars'], mass: 40, stow: 0.075, pRef: 1000, eta: 0.7,
    perCapita: 0.004, bufferDays: 20, base: 1.0, epochDays: 8, shockChance: 0.35, shockAmp: 0.4,
    season: [100, 40, 0.4], look: 'amphora', tint: 0x8f6a4e,
  },
  {
    id: 'honey', name: 'Honey', unit: ['jar', 'jars'], mass: 25, stow: 0.04, pRef: 2000, eta: 0.5,
    perCapita: 0.001, bufferDays: 60, base: 1.0, epochDays: 20, shockChance: 0.25, shockAmp: 0.3,
    season: [190, 30, 0.4], look: 'jar', tint: 0xc9a066,
  },
  {
    id: 'firewood', name: 'Firewood', unit: ['bundle', 'bundles'], mass: 25, stow: 0.06, pRef: 80, eta: 1.0,
    perCapita: 0.15, bufferDays: 10, base: 0.9, epochDays: 10, shockChance: 0.3, shockAmp: 0.3,
    season: [0, 0, 0], look: 'bundle', tint: 0x7a5a3c,
  },
  {
    id: 'pitch', name: 'Pitch', unit: ['jar', 'jars'], mass: 35, stow: 0.06, pRef: 800, eta: 0.6,
    perCapita: 0.001, bufferDays: 60, base: 1.0, epochDays: 20, shockChance: 0.25, shockAmp: 0.35,
    season: [0, 0, 0], look: 'jar', tint: 0x5a4636,
  },
];

export const GOOD_IDS: readonly GoodId[] = GOODS.map((g) => g.id);

const INDEX = new Map<GoodId, number>(GOOD_IDS.map((id, i) => [id, i]));

/** Position of a good in the table (GOOD_IDS order). Throws on an unknown id. */
export function goodIndex(id: GoodId): number {
  const i = INDEX.get(id);
  if (i === undefined) throw new RangeError(`unknown good: ${String(id)}`);
  return i;
}

/** The table entry for a good id. */
export function goodById(id: GoodId): Good {
  return GOODS[goodIndex(id)];
}

/**
 * Harvest factor for a good on a day of year (0..364). Continuous, year mean exactly 1 (integral over
 * the year), minimum 1 - amp·half/365 > 0. Exactly 1 for goods with amp = 0.
 * Takes the table entry (not the id).
 */
export function season(good: Good, doy: number): number {
  const [peak, half, amp] = good.season;
  if (amp === 0 || half === 0) return 1;
  // circular day-of-year distance to the peak, in [0, 182.5]
  let d = (((doy - peak) % 365) + 365) % 365;
  if (d > 182.5) d = 365 - d;
  const g = d < half ? 0.5 * (1 + Math.cos((Math.PI * d) / half)) : 0;
  return 1 + amp * (g - half / 365);
}
