import * as THREE from 'three';
import type { Berth, HarbourLayout } from '../world/harbour';
import type { ShipPhysics } from './physics';
import { halfBeam, deckY, sheer, zOf } from './hull';

/**
 * Lines, gangplank and anchor. CONTRACT (lead-owned public API): WS-B implements the bodies.
 * All forces go through ShipPhysics.addForceAtPublic during ShipPhysics.step.
 */
export type MooringState = 'free' | 'warping' | 'moored' | 'anchored';
export type AnchorPhase = 'stowed' | 'dropping' | 'holding' | 'weighing' | 'lifting';

export interface ApproachInfo {
  berth: Berth;
  /** horizontal distance ship CoG → berth centre (m) */
  dist: number;
  /** signed offset of the ship centre from the berth centre along the pier axis (m) */
  along: number;
  /** gap error: ship centre distance from the berth line, + = too far out, − = pressing the quay (m) */
  lateral: number;
  /** smallest angle to either allowed heading (rad, ≥ 0) */
  headingErr: number;
  /** velocity toward the pier face (m/s, + = closing) */
  closing: number;
  /** speed over ground (m/s) */
  sog: number;
  /** which side of the ship faces the pier: −1 port, +1 starboard */
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
  /** current world position of the cleat (updated each step) */
  cleatWorld: THREE.Vector3;
  /** 0..1 for visuals (sag when slack) */
  tension: number;
}

export interface Gangplank {
  /** deck station of the plank opening */
  station: number;
  /** ship side facing the quay */
  side: -1 | 1;
  /** 0 stowed .. 1 resting on the quay */
  deployed: number;
  /** deck-edge end, ship-local */
  deckLocal: THREE.Vector3;
  /** quay end, world */
  shoreWorld: THREE.Vector3;
  width: number;
}

export type MooringEvent =
  | { type: 'made-fast'; berth: Berth }
  | { type: 'moored'; rating: 'Perfect' | 'Good' | 'Rough'; contactSpeed: number }
  | { type: 'cast-off' }
  | { type: 'bump'; speed: number }
  | { type: 'anchor-down' }
  | { type: 'anchor-weighing' }
  | { type: 'anchor-up' }
  | { type: 'plank'; down: boolean }
  | { type: 'denied'; reason: string };

const DEG = Math.PI / 180;
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** outrigger outboard extension (same profile as trireme.ts) */
export const outriggerOf = (s: number) => 0.7 * smooth(0.13, 0.2, s) * (1 - smooth(0.8, 0.87, s));
/** walkable deck edge at a station: the rail the cleats and the gangplank sit on */
const railOf = (s: number) => halfBeam(s) + outriggerOf(s) - 0.45;

const CAPTURE = { along: 8, latMin: -0.8, latMax: 4, head: 15 * DEG, sog: 1.3, anchorSog: 1.5 };
const NEAR = 220;
/** cleat stations: bow, forward spring, aft spring, stern */
const CLEATS = [0.12, 0.4, 0.6, 0.86];
const LINE = { k: 40e3, c: 25e3, slack: 0.1, clamp: 30e3, ramp: 1.5, timeout: 25, haulSpeed: 0.5, haulTau: 1.2 };
/** fall/haul/lift in m/s; breakout = horizontal rode length at which the anchor breaks out of the seabed */
const ANCHOR = { k: 18e3, c: 12e3, clamp: 60e3, s: 0.12, rode: 14, fall: 2.5, haul: 1.2, lift: 1.5, breakout: 1.5 };
const PLANK = { station: 0.62, width: 0.7, rate: 0.5, reach: 1.6 };
const SHOVE = { speed: 0.35, time: 1 };
const BUMP = { min: 0.25, gap: 0.4 };
const RATING = { smart: 0.35, well: 0.8 };

const BOW_LOCAL = new THREE.Vector3(0, deckY(ANCHOR.s), zOf(ANCHOR.s));
const _v = new THREE.Vector3();
const _f = new THREE.Vector3();
const _s = new THREE.Vector3();
const _b = new THREE.Vector3();

/** heading (compass, rad) of the ship's bow */
function headingOf(ship: ShipPhysics) {
  _f.set(0, 0, -1).applyQuaternion(ship.quat);
  return Math.atan2(_f.x, -_f.z);
}

export class Mooring {
  private readonly bowLocal: THREE.Vector3;
  constructor(readonly docking = true, readonly anchoring = true, bowLocal: THREE.Vector3 = BOW_LOCAL, readonly anchorScale = 1) {
    this.bowLocal = bowLocal.clone();
  }
  state: MooringState = 'free';
  berth: Berth | null = null;
  approach: ApproachInfo | null = null;
  lines: MooringLine[] = [];
  plank: Gangplank | null = null;
  /** world xz of the anchor on the seabed, when anchored */
  anchorAt: THREE.Vector3 | null = null;
  rode = ANCHOR.rode;
  /** 0..1 progress while warping in */
  warpProgress = 0;
  events: MooringEvent[] = [];
  layout: HarbourLayout | null = null;
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
  private warpTime = 0;
  private warpErr0 = 1;
  /** berthed pose: CoG xz and heading */
  private pose = { x: 0, z: 0, h: 0 };
  /** horizontal targets of the cleats in the berthed pose, parallel to lines */
  private targets: { x: number; z: number }[] = [];
  private captureSog = 0;
  /** largest quay contact speed since the approach began */
  private peak = 0;
  private lastBump = -Infinity;
  private shove = 0;
  private shoveDir = { x: 0, z: 0 };
  private side: -1 | 1 = 1;
  private settle = 0;
  private lastDt = 0;

  setHarbour(layout: HarbourLayout) {
    this.layout = layout;
  }

  /** called once per sim step from ShipPhysics.step, before integration */
  step(dt: number, ship: ShipPhysics) {
    this.ship = ship;
    this.clock += dt;
    this.lastDt = dt;
    if (!this.docking) {
      this.approach = null;
      if (this.state === 'anchored') this.holdAnchor(ship);
    } else {
      this.updateApproach(ship);
      if (!this.approach && this.state === 'free') this.peak = 0;
      if (!this.plank) this.plank = { station: PLANK.station, side: 1, deployed: 0, deckLocal: new THREE.Vector3(), shoreWorld: new THREE.Vector3(), width: PLANK.width };

      switch (this.state) {
        case 'warping':
          this.warpTime += dt;
          this.pullLines(ship);
          this.checkMoored(ship);
          break;
        case 'moored':
          this.warpTime += dt;
          this.pullLines(ship);
          break;
        case 'anchored':
          this.holdAnchor(ship);
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
    }
    if (this.anchoring) this.updateAnchor(dt, ship);
  }

  makeFast(): boolean {
    if (!this.docking) {
      this.events.push({ type: 'denied', reason: "Docking isn't available on the merchant ship yet" });
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
    this.lines = [];
    this.targets = [];
    CLEATS.forEach((st, i) => {
      const lx = side * railOf(st),
        lz = zOf(st);
      // cleat position in the berthed pose: rotate the ship-local point by the berth heading
      this.targets.push({ x: b.cx + lx * c - lz * s, z: b.cz + lx * s + lz * c });
      this.lines.push({
        local: new THREE.Vector3(lx, sheer(st), lz),
        anchor: b.bollards[bollardOf[i]].clone(),
        cleatWorld: new THREE.Vector3(),
        tension: 0,
      });
    });
    this.side = side;
    this.pose = { x: b.cx, z: b.cz, h };
    this.berth = b;
    this.captureSog = a.sog;
    this.warpTime = 0;
    this.warpErr0 = Math.max(0.05, Math.hypot(ship.pos.x - b.cx, ship.pos.z - b.cz));
    this.warpProgress = 0;
    this.settle = 0;
    this.state = 'warping';
    this.events.push({ type: 'made-fast', berth: b });
    return true;
  }

  castOff() {
    if (this.state !== 'moored' && this.state !== 'warping') return;
    if (this.state === 'moored' && this.berth) {
      // crew shove her off the quay: 0.35 m/s away from the pier face over 1 s
      this.shove = SHOVE.time;
      this.shoveDir = { x: this.berth.nx, z: this.berth.nz };
    }
    this.lines = [];
    this.targets = [];
    this.berth = null;
    this.state = 'free';
    this.warpProgress = 0;
    this.peak = 0;
    this.events.push({ type: 'cast-off' }, { type: 'plank', down: false });
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
    if (this.state !== 'free') return deny('Already moored');
    if (Math.hypot(ship.vel.x, ship.vel.z) >= CAPTURE.anchorSog) return deny('Too fast to anchor · slow below 3 kn');
    ship.toWorld(this.bowLocal, _b);
    if (this.seabed) {
      const depth = -this.seabed(_b.x, _b.z);
      if (depth > this.rode) return deny(`Too deep to anchor · ${Math.round(depth)} m here, ${this.rode} m of rode`);
    }
    this.anchorAt = new THREE.Vector3(_b.x, 0, _b.z);
    this.berth = null;
    this.peak = 0;
    this.state = 'anchored';
    this.anchorPhase = 'dropping';
    this.anchorPos.copy(_b);
    this.dropTop = _b.y;
    this.anchorProgress = 0;
    this.events.push({ type: 'anchor-down' });
    return true;
  }

  /** starts hauling the rode in; the ship is freed and the anchor comes up when it breaks out */
  weighAnchor() {
    if (this.state !== 'anchored' || (this.anchorPhase !== 'holding' && this.anchorPhase !== 'dropping')) return;
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

  private updateApproach(ship: ShipPhysics) {
    let best: Berth | null = null;
    let bd = Infinity;
    for (const b of this.layout?.berths ?? []) {
      const d = Math.hypot(ship.pos.x - b.cx, ship.pos.z - b.cz);
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
    const dx = ship.pos.x - b.cx,
      dz = ship.pos.z - b.cz;
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

    const free = this.state === 'free';
    const sogOk = sog <= CAPTURE.sog;
    const latOk = lateral >= CAPTURE.latMin && lateral <= CAPTURE.latMax;
    const headOk = headingErr <= CAPTURE.head;
    const alongOk = Math.abs(along) <= CAPTURE.along;
    const canMakeFast = free && sogOk && latOk && headOk && alongOk;
    let reason: string | null = null;
    if (!free) reason = this.state === 'warping' ? 'Pulling in' : this.state === 'moored' ? 'Moored' : 'Anchored';
    // most distant concern first: get there, slow down, close the gap, straighten up
    else if (!alongOk) reason = `${Math.round(Math.abs(along) - CAPTURE.along)} m to berth`;
    else if (!sogOk) reason = 'Too fast · slow below 2.5 kn';
    else if (lateral > CAPTURE.latMax) reason = `${(lateral - CAPTURE.latMax).toFixed(1)} m too far from quay`;
    else if (!latOk) reason = 'Too close to quay';
    else if (!headOk) reason = `${Math.round(headingErr / DEG)}° off line`;

    const qSpeed = clamp01(1 - Math.max(0, sog - 0.3) / 1.5);
    const qLat = clamp01(1 - Math.max(0, Math.abs(lateral - 0.5) - 0.5) / 3);
    const qHead = clamp01(1 - headingErr / (20 * DEG));

    this.approach = {
      berth: b,
      dist: bd,
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

  /** horizontal spring-damper per line, cleat toward its berthed position; tension only, never push */
  private pullLines(ship: ShipPhysics) {
    const ramp = Math.min(1, this.warpTime / LINE.ramp);
    const k = LINE.k * ramp,
      c = LINE.c * ramp;
    for (let i = 0; i < this.lines.length; i++) {
      const ln = this.lines[i],
        tg = this.targets[i];
      ship.toWorld(ln.local, ln.cleatWorld);
      const ex = tg.x - ln.cleatWorld.x,
        ez = tg.z - ln.cleatWorld.z;
      const dist = Math.hypot(ex, ez);
      if (dist <= LINE.slack) {
        ln.tension = 0;
        continue;
      }
      const ux = ex / dist,
        uz = ez / dist;
      ship.pointVel(ln.cleatWorld, _v);
      const vn = _v.x * ux + _v.z * uz;
      let F: number;
      if (this.state === 'warping') {
        // the crew hauls hand over hand: line speed eases from 0.5 m/s to zero at the target, and
        // the line goes slack whenever the ship is already coming in faster than they can take up
        const want = Math.min(LINE.haulSpeed, 0.4 * (dist - LINE.slack));
        const gain = (ship.mass + ship.payloadMass) / (this.lines.length * LINE.haulTau);
        F = Math.min(LINE.clamp, Math.max(0, gain * (want - vn) * ramp));
      } else F = Math.min(LINE.clamp, Math.max(0, k * (dist - LINE.slack) - c * vn));
      ship.addForceAtPublic(_f.set(F * ux, 0, F * uz), ln.cleatWorld);
      ln.tension = F / LINE.clamp;
    }
  }

  private checkMoored(ship: ShipPhysics) {
    const err = Math.hypot(ship.pos.x - this.pose.x, ship.pos.z - this.pose.z);
    const herr = Math.abs(wrap(headingOf(ship) - this.pose.h));
    const sog = Math.hypot(ship.vel.x, ship.vel.z);
    this.warpProgress = clamp01(1 - err / this.warpErr0);
    // alongside and steady for a second; wave orbital motion never lets the speed reach zero
    this.settle = err < 0.45 && herr < 4 * DEG && sog < 0.4 ? this.settle + this.lastDt : 0;
    if (this.settle >= 1 || this.warpTime >= LINE.timeout) {
      const contact = Math.max(this.peak, this.captureSog);
      const rating: 'Perfect' | 'Good' | 'Rough' = contact < RATING.smart ? 'Perfect' : contact < RATING.well ? 'Good' : 'Rough';
      this.state = 'moored';
      this.warpProgress = 1;
      this.events.push({ type: 'moored', rating, contactSpeed: contact }, { type: 'plank', down: true });
    }
  }

  /** anchor rode: beyond its length a horizontal spring-damper at the bow cleat */
  private holdAnchor(ship: ShipPhysics) {
    const a = this.anchorAt;
    if (!a) return;
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
    const F = Math.min(ANCHOR.clamp * this.anchorScale, Math.max(0, ANCHOR.k * this.anchorScale * stretch + ANCHOR.c * this.anchorScale * vn));
    ship.addForceAtPublic(_f.set(-F * ux, 0, -F * uz), _b);
  }

  /** the anchor's own motion: falls to the seabed, holds, comes up with the rode; stowed = on deck */
  private updateAnchor(dt: number, ship: ShipPhysics) {
    ship.toWorld(this.bowLocal, _b);
    const floor = (x: number, z: number) => (this.seabed ? this.seabed(x, z) : _b.y - 6);
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
        const d = Math.hypot(_b.x - a.x, _b.z - a.z);
        if (this.rode <= ANCHOR.breakout && d <= ANCHOR.breakout + 0.5) {
          // breakout: the ship is free, the anchor comes up
          this.state = 'free';
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

  /** gangplank: deploys while moored, stows otherwise; shoreWorld is re-projected every step */
  private updatePlank(dt: number, ship: ShipPhysics) {
    const p = this.plank!;
    const target = this.state === 'moored' ? 1 : 0;
    p.deployed += Math.max(-PLANK.rate * dt, Math.min(PLANK.rate * dt, target - p.deployed));
    p.side = this.side;
    const st = PLANK.station;
    p.deckLocal.set(this.side * railOf(st), deckY(st), zOf(st));
    ship.toWorld(p.deckLocal, p.shoreWorld);
    let ox: number, oz: number, oy: number;
    if (this.berth) {
      ox = -this.berth.nx;
      oz = -this.berth.nz;
      oy = this.berth.top;
    } else {
      _s.set(1, 0, 0).applyQuaternion(ship.quat);
      ox = _s.x * this.side;
      oz = _s.z * this.side;
      oy = p.shoreWorld.y;
    }
    p.shoreWorld.set(p.shoreWorld.x + ox * PLANK.reach, oy, p.shoreWorld.z + oz * PLANK.reach);
  }
}
