import * as THREE from 'three';
import type { Walker, WalkEvent, WalkInput, ShipPose } from './walker';

/**
 * Body feel for the first-person camera (spec §3.4): stride-driven bob and sway, strafe lean, a
 * landing dip on a damped spring, run FOV kick, and the sea legs (a lagged eye sway from the deck's
 * acceleration; the foot itself never moves). Emits footsteps at bob troughs and forwards the walker's
 * land / splash / stroke events, so audio and dust have one stream to read.
 */
const WALK = 2.1;
const RUN = 4.6;
const STRIDE_WALK = 1.45;
const STRIDE_RUN = 2.1;
const BOB_WALK = 0.035;
const BOB_RUN = 0.06;
const SWAY = 0.02;
const ROLL_BOB = (0.6 * Math.PI) / 180;
const STRAFE_ROLL = (1.2 * Math.PI) / 180;
const DIP_W = 14; // landing spring ω (rad/s): recovers in ~0.25 s
const DIP_Z = 0.9;
const DIP_MAX = 0.18;
const SEA_W2 = 40; // sea legs: k = 40, ζ = 0.7, clamp 0.12 m
const SEA_Z = 0.7;
const SEA_MAX = 0.12;
const RUN_FOV = 6;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export class CameraFeel {
  /** camera-local eye offset (x right, y up) */
  readonly offset = new THREE.Vector3();
  /** camera roll (rad) about the view axis */
  roll = 0;
  /** field-of-view addition (deg) */
  fovAdd = 0;
  /** events this frame: step, land, splash, stroke (cleared each update) */
  readonly events: WalkEvent[] = [];

  private phase = 0; // stride phase, 2π per stride
  private troughs = 0; // bob troughs passed (floor(phase / π))
  private moveK = 0; // 0 standing .. 1 walking, smoothed
  private runK = 0; // 0 walking .. 1 running, smoothed
  private strafeRoll = 0;
  private dip = 0;
  private dipV = 0;
  private seaX = 0;
  private seaY = 0;
  private seaVX = 0;
  private seaVY = 0;
  private prevPointVel = new THREE.Vector3();
  private havePrev = false;
  private tmpV = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private tmpR = new THREE.Vector3();
  private tmpD = new THREE.Vector3();

  update(dt: number, walker: Walker, input: WalkInput, ship?: ShipPose) {
    this.events.length = 0;
    for (const e of walker.events) {
      if (e.type === 'land') {
        // spring impulse proportional to the fall speed, clamped
        this.dipV -= Math.min(DIP_MAX, e.speed * 0.035) * DIP_W;
        this.events.push(e);
      } else if (e.type === 'splash' || e.type === 'stroke') this.events.push(e);
    }

    const hv = Math.hypot(walker.vel.x, walker.vel.z);
    const onFoot = walker.grounded && !walker.swimming && !walker.scripted;
    const moveTarget = onFoot ? clamp(hv / WALK, 0, 1.25) : 0;
    this.moveK += (moveTarget - this.moveK) * (1 - Math.exp(-8 * dt));
    const runTarget = onFoot ? clamp((hv - WALK) / (RUN - WALK), 0, 1) : 0;
    this.runK += (runTarget - this.runK) * (1 - Math.exp(-4 * dt));

    if (onFoot) {
      const stride = STRIDE_WALK + (STRIDE_RUN - STRIDE_WALK) * this.runK;
      this.phase += ((2 * Math.PI) * hv * dt) / stride;
      const t = Math.floor(this.phase / Math.PI);
      for (let i = this.troughs; i < t && i < this.troughs + 2; i++) {
        this.events.push({ type: 'step', kind: walker.surface, intensity: clamp(hv / RUN, 0.2, 1) });
      }
      this.troughs = t;
    }

    const bobAmp = (BOB_WALK + (BOB_RUN - BOB_WALK) * this.runK) * this.moveK;
    const s = Math.sin(this.phase);
    // |sin| gives two dips per stride; the trough is where the foot lands
    const bobY = bobAmp * (Math.abs(s) - 1);
    const swayX = SWAY * this.moveK * s;

    const strafeTarget = onFoot ? -clamp(input.strafe, -1, 1) * STRAFE_ROLL : 0;
    this.strafeRoll += (strafeTarget - this.strafeRoll) * (1 - Math.exp(-6 * dt));
    this.roll = ROLL_BOB * this.moveK * s + this.strafeRoll;

    // landing dip: damped spring toward 0 (dip is ≤ 0)
    const dipAcc = -DIP_W * DIP_W * this.dip - 2 * DIP_Z * DIP_W * this.dipV;
    this.dipV += dipAcc * dt;
    this.dip += this.dipV * dt;
    if (this.dip < -DIP_MAX || this.dip > 0) {
      this.dip = clamp(this.dip, -DIP_MAX, 0);
      this.dipV = 0;
    }

    // sea legs: the deck's acceleration at the foot drives a lagged eye sway
    let ax = 0;
    let ay = 0;
    if (ship && walker.frame === 'ship' && !walker.swimming && dt > 0) {
      const p = walker.world;
      const v = this.tmpV.copy(ship.angVel).cross(this.tmpR.copy(p).sub(ship.cgWorld)).add(ship.vel);
      if (this.havePrev) {
        const acc = this.tmpD.copy(v).sub(this.prevPointVel).multiplyScalar(1 / dt).applyQuaternion(this.tmpQ.copy(ship.quat).invert());
        ax = acc.x;
        ay = acc.y;
      }
      this.prevPointVel.copy(v);
      this.havePrev = true;
    } else this.havePrev = false;
    const sw = this.stepSea(dt, ax, ay);

    this.offset.set(swayX + sw.x, bobY + this.dip + sw.y, 0);
    const runFov = onFoot ? RUN_FOV * this.runK : 0;
    this.fovAdd += (runFov - this.fovAdd) * (1 - Math.exp(-4 * dt));
  }

  private stepSea(dt: number, ax: number, ay: number): { x: number; y: number } {
    // x'' = −a − ω²x − 2ζω x'  (equilibrium x = −a/ω²)
    const c = 2 * SEA_Z * Math.sqrt(SEA_W2);
    this.seaVX += (-ax - SEA_W2 * this.seaX - c * this.seaVX) * dt;
    this.seaVY += (-ay - SEA_W2 * this.seaY - c * this.seaVY) * dt;
    this.seaX = clamp(this.seaX + this.seaVX * dt, -SEA_MAX, SEA_MAX);
    this.seaY = clamp(this.seaY + this.seaVY * dt, -SEA_MAX, SEA_MAX);
    return { x: this.seaX, y: this.seaY };
  }
}
