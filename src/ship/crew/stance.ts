import type { HullShape } from '../hullShape';
import { ROWING_CONSTANTS } from '../rowing';
import type { CrewRowingParams } from './params';

/**
 * Rowing stance, plain numbers (shared by the sim and the animator; src/crew/stance.ts wraps it with deck height
 * and the RowerStance frame).
 *
 * SPEC DEVIATION (docs/merchant-crew-spec.md §2.2, measured): the opposite-side stance is out of reach. The grips
 * sit 0.11 to 1.09 m off the centreline on the oar's own side, beyond a 0.58 m arm reach. So the rower stands on
 * his oar's side, level with the mid-stroke grip midpoint across the deck, and STANCE_D0 forward of it. He faces aft.
 */
/** m, the stance centre forward of the pin (the mid-stroke grip midpoint is level with the pin fore-aft) */
export const STANCE_D0 = 0.6;
/** the stroke: the aftmost station (slot 5, pin at s 0.78) */
export const STROKE_STATION = 5;
/**
 * m, the stroke station's stance centre forward of the pin. The handle is at hip height there, so with 0.6 the loom
 * comes to the front thigh at the finish. At 0.68 the clearance is 0.088 to 0.096 m: ACCEPTED DEVIATION from the
 * 0.10 m gate (the stroke gate is 0.085 in scripts/test-rowers.mjs). Derivation: docs/merchant-crew/rig-fixes-2.md sec. 4.
 */
export const STANCE_D0_STROKE = 0.68;
/** m, toward the oar's side from the grip midpoint (zero: the stance is on the grip midpoint's lateral line) */
export const STANCE_LAT = 0;
/** m, front (left) foot; the short merchant arc needs no lunge */
export const STANCE_SPLIT_FWD = 0.32;
export const STANCE_SPLIT_BACK = 0.25;
export const STANCE_WIDTH = 0.16;
/** m, a second man on the loom (the outgoing rower in a handover) stands this far inboard of the stance */
export const SECOND_STEP = 0.35;

/**
 * Ship-local stance centre of station k: x is the grip midpoint's lateral position at sweep 0 (on the oar's side,
 * the sign of the side), z is STANCE_D0 forward of the pin. Written into out, allocation-free.
 */
export function stanceXZ(k: number, hull: HullShape, p: CrewRowingParams, out: { x: number; z: number }): { x: number; z: number } {
  const st = p.stations[k], side = st.side, s = st.s;
  // pin and wet dip exactly as crewSlots / the crew's water model place them
  const pinX = side * (hull.halfBeam(s) + p.pinDx), pinY = hull.sheer(s) + st.pinDy, pinZ = hull.zOf(s);
  const bladeR = p.length - p.inboard - p.bladeLength / 2;
  const dip = Math.asin(Math.min(0.95, (pinY + ROWING_CONSTANTS.wetDepth) / bladeR));
  // grip midpoint at sweep 0: pin - axis * r, axis = (side cos dip, -sin dip, 0)
  const gripX = pinX - side * Math.cos(dip) * 0.5 * (p.gripOuter + p.gripInner);
  out.x = gripX + side * STANCE_LAT;
  out.z = pinZ - (k === STROKE_STATION ? STANCE_D0_STROKE : STANCE_D0);
  return out;
}
