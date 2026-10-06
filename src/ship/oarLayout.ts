import { halfBeam, sheer, zOf } from './hull';

/**
 * Oar banks of a trireme: thranites (top, on the outrigger), zygites (middle, through the hull
 * at the gunwale), thalamites (lowest, through ports just above the waterline).
 * Each bank spans a stretch of the hull; rowers ~0.98 m apart (the "interscalmium").
 */
export interface OarBank {
  name: string;
  count: number; // per side
  s0: number;
  s1: number;
  pivotX: number; // mean |x| of the thole pins
  pivotY: number;
  zMid: number;
  length: number;
  inboard: number;
}

const bank = (name: string, count: number, s0: number, s1: number, dx: number, y: (s: number) => number, length: number, inboard: number): OarBank => {
  const sm = (s0 + s1) / 2;
  return { name, count, s0, s1, pivotX: halfBeam(sm) + dx, pivotY: y(sm), zMid: zOf(sm), length, inboard };
};

export const OAR_BANKS: OarBank[] = [
  bank('thranite', 31, 0.2, 0.8, 0.62, (s) => sheer(s) + 0.08, 4.5, 0.95),
  bank('zygite', 27, 0.24, 0.76, 0.02, (s) => sheer(s) - 0.6, 4.2, 0.95),
  bank('thalamite', 27, 0.24, 0.76, -0.08, () => 0.5, 3.9, 0.9),
];

export interface OarSlot {
  id: number;
  length: number;
  inboard: number;
  bladeLength: number;
  bladeWidth: number;
  bladeThickness: number;
  bladeRadius: number;
  bank: number;
  side: -1 | 1;
  x: number;
  y: number;
  z: number;
  jitter: number;
}

export function oarSlots(): OarSlot[] {
  const slots: OarSlot[] = [];
  OAR_BANKS.forEach((b, bi) => {
    for (let i = 0; i < b.count; i++) {
      const s = b.s0 + ((i + 0.5) / b.count) * (b.s1 - b.s0) + (bi === 1 ? 0.004 : bi === 2 ? -0.004 : 0);
      for (const side of [-1, 1] as const) {
        const hb = halfBeam(s);
        const x = side * (hb + (bi === 0 ? 0.62 : bi === 1 ? 0.02 : -0.08));
        const y = bi === 0 ? sheer(s) + 0.08 : bi === 1 ? sheer(s) - 0.6 : 0.5;
        slots.push({ id: slots.length, length: b.length, inboard: b.inboard, bladeLength: 0.66, bladeWidth: 0.17, bladeThickness: 0.028, bladeRadius: b.length - b.inboard - 0.33, bank: bi, side, x, y, z: zOf(s), jitter: Math.sin(i * 12.9898 + bi * 78.233 + side) * 0.5 });
      }
    }
  });
  return slots;
}
