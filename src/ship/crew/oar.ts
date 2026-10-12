import type { OarSlot } from '../oarLayout';
import { nominalDip } from '../rowing';
import { Track, type TrackSample } from './tracks';
import type { CrewRowingParams } from './params';
import type { Hand } from './physiology';

export type OarMode = 'rest' | 'transfer' | 'ready' | 'catch' | 'drive' | 'extract' | 'recover' | 'hold' | 'shipped';
export type TransferTo = 'ready' | 'rest' | 'hold' | 'shipped';

/** a Hermite segment of the servo reference (catch turnaround, extraction braking) */
export interface RefSegment { q0: number; v0: number; q1: number; v1: number; H: number; o: TrackSample }

export interface StrokePlan { arc: number; u: number; thetaC: number; thetaF: number; P: number }

/** per-oar energy audit (J); the oar balance must close (spec §12.1.1) */
export interface OarAudit {
  posWork: number; negWork: number; waterWork: number; numLoss: number; shedKE: number; pickupLoss: number;
  hullWork: number; slipLoss: number; dipWork: number; dipPos: number; dipNeg: number;
}

/** One sweep and its rower's motor state: the physical sweep (theta, omega) and the planned tracks. */
export class Oar {
  theta: number;
  omega = 0;
  readonly dip: Track;
  readonly feather: Track;
  /** servo reference for the sweep outside the drive */
  readonly ref: Track;
  mode: OarMode = 'rest';
  modeT = 0;
  /** activation 0..1 and its command */
  u = 0;
  uCmd = 0;
  /** -1 rowing ahead (theta decreases in the drive), +1 backing */
  dir: -1 | 1 = -1;
  hand: Hand | null = null;
  /** the outgoing man during a handover (his hands follow passively) */
  second: Hand | null = null;
  /** allocation share in [-1, 1] and arc bias in [-1, 1] */
  alloc = 0;
  bias = 0;
  /** manned in a watch (fewer oars than all) */
  watch = false;
  /** the side's oars are to be shipped */
  shipped = false;
  next: TransferTo = 'rest';
  lastArc = 0;
  readonly plan: StrokePlan;
  lastCatch = -Infinity;
  prevCatch = -Infinity;
  /** this rower's own stroke period estimate (s) */
  period = 3;
  strokes = 0;
  driveStart = 0;
  lastDrive = 1.2;
  cycleWork = 0;
  lastCycleP = 0;
  catchAt = Infinity;
  /** seconds this blade has spent holding to check her way (turning, see stroke.ts) */
  checkT = 0;
  retimeClock = 0;
  catchRef: RefSegment | null = null;
  extractRef: RefSegment | null = null;
  /** handle force (N), rower and water generalised moments (N m) at the end of the step */
  Fh = 0;
  Mr = 0;
  Mw = 0;
  stall = 0;
  /** wet fraction of the blade */
  wet = 0;
  contact = false;
  lastContactT = -Infinity;
  /** reading the water: wet-dip trim at the catch, dry-dip lift in chop, surface spread, missed water */
  dipTrim = 0;
  dryLift = 0;
  chopMean = 0;
  chopVar = 0;
  missT = 0;
  missed = false;
  /** effective inertia about the thole (kg m2), a state: it changes as the blade picks up water */
  Ieff: number;
  /** the blade's added inertia within Ieff (kg m2) */
  Iadd = 0;
  /** this oar's hand radius (m), inertia about the thole (kg m2) and blade added mass (kg): its bank's, or the crew's */
  readonly handR: number;
  readonly Ioar: number;
  readonly addedMass: number;
  readonly audit: OarAudit = { posWork: 0, negWork: 0, waterWork: 0, numLoss: 0, shedKE: 0, pickupLoss: 0, hullWork: 0, slipLoss: 0, dipWork: 0, dipPos: 0, dipNeg: 0 };

  constructor(readonly slot: Readonly<OarSlot>, p: CrewRowingParams) {
    this.theta = p.thetaRest;
    this.dip = new Track(nominalDip(slot, false));
    this.feather = new Track(Math.PI / 2);
    this.ref = new Track(p.thetaRest);
    this.plan = { arc: p.arcStart, u: 0.6, thetaC: p.arcStart / 2, thetaF: -p.arcStart / 2, P: 0 };
    const b = p.banks?.[slot.bank];
    this.handR = b ? b.handR : p.handR;
    this.Ioar = b ? b.Ioar : p.Ioar;
    this.addedMass = b ? b.addedMass : p.addedMass;
    this.Ieff = this.Ioar;
  }
  get dDry() { return nominalDip(this.slot, false) - this.dryLift; }
  get dWet() { return nominalDip(this.slot, true); }
  /** relief group: 0 fore, 1 aft */
  get group() { return this.slot.z < 0 ? 0 : 1; }
  setMode(mode: OarMode) { this.mode = mode; this.modeT = 0; }
  /** the hand force he allows himself to swing the oar outside the drive (N): more when asked for more than he can sustain */
  recoveryF(p: CrewRowingParams) { return p.recoveryEffort ? p.servoF * Math.max(1, this.plan.P / p.CP) : p.servoF; }
  /** back to rest instantly (teleport / reset only); physiology and assignments are untouched */
  snapRest(p: CrewRowingParams) {
    this.theta = p.thetaRest; this.omega = 0; this.u = this.uCmd = 0;
    this.dip.snap(this.dDry); this.feather.snap(Math.PI / 2); this.ref.snap(p.thetaRest);
    this.mode = 'rest'; this.modeT = 0; this.catchAt = Infinity; this.checkT = 0; this.strokes = 0;
    this.lastCatch = this.prevCatch = -Infinity; this.catchRef = this.extractRef = null;
    this.Ieff = this.Ioar + (this.hand ? p.mRowerRefl * (this.handR * Math.cos(this.dDry)) ** 2 : 0);
    this.Iadd = 0;
    this.contact = false; this.wet = 0; this.stall = 0;
  }
}
