import * as THREE from 'three';
import type { Column } from './hull';
import { TRIREME, type ShipDesign } from './design';
import { dragCoefficient } from './resistance';
import { Crew } from './crew';
import { RowingSystem } from './rowing';
import { hullLateralForce } from './hullLateral';
import { SailingSystem } from './sailing';
import { Mooring } from './mooring';
import type { BoxSolid } from '../world/walkable';
import { createFlowSample } from '../world/waves';
import type { WaveField } from '../world/waves';
import type { Wind } from '../world/wind';
import type { Terrain } from '../world/terrain';
import { clamp } from '../core/util';

const RHO = 1025;
const RHO_AIR = 1.225;
const G = 9.81;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _h = new THREE.Vector3();
const _hullHorizontalForce = new THREE.Vector3();
const _windSample = new THREE.Vector3();
const _windPointVelocity = new THREE.Vector3();
// quay (pier face) contact: fendered spring + damper along the face normal, Coulomb friction
const QUAY_K = 3e5;
const QUAY_C = 8e4;
const QUAY_MU = 0.25;

/**
 * 6-DOF rigid-body ship. All hydrostatic/hydrodynamic forces are sampled over columns derived
 * from the hull geometry; propulsion from oar blades, steering oars and the sail is computed from
 * the relative flow at each surface. Nothing is a "max speed" constant. The ship's hull and
 * coefficients come from its ShipDesign (the trireme by default).
 */
export class ShipPhysics {
  readonly columns: Column[];
  readonly mass: number;
  readonly inertia = new THREE.Vector3();
  readonly cg: THREE.Vector3; // local centre of gravity
  // state
  readonly pos = new THREE.Vector3(); // world CoG
  readonly quat = new THREE.Quaternion();
  readonly vel = new THREE.Vector3();
  readonly angVel = new THREE.Vector3(); // world
  // previous state for render interpolation
  readonly prevPos = new THREE.Vector3();
  readonly prevQuat = new THREE.Quaternion();
  // accumulators
  private force = new THREE.Vector3();
  private torque = new THREE.Vector3();
  readonly rowing: RowingSystem;
  readonly sailing: SailingSystem;
  readonly mooring: Mooring;
  /** deck cargo / built pieces: weight acting at ship-local points (spec §8) */
  readonly payload: { mass: number; local: THREE.Vector3 }[] = [];
  private flow = createFlowSample();
  private contactPts: THREE.Vector3[] = [];
  /** outrigger edge points that meet the pier face when she is alongside (harbour boxes only) */
  private quayPts: THREE.Vector3[] = [];
  // controls
  helm = 0; // -1..1 (positive = turn to starboard)
  rudderAngle = 0;
  // telemetry
  speed = 0; // forward speed through water (m/s)
  leeway = 0; // signed water-relative drift angle (rad; positive = starboard)
  heading = 0; // compass bearing (rad)
  heel = 0;
  pitch = 0;
  grounding = 0; // contact intensity
  oarThrust = 0;
  bowImmersion = 0;
  bowSlam = 0;
  displacement = 0;
  time = 0;

  constructor(private waves: WaveField, private wind: Wind, private terrain: Terrain, public crew: Crew, readonly design: ShipDesign = TRIREME) {
    this.cg = new THREE.Vector3(0, design.mass.cgY, design.mass.cgZ);
    this.mooring = new Mooring(design.dockingEnabled, design.anchoringEnabled,
      new THREE.Vector3(0, design.deck.deckY(design.anchor.s), design.hull.zOf(design.anchor.s)), design.anchor.stiffnessScale);
    this.mooring.seabed = (x, z) => terrain.heightAt(x, z);
    const hull = design.hull;
    this.columns = hull.buildColumns(design.columns.stations, design.columns.strips);
    this.rowing = new RowingSystem(crew, design.oars);
    this.sailing = new SailingSystem(design.rig, design.aero);
    crew.maxOrder = design.oars.maxOrder;
    // mass from displacement at the design waterline: the ship floats where it was designed to
    let vol = 0;
    for (const c of this.columns) vol += c.area * Math.max(0, -c.bottom);
    this.mass = vol * RHO;
    this.displacement = this.mass;
    // inertia from a mass distribution over the hull columns (+ rig and crew mass high up)
    let ix = 0,
      iy = 0,
      iz = 0,
      wsum = 0;
    for (const c of this.columns) wsum += c.area * (c.top - c.bottom);
    for (const c of this.columns) {
      const m = (this.mass * c.area * (c.top - c.bottom)) / wsum;
      const y = (c.top + c.bottom) / 2 - this.cg.y;
      const h = c.top - c.bottom;
      ix += m * (y * y + h * h / 12 + c.z * c.z);
      iy += m * (c.x * c.x + c.z * c.z);
      iz += m * (c.x * c.x + y * y + h * h / 12);
    }
    const [sx, sy, sz] = design.mass.inertiaScale;
    this.inertia.set(ix * sx, iy * sy, iz * sz);
    // contact points for grounding: column bottoms + design extras (ram, stern) + sides
    for (const c of this.columns) this.contactPts.push(new THREE.Vector3(c.x, c.bottom, c.z));
    for (const [x, y, z] of design.contactExtras) this.contactPts.push(new THREE.Vector3(x, y, z));
    for (const s of design.quayStations) for (const sg of [-1, 1]) this.quayPts.push(new THREE.Vector3(sg * design.deck.outerHalfWidth(s), hull.sheer(s), hull.zOf(s)));
    for (let i = 0; i <= 10; i++) {
      const s = 0.05 + (i / 10) * 0.9;
      for (const sg of [-1, 1]) {
        this.contactPts.push(new THREE.Vector3(sg * hull.halfBeam(s), 0.3, hull.zOf(s)));
        this.contactPts.push(new THREE.Vector3(sg * hull.halfBeam(s), hull.sheer(s) * 0.8, hull.zOf(s)));
      }
    }
  }

  place(x: number, z: number, heading: number) {
    this.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading);
    const y = this.waves.heightAt(x, z, this.time);
    this.pos.set(x, y + this.cg.y, z);
    this.vel.set(0, 0, 0);
    this.angVel.set(0, 0, 0);
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    this.rowing.reset(this, this.time);
    this.sailing.reset();
  }

  /** local hull point -> world */
  toWorld(local: THREE.Vector3, out: THREE.Vector3) {
    return out.copy(local).sub(this.cg).applyQuaternion(this.quat).add(this.pos);
  }
  /** velocity of a world point on the body */
  pointVel(world: THREE.Vector3, out: THREE.Vector3) {
    _v3.copy(world).sub(this.pos);
    return out.copy(this.angVel).cross(_v3).add(this.vel);
  }
  /** for subsystems stepping inside step() (mooring lines, anchor) */
  addForceAtPublic(f: THREE.Vector3, world: THREE.Vector3) {
    this.addForceAt(f, world);
  }
  get payloadMass() {
    let m = 0;
    for (const p of this.payload) m += p.mass;
    return m;
  }
  /** Legacy sail fields proxy the coupled sailing subsystem. */
  get sailSet() { return this.sailing.current.deployment; }
  set sailSet(value: number) { this.sailing.current.deployment = clamp(value, 0, 1); }
  get sailTarget() { return this.sailing.deploymentTarget; }
  set sailTarget(value: number) { this.sailing.deploymentTarget = clamp(value, 0, 1); }
  get yardAngle() { return this.sailing.current.yardAngle; }
  set yardAngle(value: number) { this.sailing.current.yardAngle = clamp(value, -this.sailing.rig.maxYardAngle, this.sailing.rig.maxYardAngle); }
  get sailForce() { return this.sailing.telemetry.forwardForce; }
  get sailPressure() { return this.sailing.telemetry.pressure; }
  get apparentWind() { return this.sailing.telemetry.apparentWind; }
  private addForceAt(f: THREE.Vector3, world: THREE.Vector3) {
    this.force.add(f);
    _v3.copy(world).sub(this.pos).cross(f);
    this.torque.add(_v3);
  }

  step(dt: number) {
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    this.time += dt;
    this.force.set(0, -this.mass * G, 0);
    this.torque.set(0, 0, 0);
    const invQ = _q.copy(this.quat).invert();

    this.hydrostatics(dt, invQ);
    this.rowing.step(dt, this.time, this, this.helm, this.waves, this.force, this.torque);
    this.oarThrust = this.rowing.telemetry.oarThrust;
    this.rudders(dt, invQ);
    this.sailing.step(dt, this.time, this, this.wind, this.force, this.torque);
    this.windage(invQ);
    for (const p of this.payload) this.addForceAt(_v.set(0, -p.mass * G, 0), this.toWorld(p.local, _p));
    this.mooring.step(dt, this);
    this.ground();
    this.boundary();

    // integrate (semi-implicit Euler)
    this.vel.addScaledVector(this.force, dt / (this.mass + this.payloadMass));
    const tb = _v.copy(this.torque).applyQuaternion(invQ);
    const wb = _v2.copy(this.angVel).applyQuaternion(invQ);
    const I = this.inertia;
    // gyroscopic term w x (I w)
    const Iw = new THREE.Vector3(I.x * wb.x, I.y * wb.y, I.z * wb.z);
    const gyro = new THREE.Vector3().crossVectors(wb, Iw);
    wb.x += ((tb.x - gyro.x) / I.x) * dt;
    wb.y += ((tb.y - gyro.y) / I.y) * dt;
    wb.z += ((tb.z - gyro.z) / I.z) * dt;
    this.angVel.copy(wb).applyQuaternion(this.quat);
    this.pos.addScaledVector(this.vel, dt);
    const w = this.angVel;
    const dq = new THREE.Quaternion(w.x * dt * 0.5, w.y * dt * 0.5, w.z * dt * 0.5, 0).multiply(this.quat);
    this.quat.x += dq.x;
    this.quat.y += dq.y;
    this.quat.z += dq.z;
    this.quat.w += dq.w;
    this.quat.normalize();

    // telemetry
    const fwd = _v.set(0, 0, -1).applyQuaternion(this.quat);
    const flow = this.waves.sampleFlowAt(this.pos.x, this.pos.y, this.pos.z, this.time, this.flow);
    this.speed = _v2.set(this.vel.x - flow.vx, this.vel.y - flow.vy, this.vel.z - flow.vz).dot(fwd);
    this.heading = Math.atan2(fwd.x, -fwd.z);
    const right = _v2.set(1, 0, 0).applyQuaternion(this.quat);
    const waterVelocity = _v3.set(this.vel.x - flow.vx, this.vel.y - flow.vy, this.vel.z - flow.vz);
    this.leeway = Math.atan2(waterVelocity.dot(right), waterVelocity.dot(fwd));
    this.heel = Math.asin(clamp(right.y, -1, 1));
    this.pitch = Math.asin(clamp(fwd.y, -1, 1));
    this.rowing.refreshWorld(this);
  }

  private hydrostatics(dt: number, invQ: THREE.Quaternion) {
    const t = this.time;
    const cols = this.columns;
    const d = this.design, hull = d.hull, hy = d.hydro;
    let bowImm = 0;
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
      // centre of the submerged part
      const cp = _v2.copy(pb).lerp(pt, f * 0.5);
      // buoyancy
      const Fb = _v.set(0, RHO * G * vol, 0);
      this.addForceAt(Fb, cp);
      if (c.z < -hull.length * 0.3) bowImm += subLen;

      // hydrodynamic drag in hull frame, relative to the water (vertical orbital velocity included)
      const pv = this.pointVel(cp, _v);
      const flow = this.waves.sampleFlowAt(cp.x, cp.y, cp.z, t, this.flow);
      pv.x -= flow.vx; pv.y -= flow.vy; pv.z -= flow.vz;
      const lv = pv.applyQuaternion(invQ); // local velocity
      const subDepth = Math.min(subLen, 2.5);
      // Coupled shallow-hull sideforce and its induced drag, with the existing crossflow loss.
      // lateral plane: the station's submerged profile depth (keel to water) shared by beam fraction,
      // or (trireme calibration) each column's own submerged depth with the strips sharing the section
      const Alat = hy.lateralFromProfile
        ? Math.min(subLen + c.bottom - c.keel!, 2.5) * c.dz * c.latW!
        : subDepth * c.dz / d.columns.strips;
      hullLateralForce(lv.x, lv.z, Alat, _hullHorizontalForce);
      const Fx = _hullHorizontalForce.x;
      // longitudinal: skin friction + form and wave-making drag (see resistance.ts)
      const Swet = c.area * hy.wettedFactor;
      const Fz = -0.5 * RHO * dragCoefficient(hy.resistance, lv.z, hull.length) * Swet * lv.z * Math.abs(lv.z) + _hullHorizontalForce.z;
      // vertical: radiation/viscous damping
      const Fy = -0.5 * RHO * hy.heaveDampQuad * c.area * lv.y * Math.abs(lv.y) - hy.heaveDampLin * c.area * lv.y;
      const Fl = _v.set(Fx, Fy, Fz).applyQuaternion(this.quat);
      this.addForceAt(Fl, cp);
    }
    this.bowSlam = Math.max(0, bowImm - this.bowImmersion) / dt;
    this.bowImmersion = bowImm;
    // weak angular damping (added-mass, appendages)
    this.torque.addScaledVector(this.angVel, -this.mass * hy.angularDamp);
    // roll damping: bilge/keel eddy-making plus 170 oar blades acting as outriggers when in the
    // water (much stronger with the oars run out than with them shipped)
    const fwdAxis = _v.set(0, 0, -1).applyQuaternion(this.quat);
    const rollRate = this.angVel.dot(fwdAxis);
    // Blade forces now supply actual oar roll damping; retain only hull damping here.
    this.torque.addScaledVector(fwdAxis, -hy.rollDampLin * rollRate - hy.rollDampQuad * rollRate * Math.abs(rollRate));
  }

  private rudders(dt: number, invQ: THREE.Quaternion) {
    // helmsman moves the tillers at a finite rate
    const r = this.design.rudder, hull = this.design.hull;
    const target = -this.helm * r.maxAngle; // positive rudder angle turns to port
    this.rudderAngle += clamp(target - this.rudderAngle, -r.rate * dt, r.rate * dt);
    const d = this.rudderAngle;
    for (const side of [-1, 1]) {
      const s = r.s;
      const local = _p.set(side * (hull.halfBeam(s) + r.xOut), r.y, hull.zOf(s) + r.dz);
      const w = this.toWorld(local, _v2.copy(local));
      const water = this.waves.heightAt(w.x, w.z, this.time);
      const depth = water - w.y;
      if (depth < 0) continue; // blade lifted clear (heel)
      const sub = clamp(depth / r.depthNorm, 0, 1);
      const v = this.pointVel(w, _v);
      const flow = this.waves.sampleFlowAt(w.x, w.y, w.z, this.time, this.flow);
      v.x -= flow.vx; v.y -= flow.vy; v.z -= flow.vz;
      v.applyQuaternion(invQ); // local blade velocity relative to moving water
      v.y = 0;
      const sp = v.length();
      if (sp < 0.01) continue;
      // blade normal (horizontal); chord along +z rotated by rudder angle (positive = trailing edge to port)
      const n = _n.set(Math.cos(d), 0, Math.sin(d));
      const vn = v.dot(n);
      // thin-plate normal force: C_N ~ 2*pi*sin(alpha), stalls ~1.2
      const CN = clamp((2 * Math.PI * vn) / sp, -1.2, 1.2);
      const Fn = -0.5 * RHO * r.area * sub * sp * sp * CN;
      const F = n.multiplyScalar(Fn);
      // profile drag
      F.addScaledVector(v, -0.5 * RHO * r.area * sub * 0.02 * sp);
      F.applyQuaternion(this.quat);
      this.addForceAt(F, w);
    }
  }

  private windage(invQ: THREE.Quaternion) {
    // Keep hull/rig windage independent from sail telemetry. Sample it at its own physical point
    // and include rigid-body point velocity, so rotation contributes to local apparent air.
    const w = this.design.windage;
    const local = _n.set(w.point[0], w.point[1], w.point[2]);
    const world = this.toWorld(local, _p);
    if (this.wind.sampleAt) this.wind.sampleAt(world.x, world.y, world.z, this.time, _windSample);
    else _windSample.set(this.wind.vx, 0, this.wind.vz);
    this.pointVel(world, _windPointVelocity);
    const apparent = _windSample.sub(_windPointVelocity).applyQuaternion(invQ);
    const Fx = 0.5 * RHO_AIR * w.lateralCd * w.lateralArea * apparent.x * Math.abs(apparent.x);
    const Fz = 0.5 * RHO_AIR * w.frontalCd * w.frontalArea * apparent.z * Math.abs(apparent.z);
    const force = _v.set(Fx, 0, Fz).applyQuaternion(this.quat);
    this.addForceAt(force, world);
  }

  private ground() {
    let g = 0;
    for (const lp of this.contactPts) {
      const w = this.toWorld(lp, _p.copy(lp));
      const th = this.terrain.heightAt(w.x, w.z);
      const pen = th - w.y;
      if (pen <= 0) continue;
      const n = this.terrain.normalAt(w.x, w.z, _n);
      const pe = Math.min(pen * Math.max(0.15, n.y), 1.2);
      const v = this.pointVel(w, _v);
      const vn = v.dot(n);
      const Fn = Math.max(0, 2.2e5 * pe - 6e4 * vn);
      const F = _v2.copy(n).multiplyScalar(Fn);
      // friction
      const vt = v.addScaledVector(n, -vn);
      const vtl = vt.length();
      // friction: a greased keel slides on sand (gentle slopes), grinds on rock (steep)
      const mu = 0.12 + 0.5 * Math.min(1, (1 - n.y) * 3);
      if (vtl > 1e-4) F.addScaledVector(vt, (-mu * Fn * Math.min(1, vtl / 0.3)) / vtl);
      this.addForceAt(F, w);
      g += Fn;
    }
    this.grounding = g / (this.mass * G);
    const quays = this.mooring.layout?.shipColliders;
    if (quays && quays.length) this.quayContacts(quays);
  }

  /** outrigger edge against the harbour boxes: spring + damper on the nearest face, friction, bump reports */
  private quayContacts(boxes: BoxSolid[]) {
    for (const lp of this.quayPts) {
      const w = this.toWorld(lp, _h);
      for (const b of boxes) {
        if (w.y < b.y0 || w.y > b.y1) continue;
        const dx = w.x - b.cx,
          dz = w.z - b.cz;
        const c = Math.cos(b.rot),
          sn = Math.sin(b.rot);
        const u = dx * c - dz * sn, // box-local coordinates
          v = dx * sn + dz * c;
        const su = b.hx - Math.abs(u),
          sv = b.hz - Math.abs(v);
        if (su <= 0 || sv <= 0) continue;
        // outward normal of the nearest face (local x = (c, -sn), local z = (sn, c))
        let nx: number, nz: number, pen: number;
        if (su < sv) {
          const g = u >= 0 ? 1 : -1;
          nx = g * c;
          nz = -g * sn;
          pen = su;
        } else {
          const g = v >= 0 ? 1 : -1;
          nx = g * sn;
          nz = g * c;
          pen = sv;
        }
        const vel = this.pointVel(w, _v);
        const vn = vel.x * nx + vel.z * nz; // + = moving out of the box
        const Fn = Math.max(0, QUAY_K * pen - QUAY_C * vn);
        const F = _v2.set(Fn * nx, 0, Fn * nz);
        const tx = vel.x - vn * nx,
          tz = vel.z - vn * nz;
        const tl = Math.hypot(tx, tz);
        if (tl > 1e-4) {
          const k = (-QUAY_MU * Fn * Math.min(1, tl / 0.3)) / tl;
          F.x += k * tx;
          F.z += k * tz;
        }
        this.addForceAt(F, w);
        if (vn < 0) this.mooring.noteContact(-vn);
      }
    }
  }

  private boundary() {
    const lim = 5600;
    const r = Math.max(Math.abs(this.pos.x), Math.abs(this.pos.z));
    if (r > lim) {
      const k = (r - lim) * 400;
      this.force.x += -Math.sign(this.pos.x) * (Math.abs(this.pos.x) > lim ? k : 0);
      this.force.z += -Math.sign(this.pos.z) * (Math.abs(this.pos.z) > lim ? k : 0);
    }
  }

  /** interpolated pose for rendering */
  pose(alpha: number, pos: THREE.Vector3, quat: THREE.Quaternion) {
    pos.lerpVectors(this.prevPos, this.pos, alpha);
    quat.slerpQuaternions(this.prevQuat, this.quat, alpha);
  }
}
