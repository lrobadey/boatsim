import * as THREE from 'three';
import { clamp, smoothstep } from '../../core/util';
import { BladeClipper, bladeDrag, createKinematics, evaluateOar, type JointPose, type RowBody } from '../rowing';
import { type WaveField } from '../../world/waves';
import { hermite3, type TrackSample } from './tracks';
import type { Oar } from './oar';
import type { CrewRowingParams } from './params';

interface Patch { A: number; n: THREE.Vector3; b: THREE.Vector3; s: THREE.Vector3; d: THREE.Vector3; pos: THREE.Vector3 }

/** what one oar's step delivered (W and N, world frame) */
export interface SweepResult {
  /** rower power on the sweep (+ positive work) */
  Pr: number;
  /** positive dip/feather work the rower does against the water (charged to him) */
  PdipPos: number;
  /** power dissipated as slip */
  Pdiss: number;
  /** power delivered to the hull: F . (v_body - v_water) */
  Phull: number;
  force: THREE.Vector3;
  /** yaw moment about the hull origin (N m, world y) */
  yaw: number;
  /** wet area (m2) and blade centre (world) */
  area: number;
  center: THREE.Vector3;
}

/**
 * Per-oar force balance (spec §3): the sweep rate is a physical state,
 *   I_eff dw/dt = Q_r(w) + Q_w(w),
 * solved by backward Euler with a safeguarded Newton step. Water force per wet blade strip comes
 * from the shared bladeDrag law at slip = b + w s (linear in w once the geometry is frozen). The
 * water forces applied to the hull are exactly bladeDrag at the solved w: nothing is scaled or clipped.
 */
export class SweepDynamics {
  private kin = createKinematics();
  private kin1 = createKinematics();
  private clipper = new BladeClipper();
  private fv = { vx: 0, vy: 0, vz: 0 };
  private joint: JointPose = { sweep: 0, dip: 0, feather: 0, dSweep: 0, dDip: 0, dFeather: 0 };
  private patches: Patch[] = Array.from({ length: 4 }, () => ({ A: 0, n: new THREE.Vector3(), b: new THREE.Vector3(), s: new THREE.Vector3(), d: new THREE.Vector3(), pos: new THREE.Vector3() }));
  private nwet = 0;
  private v = Array.from({ length: 12 }, () => new THREE.Vector3());
  private rest: TrackSample = [0, 0, 0];
  private clamped: TrackSample = [0, 0, 0];
  readonly result: SweepResult = { Pr: 0, PdipPos: 0, Pdiss: 0, Phull: 0, force: new THREE.Vector3(), yaw: 0, area: 0, center: new THREE.Vector3() };
  // solve state (fields, not closures: no per-step allocation)
  private o!: Oar;
  private I = 1;
  private w0e = 0;
  private th0 = 0;
  private S = 0;
  private rh = 1;
  private physMode = false;
  private refq: TrackSample | null = null;
  private beta = 1;
  private Kp = 0;
  private Kd = 0;
  private Mbound = 0;
  private dt = 1 / 120;
  // the entrained water this step (addedMassRelative): its added inertia, the part kept from the last step,
  // the sweep rate of the water and the strips' sum of A (s.n)^2
  private amOn = false;
  private amIadd = 0;
  private amKeep = 0;
  private amWf = 0;
  private amDen = 0;

  constructor(private p: CrewRowingParams) {}

  /** rower handle force (N) along the drive at handle speed vh (m/s, + = moving with the stroke) */
  handForce(o: Oar, vh: number, S: number) {
    const p = this.p;
    const g = clamp(1 - (1 - p.gEdge) * ((o.theta - p.thetaMid) / p.thetaHalf) ** 2, p.gEdge, 1);
    const Fmax = o.u * p.F0 * S * g * (o.dir > 0 ? p.pushFactor : 1);
    return vh >= 0 ? Fmax * Math.max(0, 1 - vh / p.v0) : Fmax * (1 + (p.eccMax - 1) * (1 - Math.exp(vh / p.eccV)));
  }

  /** generalised sweep moment of the water forces at sweep rate w */
  private waterMoment(w: number) {
    let M = 0;
    const sl = this.v[0], F = this.v[1];
    for (let j = 0; j < this.nwet; j++) {
      const pa = this.patches[j];
      sl.copy(pa.b).addScaledVector(pa.s, w);
      bladeDrag(pa.A, sl, pa.n, F);
      M += F.dot(pa.s);
    }
    return M;
  }

  private rowerMoment(w: number) {
    const o = this.o, rh = this.rh;
    const blendFv = this.physMode || o.mode === 'catch';
    const fv = blendFv ? o.dir * this.handForce(o, o.dir * w * rh, this.S) * rh : 0;
    if (this.physMode) return fv;
    const r = this.refq!;
    const sv = clamp(this.I * r[2] + this.Kp * (r[0] - this.th0 - w * this.dt) + this.Kd * (r[1] - w), -this.Mbound, this.Mbound);
    return o.mode === 'catch' ? (1 - this.beta) * sv + this.beta * fv : sv;
  }

  private G(w: number, dt: number) { return (this.I * (w - this.w0e)) / dt - this.rowerMoment(w) - this.waterMoment(w); }

  /**
   * Advance one oar: dip and feather to t1, sweep by the implicit force balance. Adds its water
   * forces and moments to forceOut / torqueOut and fills `result`.
   */
  step(o: Oar, S: number, manned: number, dt: number, time: number, body: RowBody, waves: WaveField, forceOut: THREE.Vector3, torqueOut: THREE.Vector3): SweepResult {
    const p = this.p, slot = o.slot, res = this.result;
    // activation dynamics
    o.u += (o.uCmd - o.u) * (1 - Math.exp(-dt / (o.uCmd > o.u ? p.tauUp : p.tauDown)));
    const dp = o.dip.eval(o.dip.t + dt), fe = o.feather.eval(o.feather.t + dt);
    const th0 = o.theta, w0 = o.omega;
    // geometry frozen at the predicted sweep; per-strip linearisation slip = b + w s
    const J = this.joint;
    J.sweep = th0 + w0 * dt; J.dip = dp[0]; J.feather = fe[0];
    J.dSweep = 1; J.dDip = 0; J.dFeather = 0;
    evaluateOar(slot, J, this.kin1); // per unit sweep rate
    J.dSweep = 0; J.dDip = dp[1]; J.dFeather = fe[1];
    evaluateOar(slot, J, this.kin); // dip and feather motion
    const q = body.quat, k = this.kin, k1 = this.kin1, v = this.v;
    const cW = res.center.copy(k.center).sub(body.cg).applyQuaternion(q).add(body.pos);
    const axis = v[2].copy(k.axis).applyQuaternion(q), width = v[3].copy(k.widthAxis).applyQuaternion(q), normal = v[4].copy(k.normal).applyQuaternion(q);
    const du0 = v[5].copy(k.axisVelocity).applyQuaternion(q), dB0 = v[6].copy(k.widthAxisVelocity).applyQuaternion(q);
    const du1 = v[7].copy(k1.axisVelocity).applyQuaternion(q), dB1 = v[8].copy(k1.widthAxisVelocity).applyQuaternion(q);
    // the oar's own sample: its blade centre moves a few cm per step, so the query warm-starts
    const fl = waves.sampleFlowAt(cW.x, cW.y, cW.z, time, o.flow);
    let area = 0;
    this.nwet = 0;
    for (let j = 0; j < 4; j++) {
      const l0 = -slot.bladeLength / 2 + (j * slot.bladeLength) / 4, l1 = l0 + slot.bladeLength / 4;
      const depth = fl.height - cW.y, dl = fl.hx * axis.x + fl.hz * axis.z - axis.y, dw = fl.hx * width.x + fl.hz * width.z - width.y;
      const wet = this.clipper.clip(l0, l1, -slot.bladeWidth / 2, slot.bladeWidth / 2, depth, dl, dw);
      if (wet.area === 0) continue;
      const pa = this.patches[this.nwet++];
      pa.A = wet.area; area += wet.area; pa.n.copy(normal);
      pa.pos.copy(cW).addScaledVector(axis, wet.l).addScaledVector(width, wet.w);
      const ph = fl.height + fl.hx * (pa.pos.x - cW.x) + fl.hz * (pa.pos.z - cW.z);
      waves.flowAtDepth(fl, Math.max(0, ph - pa.pos.y), this.fv);
      const r = v[9].copy(pa.pos).sub(body.pos);
      pa.b.copy(body.angVel).cross(r).add(body.vel);
      pa.b.x -= this.fv.vx; pa.b.y -= this.fv.vy; pa.b.z -= this.fv.vz;
      pa.d.copy(du0).multiplyScalar(slot.bladeRadius + wet.l).addScaledVector(dB0, wet.w);
      pa.b.add(pa.d);
      pa.s.copy(du1).multiplyScalar(slot.bladeRadius + wet.l).addScaledVector(dB1, wet.w);
    }
    const wetFrac = area / (slot.bladeLength * slot.bladeWidth);
    // effective inertia: oar + the rowers' moving mass through the hands + blade added mass when wet and square
    const rh = o.handR * Math.cos(dp[0]);
    const Iadd = o.addedMass * (slot.bladeRadius ** 2 + slot.bladeLength ** 2 / 12) * wetFrac * Math.cos(fe[0]) ** 2;
    const Inew = o.Ioar + manned * p.mRowerRefl * rh * rh + Iadd;
    let w0e = w0;
    this.amOn = false;
    if (p.addedMassRelative) {
      // The entrained water moves relative to the flowing sea, not the hull: it is picked up at the sweep rate wf
      // at which the blade moves with the water (no normal slip) and its inertial force, -d/dt(Iadd (w - wf)),
      // is a water force on the blade that reaches the hull like the drag. Only the oar and the rowers' bodies
      // keep the pickup and shedding rule below.
      let num = 0, den = 0;
      for (let j = 0; j < this.nwet; j++) { const pa = this.patches[j], sn = pa.s.dot(pa.n); num += pa.A * pa.b.dot(pa.n) * sn; den += pa.A * sn * sn; }
      const wf = den > 1e-12 ? -num / den : w0;
      const Id = Inew - Iadd, IdOld = o.Ieff - o.Iadd, keep = Math.min(o.Iadd, Iadd);
      let w0d = w0;
      if (Id < IdOld) o.audit.shedKE += 0.5 * (IdOld - Id) * w0 * w0;
      else if (Id > IdOld) { w0d = (IdOld * w0) / Id; o.audit.pickupLoss += 0.5 * IdOld * w0 * w0 - 0.5 * Id * w0d * w0d; }
      w0e = (Id * w0d + keep * w0 + (Iadd - keep) * wf) / Inew;
      this.amIadd = Iadd; this.amKeep = keep; this.amWf = wf; this.amDen = den; this.amOn = den > 1e-12;
    } else {
      // a changing inertia creates no energy: shedding keeps the rate (energy left in the wake),
      // pickup conserves momentum (inelastic, I0 w0 = I1 w0')
      if (Inew < o.Ieff) o.audit.shedKE += 0.5 * (o.Ieff - Inew) * w0 * w0;
      else if (Inew > o.Ieff) { w0e = (o.Ieff * w0) / Inew; o.audit.pickupLoss += 0.5 * o.Ieff * w0 * w0 - 0.5 * Inew * w0e * w0e; }
    }
    o.Ieff = Inew;
    o.Iadd = Iadd;
    // rower moment law for this mode
    this.o = o; this.I = Inew; this.w0e = w0e; this.th0 = th0; this.S = S; this.rh = rh; this.dt = dt;
    this.physMode = o.mode === 'drive' || (o.mode === 'catch' && !p.catchMatch);
    this.beta = 1;
    this.refq = null;
    if (o.mode === 'catch' && p.catchMatch && o.catchRef) {
      const c = o.catchRef;
      this.refq = hermite3(c.q0, c.v0, c.q1, c.v1, c.H, o.modeT + dt, c.o);
      this.beta = smoothstep(0.6, 1.0, (o.modeT + dt) / c.H);
    } else if (o.mode === 'extract' && o.extractRef) {
      const c = o.extractRef;
      this.refq = hermite3(c.q0, c.v0, c.q1, c.v1, c.H, o.modeT + dt, c.o);
    } else if (!this.physMode) {
      const r = this.rest;
      if (o.mode === 'rest') { r[0] = p.thetaRest; r[1] = r[2] = 0; this.refq = r; }
      else if (o.mode === 'ready') { r[0] = o.plan.thetaC; r[1] = r[2] = 0; this.refq = r; }
      else if (o.mode === 'shipped') { r[0] = p.shippedSweep; r[1] = r[2] = 0; this.refq = r; }
      else this.refq = o.ref.eval(o.ref.t + dt);
    }
    // a rower never aims past his reach: a re-planned recovery that starts moving can overshoot its
    // target, so the reference is held inside the reach envelope (shipping runs the oar in beyond it)
    const shipping = o.mode === 'shipped' || (o.mode === 'transfer' && (o.next === 'shipped' || o.ref.q0 < p.finishMin - 0.1));
    if (this.refq && !shipping) {
      const lo = p.finishMin - 0.02, hi = p.catchMax + 0.02, r = this.refq;
      if (r[0] < lo || r[0] > hi) { const c = this.clamped; c[0] = clamp(r[0], lo, hi); c[1] = c[2] = 0; this.refq = c; }
    }
    this.Kp = Inew * p.servoWn ** 2;
    this.Kd = 2 * p.servoZeta * Inew * p.servoWn;
    // the servo's hand-force bound: recovery comfort (servoF, raised with the effort asked: Oar.recoveryF) normally; full strength to place the oar
    // at the catch, stop it at the extraction, swing it into a new task, or brace at the end of reach
    const beyondReach = !shipping && (th0 > p.catchMax + 0.02 || th0 < p.finishMin - 0.02);
    const full = o.mode === 'catch' || o.mode === 'extract' || o.mode === 'transfer' || beyondReach;
    const bound = o.mode === 'hold' ? p.holdF * p.uHold * p.F0 * S * rh : manned > 0 ? o.recoveryF(p) * rh : 30;
    this.Mbound = full && manned > 0 ? Math.max(bound, p.F0 * Math.max(S, 0.3) * rh) : bound;
    // G is strictly increasing in w: safeguarded Newton with bracketing
    let w = w0, lo = -40, hi = 40;
    for (let it = 0; it < 8; it++) {
      const g = this.G(w, dt);
      if (Math.abs(g) < (1e-7 * Inew) / dt) break;
      if (g > 0) hi = w; else lo = w;
      const h = 1e-5, dg = (this.G(w + h, dt) - this.G(w - h, dt)) / (2 * h);
      let wn = w - g / dg;
      if (!(wn > lo && wn < hi)) wn = 0.5 * (lo + hi);
      w = wn;
    }
    const Mr = this.rowerMoment(w), Mw = this.waterMoment(w);
    const a = o.audit, Pr = Mr * w;
    if (Pr > 0) a.posWork += Pr * dt; else a.negWork -= Pr * dt;
    a.waterWork += Mw * w * dt;
    a.numLoss += 0.5 * Inew * (w - w0e) ** 2;
    o.omega = w; o.theta = th0 + w * dt; o.Mr = Mr; o.Mw = Mw; o.Fh = Math.abs(Mr) / Math.max(1e-6, rh);
    o.wet = wetFrac;
    // forces to the hull at the solved sweep rate
    const sl = v[10], F = v[11], rr = v[9], vb = v[0];
    res.force.set(0, 0, 0);
    res.yaw = 0;
    let Pdiss = 0, Phull = 0, Pdip = 0;
    for (let j = 0; j < this.nwet; j++) {
      const pa = this.patches[j];
      sl.copy(pa.b).addScaledVector(pa.s, w);
      bladeDrag(pa.A, sl, pa.n, F);
      forceOut.add(F);
      res.force.add(F);
      rr.copy(pa.pos).sub(body.pos);
      vb.copy(body.angVel).cross(rr).add(body.vel);
      Phull += F.dot(vb);
      rr.cross(F);
      torqueOut.add(rr);
      res.yaw += rr.y;
      Pdiss += -F.dot(sl);
      Pdip -= F.dot(pa.d);
      a.dipWork += F.dot(pa.d) * dt;
    }
    if (this.amOn) {
      // the entrained water's inertial force, shared over the wet strips along the blade normal as its added mass is
      const Mam = -(this.amIadd * (w - this.amWf) - this.amKeep * (w0 - this.amWf)) / dt, c = Mam / this.amDen;
      a.waterWork += Mam * w * dt;
      for (let j = 0; j < this.nwet; j++) {
        const pa = this.patches[j];
        F.copy(pa.n).multiplyScalar(c * pa.A * pa.s.dot(pa.n));
        forceOut.add(F);
        res.force.add(F);
        rr.copy(pa.pos).sub(body.pos);
        vb.copy(body.angVel).cross(rr).add(body.vel);
        Phull += F.dot(vb);
        rr.cross(F);
        torqueOut.add(rr);
        res.yaw += rr.y;
      }
    }
    const PdipPos = Math.max(0, Pdip);
    a.dipPos += PdipPos * dt; a.dipNeg += Math.max(0, -Pdip) * dt;
    a.hullWork += Phull * dt; a.slipLoss += Pdiss * dt;
    res.Pr = Pr; res.PdipPos = PdipPos; res.Pdiss = Pdiss; res.Phull = Phull; res.area = area;
    return res;
  }
}
