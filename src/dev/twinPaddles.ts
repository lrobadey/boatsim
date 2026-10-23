import * as THREE from 'three';
import type { ShipPhysics } from '../ship/physics';
import type { Crew } from '../ship/crew';
import type { PaddleGeometry } from './paddleVariants';
import { createPaddleFrame, paddleFrame } from './paddleKinematics';
import { createFlowSample } from '../world/waves';

/** Shared physical/visual geometry. Runtime axes: +x starboard, -z bow, +y up. */
export const PADDLE = { x: 13.5, y: 2, z: 3, radius: 3.6, width: 2.4,
  bladeHeight: 0.75, blades: 12, inertia: 45000, cd: 1.65,
  maxTorque: 12000, maxOmega: 0.8, gearEfficiency: 0.8, machineryMass: 24000 } as const;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export class TwinPaddles {
  sourceKW = 12;
  manual = false;
  commands = [0, 0]; // port, starboard; positive means ahead
  readonly wheels = [-1, 1].map(side => ({ side, angle: 0, previousAngle: 0, omega: 0,
    thrust: 0, rpm: 0, shaftW: 0, waterW: 0, frictionW: 0, storedW: 0, numericalW: 0,
    wetArea: 0, motorTorque: 0, waterTorque: 0, sourceW: 0 }));
  readonly wrench = { force: new THREE.Vector3(), torque: new THREE.Vector3() };
  hullW = 0; dissipationW = 0; waveW = 0; reactionW = 0; cpuMs = 0;
  private flows;
  private frame = createPaddleFrame();
  private tangent = new THREE.Vector3();
  private radial = new THREE.Vector3(); private point = new THREE.Vector3(); private normal = new THREE.Vector3(); private force = new THREE.Vector3();
  private rel = new THREE.Vector3(); private offset = new THREE.Vector3(); private axis = new THREE.Vector3();
  private bodyVel = new THREE.Vector3(); private waveVel = new THREE.Vector3();
  constructor(private crew: Crew, public geometry: PaddleGeometry = PADDLE) {
    this.flows = this.makeFlows();
  }
  private makeFlows() { return this.wheels.map(() => Array.from({ length: this.geometry.blades }, () => createFlowSample())); }
  setGeometry(ship: ShipPhysics, geometry: PaddleGeometry) {
    // A refit is a dev operation: stop shafts instead of creating angular momentum on a new rotor.
    this.geometry = geometry; this.flows = this.makeFlows(); this.reset();
    this.setWatchPower(ship, this.sourceKW);
  }
  mount(ship: ShipPhysics) {
    ship.externalDrive = this;
    this.setWatchPower(ship, this.sourceKW);
  }
  setWatchPower(ship: ShipPhysics, kw: number) {
    this.sourceKW = Math.max(0, kw);
    // Explicit dev machinery + active workers; food, relief watches and gear stress remain outside this trial.
    ship.setStaticLoad([-1, 1].flatMap(side => [
      ...(this.geometry.rotorMass ? Array.from({ length: 8 }, (_, i) => {
        const r = Math.sqrt(this.geometry.inertia / this.geometry.rotorMass!), t = i * Math.PI / 4;
        if (this.geometry.mechanism && this.geometry.mechanism !== 'wheel') return {
          mass: this.geometry.rotorMass! / 8, local: new THREE.Vector3(side*this.geometry.x, this.geometry.y,
            this.geometry.z + (i/7-.5)*2*(this.geometry.trackHalfLength ?? 28)) };
        return { mass: this.geometry.rotorMass! / 8, local: new THREE.Vector3(side * this.geometry.x,
          this.geometry.y + r * Math.cos(t), this.geometry.z + r * Math.sin(t)) };
      }) : []),
      { mass: this.geometry.machineryMass / 2 - (this.geometry.rotorMass ?? 0),
        local: new THREE.Vector3(side * (this.geometry.rotorMass ? 10.5 : this.geometry.x), this.geometry.y, this.geometry.z) },
      { mass: this.sourceKW * 1000 / 75 * 80 / 2, local: new THREE.Vector3(side * 6, 5.55, this.geometry.z) },
    ]));
  }
  reset() {
    for (const w of this.wheels) Object.assign(w, { angle: 0, previousAngle: 0, omega: 0, thrust: 0, rpm: 0,
      shaftW: 0, waterW: 0, frictionW: 0, storedW: 0, numericalW: 0, wetArea: 0, motorTorque: 0, waterTorque: 0, sourceW: 0 });
    this.wrench.force.set(0, 0, 0); this.wrench.torque.set(0, 0, 0);
    for (const bank of this.flows) for (const f of bank) f.warm = false;
  }
  step(dt: number, ship: ShipPhysics, totalForce: THREE.Vector3, totalTorque: THREE.Vector3) {
    const started = performance.now();
    const { radius: R, width, bladeHeight, blades, inertia: I, cd } = this.geometry;
    this.wrench.force.set(0, 0, 0); this.wrench.torque.set(0, 0, 0);
    this.hullW = this.dissipationW = this.waveW = this.reactionW = 0;
    // No free pivot: opposite shaft commands share the same finite installed power.
    if (!this.manual) {
      const base = this.crew.order.dir * this.crew.order.effort;
      const turn = ship.helm;
      this.commands[0] = clamp(base + turn, -1, 1);
      this.commands[1] = clamp(base - turn, -1, 1);
      if (Math.abs(base) < 0.01) { this.commands[0] = turn; this.commands[1] = -turn; }
    }
    this.axis.set(1, 0, 0).applyQuaternion(ship.quat);
    this.wheels.forEach((w, sideIndex) => {
      w.previousAngle = w.angle;
      w.thrust = w.waterTorque = w.waterW = w.wetArea = 0;
      const command = clamp(this.commands[sideIndex], -1, 1);
      const shaftLimit = Math.max(0, this.sourceKW) * 1000 * this.geometry.gearEfficiency / 2;
      // Torque-limited start, power-limited working range, unloaded speed governor.
      const target = -command * this.geometry.maxOmega;
      const error = target - w.omega;
      const capacity = Math.min(this.geometry.maxTorque * Math.min(1, this.sourceKW / 12) * Math.abs(command), shaftLimit / Math.max(this.geometry === PADDLE ? .25 : Math.min(.25, this.geometry.maxOmega*.3), Math.abs(w.omega)));
      const motor = command === 0 || this.crew.holdWater ? 0 : clamp(error * (this.geometry === PADDLE ? 30000 : 4 * this.geometry.maxTorque / this.geometry.maxOmega), -capacity, capacity);
      const brake = this.crew.holdWater ? clamp(-w.omega * I / dt, -this.geometry.maxTorque, this.geometry.maxTorque) : 0;
      const friction = -120 * w.omega - 60 * w.omega * Math.abs(w.omega) + brake;
      const oldOmega = w.omega;
      for (let b = 0; b < blades; b++) {
        const frame = paddleFrame(this.geometry, w.angle, b, this.frame);
        this.point.copy(frame.point); this.point.x *= w.side; ship.toWorld(this.point, this.point);
        this.normal.copy(frame.normal); this.normal.x *= w.side; this.normal.applyQuaternion(ship.quat);
        this.tangent.copy(frame.tangent); this.tangent.x *= w.side; this.tangent.applyQuaternion(ship.quat);
        const flow = ship.waves.sampleFlowAt(this.point.x, this.point.y, this.point.z, ship.time, this.flows[sideIndex][b]);
        const verticalSpan = Math.max(0.08, bladeHeight * Math.abs(this.radial.set(frame.heightAxis.x*w.side,frame.heightAxis.y,frame.heightAxis.z).applyQuaternion(ship.quat).y) + width*Math.abs(this.radial.set(frame.widthAxis.x*w.side,frame.widthAxis.y,frame.widthAxis.z).applyQuaternion(ship.quat).y));
        const wet = clamp(0.5 + (flow.height - this.point.y) / verticalSpan, 0, 1);
        const area = width * bladeHeight * (this.geometry.areaFactor ?? 1) * wet;
        if (area === 0) continue;
        ship.pointVel(this.point, this.bodyVel);
        this.waveVel.set(flow.vx, flow.vy, flow.vz);
        this.rel.copy(this.bodyVel).addScaledVector(this.tangent, oldOmega).sub(this.waveVel);
        const vn = this.rel.dot(this.normal);
        const fn = -0.5 * 1025 * cd * area * vn * Math.abs(vn);
        this.force.copy(this.normal).multiplyScalar(fn);
        this.wrench.force.add(this.force);
        this.offset.copy(this.point).sub(ship.pos).cross(this.force); this.wrench.torque.add(this.offset);
        const generalizedForce = this.force.dot(this.tangent);
        w.waterTorque += generalizedForce;
        w.waterW += generalizedForce * oldOmega;
        w.wetArea += area;
        w.thrust += this.force.dot(this.rel.set(0, 0, -1).applyQuaternion(ship.quat));
        this.hullW += this.force.dot(this.bodyVel);
        this.waveW += this.force.dot(this.waveVel);
        this.dissipationW += -fn * vn;
      }
      const net = motor + friction + w.waterTorque;
      w.omega += net * dt / I;
      w.angle += (oldOmega + w.omega) * 0.5 * dt;
      // Transfer rotor acceleration to its angular momentum, not twice into hull pitch.
      this.wrench.torque.addScaledVector(this.axis, -net);
      const reaction = -net * ship.angVel.dot(this.axis);
      this.reactionW += reaction; this.hullW += reaction;
      w.rpm = -w.omega * 60 / (2 * Math.PI);
      w.motorTorque = motor;
      w.shaftW = motor * oldOmega;
      w.sourceW = Math.max(0, w.shaftW) / this.geometry.gearEfficiency;
      w.frictionW = -friction * oldOmega;
      w.storedW = 0.5 * I * (w.omega ** 2 - oldOmega ** 2) / dt;
      w.numericalW = 0.5 * I * (w.omega - oldOmega) ** 2 / dt;
    });
    totalForce.add(this.wrench.force); totalTorque.add(this.wrench.torque);
    this.cpuMs = performance.now() - started;
  }
}
