import { clamp } from '../core/util';

/**
 * The rowing crew: stroke orders from the helmsman, the keleustes' stroke rate, the stroke cycle
 * kinematics shared by physics (blade velocity) and visuals (oar pose), and crew stamina.
 */
export interface Order {
  name: string;
  short: string;
  rate: number; // strokes per minute
  dir: 1 | -1 | 0;
  effort: number; // fraction of max rower force
  drain: number; // stamina per second (negative = recover)
}

export const ORDERS: Order[] = [
  { name: 'Back Water', short: 'BACK', rate: 20, dir: -1, effort: 0.7, drain: 0.002 },
  { name: 'Oars Up', short: 'STOP', rate: 0, dir: 0, effort: 0, drain: -0.03 },
  { name: 'Slow', short: 'SLOW', rate: 18, dir: 1, effort: 0.45, drain: -0.015 },
  { name: 'Half', short: 'HALF', rate: 26, dir: 1, effort: 0.65, drain: -0.004 },
  { name: 'Full', short: 'FULL', rate: 34, dir: 1, effort: 0.85, drain: 0.004 },
  { name: 'Ramming Speed', short: 'RAM', rate: 44, dir: 1, effort: 1.0, drain: 0.028 },
];
export const ORDER_STOP = 1;

export const SWEEP_CATCH = 0.72; // rad, blade toward the bow at the catch
export const SWEEP_RELEASE = -0.58; // rad, blade aft at the release
export const OAR_BLADE_R = 2.8; // m, pivot to blade centre

export class Crew {
  orderIndex = ORDER_STOP;
  rate = 0; // actual strokes/min
  phase = 0.6; // 0..1, drive = [0, driveFrac)
  stamina = 1;
  holdWater = false;
  /** 0..1 how far the oars are "run out" (ready); used for visuals when stopping */
  readiness = 0;
  /** fired at each catch (for audio/foam) */
  onCatch: (() => void) | null = null;
  exhausted = false;

  get order() {
    return ORDERS[this.orderIndex];
  }

  /** duration of the drive phase in seconds for the current rate */
  get driveTime() {
    return Math.max(0.52, 1.0 - this.rate * 0.0105);
  }
  get period() {
    return this.rate > 0.5 ? 60 / this.rate : 1e9;
  }
  get driveFrac() {
    return clamp(this.driveTime / this.period, 0.05, 0.6);
  }

  setOrder(i: number) {
    this.orderIndex = clamp(i, 0, ORDERS.length - 1);
    if (this.orderIndex === ORDERS.length - 1 && this.stamina < 0.15) this.orderIndex = ORDERS.length - 2;
  }

  update(dt: number) {
    const o = this.order;
    // stamina
    this.stamina = clamp(this.stamina - o.drain * dt, 0, 1);
    if (this.stamina <= 0.02 && this.orderIndex === ORDERS.length - 1) {
      this.orderIndex = ORDERS.length - 2; // crew can't sustain ramming speed
      this.exhausted = true;
    }
    if (this.stamina > 0.3) this.exhausted = false;
    // keleustes changes the beat gradually
    const target = o.rate;
    this.rate += clamp(target - this.rate, -6 * dt, 6 * dt);
    this.readiness = clamp(this.readiness + (o.dir !== 0 || this.holdWater ? 1 : -1) * dt * 0.8, 0, 1);
    if (this.rate > 0.5) {
      const prev = this.phase;
      this.phase += dt / this.period;
      if (this.phase >= 1) {
        this.phase -= 1;
        this.onCatch?.();
      }
      if (prev < 0 && this.phase >= 0) this.onCatch?.();
    } else {
      // finish the current stroke into the recovery "oars up" pose
      if (this.phase < 0.75) this.phase = Math.min(0.75, this.phase + dt * 0.5);
    }
  }

  /** effective force multiplier from stamina */
  get strength() {
    return 0.35 + 0.65 * Math.sqrt(this.stamina);
  }
}

/**
 * Stroke kinematics at phase p: sweep angle, its time derivative, and blade immersion (0..1).
 * Direction -1 (back water) runs the drive in reverse.
 */
export function stroke(p: number, driveFrac: number, driveTime: number, period: number, dir: number) {
  let sweep: number, dSweep: number, immersion: number;
  const A = SWEEP_CATCH,
    B = SWEEP_RELEASE;
  p = ((p % 1) + 1) % 1;
  if (p < driveFrac) {
    const x = p / driveFrac;
    const e = 0.5 - 0.5 * Math.cos(Math.PI * x);
    sweep = A + (B - A) * e;
    dSweep = ((B - A) * 0.5 * Math.PI * Math.sin(Math.PI * x)) / driveTime;
    immersion = Math.min(1, x * 8) * Math.min(1, (1 - x) * 8);
  } else {
    const x = (p - driveFrac) / (1 - driveFrac);
    const e = 0.5 - 0.5 * Math.cos(Math.PI * x);
    sweep = B + (A - B) * e;
    const recTime = Math.max(0.1, period - driveTime);
    dSweep = ((A - B) * 0.5 * Math.PI * Math.sin(Math.PI * x)) / recTime;
    immersion = 0;
  }
  if (dir < 0) {
    // backing water: blade enters aft and pushes forward
    sweep = -sweep + (A + B);
    dSweep = -dSweep;
  }
  return { sweep, dSweep, immersion };
}
