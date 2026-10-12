import type { ShipDesign } from '../ship/design';
import {
  stanceXZ, STANCE_SPLIT_FWD, STANCE_SPLIT_BACK, STANCE_WIDTH,
} from '../ship/crew/stance';
import type { RowerStance } from './rowerRig';

/**
 * Animator wrapper over the plain stance numbers in src/ship/crew/stance.ts (the single source of truth,
 * shared with the sim). The rower faces aft; the centre is on his oar's side, level with the mid-stroke grip
 * midpoint across the deck and 0.6 m forward of the pin (spec §2.2, measured deviation: the opposite-side
 * stance is out of reach).
 */
export {
  STANCE_D0, STANCE_LAT, STANCE_SPLIT_FWD, STANCE_SPLIT_BACK, STANCE_WIDTH, SECOND_STEP,
} from '../ship/crew/stance';

const xz = { x: 0, z: 0 };

/**
 * Stance of the rower at station `slotIndex` of an agent-crew design (design.oars.crew), ship-local.
 * Writes center, facing, deckUp and the foot split into `out` and returns it; allocation-free.
 */
export function stanceFor(slotIndex: number, design: ShipDesign, out: RowerStance): RowerStance {
  const p = design.oars.crew;
  if (!p) throw new Error('stanceFor: design has no agent crew');
  stanceXZ(slotIndex, design.hull, p, xz);
  out.center.set(xz.x, design.deck.deckY(p.stations[slotIndex].s), xz.z);
  out.facing.set(0, 0, 1);
  out.deckUp.set(0, 1, 0);
  out.splitFwd = STANCE_SPLIT_FWD;
  out.splitBack = STANCE_SPLIT_BACK;
  out.width = STANCE_WIDTH;
  return out;
}
