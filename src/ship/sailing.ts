import * as THREE from 'three';
import { clamp, smoothstep } from '../core/util';
import { evaluateSailSample, sailSampleArea } from './sailGeometry';
import { TRIREME, type SailRig, type SailAero } from './design';

const AIR_DENSITY = 1.225;
const PI = Math.PI;
const INCIDENCE_START = (2 * PI) / 180;
const INCIDENCE_FULL = (9 * PI) / 180;
const SEPARATION_START = (18 * PI) / 180;
const SEPARATION_FULL = (32 * PI) / 180;
/** Gameplay calibration/preferences, not historically measured coefficients. */
export const SAIL_AERO = Object.freeze({
  pressureDrag: 1.7,
  trimSidePenalty: 0.22,
  heelReliefStart: (8 * PI) / 180,
  heelReliefFull: (18 * PI) / 180,
  heelSidePenalty: 1.8,
  trimSlewPenalty: 300,
});

export interface SailAeroCoefficients {
  alpha: number;
  /** Raw section CL before fill scaling; the force uses abs(fill) * CL. */
  liftCoefficient: number;
  dragCoefficient: number;
}

/**
 * Evaluate a passive sail force in the same coordinate frame as `airVelocity` and `normal`.
 * `normal` is expected to be unit length; optional coefficient output is mutated in place.
 */
export function evaluateSailForce(
  airVelocity: THREE.Vector3,
  normal: THREE.Vector3,
  area: number,
  fill: number,
  out: THREE.Vector3,
  coefficients?: SailAeroCoefficients,
  aero: SailAero = SAIL_AERO,
): THREE.Vector3 {
  const ux = airVelocity.x;
  const uy = airVelocity.y;
  const uz = airVelocity.z;
  const speed2 = ux * ux + uy * uy + uz * uz;
  const exposedArea = Math.max(0, area);
  if (speed2 < 1e-16 || exposedArea === 0) {
    out.set(0, 0, 0);
    if (coefficients) coefficients.alpha = coefficients.liftCoefficient = coefficients.dragCoefficient = 0;
    return out;
  }

  const speed = Math.sqrt(speed2);
  const dx = ux / speed;
  const dy = uy / speed;
  const dz = uz / speed;
  const nx = normal.x;
  const ny = normal.y;
  const nz = normal.z;
  const incidenceDot = clamp(dx * nx + dy * ny + dz * nz, -1, 1);
  const alpha = Math.asin(Math.abs(incidenceDot));
  const attached = 4 * Math.sin(alpha) * Math.cos(alpha);
  const separated = Math.sin(2 * alpha);
  const separation = smoothstep(SEPARATION_START, SEPARATION_FULL, alpha);
  const cl = attached + (separated - attached) * separation;
  const fillMagnitude = clamp(Math.abs(fill), 0, 1);
  const effectiveLift = fillMagnitude * cl;
  const pressureDrag = (0.2 + 0.8 * fillMagnitude) * aero.pressureDrag * Math.sin(alpha) ** 2;
  const cd = 0.035 + pressureDrag + (effectiveLift * effectiveLift) / (PI * 0.7 * 0.7);

  // Unit direction perpendicular to the air flow, within the plane spanned by flow and normal.
  const perpendicular = Math.sqrt(Math.max(0, 1 - incidenceDot * incidenceDot));
  let lx = 0;
  let ly = 0;
  let lz = 0;
  if (perpendicular >= 1e-8) {
    const liftSign = Math.sign(incidenceDot);
    lx = (nx - incidenceDot * dx) * (liftSign / perpendicular);
    ly = (ny - incidenceDot * dy) * (liftSign / perpendicular);
    lz = (nz - incidenceDot * dz) * (liftSign / perpendicular);
  }
  const qArea = 0.5 * AIR_DENSITY * speed2 * exposedArea;
  out.set(
    qArea * (cd * dx + effectiveLift * lx),
    qArea * (cd * dy + effectiveLift * ly),
    qArea * (cd * dz + effectiveLift * lz),
  );
  if (coefficients) {
    coefficients.alpha = alpha;
    coefficients.liftCoefficient = cl;
    coefficients.dragCoefficient = cd;
  }
  return out;
}

export interface SailBody {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  vel: THREE.Vector3;
  angVel: THREE.Vector3;
  cg: THREE.Vector3;
}

export interface SailWind {
  vx: number;
  vz: number;
  sampleAt?(x: number, y: number, z: number, time: number, out: THREE.Vector3): THREE.Vector3;
}

export type SailStatus = 'furled' | 'setting' | 'drawing' | 'luffing' | 'aback';

export interface SailState {
  deployment: number;
  yardAngle: number;
  fill: number;
  /** Signed billow used by the renderer; positive displaces along the shared +normal. */
  pressure: number;
  flutter: number;
}

export interface SailTelemetry {
  forwardForce: number;
  lateralForce: number;
  load: number;
  pressure: number;
  flutter: number;
  apparentSpeed: number;
  heelMoment: number;
  pointOfSail: 'calm' | 'windward' | 'reach' | 'run';
  apparentWind: THREE.Vector3;
  apparentFrom: number;
  status: SailStatus;
}

export interface SailingBodyLike extends SailBody {}

export class SailingSystem {
  deploymentTarget = 0;
  trimMode: 'auto' | 'manual' = 'auto';
  manualYardTarget = 0;
  readonly current: SailState = { deployment: 0, yardAngle: 0, fill: 0, pressure: 0, flutter: 0 };
  readonly previous: SailState = { deployment: 0, yardAngle: 0, fill: 0, pressure: 0, flutter: 0 };
  readonly telemetry: SailTelemetry = {
    forwardForce: 0,
    lateralForce: 0,
    load: 0,
    pressure: 0,
    flutter: 0,
    apparentSpeed: 0,
    heelMoment: 0,
    pointOfSail: 'calm',
    apparentWind: new THREE.Vector3(),
    apparentFrom: 0,
    status: 'furled',
  };

  constructor(readonly rig: SailRig = TRIREME.rig, readonly aero: SailAero = TRIREME.aero) {
    this.trimSidePenalty = aero.trimSidePenalty;
  }

  private trimTimer = 0;
  private trimSidePenalty: number;
  private readonly localPoint = new THREE.Vector3();
  private readonly worldPoint = new THREE.Vector3();
  private readonly pointOffset = new THREE.Vector3();
  private readonly pointVelocity = new THREE.Vector3();
  private readonly windVelocity = new THREE.Vector3();
  private readonly airWorld = new THREE.Vector3();
  private readonly airLocal = new THREE.Vector3();
  private readonly normalLocal = new THREE.Vector3();
  private readonly normalWorld = new THREE.Vector3();
  private readonly forceSample = new THREE.Vector3();
  private readonly totalForceWorld = new THREE.Vector3();
  private readonly totalTorqueWorld = new THREE.Vector3();
  private readonly torqueAtSample = new THREE.Vector3();
  private readonly centerAirLocal = new THREE.Vector3();
  private readonly candidateForce = new THREE.Vector3();
  private readonly candidateNormal = new THREE.Vector3();
  private readonly forwardWorld = new THREE.Vector3();
  private readonly starboardWorld = new THREE.Vector3();
  private readonly inverseQuat = new THREE.Quaternion();

  /** Advance deployment, fill, trim, and nine distributed aerodynamic loads. */
  step(
    dt: number,
    time: number,
    body: SailingBodyLike,
    wind: SailWind,
    force: THREE.Vector3,
    torque: THREE.Vector3,
  ): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.copyState(this.current, this.previous);
    this.deploymentTarget = clamp(Number.isFinite(this.deploymentTarget) ? this.deploymentTarget : 0, 0, 1);
    this.manualYardTarget = clamp(
      Number.isFinite(this.manualYardTarget) ? this.manualYardTarget : 0,
      -this.rig.maxYardAngle,
      this.rig.maxYardAngle,
    );
    const deploymentStep = dt / 6;
    this.current.deployment += clamp(this.deploymentTarget - this.current.deployment, -deploymentStep, deploymentStep);
    this.current.deployment = clamp(this.current.deployment, 0, 1);

    const invQ = this.inverseQuat.copy(body.quat).invert();
    this.setLocalNormal(this.current.yardAngle, this.normalLocal);
    this.centerAirLocal.copy(this.centerAirAt(body, wind, time, invQ, this.current.yardAngle));
    const centerSpeed = this.centerAirLocal.length();
    const centerIncidenceDot = centerSpeed > 1e-8 ? clamp(this.centerAirLocal.dot(this.normalLocal) / centerSpeed, -1, 1) : 0;
    const incidence = Math.asin(Math.abs(centerIncidenceDot));
    const fillTarget = this.fillTarget(this.centerAirLocal, this.normalLocal, centerSpeed, centerIncidenceDot);
    const collapsing = fillTarget * this.current.fill < 0 || Math.abs(fillTarget) < Math.abs(this.current.fill);
    const fillTau = collapsing ? 0.22 : 0.65;
    this.current.fill += (fillTarget - this.current.fill) * (1 - Math.exp(-dt / fillTau));
    this.current.fill = clamp(this.current.fill, -1, 1);

    this.starboardWorld.set(1, 0, 0).applyQuaternion(body.quat);
    const absoluteHeel = Math.abs(Math.asin(clamp(this.starboardWorld.y, -1, 1)));
    // Crew trade drive against heel through actual yard choices; this preference is not a heel cap.
    this.trimSidePenalty =
      this.aero.trimSidePenalty +
      this.aero.heelSidePenalty * smoothstep(this.aero.heelReliefStart, this.aero.heelReliefFull, absoluteHeel);

    this.trimTimer += dt;
    while (this.trimTimer >= 0.25 - 1e-12) {
      this.trimTimer = Math.max(0, this.trimTimer - 0.25);
      this.updateAutoTrim(centerSpeed, incidence, this.centerAirLocal);
    }
    const yardTarget = this.trimMode === 'manual' ? this.manualYardTarget : this.autoYardTarget;
    this.current.yardAngle += clamp(yardTarget - this.current.yardAngle, -0.25 * dt, 0.25 * dt);
    this.current.yardAngle = clamp(this.current.yardAngle, -this.rig.maxYardAngle, this.rig.maxYardAngle);

    // Refresh rig-center telemetry at the actual yard pose used for this force evaluation.
    this.setLocalNormal(this.current.yardAngle, this.normalLocal);
    this.centerAirLocal.copy(this.centerAirAt(body, wind, time, invQ, this.current.yardAngle));
    const finalCenterSpeed = this.centerAirLocal.length();
    const finalCenterDot = finalCenterSpeed > 1e-8 ? clamp(this.centerAirLocal.dot(this.normalLocal) / finalCenterSpeed, -1, 1) : 0;
    const finalIncidence = Math.asin(Math.abs(finalCenterDot));

    this.totalForceWorld.set(0, 0, 0);
    this.totalTorqueWorld.set(0, 0, 0);
    let load = 0;
    const areaEach = sailSampleArea(this.current.deployment, this.rig);
    this.setWorldNormal(body, this.current.yardAngle, this.normalWorld);
    for (let i = 0; i < this.rig.sampleCount; i++) {
      evaluateSailSample(i, this.current.deployment, this.current.yardAngle, this.localPoint, this.rig);
      this.worldPoint.copy(this.localPoint).sub(body.cg).applyQuaternion(body.quat).add(body.pos);
      this.pointOffset.copy(this.worldPoint).sub(body.pos);
      this.pointVelocity.copy(body.angVel).cross(this.pointOffset).add(body.vel);
      this.sampleWind(wind, this.worldPoint, time, this.windVelocity);
      this.airWorld.copy(this.windVelocity).sub(this.pointVelocity);
      evaluateSailForce(this.airWorld, this.normalWorld, areaEach, this.current.fill, this.forceSample, undefined, this.aero);
      this.totalForceWorld.add(this.forceSample);
      this.torqueAtSample.copy(this.pointOffset).cross(this.forceSample);
      this.totalTorqueWorld.add(this.torqueAtSample);
      load += this.forceSample.length();
    }
    force.add(this.totalForceWorld);
    torque.add(this.totalTorqueWorld);
    this.forwardWorld.set(0, 0, -1).applyQuaternion(body.quat);
    this.starboardWorld.set(1, 0, 0).applyQuaternion(body.quat);
    const telemetry = this.telemetry;
    telemetry.forwardForce = this.totalForceWorld.dot(this.forwardWorld);
    telemetry.lateralForce = this.totalForceWorld.dot(this.starboardWorld);
    telemetry.load = load;
    telemetry.heelMoment = this.totalTorqueWorld.dot(this.forwardWorld);
    telemetry.apparentWind.copy(this.centerAirLocal);
    telemetry.apparentSpeed = finalCenterSpeed;
    telemetry.apparentFrom = Math.atan2(-this.centerAirLocal.x, this.centerAirLocal.z);
    telemetry.pointOfSail = this.pointOfSail(finalCenterSpeed, telemetry.apparentFrom);
    telemetry.pressure = this.current.deployment > 0
      ? this.current.fill * clamp(load / (0.5 * AIR_DENSITY * this.rig.area * 8 * 8), 0, 1)
      : 0;
    telemetry.flutter = clamp(
      this.current.deployment * (1 - Math.abs(this.current.fill)) * smoothstep(0.3, 3, finalCenterSpeed),
      0,
      1,
    );
    telemetry.status = this.status(finalIncidence);
    this.current.pressure = telemetry.pressure;
    this.current.flutter = telemetry.flutter;
  }

  /** Match interpolation history and clear the trim schedule without deploying the sail. */
  reset(): void {
    this.copyState(this.current, this.previous);
    this.trimTimer = 0;
  }

  private autoYardTarget = 0;

  private copyState(from: SailState, to: SailState) {
    to.deployment = from.deployment;
    to.yardAngle = from.yardAngle;
    to.fill = from.fill;
    to.pressure = from.pressure;
    to.flutter = from.flutter;
  }

  private setLocalNormal(yard: number, out: THREE.Vector3) {
    return out.set(Math.sin(yard), 0, Math.cos(yard));
  }

  private setWorldNormal(body: SailBody, yard: number, out: THREE.Vector3) {
    return this.setLocalNormal(yard, out).applyQuaternion(body.quat);
  }

  private sampleWind(wind: SailWind, point: THREE.Vector3, time: number, out: THREE.Vector3) {
    if (wind.sampleAt) return wind.sampleAt(point.x, point.y, point.z, time, out);
    return out.set(wind.vx, 0, wind.vz);
  }

  private centerAirAt(body: SailBody, wind: SailWind, time: number, invQ: THREE.Quaternion, yard: number) {
    evaluateSailSample(4, this.current.deployment, yard, this.localPoint, this.rig);
    this.worldPoint.copy(this.localPoint).sub(body.cg).applyQuaternion(body.quat).add(body.pos);
    this.pointOffset.copy(this.worldPoint).sub(body.pos);
    this.pointVelocity.copy(body.angVel).cross(this.pointOffset).add(body.vel);
    this.sampleWind(wind, this.worldPoint, time, this.windVelocity);
    this.airWorld.copy(this.windVelocity).sub(this.pointVelocity);
    return this.airLocal.copy(this.airWorld).applyQuaternion(invQ);
  }

  private fillTarget(air: THREE.Vector3, normal: THREE.Vector3, speed: number, incidenceDot: number) {
    const vn = air.dot(normal);
    const incidence = Math.asin(Math.abs(incidenceDot));
    return Math.tanh(vn / 1.2) * smoothstep(INCIDENCE_START, INCIDENCE_FULL, incidence);
  }

  private updateAutoTrim(centerSpeed: number, _incidence: number, air: THREE.Vector3) {
    if (centerSpeed < 0.3 || this.current.deployment < 0.02) {
      this.autoYardTarget = 0;
      return;
    }
    const currentScore = this.trimScore(this.current.yardAngle, air);
    let bestAngle = 0;
    let bestScore = -Infinity;
    let bestDistance = Infinity;
    for (let k = 0; k <= 24; k++) {
      const angle = -this.rig.maxYardAngle + (k / 24) * (2 * this.rig.maxYardAngle);
      const score = this.trimScore(angle, air);
      const distance = Math.abs(angle - this.current.yardAngle);
      const scoreTie = Math.abs(score - bestScore) <= 1e-9;
      if (score > bestScore + 1e-9 || (scoreTie && (distance < bestDistance - 1e-9 || (Math.abs(distance - bestDistance) <= 1e-9 && Math.abs(angle) < Math.abs(bestAngle))))) {
        bestScore = score;
        bestAngle = angle;
        bestDistance = distance;
      }
    }
    const improvementThreshold = Math.max(20, 0.025 * Math.abs(currentScore));
    if (bestScore > currentScore + improvementThreshold) this.autoYardTarget = bestAngle;
  }

  private trimScore(angle: number, air: THREE.Vector3) {
    this.setLocalNormal(angle, this.candidateNormal);
    const speed = air.length();
    const dot = speed > 1e-8 ? clamp(air.dot(this.candidateNormal) / speed, -1, 1) : 0;
    const candidateFill = this.fillTarget(air, this.candidateNormal, speed, dot);
    evaluateSailForce(air, this.candidateNormal, this.rig.area * this.current.deployment, candidateFill, this.candidateForce, undefined, this.aero);
    return -this.candidateForce.z - this.trimSidePenalty * Math.abs(this.candidateForce.x) - this.aero.trimSlewPenalty * Math.abs(angle - this.current.yardAngle);
  }

  private pointOfSail(speed: number, apparentFrom: number): SailTelemetry['pointOfSail'] {
    if (speed < 0.3) return 'calm';
    const wrapped = Math.atan2(Math.sin(apparentFrom), Math.cos(apparentFrom));
    const angle = Math.abs(wrapped);
    if (angle < PI / 3) return 'windward';
    if (angle > (3 * PI) / 4) return 'run';
    return 'reach';
  }

  private status(incidence: number): SailStatus {
    if (this.current.deployment < 0.02) return 'furled';
    if (Math.abs(this.current.deployment - this.deploymentTarget) > 0.04) return 'setting';
    if (this.current.fill > 0.15 && incidence > INCIDENCE_FULL) return 'aback';
    if (Math.abs(this.current.fill) < 0.2 || incidence < (7 * PI) / 180) return 'luffing';
    return 'drawing';
  }
}
