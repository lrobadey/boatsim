import * as THREE from 'three';

/**
 * The one camera rig (spec §9). Every mode produces a live target pose; the rig owns the pose the
 * camera actually has: it snapshots the current pose on a mode change and blends to the live target
 * with smootherstep, then adds trauma shake on top. The base pose is kept free of shake, so a later
 * snapshot starts from where the view really is.
 */
export interface Pose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  fov: number;
}

export function newPose(): Pose {
  return { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), fov: 70 };
}

export function copyPose(dst: Pose, src: Pose): Pose {
  dst.position.copy(src.position);
  dst.quaternion.copy(src.quaternion);
  dst.fov = src.fov;
  return dst;
}

/** C2 easing: zero first and second derivative at both ends, so blends start and land without a kink */
export function smootherstep(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

const TRAUMA_DECAY = 1.4; // per second
const YAW_MAX = (2.5 * Math.PI) / 180;
const PITCH_MAX = (2 * Math.PI) / 180;
const ROLL_MAX = (3 * Math.PI) / 180;
const POS_MAX = 0.06;

/** a smooth noise in [−1, 1]: three incommensurate sines in the 9–17 Hz band */
function wobble(t: number, f0: number, f1: number, f2: number, p: number): number {
  const TAU = Math.PI * 2;
  return (Math.sin(TAU * f0 * t + p) + 0.6 * Math.sin(TAU * f1 * t + 1.7 * p + 0.5) + 0.4 * Math.sin(TAU * f2 * t + 2.9 * p + 1.1)) / 2;
}

export class CameraRig {
  /** the blended pose before shake (what the next transition snapshots) */
  readonly pose: Pose = newPose();
  /** true after the first update; the first frame takes the live pose without blending */
  started = false;
  /** 0..1, decays 1.4 per second; the shake is trauma² */
  trauma = 0;

  private from: Pose = newPose();
  private t = 0;
  private dur = 0;
  private time = 0;
  private qShake = new THREE.Quaternion();
  private eShake = new THREE.Euler();
  private vShake = new THREE.Vector3();
  private out = new THREE.Quaternion();

  /** call when the mode changes, before update(): blends from the current pose over `duration` s */
  transition(duration: number) {
    if (!this.started) return;
    if (duration <= 0) {
      this.dur = 0;
      return;
    }
    copyPose(this.from, this.pose);
    this.t = 0;
    this.dur = duration;
  }

  /** a shake impulse; the sources are the quay bump, grounding and bow slam (spec §9.5) */
  addTrauma(x: number) {
    this.trauma = Math.min(1, this.trauma + Math.max(0, x));
  }

  update(dt: number, camera: THREE.PerspectiveCamera, live: Pose, shakeScale = 1) {
    if (!this.started) {
      this.started = true;
      copyPose(this.pose, live);
      this.dur = 0;
    } else if (this.dur > 0) {
      this.t += dt;
      const k = smootherstep(this.t / this.dur);
      this.pose.position.lerpVectors(this.from.position, live.position, k);
      this.pose.quaternion.slerpQuaternions(this.from.quaternion, live.quaternion, k);
      this.pose.fov = this.from.fov + (live.fov - this.from.fov) * k;
      if (this.t >= this.dur) this.dur = 0;
    } else copyPose(this.pose, live);

    this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY * dt);
    this.time += dt;
    const s = this.trauma * this.trauma * shakeScale;
    const q = this.out.copy(this.pose.quaternion);
    camera.position.copy(this.pose.position);
    if (s > 0) {
      const T = this.time;
      this.eShake.set(PITCH_MAX * s * wobble(T, 10.7, 14.3, 9.9, 2.1), YAW_MAX * s * wobble(T, 9.3, 12.1, 16.7, 0), ROLL_MAX * s * wobble(T, 11.9, 15.7, 13.1, 4.2), 'YXZ');
      q.multiply(this.qShake.setFromEuler(this.eShake));
      // positional shake is in camera-local axes
      const off = this.vShake.set(POS_MAX * s * wobble(T, 13.5, 9.7, 16.1, 0.8), POS_MAX * s * wobble(T, 9.9, 11.3, 15.3, 2.9), POS_MAX * s * wobble(T, 12.7, 10.9, 14.7, 5.1));
      camera.position.add(off.applyQuaternion(q));
    }
    camera.quaternion.copy(q);
    camera.fov = this.pose.fov;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }
}
