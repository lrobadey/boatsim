import type { HullShape } from '../hullShape';
import { oarSlots, type OarSlot } from '../oarLayout';

/**
 * Parameters of the agent crew (docs/merchant-crew-spec.md). Values tagged [est] in the spec are
 * calibration choices; the per-order power table is the one tuning knob for speed.
 */
export interface CrewOrder {
  /** -1 back water, 0 oars up, 1 ahead */
  dir: -1 | 0 | 1;
  /** mechanical power per active man (W) */
  P: number;
  /** target stroke rate (spm); the actual rate emerges */
  rate: number;
  /** oars manned (fewer than all = a watch, one per side) */
  manned: number;
}

/** per-bank oar and rower values where a ship's banks differ (the trireme); indexed by slot.bank */
export interface CrewBank {
  /** hand-centre radius from the thole used by the force law (m) */
  handR: number;
  /** oar inertia about the thole (kg m2) and blade added mass (kg) */
  Ioar: number; addedMass: number;
}

export interface CrewStation {
  s: number;
  side: -1 | 1;
  /** thole pin height above the sheer (m) */
  pinDy: number;
}

export interface CrewRowingParams {
  /** the sweeps and their stances; empty when `layout` gives the oars */
  stations: CrewStation[];
  /** the oar slots when they are not the stations' sweeps (the trireme's banks) */
  layout?: () => OarSlot[];
  /** per-bank overrides of handR, Ioar and addedMass */
  banks?: CrewBank[];
  // sweep
  length: number; inboard: number; bladeLength: number; bladeWidth: number; pinDx: number;
  /** hand-centre radius from the thole used by the force law (m) */
  handR: number;
  /** grip radii of the outer (end) and inner hands (m), for animation and handovers */
  gripOuter: number; gripInner: number;
  // inertia about the thole: oar (kg m2), rower body reflected through the hands (kg), blade added mass (kg)
  Ioar: number; mRowerRefl: number; addedMass: number;
  /**
   * the entrained water moves with the sea, not the hull: picked up at the water's own sweep rate, its inertial
   * force reaching the hull as thrust (false: picked up at rest in the hull frame, its reaction left out)
   */
  addedMassRelative: boolean;
  // rower force-velocity at the hands
  F0: number; v0: number; eccMax: number; eccV: number; pushFactor: number;
  thetaMid: number; thetaHalf: number; gEdge: number;
  /** activation time constants (s) */
  tauUp: number; tauDown: number;
  // reach (rad, + = blade forward) and arc
  catchMax: number; finishMin: number; arcMin: number; arcMax: number; arcStart: number;
  // servo outside the drive
  servoWn: number; servoZeta: number; servoF: number; holdF: number; uHold: number;
  /** the recovery force rises with the power asked beyond critical power (servoF x P / CP) */
  recoveryEffort: boolean;
  // stroke timing (s)
  Tcatch: number; Textract: number; Tfeather: number; driveFrac: number;
  recMin: number; recPerRad: number; recMax: number;
  thetaRest: number; thetaHold: number;
  taperFrac: number; taperTo: number;
  /** shipped pose: oar run in along the side, blade dry and feathered */
  shippedSweep: number; shippedDip: number;
  /** shipping ripples from bow to stern over this fore-aft span about amidships (m) */
  shipRipple: number;
  // timing coupling
  K: number; Klead: number; delay: number; wStroke: number; wVisible: number; wAudible: number;
  /** the stroke's lead while the crew trails him by more than trailLimit (s): he waits for them (audit §6.6) */
  KleadTrail: number; trailLimit: number;
  /**
   * whom a rower times himself by: men within sightRange fore and aft (m), on both sides of the deck or
   * only his own; wCall is the weight of the stroke's beat called to every man (the keleustes, the piper)
   */
  sightRange: number; crossDeck: boolean; wCall: number;
  /** a man behind the beat shortens his next stroke to make the catch */
  catchUp: boolean;
  jitter: number; rateBias: number; wanderAmp: number;
  // physiology (mechanical)
  CP: number; Wp: number; tEnd: number; tRecover: number; massHand: number;
  orders: CrewOrder[];
  /** hands aboard (the helmsman is extra) */
  hands: number;
  /** relief waiting spots, ship local [x, s] per relief, fore group first */
  reliefSpots: [number, number][];
  // rotation
  swapW: number; swapR: number; swapMinOn: number; swapGap: number;
  /** test switches; all true in play */
  allocation: boolean; rotation: boolean; catchMatch: boolean; featherRecovery: boolean; retime: boolean; payload: boolean;
  /** rowers read the water at their blade (spec §5.8) */
  waterRead: boolean;
  /** fill the per-hand view for the animated rowers and the walker (false: the rowers are not seen) */
  animated: boolean;
}

/**
 * The Kyrenia merchant's crew: six standing sweeps on alternating sides, fore group P S P, after
 * group S P S; the stroke is the aftmost, ahead of the helm. Eight hands (two reliefs, one per group).
 */
export const MERCHANT_CREW: CrewRowingParams = {
  stations: [
    { s: 0.17, side: -1, pinDy: 0.27 },
    { s: 0.25, side: 1, pinDy: 0.27 },
    { s: 0.33, side: -1, pinDy: 0.27 },
    { s: 0.62, side: 1, pinDy: 0.27 },
    { s: 0.70, side: -1, pinDy: 0.27 },
    // the sheer rises aft: a lower pin keeps the stroke's handle at the others' height
    { s: 0.78, side: 1, pinDy: 0.12 },
  ],
  length: 5.6, inboard: 1.5, bladeLength: 0.9, bladeWidth: 0.2, pinDx: 0.02,
  handR: 1.2, gripOuter: 1.42, gripInner: 0.97,
  Ioar: 80, mRowerRefl: 20, addedMass: 14.5, addedMassRelative: false,
  F0: 900, v0: 2.8, eccMax: 1.5, eccV: 0.25, pushFactor: 0.85,
  thetaMid: 0, thetaHalf: 0.5, gEdge: 0.45,
  tauUp: 0.06, tauDown: 0.09,
  catchMax: 0.43, finishMin: -0.40, arcMin: 0.30, arcMax: 0.83, arcStart: 0.45,
  servoWn: 12, servoZeta: 1, servoF: 220, holdF: 1.25, uHold: 0.75, recoveryEffort: false,
  Tcatch: 0.22, Textract: 0.2, Tfeather: 0.15, driveFrac: 0.5,
  recMin: 0.55, recPerRad: 0.45, recMax: 3.2,
  thetaRest: 0.07, thetaHold: 0.07,
  taperFrac: 0.3, taperTo: 0.25,
  // +1.48: the shipped handle swings aft, away from the rower on the stance. At -1.48 it swung forward through him
  // (clearance -0.11 to -0.19 m); docs/merchant-crew/rig-fixes-2.md sec. 5. The bow sweep then overhangs 1.74 m.
  shippedSweep: 1.48, shippedDip: 0.04, shipRipple: 14,
  K: 0.7, Klead: 0.1, delay: 0.15, wStroke: 1, wVisible: 0.5, wAudible: 0.15,
  KleadTrail: 0.4, trailLimit: 0.1,
  sightRange: Infinity, crossDeck: true, wCall: 0, catchUp: false,
  jitter: 0.035, rateBias: 0.02, wanderAmp: 0.012,
  CP: 100, Wp: 14000, tEnd: 9000, tRecover: 5400, massHand: 65,
  orders: [
    { dir: -1, P: 80, rate: 15, manned: 6 }, // Back Water
    { dir: 0, P: 0, rate: 0, manned: 0 }, // Oars Up
    { dir: 1, P: 45, rate: 14, manned: 2 }, // Slow: a watch, one man per side
    { dir: 1, P: 80, rate: 16, manned: 6 }, // Half
    { dir: 1, P: 115, rate: 18, manned: 6 }, // Full
  ],
  hands: 8,
  reliefSpots: [[1.0, 0.44], [-1.2, 0.55]],
  swapW: 0.35, swapR: 0.15, swapMinOn: 600, swapGap: 20,
  allocation: true, rotation: true, catchMatch: true, featherRecovery: true, retime: true, payload: true, waterRead: true,
  animated: true,
};

/**
 * The trireme's crew (docs/trireme-crew-plan.md): 170 men seated on fixed thwarts, one per oar, in three banks
 * (oarLayout.ts). No reliefs; the rowers are inside the hull and not drawn, and their weight is part of her
 * displacement. Values tagged [est] are reasoned estimates, not measurements; speed is not tuned to a target.
 */
export const TRIREME_CREW: CrewRowingParams = {
  stations: [],
  layout: oarSlots,
  // [est] hands near the loom's end (inboard 0.95 / 0.95 / 0.9 m). Olympias' oars weighed 26 lb (11.8 kg; Christian
  // Science Monitor, 25 Aug 1988). Inertia about the thole for the 4.5 m oar: a heavy inboard loom (5 kg about 0.55 m
  // in: 1.5 kg m2), the outboard loom tapering to the blade (4.8 kg over 3.55 m, about m L^2/4: 15) and a 1.0 kg blade
  // at its 3.22 m radius (10.4): 24 kg m2 (a uniform 11.8 kg rod would give 40); 20 and 17 for the 4.2 and 3.9 m oars.
  // Added mass: the plate value rho pi/4 w^2 l (15.3 kg) halved near the surface, as for the merchant's sweep
  banks: [
    { handR: 0.85, Ioar: 24, addedMass: 7.7 },
    { handR: 0.85, Ioar: 20, addedMass: 7.7 },
    { handR: 0.8, Ioar: 17, addedMass: 7.7 },
  ],
  // the thranite's oar, for reference (the layout's per-bank slots are what the physics uses)
  length: 4.5, inboard: 0.95, bladeLength: 0.66, bladeWidth: 0.17, pinDx: 0.62,
  handR: 0.85, gripOuter: 0.9, gripInner: 0.8,
  // [est] a seated man moves less of his body with the handle than a standing one (merchant 20 kg)
  Ioar: 24, mRowerRefl: 15, addedMass: 7.7, addedMassRelative: true,
  // [est] fixed seat and stretcher: legs, trunk and arms, no slide; a lower peak force than the standing sweep
  F0: 800, v0: 2.8, eccMax: 1.5, eccV: 0.25, pushFactor: 0.85,
  thetaMid: 0.07, thetaHalf: 0.65, gEdge: 0.45,
  tauUp: 0.06, tauDown: 0.09,
  // reach: the trireme's catch and finish (docs/rowing-spec.md, 0.72 / -0.58 rad), about 1.1 m of handle travel
  catchMax: 0.72, finishMin: -0.58, arcMin: 0.4, arcMax: 1.25, arcStart: 0.8,
  // [est] a lighter oar, worked faster: quicker catch and extraction, a firmer push through the recovery
  servoWn: 12, servoZeta: 1, servoF: 300, holdF: 1.25, uHold: 0.75, recoveryEffort: true,
  Tcatch: 0.15, Textract: 0.15, Tfeather: 0.12, driveFrac: 0.5,
  recMin: 0.35, recPerRad: 0.25, recMax: 3.0,
  thetaRest: 0.07, thetaHold: 0.07,
  taperFrac: 0.3, taperTo: 0.25,
  // shipped: swung aft and levelled along the outrigger, as the old visual stow; the oars span 20 m fore and aft
  shippedSweep: -1.48, shippedDip: 0.04, shipRipple: 20,
  // [est] in the din of 170 oars no single neighbour's catch can be picked out by ear (wAudible near zero); a man
  // sees the back of the one or two men ahead of him in his own bank (sightRange 1 m). The keleustes' call and the
  // piper carry the stroke's beat to everyone and outweigh the neighbours: with the merchant's weights (hearing
  // every oar within 2.5 m) blocks of the crew kept one another late, up to a whole beat behind the stroke
  K: 0.7, Klead: 0.1, delay: 0.15, wStroke: 1, wVisible: 0.5, wAudible: 0.02,
  KleadTrail: 0.4, trailLimit: 0.1,
  sightRange: 1.0, crossDeck: false, wCall: 3, catchUp: true,
  jitter: 0.035, rateBias: 0.02, wanderAmp: 0.012,
  // [est] trained oarsmen, mechanical power at the hands: critical power 140 W, W' 16 kJ (CP + W'/t: about 270 W
  // for two minutes). The Olympias sprints delivered roughly 80-120 W per rower to the hull (Rankov 2012, Table 4.2)
  CP: 140, Wp: 16000, tEnd: 9000, tRecover: 5400, massHand: 65,
  // Full is about critical power, Half an all-day 100 W; the rates are the keleustes' calls, the actual rate and
  // stroke length emerge. Ramming speed is called at 36: with these oars a faster beat shortens the stroke and
  // spends more of each man's work swinging the oar (measured: 5.95 kn at 34 spm, 5.84 at 36, 5.13 at 44). Olympias
  // counted up to 48 spm in her sprints (Christian Science Monitor, 25 Aug 1988); see docs/trireme-crew-plan.md
  orders: [
    { dir: -1, P: 90, rate: 18, manned: 170 }, // Back Water
    { dir: 0, P: 0, rate: 0, manned: 0 }, // Oars Up
    { dir: 1, P: 60, rate: 18, manned: 170 }, // Slow
    { dir: 1, P: 100, rate: 26, manned: 170 }, // Half
    { dir: 1, P: 140, rate: 31, manned: 170 }, // Full
    { dir: 1, P: 270, rate: 36, manned: 170 }, // Ramming Speed
  ],
  hands: 170,
  reliefSpots: [],
  swapW: 0.35, swapR: 0.15, swapMinOn: 600, swapGap: 20,
  allocation: true, rotation: false, catchMatch: true, featherRecovery: true, retime: true, payload: false, waterRead: true,
  animated: false,
};

/** the oars: the layout's, or the sweeps as oar slots with pins at halfBeam + pinDx and sheer + pinDy */
export function crewSlots(hull: HullShape, p: CrewRowingParams): OarSlot[] {
  if (p.layout) return p.layout();
  return p.stations.map(({ s, side, pinDy }, id) => ({
    id,
    length: p.length,
    inboard: p.inboard,
    bladeLength: p.bladeLength,
    bladeWidth: p.bladeWidth,
    bladeThickness: 0.03,
    bladeRadius: p.length - p.inboard - p.bladeLength / 2,
    bank: 0,
    side,
    x: side * (hull.halfBeam(s) + p.pinDx),
    y: hull.sheer(s) + pinDy,
    z: hull.zOf(s),
    jitter: 0,
  }));
}
