import * as THREE from 'three';
import type { Berth, HarbourLayout } from '../world/harbour';
import type { ShipPhysics } from './physics';
import type { BoxSolid } from '../world/walkable';
import type { DockingDesign, ShipDesign } from './design';

/**
 * Lines, gangplank and anchor: two independent state machines, so she can lie to her anchor and
 * warp in to a quay at the same time. All forces go through ShipPhysics.addForceAtPublic /
 * addTorquePublic during ShipPhysics.step.
 *
 * Lines: none -> out (the crew throws, about 1 s) -> hauling -> docked -> casting -> none.
 * Hauling is force-based: each cleat is servoed toward its berthed position, with feed-forward of the
 * measured wind and wave load, and the whole haul is capped by what the crew can pull. When they
 * can't win, the lines hold her where she is (stalled) until the load eases.
 * Docked is a PD force hold at the CG on horizontal position and yaw, with a small soft deadband;
 * heave, roll and pitch stay physical. A sustained overload makes the crew ease the lines (back to
 * hauling). Cast off raises the plank, lets go and shoves her clear.
 *
 * Anchor: stowed -> dropping -> holding -> weighing -> lifting -> stowed.
 */
export type LinePhase = 'none' | 'out' | 'hauling' | 'docked' | 'casting';
export type AnchorPhase = 'stowed' | 'dropping' | 'holding' | 'weighing' | 'lifting';

export interface ApproachInfo {
  berth: Berth;
  /** horizontal distance ship CoG -> berth centre (m) */
  dist: number;
  /** where this ship's CoG lies when docked at this berth (world xz) */
  poseX: number;
  poseZ: number;
  /** signed offset of the ship centre from the docked pose along the pier axis (m) */
  along: number;
  /** distance off the docked pose: + = too far out, - = pressing the quay (m) */
  lateral: number;
  /** smallest angle to either allowed heading (rad, >= 0) */
  headingErr: number;
  /** velocity toward the pier face (m/s, + = closing) */
  closing: number;
  /** speed over ground (m/s) */
  sog: number;
  /** which side of the ship faces the pier: -1 port, +1 starboard */
  side: -1 | 1;
  /** true when bow points seaward along the pier (+a) */
  bowOut: boolean;
  canMakeFast: boolean;
  /** the single most important reason it can't, in plain words; null when it can */
  reason: string | null;
  /** 0..1 overall approach quality for colour coding */
  quality: number;
}

export interface MooringLine {
  /** cleat, ship-local */
  local: THREE.Vector3;
  /** bollard, world */
  anchor: THREE.Vector3;
  /** 0..1 for visuals (sag when slack) */
  tension: number;
  /** 0..1 progress of the throw: the line's end flies from the cleat to the bollard */
  deploy: number;
}

export interface Gangplank {
  /** deck station of the plank opening */
  station: number;
  /** ship side facing the quay */
  side: -1 | 1;
  /** 0 stowed .. 1 resting on the quay */
  deployed: number;
  /** the plank's foot on deck, where the crew set it (ship-local); it rides with the ship */
  deckLocal: THREE.Vector3;
  /** the plank's far end (world): over the quay when it rests there, swung up while stowed */
  shoreWorld: THREE.Vector3;
  width: number;
  /** plank length (m); its top surface runs straight from deckLocal to shoreWorld */
  length?: number;
  /** true when it lies on the quay with enough bearing to walk on; absent = true (simple test planks) */
  resting?: boolean;
  /** where it bears on the quay (world): the quay's top edge, or its end on the quay top */
  restWorld?: THREE.Vector3;
}

export type MooringEvent =
  | { type: 'lines-out'; berth: Berth }
  | { type: 'docked'; rating: 'Perfect' | 'Good' | 'Rough'; contactSpeed: number }
  | { type: 'haul-stalled'; reason: string }
  | { type: 'haul-resumed' }
  | { type: 'lines-eased' }
  | { type: 'casting-off' }
  | { type: 'cast-off' }
  | { type: 'bump'; speed: number }
  | { type: 'anchor-down' }
  | { type: 'anchor-weighing' }
  | { type: 'anchor-up' }
  | { type: 'plank'; down: boolean }
  | { type: 'denied'; reason: string };

const DEG = Math.PI / 180;
const KNOTS = 1.943844;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** soft deadband: about zero inside +-d, e -/+ d well outside it, smooth in between */
const softDead = (e: number, d: number) => e - d * Math.tanh(e / d);

const NEAR = 220;
const THROW_TIME = 1;
/** pull one hand puts on a line (N) */
const HAND_FORCE = 350;
/**
 * speed: the crew's top hauling speed; rate: line speed per metre still to go, so she eases in;
 * tau: servo time constant; ramp: lines come taut over this long; envTau: filter on the measured load;
 * stallAfter: seconds at the crew's limit without closing before the haul is called stalled;
 * resume: the load must fall below this share of the crew's pull, for resumeAfter seconds
 */
const HAUL = { speed: 0.5, rate: 0.4, slack: 0.1, tau: 1.2, ramp: 1.5, envTau: 1.5, stallAfter: 4, closing: 0.03, resume: 0.8, resumeAfter: 2 };
/** docked once within err / head / sog for settle seconds (or nearly there after `late` s of hauling) */
const DOCK = { err: 0.45, head: 4 * DEG, sog: 0.4, settle: 1, late: 40, lateErr: 1, deadband: 0.15, deadHead: 3 * DEG, overTau: 1, easeAfter: 2 };
const STALL_REASON = 'Wind too strong to haul in · lines holding';
const PHASE_LABEL = { out: 'Lines out', hauling: 'Hauling in', docked: 'Docked', casting: 'Casting off' } as const;
/** fall/haul/lift in m/s; breakout = horizontal rode length at which the anchor breaks out of the seabed */
const ANCHOR = { k: 18e3, c: 12e3, clamp: 60e3, rode: 14, fall: 2.5, haul: 1.2, lift: 1.5, breakout: 1.5, sog: 1.5 };
/**
 * width (m); rate: deploy per second; maxSlope: the steepest climb the crew will set it at; bearing: the
 * least run past the quay edge (m) it needs to be walked on; edgeInset: its foot at least this far inboard
 */
const PLANK = { width: 0.7, rate: 0.5, maxSlope: (28 * Math.PI) / 180, bearing: 0.15, edgeInset: 0.25 };
const _pH = new THREE.Vector3();
const _pU = new THREE.Vector3();
const _pR = new THREE.Vector3();
const SHOVE = { speed: 0.35, time: 1 };
const BUMP = { min: 0.25, gap: 0.4 };
const RATING = { smart: 0.35, well: 0.8 };

const _v = new THREE.Vector3();
const _f = new THREE.Vector3();
const _s = new THREE.Vector3();
const _b = new THREE.Vector3();
const _w = new THREE.Vector3();
const _m = new THREE.Vector3();
// the design CG (ship.refPoint): what the berth and pose comparisons measure, so cargo moving the CG doesn't drag her
const _ref = new THREE.Vector3();

/** heading (compass, rad) of the ship's bow */
function headingOf(ship: ShipPhysics) {
  _f.set(0, 0, -1).applyQuaternion(ship.quat);
  return Math.atan2(_f.x, -_f.z);
}

export class Mooring {
  readonly docking: DockingDesign;
  readonly anchoring: boolean;
  /** the ship's widest outer half-width: sets how far off the quay face her centre lies when docked */
  private readonly outerHalfWidth: number;
  private readonly bowLocal: THREE.Vector3;
  private readonly anchorScale: number;
  private readonly crewForce: number;

  constructor(private readonly design: ShipDesign) {
    this.docking = design.docking;
    this.anchoring = design.anchoringEnabled;
    let w = 0;
    for (let i = 0; i <= 200; i++) w = Math.max(w, design.deck.outerHalfWidth(i / 200));
    this.outerHalfWidth = w;
    this.bowLocal = new THREE.Vector3(0, design.deck.deckY(design.anchor.s), design.hull.zOf(design.anchor.s));
    this.anchorScale = design.anchor.stiffnessScale;
    this.crewForce = design.docking.crew * HAND_FORCE * design.docking.tackle;
  }

  linePhase: LinePhase = 'none';
  berth: Berth | null = null;
  approach: ApproachInfo | null = null;
  lines: MooringLine[] = [];
  plank: Gangplank | null = null;
  /** the plank foot's distance from the centre line, chosen per berth (m) */
  private plankFoot = 0;
  private plankBerth = -1;
  /** true while the crew can't haul her in and the lines are holding her */
  stalled = false;
  /** 0..1 progress while hauling in */
  warpProgress = 0;
  events: MooringEvent[] = [];
  /** the first harbour in view (kept for callers that read one layout) */
  layout: HarbourLayout | null = null;
  /** berths and ship colliders of every harbour in view (setHarbours concatenates them) */
  private berths: Berth[] = [];
  private colliders: BoxSolid[] = [];
  /** world xz of the anchor on the seabed, while it is down (dropping, holding, weighing) */
  anchorAt: THREE.Vector3 | null = null;
  rode = ANCHOR.rode;
  /** where the anchor is in its cycle; 'stowed' = on deck */
  anchorPhase: AnchorPhase = 'stowed';
  /** world position of the anchor's ring while it is off the deck */
  readonly anchorPos = new THREE.Vector3();
  /** 0..1 progress of the current anchor phase (UI); 1 while holding, 0 when stowed */
  anchorProgress = 0;
  /** seabed height at a world xz (ShipPhysics sets it from the terrain) */
  seabed: ((x: number, z: number) => number) | null = null;

  private dropTop = 0;
  private weighRode0 = 0;
  private liftDist0 = 0;
  private ship: ShipPhysics | null = null;
  private clock = 0;
  /** time in the current line phase */
  private phaseTime = 0;
  private warpErr0 = 1;
  /** docked pose: CoG xz and heading */
  private pose = { x: 0, z: 0, h: 0 };
  /** horizontal targets of the cleats in the docked pose */
  private targets: { x: number; z: number }[] = [];
  private captureSog = 0;
  /** largest quay contact speed since the approach began */
  private peak = 0;
  private lastBump = -Infinity;
  private shove = 0;
  private shoveDir = { x: 0, z: 0 };
  private side: -1 | 1 = 1;
  private settle = 0;
  /** filtered horizontal environmental load (wind, waves, hull), world */
  private env = { x: 0, z: 0 };
  private stallT = 0;
  private resumeT = 0;
  /** filtered pose-error closing rate while hauling (m/s, + = closing) */
  private closingRate = 0;
  private lastErr = 0;
  /** filtered docked-hold demand as a share of the line strength */
  private overload = 0;
  private overT = 0;

  setHarbours(layouts: (HarbourLayout | null)[]) {
    const ls = layouts.filter((l): l is HarbourLayout => l != null);
    this.layout = ls[0] ?? null;
    this.berths = ls.flatMap((l) => l.berths);
    this.colliders = ls.flatMap((l) => l.shipColliders);
  }

  setHarbour(layout: HarbourLayout | null) {
    this.setHarbours([layout]);
  }

  /** boxes the hull collides with (the moles of every harbour in view) */
  get shipColliders(): BoxSolid[] {
    return this.colliders;
  }

  /** true while lines are attached (out, hauling, docked or casting off) */
  get onLines() {
    return this.linePhase !== 'none';
  }
  /** true while the anchor is off the deck */
  get anchorOut() {
    return this.anchorPhase !== 'stowed';
  }

  /** distance from her centre line to the quay face when docked (m) */
  get faceOffset() {
    return this.outerHalfWidth + this.docking.gap;
  }

  /** where this ship's CoG lies when docked at berth b: her widest point `gap` off the quay face */
  berthPose(b: Berth, out: { x: number; z: number }) {
    const shift = this.faceOffset - b.face;
    out.x = b.cx + b.nx * shift;
    out.z = b.cz + b.nz * shift;
    return out;
  }

  /** called once per sim step from ShipPhysics.step, after the environmental forces and before integration */
  step(dt: number, ship: ShipPhysics) {
    this.ship = ship;
    this.clock += dt;
    if (this.docking.enabled) {
      this.updateApproach(ship);
      if (!this.approach && this.linePhase === 'none') this.peak = 0;
      if (!this.plank) this.plank = this.newPlank(1, 0);
      this.phaseTime += dt;
      switch (this.linePhase) {
        case 'out':
          for (const ln of this.lines) ln.deploy = clamp01(this.phaseTime / THROW_TIME);
          if (this.phaseTime >= THROW_TIME) this.setPhase('hauling');
          break;
        case 'hauling':
          this.haul(dt, ship);
          this.checkDocked(dt, ship);
          break;
        case 'docked':
          this.hold(dt, ship);
          break;
        case 'casting':
          this.hold(dt, ship);
          if (this.plank.deployed < 0.02) this.release(true);
          break;
        default:
          break;
      }
      if (this.shove > 0) {
        this.shove = Math.max(0, this.shove - dt);
        const m = ship.mass + ship.payloadMass;
        const k = (m * SHOVE.speed) / SHOVE.time;
        ship.addForceAtPublic(_f.set(this.shoveDir.x * k, 0, this.shoveDir.z * k), ship.pos);
      }
      this.updatePlank(dt, ship);
    } else this.approach = null;
    if (this.anchorAt) this.holdAnchor(ship);
    if (this.anchoring) this.updateAnchor(dt, ship);
  }

  /** throw the lines (R inside the capture window) */
  makeFast(): boolean {
    if (!this.docking.enabled) {
      this.events.push({ type: 'denied', reason: `Docking isn't available on the ${this.design.name.toLowerCase()}` });
      return false;
    }
    if (this.onLines) {
      this.events.push({ type: 'denied', reason: PHASE_LABEL[this.linePhase as Exclude<LinePhase, 'none'>] });
      return false;
    }
    const a = this.approach,
      ship = this.ship;
    if (!a || !ship) return false;
    if (!a.canMakeFast) {
      if (a.reason) this.events.push({ type: 'denied', reason: a.reason });
      return false;
    }
    const b = a.berth;
    // the allowed heading nearest to where she points now
    const hA = Math.atan2(b.ax, -b.az),
      hB = hA + Math.PI;
    const hd = headingOf(ship);
    const h = Math.abs(wrap(hd - hA)) <= Math.abs(wrap(hd - hB)) ? hA : hB;
    const c = Math.cos(h),
      s = Math.sin(h);
    const bowOut = s * b.ax - c * b.az > 0; // bow points along (sin h, -cos h)
    const side = a.side;
    // bow and stern lines go to the outer bollards, springs to the centre one
    const bollardOf = [bowOut ? 2 : 0, 1, 1, bowOut ? 0 : 2];
    const { deck, hull } = this.design;
    this.lines = [];
    this.targets = [];
    this.docking.cleats.forEach((st, i) => {
      const lx = side * deck.deckHalfWidth(st),
        lz = hull.zOf(st);
      // cleat position in the docked pose: rotate the ship-local point by the berth heading
      this.targets.push({ x: a.poseX + lx * c - lz * s, z: a.poseZ + lx * s + lz * c });
      this.lines.push({ local: new THREE.Vector3(lx, hull.sheer(st), lz), anchor: b.bollards[bollardOf[i]].clone(), tension: 0, deploy: 0 });
    });
    this.side = side;
    this.pose = { x: a.poseX, z: a.poseZ, h };
    this.berth = b;
    this.captureSog = a.sog;
    const r0 = ship.refPoint(_ref);
    this.warpErr0 = Math.max(0.05, Math.hypot(r0.x - a.poseX, r0.z - a.poseZ));
    this.warpProgress = 0;
    this.setPhase('out');
    this.events.push({ type: 'lines-out', berth: b });
    return true;
  }

  /**
   * R on the lines. Docked: raise the plank, then let go and shove her off (casting). Lines out or
   * hauling: let go at once.
   */
  castOff() {
    if (this.linePhase === 'docked') {
      this.setPhase('casting');
      this.events.push({ type: 'casting-off' }, { type: 'plank', down: false });
    } else if (this.linePhase === 'out' || this.linePhase === 'hauling') this.release(false);
  }

  /**
   * Put her straight into the docked state at berth b (voyage restore, new voyage). Lines, cleat
   * targets and plank are built as makeFast and the haul build them, and the state goes through setPhase,
   * so no events are emitted. bowOut picks the heading along the pier (seaward) or back. Call after
   * ship.place at berthPose(b) with the same heading. The first step runs the docked hold as usual.
   */
  restoreDocked(b: Berth, bowOut: boolean) {
    if (!this.docking.enabled) throw new Error(`Docking isn't available on the ${this.design.name.toLowerCase()}`);
    const hA = Math.atan2(b.ax, -b.az),
      h = bowOut ? hA : hA + Math.PI;
    const c = Math.cos(h),
      s = Math.sin(h);
    // starboard points along (cos h, 0, sin h); the side it points away from is the side to the pier
    const side: -1 | 1 = c * b.nx + s * b.nz < 0 ? 1 : -1;
    const p = this.berthPose(b, { x: 0, z: 0 });
    const { deck, hull } = this.design;
    const bollardOf = [bowOut ? 2 : 0, 1, 1, bowOut ? 0 : 2];
    this.lines = [];
    this.targets = [];
    this.docking.cleats.forEach((st, i) => {
      const lx = side * deck.deckHalfWidth(st),
        lz = hull.zOf(st);
      this.targets.push({ x: p.x + lx * c - lz * s, z: p.z + lx * s + lz * c });
      this.lines.push({ local: new THREE.Vector3(lx, hull.sheer(st), lz), anchor: b.bollards[bollardOf[i]].clone(), tension: 1, deploy: 1 });
    });
    if (!this.plank) this.plank = this.newPlank(side, 1);
    this.plank.deployed = 1;
    this.side = side;
    this.pose = { x: p.x, z: p.z, h };
    this.berth = b;
    this.approach = null;
    this.stalled = false;
    this.stallT = this.resumeT = 0;
    this.closingRate = 0;
    this.lastErr = 0;
    this.env = { x: 0, z: 0 };
    this.shove = 0;
    this.captureSog = 0;
    this.warpErr0 = 1;
    this.warpProgress = 1;
    this.settle = 0;
    this.peak = 0;
    this.setPhase('docked');
  }

  /** quiet: no denied event (used by the per-frame auto-anchor while the captain is ashore) */
  dropAnchor(quiet = false): boolean {
    const deny = (reason: string) => {
      if (!quiet) this.events.push({ type: 'denied', reason });
      return false;
    };
    if (!this.anchoring) return deny("This ship can't anchor");
    const ship = this.ship;
    if (!ship) return false;
    if (this.anchorPhase === 'lifting') return deny('The anchor is still coming up');
    if (this.anchorPhase !== 'stowed') return deny('The anchor is already down');
    if (this.linePhase === 'docked' || this.linePhase === 'casting') return deny('Docked · no need to anchor');
    if (Math.hypot(ship.vel.x, ship.vel.z) >= ANCHOR.sog) return deny('Too fast to anchor · slow below 3 kn');
    ship.toWorld(this.bowLocal, _b);
    if (this.seabed) {
      const depth = -this.seabed(_b.x, _b.z);
      if (depth > this.rode) return deny(`Too deep to anchor · ${Math.round(depth)} m here, ${this.rode} m of rode`);
    }
    this.anchorAt = new THREE.Vector3(_b.x, 0, _b.z);
    this.anchorPhase = 'dropping';
    this.anchorPos.copy(_b);
    this.dropTop = _b.y;
    this.anchorProgress = 0;
    this.events.push({ type: 'anchor-down' });
    return true;
  }

  /** starts hauling the rode in; the anchor comes up when it breaks out */
  weighAnchor() {
    if (this.anchorPhase !== 'holding' && this.anchorPhase !== 'dropping') return;
    this.anchorPhase = 'weighing';
    this.weighRode0 = this.rode;
    this.anchorProgress = 0;
    this.events.push({ type: 'anchor-weighing' });
  }

  /** drain and return pending events */
  drain(): MooringEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  /**
   * Quay contact reported by ShipPhysics (closing speed along the face normal, m/s). Peak speed is
   * kept for the rating; bump events are throttled to one per 0.4 s.
   */
  noteContact(speed: number) {
    if (speed > this.peak) this.peak = speed;
    if (speed >= BUMP.min && this.clock - this.lastBump >= BUMP.gap) {
      this.lastBump = this.clock;
      this.events.push({ type: 'bump', speed });
    }
  }

  private setPhase(p: LinePhase) {
    this.linePhase = p;
    this.phaseTime = 0;
    if (p === 'hauling') {
      this.stalled = false;
      this.stallT = this.resumeT = 0;
      this.settle = 0;
      this.closingRate = 0;
      if (this.ship) {
        const r = this.ship.refPoint(_ref);
        this.lastErr = Math.hypot(r.x - this.pose.x, r.z - this.pose.z);
      } else this.lastErr = 0;
      for (const ln of this.lines) ln.deploy = 1;
    }
    if (p === 'docked') this.overload = this.overT = 0;
  }

  /** let go all lines; shove pushes her off the quay face */
  private release(shove: boolean) {
    if (shove && this.berth) {
      this.shove = SHOVE.time;
      this.shoveDir = { x: this.berth.nx, z: this.berth.nz };
    }
    this.lines = [];
    this.targets = [];
    this.berth = null;
    this.stalled = false;
    this.warpProgress = 0;
    this.peak = 0;
    this.setPhase('none');
    this.events.push({ type: 'cast-off' });
  }

  private updateApproach(ship: ShipPhysics) {
    let best: Berth | null = null;
    let bd = Infinity;
    for (const b of this.berths) {
      const rb = ship.refPoint(_ref);
      const d = Math.hypot(rb.x - b.cx, rb.z - b.cz);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    if (!best || bd > NEAR) {
      this.approach = null;
      return;
    }
    const b = best;
    const cap = this.docking.capture;
    const pose = this.berthPose(b, _w);
    const rp = ship.refPoint(_ref);
    const dx = rp.x - pose.x,
      dz = rp.z - pose.z;
    const along = dx * b.ax + dz * b.az;
    const lateral = dx * b.nx + dz * b.nz;
    _f.set(0, 0, -1).applyQuaternion(ship.quat); // bow direction
    _s.set(1, 0, 0).applyQuaternion(ship.quat); // starboard direction
    const hd = Math.atan2(_f.x, -_f.z);
    const hA = Math.atan2(b.ax, -b.az);
    const headingErr = Math.min(Math.abs(wrap(hd - hA)), Math.abs(wrap(hd - hA - Math.PI)));
    const vx = ship.vel.x,
      vz = ship.vel.z;
    const sog = Math.hypot(vx, vz);
    const closing = -(vx * b.nx + vz * b.nz);
    // the pier lies on the side the ship's normal points away from
    const side: -1 | 1 = _s.x * b.nx + _s.z * b.nz < 0 ? 1 : -1;
    const bowOut = _f.x * b.ax + _f.z * b.az > 0;

    const free = this.linePhase === 'none';
    const sogOk = sog <= cap.sog;
    const latOk = lateral >= cap.latMin && lateral <= cap.latMax;
    const headOk = headingErr <= cap.head;
    const alongOk = Math.abs(along) <= cap.along;
    const canMakeFast = free && sogOk && latOk && headOk && alongOk;
    let reason: string | null = null;
    if (!free) reason = PHASE_LABEL[this.linePhase as Exclude<LinePhase, 'none'>];
    // most distant concern first: get there, slow down, close the gap, straighten up
    else if (!alongOk) reason = `${Math.round(Math.abs(along) - cap.along)} m to berth`;
    else if (!sogOk) reason = `Too fast · slow below ${(cap.sog * KNOTS).toFixed(1)} kn`;
    else if (lateral > cap.latMax) reason = `${(lateral - cap.latMax).toFixed(1)} m too far from quay`;
    else if (!latOk) reason = 'Too close to quay';
    else if (!headOk) reason = `${Math.round(headingErr / DEG)}° off line`;

    const qSpeed = clamp01(1 - Math.max(0, sog - 0.3) / (cap.sog + 0.2));
    const qLat = clamp01(1 - Math.max(0, Math.abs(lateral - 0.5) - 0.5) / (cap.latMax - 1));
    const qHead = clamp01(1 - headingErr / (cap.head + 5 * DEG));

    this.approach = {
      berth: b,
      dist: bd,
      poseX: pose.x,
      poseZ: pose.z,
      along,
      lateral,
      headingErr,
      closing,
      sog,
      side,
      bowOut,
      canMakeFast,
      reason,
      quality: qSpeed * qLat * qHead,
    };
  }

  /**
   * Hauling in: each cleat is servoed toward its docked position (line speed easing to zero there),
   * plus a share of the measured environmental load the lines must carry; tension only. The total is
   * capped by the crew's pull. Stalled, the crew belays: the lines hold her (up to their strength) and
   * they wait for the load to ease.
   */
  private haul(dt: number, ship: ShipPhysics) {
    const m = ship.mass + ship.payloadMass;
    const ramp = Math.min(1, this.phaseTime / HAUL.ramp);
    // environmental load: everything acting on her this step before the lines and the quay
    const pf = ship.pendingForce;
    const ka = 1 - Math.exp(-dt / HAUL.envTau);
    this.env.x += (pf.x - this.env.x) * ka;
    this.env.z += (pf.z - this.env.z) * ka;
    const envMag = Math.hypot(this.env.x, this.env.z);
    const ex = envMag > 1e-6 ? this.env.x / envMag : 0,
      ez = envMag > 1e-6 ? this.env.z / envMag : 0;
    const gain = m / (this.lines.length * HAUL.tau);
    const cap = this.stalled ? this.docking.lineStrength : this.crewForce;
    // feed-forward split: lines pulling against the load carry it in proportion to how directly they oppose it
    let w2 = 0;
    for (let i = 0; i < this.lines.length; i++) {
      const u = this.lineDir(i, ship);
      const w = u ? Math.max(0, -(ex * u.x + ez * u.z)) : 0;
      w2 += w * w;
    }
    const F = this.lineForce;
    let total = 0;
    for (let i = 0; i < this.lines.length; i++) {
      const ln = this.lines[i];
      ln.tension = 0;
      const u = this.lineDir(i, ship);
      if (!u) {
        F[i] = 0;
        continue;
      }
      ship.pointVel(_b, _v);
      const vn = _v.x * u.x + _v.z * u.z;
      // stalled: hold position (no line taken in); hauling: ease in toward the target
      const want = this.stalled ? 0 : Math.min(HAUL.speed, HAUL.rate * (u.dist - HAUL.slack));
      const w = Math.max(0, -(ex * u.x + ez * u.z));
      const ff = w2 > 1e-6 ? (envMag * w) / w2 : 0;
      F[i] = Math.max(0, (gain * (want - vn) + ff) * ramp);
      total += F[i];
    }
    const capped = total > cap;
    const scale = capped ? cap / total : 1;
    for (let i = 0; i < this.lines.length; i++) {
      const u = this.lineDir(i, ship);
      if (!u || F[i] <= 0) continue;
      const f = F[i] * scale;
      ship.addForceAtPublic(_f.set(f * u.x, 0, f * u.z), _b);
      this.lines[i].tension = Math.min(1, f / (this.docking.lineStrength / this.lines.length) + 0.3);
    }
    // stall: at the crew's limit and not closing for a while
    const rh = ship.refPoint(_ref);
    const err = Math.hypot(rh.x - this.pose.x, rh.z - this.pose.z);
    this.closingRate += ((this.lastErr - err) / dt - this.closingRate) * (1 - Math.exp(-dt / 1));
    this.lastErr = err;
    if (!this.stalled) {
      this.stallT = capped && this.closingRate < HAUL.closing ? this.stallT + dt : 0;
      if (this.stallT >= HAUL.stallAfter) {
        this.stalled = true;
        this.resumeT = 0;
        this.events.push({ type: 'haul-stalled', reason: STALL_REASON });
      }
    } else {
      this.resumeT = envMag < HAUL.resume * this.crewForce ? this.resumeT + dt : 0;
      if (this.resumeT >= HAUL.resumeAfter) {
        this.stalled = false;
        this.stallT = 0;
        this.events.push({ type: 'haul-resumed' });
      }
    }
  }

  private readonly lineForce = [0, 0, 0, 0];
  private readonly lineU = { x: 0, z: 0, dist: 0 };
  /** world cleat of line i into _b, and the horizontal unit direction toward its target (null when slack) */
  private lineDir(i: number, ship: ShipPhysics) {
    ship.toWorld(this.lines[i].local, _b);
    const tg = this.targets[i];
    const ex = tg.x - _b.x,
      ez = tg.z - _b.z;
    const dist = Math.hypot(ex, ez);
    if (dist <= HAUL.slack) return null;
    this.lineU.x = ex / dist;
    this.lineU.z = ez / dist;
    this.lineU.dist = dist;
    return this.lineU;
  }

  private checkDocked(dt: number, ship: ShipPhysics) {
    const rc = ship.refPoint(_ref);
    const err = Math.hypot(rc.x - this.pose.x, rc.z - this.pose.z);
    const herr = Math.abs(wrap(headingOf(ship) - this.pose.h));
    const sog = Math.hypot(ship.vel.x, ship.vel.z);
    this.warpProgress = clamp01(1 - err / this.warpErr0);
    // alongside and steady for a second; wave orbital motion never lets the speed reach zero
    this.settle = err < DOCK.err && herr < DOCK.head && sog < DOCK.sog ? this.settle + dt : 0;
    const late = this.phaseTime >= DOCK.late && err < DOCK.lateErr && !this.stalled;
    if (this.settle >= DOCK.settle || late) {
      const contact = Math.max(this.peak, this.captureSog);
      const rating: 'Perfect' | 'Good' | 'Rough' = contact < RATING.smart ? 'Perfect' : contact < RATING.well ? 'Good' : 'Rough';
      this.warpProgress = 1;
      this.setPhase('docked');
      this.events.push({ type: 'docked', rating, contactSpeed: contact }, { type: 'plank', down: true });
    }
  }

  /**
   * Docked hold: critically damped PD force at the CG on horizontal position and yaw, with a soft
   * deadband, clamped at the lines' strength. k and c use her mass; with a water response design, her
   * effective mass along each hull axis (sway and surge differ by the water's added mass), so the hold
   * keeps its period and critical damping in every direction.
   */
  private hold(dt: number, ship: ShipPhysics) {
    const d = this.docking;
    const m = ship.mass + ship.payloadMass;
    const w = (2 * Math.PI) / d.holdPeriod;
    const rd = ship.refPoint(_ref);
    const ex = rd.x - this.pose.x,
      ez = rd.z - this.pose.z;
    const e = Math.hypot(ex, ez);
    const sc = e > 1e-9 ? softDead(e, DOCK.deadband) / e : 0;
    let fx: number, fz: number;
    if (this.design.hydro.response) {
      // horizontal hull axes: starboard (sway) and aft (surge)
      const me = ship.effectiveMass(_m);
      const h = headingOf(ship);
      const rx = Math.cos(h), rz = Math.sin(h), ax = -Math.sin(h), az = Math.cos(h);
      const eS = (ex * rx + ez * rz) * sc, eA = (ex * ax + ez * az) * sc;
      const vS = ship.vel.x * rx + ship.vel.z * rz, vA = ship.vel.x * ax + ship.vel.z * az;
      const fS = -me.x * (w * w * eS + 2 * w * vS), fA = -me.z * (w * w * eA + 2 * w * vA);
      fx = fS * rx + fA * ax;
      fz = fS * rz + fA * az;
    } else {
      fx = -m * w * w * ex * sc - 2 * m * w * ship.vel.x;
      fz = -m * w * w * ez * sc - 2 * m * w * ship.vel.z;
    }
    const fm = Math.hypot(fx, fz);
    if (fm > d.lineStrength) {
      fx *= d.lineStrength / fm;
      fz *= d.lineStrength / fm;
    }
    ship.addForceAtPublic(_f.set(fx, 0, fz), ship.pos);
    // yaw: heading grows with negative rotation about +y, so a heading error wants a positive torque
    const Iy = this.design.hydro.response ? ship.effectiveInertia(_m).y : ship.inertia.y;
    const eh = softDead(wrap(headingOf(ship) - this.pose.h), DOCK.deadHead);
    const tMax = d.lineStrength * this.design.hull.length * 0.25;
    const ty = Math.max(-tMax, Math.min(tMax, Iy * w * w * eh - 2 * Iy * w * ship.angVel.y));
    ship.addTorquePublic(_f.set(0, ty, 0));
    // the crew eases the lines when the hold is overloaded for a while (filtered: wave peaks don't count)
    this.overload += (fm / d.lineStrength - this.overload) * (1 - Math.exp(-dt / DOCK.overTau));
    for (const ln of this.lines) ln.tension = 0.35 + 0.65 * Math.min(1, this.overload);
    if (this.linePhase !== 'docked') return;
    this.overT = this.overload > 1 ? this.overT + dt : 0;
    if (this.overT >= DOCK.easeAfter) {
      this.setPhase('hauling');
      this.events.push({ type: 'lines-eased' }, { type: 'plank', down: false });
    }
  }

  /** anchor rode: beyond its length a horizontal spring-damper at the bow fairlead */
  private holdAnchor(ship: ShipPhysics) {
    const a = this.anchorAt!;
    ship.toWorld(this.bowLocal, _b);
    const ex = _b.x - a.x,
      ez = _b.z - a.z;
    const d = Math.hypot(ex, ez);
    const stretch = d - this.rode;
    if (stretch <= 0 || d < 1e-6) return;
    const ux = ex / d,
      uz = ez / d;
    ship.pointVel(_b, _v);
    const vn = _v.x * ux + _v.z * uz;
    const s = this.anchorScale;
    const F = Math.min(ANCHOR.clamp * s, Math.max(0, ANCHOR.k * s * stretch + ANCHOR.c * s * vn));
    ship.addForceAtPublic(_f.set(-F * ux, 0, -F * uz), _b);
  }

  /** the anchor's own motion: falls to the seabed, holds, comes up with the rode; stowed = on deck */
  private updateAnchor(dt: number, ship: ShipPhysics) {
    ship.toWorld(this.bowLocal, _b);
    const fallback = _b.y - 6;
    const floor = (x: number, z: number) => (this.seabed ? this.seabed(x, z) : fallback);
    switch (this.anchorPhase) {
      case 'dropping': {
        const a = this.anchorAt!;
        const bottom = floor(a.x, a.z);
        const y = this.anchorPos.y - ANCHOR.fall * dt;
        this.anchorPos.set(a.x, Math.max(bottom, y), a.z);
        this.anchorProgress = clamp01((this.dropTop - this.anchorPos.y) / Math.max(0.01, this.dropTop - bottom));
        if (y <= bottom) {
          this.anchorPhase = 'holding';
          this.anchorProgress = 1;
        }
        break;
      }
      case 'holding': {
        const a = this.anchorAt!;
        this.anchorPos.set(a.x, floor(a.x, a.z), a.z);
        this.anchorProgress = 1;
        break;
      }
      case 'weighing': {
        const a = this.anchorAt!;
        this.anchorPos.set(a.x, floor(a.x, a.z), a.z);
        // the shortening rode pulls the ship up to her anchor (holdAnchor)
        this.rode = Math.max(ANCHOR.breakout, this.rode - ANCHOR.haul * dt);
        this.anchorProgress = clamp01(1 - (this.rode - ANCHOR.breakout) / Math.max(0.01, this.weighRode0 - ANCHOR.breakout));
        let d = Math.hypot(_b.x - a.x, _b.z - a.z);
        // held on her lines she can't come up to the anchor, so the crew drags the anchor home instead
        if (this.onLines && d > this.rode + 0.5) {
          const k = (this.rode + 0.5) / d;
          a.set(_b.x + (a.x - _b.x) * k, 0, _b.z + (a.z - _b.z) * k);
          this.anchorPos.set(a.x, floor(a.x, a.z), a.z);
          d = this.rode + 0.5;
        }
        if (this.rode <= ANCHOR.breakout && d <= ANCHOR.breakout + 0.5) {
          // breakout: the anchor comes up
          this.anchorAt = null;
          this.anchorPhase = 'lifting';
          this.liftDist0 = Math.max(0.01, this.anchorPos.distanceTo(_b));
          this.anchorProgress = 0;
        }
        break;
      }
      case 'lifting': {
        const dist0 = this.anchorPos.distanceTo(_b);
        const step = Math.min(dist0, ANCHOR.lift * dt);
        if (dist0 > 1e-9) this.anchorPos.lerp(_b, step / dist0);
        const dist = this.anchorPos.distanceTo(_b);
        this.anchorProgress = clamp01(1 - dist / this.liftDist0);
        if (dist < 0.3) {
          this.anchorPhase = 'stowed';
          this.anchorProgress = 0;
          this.rode = ANCHOR.rode;
          this.events.push({ type: 'anchor-up' });
        }
        break;
      }
      default:
        break;
    }
  }

  private newPlank(side: -1 | 1, deployed: number): Gangplank {
    return { station: this.docking.plankS, side, deployed, deckLocal: new THREE.Vector3(), shoreWorld: new THREE.Vector3(), width: PLANK.width, length: this.docking.plankLength, resting: false, restWorld: new THREE.Vector3() };
  }

  /**
   * Gangplank, a rigid board with two contacts. Its foot is set on deck by the crew (ship-local, so it
   * heaves, rolls and surges with her); from there it lowers under its own weight until it meets the quay:
   * either the quay's top edge (her deck below the quay top: it pivots on the edge and its end overhangs
   * the quay) or its own end on the quay top (her deck above it). Solved again every step, so the board
   * pivots and slides on the stone as she moves. Too little bearing past the edge and nobody can walk it.
   */
  private updatePlank(dt: number, ship: ShipPhysics) {
    const p = this.plank!;
    const b = this.berth;
    const target = this.linePhase === 'docked' ? 1 : 0;
    p.deployed += Math.max(-PLANK.rate * dt, Math.min(PLANK.rate * dt, target - p.deployed));
    p.side = this.side;
    const L = this.docking.plankLength;
    p.length = L;
    const { deck, hull } = this.design;
    const st = p.station;
    const zl = hull.zOf(st),
      yd = deck.deckY(st),
      hwd = deck.deckHalfWidth(st);
    // the crew choose the foot once per berth: far enough inboard that the climb stays walkable
    if (b && this.plankBerth !== b.id) {
      this.plankBerth = b.id;
      this.plankFoot = this.chooseFoot(ship, b, zl, yd, hwd, L);
    } else if (!b) this.plankBerth = -1;
    p.deckLocal.set(this.side * this.plankFoot, yd, zl);
    const H = ship.toWorld(p.deckLocal, _pH);
    // horizontal direction from the foot toward the quay: her own athwartships axis on the quay side
    const u = _pU.set(this.side, 0, 0).applyQuaternion(ship.quat).setY(0).normalize();
    let el = Math.PI / 2;
    p.resting = false;
    if (b) {
      const rest = this.plankRest(H, u, b, L);
      p.resting = rest.bearing >= PLANK.bearing;
      el = rest.elevation;
      p.restWorld!.copy(rest.point);
    }
    // stowed it stands upright on its foot; deploying it swings down to where it rests
    const k = p.deployed * p.deployed * (3 - 2 * p.deployed);
    const e = Math.PI / 2 + (el - Math.PI / 2) * k;
    p.shoreWorld.copy(H).addScaledVector(u, L * Math.cos(e));
    p.shoreWorld.y += L * Math.sin(e);
  }

  /**
   * Where a board of length L pinned at H (world) and pointing along u (horizontal, toward berth b's quay)
   * comes to rest: lowered from upright, it stops on the first thing it meets, the quay's top edge or its
   * own end on the quay top. Returns its elevation (rad), the bearing point and how far it runs past the
   * edge (m, along the board's horizontal).
   */
  private plankRest(H: THREE.Vector3, u: THREE.Vector3, b: Berth, L: number) {
    const un = u.x * b.nx + u.z * b.nz; // < 0 when u points at the quay
    const out = { elevation: 0, bearing: -1, point: _pR.copy(H) };
    if (un > -0.2) return out;
    // horizontal run from the foot to the quay face along u
    const dFace = ((H.x - b.cx) * b.nx + (H.z - b.cz) * b.nz + b.face) / -un;
    const rise = b.top - H.y;
    const aEdge = Math.atan2(rise, Math.max(1e-3, dFace));
    let a = aEdge;
    let onEdge = true;
    if (Math.abs(rise) < L) {
      const aEnd = Math.asin(rise / L);
      // the end can lie on the quay top only past the face; take whichever contact holds it higher
      if (L * Math.cos(aEnd) > dFace && aEnd > aEdge) {
        a = aEnd;
        onEdge = false;
      }
    }
    out.elevation = a;
    out.bearing = L * Math.cos(a) - dFace;
    const run = onEdge ? dFace : L * Math.cos(a);
    out.point.copy(H).addScaledVector(u, run);
    out.point.y = b.top;
    return out;
  }

  /** the foot's distance from the centre line: as far out as the climb allows (MAX slope), never past the deck edge */
  private chooseFoot(ship: ShipPhysics, b: Berth, zl: number, yd: number, hwd: number, L: number): number {
    const edge = Math.max(0, hwd - PLANK.edgeInset);
    const H = ship.toWorld(_pH.set(this.side * edge, yd, zl), _pH);
    const u = _pU.set(this.side, 0, 0).applyQuaternion(ship.quat).setY(0).normalize();
    const un = u.x * b.nx + u.z * b.nz;
    if (un > -0.2) return edge;
    const dFace = ((H.x - b.cx) * b.nx + (H.z - b.cz) * b.nz + b.face) / -un;
    const rise = b.top - H.y;
    if (rise <= 0) return edge;
    // inboard far enough for the slope (never past the centre line), then back out until the board still
    // reaches past the quay edge with twice the bearing it needs
    let i = Math.min(edge, Math.max(0, rise / Math.tan(PLANK.maxSlope) - dFace));
    const bearing = (d: number) => (L * d) / Math.hypot(d, rise) - d;
    while (i > 0 && bearing(dFace + i) < 2 * PLANK.bearing) i = Math.max(0, i - 0.05);
    return edge - i;
  }
}
