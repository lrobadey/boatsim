import type { ShipDesign } from '../ship/design';
import type { CrewMemberView } from '../ship/crew/view';
import { crewSlots } from '../ship/crew/params';
import { stanceXZ } from '../ship/crew/stance';
import { createKinematics, type OarKinematics } from '../ship/rowing';
import type { BoxSolid, CylSolid, WalkGeometry } from '../world/walkable';

/**
 * Walker collision for the agent crew (docs/merchant-crew-spec.md §9.8, E10). Each frame the crew's
 * views set the dynamic solids on the ship's WalkGeometry:
 * - one cylinder per hand, following the walker while walking, and at the stance (r 0.35) while at an oar;
 * - one box per manned, unshipped station that follows the loom: from the pin to the handle end plus
 *   0.1 m, 0.25 m wide, from just below the handle to 0.4 m above the higher of handle and pin.
 *
 * Ship-local, like the static deck solids in game.ts. Allocation-free: the solids and the kinematics are
 * created once; update() rewrites WalkGeometry.dynamic in place.
 */

const HAND_R = 0.28;
const HAND_H = 1.75;
/** a rower at the oar: the stance cylinder */
const STANCE_R = 0.35;
/** loom box: full width (loom plus hands), extension past the handle end, band below and above */
const LOOM_W = 0.25;
const LOOM_PAST_HANDLE = 0.1;
const LOOM_BELOW = 0.1;
const LOOM_ABOVE = 0.4;
const MAX_HANDS = 8;

/** what the loom pose comes from: CrewRowing.renderPose (the current joint, alpha 1) */
export interface LoomPose {
  renderPose(index: number, alpha: number, out: OarKinematics): void;
}

export class CrewSolids {
  private readonly hands: CylSolid[] = [];
  private readonly looms: BoxSolid[] = [];
  private readonly stations: number;
  private readonly inboard: number[] = [];
  // per station: stance (ship-local x, z), deck y
  private readonly stanceX: number[] = [];
  private readonly stanceZ: number[] = [];
  private readonly stanceY: number[] = [];
  private readonly manned: boolean[] = [];
  // deck height as a function of z, sampled along the hull (for walking hands)
  private readonly deckZ: number[] = [];
  private readonly deckY: number[] = [];
  private readonly kin: OarKinematics = createKinematics();
  /** loom boxes block walkers (spec E10); a walker slips through between strokes. The user confirms at the browser review */
  private readonly loomSolids: boolean;

  /**
   * @param geometry the ship-frame WalkGeometry (game.ts `shipSolids`)
   * @param design the merchant design; must have `oars.crew` (the crew system)
   */
  constructor(private readonly geometry: WalkGeometry, design: ShipDesign, opts: { loomSolids?: boolean } = {}) {
    // the deck is ~60 cm wide at station 3 between the stance and the loom sweep, so looms do not block walkers by
    // default; the user decides at the browser review
    this.loomSolids = opts.loomSolids ?? false;
    const crew = design.oars.crew;
    if (!crew) throw new Error('CrewSolids: design has no crew oars');
    const slots = crewSlots(design.hull, crew);
    const d = design;
    this.stations = crew.stations.length;
    for (let i = 0; i < 65; i++) {
      const s = i / 64;
      this.deckZ.push(d.hull.zOf(s));
      this.deckY.push(d.deck.deckY(s));
    }
    const xz = { x: 0, z: 0 };
    for (let k = 0; k < this.stations; k++) {
      // the stance of station k (stance.ts, the animator's rower centre): on the oar's side, 0.6 m forward of the pin
      stanceXZ(k, d.hull, crew, xz);
      this.stanceX.push(xz.x);
      this.stanceZ.push(xz.z);
      this.stanceY.push(d.deck.deckY(crew.stations[k].s));
      this.manned.push(false);
      this.inboard.push(slots[k].inboard);
      this.looms.push({ kind: 'box', cx: 0, cz: 0, hx: 0, hz: LOOM_W / 2, rot: 0, y0: 0, y1: 0, surface: 'wood', walkTop: false });
    }
    for (let i = 0; i < MAX_HANDS; i++) {
      this.hands.push({ kind: 'cyl', cx: 0, cz: 0, r: HAND_R, y0: 0, y1: HAND_H, surface: 'wood', walkTop: false });
    }
  }

  /**
   * Rewrite geometry.dynamic from this frame's crew views (ship-local). Call once per physics step,
   * after the step, with the crew's views and the rowing system that owns the oars.
   */
  update(view: readonly CrewMemberView[], rowing: LoomPose): void {
    const dyn = this.geometry.dynamic;
    dyn.length = 0;
    for (let k = 0; k < this.stations; k++) this.manned[k] = false;

    const n = Math.min(view.length, MAX_HANDS);
    for (let i = 0; i < n; i++) {
      const m = view[i];
      const h = this.hands[i];
      const walking = (m.mode === 'walk' || m.mode === 'stepIn' || m.mode === 'stepOut') && m.walk;
      if (walking) {
        const p = m.walk!.pos;
        const y0 = this.deckAt(p.z);
        h.cx = p.x; h.cz = p.z; h.r = HAND_R; h.y0 = y0; h.y1 = y0 + HAND_H;
        dyn.push(h);
      } else if (m.mode === 'row' || m.mode === 'hold') {
        if (m.oar < 0 || m.oar >= this.stations) continue;
        const k = m.oar;
        h.cx = this.stanceX[k]; h.cz = this.stanceZ[k]; h.r = STANCE_R; h.y0 = this.stanceY[k]; h.y1 = h.y0 + HAND_H;
        dyn.push(h);
      }
      if ((m.mode === 'row' || m.mode === 'hold' || m.mode === 'stepIn') && m.oar >= 0 && m.oar < this.stations) this.manned[m.oar] = true;
    }
    for (let k = 0; k < this.stations; k++) {
      if (!this.manned[k]) continue;
      if (!this.loomSolids) continue;
      rowing.renderPose(k, 1, this.kin);
      this.placeLoom(k, this.looms[k]);
      dyn.push(this.looms[k]);
    }
  }

  /** the loom box for station k from the current pose (kin): pin to handle end + 0.1 m, rotated along the loom */
  private placeLoom(k: number, b: BoxSolid): void {
    const P = this.kin.pivot, A = this.kin.axis;
    // the loom runs from the pin along -axis (the axis points outboard, to the blade)
    const L = this.inboard[k] + LOOM_PAST_HANDLE;
    const ex = P.x - A.x * L, ey = P.y - A.y * L, ez = P.z - A.z * L;
    const ux = -A.x, uz = -A.z;
    const hl = Math.hypot(ux, uz);
    b.cx = (P.x + ex) / 2;
    b.cz = (P.z + ez) / 2;
    b.hx = (L * hl) / 2;
    // a loom pointing straight up or down has no horizontal direction: keep the last yaw
    if (hl > 1e-6) b.rot = Math.atan2(-uz / hl, ux / hl);
    b.y0 = Math.min(ey, P.y) - LOOM_BELOW;
    b.y1 = Math.max(ey, P.y) + LOOM_ABOVE;
  }

  /** deck height at ship-local z: the nearest sample along the hull */
  private deckAt(z: number): number {
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.deckZ.length; i++) {
      const d = Math.abs(this.deckZ[i] - z);
      if (d < bd) { bd = d; best = i; }
    }
    return this.deckY[best];
  }
}
