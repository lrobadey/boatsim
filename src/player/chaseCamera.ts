import * as THREE from 'three';
import type { Terrain } from '../world/terrain';
import type { WaveField } from '../world/waves';
import type { ShipPose } from './walker';
import type { Pose } from './cameraRig';

/**
 * Third-person chase camera (spec §9.3): a pivot above the ship that follows with two critically
 * damped springs (tight horizontally, soft vertically so heave does not bounce the view), a look-ahead
 * along the ship's velocity, and a spring arm that pulls in before terrain or water and lets back out.
 */
const PIVOT_UP = 4; // m above the centre of gravity
const OMEGA_XZ = 8;
const OMEGA_Y = 2.5;
const LOOK_TIME = 0.6; // s of ship velocity the pivot leads by
const LOOK_MAX = 6; // m
const ARM_CLEAR = 1.5; // m of clearance the arm samples must keep
const ARM_SAMPLES = 10;
const ARM_RECOVER = 1.2; // s for the arm to back out to full length
const ARM_MIN = 3; // m
const FLOOR_CLEAR = 1.4; // the camera itself never ends lower than this above ground
const SPEED_FOV = 5; // deg of FOV added at SPEED_FOV_MS
const SPEED_FOV_MS = 5; // m/s
const SUB = 1 / 120;

export class ChaseCamera {
  readonly pivot = new THREE.Vector3();
  /** current spring arm length (m) after collision */
  arm = -1;
  private vel = new THREE.Vector3();
  private ready = false;
  private goal = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private cam = new THREE.Vector3();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);

  /** Solves the chase pose into `out` (un-zoomed fov). yaw/pitch are the world orbit angles. */
  solve(dt: number, ship: ShipPose, terrain: Terrain, waves: WaveField, time: number, yaw: number, pitch: number, dist: number, lift: number, speed: number, baseFov: number, out: Pose) {
    const h = Math.min(0.25, Math.max(0, dt));
    // look-ahead: the pivot leads along the ship's horizontal velocity, clamped
    let lx = ship.vel.x * LOOK_TIME;
    let lz = ship.vel.z * LOOK_TIME;
    const ll = Math.hypot(lx, lz);
    if (ll > LOOK_MAX) {
      lx *= LOOK_MAX / ll;
      lz *= LOOK_MAX / ll;
    }
    this.goal.set(ship.cgWorld.x + lx, ship.cgWorld.y + PIVOT_UP + lift, ship.cgWorld.z + lz);
    if (!this.ready) {
      this.ready = true;
      this.pivot.copy(this.goal);
      this.vel.set(0, 0, 0);
    }
    // critically damped springs, stepped in fixed sub-steps for stability
    for (let rem = h; rem > 1e-9; ) {
      const s = Math.min(SUB, rem);
      rem -= s;
      this.springAxis('x', s, OMEGA_XZ);
      this.springAxis('y', s, OMEGA_Y);
      this.springAxis('z', s, OMEGA_XZ);
    }

    // orbit direction from the pivot toward the camera (unit vector)
    this.dir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));

    // spring arm: sample the arm; the first sample that is too close to ground or water sets the limit
    let limit = dist;
    for (let i = 1; i <= ARM_SAMPLES; i++) {
      const f = (i / ARM_SAMPLES) * dist;
      const x = this.pivot.x + this.dir.x * f;
      const y = this.pivot.y + this.dir.y * f;
      const z = this.pivot.z + this.dir.z * f;
      const ground = Math.max(terrain.heightAt(x, z), waves.heightAt(x, z, time));
      if (y - ground < ARM_CLEAR) {
        limit = Math.max(ARM_MIN, Math.min(dist, ((i - 1) / ARM_SAMPLES) * dist));
        break;
      }
    }
    if (this.arm < 0) this.arm = limit;
    // pulled in at once; backs out over ARM_RECOVER seconds
    if (limit < this.arm) this.arm = limit;
    else this.arm = Math.min(limit, this.arm + (dist / ARM_RECOVER) * dt);

    this.cam.copy(this.pivot).addScaledVector(this.dir, this.arm);
    const floor = Math.max(terrain.heightAt(this.cam.x, this.cam.z), waves.heightAt(this.cam.x, this.cam.z, time)) + FLOOR_CLEAR;
    if (this.cam.y < floor) this.cam.y = floor;

    this.m.lookAt(this.cam, this.pivot, this.up);
    out.quaternion.copy(this.q.setFromRotationMatrix(this.m));
    out.position.copy(this.cam);
    out.fov = baseFov + SPEED_FOV * Math.min(1, Math.abs(speed) / SPEED_FOV_MS);
  }

  private springAxis(axis: 'x' | 'y' | 'z', h: number, w: number) {
    const g = axis === 'x' ? this.goal.x : axis === 'y' ? this.goal.y : this.goal.z;
    const p = axis === 'x' ? this.pivot.x : axis === 'y' ? this.pivot.y : this.pivot.z;
    const v = axis === 'x' ? this.vel.x : axis === 'y' ? this.vel.y : this.vel.z;
    const a = -w * w * (p - g) - 2 * w * v;
    const nv = v + a * h;
    const np = p + nv * h;
    if (axis === 'x') {
      this.vel.x = nv;
      this.pivot.x = np;
    } else if (axis === 'y') {
      this.vel.y = nv;
      this.pivot.y = np;
    } else {
      this.vel.z = nv;
      this.pivot.z = np;
    }
  }
}
