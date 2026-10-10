import { HULL_LENGTH, RAM_LENGTH, deckY as triremeDeckY, halfBeam as triremeHalfBeam, DECK_S0, DECK_S1 } from './hull';
import { TRIREME_HULL, type HullShape } from './hullShape';
import { MERCHANT_HULL } from './merchantHull';
import { oarSlots, type OarSlot } from './oarLayout';

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
  };
  rig: SailRig;
  aero: SailAero;
  /** docking: capture, warping in, gangplank (Mooring) */
  dockingEnabled: boolean;
  /** dropping and weighing the anchor (Mooring) */
  anchoringEnabled: boolean;
  /** ground tackle: station of the bow fairlead the rode runs from, rode stiffness relative to the trireme's */
  anchor: { s: number; stiffnessScale: number };
  /** deck building (DeckBuilder) */
  buildingEnabled: boolean;
  camera: { helmS: number; chaseDist: number; chasePivotUp: number; dockingDist: number; titleDist: number; titleLift: number };
  /** deck crew figures from the model kit: [model name, x, station s, yaw]; model -z faces forward */
  crewSpots: [string, number, number, number][];
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
    slots: oarSlots,
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
  dockingEnabled: true,
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

/** four sweeps worked standing: one each side on the foredeck (s 0.2) and on the afterdeck (s 0.78) */
function merchantSweeps(): OarSlot[] {
  const slots: OarSlot[] = [];
  const length = 5.6, inboard = 1.5, bladeLength = 0.9;
  for (const s of [0.2, 0.78]) {
    for (const side of [-1, 1] as const) {
      slots.push({
        id: slots.length,
        length,
        inboard,
        bladeLength,
        bladeWidth: 0.2,
        bladeThickness: 0.03,
        bladeRadius: length - inboard - bladeLength / 2,
        bank: 0,
        side,
        x: side * (MH.halfBeam(s) + 0.02),
        y: MH.sheer(s) + 0.12,
        z: MH.zOf(s),
        jitter: 0,
      });
    }
  }
  return slots;
}

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
    // the column heave damper also damps roll (plan §2.1), so it is kept light: a 10 degree roll
    // release decays with zeta about 0.16 (0.13 at small angles), period 2.3 s
    heaveDampQuad: 0.9,
    heaveDampLin: 400,
    angularDamp: 0.6,
    rollDampLin: 2000,
    rollDampQuad: 4000,
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
    slots: merchantSweeps,
    bankCount: 1,
    // four standing sweep hands: Full gives about 1.9 kn after a few minutes (Kyrenia II: typically 1.8 kn)
    meanPower: [80, 20, 60, 105, 150, 150],
    maxOrder: 4,
    slotEnergy: 900,
    sweepFwd: 0.72,
    sweepBack: -0.58,
    rateScale: 0.7,
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
  dockingEnabled: false,
  anchoringEnabled: true,
  // a third of the trireme's mass, so a third of the rode stiffness and damping (same natural period)
  anchor: { s: 0.08, stiffnessScale: 0.33 },
  buildingEnabled: false,
  camera: { helmS: 0.86, chaseDist: 24, chasePivotUp: 2.5, dockingDist: 30, titleDist: 30, titleLift: 7 },
  // the four sweep hands, standing inboard of their sweeps and facing aft; the after pair stands
  // forward of the helm and out by the rails so they don't block the helmsman's view
  crewSpots: [
    ['fig_sailor_idle', 0.85, 0.2, Math.PI],
    ['fig_sailor_idle', -0.85, 0.2, Math.PI],
    ['fig_sailor_idle', 1.2, 0.7, Math.PI],
    ['fig_sailor_idle', -1.2, 0.7, Math.PI],
  ],
};

export const DESIGNS: Record<ShipKind, ShipDesign> = { trireme: TRIREME, merchant: MERCHANT };

/** the ship chosen for this page load: `?ship=` wins, then the remembered choice, else the trireme */
export function chosenShipKind(search: string, stored: string | null): ShipKind {
  const q = new URLSearchParams(search).get('ship');
  if (q === 'trireme' || q === 'merchant') return q;
  if (stored === 'trireme' || stored === 'merchant') return stored;
  return 'trireme';
}
