import * as THREE from 'three';
import { clamp, smoothstep } from '../../core/util';
import { ROWING_CONSTANTS, createKinematics, evaluateOar, type JointPose, type RowBody } from '../rowing';
import type { WaveField } from '../../world/waves';
import type { Oar } from './oar';
import type { CrewRowingParams } from './params';

/** catch-time shifts tried toward better water, smallest first (s): later up to 0.15, earlier up to 0.10 */
const SHIFTS = [0.05, -0.05, 0.1, -0.1, 0.15];
const _fwd = new THREE.Vector3(), _yaw = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);

/**
 * Reading the water (spec §5.8): what a skilled rower anticipates, on top of the force balance's
 * own response to orbital flow. He looks at the surface where his blade will go in: he times the
 * catch away from a trough, sets the blade's depth for the local slope, shortens and lifts his
 * stroke in chop, and shortens the next stroke after missing water.
 */
export class WaterReader {
  private kin = createKinematics();
  private joint: JointPose = { sweep: 0, dip: 0, feather: 0, dSweep: 0, dDip: 0, dFeather: 0 };
  private v = new THREE.Vector3();

  constructor(private p: CrewRowingParams) {}

  /** predicted depth (m) of the blade centre below the surface for a catch at world time t */
  private depthAt(o: Oar, dip: number, body: RowBody, waves: WaveField, t: number, now: number, sweep = o.plan.thetaC) {
    const J = this.joint;
    J.sweep = sweep; J.dip = dip; J.feather = 0;
    evaluateOar(o.slot, J, this.kin);
    const c = this.v.copy(this.kin.center).sub(body.cg).applyQuaternion(body.quat).add(body.pos).addScaledVector(body.vel, t - now);
    return waves.heightAt(c.x, c.z, t) - c.y;
  }

  /** shift (s) to apply to a planned catch at tStar so the blade doesn't go in over a trough */
  catchShift(o: Oar, body: RowBody | null, waves: WaveField | null, tStar: number, now: number) {
    if (!this.p.waterRead || !body || !waves) return 0;
    const nominal = ROWING_CONSTANTS.wetDepth, dip = o.dWet;
    let best = 0, bestD = this.depthAt(o, dip, body, waves, tStar, now);
    if (bestD >= 0.4 * nominal) return 0;
    for (const s of SHIFTS) {
      if (tStar + s <= now) continue;
      const d = this.depthAt(o, dip, body, waves, tStar + s, now);
      if (d > bestD + 0.02) { best = s; bestD = d; }
      if (bestD >= 0.4 * nominal) break;
    }
    return best;
  }

  /** wet-dip trim (rad) for a catch now: keep the blade at nominal depth on the local surface */
  dipTrim(o: Oar, body: RowBody | null, waves: WaveField | null, now: number) {
    if (!this.p.waterRead || !body || !waves) return 0;
    const excess = this.depthAt(o, o.dWet, body, waves, now + this.p.Tcatch, now) - ROWING_CONSTANTS.wetDepth;
    // deeper water than planned: dip less (a smaller dip raises the blade)
    return clamp(-excess / (o.slot.bladeRadius * Math.cos(o.dWet)), -0.06, 0.06);
  }

  /** in the drive: the dip (rad) that keeps the blade at nominal depth 0.1 s ahead, as he feels it */
  trackDepth(o: Oar, body: RowBody | null, waves: WaveField | null, now: number) {
    if (!this.p.waterRead || !body || !waves) return o.dip.q1;
    const lead = 0.1, sweep = o.theta + o.omega * lead, dip = o.dip.o[0];
    const excess = this.depthAt(o, dip, body, waves, now + lead, now, sweep) - ROWING_CONSTANTS.wetDepth;
    const want = dip - excess / (o.slot.bladeRadius * Math.cos(dip));
    return clamp(want, o.dWet - 0.12, o.dWet + 0.12);
  }

  /**
   * 10 Hz: the surface's spread at the oar's working area over the last ~10 s, measured relative to the
   * hull: the blade's height is taken with her roll and pitch removed (yaw and heave kept), so the sensor
   * reads the sea and not her own rolling (audit §2, §5.7).
   */
  watchChop(o: Oar, body: RowBody, waves: WaveField, now: number, dt: number) {
    const J = this.joint;
    J.sweep = 0; J.dip = o.dWet; J.feather = 0;
    evaluateOar(o.slot, J, this.kin);
    const fwd = _fwd.set(0, 0, -1).applyQuaternion(body.quat);
    _yaw.setFromAxisAngle(_up, Math.atan2(-fwd.x, -fwd.z));
    const c = this.v.copy(this.kin.center).sub(body.cg).applyQuaternion(_yaw).add(body.pos);
    const h = waves.heightAt(c.x, c.z, now) - c.y;
    const a = 1 - Math.exp(-dt / 10);
    o.chopMean += (h - o.chopMean) * a;
    o.chopVar += ((h - o.chopMean) ** 2 - o.chopVar) * a;
  }

  /** the chop response for the next stroke: arc factor (<= 1) and dry-dip lift (rad) */
  chopResponse(o: Oar) {
    if (!this.p.waterRead) return { arc: 1, lift: 0 };
    const k = smoothstep(0.12, 0.35, Math.sqrt(Math.max(0, o.chopVar)));
    // in chop the recovery is raised clear of the crests; the arc is not cut (it did not earn its keep, audit §2, §6.7)
    return { arc: 1, lift: 0.05 * k };
  }
}
