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
  { name: 'Back Water', short: 'BACK', rate: 18, dir: -1, effort: 0.5, drain: 0.002 },
  { name: 'Oars Up', short: 'STOP', rate: 0, dir: 0, effort: 0, drain: -0.03 },
  { name: 'Slow', short: 'SLOW', rate: 18, dir: 1, effort: 0.45, drain: -0.015 },
  { name: 'Half', short: 'HALF', rate: 26, dir: 1, effort: 0.65, drain: -0.004 },
  { name: 'Full', short: 'FULL', rate: 31, dir: 1, effort: 0.85, drain: 0.0011 },
  { name: 'Ramming Speed', short: 'RAM', rate: 46, dir: 1, effort: 1.0, drain: 0.011 },
];
export const ORDER_STOP = 1;

/** Public command facade; RowingSystem alone owns stroke evolution and delivered-work stamina. */
export class Crew {
  orderIndex = ORDER_STOP;
  rate = 0;
  phase = 0;
  stamina = 1;
  holdWater = false;
  readiness = 0;
  exhausted = false;
  latchedDriveTime = 1.55;
  latchedPeriod = 60 / 18;
  get order() { return ORDERS[this.orderIndex]; }
  get driveTime() { return this.latchedDriveTime; }
  get period() { return this.latchedPeriod; }
  get driveFrac() { return this.driveTime / this.period; }
  setOrder(i: number) {
    this.orderIndex = clamp(Math.round(i), 0, ORDERS.length - 1);
    if (this.orderIndex === ORDERS.length - 1 && this.stamina < 0.20) this.orderIndex--;
  }
  get strength() { return 0.65 + 0.35 * Math.sqrt(this.stamina); }
}
