import * as THREE from 'three';
import type { WalkGeometry, SurfaceKind, Support } from '../world/walkable';
import type { Gangplank } from '../ship/mooring';
import type { WaveField } from '../world/waves';
import { deckY, halfBeam, sOf, zOf, DECK_S0, DECK_S1, HULL_LENGTH } from '../ship/hull';
import { deckHalfWidth, outrigger } from '../ship/trireme';

/**
 * Frame-aware first-person character controller (spec §3). CONTRACT (lead-owned public API):
 * WS-A implements the bodies; the fields and method signatures below are what the rest of the game
 * uses. Add private members freely.
 */
export type WalkFrame = 'ship' | 'world';

/** the ship as the walker sees it this frame (render-interpolated) */
export interface ShipPose {
  /** ship-local → world: model.group.position / quaternion */
  origin: THREE.Vector3;
  quat: THREE.Quaternion;
  /** rigid-body state for point velocities (world) */
  cgWorld: THREE.Vector3;
  vel: THREE.Vector3;
  angVel: THREE.Vector3;
  plank: Gangplank | null;
  /** ship-local solids (mast, bench, build pieces) */
  solids: WalkGeometry;
}

export interface WalkInput {
  /** −1..1 */
  fwd: number;
  strafe: number;
  run: boolean;
  /** pressed this frame */
  jump: boolean;
  /** view yaw in the walker's current frame (rad, Euler-Y convention: 0 looks along −z) */
  yaw: number;
}

export type WalkEvent =
  | { type: 'step'; kind: SurfaceKind; intensity: number }
  | { type: 'land'; kind: SurfaceKind; speed: number }
  | { type: 'splash'; size: number }
  | { type: 'stroke' }
  /** frame switched; the controller adds yawDelta to its yaw so the view stays continuous */
  | { type: 'frame'; frame: WalkFrame; yawDelta: number }
  | { type: 'vault' };

// capsule and body
const RADIUS = 0.3;
const HEIGHT = 1.75;
const EYE = 1.66;
const STEP_UP = 0.45;
const STEP_DOWN = 0.5;
const SLOPE_COS = Math.cos((42 * Math.PI) / 180);
const G = 9.81;
const FALL_G = 1.6;
const JUMP_V = 3.5;
const COYOTE = 0.12;
const JUMP_BUF = 0.12;
const SUB_DT = 1 / 60;
// ground speeds (m/s); accel in m/s²
const WALK = 2.1;
const RUN = 4.6;
const ACCEL = 14;
const DECEL = 18;
const AIR = 0.25;
const SHALLOW_K = 0.6;
const SHALLOW = 0.4;
// water
const SWIM = 1.2;
const SWIM_RUN = 1.8;
const SWIM_ACCEL = 6;
const SWIM_IN = 1.3;
const SWIM_OUT = 1.2;
const SURFACE_EYE = 0.12;
const SWIM_K = 30; // spring to the surface, ω ≈ 5.5 rad/s
const SWIM_C = 7.7; // ζ ≈ 0.7
const SWIM_BOB = 2.4; // Space impulse (m/s)
const STROKE = 1.1;
// scripted moves
const VAULT_T = 0.45;
const VAULT_UP = 0.8;
const VAULT_OUT = 1.3;
const CLIMB_T = 0.8;
const CLIMB_RANGE = 2.2;
const RAIL_IN = 0.4;
const PLANK_HALF = 0.45;
const CROSSING = 0.6; // how far the rail gives way beyond the deck edge at the plank opening
const HULL_CLEAR = 0.3;
// the walkable strip is never narrower than this, so it cannot shrink to a line at the ends
const MIN_HALF = 0.35;

const _fwd = new THREE.Vector3();

/** walkable half-width at a station: the deck's, never narrower than MIN_HALF */
function halfWidthAt(s: number): number {
  return Math.max(MIN_HALF, deckHalfWidth(Math.min(1, Math.max(0, s))));
}

/** heading of a ship as the Euler-Y yaw of its forward (−z) vector, same convention as the view yaw */
export function shipYaw(q: THREE.Quaternion): number {
  _fwd.set(0, 0, -1).applyQuaternion(q);
  return Math.atan2(-_fwd.x, -_fwd.z);
}

interface Floor {
  y: number;
  nx: number;
  ny: number;
  nz: number;
  kind: SurfaceKind;
  plank: boolean;
}

interface Script {
  kind: 'vault' | 'climb';
  t: number;
  p0: THREE.Vector3;
  /** vault: horizontal outward direction; climb: unused */
  dir: THREE.Vector3;
  /** climb: target in ship-local coordinates */
  local: THREE.Vector3;
}

export class Walker {
  frame: WalkFrame = 'ship';
  /** foot position in the current frame (ship-local when frame = 'ship', else world) */
  readonly pos = new THREE.Vector3();
  /** velocity in the current frame */
  readonly vel = new THREE.Vector3();
  /** foot position in world space, valid in both frames after update() */
  readonly world = new THREE.Vector3();
  grounded = true;
  swimming = false;
  surface: SurfaceKind = 'wood';
  /** −1/+1 while pressing against the port/starboard rail (ship frame), else 0 */
  touchingRail: -1 | 0 | 1 = 0;
  /** −1 pressing against the bow rail, +1 the stern rail, else 0 */
  touchingEnd: -1 | 0 | 1 = 0;
  /** a scripted move (vault, climb aboard) is playing; input ignored */
  scripted = false;
  readonly events: WalkEvent[] = [];

  // per-substep input (unit wish direction in the walker frame, scaled by mag)
  private wx = 0;
  private wz = 0;
  private mag = 0;
  private yawNow = 0;
  private coyote = 0;
  private jumpBuf = 0;
  private strokeT = 0;
  private depthPrev = 0;
  private steep = false;
  private steepN = new THREE.Vector3(0, 1, 0);
  private script: Script | null = null;

  private sup: Support = { y: 0, nx: 0, ny: 1, nz: 0, kind: 'wood', solid: null };
  private fl: Floor = { y: 0, nx: 0, ny: 1, nz: 0, kind: 'wood', plank: false };
  private pl: Floor = { y: 0, nx: 0, ny: 1, nz: 0, kind: 'wood', plank: true };
  private col = { x: 0, z: 0 };
  private qInv = new THREE.Quaternion();
  private ta = new THREE.Vector3();
  private tb = new THREE.Vector3();
  private tc = new THREE.Vector3();
  private td = new THREE.Vector3();

  update(dt: number, input: WalkInput, ship: ShipPose, world: WalkGeometry, waves: WaveField, time: number): void {
    this.events.length = 0;
    if (input.jump) this.jumpBuf = JUMP_BUF;
    this.yawNow = input.yaw;
    // fixed substeps keep the contacts and the swim spring stable at any frame rate
    const n = Math.max(1, Math.ceil(dt / SUB_DT));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.step(h, input, ship, world, waves, time);
      this.jumpBuf = Math.max(0, this.jumpBuf - h);
    }
    if (this.frame === 'ship') this.world.copy(this.pos).applyQuaternion(ship.quat).add(ship.origin);
    else this.world.copy(this.pos);
  }

  /** world eye position, before camera-feel offsets */
  eye(ship: ShipPose, out: THREE.Vector3): THREE.Vector3 {
    if (this.frame === 'ship') {
      return out.copy(this.pos).setY(this.pos.y + EYE).applyQuaternion(ship.quat).add(ship.origin);
    }
    return out.copy(this.world).setY(this.world.y + EYE);
  }

  /** put the walker standing on deck at a ship-local point (leaving the helm, spawning) */
  placeOnDeck(local: THREE.Vector3) {
    this.frame = 'ship';
    this.pos.copy(local);
    this.vel.set(0, 0, 0);
    this.touchingRail = 0;
    this.touchingEnd = 0;
    this.grounded = true;
    this.swimming = false;
    this.script = null;
    this.scripted = false;
  }

  /** scripted climb from the water to the nearest deck point inside the rail (spec §3.3) */
  climbAboard(ship: ShipPose): boolean {
    if (this.frame !== 'world' || this.script) return false;
    const local = this.toLocal(ship, this.world, this.ta);
    const s = sOf(local.z);
    if (s < 0.02 || s > 0.98) return false;
    const side = local.x < 0 ? -1 : 1;
    const outer = halfBeam(s) + outrigger(s);
    if (Math.abs(local.x) - outer > CLIMB_RANGE) return false;
    const zt = Math.min(zOf(DECK_S1), Math.max(zOf(DECK_S0), local.z));
    const st = sOf(zt);
    const xt = side * Math.max(0, halfWidthAt(st) - RAIL_IN);
    this.script = { kind: 'climb', t: 0, p0: this.pos.clone(), dir: new THREE.Vector3(), local: new THREE.Vector3(xt, deckY(st), zt) };
    this.scripted = true;
    this.swimming = false;
    this.grounded = false;
    this.vel.set(0, 0, 0);
    this.jumpBuf = 0;
    return true;
  }

  // ───────────────────────── substep ─────────────────────────

  private step(h: number, input: WalkInput, ship: ShipPose, world: WalkGeometry, waves: WaveField, time: number) {
    if (this.script) {
      this.runScript(h, ship);
      return;
    }
    // wish direction: forward = (−sin yaw, −cos yaw), right = (cos yaw, −sin yaw)
    const f = Math.max(-1, Math.min(1, input.fwd));
    const s = Math.max(-1, Math.min(1, input.strafe));
    this.mag = Math.min(1, Math.hypot(f, s));
    const sy = Math.sin(this.yawNow),
      cy = Math.cos(this.yawNow);
    let dx = cy * s - sy * f;
    let dz = -sy * s - cy * f;
    const dl = Math.hypot(dx, dz);
    if (dl > 1e-6) {
      dx /= dl;
      dz /= dl;
    } else {
      dx = 0;
      dz = 0;
    }
    this.wx = dx;
    this.wz = dz;
    if (this.frame === 'ship') this.shipStep(h, input, ship);
    else this.worldStep(h, input, ship, world, waves, time);
  }

  // ───────────────────────── ship frame ─────────────────────────

  private shipStep(h: number, input: WalkInput, ship: ShipPose) {
    const moving = this.mag > 0.01;
    const speed = (input.run ? RUN : WALK) * this.mag;
    this.approach(this.wx * speed, this.wz * speed, this.accelFor(moving, h));

    let nx = this.pos.x + this.vel.x * h;
    let nz = this.pos.z + this.vel.z * h;
    // mast, bench and placed pieces block; anything within a step is a floor (see shipFloor)
    if (ship.solids.collide(nx, nz, RADIUS, this.pos.y, this.pos.y + HEIGHT, STEP_UP, this.col)) {
      if (Math.abs(this.col.x - nx) > 1e-9) this.vel.x = 0;
      if (Math.abs(this.col.z - nz) > 1e-9) this.vel.z = 0;
      nx = this.col.x;
      nz = this.col.z;
    }

    // end rails at DECK_S0 / DECK_S1, like the side rails: the foot never passes them
    const zLo = zOf(DECK_S0);
    const zHi = zOf(DECK_S1);
    const oldZ = this.pos.z;
    if (nz < zLo && nz < oldZ) {
      nz = oldZ >= zLo ? zLo : oldZ;
      this.vel.z = 0;
    } else if (nz > zHi && nz > oldZ) {
      nz = oldZ <= zHi ? zHi : oldZ;
      this.vel.z = 0;
    }

    // side rails at the deck edge; the plank opening lets the foot out past it
    const hw = halfWidthAt(sOf(nz));
    const opening = this.plankOpen(nx, nz, ship.plank);
    const lim = Math.max(0, hw - RADIUS);
    const outLim = opening ? hw + CROSSING : lim;
    const ax = Math.abs(nx);
    const oldAx = Math.abs(this.pos.x);
    if (ax > outLim && ax > oldAx) {
      nx = oldAx <= outLim ? Math.sign(nx) * outLim : this.pos.x;
      this.vel.x = 0;
    }
    this.pos.x = nx;
    this.pos.z = nz;

    // pressing outward against a rail enables the vault (sides not at the opening, and both ends)
    this.touchingRail = 0;
    this.touchingEnd = 0;
    const pushing = this.mag > 0.05 ? 1 : 0;
    if (pushing && !opening && Math.abs(nx) >= lim - 0.02 && Math.sign(nx) * this.wx * this.mag > 0.05) {
      this.touchingRail = nx < 0 ? -1 : 1;
    }
    if (pushing && nz >= zHi - 0.02 && this.wz * this.mag > 0.05) this.touchingEnd = 1;
    else if (pushing && nz <= zLo + 0.02 && this.wz * this.mag < -0.05) this.touchingEnd = -1;

    if (this.jumpBuf > 0 && this.touchingRail !== 0) {
      this.startVault(ship, this.tb.set(this.touchingRail, 0, 0));
      return;
    }
    if (this.jumpBuf > 0 && this.touchingEnd !== 0) {
      this.startVault(ship, this.tb.set(0, 0, this.touchingEnd));
      return;
    }
    if (this.leavesDeck(this.pos.x, sOf(this.pos.z))) {
      this.toWorld(ship);
      return;
    }

    if (this.jumpBuf > 0 && (this.grounded || this.coyote > 0)) {
      this.vel.y = JUMP_V;
      this.grounded = false;
      this.coyote = 0;
      this.jumpBuf = 0;
    }
    const has = this.shipFloor(this.pos.x, this.pos.z, this.pos.y + STEP_UP, ship);
    this.surface = has ? this.fl.kind : 'wood';
    this.verticalStep(h, has, this.fl.y);
  }

  /** the foot is past the deck edge (only possible through the plank opening) */
  private leavesDeck(x: number, s: number): boolean {
    return Math.abs(x) > halfWidthAt(s);
  }

  private shipFloor(x: number, z: number, maxY: number, ship: ShipPose): boolean {
    const f = this.fl;
    let found = false;
    const s = sOf(z);
    if (s >= DECK_S0 && s <= DECK_S1 && Math.abs(x) < halfWidthAt(s)) {
      f.y = deckY(s);
      f.nx = 0;
      f.ny = 1;
      f.nz = 0;
      f.kind = 'wood';
      f.plank = false;
      found = true;
    }
    if (ship.solids.support(x, z, maxY, this.sup) && this.sup.y <= maxY && (!found || this.sup.y > f.y)) {
      f.y = this.sup.y;
      f.nx = this.sup.nx;
      f.ny = this.sup.ny;
      f.nz = this.sup.nz;
      f.kind = this.sup.kind;
      f.plank = false;
      found = true;
    }
    return found;
  }

  // ───────────────────────── world frame ─────────────────────────

  private worldStep(h: number, input: WalkInput, ship: ShipPose, world: WalkGeometry, waves: WaveField, time: number) {
    const feet = this.pos.y;
    const x0 = this.pos.x;
    const z0 = this.pos.z;
    const moving = this.mag > 0.01;
    const shallow = this.grounded && this.depthPrev > SHALLOW;

    // target velocity; no uphill walking on steep ground
    const speed = this.swimming ? (input.run ? SWIM_RUN : SWIM) * this.mag : (input.run ? RUN : WALK) * this.mag * (shallow ? SHALLOW_K : 1);
    let tx = this.wx * speed;
    let tz = this.wz * speed;
    if (this.steep && !this.swimming && tx * this.steepN.x + tz * this.steepN.z < 0) {
      tx = 0;
      tz = 0;
    }
    this.approach(tx, tz, this.swimming ? SWIM_ACCEL * h : this.accelFor(moving, h));
    if (this.steep && this.grounded && !this.swimming) {
      this.vel.x += G * this.steepN.y * this.steepN.x * h;
      this.vel.z += G * this.steepN.y * this.steepN.z * h;
    }

    let nx = x0 + this.vel.x * h;
    let nz = z0 + this.vel.z * h;
    if (world.collide(nx, nz, RADIUS, feet, feet + HEIGHT, STEP_UP, this.col)) {
      if (Math.abs(this.col.x - nx) > 1e-9) this.vel.x = 0;
      if (Math.abs(this.col.z - nz) > 1e-9) this.vel.z = 0;
      nx = this.col.x;
      nz = this.col.z;
    }
    // the hull is an obstacle everywhere except on the gangplank
    if (!this.plankSurface(nx, nz, ship, this.pl) && this.hullPush(nx, feet, nz, ship)) {
      nx = this.col.x;
      nz = this.col.z;
    }

    const has = this.worldFloor(nx, nz, feet + STEP_UP, world, ship);
    const fy = this.fl.y;
    const waterY = waves.heightAt(nx, nz, time);
    const depth = has ? waterY - fy : 0;

    if (this.swimming) {
      if (has && depth <= SWIM_OUT && fy >= feet - 0.2 && fy <= feet + STEP_UP) {
        // a floor within step height in shallow water: walk out
        this.swimming = false;
        this.grounded = true;
        this.coyote = COYOTE;
        this.vel.y = 0;
        this.pos.y = fy;
        this.pos.x = nx;
        this.pos.z = nz;
        this.surface = this.fl.kind;
        this.tryBoard(ship);
        this.depthPrev = depth;
        return;
      }
      this.pos.x = nx;
      this.pos.z = nz;
      this.swimStep(h, waterY, time);
      this.depthPrev = depth;
      return;
    }

    if (has && depth > SWIM_IN && feet < waterY) {
      this.swimming = true;
      this.grounded = false;
      this.events.push({ type: 'splash', size: Math.min(1, Math.max(0.3, Math.abs(this.vel.y) / 5)) });
      this.pos.x = nx;
      this.pos.z = nz;
      this.swimStep(h, waterY, time);
      this.depthPrev = depth;
      return;
    }

    this.pos.x = nx;
    this.pos.z = nz;
    if (this.jumpBuf > 0 && (this.grounded || this.coyote > 0)) {
      this.vel.y = JUMP_V;
      this.grounded = false;
      this.coyote = 0;
      this.jumpBuf = 0;
    }
    const landSpeed = this.verticalStep(h, has, fy);
    if (landSpeed > 0) {
      if (landSpeed > 0.5) this.events.push({ type: 'land', kind: this.fl.kind, speed: landSpeed });
      if (depth > 0.05) this.events.push({ type: 'splash', size: Math.min(1, landSpeed / 5) });
    }
    this.surface = shallow && this.grounded ? 'shallows' : has ? this.fl.kind : 'sand';
    if (this.grounded && has && this.fl.ny < SLOPE_COS) {
      this.steep = true;
      this.steepN.set(this.fl.nx, this.fl.ny, this.fl.nz);
    } else this.steep = false;
    this.depthPrev = depth;
    this.tryBoard(ship);
  }

  private swimStep(h: number, waterY: number, _time: number) {
    if (this.jumpBuf > 0) {
      this.vel.y = SWIM_BOB;
      this.jumpBuf = 0;
    }
    const target = waterY + SURFACE_EYE - EYE;
    this.vel.y += (SWIM_K * (target - this.pos.y) - SWIM_C * this.vel.y) * h;
    this.pos.y += this.vel.y * h;
    this.grounded = false;
    this.coyote = 0;
    this.steep = false;
    this.surface = 'shallows';
    if (this.mag > 0.3) {
      this.strokeT += h;
      if (this.strokeT >= STROKE) {
        this.strokeT -= STROKE;
        this.events.push({ type: 'stroke' });
      }
    } else this.strokeT = 0;
  }

  /** vertical motion shared by both frames; returns the landing speed (0 when no landing) */
  private verticalStep(h: number, has: boolean, fy: number): number {
    const feet = this.pos.y;
    if (this.grounded && this.vel.y <= 0 && has && fy >= feet - STEP_DOWN) {
      this.pos.y = fy;
      this.vel.y = 0;
      this.coyote = COYOTE;
      return 0;
    }
    this.vel.y -= G * (this.vel.y > 0 ? 1 : FALL_G) * h;
    const next = feet + this.vel.y * h;
    if (has && this.vel.y <= 0 && next <= fy) {
      const speed = -this.vel.y;
      this.pos.y = fy;
      this.vel.y = 0;
      this.grounded = true;
      this.coyote = COYOTE;
      return speed;
    }
    this.pos.y = next;
    this.grounded = false;
    this.coyote = Math.max(0, this.coyote - h);
    return 0;
  }

  private accelFor(moving: boolean, h: number): number {
    if (this.grounded) return (moving ? ACCEL : DECEL) * h;
    return moving ? ACCEL * AIR * h : 0;
  }

  /** move (vx,vz) toward the target by at most maxDv */
  private approach(tx: number, tz: number, maxDv: number) {
    const dx = tx - this.vel.x;
    const dz = tz - this.vel.z;
    const d = Math.hypot(dx, dz);
    if (d <= maxDv) {
      this.vel.x = tx;
      this.vel.z = tz;
    } else {
      const k = maxDv / d;
      this.vel.x += dx * k;
      this.vel.z += dz * k;
    }
  }

  // ───────────────────────── floors, plank, hull ─────────────────────────

  private worldFloor(x: number, z: number, maxY: number, world: WalkGeometry, ship: ShipPose): boolean {
    const f = this.fl;
    let found = false;
    if (world.support(x, z, maxY, this.sup)) {
      f.y = this.sup.y;
      f.nx = this.sup.nx;
      f.ny = this.sup.ny;
      f.nz = this.sup.nz;
      f.kind = this.sup.kind;
      f.plank = false;
      found = true;
    }
    if (this.plankSurface(x, z, ship, this.pl) && this.pl.y <= maxY && (!found || this.pl.y > f.y)) {
      f.y = this.pl.y;
      f.nx = this.pl.nx;
      f.ny = this.pl.ny;
      f.nz = this.pl.nz;
      f.kind = 'wood';
      f.plank = true;
      found = true;
    }
    return found;
  }

  /** is (x,z) on the gangplank footprint; fills `out` with the sloped surface */
  private plankSurface(x: number, z: number, ship: ShipPose, out: Floor): boolean {
    const p = ship.plank;
    if (!p || p.deployed < 0.95) return false;
    const A = this.ta.copy(p.deckLocal).applyQuaternion(ship.quat).add(ship.origin);
    const B = p.shoreWorld;
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const dz = B.z - A.z;
    const L2 = dx * dx + dz * dz;
    if (L2 < 1e-6) return false;
    const L = Math.sqrt(L2);
    const px = x - A.x;
    const pz = z - A.z;
    const t = (px * dx + pz * dz) / L2;
    if (t < -0.02 || t > 1.02) return false;
    if (Math.abs(px * dz - pz * dx) / L > p.width / 2) return false;
    out.y = A.y + Math.min(1, Math.max(0, t)) * dy;
    // surface normal = cross(lateral, along): tilts toward the quay, up component positive
    const nx = -dx * dy;
    const ny = L2;
    const nz = -dz * dy;
    const len = Math.hypot(nx, ny, nz);
    out.nx = nx / len;
    out.ny = ny / len;
    out.nz = nz / len;
    out.kind = 'wood';
    out.plank = true;
    return true;
  }

  private plankOpen(x: number, z: number, p: Gangplank | null): boolean {
    return !!p && p.deployed > 0.95 && Math.sign(x) === p.side && Math.abs(z - zOf(p.station)) <= PLANK_HALF;
  }

  /** pushes a foot out of the hull's side zone; writes the new xz to `col` and returns true if moved */
  private hullPush(x: number, y: number, z: number, ship: ShipPose): boolean {
    const d = this.toLocal(ship, this.tc.set(x, y, z), this.tb);
    const s = sOf(d.z);
    if (s < 0 || s > 1) return false;
    const side = halfBeam(s) + outrigger(s) + HULL_CLEAR;
    if (Math.abs(d.x) >= side || d.y >= deckY(s)) return false;
    const target = d.x < 0 ? -side : side;
    const w = this.ta.set(target - d.x, 0, 0).applyQuaternion(ship.quat);
    this.col.x = x + w.x;
    this.col.z = z + w.z;
    return true;
  }

  /** ship-local point of a world point */
  private toLocal(ship: ShipPose, world: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    this.qInv.copy(ship.quat).invert();
    return out.copy(world).sub(ship.origin).applyQuaternion(this.qInv);
  }

  /** world point velocity of the ship at a world point */
  private pointVel(ship: ShipPose, world: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const r = this.td.copy(world).sub(ship.cgWorld);
    return out.copy(ship.angVel).cross(r).add(ship.vel);
  }

  // ───────────────────────── frame switches ─────────────────────────

  private toWorld(ship: ShipPose) {
    const yaw = shipYaw(ship.quat);
    const p = this.tc.copy(this.pos).applyQuaternion(ship.quat).add(ship.origin);
    const vLocal = this.tb.copy(this.vel).applyQuaternion(ship.quat);
    const v = this.pointVel(ship, p, this.ta).add(vLocal);
    this.pos.copy(p);
    this.vel.copy(v);
    this.frame = 'world';
    this.touchingRail = 0;
    this.touchingEnd = 0;
    this.events.push({ type: 'frame', frame: 'world', yawDelta: yaw });
    this.yawNow += yaw;
  }

  private toShip(ship: ShipPose) {
    const yaw = shipYaw(ship.quat);
    const local = this.toLocal(ship, this.pos, this.ta);
    const pv = this.pointVel(ship, this.pos, this.td);
    const vLocal = this.tc.copy(this.vel).sub(pv);
    this.qInv.copy(ship.quat).invert();
    vLocal.applyQuaternion(this.qInv);
    this.pos.copy(local);
    this.vel.copy(vLocal);
    this.frame = 'ship';
    this.swimming = false;
    this.steep = false;
    this.events.push({ type: 'frame', frame: 'ship', yawDelta: -yaw });
    this.yawNow -= yaw;
  }

  /** world → ship when the foot is back over the deck footprint and at or above deck level */
  private tryBoard(ship: ShipPose) {
    if (this.frame !== 'world' || this.swimming) return;
    const local = this.toLocal(ship, this.pos, this.ta);
    const s = sOf(local.z);
    if (local.z < zOf(DECK_S0) + 0.05 || local.z > zOf(DECK_S1) - 0.05) return;
    if (Math.abs(local.x) >= halfWidthAt(s) - 0.05) return;
    if (local.y < deckY(Math.min(1, Math.max(0, s))) - 0.25) return;
    if (!this.grounded && this.vel.y > 0) return;
    this.toShip(ship);
  }

  /** vault along a ship-local outward direction (sideways, or fore/aft over an end rail) */
  private startVault(ship: ShipPose, localOut: THREE.Vector3) {
    const dir = new THREE.Vector3().copy(localOut).applyQuaternion(ship.quat);
    dir.y = 0;
    dir.normalize();
    this.toWorld(ship);
    this.script = { kind: 'vault', t: 0, p0: this.pos.clone(), dir, local: new THREE.Vector3() };
    this.scripted = true;
    this.swimming = false;
    this.grounded = false;
    this.touchingRail = 0;
    this.touchingEnd = 0;
    this.jumpBuf = 0;
    this.coyote = 0;
    this.events.push({ type: 'vault' });
  }

  private runScript(h: number, ship: ShipPose) {
    const sc = this.script;
    if (!sc) return;
    sc.t += h;
    if (sc.kind === 'vault') {
      const u = Math.min(1, sc.t / VAULT_T);
      this.pos.copy(sc.p0).addScaledVector(sc.dir, VAULT_OUT * u);
      this.pos.y += VAULT_UP * 4 * u * (1 - u);
      if (u >= 1) {
        // hand over to free fall with the arc's end velocity, so there is no kink
        this.vel.copy(sc.dir).multiplyScalar(VAULT_OUT / VAULT_T);
        this.vel.y = (-VAULT_UP * 4) / VAULT_T;
        this.finishScript();
      }
      return;
    }
    const u = Math.min(1, sc.t / CLIMB_T);
    const tgt = this.tc.copy(sc.local).applyQuaternion(ship.quat).add(ship.origin);
    const k = u * u * (3 - 2 * u);
    this.pos.lerpVectors(sc.p0, tgt, k);
    this.pos.y += 0.6 * Math.sin(Math.PI * u);
    if (u >= 1) {
      this.toShip(ship);
      this.vel.set(0, 0, 0);
      this.grounded = true;
      this.finishScript();
    }
  }

  private finishScript() {
    this.script = null;
    this.scripted = false;
    this.coyote = 0;
  }
}
