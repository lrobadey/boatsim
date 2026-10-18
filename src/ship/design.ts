import { HULL_LENGTH, RAM_LENGTH, deckY as triremeDeckY, halfBeam as triremeHalfBeam, DECK_S0, DECK_S1 } from './hull';
import { TRIREME_HULL, type HullShape } from './hullShape';
import { MERCHANT_HULL } from './merchantHull';
import { oarSlots, type OarSlot } from './oarLayout';
import { MERCHANT_CREW, TRIREME_CREW, crewSlots, type CrewRowingParams } from './crew/params';

/**
 * A playable ship: pure data plus hull functions. Every ship-dependent system takes a design in its
 * constructor and reads only that design; nothing switches a global "current ship".
 * The trireme's values reproduce the original hard-coded constants exactly (golden-trace test).
 */
export type ShipKind = 'trireme' | 'merchant';

/** Walkable deck surface, ship local frame (see hullShape.ts). */
export interface ShipDeck {
  /** walkable deck height at station s */
  deckY(s: number): number;
  /** walkable half-width at s, inside the rail */
  deckHalfWidth(s: number): number;
  /** outermost half-width at the sheer (hull plus outrigger): climbing aboard, clearance, quay contact */
  outerHalfWidth(s: number): number;
  /** walkable extent in s */
  readonly s0: number;
  readonly s1: number;
}

/** Longitudinal drag coefficient model for the hull columns (see resistance.ts). */
export type ResistanceModel =
  /** constant friction coefficient (the trireme's original calibration) */
  | { kind: 'constant'; cf: number; cw0: number; cwExp: number; astern: number }
  /** ITTC-57 friction line times a form factor */
  | { kind: 'ittc'; formFactor: number; cw0: number; cwExp: number; astern: number };

/** Square-rig geometry shared by the sail physics and the sail cloth. */
export interface SailRig {
  width: number;
  height: number;
  area: number;
  mastStation: number;
  /** mast height above the partner (deck) */
  mastHeight: number;
  yardDrop: number;
  clothTopDrop: number;
  clothOffsetZ: number;
  yardLength: number;
  maxYardAngle: number;
  sampleCount: number;
  /** deck height at the mast partner, ship local */
  mastBaseY: number;
  /** yard axis, ship local: yardY = mastBaseY + mastHeight - yardDrop */
  yardY: number;
  yardZ: number;
}

/** Sail aerodynamic calibration (see SAIL_AERO in sailing.ts). */
export interface SailAero {
  pressureDrag: number;
  trimSidePenalty: number;
  heelReliefStart: number;
  heelReliefFull: number;
  heelSidePenalty: number;
  trimSlewPenalty: number;
}

/** Docking alongside a quay (Mooring): lines, hauling in, the docked hold and the gangplank. */
export interface DockingDesign {
  enabled: boolean;
  /** cleat stations: bow line, forward spring, aft spring, stern line */
  cleats: [number, number, number, number];
  /** gangplank opening station, and how far the plank reaches out from the rail toward the quay (m) */
  plankS: number;
  plankReach: number;
  /** gangplank length (m): it rests on the quay edge or the quay top, its foot set on deck (Mooring) */
  plankLength: number;
  /** clearance between the hull's widest point and the quay face when docked (fenders implied, m) */
  gap: number;
  /**
   * capture window for throwing the lines. lateral is measured from the docked pose, + = out from the
   * quay; along is the offset along the quay; head is the largest heading error (rad); sog in m/s
   */
  capture: { along: number; latMin: number; latMax: number; head: number; sog: number };
  /** hands on the lines (about 350 N each) times the tackle's mechanical advantage cap the haul */
  crew: number;
  tackle: number;
  /** most the belayed lines hold together (N); beyond it the crew eases them */
  lineStrength: number;
  /** natural period of the docked hold (s) */
  holdPeriod: number;
}

/** Cargo hold of a ship that carries trade cargo (cargo-trade spec §5.3, §6.1). Only the merchant has one. */
export interface CargoDesign {
  /** the 3 t of amphorae baked into the design load, removed as one block when the hold takes over */
  reference: { mass: number; local: [number, number, number] };
  /** hold extent (stations, z along the keel), layers above the keel floor and below the deck, cell size, margin to the hull, mast clearance (m) */
  hold: { sFrom: number; sTo: number; floorAboveKeel: number; ceilingBelowDeck: number; cell: [number, number, number]; margin: number; mastClear: number };
  /** deck hatches, stations s0..s1 (fore-aft), each half-width hatchHalfWidth */
  hatches: { s0: number; s1: number }[];
  hatchHalfWidth: number;
  /** coaming lip height (m) */
  lip: number;
}

export interface ShipDesign {
  kind: ShipKind;
  /** plain name for UI text */
  name: string;
  /** title-screen subtitle */
  subtitle: string;
  hull: HullShape;
  deck: ShipDeck;
  /** buoyancy column sampling */
  columns: { stations: number; strips: number };
  /** mass from displacement at the design waterline (y = 0); CG height and fore-aft position, inertia scale per axis */
  mass: { cgY: number; cgZ: number; inertiaScale: [number, number, number] };
  hydro: {
    resistance: ResistanceModel;
    /** wetted area per submerged column = plan area x this factor */
    wettedFactor: number;
    /**
     * lateral plane per column: false = its own submerged depth / strips (the trireme's calibration);
     * true = the station's submerged profile depth (keel to waterline) x its share of the beam
     */
    lateralFromProfile: boolean;
    /** column heave damping: -0.5 rho quad A v|v| - lin A v */
    heaveDampQuad: number;
    heaveDampLin: number;
    /** angular damping torque = -mass x this x angVel */
    angularDamp: number;
    /** roll damping torque about the fore-aft axis = -lin p - quad p|p| */
    rollDampLin: number;
    rollDampQuad: number;
    /**
     * Response to the water (merchant plan §4.3); absent = the trireme's original model. Enables wave
     * excitation (Froude–Krylov plus diffraction), implicit added mass with the Kirchhoff/Munk terms,
     * payload inertia, and column heave damping on the centre line (so it no longer damps roll).
     * ca: added-mass coefficients per submerged column as fractions of its displaced mass rho V, along
     * the hull axes [sway (x), heave (y), surge (z)].
     */
    response?: { ca: [number, number, number] };
  };
  /** hull and rig windage: F = 0.5 rho_air Cd A v|v| per axis, acting at `point` (ship local) */
  windage: { lateralCd: number; lateralArea: number; frontalCd: number; frontalArea: number; point: [number, number, number] };
  /** a pair of steering oars / quarter rudders, mirrored port and starboard */
  rudder: {
    area: number;
    /** station of the blade */
    s: number;
    /** blade centre outboard of halfBeam(s) */
    xOut: number;
    /** blade centre height (ship local) */
    y: number;
    /** blade centre aft of zOf(s) */
    dz: number;
    /** depth at which the blade counts as fully submerged */
    depthNorm: number;
    /** rudder angle at full helm (rad) */
    maxAngle: number;
    /** tiller rate (rad/s) */
    rate: number;
  };
  /** extra grounding contact points (ship local), after the column bottoms */
  contactExtras: [number, number, number][];
  /** stations of the side points that meet a quay face (at outerHalfWidth(s), sheer(s)) */
  quayStations: number[];
  oars: {
    /** 'banks': RowingSystem (scripted strokes); 'crew': CrewRowing (agent crew, docs/merchant-crew-spec.md) */
    system: 'banks' | 'crew';
    slots(): OarSlot[];
    /** number of oar banks (visual instancing groups); slot.bank < bankCount */
    bankCount: number;
    /** mean sustainable power per rower (W), indexed by order (see ORDERS in crew.ts) */
    meanPower: number[];
    /** highest order index this crew can be given (5 = ramming speed) */
    maxOrder: number;
    /** per-slot stroke energy reservoir (J) */
    slotEnergy: number;
    /** catch and finish sweep angles of the stroke (rad) */
    sweepFwd: number;
    sweepBack: number;
    /** stroke rate = order rate x rateScale, clamped to [rateMin, rateMax] (spm) */
    rateScale: number;
    rateMin: number;
    rateMax: number;
    /** keleustes' drum on the catch */
    drum: boolean;
    /** the agent crew's parameters (system 'crew' only) */
    crew?: CrewRowingParams;
  };
  rig: SailRig;
  aero: SailAero;
  docking: DockingDesign;
  /** dropping and weighing the anchor (Mooring) */
  anchoringEnabled: boolean;
  /** ground tackle: station of the bow fairlead the rode runs from, rode stiffness relative to the trireme's */
  anchor: { s: number; stiffnessScale: number };
  /** deck building (DeckBuilder) */
  buildingEnabled: boolean;
  camera: { helmS: number; chaseDist: number; chasePivotUp: number; dockingDist: number; titleDist: number; titleLift: number };
  /** deck crew figures from the model kit: [model name, x, station s, yaw]; model -z faces forward */
  crewSpots: [string, number, number, number][];
  /** cargo hold (merchant only); absent = no trade */
  cargo?: CargoDesign;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------- trireme

/** outrigger (parexeiresia) outboard extension; same formula as trireme.ts */
const triremeOutrigger = (s: number) => 0.7 * smooth(0.13, 0.2, s) * (1 - smooth(0.8, 0.87, s));

const TRIREME_DECK: ShipDeck = {
  deckY: triremeDeckY,
  deckHalfWidth: (s) => triremeHalfBeam(s) + triremeOutrigger(s) - 0.45,
  outerHalfWidth: (s) => triremeHalfBeam(s) + triremeOutrigger(s),
  s0: DECK_S0,
  s1: DECK_S1,
};

const triremeQuayStations: number[] = [];
for (let i = 0; i <= 6; i++) triremeQuayStations.push(0.2 + i * 0.1);

/** the trireme's original sail calibration (equal to SAIL_AERO in sailing.ts) */
const TRIREME_AERO: SailAero = Object.freeze({
  pressureDrag: 1.7,
  trimSidePenalty: 0.22,
  heelReliefStart: (8 * Math.PI) / 180,
  heelReliefFull: (18 * Math.PI) / 180,
  heelSidePenalty: 1.8,
  trimSlewPenalty: 300,
});

export const TRIREME: ShipDesign = {
  kind: 'trireme',
  name: 'Trireme',
  subtitle: 'Trireme simulator',
  hull: TRIREME_HULL,
  deck: TRIREME_DECK,
  columns: { stations: 20, strips: 4 },
  mass: { cgY: 0.3, cgZ: 0, inertiaScale: [1.1, 1.05, 1.25] },
  hydro: {
    resistance: { kind: 'constant', cf: 0.006, cw0: 0.003, cwExp: 4, astern: 2.4 },
    wettedFactor: 1.35,
    lateralFromProfile: false,
    heaveDampQuad: 0.9,
    heaveDampLin: 1800,
    angularDamp: 0.6,
    rollDampLin: 22000,
    rollDampQuad: 40000,
  },
  windage: { lateralCd: 1.0, lateralArea: 45, frontalCd: 0.6, frontalArea: 9, point: [0, 2.6, 2] },
  rudder: { area: 0.85, s: 0.93, xOut: 0.45, y: -0.7, dz: 0.8, depthNorm: 0.8, maxAngle: 0.6, rate: 0.9 },
  contactExtras: [
    [0, -0.2, -HULL_LENGTH / 2 - RAM_LENGTH],
    [0, 0.3, -HULL_LENGTH / 2 - RAM_LENGTH * 0.5],
  ],
  quayStations: triremeQuayStations,
  oars: {
    // 170 seated rowers as an agent crew (docs/trireme-crew-plan.md); 'banks' selects the old scripted
    // RowingSystem, whose fields below the crew are kept for it
    system: 'crew',
    slots: oarSlots,
    crew: TRIREME_CREW,
    bankCount: 3,
    meanPower: [90, 20, 70, 120, 190, 320],
    maxOrder: 5,
    slotEnergy: 640,
    sweepFwd: 0.72,
    sweepBack: -0.58,
    rateScale: 1,
    rateMin: 18,
    rateMax: 46,
    drum: true,
  },
  rig: Object.freeze({
    width: 10,
    height: 7,
    area: 70,
    mastStation: 0.42,
    mastHeight: 11.5,
    yardDrop: 0.7,
    clothTopDrop: 0.1,
    clothOffsetZ: 0.2,
    yardLength: 12.5,
    maxYardAngle: Math.PI / 4,
    sampleCount: 9,
    mastBaseY: triremeDeckY(0.42),
    yardY: triremeDeckY(0.42) + 11.5 - 0.7,
    yardZ: TRIREME_HULL.zOf(0.42),
  }),
  aero: TRIREME_AERO,
  docking: {
    enabled: true,
    cleats: [0.12, 0.4, 0.6, 0.86],
    plankS: 0.62,
    plankReach: 1.6,
    plankLength: 3,
    // the outrigger is widest at 2.65 m: 0.35 m off a quay face 3 m from the berth centre
    gap: 0.35,
    capture: { along: 8, latMin: -0.8, latMax: 4, head: (15 * Math.PI) / 180, sog: 1.3 },
    // deck crew and marines on the lines, with tackle: about 21 kN
    crew: 20,
    tackle: 3,
    lineStrength: 150e3,
    holdPeriod: 1.75,
  },
  anchoringEnabled: true,
  anchor: { s: 0.12, stiffnessScale: 1 },
  buildingEnabled: true,
  camera: { helmS: 0.885, chaseDist: 42, chasePivotUp: 4, dockingDist: 48, titleDist: 58, titleLift: 13 },
  crewSpots: [
    ['fig_marine', 1.05, 0.5, -Math.PI / 2],
    ['fig_marine', -1.1, 0.53, Math.PI / 2],
    ['fig_marine', 0.95, 0.38, -Math.PI / 2],
    ['fig_marine', -1.0, 0.33, Math.PI / 2],
    ['fig_archer', 0.8, 0.2, 0],
    ['fig_archer', -0.75, 0.17, 0],
    ['fig_sailor_idle', 0.2, 0.12, 0],
    ['fig_keleustes', 0.9, 0.66, Math.PI],
  ],
};

// ---------------------------------------------------------------- merchant (Kyrenia type)

const MH = MERCHANT_HULL;
/** milestone 1: a flush working deck 0.3 m below the sheer (the open hold comes in phase 3) */
const merchantDeckY = (s: number) => MH.sheer(s) - 0.3;

const MERCHANT_DECK: ShipDeck = {
  deckY: merchantDeckY,
  deckHalfWidth: (s) => Math.max(0, MH.halfWidthAt(s, merchantDeckY(s)) - 0.12),
  outerHalfWidth: (s) => MH.halfBeam(s),
  s0: 0.06,
  s1: 0.93,
};

/**
 * Mast step just forward of amidships. With the profile lateral plane this leaves moderate lee helm
 * close-hauled (about half helm, leeway 11 degrees at 2.5 kn in 11 m/s) and a near-neutral helm on a
 * beam or broad reach; further aft she is easily taken aback.
 */
const MERCHANT_MAST_S = 0.44;

const merchantQuayStations: number[] = [];
for (let i = 0; i <= 8; i++) merchantQuayStations.push(0.1 + i * 0.1);

export const MERCHANT: ShipDesign = {
  kind: 'merchant',
  name: 'Merchant ship',
  subtitle: 'Merchant ship simulator',
  hull: MH,
  deck: MERCHANT_DECK,
  columns: { stations: 22, strips: 8 },
  // 17.7 t at the design waterline (standard load). Light ship 9 t at 1.35 m above the keel, 6 t gravel
  // at 0.35 m, 3 t amphorae at 0.8 m -> KG 0.93 m above the keel, 0.36 m below the waterline.
  // Fore-aft, the stowage is trimmed so she floats level: CG over the centre of buoyancy.
  mass: { cgY: -0.36, cgZ: -0.205, inertiaScale: [1.1, 1.05, 1.25] },
  hydro: {
    // ITTC-57 x 1.82 matches Rudan et al. 2024 Table A1 (22 t, 1-4.5 kn) within 2%; the wave term
    // is small there and climbs steeply toward hull speed (about 8.9 kn)
    resistance: { kind: 'ittc', formFactor: 1.82, cw0: 0.004, cwExp: 6, astern: 1.4 },
    // submerged plan area x 1.256 = Denny-Mumford wetted area (41.6 m2 at 18 t)
    wettedFactor: 1.256,
    lateralFromProfile: true,
    // column heave damping acts on the centre line (response below), so roll damping is all here:
    // bilge eddy-making and skin friction. Measured (test:seakeeping) at rest: zeta 0.14 for 10->5 deg,
    // 0.10 for 3->1 deg, undamped roll period 2.6 s with added inertia.
    heaveDampQuad: 0.9,
    heaveDampLin: 400,
    angularDamp: 0.6,
    rollDampLin: 12000,
    rollDampQuad: 8000,
    // added mass per column as a fraction of rho V: sway about pi T / (2 beta B) for her sections with a
    // 3D end correction, heave about pi B / (8 beta T) likewise, surge small for L/B 3.4
    response: { ca: [0.7, 1.0, 0.06] },
  },
  // beam windage about 1.4 kN and headwind about 0.45 kN at 12 m/s (plan §4.5)
  windage: { lateralCd: 1.0, lateralArea: 16, frontalCd: 0.6, frontalArea: 8.5, point: [0, 1.3, 0.5] },
  rudder: { area: 0.45, s: 0.88, xOut: 0.3, y: -0.6, dz: 0.3, depthNorm: 0.7, maxAngle: 0.6, rate: 0.9 },
  contactExtras: [
    [0, -MH.keelDepth(0.03), MH.zOf(0.03)],
    [0, MH.sheer(0) * 0.5, MH.zOf(0) - 0.2],
  ],
  quayStations: merchantQuayStations,
  oars: {
    // six standing sweeps worked by an agent crew (docs/merchant-crew-spec.md); the fields below
    // `slots` belong to the trireme's scripted RowingSystem and are not used by the crew
    system: 'crew',
    slots: () => crewSlots(MH, MERCHANT_CREW),
    crew: MERCHANT_CREW,
    bankCount: 1,
    meanPower: [80, 20, 45, 80, 115, 115],
    maxOrder: 4,
    slotEnergy: 900,
    sweepFwd: MERCHANT_CREW.catchMax,
    sweepBack: MERCHANT_CREW.finishMin,
    rateScale: 1,
    rateMin: 12,
    rateMax: 30,
    drum: false,
  },
  rig: Object.freeze({
    width: 9.5,
    height: 7,
    area: 66.5,
    mastStation: MERCHANT_MAST_S,
    mastHeight: 9.5,
    yardDrop: 0.5,
    clothTopDrop: 0.1,
    clothOffsetZ: 0.2,
    yardLength: 11,
    maxYardAngle: Math.PI / 4,
    sampleCount: 9,
    mastBaseY: merchantDeckY(MERCHANT_MAST_S),
    yardY: merchantDeckY(MERCHANT_MAST_S) + 9.5 - 0.5,
    yardZ: MH.zOf(MERCHANT_MAST_S),
  }),
  // milestone 1 uses the trireme's calibration; the merchant gets its own in phase 5
  aero: Object.freeze({ ...TRIREME_AERO }),
  docking: {
    enabled: true,
    cleats: [0.1, 0.38, 0.62, 0.88],
    // aft of the after hatch (s 0.47-0.555): her deck is about 1.2 m below the quay top, so the crew set the
    // plank's foot well inboard and it climbs to the quay edge
    plankS: 0.62,
    // her deck lies about a metre below the quay top: a longer reach keeps the plank walkable
    plankReach: 2.2,
    plankLength: 3.1,
    gap: 0.25,
    // a line's throw (about 7 m) from her side to the quay face; the along range scales with her length
    capture: { along: 4, latMin: -0.3, latMax: 7, head: (25 * Math.PI) / 180, sog: 1.0 },
    // four hands with tackle: about 4.2 kN, three times her beam windage at 12 m/s
    crew: 4,
    tackle: 3,
    lineStrength: 60e3,
    holdPeriod: 1.75,
  },
  anchoringEnabled: true,
  // a third of the trireme's mass, so a third of the rode stiffness and damping (same natural period)
  anchor: { s: 0.08, stiffnessScale: 0.33 },
  // cargo-trade spec §5.3 rev. 2. The reference sits 0.8 m above the keel bottom; z = cgZ is a convention
  // (the design only says the stowage is trimmed level), so the design CG is unchanged.
  cargo: {
    reference: { mass: 3000, local: [0, -0.485, -0.205] },
    hold: { sFrom: 0.28, sTo: 0.72, floorAboveKeel: 0.4, ceilingBelowDeck: 0.1, cell: [0.25, 0.2, 0.5], margin: 0.06, mastClear: 0.3 },
    hatches: [{ s0: 0.31, s1: 0.41 }, { s0: 0.47, s1: 0.555 }],
    hatchHalfWidth: 0.7,
    lip: 0.03,
  },
  buildingEnabled: false,
  camera: { helmS: 0.86, chaseDist: 24, chasePivotUp: 2.5, dockingDist: 30, titleDist: 30, titleLift: 7 },
  // static stand-ins for the six rowers at their stances (src/ship/crew/stance.ts, spec §2.2 measured deviation):
  // on each oar's own side, 0.36 to 0.91 m off the centreline, 0.6 m forward of the pin, facing aft. [x, s] with
  // s the station whose z is the stance's z (literal: stance.ts imports rowing, which imports this module).
  // The two reliefs at their waiting spots.
  crewSpots: [
    ['fig_sailor_idle', -0.355, 0.1265, Math.PI],
    ['fig_sailor_idle', 0.651, 0.2065, Math.PI],
    ['fig_sailor_idle', -0.846, 0.2865, Math.PI],
    ['fig_sailor_idle', 0.905, 0.5765, Math.PI],
    ['fig_sailor_idle', -0.708, 0.6565, Math.PI],
    ['fig_sailor_idle', 0.407, 0.7365, Math.PI],
    ...MERCHANT_CREW.reliefSpots.map(([x, s]): [string, number, number, number] => ['fig_sailor_idle', x, s, x > 0 ? -Math.PI / 2 : Math.PI / 2]),
  ],
};

export const DESIGNS: Record<ShipKind, ShipDesign> = { trireme: TRIREME, merchant: MERCHANT };

/** the ship chosen for this page load: `?ship=` wins, then the remembered choice, else the merchant (the opening) */
export function chosenShipKind(search: string, stored: string | null): ShipKind {
  const q = new URLSearchParams(search).get('ship');
  if (q === 'trireme' || q === 'merchant') return q;
  if (stored === 'trireme' || stored === 'merchant') return stored;
  return 'merchant';
}
