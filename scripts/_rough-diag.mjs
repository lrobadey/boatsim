import './register-ts.mjs';
// Rough-water speed diagnostic (scratch; see docs/merchant-crew-handoff.md "Rough-water speed investigation").
// Mean force along the heading from every source, the drag split into its pieces, and the integrator's
// added-mass leak (vertical force projected into surge by the per-hull-axis effective mass when she pitches).
// Ablations switch one suspect off at a time, by runtime patch; no source changes.
//   node scripts/_rough-diag.mjs   env: U (m/s, 12), REL (deg: 180 into the sea, 90 beam, 0 astern), ORDER (-1 oars
//   shipped, 4 Full), SECS (150), FROM (30), SEED (1), WIND (1 = the sea's own wind on the windage), ABL (comma list):
//     worldMass   the integrator's anisotropic mass in level axes (heave world-vertical, surge/sway horizontal)
//     levelExc    wave excitation and diffraction projected on level axes (yaw only), not the pitched/rolled hull
//     noAstern    the 1.4 astern multiplier on longitudinal resistance off
//     noLiftInd   lateral lift and induced drag off (crossflow drag kept)
//     meanFric    longitudinal resistance against the hull's velocity through the mean water (no orbital flow);
//                 everything else still sees the local orbital flow
//     noHeaveRot  column heave damping applied world-vertical instead of along the pitched hull axis
//     liftMean    lateral lift and induced drag from each column's relative velocity averaged over LIFT_TAU (6 s):
//                 steady leeway and turning kept, wave-frequency crossflow no longer drives the steady lift model
//     fkMean      wave excitation (Froude-Krylov, diffraction) on each column's calm-water immersed volume and depth
//                 (frozen excitation geometry); buoyancy and drag still use the instantaneous immersion
import * as THREE from 'three';
const { Crew } = await import('../src/ship/crew.ts');
const { ShipPhysics } = await import('../src/ship/physics.ts');
const { Wind } = await import('../src/world/wind.ts');
const { WaveField } = await import('../src/world/waves.ts');
const { MERCHANT } = await import('../src/ship/design.ts');
const { dragCoefficient } = await import('../src/ship/resistance.ts');
const { clamp } = await import('../src/core/util.ts');

const env = process.env;
const U = +(env.U ?? 12), REL = +(env.REL ?? 180), ORDER = +(env.ORDER ?? -1), SECS = +(env.SECS ?? 150), FROM = +(env.FROM ?? 30);
const ABL = new Set((env.ABL ?? '').split(',').filter(Boolean));
const dt = 1 / 120, KN = 1.943844, RHO = 1025, G = 9.81;
const terrain = { heightAt: () => -100, normalAt: (x, z, out) => out.set(0, 1, 0) };
const still = { vx: 0, vz: 0, sampleAt: (x, y, z, t, out) => out.set(0, 0, 0) };

const wind = new Wind(+(env.SEED ?? 1));
wind.baseSpeed = 1; wind.update(0);
wind.baseSpeed = U / Math.max(1e-9, wind.meanSpeed); wind.update(0);
const waves = new WaveField(wind, env.SEED ? +env.SEED : undefined);
if (U === 0) waves.waves.length = 0; else waves.update(Infinity);
// calm-water immersed volume and centre depth per column (for fkMean)
const calmVol = [], calmDepth = [];
{
  const w0 = new WaveField(new Wind(0)); w0.waves.length = 0;
  const twin = new ShipPhysics(w0, still, terrain, new Crew(), MERCHANT);
  twin.place(0, 0, 0);
  for (let i = 0; i < 1200; i++) twin.step(dt);
  for (const c of twin.columns) {
    const pb = twin.toWorld(new THREE.Vector3(c.x, c.bottom, c.z), new THREE.Vector3());
    const pt = twin.toWorld(new THREE.Vector3(c.x, c.top, c.z), new THREE.Vector3());
    const f = pb.y >= 0 ? 0 : clamp(-pb.y / (pt.y - pb.y), 0, 1);
    calmVol.push(c.area * f * (c.top - c.bottom));
    calmDepth.push(Math.max(0, -(pb.y + (pt.y - pb.y) * f * 0.5)));
  }
}
const crew = new Crew(), ship = new ShipPhysics(waves, env.WIND === '1' ? wind : still, terrain, crew, MERCHANT);
// rel 180 = bow into the waves (the sea runs toward wind.from + pi)
const heading = wind.from + Math.PI + (REL * Math.PI) / 180;
ship.place(0, 0, heading);
const row = ORDER >= 0;
ship.rowing.setShipped(-1, !row); ship.rowing.setShipped(1, !row);
for (let i = 0; i < 240; i++) ship.step(dt);
ship.vel.set(0, 0, 0); ship.angVel.set(0, 0, 0);
if (row) crew.setOrder(ORDER);

// ------------------------------------------------------------------ accounting
const fwd = new THREE.Vector3(Math.sin(heading), 0, -Math.cos(heading)); // horizontal heading, fixed
const acc = {};
let on = false;
const add = (k, f) => { if (on) acc[k] = (acc[k] ?? 0) + f.dot(fwd); };
const _f = new THREE.Vector3(), _q = new THREE.Quaternion(), _qi = new THREE.Quaternion();
/** yaw-only attitude of the hull (level axes) */
function levelQuat(out) {
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.quat);
  return out.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.atan2(f.x, -f.z));
}

const P = ShipPhysics.prototype;
const _p = new THREE.Vector3(), _n = new THREE.Vector3(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _hh = new THREE.Vector3(), _wa = new THREE.Vector3(), _wb = new THREE.Vector3(), _wc = new THREE.Vector3(), _wd = new THREE.Vector3();
const _meanFlow = { vx: 0, vz: 0 };

/** hullLateralForce split: crossflow (x only), lift, induced drag (local frame) */
function lateralPieces(vx, vz, area, cross, lift, ind) {
  const speed = Math.hypot(vx, vz);
  cross.set(-0.5 * RHO * 1.1 * area * vx * Math.abs(vx) - 400 * area * vx, 0, 0);
  lift.set(0, 0, 0); ind.set(0, 0, 0);
  if (speed > 1e-12 && area > 0) {
    const beta = Math.atan2(vx, Math.abs(vz));
    const cl = 0.8 * Math.sin(2 * beta);
    const qArea = 0.5 * RHO * area * speed * speed;
    lift.set(qArea * cl * (-Math.abs(vz) / speed), 0, qArea * cl * ((vz === 0 ? 0 : Math.sign(vz)) * vx / speed));
    const cdi = (cl * cl) / (Math.PI * 0.18 * 0.7);
    ind.set(-qArea * cdi * vx / speed, 0, -qArea * cdi * vz / speed);
  }
}
const LIFT_TAU = +(env.LIFT_TAU ?? 6), liftAvg = [];
const _cross = new THREE.Vector3(), _lift = new THREE.Vector3(), _ind = new THREE.Vector3(), _crossM = new THREE.Vector3(), _hmean = new THREE.Vector3();

// instrumented copy of ShipPhysics.hydrostatics (src/ship/physics.ts), same maths, pieces logged
P.hydrostatics = function (dtt, invQ) {
  const t = this.time, cols = this.columns, d = this.design, hull = d.hull, hy = d.hydro, resp = hy.response;
  let bowImm = 0;
  if (resp) { this.addedMass.set(0, 0, 0); this.addedInertia.set(0, 0, 0); }
  // mean water velocity for meanFric: none (Gerstner has no mean current)
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    const pb = this.toWorld(_p.set(c.x, c.bottom, c.z), _p);
    const pt = this.toWorld(_n.set(c.x, c.top, c.z), _n);
    const water = this.waves.heightAt(pb.x, pb.z, t);
    if (pb.y >= water) continue;
    const span = pt.y - pb.y;
    const f = span > 1e-3 ? clamp((water - pb.y) / span, 0, 1) : 1;
    const subLen = f * (c.top - c.bottom);
    const vol = c.area * subLen;
    const cp = _v2.copy(pb).lerp(pt, f * 0.5);
    this.addForceAt(_v.set(0, RHO * G * vol, 0), cp);
    if (c.z < -hull.length * 0.3) bowImm += subLen;
    const pv = this.pointVel(cp, _v);
    const flow = this.waves.sampleFlowAt(cp.x, cp.y, cp.z, t, this.flow);
    const hullV = _wd.copy(pv); // hull point velocity, world
    pv.x -= flow.vx; pv.y -= flow.vy; pv.z -= flow.vz;
    const lv = pv.applyQuaternion(invQ);
    const subDepth = Math.min(subLen, 2.5);
    const Alat = hy.lateralFromProfile ? Math.min(subLen + c.bottom - c.keel, 2.5) * c.dz * c.latW : subDepth * c.dz / d.columns.strips;
    lateralPieces(lv.x, lv.z, Alat, _cross, _lift, _ind);
    if (ABL.has('liftMean')) {
      // per column, the relative velocity averaged over LIFT_TAU: steady leeway and turning, not the wave-frequency part
      const k = Math.min(1, dtt / LIFT_TAU), e = liftAvg[i] ??= { x: lv.x, z: lv.z };
      e.x += (lv.x - e.x) * k; e.z += (lv.z - e.z) * k;
      lateralPieces(e.x, e.z, Alat, _crossM, _lift, _ind);
    }
    if (ABL.has('noLiftInd')) { _lift.set(0, 0, 0); _ind.set(0, 0, 0); }
    const Swet = c.area * hy.wettedFactor;
    // longitudinal: friction/form part and wave-making part, against local water (or the mean water)
    const vzF = ABL.has('meanFric') ? _hmean.copy(hullV).applyQuaternion(invQ).z : lv.z;
    const rm = hy.resistance;
    const Fr = Math.abs(vzF) / Math.sqrt(G * hull.length);
    const Cw = rm.cw0 * Math.pow(Fr / 0.33, rm.cwExp);
    const CdTot = ABL.has('noAstern') ? dragCoefficient({ ...rm, astern: 1 }, vzF, hull.length) : dragCoefficient(rm, vzF, hull.length);
    const q = -0.5 * RHO * Swet * vzF * Math.abs(vzF);
    const Ffric = q * (CdTot - Cw), Fwave = q * Cw;
    // log in world frame along the heading
    const logLocal = (key, fx, fy, fz) => add(key, _f.set(fx, fy, fz).applyQuaternion(this.quat));
    logLocal('drag:friction+form', 0, 0, Ffric);
    logLocal('drag:waveMaking', 0, 0, Fwave);
    logLocal('drag:crossflow', _cross.x, 0, 0);
    logLocal('drag:lift', _lift.x, 0, _lift.z);
    logLocal('drag:induced', _ind.x, 0, _ind.z);
    const Fx = _cross.x + _lift.x + _ind.x, Fz = Ffric + Fwave + _lift.z + _ind.z;
    this.addForceAt(_v.set(Fx, 0, Fz).applyQuaternion(this.quat), cp);
    // column response, instrumented (heave damping, Froude-Krylov, diffraction), added mass as before
    const yc = c.bottom + subLen * 0.5;
    const pc = this.toWorld(_wa.set(0, yc, c.z), _wa);
    const v = this.pointVel(pc, _wb);
    v.x -= flow.vx; v.y -= flow.vy; v.z -= flow.vz;
    const vy = v.applyQuaternion(invQ).y;
    const Fy = -0.5 * RHO * hy.heaveDampQuad * c.area * vy * Math.abs(vy) - hy.heaveDampLin * c.area * vy;
    const Fh = _wb.set(0, Fy, 0);
    if (ABL.has('noHeaveRot')) Fh.set(0, Fy, 0); else Fh.applyQuaternion(this.quat);
    add('heaveDamping', Fh);
    this.addForceAt(Fh, pc);
    const fkM = ABL.has('fkMean');
    const m = RHO * (fkM ? calmVol[i] : vol), ca = resp.ca;
    const a = this.waves.accelAtDepth(flow, fkM ? calmDepth[i] : Math.max(0, flow.height - cp.y), _wc);
    const qx = ABL.has('levelExc') ? levelQuat(_q) : this.quat;
    _qi.copy(qx).invert();
    const fd = _f.copy(a).applyQuaternion(_qi);
    fd.set(ca[0] * m * fd.x, ca[1] * m * fd.y, ca[2] * m * fd.z).applyQuaternion(qx);
    add('wave:diffraction', fd);
    const fk = _wd.set(m * a.x, 0, m * a.z);
    add('wave:froudeKrylov', fk);
    this.addForceAt(fd.add(fk), cp);
    const ax = ca[0] * m, ay = ca[1] * m, az = ca[2] * m;
    this.addedMass.x += ax; this.addedMass.y += ay; this.addedMass.z += az;
    const dx = c.x - this.cg.x, dy = yc - this.cg.y, dz = c.z - this.cg.z;
    this.addedInertia.x += ay * dz * dz + az * dy * dy;
    this.addedInertia.y += ax * dz * dz + az * dx * dx;
    this.addedInertia.z += ax * dy * dy + ay * dx * dx;
  }
  this.bowSlam = Math.max(0, bowImm - this.bowImmersion) / dtt;
  this.bowImmersion = bowImm;
  this.torque.addScaledVector(this.angVel, -this.designMass * hy.angularDamp);
  const fwdAxis = _v.set(0, 0, -1).applyQuaternion(this.quat);
  const rollRate = this.angVel.dot(fwdAxis);
  this.torque.addScaledVector(fwdAxis, -hy.rollDampLin * rollRate - hy.rollDampQuad * rollRate * Math.abs(rollRate));
};
for (const [name, key] of [['kirchhoff', 'kirchhoff'], ['rudders', 'rudders'], ['windage', 'windage']]) {
  const orig = P[name];
  P[name] = function (...a) { const b = this.force.clone(); const r = orig.apply(this, a); add(key, this.force.clone().sub(b)); return r; };
}
const origRow = ship.rowing.step.bind(ship.rowing);
ship.rowing.step = (...a) => { const b = ship.force.clone(); origRow(...a); add('oars', ship.force.clone().sub(b)); };

// worldMass ablation: the integrator's per-axis effective mass in level axes instead of the pitched hull axes
if (ABL.has('worldMass')) {
  const qL = new THREE.Quaternion(), qLi = new THREE.Quaternion();
  ship.effectiveMassLevel = true;
  const origStep = P.step;
  // re-implement only the linear-velocity update: run the original step with vel saved, then redo vel in level axes
  P.step = function (h) {
    const v0 = this.vel.clone();
    let Fsum = null;
    const origKirch = this.kirchhoff;
    // capture the total force just before integration: the last call before integrating is kirchhoff (resp designs)
    this.kirchhoff = function (...a) { const r = origKirch.apply(this, a); Fsum = this.force.clone(); return r; };
    origStep.call(this, h);
    this.kirchhoff = origKirch;
    if (!Fsum) return;
    levelQuat(qL); qLi.copy(qL).invert();
    const fb = Fsum.applyQuaternion(qLi);
    const me = this.effectiveMass(new THREE.Vector3());
    fb.set(fb.x / me.x, fb.y / me.y, fb.z / me.z).applyQuaternion(qL);
    const vNew = v0.addScaledVector(fb, h);
    // the original already moved pos with its own vel: correct pos for the difference
    this.pos.addScaledVector(vNew.clone().sub(this.vel), h);
    this.vel.copy(vNew);
  };
}

// integrator leak: me_surge * (actual surge acceleration) - (force along the heading)
let leak = 0, Fsum = 0;
{
  const origKirch = P.kirchhoff;
  P.kirchhoff = function (...a) { const r = origKirch.apply(this, a); if (on) Fsum += this.force.dot(fwd); return r; };
}

// ------------------------------------------------------------------ run with a heading autopilot
const p0 = new THREE.Vector3();
let hdgErr = 0, helmSat = 0, n = 0, sp = 0, pitch2 = 0, roll2 = 0, heave2 = 0, yaw2 = 0, y0 = null, tOn = 0, vF0 = 0;
const me = new THREE.Vector3();
for (let i = 0; i < SECS / dt; i++) {
  const t = i * dt;
  if (!on && t >= FROM) { on = true; p0.copy(ship.pos); vF0 = ship.vel.dot(fwd); tOn = t; }
  const err = ((ship.heading - heading + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  ship.helm = clamp(-1.2 * err - 4 * -ship.angVel.y, -0.3, 0.3);
  if (on) { hdgErr += Math.abs(err); helmSat += Math.abs(ship.helm) >= 0.3 ? 1 : 0; }
  if (waves.waves.length) waves.update(dt);
  const vb = ship.vel.dot(fwd);
  ship.step(dt);
  if (on) {
    ship.effectiveMass(me);
    leak += me.z * (ship.vel.dot(fwd) - vb) / dt;
    n++; sp += ship.speed;
    if (y0 === null) y0 = ship.pos.y;
    pitch2 += ship.pitch ** 2; roll2 += ship.heel ** 2; heave2 += (ship.pos.y - y0) ** 2; yaw2 += ship.angVel.y ** 2;
  }
}
const T = n * dt;
const mean = Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, Math.round(v / n)]));
const total = Fsum / n;
const out = {
  U, REL, ORDER, ABL: [...ABL].join('+') || 'none', WIND: env.WIND === '1',
  sogKn: +((ship.pos.clone().sub(p0).dot(fwd) / T) * KN).toFixed(2),
  stwKn: +((sp / n) * KN).toFixed(2),
  rms: { pitchDeg: +(Math.sqrt(pitch2 / n) * 57.3).toFixed(2), rollDeg: +(Math.sqrt(roll2 / n) * 57.3).toFixed(2), heaveM: +Math.sqrt(heave2 / n).toFixed(3), yawDegS: +(Math.sqrt(yaw2 / n) * 57.3).toFixed(2) },
  meanForceAlongHeadingN: mean,
  sumOfForcesN: Math.round(total),
  // me_surge * dv/dt: what actually accelerated her along the heading; minus the forces = added-mass leak
  massTimesAccelN: Math.round(leak / n),
  integratorLeakN: Math.round(leak / n - total),
  meanAbsHeadingErrDeg: +((hdgErr / n) * 57.3).toFixed(1), helmSaturatedPct: Math.round((100 * helmSat) / n),
  dvKn: +(((ship.vel.dot(fwd) - vF0)) * KN).toFixed(2),
};
console.log(JSON.stringify(out));
