import * as THREE from 'three';
import { Crew } from './crew';
import { type OarSlot } from './oarLayout';
import { TRIREME, type ShipDesign } from './design';
import { createFlowSample, type WaveField } from '../world/waves';
import { clamp, smoothstep } from '../core/util';

type OarParams = ShipDesign['oars'];

export type RowSide = -1 | 1;
export type RowMode = 'rest' | 'row' | 'exit' | 'transfer' | 'enter' | 'hold';
export interface JointPose { sweep: number; dip: number; feather: number; dSweep: number; dDip: number; dFeather: number }
export interface OarKinematics {
  pivot: THREE.Vector3; center: THREE.Vector3; axis: THREE.Vector3; widthAxis: THREE.Vector3;
  normal: THREE.Vector3; centerVelocity: THREE.Vector3; axisVelocity: THREE.Vector3;
  widthAxisVelocity: THREE.Vector3; matrix: THREE.Matrix4;
}
export interface RowBody {
  readonly pos: THREE.Vector3; readonly quat: THREE.Quaternion; readonly vel: THREE.Vector3;
  readonly angVel: THREE.Vector3; readonly cg: THREE.Vector3;
}
export function createKinematics(): OarKinematics {
  return { pivot: new THREE.Vector3(), center: new THREE.Vector3(), axis: new THREE.Vector3(),
    widthAxis: new THREE.Vector3(), normal: new THREE.Vector3(), centerVelocity: new THREE.Vector3(),
    axisVelocity: new THREE.Vector3(), widthAxisVelocity: new THREE.Vector3(), matrix: new THREE.Matrix4() };
}
export function evaluateOar(slot: Readonly<OarSlot>, j: Readonly<JointPose>, out: OarKinematics): void {
  const s = slot.side, ca = Math.cos(j.sweep), sa = Math.sin(j.sweep), cd = Math.cos(j.dip), sd = Math.sin(j.dip);
  const cf = Math.cos(j.feather), sf = Math.sin(j.feather), da = j.dSweep, dd = j.dDip, df = j.dFeather;
  out.pivot.set(slot.x, slot.y, slot.z);
  out.axis.set(s * cd * ca, -sd, -cd * sa);
  // b is perpendicular to the loom in the dip plane; n0=u cross b.
  const bx = s * sd * ca, by = cd, bz = -sd * sa;
  const nx = sa, nz = s * ca;
  const dbx = s * (cd * dd * ca - sd * sa * da), dby = -sd * dd, dbz = -cd * dd * sa - sd * ca * da;
  const dnx = ca * da, dnz = -s * sa * da;
  out.axisVelocity.set(s * (-sd * dd * ca - cd * sa * da), -cd * dd, sd * dd * sa - cd * ca * da);
  out.widthAxis.set(bx * cf + nx * sf, by * cf, bz * cf + nz * sf);
  out.normal.set(nx * cf - bx * sf, -by * sf, nz * cf - bz * sf);
  out.widthAxisVelocity.set(dbx * cf + dnx * sf + df * (-bx * sf + nx * cf),
    dby * cf - by * sf * df, dbz * cf + dnz * sf + df * (-bz * sf + nz * cf));
  out.center.copy(out.pivot).addScaledVector(out.axis, slot.bladeRadius);
  out.centerVelocity.copy(out.axisVelocity).multiplyScalar(slot.bladeRadius);
  out.matrix.makeBasis(out.axis, out.widthAxis, out.normal).setPosition(out.pivot);
}

export class BladeFrame {
  readonly joint: Float64Array; readonly centerLocal: Float64Array; readonly centerWorld: Float64Array;
  readonly normalWorld: Float64Array; readonly forceWorld: Float64Array; readonly wetArea: Float64Array;
  readonly positivePower: Float64Array; readonly handleForce: Float64Array; readonly contact: Uint8Array;
  constructor(n: number) {
    this.joint = new Float64Array(n * 6); this.centerLocal = new Float64Array(n * 3); this.centerWorld = new Float64Array(n * 3);
    this.normalWorld = new Float64Array(n * 3); this.forceWorld = new Float64Array(n * 3); this.wetArea = new Float64Array(n);
    this.positivePower = new Float64Array(n); this.handleForce = new Float64Array(n); this.contact = new Uint8Array(n);
  }
  copy(f: BladeFrame) {
    this.joint.set(f.joint); this.centerLocal.set(f.centerLocal); this.centerWorld.set(f.centerWorld);
    this.normalWorld.set(f.normalWorld); this.forceWorld.set(f.forceWorld); this.wetArea.set(f.wetArea);
    this.positivePower.set(f.positivePower); this.handleForce.set(f.handleForce); this.contact.set(f.contact);
  }
}
export type RowEventKind = 'catchBeat' | 'enterWater' | 'leaveWater';
export interface RowEvent { id: number; time: number; bladeId: number; side: RowSide; kind: RowEventKind; x: number; y: number; z: number; intensity: number }
export interface RowEventCursor { next: number; epoch?: number }
export class RowEventRing {
  readonly capacity = 4096;
  private times = new Float64Array(this.capacity); private blade = new Int16Array(this.capacity);
  private sides = new Int8Array(this.capacity); private kinds = new Uint8Array(this.capacity);
  private positions = new Float64Array(this.capacity * 3); private intensities = new Float64Array(this.capacity);
  nextId = 0; oldestId = 0; overflows = 0; private epoch = 0;
  get generation() { return this.epoch; }
  createCursor(): RowEventCursor { return { next: this.nextId, epoch: this.epoch }; }
  clear() { this.oldestId = this.nextId; this.overflows = 0; this.epoch++; }
  push(kind: RowEventKind, time: number, bladeId: number, side: RowSide, x: number, y: number, z: number, intensity: number) {
    const k = this.nextId++ % this.capacity;
    this.times[k] = time; this.blade[k] = bladeId; this.sides[k] = side;
    this.kinds[k] = kind === 'catchBeat' ? 0 : kind === 'enterWater' ? 1 : 2;
    this.positions[k * 3] = x; this.positions[k * 3 + 1] = y; this.positions[k * 3 + 2] = z; this.intensities[k] = intensity;
    // Retained history overwrites are ordinary. Overflow means an actual consumer fell behind.
    this.oldestId = Math.max(this.oldestId, this.nextId - this.capacity);
  }
  read(cursor: RowEventCursor, renderTime: number, visit: (event: RowEvent) => void) {
    if (cursor.epoch !== this.epoch) { cursor.next = this.oldestId; cursor.epoch = this.epoch; }
    if (cursor.next < this.oldestId) { this.overflows++; cursor.next = this.oldestId; }
    for (; cursor.next < this.nextId; cursor.next++) {
      const k = cursor.next % this.capacity;
      if (this.times[k] > renderTime + 1e-10) break;
      visit({ id: cursor.next, time: this.times[k], bladeId: this.blade[k], side: this.sides[k] as RowSide,
        kind: this.kinds[k] === 0 ? 'catchBeat' : this.kinds[k] === 1 ? 'enterWater' : 'leaveWater',
        x: this.positions[k * 3], y: this.positions[k * 3 + 1], z: this.positions[k * 3 + 2], intensity: this.intensities[k] });
    }
  }
}

export const ROWING_CONSTANTS = { normalDrag: 1.8, profileDrag: 0.025, wetDepth: 0.23, powerMultiplier: 1, handleMultiplier: 1 };
const Q = (x: number) => x * x * x * (10 + x * (-15 + 6 * x));
const dQ = (x: number) => 30 * x * x * (x - 1) * (x - 1);
export function interpolateJoint(q0: number, v0: number, q1: number, t: number, duration: number, out: Float64Array, offset = 0) {
  const x = clamp(t / duration, 0, 1), x2 = x * x, x3 = x2 * x, x4 = x3 * x, x5 = x4 * x;
  out[offset] = q0 + (q1 - q0) * Q(x) + duration * v0 * (x - 6 * x3 + 8 * x4 - 3 * x5);
  out[offset + 3] = (q1 - q0) * dQ(x) / duration + v0 * (1 - 18 * x2 + 32 * x3 - 15 * x4);
}
export function nominalDip(slot: Readonly<OarSlot>, wet: boolean) {
  return Math.asin(clamp((slot.y + (wet ? ROWING_CONSTANTS.wetDepth : -0.42)) / slot.bladeRadius, -0.2, 0.9));
}
class SideController {
  mode: RowMode = 'rest'; destination: 'rest' | 'row' | 'hold' = 'rest'; direction = 1; targetDirection = 1;
  elapsed = 0; duration = 0; requestedRate = 18; rate = 18; period = 60 / 18; drive = 1.55;
  effort = 0; targetEffort = 0; turn = 0; low = 1; lastEffort = 0;
  handleLimit = 120; peakLimit = 100; meanLimit = 20;
  start: Float64Array; target: Float64Array;
  constructor(n: number) { this.start = new Float64Array(n * 6); this.target = new Float64Array(n * 3); }
}
export interface WetPatch { area: number; l: number; w: number }
/** Exact clipping of a material rectangle against linear signed water depth. Reusable scratch. */
export class BladeClipper {
  private ls = new Float64Array(6); private ws = new Float64Array(6);
  readonly patch: WetPatch = { area: 0, l: 0, w: 0 };
  clip(l0: number, l1: number, w0: number, w1: number, depth: number, dl: number, dw: number): WetPatch {
    let count = 0;
    for (let i = 0; i < 4; i++) {
      const al = i < 2 ? l0 : l1, aw = i === 0 || i === 3 ? w0 : w1;
      const k = (i + 1) % 4, bl = k < 2 ? l0 : l1, bw = k === 0 || k === 3 ? w0 : w1;
      const av = depth + dl * al + dw * aw, bv = depth + dl * bl + dw * bw;
      if (av >= 0) { this.ls[count] = al; this.ws[count++] = aw; }
      if ((av >= 0) !== (bv >= 0)) {
        const t = av / (av - bv);
        this.ls[count] = al + t * (bl - al); this.ws[count++] = aw + t * (bw - aw);
      }
    }
    let area2 = 0, cl = 0, cw = 0;
    for (let i = 0; i < count; i++) {
      const k = (i + 1) % count, cross = this.ls[i] * this.ws[k] - this.ls[k] * this.ws[i];
      area2 += cross; cl += (this.ls[i] + this.ls[k]) * cross; cw += (this.ws[i] + this.ws[k]) * cross;
    }
    const p = this.patch; p.area = Math.abs(area2) / 2;
    if (p.area < 1e-9) { p.area = 0; p.l = p.w = 0; }
    else { p.l = cl / (3 * area2); p.w = cw / (3 * area2); }
    return p;
  }
}
/** Passive traction; the optional uniform scalar cap cannot change its energy sign. */
export function bladeDrag(area: number, slip: THREE.Vector3, normal: THREE.Vector3, out: THREE.Vector3) {
  const vn = slip.dot(normal), tx = slip.x - vn * normal.x, ty = slip.y - vn * normal.y, tz = slip.z - vn * normal.z;
  const tn = Math.hypot(tx, ty, tz), k = -0.5 * 1025 * area;
  return out.set(k * (ROWING_CONSTANTS.normalDrag * vn * Math.abs(vn) * normal.x + ROWING_CONSTANTS.profileDrag * tn * tx),
    k * (ROWING_CONSTANTS.normalDrag * vn * Math.abs(vn) * normal.y + ROWING_CONSTANTS.profileDrag * tn * ty),
    k * (ROWING_CONSTANTS.normalDrag * vn * Math.abs(vn) * normal.z + ROWING_CONSTANTS.profileDrag * tn * tz));
}

export class RowingSystem {
  readonly slots: readonly OarSlot[];
  readonly previous: BladeFrame; readonly current: BladeFrame;
  readonly events = new RowEventRing(); readonly energy: Float64Array;
  readonly handleCaps: Float64Array; readonly powerCaps: Float64Array;
  readonly replenishedEnergy: Float64Array; readonly spentEnergy: Float64Array;
  readonly sides: SideController[];
  readonly telemetry = { portThrust: 0, starboardThrust: 0, oarThrust: 0, yawMoment: 0, wetArea: 0, wetBlades: 0,
    positivePower: 0, dissipatedPower: 0, crewLoad: 0, forceCapFraction: 0, powerCapFraction: 0,
    missedDriveFraction: 0, fallbackQueries: 0, guardedQueries: 0 };
  /** Test/reference switch: query each strip center even when curvature allows one center plane. */
  exactStripSampling = false;
  private k = createKinematics(); private joint: JointPose = { sweep: 0, dip: 0, feather: 0, dSweep: 0, dDip: 0, dFeather: 0 };
  private clipper = new BladeClipper(); private centerFlow = createFlowSample(); private stripFlow = createFlowSample();
  private flowVelocity = { vx: 0, vy: 0, vz: 0 };
  private worldCenter = new THREE.Vector3(); private worldPivot = new THREE.Vector3(); private axis = new THREE.Vector3();
  private width = new THREE.Vector3(); private normal = new THREE.Vector3(); private du = new THREE.Vector3(); private dB = new THREE.Vector3();
  private patchWorld = new THREE.Vector3(); private jointVelocity = new THREE.Vector3(); private bodyVelocity = new THREE.Vector3();
  private slip = new THREE.Vector3(); private f = new THREE.Vector3(); private moment = new THREE.Vector3(); private offset = new THREE.Vector3();
  private patchForce = new Float64Array(12); private patchPosition = new Float64Array(12); private patchPower = new Float64Array(4);
  private patchDissipation = new Float64Array(4); private patchImpact = new Float64Array(4);
  private lastContactTime: Float64Array; private lastIntensity: Float64Array;
  private load = 0; private initialized = false;
  constructor(readonly crew: Crew, readonly params: OarParams = TRIREME.oars) {
    this.slots = Object.freeze(params.slots().map(s => Object.freeze(s)));
    const n = this.slots.length;
    this.previous = new BladeFrame(n); this.current = new BladeFrame(n);
    this.energy = new Float64Array(n).fill(params.slotEnergy);
    this.handleCaps = new Float64Array(n); this.powerCaps = new Float64Array(n);
    this.replenishedEnergy = new Float64Array(n); this.spentEnergy = new Float64Array(n);
    this.sides = [new SideController(n), new SideController(n)];
    this.lastContactTime = new Float64Array(n).fill(-Infinity); this.lastIntensity = new Float64Array(n);
    this.initializeJoints();
  }
  private initializeJoints() {
    for (const slot of this.slots) {
      const o = slot.id * 6; this.current.joint[o] = 0.07; this.current.joint[o + 1] = nominalDip(slot, false);
      this.current.joint[o + 2] = Math.PI / 2;
      this.readJoint(slot.id); evaluateOar(slot, this.joint, this.k);
      const c = slot.id * 3;
      this.current.centerLocal[c] = this.k.center.x; this.current.centerLocal[c + 1] = this.k.center.y; this.current.centerLocal[c + 2] = this.k.center.z;
    }
    this.previous.copy(this.current);
  }
  reset(body: RowBody, time: number) {
    for (const s of this.sides) { s.mode = s.destination = 'rest'; s.elapsed = s.duration = s.effort = s.targetEffort = 0; s.requestedRate = s.rate = this.params.rateMin; }
    this.current.joint.fill(0); this.current.contact.fill(0); this.current.wetArea.fill(0);
    this.current.forceWorld.fill(0); this.current.positivePower.fill(0); this.current.handleForce.fill(0); this.initializeJoints(); this.events.clear(); this.initialized = false;
    this.lastContactTime.fill(-Infinity); this.lastIntensity.fill(0);
    // Teleport resets poses and event history, never physiology or the energy reservoir.
    this.refreshWorld(body); this.previous.copy(this.current);
  }
  private readJoint(i: number, alpha = 1) {
    const o = i * 6, p = this.previous.joint, c = this.current.joint, j = this.joint;
    j.sweep = p[o] + (c[o] - p[o]) * alpha; j.dip = p[o + 1] + (c[o + 1] - p[o + 1]) * alpha;
    j.feather = p[o + 2] + (c[o + 2] - p[o + 2]) * alpha;
    j.dSweep = p[o + 3] + (c[o + 3] - p[o + 3]) * alpha; j.dDip = p[o + 4] + (c[o + 4] - p[o + 4]) * alpha;
    j.dFeather = p[o + 5] + (c[o + 5] - p[o + 5]) * alpha;
  }
  renderPose(index: number, alpha: number, out: OarKinematics) { this.readJoint(index, clamp(alpha, 0, 1)); evaluateOar(this.slots[index], this.joint, out); }
  private beginTransition(side: number, mode: 'exit' | 'transfer' | 'enter') {
    const s = this.sides[side]; s.mode = mode; s.elapsed = 0; s.duration = mode === 'exit' ? 0.28 : mode === 'transfer' ? 0.38 : 0.22;
    s.start.set(this.current.joint);
    for (const slot of this.slots) if ((slot.side === -1 ? 0 : 1) === side) {
      const o = slot.id * 6, t = slot.id * 3;
      s.target[t] = mode === 'exit' ? clamp(s.start[o] + 0.12 * s.start[o + 3], this.params.sweepBack, this.params.sweepFwd) :
        s.destination === 'row' ? (s.targetDirection > 0 ? this.params.sweepFwd : this.params.sweepBack) : 0.07;
      s.target[t + 1] = nominalDip(slot, mode === 'enter');
      s.target[t + 2] = mode === 'transfer' && s.destination === 'rest' ? Math.PI / 2 : 0;
    }
  }
  private cyclePose(slot: Readonly<OarSlot>, s: SideController) {
    const out = this.current.joint, o = slot.id * 6, t = s.elapsed, T = s.period;
    const D = s.drive, C = Math.min(0.12, 0.1 * D), E = C;
    const start = s.direction > 0 ? this.params.sweepFwd : this.params.sweepBack, end = s.direction > 0 ? this.params.sweepBack : this.params.sweepFwd;
    const dry = nominalDip(slot, false), wet = nominalDip(slot, true);
    out[o] = start; out[o + 1] = dry; out[o + 2] = 0; out[o + 3] = out[o + 4] = out[o + 5] = 0;
    if (t < D) {
      const x = t / D, epsilon = 0.15, gain = 1 / (1 - epsilon);
      let position: number, velocity: number;
      if (x < epsilon || x > 1 - epsilon) {
        const u = (x < epsilon ? x : 1 - x) / epsilon;
        const u2 = u * u, u4 = u2 * u2;
        const integrated = u4 * (u2 - 3 * u + 2.5);
        position = x < epsilon ? epsilon * gain * integrated : 1 - epsilon * gain * integrated;
        velocity = gain * Q(u);
      } else { position = gain * (x - epsilon / 2); velocity = gain; }
      out[o] = start + (end - start) * position; out[o + 3] = (end - start) * velocity / D;
      out[o + 1] = wet;
      if (t < C) interpolateJoint(dry, 0, wet, t, C, out, o + 1);
      else if (t > D - E) interpolateJoint(wet, 0, dry, t - D + E, E, out, o + 1);
    } else if (t < D + 0.12) { out[o] = end; interpolateJoint(0, 0, Math.PI / 2, t - D, 0.12, out, o + 2); }
    else if (t < T - 0.12) { out[o + 2] = Math.PI / 2; interpolateJoint(end, 0, start, t - D - 0.12, T - D - 0.24, out, o); }
    else interpolateJoint(Math.PI / 2, 0, 0, t - T + 0.12, 0.12, out, o + 2);

  }
  private fillSide(side: number) {
    const s = this.sides[side];
    for (const slot of this.slots) if ((slot.side === -1 ? 0 : 1) === side) {
      const o = slot.id * 6;
      if (s.mode === 'row') this.cyclePose(slot, s);
      else if (s.mode === 'rest' || s.mode === 'hold') {
        this.current.joint[o] = 0.07; this.current.joint[o + 1] = nominalDip(slot, s.mode === 'hold');
        this.current.joint[o + 2] = s.mode === 'rest' ? Math.PI / 2 : 0;
        this.current.joint[o + 3] = this.current.joint[o + 4] = this.current.joint[o + 5] = 0;
      } else for (let a = 0; a < 3; a++) interpolateJoint(s.start[o + a], s.start[o + a + 3], s.target[slot.id * 3 + a], s.elapsed, s.duration, this.current.joint, o + a);
    }
  }
  private catch(side: number, time: number, body: RowBody) {
    const s = this.sides[side];
    s.mode = 'row'; s.direction = s.targetDirection; s.rate = clamp(s.requestedRate, this.params.rateMin, this.params.rateMax);
    s.period = 60 / s.rate; s.drive = clamp(0.48 * s.period, 0.68, 1.55); s.elapsed = 0;
    this.events.push('catchBeat', time, -1, side === 0 ? -1 : 1, body.pos.x, body.pos.y, body.pos.z, s.effort);
  }
  private evolve(side: number, dt: number, time: number, body: RowBody) {
    const s = this.sides[side];
    const continuing = s.mode === s.destination && (s.mode !== 'row' || s.direction === s.targetDirection);
    if (!continuing && s.mode !== 'exit' && s.mode !== 'transfer' && s.mode !== 'enter') this.beginTransition(side, 'exit');
    // Pending request changes during transfer/enter: preserve the actual present derivatives.
    if ((s.mode === 'transfer' || s.mode === 'enter') &&
      (s.destination !== this.stageDestination[side] || s.targetDirection !== this.stageDirection[side])) this.beginTransition(side, 'exit');
    let remaining = dt, boundaries = 0;
    while (remaining > 1e-12) {
      if (s.mode === 'rest' || s.mode === 'hold') { this.fillSide(side); break; }
      const duration = s.mode === 'row' ? s.period : s.duration;
      const take = Math.min(remaining, Math.max(0, duration - s.elapsed));
      s.elapsed += take; remaining -= take; this.fillSide(side);
      if (s.elapsed < duration - 1e-12) break;
      if (++boundaries > 4) throw new Error('Too many rowing stage boundaries in one step');
      if (s.mode === 'row') this.catch(side, time - remaining, body);
      else if (s.mode === 'exit') {
        this.stageDestination[side] = s.destination; this.stageDirection[side] = s.targetDirection;
        this.beginTransition(side, 'transfer');
      } else if (s.mode === 'transfer') {
        if (s.destination === 'row') this.catch(side, time - remaining, body);
        else if (s.destination === 'hold') this.beginTransition(side, 'enter');
        else { s.mode = 'rest'; s.elapsed = 0; }
      } else { s.mode = 'hold'; s.elapsed = 0; }
      this.fillSide(side);
    }
  }
  private stageDestination: ('rest' | 'row' | 'hold')[] = ['rest', 'rest'];
  private stageDirection = new Int8Array([1, 1]);
  private request(dt: number, speed: number, helm: number) {
    const o = this.crew.order, a = 1 - Math.exp(-dt / 0.2);
    for (let side = 0; side < 2; side++) {
      const s = this.sides[side], sign = side === 0 ? -1 : 1;
      s.turn += (smoothstep(0.35, 1, Math.abs(helm)) - s.turn) * a;
      s.low += (1 - smoothstep(0.8, 3, Math.abs(speed)) - s.low) * a;
      const inner = Math.abs(helm) >= 0.05 && Math.sign(helm) === sign;
      s.targetDirection = o.dir < 0 ? -1 : 1;
      s.destination = this.crew.holdWater ? 'hold' : o.dir === 0 ? 'rest' : 'row';
      s.targetEffort = o.effort;
      if (inner && !this.crew.holdWater) {
        if (o.dir < 0) s.targetEffort *= 1 - 0.55 * s.turn;
        else if (o.dir > 0) {
          const c = 1 - s.turn * (0.65 + 1.10 * s.low);
          if (Math.abs(c) <= 0.12) s.destination = 'rest';
          else s.targetDirection = c < 0 ? -1 : 1;
          s.targetEffort *= Math.abs(c);
        }
      }
      if (s.destination !== 'row') s.targetEffort = 0;
      s.effort += clamp(s.targetEffort - s.effort, -1.5 * dt, 1.5 * dt);
      if (s.effort > 0.01) s.lastEffort = s.effort;
      s.requestedRate += clamp(o.rate * this.params.rateScale - s.requestedRate, -6 * dt, 6 * dt);
    }
  }
  /** Explicit step: evolve joints at t1, evaluate forces on the pre-integration hull pose. */
  step(dt: number, time: number, body: RowBody, helm: number, waves: WaveField, forceOut: THREE.Vector3, torqueOut: THREE.Vector3) {
    if (!(dt > 0) || !Number.isFinite(dt)) throw new Error('Invalid rowing dt');
    this.previous.copy(this.current);
    waves.sampleFlowAt(body.pos.x, body.pos.y, body.pos.z, time, this.centerFlow);
    this.offset.set(this.centerFlow.vx, this.centerFlow.vy, this.centerFlow.vz);
    this.f.set(0, 0, -1).applyQuaternion(body.quat);
    const speed = this.slip.copy(body.vel).sub(this.offset).dot(this.f);
    this.request(dt, speed, helm);
    this.evolve(0, dt, time, body); this.evolve(1, dt, time, body);
    // Human grip and work availability remain continuous across command/stage boundaries.
    // Filter scalars, never force vectors: the current drag must still oppose current slip.
    const limitAlpha = 1 - Math.exp(-dt / 0.16), order = this.crew.order;
    for (const side of this.sides) {
      const row = side.mode === 'row', transition = side.mode === 'exit' || side.mode === 'transfer' || side.mode === 'enter';
      const handle = row ? 750 * side.effort : transition ? 750 * Math.max(0.25, side.lastEffort) : side.mode === 'hold' ? 900 : 120;
      const peak = row ? 1400 * Math.max(0.2, side.effort) : transition ? 500 : 100;
      const mean = row ? this.params.meanPower[this.crew.orderIndex] * (order.effort > 0 ? side.effort / order.effort : 0) : transition ? 60 : side.mode === 'hold' ? 30 : 20;
      side.handleLimit += (clamp(handle, 0, 900) - side.handleLimit) * limitAlpha;
      side.peakLimit += (clamp(peak, 0, 1400) - side.peakLimit) * limitAlpha;
      side.meanLimit += (clamp(mean, 0, 320) - side.meanLimit) * limitAlpha;
    }
    const tele = this.telemetry;
    tele.portThrust = tele.starboardThrust = tele.oarThrust = tele.yawMoment = tele.wetArea = tele.wetBlades = 0;
    tele.positivePower = tele.dissipatedPower = tele.fallbackQueries = tele.guardedQueries = 0;
    let loadSum = 0, forceLimited = 0, powerLimited = 0, active = 0, driveSamples = 0, missed = 0;
    for (const slot of this.slots) {
      const id = slot.id, o = id * 3, side = this.sides[slot.side === -1 ? 0 : 1];
      this.readJoint(id); evaluateOar(slot, this.joint, this.k);
      const k = this.k;
      this.worldCenter.copy(k.center).sub(body.cg).applyQuaternion(body.quat).add(body.pos);
      this.worldPivot.copy(k.pivot).sub(body.cg).applyQuaternion(body.quat).add(body.pos);
      this.axis.copy(k.axis).applyQuaternion(body.quat); this.width.copy(k.widthAxis).applyQuaternion(body.quat);
      this.normal.copy(k.normal).applyQuaternion(body.quat); this.du.copy(k.axisVelocity).applyQuaternion(body.quat);
      this.dB.copy(k.widthAxisVelocity).applyQuaternion(body.quat);
      this.current.centerLocal[o] = k.center.x; this.current.centerLocal[o + 1] = k.center.y; this.current.centerLocal[o + 2] = k.center.z;
      // Scalar writes below avoid temporary arrays in the hot loop.
      this.current.centerWorld[o] = this.worldCenter.x; this.current.centerWorld[o + 1] = this.worldCenter.y; this.current.centerWorld[o + 2] = this.worldCenter.z;
      this.current.normalWorld[o] = this.normal.x; this.current.normalWorld[o + 1] = this.normal.y; this.current.normalWorld[o + 2] = this.normal.z;
      waves.sampleFlowAt(this.worldCenter.x, this.worldCenter.y, this.worldCenter.z, time, this.centerFlow);
      if (this.centerFlow.guarded) tele.guardedQueries++;
      const rb = Math.hypot(slot.bladeLength / 2, slot.bladeWidth / 2);
      const curvature = this.centerFlow.H / Math.pow(Math.max(0.25, this.centerFlow.sigma - rb * this.centerFlow.Hx), 3);
      const fallback = this.exactStripSampling || 0.5 * curvature * rb * rb > 0.025;
      let area = 0, power = 0, dissipated = 0, impact = 0, hx = 0, hy = 0, hz = 0;
      for (let patch = 0; patch < 4; patch++) {
        const po = patch * 3, l0 = -slot.bladeLength / 2 + patch * slot.bladeLength / 4, l1 = l0 + slot.bladeLength / 4;
        const lc = (l0 + l1) / 2;
        let flow = this.centerFlow;
        this.offset.copy(this.worldCenter);
        if (fallback) {
          this.offset.addScaledVector(this.axis, lc);
          waves.sampleFlowAt(this.offset.x, this.offset.y, this.offset.z, time, this.stripFlow);
          flow = this.stripFlow; tele.fallbackQueries++; if (flow.guarded) tele.guardedQueries++;
        }
        const depth = flow.height + flow.hx * (this.worldCenter.x - this.offset.x) + flow.hz * (this.worldCenter.z - this.offset.z) - this.worldCenter.y;
        const dl = flow.hx * this.axis.x + flow.hz * this.axis.z - this.axis.y;
        const dw = flow.hx * this.width.x + flow.hz * this.width.z - this.width.y;
        const wet = this.clipper.clip(l0, l1, -slot.bladeWidth / 2, slot.bladeWidth / 2, depth, dl, dw);
        this.patchForce[po] = this.patchForce[po + 1] = this.patchForce[po + 2] = 0;
        this.patchPower[patch] = this.patchDissipation[patch] = this.patchImpact[patch] = 0;
        if (wet.area === 0) continue;
        area += wet.area;
        this.patchWorld.copy(this.worldCenter).addScaledVector(this.axis, wet.l).addScaledVector(this.width, wet.w);
        const patchHeight = flow.height + flow.hx * (this.patchWorld.x - this.offset.x) + flow.hz * (this.patchWorld.z - this.offset.z);
        waves.flowAtDepth(flow, Math.max(0, patchHeight - this.patchWorld.y), this.flowVelocity);
        this.jointVelocity.copy(this.du).multiplyScalar(slot.bladeRadius + wet.l).addScaledVector(this.dB, wet.w);
        this.offset.copy(this.patchWorld).sub(body.pos);
        this.bodyVelocity.copy(body.angVel).cross(this.offset).add(body.vel);
        this.slip.copy(this.bodyVelocity).add(this.jointVelocity);
        this.slip.x -= this.flowVelocity.vx; this.slip.y -= this.flowVelocity.vy; this.slip.z -= this.flowVelocity.vz;
        bladeDrag(wet.area, this.slip, this.normal, this.f);
        const pp = Math.max(0, -this.f.dot(this.jointVelocity)), dp = Math.max(0, -this.f.dot(this.slip));
        power += pp; dissipated += dp; impact = Math.max(impact, Math.abs(this.slip.dot(this.normal)) / 3);
        this.offset.copy(this.patchWorld).sub(this.worldPivot); this.moment.copy(this.offset).cross(this.f);
        hx += this.moment.x; hy += this.moment.y; hz += this.moment.z;
        this.patchForce[po] = this.f.x; this.patchForce[po + 1] = this.f.y; this.patchForce[po + 2] = this.f.z;
        this.patchPosition[po] = this.patchWorld.x; this.patchPosition[po + 1] = this.patchWorld.y; this.patchPosition[po + 2] = this.patchWorld.z;
        this.patchPower[patch] = pp; this.patchDissipation[patch] = dp; this.patchImpact[patch] = impact;
      }
      const rowing = side.mode === 'row';
      const strength = this.crew.strength;
      const Hcap = ROWING_CONSTANTS.handleMultiplier * strength * side.handleLimit;
      const Pcap = strength * side.peakLimit;
      const replenish = ROWING_CONSTANTS.powerMultiplier * strength * side.meanLimit;
      const supplied = Math.min(this.params.slotEnergy - this.energy[id], replenish * dt);
      this.energy[id] += supplied; this.replenishedEnergy[id] += supplied;
      const rawHandle = Math.hypot(hx, hy, hz) / slot.inboard;
      const hs = rawHandle > 0 ? Math.min(1, Hcap / rawHandle) : 1;
      const ps = power > 0 ? Math.min(1, Pcap / power, this.energy[id] / (dt * power)) : 1;
      const scale = Math.min(hs, ps);
      const work = dt * scale * power;
      this.energy[id] = Math.max(0, this.energy[id] - work); this.spentEnergy[id] += work;
      this.handleCaps[id] = Hcap; this.powerCaps[id] = Pcap;
      this.current.handleForce[id] = rawHandle * scale; this.current.positivePower[id] = power * scale;
      this.current.wetArea[id] = area; this.current.forceWorld[o] = this.current.forceWorld[o + 1] = this.current.forceWorld[o + 2] = 0;
      for (let patch = 0; patch < 4; patch++) {
        const po = patch * 3;
        this.f.set(this.patchForce[po], this.patchForce[po + 1], this.patchForce[po + 2]).multiplyScalar(scale);
        forceOut.add(this.f); this.current.forceWorld[o] += this.f.x; this.current.forceWorld[o + 1] += this.f.y; this.current.forceWorld[o + 2] += this.f.z;
        if (this.f.lengthSq() > 0) {
          this.offset.set(this.patchPosition[po], this.patchPosition[po + 1], this.patchPosition[po + 2]).sub(body.pos);
          this.moment.copy(this.offset).cross(this.f); torqueOut.add(this.moment); tele.yawMoment += this.moment.y;
        }
      }
      this.f.set(this.current.forceWorld[o], this.current.forceWorld[o + 1], this.current.forceWorld[o + 2]);
      this.offset.set(0, 0, -1).applyQuaternion(body.quat);
      const thrust = this.f.dot(this.offset); tele.oarThrust += thrust;
      if (slot.side < 0) tele.portThrust += thrust; else tele.starboardThrust += thrust;
      tele.wetArea += area; if (area > 0) tele.wetBlades++;
      tele.positivePower += power * scale; tele.dissipatedPower += dissipated * scale;
      if (rowing) { active++; if (hs < 0.999999) forceLimited++; if (ps < 0.999999) powerLimited++; }
      const C = Math.min(0.12, 0.1 * side.drive);
      if (rowing && side.elapsed >= C && side.elapsed < side.drive - C) { driveSamples++; if (area < 0.02 * slot.bladeLength * slot.bladeWidth) missed++; }
      loadSum += power * scale + 60 * Math.pow(rawHandle * scale / Math.max(1, Hcap), 2) + (rowing ? 15 + 0.6 * side.rate : 0);
      const fraction = area / (slot.bladeLength * slot.bladeWidth), was = this.current.contact[id] !== 0;
      const contact = was ? fraction >= 0.02 : fraction > 0.08;
      const intensity = Math.min(1, Math.sqrt(dissipated * scale / 250));
      if (!this.initialized) this.current.contact[id] = contact ? 1 : 0;
      else if (contact !== was && time - this.lastContactTime[id] >= 0.06) {
        this.events.push(contact ? 'enterWater' : 'leaveWater', time, id, slot.side,
          this.worldCenter.x, this.worldCenter.y, this.worldCenter.z,
          contact ? Math.max(intensity, clamp(impact, 0, 1)) : this.lastIntensity[id] * 0.65);
        this.current.contact[id] = contact ? 1 : 0; this.lastContactTime[id] = time;
      }
      if (area > 0) this.lastIntensity[id] = intensity;
    }
    this.initialized = true;
    tele.forceCapFraction = active ? forceLimited / active : 0; tele.powerCapFraction = active ? powerLimited / active : 0;
    tele.missedDriveFraction = driveSamples ? missed / driveSamples : 0;
    this.load += (loadSum / this.slots.length - this.load) * (1 - Math.exp(-dt / 3)); tele.crewLoad = this.load;
    const ds = (220 - this.load) / (this.load > 220 ? 16000 : 32000);
    this.crew.stamina = clamp(this.crew.stamina + clamp(ds, -0.02, 0.02) * dt, 0, 1);
    if (this.crew.stamina <= 0.05 && this.crew.orderIndex === 5) { this.crew.orderIndex = 4; this.crew.exhausted = true; }
    if (this.crew.stamina >= 0.3) this.crew.exhausted = false;
    const reference = this.sides[0].mode === 'row' ? this.sides[0] : this.sides[1];
    this.crew.rate = reference.mode === 'row' ? reference.rate : 0;
    this.crew.phase = reference.mode === 'row' ? reference.elapsed / reference.period : 0;
    this.crew.latchedDriveTime = reference.drive; this.crew.latchedPeriod = reference.period;
    this.crew.readiness += ((this.sides[0].mode !== 'rest' || this.sides[1].mode !== 'rest' ? 1 : 0) - this.crew.readiness) * (1 - Math.exp(-dt / 0.25));
  }
  /** Complete explicit integration: world display centres follow the newly integrated hull. */
  refreshWorld(body: RowBody) {
    for (const slot of this.slots) {
      this.offset.fromArray(this.current.centerLocal, slot.id * 3).sub(body.cg).applyQuaternion(body.quat).add(body.pos);
      const o = slot.id * 3; this.current.centerWorld[o] = this.offset.x; this.current.centerWorld[o + 1] = this.offset.y; this.current.centerWorld[o + 2] = this.offset.z;
    }
  }
}
