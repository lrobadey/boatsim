// Runtime rower solver: the production port of docs/merchant-crew/animation-poc/node/rowerIK.mjs.
// The pose is a function of the grip positions plus a few smoothed scalars, never of stroke phase.
// Everything is solved in SHIP-LOCAL space (the parent frame of the figure root).
// Node-safe: imports only 'three'. No DOM, no Math.random, no allocation inside update().
import * as THREE from 'three';

type V3 = THREE.Vector3;
type Q4 = THREE.Quaternion;

/**
 * Bone-name map: the one place to adjust names if the exported rig changes.
 * Keys are the solver's names; values are the glTF node names. 20 bones: no forearm-twist bones.
 */
export const ROWER_BONE_NAMES = {
  root: 'root', pelvis: 'pelvis', spine: 'spine', chest: 'chest', neck: 'neck', head: 'head',
  clavicle_L: 'clavicle_L', upperarm_L: 'upperarm_L', forearm_L: 'forearm_L', hand_L: 'hand_L',
  thigh_L: 'thigh_L', shin_L: 'shin_L', foot_L: 'foot_L',
  clavicle_R: 'clavicle_R', upperarm_R: 'upperarm_R', forearm_R: 'forearm_R', hand_R: 'hand_R',
  thigh_R: 'thigh_R', shin_R: 'shin_R', foot_R: 'foot_R',
} as const;

type BoneKey = keyof typeof ROWER_BONE_NAMES;
const KEYS = Object.keys(ROWER_BONE_NAMES) as BoneKey[];
const N = KEYS.length;
const IX = {} as Record<BoneKey, number>;
KEYS.forEach((k, i) => { IX[k] = i; });

// Solver parent of each bone. The root bone is not written; its world frame is the figure root.
const PARENT: Record<string, string> = { pelvis: 'root', spine: 'pelvis', chest: 'spine', neck: 'chest', head: 'neck' };
for (const s of ['L', 'R']) {
  PARENT[`clavicle_${s}`] = 'chest';
  PARENT[`upperarm_${s}`] = `clavicle_${s}`;
  PARENT[`forearm_${s}`] = `upperarm_${s}`;
  PARENT[`hand_${s}`] = `forearm_${s}`;
  PARENT[`thigh_${s}`] = 'pelvis';
  PARENT[`shin_${s}`] = `thigh_${s}`;
  PARENT[`foot_${s}`] = `shin_${s}`;
}
const PIX: number[] = KEYS.map((k) => (PARENT[k] ? IX[PARENT[k] as BoneKey] : -1));

// Per-side bone indices: 0 = L, 1 = R. SIGN: side sign used by the elbow pole and foot pole.
const CLAV = [IX.clavicle_L, IX.clavicle_R];
const UA = [IX.upperarm_L, IX.upperarm_R];
const FA = [IX.forearm_L, IX.forearm_R];
const HAND = [IX.hand_L, IX.hand_R];
const THIGH = [IX.thigh_L, IX.thigh_R];
const SHIN = [IX.shin_L, IX.shin_R];
const FOOT = [IX.foot_L, IX.foot_R];
const SIGN = [-1, 1];

// Trunk chain: pelvis -> spine -> chest. The reach model and the spine write both use these cumulative
// fractions (HARD RULE 2: one source of truth, so the reach model equals the real spine FK).
const SEG = [IX.pelvis, IX.spine, IX.chest];
const CUM_PF = [0.3, 0.7, 1.0];   // cumulative trunk pitch
const CUM_YF = [0.25, 0.6, 1.0];  // cumulative trunk yaw

const HAND_LEN = 0.094;           // wrist to hand tip, m
const FOOT_LEN = 0.19;            // ankle to toe point along the foot bone's Y, m (matches the test harness)
const ANKLE_H = 0.08;             // planted ankle height above the deck, m
const STANCE_D0 = 0.32;           // handle reach along facing (m) at which the pelvis is centred
const RATIO_MAX = 0.9, RATIO_MIN = 0.5;
const TH_MIN = -0.42, TH_MAX = 0.9, TH_COMFORT = 0.62, TH_UPRIGHT = -0.15;
const DEF_SPLIT_FWD = 0.4, DEF_SPLIT_BACK = 0.3, DEF_WIDTH = 0.16;
const STEP_T = 0.35;              // foot re-planting arc, s
const STEP_LIFT = 0.03;           // peak lift of the re-planting arc, m
const STEP_TRIGGER = 0.10;        // a foot this far from its ideal steps when it may
const SHIFT_MAX = 0.20;           // limit on the fore-aft shift of the ideal feet, m
const POLE_K = 0.3;   // pole guard: weight of pole2's projection added to the pole's (stateless)
const FEATHER_HAND = 0.4;  // share of the loom's feather the hands roll with; the loom turns in the fingers
const LOOM_END_BACK = 0.08, LOOM_FWD = 0.3;  // loom segment around the grips (spec 2.3: end grip 8 cm from the end)
const TRUNK_H = 0.45, TRUNK_R = 0.16 + 0.035;  // trunk capsule (harness radii) plus loom radius
const THIGH_R = 0.10 + 0.035;                                   // thigh capsule plus loom radius
const LOOM_CLEAR = 0.16;      // m, gap kept between this simplified trunk/thigh and the loom; 0.16 here gives >= 0.10 m on the harness capsules (spec 12.3.5)
const REACH_OK = 0.15, REACH_BAND = 0.10;   // reach gate: full below REACH_OK of miss, 0 past + BAND, m
const REACH_ON = 1 / 0.4, REACH_OFF = 1 / 0.2;   // reach gate rates, 1/s: take the loom over 0.4 s, let go within 0.2 s
// wrist lag while the hands let go. The loom's transfer swing at shipping moves the grip 3 to 4 cm a frame; the hand
// trails it by about WRIST_LAG_TAU, so the forearm turns under 10 deg a frame. The lag comes in with (1 - hand weight)
// over WRIST_LAG_BAND, C1, and is zero while the hands are fully on, so held frames are unchanged.
const WRIST_LAG_TAU = 0.04, WRIST_LAG_BAND = 0.1;   // s; hand weight band

function clamp(x: number, a: number, b: number): number { return Math.min(b, Math.max(a, x)); }
function smooth01(x: number): number { const c = clamp(x, 0, 1); return c * c * (3 - 2 * c); }

/** Critically damped spring on a scalar. Stable at any dt. */
class Spring1 {
  v = 0;
  dv = 0;
  snap(t: number): void { this.v = t; this.dv = 0; }
  step(target: number, dt: number, w: number): number {
    const x = this.v - target, k = Math.exp(-w * dt);
    const tmp = (this.dv + w * x) * dt;
    this.v = target + (x + tmp) * k;
    this.dv = (this.dv - w * tmp) * k;
    return this.v;
  }
}

/** Three scalar springs on a vector. */
class Spring3 {
  readonly x = new Spring1();
  readonly y = new Spring1();
  readonly z = new Spring1();
  snap(t: V3): void { this.x.snap(t.x); this.y.snap(t.y); this.z.snap(t.z); }
  step(t: V3, dt: number, w: number, out: V3): V3 {
    return out.set(this.x.step(t.x, dt, w), this.y.step(t.y, dt, w), this.z.step(t.z, dt, w));
  }
}

// ---- module scratch. update() is synchronous and not re-entrant, so shared scratch is safe. Each
// helper below writes only to its own output argument and to scratch named for that helper.
const _m4 = new THREE.Matrix4();
const _fy = new THREE.Vector3(), _fx = new THREE.Vector3(), _fz = new THREE.Vector3();
const _tbD = new THREE.Vector3(), _tbDir = new THREE.Vector3(), _tbP = new THREE.Vector3(), _tbF = new THREE.Vector3();
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();
const _vA = new THREE.Vector3(), _vB = new THREE.Vector3(), _vC = new THREE.Vector3(), _vD = new THREE.Vector3();
const _vE = new THREE.Vector3(), _vF = new THREE.Vector3(), _vG = new THREE.Vector3(), _vH = new THREE.Vector3();
const _vI = new THREE.Vector3(), _vJ = new THREE.Vector3(), _vK = new THREE.Vector3(), _vW = new THREE.Vector3();
const _sh = new THREE.Vector3(), _scale = new THREE.Vector3();
// reach model scratch: procedural and actual trunk segment quats, shoulders
const _dW = [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()];
const _dA = [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()];
const _dQ = [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()];
const _dL = new THREE.Quaternion(), _dCl = new THREE.Quaternion();
const _dP = new THREE.Vector3(), _dX = new THREE.Vector3(), _dY = new THREE.Vector3(), _dK = new THREE.Vector3();
const _dy = new THREE.Vector3(), _dx = new THREE.Vector3();

/** Rotation whose basis is (x, y, z) with y exact and x orthogonalised against y. */
function frameQuat(y: V3, xRef: V3, out: Q4): Q4 {
  _fy.copy(y).normalize();
  _fx.copy(xRef).addScaledVector(_fy, -xRef.dot(_fy));
  if (_fx.lengthSq() < 1e-10) _fx.set(1, 0, 0).addScaledVector(_fy, -_fy.x);
  _fx.normalize();
  _fz.crossVectors(_fx, _fy);
  _m4.makeBasis(_fx, _fy, _fz);
  return out.setFromRotationMatrix(_m4);
}

/**
 * Analytic two-bone IK with soft extension. Writes the joint (elbow or knee) and the end (wrist or ankle).
 * pole: preferred bend direction. pole2: guard pole; its projection, weighted POLE_K, takes over as the pole's
 * own projection shrinks (the reach running along the pole). Pass pole2 = pole for no guard.
 */
function twoBone(S: V3, T: V3, a: number, b: number, pole: V3, soft: number, pole2: V3, outJoint: V3, outEnd: V3): void {
  _tbD.subVectors(T, S);
  let c = _tbD.length();
  const L = a + b;
  _tbDir.copy(_tbD).divideScalar(Math.max(c, 1e-6));
  // soft IK: approach full extension asymptotically instead of snapping straight
  const s0 = L * soft;
  if (c > s0) c = s0 + (L - s0) * (1 - Math.exp(-(c - s0) / (L - s0)));
  c = clamp(c, Math.abs(a - b) + 1e-4, L * 0.9999);
  const cosA = clamp((a * a + c * c - b * b) / (2 * a * c), -1, 1);
  // pole guard (stateless): the bend direction is the pole's projection plus POLE_K times pole2's. When the reach
  // runs along the pole its projection shrinks and pole2's takes over, continuously; no history is kept (the last-
  // frame plane froze in the wrong side: 7 to 11 elbow-forward frames per 40 s).
  const pl = Math.max(pole.length(), 1e-6), p2l = Math.max(pole2.length(), 1e-6);
  const cosP = pole.dot(_tbDir) / pl;
  _tbP.copy(pole).divideScalar(pl).addScaledVector(_tbDir, -cosP);
  _tbF.copy(pole2).divideScalar(p2l).addScaledVector(_tbDir, -pole2.dot(_tbDir) / p2l);
  _tbP.addScaledVector(_tbF, POLE_K);   // bias: takes over smoothly as the pole's own projection shrinks
  if (_tbP.lengthSq() < 1e-8) _tbP.set(0, -1, 0).addScaledVector(_tbDir, _tbDir.y); // last resort
  _tbP.normalize();
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  outJoint.copy(S).addScaledVector(_tbDir, a * cosA).addScaledVector(_tbP, a * sinA);
  outEnd.copy(S).addScaledVector(_tbDir, c);
}

/**
 * Closest points between segments p1-q1 and p2-q2 (Ericson 5.1.9). Writes them to c1, c2; returns the distance.
 */
function segSegClosest(p1: V3, q1: V3, p2: V3, q2: V3, c1: V3, c2: V3): number {
  const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z;
  const d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z;
  const rx = p1.x - p2.x, ry = p1.y - p2.y, rz = p1.z - p2.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
  let s = 0, t = 0;
  if (a <= 1e-12 && e <= 1e-12) { s = 0; t = 0; }
  else if (a <= 1e-12) { s = 0; t = clamp(f / e, 0, 1); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-12) { t = 0; s = clamp(-c / a, 0, 1); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - b * b;
      s = den !== 0 ? clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  c1.set(p1.x + d1x * s, p1.y + d1y * s, p1.z + d1z * s);
  c2.set(p2.x + d2x * t, p2.y + d2y * t, p2.z + d2z * t);
  return c1.distanceTo(c2);
}

/** Stance on the deck, ship-local. */
export interface RowerStance {
  /** Centre of the stance on the deck. This is the anchor the ideal feet are computed around. */
  center: V3;
  /** Horizontal facing of the figure (the direction of its chest). */
  facing: V3;
  /** Deck normal, ship-local. */
  deckUp: V3;
  /** Foot split forward and back, m. Defaults 0.40 and 0.30. */
  splitFwd?: number;
  splitBack?: number;
  /** Lateral half-spacing of the feet, m. Default 0.16. */
  width?: number;
}

/** Per-chain blend: 0 = clip layer, 1 = procedural layer. */
export interface RowerBlend {
  body: number;
  armL: number;
  armR: number;
  legs: number;
  head: number;
}

/** Per-frame input. All vectors are ship-local unless stated. */
export interface RowerRigInput {
  /** Outer grip: the end of the loom, ship-local. */
  gripEnd: V3;
  /** Inner grip: about 45 cm inboard along the loom from gripEnd, ship-local. */
  gripInner: V3;
  /** Unit vector along the loom, ship-local. Sets the hand's roll axis. */
  loomAxis: V3;
  /** Loom feather (roll about loomAxis), rad. Must be continuous across frames. */
  feather: number;
  /** 0..1. Multiplies the arm blend weights, and scales the reach constraints on pelvis and trunk. 0 means hands off the loom. */
  handsOn: number;
  /** Station on the deck. */
  stance: RowerStance;
  /** World up in ship-local, unit. Use the interpolated render pose, not the physics pose. */
  shipUp: V3;
  /** Deck vertical acceleration, m/s^2. Flexes the knees through a spring. */
  heaveAcc: number;
  /** Activation 0..1. Lowers the hips and the head in the drive. */
  effort: number;
  /** True while the blade is loaded. Selects spring speed and posture bias. */
  driving: boolean;
  /** 0..1. Slumps the head. */
  fatigue: number;
  /** Look-at target, ship-local. null looks straight ahead. */
  gazeTarget: V3 | null;
  /** Per-chain blend between the clip layer (0) and the procedural layer (1). */
  blend: RowerBlend;
}

/** Debug and regression metrics from the last update(). Read through RowerRig.metrics. */
export interface RowerMetrics {
  /** Solved wrist to its target, m (same as handErrorL/R). */
  handErrorL: number;
  handErrorR: number;
  /** Toe point movement since the last frame, m. Zero while the foot is re-planting. */
  toeSlideL: number;
  toeSlideR: number;
  /** Trunk pitch used this frame, rad. */
  trunkPitch: number;
  /** Pelvis movement since the last frame, m. */
  pelvisTravel: number;
  /** How far the farther hand is beyond 0.9 of arm length at the used trunk pitch, m. 0 when reachable. */
  reachDeficit: number;
  /** handsOn after the reach gate: what the hands actually do. The animator blends the body only when it is 0. */
  handsEffective: number;
  /** True while the foot is in a re-planting arc. */
  footStepping: { L: boolean; R: boolean };
}

/**
 * The rower solver for one figure. Construct once per figure.
 *
 * Per render frame, call in this order:
 *   1. rig.beginFrame()   resets every bone to its rest local pose (bones a clip does not animate
 *                         must not keep last frame's procedural pose)
 *   2. mixer.update(dt)   the clip layer writes its local poses
 *   3. rig.update(dt, input)   captures the clip layer, solves, and writes the blended local poses
 *
 * update() blends each chain (body, head, legs, arms) between the clip and the procedural pose, computed
 * against the ACTUAL blended parent. The order inside update(): trunk and head, then the arms and legs
 * are solved from the actual blended shoulders and hips, then their chains are blended.
 */
export class RowerRig {
  readonly figureRoot: THREE.Object3D;
  private readonly bones: THREE.Object3D[] = [];
  // rest data in figure space (relative to figureRoot)
  private readonly restPos: V3[] = [];
  private readonly restQ: Q4[] = [];
  private readonly restLocalQ: Q4[] = [];   // rest local rotation of each bone, restored by beginFrame()
  private readonly localPos: V3[] = [];     // rest local position of each bone, restored by beginFrame()
  private readonly offset: Q4[] = [];        // F0^-1 * R0 per bone: maps the rule frame onto the rest pose
  private readonly restRelClav: Q4[] = [];   // chest^-1 * clavicle per side
  private readonly clavLen0: number[] = [0, 0];
  // per-side limb lengths, m: upper arm, forearm, thigh, shin (rowers.py jitters each side by 4 %)
  private readonly UL = [0, 0];
  private readonly LL = [0, 0];
  private readonly TL = [0, 0];
  private readonly SL = [0, 0];

  // smoothing state
  private readonly balance = new Spring3();
  private readonly yawS = new Spring1();
  private readonly dropS = new Spring1();
  private readonly pelvisS = new Spring3();
  private readonly pitchS = new Spring1();
  private readonly headYawS = new Spring1();
  private readonly headPitchS = new Spring1();
  private primed = false;
  private t = 0;
  // seeded phases for breath and head noise (no Math.random)
  private readonly phaseA: number;
  private readonly phaseB: number;
  private readonly phaseC: number;

  // stance planner state (ship-local)
  private readonly planted: V3[] = [new THREE.Vector3(), new THREE.Vector3()];  // ideal feet from the stance input
  private readonly ideal: V3[] = [new THREE.Vector3(), new THREE.Vector3()];    // planted, shifted by the stroke
  private readonly ankle: V3[] = [new THREE.Vector3(), new THREE.Vector3()];    // ankle targets used by the IK
  private readonly stepFrom: V3[] = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly stepTo: V3[] = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly stepT = [-1, -1];                                            // < 0 when not stepping
  private readonly stepping = [false, false];
  private readonly toePrev: V3[] = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly pPrev = new THREE.Vector3();
  private readonly P0 = new THREE.Vector3();
  private anchorD = 0;      // handle reach along facing at the stance anchor (mid-stroke), m
  private haveAnchor = false;
  private catchD = 0;       // handle reach at the most recent catch, m
  private finishD = 0;      // handle reach at the most recent finish, m
  private prevDriving = false;

  // per-frame state, preallocated
  private readonly clipQ: Q4[] = [];
  private readonly clipP = new THREE.Vector3();
  private readonly W: Q4[] = [];             // procedural ship-local world quats per bone (the ideal)
  private readonly AQ: Q4[] = [];            // actual ship-local world quats per bone, after blending
  private readonly X: V3[] = [];             // actual ship-local world positions per bone
  private readonly grip: V3[] = [new THREE.Vector3(), new THREE.Vector3()];     // [L, R] hand targets
  private readonly wg: V3[] = [new THREE.Vector3(), new THREE.Vector3()];       // wrist guesses (reach)
  private readonly wristT: V3[] = [new THREE.Vector3(), new THREE.Vector3()];   // solved wrist targets
  private readonly pelvisClipW = new THREE.Vector3();  // the clip's pelvis position, ship-local world
  private wBodyNow = 0;                                // body blend this frame, used by the reach model
  private readonly shA: V3[] = [new THREE.Vector3(), new THREE.Vector3()];  // actual shoulders from the last reach evaluation
  private readonly segQ: Q4[] = [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()];
  private readonly f = new THREE.Vector3();
  private readonly u = new THREE.Vector3();
  private readonly r = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly fT = new THREE.Vector3();
  private readonly rT = new THREE.Vector3();
  private readonly bodyRight = new THREE.Vector3();
  private readonly bodyFwd = new THREE.Vector3();
  private readonly P = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly pole = new THREE.Vector3();
  private readonly loomA = new THREE.Vector3();
  private readonly loomB = new THREE.Vector3();
  private readonly pole2 = new THREE.Vector3();
  private readonly hd = new THREE.Vector3();
  private readonly wLag = [new THREE.Vector3(), new THREE.Vector3()];   // lagged wrist targets, [left, right] (WRIST_LAG_TAU)
  private readonly chestF = new THREE.Quaternion();
  private readonly cR = new THREE.Vector3();
  private readonly cU = new THREE.Vector3();
  private readonly cF = new THREE.Vector3();
  private readonly el = new THREE.Vector3();
  private readonly wr = new THREE.Vector3();
  private readonly errWrist: number[] = [0, 0];
  private yawNow = 0;
  private reachGate = 1;
  private breath = 0;
  private foldV = 0;
  private readonly _metrics: RowerMetrics = {
    handErrorL: 0, handErrorR: 0, toeSlideL: 0, toeSlideR: 0, trunkPitch: 0, pelvisTravel: 0, reachDeficit: 0, handsEffective: 0,
    footStepping: { L: false, R: false },
  };

  /**
   * figureRoot: the figure's top node, which contains the armature. Its local transform places the figure in
   * the ship. Its parent frame is the ship-local frame that all inputs use.
   * seed: per-figure seed for the breath and head-noise phases.
   * Must be constructed before any mixer writes to the figure. The bones' current poses are taken as rest.
   * Throws if a bone is missing.
   */
  constructor(figureRoot: THREE.Object3D, seed: number) {
    this.figureRoot = figureRoot;
    figureRoot.updateMatrixWorld(true);
    const invFig = new THREE.Matrix4().copy(figureRoot.matrixWorld).invert();
    const byName = new Map<string, THREE.Object3D>();
    figureRoot.traverse((o) => { if ((o as THREE.Bone).isBone && !byName.has(o.name)) byName.set(o.name, o); });
    const missing: string[] = [];
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      const name = ROWER_BONE_NAMES[KEYS[i]];
      const b = byName.get(name);
      this.clipQ.push(new THREE.Quaternion());
      this.W.push(new THREE.Quaternion());
      this.AQ.push(new THREE.Quaternion());
      this.X.push(new THREE.Vector3());
      this.offset.push(new THREE.Quaternion());
      if (!b) { missing.push(name); this.bones.push(new THREE.Object3D()); this.restPos.push(new THREE.Vector3()); this.restQ.push(new THREE.Quaternion()); this.restLocalQ.push(new THREE.Quaternion()); this.localPos.push(new THREE.Vector3()); continue; }
      this.bones.push(b);
      m.multiplyMatrices(invFig, b.matrixWorld).decompose(p, q, s);
      this.restPos.push(p.clone());
      this.restQ.push(q.clone());
      this.restLocalQ.push(b.quaternion.clone());
      this.localPos.push(b.position.clone());
    }
    if (missing.length) throw new Error(`RowerRig: figure is missing bones: ${missing.join(', ')}`);

    const rp = (k: BoneKey): V3 => this.restPos[IX[k]];
    const dist = (a: BoneKey, b: BoneKey): number => rp(a).distanceTo(rp(b));
    for (let side = 0; side < 2; side++) {
      const sfx = side === 0 ? 'L' : 'R';
      this.UL[side] = dist(`upperarm_${sfx}` as BoneKey, `forearm_${sfx}` as BoneKey);
      this.LL[side] = dist(`forearm_${sfx}` as BoneKey, `hand_${sfx}` as BoneKey);
      this.TL[side] = dist(`thigh_${sfx}` as BoneKey, `shin_${sfx}` as BoneKey);
      this.SL[side] = dist(`shin_${sfx}` as BoneKey, `foot_${sfx}` as BoneKey);
    }

    // Rule frames at rest, in figure space (rest figure faces -z, +x is its anatomical right, +y up).
    // Rule y = each bone's own +Y (HARD: taking y from the parent-to-child direction broke the hands).
    // Rule x: clavicle forward; thigh and shin -x (knee hinge); everything else +x.
    const fwd0 = new THREE.Vector3(0, 0, -1), right0 = new THREE.Vector3(1, 0, 0), up0 = new THREE.Vector3(0, 1, 0);
    const F0 = new THREE.Quaternion();
    const xRef = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      const k = KEYS[i];
      if (k.startsWith('clavicle')) xRef.copy(fwd0);
      else if (k.startsWith('thigh') || k.startsWith('shin')) xRef.copy(right0).negate();
      else xRef.copy(right0);
      const y = new THREE.Vector3(0, 1, 0).applyQuaternion(this.restQ[i]);
      frameQuat(y, xRef, F0);
      this.offset[i].copy(F0).invert().multiply(this.restQ[i]);
    }
    for (let side = 0; side < 2; side++) {
      this.restRelClav[side] = new THREE.Quaternion().copy(this.restQ[IX.chest]).invert().multiply(this.restQ[CLAV[side]]);
      this.clavLen0[side] = this.localPos[UA[side]].length();
    }

    // seeded phases (mulberry32)
    let seedState = (seed | 0) >>> 0;
    const rnd = (): number => {
      seedState = (seedState + 0x6d2b79f5) | 0;
      let x = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    this.phaseA = rnd() * Math.PI * 2;
    this.phaseB = rnd() * Math.PI * 2;
    this.phaseC = rnd() * Math.PI * 2;
  }

  /**
   * Restore every bone to its rest local pose. Call once per render frame before the animation mixer
   * updates, so bones that the clip does not animate do not keep the previous frame's procedural pose.
   */
  beginFrame(): void {
    for (let i = 0; i < N; i++) {
      this.bones[i].quaternion.copy(this.restLocalQ[i]);
      this.bones[i].position.copy(this.localPos[i]);
    }
  }

  /** Re-seed the springs and the stance on the next update (use after a teleport or respawn instead of blending). */
  reset(): void {
    this.primed = false;
  }

  /** Distance from the solved left wrist to its target, last update, m. */
  get handErrorL(): number { return this.errWrist[0]; }
  /** Distance from the solved right wrist to its target, last update, m. */
  get handErrorR(): number { return this.errWrist[1]; }
  /** Debug and regression metrics from the last update(). The same object every call; do not keep it. */
  get metrics(): Readonly<RowerMetrics> { return this._metrics; }

  /** Advance one render frame and write the procedural layer into the bones. Call after mixer.update(). */
  update(dt: number, inp: RowerRigInput): void {
    const bones = this.bones;
    const X = this.X, AQ = this.AQ, W = this.W;
    this.t += dt;
    const hReq = clamp(inp.handsOn, 0, 1);
    const hOn = hReq * this.reachGate;   // the reach gate (set in 8d) lags one frame
    const wBody = clamp(inp.blend.body, 0, 1), wHead = clamp(inp.blend.head, 0, 1), wLegs = clamp(inp.blend.legs, 0, 1);
    const wArmL = clamp(inp.blend.armL, 0, 1) * hOn, wArmR = clamp(inp.blend.armR, 0, 1) * hOn;

    // 1. clip layer (written by the mixer): capture it for the per-chain blend
    for (let i = 0; i < N; i++) this.clipQ[i].copy(bones[i].quaternion);
    this.clipP.copy(bones[IX.pelvis].position);
    this.placeRoot();
    this.wBodyNow = wBody;
    this.pelvisClipW.copy(this.clipP).multiply(this.figureRoot.scale).applyQuaternion(AQ[IX.root]).add(X[IX.root]);

    // 2. stance frame and ideal feet, ship-local
    const st = inp.stance;
    const f = this.f.copy(st.facing).normalize();
    const u = this.u.copy(st.deckUp).normalize();
    const r = this.r.crossVectors(f, u).normalize();
    const splitFwd = st.splitFwd ?? DEF_SPLIT_FWD, splitBack = st.splitBack ?? DEF_SPLIT_BACK;
    const width = st.width ?? DEF_WIDTH;
    this.planted[0].copy(st.center).addScaledVector(r, -width).addScaledVector(f, splitFwd).addScaledVector(u, ANKLE_H);
    this.planted[1].copy(st.center).addScaledVector(r, width).addScaledVector(f, -splitBack).addScaledVector(u, ANKLE_H);

    // 3. grips: the hand further along body-right is the right hand
    const dE = _vA.subVectors(inp.gripEnd, st.center).dot(r);
    const dI = _vB.subVectors(inp.gripInner, st.center).dot(r);
    if (dE > dI) { this.grip[1].copy(inp.gripEnd); this.grip[0].copy(inp.gripInner); }
    else { this.grip[1].copy(inp.gripInner); this.grip[0].copy(inp.gripEnd); }
    const rel = _vC.addVectors(inp.gripEnd, inp.gripInner).multiplyScalar(0.5).sub(st.center);
    const d = rel.dot(f), lat = rel.dot(r);

    // 3b. stance re-planting (spec 9.4 step 9). The stance input is the anchor. The recent catch and finish
    // handle reach set the stroke midpoint, and the ideal feet move fore-aft by its drift from the anchor.
    // A planted ankle moves only when it is STEP_TRIGGER from its ideal and the foot may step: the front
    // foot late in the drive (handle past its midpoint), the back foot in the recovery. Otherwise it holds.
    if (!this.primed) { this.catchD = d; this.finishD = d; this.prevDriving = inp.driving; this.haveAnchor = false; }
    if (inp.driving && !this.prevDriving) this.catchD = d;
    if (!inp.driving && this.prevDriving) {
      this.finishD = d;
      // the first complete stroke after the stance is set defines the anchor; the start-up pose does not
      if (!this.haveAnchor) { this.anchorD = 0.5 * (this.catchD + this.finishD); this.haveAnchor = true; }
    }
    this.prevDriving = inp.driving;
    const strokeMid = 0.5 * (this.catchD + this.finishD);
    // the feet travel with the pelvis's fore-aft gain (0.6 of the handle travel, spec 9.4 step 5), so the
    // hip-to-ankle distance stays put. Feet that stayed behind the hips pinned the legs.
    const shift = this.haveAnchor ? clamp(0.6 * (strokeMid - this.anchorD), -SHIFT_MAX, SHIFT_MAX) : 0;
    const lateDrive = inp.driving && d < strokeMid;
    for (let s = 0; s < 2; s++) {
      const ideal = this.ideal[s].copy(this.planted[s]).addScaledVector(f, shift);
      if (!this.primed) { this.ankle[s].copy(ideal); this.stepT[s] = -1; }
      const allowed = s === 0 ? lateDrive : !inp.driving;
      if (this.stepT[s] >= 0) {
        this.stepT[s] += dt;
        if (this.stepT[s] >= STEP_T) { this.stepT[s] = -1; this.ankle[s].copy(this.stepTo[s]); }
        else {
          const e = smooth01(this.stepT[s] / STEP_T);
          const lift = STEP_LIFT * Math.sin(Math.PI * this.stepT[s] / STEP_T);
          this.ankle[s].copy(this.stepFrom[s]).lerp(this.stepTo[s], e).addScaledVector(u, lift);
        }
      } else if (allowed && this.ankle[s].distanceTo(ideal) > STEP_TRIGGER) {
        this.stepFrom[s].copy(this.ankle[s]);
        this.stepTo[s].copy(ideal);
        this.stepT[s] = 0;
      }
      this.stepping[s] = this.stepT[s] >= 0;
    }

    // 4. balance: the trunk keeps 70 % of world vertical against roll, with a lag (spring w 4)
    const upB = _vD.copy(u).lerp(inp.shipUp, 0.7).normalize();
    const up = this.up;
    if (!this.primed) this.balance.snap(upB);
    this.balance.step(upB, dt, 4, up);
    up.normalize();
    const fT = this.fT.copy(f).addScaledVector(up, -f.dot(up)).normalize();
    const rT = this.rT.crossVectors(fT, up);

    // 5. trunk yaw: square the shoulders to the loom (spring w 8)
    const gl = _vE.subVectors(this.grip[1], this.grip[0]);
    gl.addScaledVector(up, -gl.dot(up));
    const yawT = clamp(0.55 * Math.atan2(gl.dot(fT), gl.dot(rT)), -0.6, 0.6) + clamp(0.25 * lat, -0.2, 0.2);
    this.yawNow = this.smooth1(this.yawS, yawT, dt, 8);

    // 6. wrist guesses for the reach model, and breath
    for (let s = 0; s < 2; s++) this.wg[s].copy(this.grip[s]).addScaledVector(up, HAND_LEN * 0.8);
    const n1 = Math.sin(this.t * 1.3 + this.phaseA) * 0.5 + Math.sin(this.t * 0.71 + this.phaseB) * 0.5;
    this.breath = 0.03 * Math.sin(this.t * 2.2 + this.phaseC) - (inp.driving ? 0.02 * inp.effort : 0);

    // 7. pelvis: preferred position from handle reach and height, smoothed (spring w 14 drive / 10 recovery)
    const front = splitFwd * 0.8, back = splitBack * 0.8;
    const x = 0.6 * (d - STANCE_D0);
    let pf = x > 0 ? front * Math.tanh(x / front) : back * Math.tanh(x / back);
    const pl = clamp(0.3 * lat, -0.1, 0.1);
    const tilt = _vF.subVectors(up, u);
    const base = _vG.copy(st.center).addScaledVector(r, pl).addScaledVector(u, 0.94 - 0.03).addScaledVector(tilt, 0.45);
    const spread = pf > 0 ? pf / front : -pf / back;
    const dropTarget = 0.035 * inp.effort + 0.10 * spread * spread + 0.01 * clamp(inp.heaveAcc, -3, 3);
    const drop = this.smooth1(this.dropS, dropTarget, dt, 9);
    const target = _vH.copy(base).addScaledVector(fT, pf).addScaledVector(u, -drop);
    if (!this.primed) this.pelvisS.snap(target);
    const P = this.P.copy(this.pelvisS.step(target, dt, inp.driving ? 14 : 10, _vI));

    // 8. trunk pitch preference (spring w 10). Bounded by reach below.
    const catchness = smooth01((d - 0.1) / 0.9);
    const thPref = this.smooth1(this.pitchS, -0.22 + 0.72 * catchness + (inp.driving ? -0.12 * inp.effort : 0.05), dt, 10);

    // HARD RULE 1: reach constraints run AFTER the smoothing springs and are not smoothed themselves.
    // They are continuous in the handle position, so applying them instantly cannot pop.
    // They scale with handsOn: with the hands off, the trunk and pelvis stop chasing the loom.
    // 8a. pelvis: legs make up what a lean can't. Toward the handle at the catch, away at the finish.
    const over = this.demand(P, TH_COMFORT);
    let comp = 0;
    if (over > 0) comp = Math.min(front + 0.12 - pf, over * 1.1);
    else {
      const under = this.fold(P, TH_UPRIGHT);
      if (under < 0) comp = Math.max(-back - 0.1 - pf, under * 0.8);
    }
    // the reach constraints are solved for the hands fully on (P, thReach); the result is blended toward the
    // preference (P0, th0) by handsOn below, so the full-hands posture, and the reach gate measured on it,
    // do not depend on the gate itself (scaling inside fed back: the gate held the hands off for seconds)
    const P0 = this.P0.copy(P);
    P.addScaledVector(fT, comp);
    pf += comp;
    // 8a2. loom keep-out (unsmoothed, continuous in the inputs). The loom runs from LOOM_END_BACK behind the end
    // grip to LOOM_FWD past the inner one. The trunk is the segment pelvis -> pelvis + up * TRUNK_H, leant by the
    // preferred pitch. Push the pelvis horizontally away until the gap is LOOM_CLEAR, within the back-foot range.
    {
      this.loomA.copy(inp.gripEnd).addScaledVector(this.axis.copy(inp.loomAxis).normalize(), -LOOM_END_BACK);
      this.loomB.copy(inp.gripInner).addScaledVector(this.axis, LOOM_FWD);
      for (let it = 0; it < 2; it++) {
        const top = _vJ.copy(up).applyQuaternion(this.rotSeg(this.segQ[2], 2, thPref)).multiplyScalar(TRUNK_H).add(P);
        let gap = segSegClosest(P, top, this.loomA, this.loomB, _vK, _vC) - TRUNK_R;
        // the front thigh: hip to the knee's rough place (halfway to the planted front ankle)
        const hip = _vJ.copy(P).addScaledVector(r, -0.1);
        const knee = _vD.copy(this.ankle[0]).sub(hip).multiplyScalar(0.5).add(hip);
        const gapL = segSegClosest(hip, knee, this.loomA, this.loomB, _vE, _vF) - THIGH_R;
        if (gapL < gap) { gap = gapL; _vK.copy(_vE); _vC.copy(_vF); }
        if (gap >= LOOM_CLEAR) break;
        _vK.sub(_vC).addScaledVector(u, -_vK.dot(u));          // away from the loom, horizontal
        if (_vK.lengthSq() < 1e-8) _vK.copy(fT).negate();
        _vK.normalize();
        const push = Math.min(LOOM_CLEAR - gap, Math.max(0, back + 0.1 + pf));
        P.addScaledVector(_vK, push);
        pf -= push * Math.max(0, -_vK.dot(fT));
      }
    }
    // 8b. both legs stay reachable: cap pelvis height above each planted ankle
    for (let s = 0; s < 2; s++) {
      const hip = _vJ.copy(P).addScaledVector(r, SIGN[s] * 0.1).addScaledVector(u, -0.02);
      const dv = _vK.subVectors(hip, this.ankle[s]);
      const vert = dv.dot(u), horiz2 = dv.lengthSq() - vert * vert;
      const Lmax = (this.TL[s] + this.SL[s]) * 0.985;
      const maxV = Math.sqrt(Math.max(0, Lmax * Lmax - horiz2));
      if (vert > maxV) P.addScaledVector(u, maxV - vert);
    }

    // 8c. trunk pitch: bounded by reach. Bisection, 12 steps each way, then scaled by handsOn.
    // The search range widens as the body blend drops: the actual trunk is clip + wBody * (th - clip), so a
    // procedural pitch of TH_MAX / wBody is needed to reach the same actual lean.
    const thHi = TH_MAX, thLo = TH_MIN;
    const th0 = clamp(thPref, thLo, thHi);
    // demand falls and fold falls as the trunk leans forward (th up). thD: the least lean at which the far hand is
    // within RATIO_MAX; thF: the most lean at which the near hand is outside RATIO_MIN. th = th0 clamped to
    // [thD, thF]; if they cross (only outside the stroke, e.g. unshipping) the midpoint. Every branch is continuous
    // in the inputs, so the trunk cannot jump between the two bounds (it did: 60 deg in one frame).
    let thD = thLo, thF = thHi;
    if (this.demand(P, thLo) > 0) {
      if (this.demand(P, thHi) > 0) thD = thHi;
      else { let lo = thLo, hi = thHi; for (let i = 0; i < 12; i++) { const mid = 0.5 * (lo + hi); if (this.demand(P, mid) > 0) lo = mid; else hi = mid; } thD = hi; }
    }
    if (this.fold(P, thHi) < 0) {
      if (this.fold(P, thLo) < 0) thF = thLo;
      else { let lo = thLo, hi = thHi; for (let i = 0; i < 12; i++) { const mid = 0.5 * (lo + hi); if (this.fold(P, mid) < 0) hi = mid; else lo = mid; } thF = lo; }
    }
    const thReach = thD <= thF ? clamp(th0, thD, thF) : 0.5 * (thD + thF);
    // reach gate: the miss at the full-hands posture, the far wrist beyond 0.9 of its reach. The soft IK covers the
    // last 10 % (about 5 cm), so it is 1 below REACH_OK of miss and 0 past REACH_OK + REACH_BAND. Rate limited:
    // the hands take the loom over 1/REACH_ON s and let go within 1/REACH_OFF s.
    const miss = Math.max(0, this.demand(P, thReach));
    const gateT = 1 - smooth01((miss - REACH_OK) / REACH_BAND);
    if (!this.primed) this.reachGate = gateT;
    else this.reachGate += clamp(gateT - this.reachGate, -REACH_OFF * dt, REACH_ON * dt);
    // blend the posture toward the preference as the hands come off, then keep both legs reachable again
    const th = th0 + (thReach - th0) * hOn;
    P.sub(P0).multiplyScalar(hOn).add(P0);
    for (let s = 0; s < 2; s++) {
      const hip = _vJ.copy(P).addScaledVector(r, SIGN[s] * 0.1).addScaledVector(u, -0.02);
      const dv = _vK.subVectors(hip, this.ankle[s]);
      const vert = dv.dot(u), horiz2 = dv.lengthSq() - vert * vert;
      const Lmax = (this.TL[s] + this.SL[s]) * 0.985;
      const maxV = Math.sqrt(Math.max(0, Lmax * Lmax - horiz2));
      if (vert > maxV) P.addScaledVector(u, maxV - vert);
    }

    // 9. trunk: procedural spine frames (ideal), then the actual blended write. The root is not written: it
    // keeps the clip's pose, and the actual root frame is the parent of the pelvis.
    for (let k = 0; k < 3; k++) {
      const q = this.rotSeg(this.segQ[k], k, th);
      const y = _vA.copy(up).applyQuaternion(q);
      const xr = _vB.copy(rT).applyQuaternion(q);
      frameQuat(y, xr, W[SEG[k]]).multiply(this.offset[SEG[k]]);
    }
    // pelvis position: procedural P, blended with the clip. The local is the actual root frame's inverse.
    const rootInvQ = _qa.copy(AQ[IX.root]).invert();
    const pelvisLocal = _vB.subVectors(P, X[IX.root]).applyQuaternion(rootInvQ);
    _scale.copy(this.figureRoot.scale);
    pelvisLocal.set(pelvisLocal.x / _scale.x, pelvisLocal.y / _scale.y, pelvisLocal.z / _scale.z);
    bones[IX.pelvis].position.copy(this.clipP).lerp(pelvisLocal, wBody);
    for (let k = 0; k < 3; k++) { this.writeBone(SEG[k], wBody); this.placeBone(SEG[k]); }

    // body frame after trunk yaw (head, arms, pole)
    const yawTot = this.yawNow * CUM_YF[2];
    this.bodyRight.copy(rT).applyQuaternion(_qb.setFromAxisAngle(up, yawTot));
    this.bodyFwd.copy(fT).applyQuaternion(_qb.setFromAxisAngle(up, yawTot));
    const bodyRight = this.bodyRight, bodyFwd = this.bodyFwd;

    // 10. head: look-at within neck limits, 35 % neck / 65 % head. Slumps with fatigue. Solved from the
    // actual chest, then blended.
    this.placeBone(IX.neck);
    // the actual chest's rule frame: x = its right, y = its up, -z = its forward (whatever the body blend)
    const Fc = this.chestF.copy(AQ[IX.chest]).multiply(_qa.copy(this.offset[IX.chest]).invert());
    const cR = this.cR.set(1, 0, 0).applyQuaternion(Fc), cU = this.cU.set(0, 1, 0).applyQuaternion(Fc);
    const cF = this.cF.set(0, 0, -1).applyQuaternion(Fc);
    const g = _vA;
    if (inp.gazeTarget) g.copy(inp.gazeTarget).sub(X[IX.neck]);
    else g.copy(cF).multiplyScalar(2).addScaledVector(cU, 2 * Math.tan(th * this.wBodyNow));   // level ahead
    const gf = g.dot(cF), gr = g.dot(cR), gu = g.dot(cU);
    const hyT = clamp(Math.atan2(-gr, gf), -1.2, 1.2);
    // elevation in the chest frame, + above. The head takes 60 % of it (the eyes do the rest), so a level target
    // with the trunk leant by th leaves the head 0.4 th down (as the PoC). Effort and fatigue drop the chin.
    const elev = Math.atan2(gu, Math.hypot(gf, gr));
    const hpT = clamp(-0.6 * elev + (inp.driving ? 0.12 * inp.effort : 0) + 0.15 * inp.fatigue, -0.5, 0.6);
    const hy = this.smooth1(this.headYawS, hyT, dt, 6);
    const hp = this.smooth1(this.headPitchS, hpT + 0.03 * n1, dt, 6);
    this.headFrameRel(IX.neck, hp * 0.35, hy * 0.35);
    this.writeBone(IX.neck, wHead);
    this.headFrameRel(IX.head, hp, hy);
    this.writeBone(IX.head, wHead);
    this.placeBone(IX.head);

    // 11. arms: clavicle, analytic two-bone IK from the actual shoulder, hand frame
    const ax = this.axis.copy(inp.loomAxis).normalize();   // instance field: scratch vectors below overwrite _vE
    for (let s = 0; s < 2; s++) {
      const iC = CLAV[s], iU = UA[s], iF = FA[s], iH = HAND[s];
      const grip = this.grip[s];
      const wArm = s === 0 ? wArmL : wArmR;
      this.placeBone(iC);
      // hand direction: from over the loom, wrapping it (overhand), tilted 35 % toward down, rolled by the feather
      const hd = this.hd.subVectors(grip, X[iC]);
      hd.addScaledVector(ax, -hd.dot(ax)).normalize();
      hd.lerp(_vA.copy(up).negate(), 0.35).addScaledVector(ax, -hd.dot(ax)).normalize();
      hd.applyAxisAngle(ax, FEATHER_HAND * inp.feather);
      // wrist target: the grip, lagged while the hands let go (WRIST_LAG_TAU, weight from hReq; see the constants)
      const rawW = _vW.copy(grip).addScaledVector(hd, -HAND_LEN);
      const lagW = this.wLag[s];
      if (!this.primed) lagW.copy(rawW);
      else lagW.lerp(rawW, 1 - Math.exp(-dt / WRIST_LAG_TAU));
      const wristT = this.wristT[s].copy(rawW).lerp(lagW, smooth01((1 - hReq) / WRIST_LAG_BAND));
      // clavicle: protracts toward far targets, up to 25 % when the reach ratio exceeds 0.85
      const armLen = this.UL[s] + this.LL[s];
      _qc.copy(AQ[IX.chest]).multiply(this.restRelClav[s]);
      const restClavY = _vB.set(0, 1, 0).applyQuaternion(_qc);
      const clavLen = this.clavLen0[s] * this.figureRoot.scale.x;
      _sh.copy(X[iC]).addScaledVector(restClavY, clavLen);
      const need = _sh.distanceTo(wristT) / armLen;
      const kc = smooth01((need - 0.85) / 0.2) * 0.25;
      const clavY = _vC.copy(restClavY).lerp(_vD.subVectors(wristT, X[iC]).normalize(), kc).normalize();
      frameQuat(clavY, bodyFwd, W[iC]).multiply(this.offset[iC]);
      this.writeBone(iC, wArm);
      this.placeBone(iU);   // actual shoulder
      // elbow pole. HARD RULE 3: 0.5*out - 0.2*up - 0.85*back. It must point where the hands never go.
      const pole = this.pole.copy(bodyRight).multiplyScalar(SIGN[s] * 0.5).addScaledVector(up, -0.2).addScaledVector(bodyFwd, -0.85);
      const el = this.el, wr = this.wr;
      // fallback pole: elbow down and out (the arm never reaches straight down-and-out while pulling a loom)
      const pole2 = this.pole2.copy(up).multiplyScalar(-1).addScaledVector(bodyRight, SIGN[s] * 0.4);
      twoBone(X[iU], wristT, this.UL[s], this.LL[s], pole, 0.97, pole2, el, wr);
      const uDir = _vE.subVectors(el, X[iU]).normalize();
      const lDir = _vF.subVectors(wr, el).normalize();
      const hinge = _vG.crossVectors(uDir, lDir);
      if (hinge.lengthSq() < 1e-6) hinge.crossVectors(uDir, _vH.copy(pole).negate()); // straight arm: from pole
      hinge.normalize();
      frameQuat(uDir, hinge, W[iU]).multiply(this.offset[iU]);
      this.writeBone(iU, wArm);
      frameQuat(lDir, hinge, W[iF]).multiply(this.offset[iF]);
      this.writeBone(iF, wArm);
      this.placeBone(iF);   // actual elbow
      this.placeBone(iH);   // actual wrist
      // hand: y along hd, x = loom axis, signed toward body-right
      const sgn = Math.sign(ax.dot(bodyRight)) || 1;
      frameQuat(hd, _vI.copy(ax).multiplyScalar(sgn), W[iH]).multiply(this.offset[iH]);
      this.writeBone(iH, wArm);
      this.errWrist[s] = wr.distanceTo(wristT);
    }

    // 12. legs: planted ankles, two-bone IK from the actual hip, heel lift when the leg runs out of length
    for (let s = 0; s < 2; s++) {
      const iT = THIGH[s], iS = SHIN[s], iFt = FOOT[s];
      this.placeBone(iT);
      const ankle = _vA.copy(this.ankle[s]);
      const toe = _vB.copy(ankle).addScaledVector(f, 0.17).addScaledVector(u, -0.05);
      const Lleg = this.TL[s] + this.SL[s];
      let heel = 0; // heel-lift amount (rad) is folded into the ankle position below
      for (let i = 0; i < 2; i++) {
        const dist = X[iT].distanceTo(ankle);
        if (dist <= Lleg * 0.99) break;
        heel += Math.min(0.6, (dist - Lleg * 0.99) / 0.17);
        const off = _vC.subVectors(this.ankle[s], toe);
        const sg = Math.sign(off.dot(f));
        ankle.copy(toe).add(off.applyAxisAngle(r, heel * sg));
      }
      const pole2 = _vD.copy(f).addScaledVector(r, SIGN[s] * 0.15);
      const kn = _vE, an = _vF;
      // legs: no guard (the knee pole, forward, never runs along hip-to-ankle); pole2 = pole disables it
      twoBone(X[iT], ankle, this.TL[s], this.SL[s], pole2, 0.985, pole2, kn, an);
      const uDir = _vG.subVectors(kn, X[iT]).normalize();
      const lDir = _vH.subVectors(an, kn).normalize();
      const hinge = _vI.crossVectors(uDir, lDir);
      if (hinge.lengthSq() < 1e-6) hinge.crossVectors(uDir, pole2);
      hinge.normalize();
      frameQuat(uDir, hinge, W[iT]).multiply(this.offset[iT]);
      this.writeBone(iT, wLegs);
      frameQuat(lDir, hinge, W[iS]).multiply(this.offset[iS]);
      this.writeBone(iS, wLegs);
      this.placeBone(iS);
      this.placeBone(iFt);
      frameQuat(_vJ.subVectors(toe, an).normalize(), r, W[iFt]).multiply(this.offset[iFt]);
      this.writeBone(iFt, wLegs);
    }

    // 13. metrics
    const m = this._metrics;
    m.handErrorL = this.errWrist[0];
    m.handErrorR = this.errWrist[1];
    m.trunkPitch = th;
    m.pelvisTravel = this.primed ? P.distanceTo(this.pPrev) : 0;
    this.pPrev.copy(P);
    m.reachDeficit = Math.max(0, this.demand(P, th));
    m.handsEffective = hOn;
    m.footStepping.L = this.stepping[0];
    m.footStepping.R = this.stepping[1];
    for (let s = 0; s < 2; s++) {
      const iFt = FOOT[s];
      const toeNow = _vK.set(0, FOOT_LEN, 0).applyQuaternion(AQ[iFt]).add(X[iFt]);
      const slide = this.primed && !this.stepping[s] ? toeNow.distanceTo(this.toePrev[s]) : 0;
      this.toePrev[s].copy(toeNow);
      if (s === 0) m.toeSlideL = slide; else m.toeSlideR = slide;
    }
    this.primed = true;
  }

  // ---- internals -------------------------------------------------------------------------------

  private smooth1(s: Spring1, target: number, dt: number, w: number): number {
    if (!this.primed) s.snap(target);
    return s.step(target, dt, w);
  }

  /** The actual figure root frame: the figure's own transform times the root bone's current local pose. */
  private placeRoot(): void {
    const fr = this.figureRoot;
    this.AQ[IX.root].copy(fr.quaternion).multiply(this.bones[IX.root].quaternion);
    this.X[IX.root].copy(this.bones[IX.root].position).multiply(fr.scale).applyQuaternion(fr.quaternion).add(fr.position);
  }

  /**
   * Writes bone i's local rotation. The procedural world W[i] is expressed against the ACTUAL world rotation of
   * its parent, so the bone lands on W[i] when the blend is 1 whatever the parent's blend is. Then the bone is
   * blended with the clip and its actual world rotation is stored in AQ[i].
   */
  private writeBone(i: number, w: number): void {
    const bone = this.bones[i];
    const pq = this.AQ[PIX[i]];
    if (w > 0) {
      _qa.copy(pq).invert().multiply(this.W[i]);
      bone.quaternion.copy(this.clipQ[i]).slerp(_qa, w);
    } else bone.quaternion.copy(this.clipQ[i]);
    this.AQ[i].copy(pq).multiply(bone.quaternion);
  }



  /**
   * Neck or head: pitch (+ = chin down) and yaw (+ = to the left) on top of the ACTUAL chest frame (cR, cU),
   * then the rule frame. At rest the neck and head rule frames equal the chest's, so 0, 0 is the rest pose.
   */
  private headFrameRel(bone: number, pitch: number, yaw: number): void {
    _qb.setFromAxisAngle(this.cU, yaw);
    _qc.setFromAxisAngle(this.cR, -pitch);
    _qb.multiply(_qc);
    _vB.copy(this.cU).applyQuaternion(_qb);
    _vC.copy(this.cR).applyQuaternion(_qb);
    frameQuat(_vB, _vC, this.W[bone]).multiply(this.offset[bone]);
  }

  /** Actual ship-local position of bone i from its actual parent frame and its current local position (the real FK). */
  private placeBone(i: number): void {
    const p = PIX[i];
    const lp = _vA.copy(this.bones[i].position).multiply(this.figureRoot.scale);
    lp.applyQuaternion(this.AQ[p]).add(this.X[p]);
    this.X[i].copy(lp);
  }

  /**
   * Cumulative rotation of trunk segment k for trunk pitch th: Rup(yaw) * Rright(-pitch).
   * Shared by the spine write and the reach model (HARD RULE 2).
   */
  private rotSeg(out: Q4, k: number, th: number): Q4 {
    const pitch = th * CUM_PF[k] + (k === 2 ? this.breath : 0);
    _qb.setFromAxisAngle(this.up, this.yawNow * CUM_YF[k]);
    _qc.setFromAxisAngle(this.rT, -pitch);
    return out.copy(_qb).multiply(_qc);
  }



  /**
   * Closed-form reach model. Evaluates the ACTUAL blended trunk for pelvis Pp and trunk pitch theta: each segment
   * is the clip local blended with the procedural local (the same blend as the write), so the shoulders are the
   * real FK of what will be written. At body blend 1 this is the procedural spine exactly (HARD RULE 2).
   * Returns how far the farther arm is beyond RATIO_MAX of its own arm length.
   * Sets foldV to how far the nearer arm is folded inside RATIO_MIN of its own arm length.
   */
  private demand(Pp: V3, theta: number): number {
    this.actualShoulders(Pp, theta);
    let worst = -1e9, near = 1e9;
    for (let s = 0; s < 2; s++) {
      const armLen = this.UL[s] + this.LL[s];
      const dd = this.shA[s].distanceTo(this.wg[s]);
      worst = Math.max(worst, dd - RATIO_MAX * armLen);
      near = Math.min(near, dd - RATIO_MIN * armLen);
    }
    this.foldV = near;
    return worst;
  }

  /** Procedural ship-local world quat of trunk segment k at trunk pitch th (the same form as the spine write). */
  private procSegQ(k: number, th: number, out: Q4): Q4 {
    const q = this.rotSeg(this.segQ[k], k, th);
    _dy.copy(this.up).applyQuaternion(q);
    _dx.copy(this.rT).applyQuaternion(q);
    return frameQuat(_dy, _dx, out).multiply(this.offset[SEG[k]]);
  }

  /** Fills shA with the actual shoulder positions for pelvis Pp and trunk pitch theta (see demand). */
  private actualShoulders(Pp: V3, theta: number): void {
    const w = this.wBodyNow, AQ = this.AQ, lp = this.localPos, sc = this.figureRoot.scale;
    // the actual pelvis is linear in the procedural one: the clip pelvis blended with Pp
    const Pa = _dP.copy(this.pelvisClipW).multiplyScalar(1 - w).addScaledVector(Pp, w);
    // pelvis, spine, chest: actual world quats, each the clip local blended with the procedural local
    let parent = AQ[IX.root];
    for (let k = 0; k < 3; k++) {
      this.procSegQ(k, theta, _dW[k]);
      _dL.copy(parent).invert().multiply(_dW[k]);
      _dA[k].copy(this.clipQ[SEG[k]]).slerp(_dL, w);
      _dQ[k].copy(parent).multiply(_dA[k]);
      parent = _dQ[k];
    }
    // spine and chest origins, then clavicle and upper arm (the clavicle keeps its rest pose relative to the chest)
    const Xs = _dX.copy(lp[IX.spine]).multiply(sc).applyQuaternion(_dQ[0]).add(Pa);
    const Xc = _dY.copy(lp[IX.chest]).multiply(sc).applyQuaternion(_dQ[1]).add(Xs);
    for (let s = 0; s < 2; s++) {
      const K = _dK.copy(lp[CLAV[s]]).multiply(sc).applyQuaternion(_dQ[2]).add(Xc);
      _dCl.copy(_dQ[2]).multiply(this.restRelClav[s]);
      this.shA[s].copy(lp[UA[s]]).multiply(sc).applyQuaternion(_dCl).add(K);
    }
  }

  private fold(Pp: V3, theta: number): number {
    this.demand(Pp, theta);
    return this.foldV;
  }
}
