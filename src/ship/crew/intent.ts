import { smoothstep } from '../../core/util';
import type { CrewOrder } from './params';

/**
 * What the crew is trying to do, as normalised demands (spec §5.2). The allocation and every rower
 * read this; nothing here is in Newtons.
 */
export interface CrewIntent {
  /** surge demand in [-1, 1] (+ ahead) */
  X: number;
  /** yaw demand in [-1, 1] (+ = turn to starboard) */
  N: number;
  /** power per active man (W) */
  P: number;
  /** target stroke rate (spm) */
  rate: number;
  hold: boolean;
  dir: -1 | 0 | 1;
  manned: number;
  yawPriority: number;
}

export const createIntent = (): CrewIntent => ({ X: 0, N: 0, P: 0, rate: 0, hold: false, dir: 0, manned: 0, yawPriority: 0.4 });

/**
 * A manoeuvre (Turn 180 and later ones) replaces the order's intent over time from its own state
 * machine on heading and speed. Nothing below the intent layer changes when one is active.
 */
export interface Manoeuvre {
  /** write the intent for this tick; return false when finished (control returns to the order) */
  update(intent: CrewIntent, heading: number, speed: number, dt: number): boolean;
}

/** order + helm + speed through the water -> intent (10 Hz) */
export function intentFromOrder(out: CrewIntent, order: CrewOrder, holdWater: boolean, helm: number, speed: number) {
  out.hold = holdWater;
  out.dir = order.dir;
  out.P = order.P;
  out.rate = order.rate;
  out.manned = order.manned;
  // oars matter most at low speed
  const low = 1 - smoothstep(0.5, 2.0, Math.abs(speed));
  const turn = smoothstep(0.05, 1, Math.abs(helm)) * Math.sign(helm);
  // hard over at low speed: the crew gives up way for the pivot
  out.X = order.dir * (1 - 0.6 * Math.abs(turn) * low);
  // the oars help the helm fully at rest and still ease the inner side at speed
  out.N = turn * (0.35 + 0.65 * low);
  out.yawPriority = 0.4 + 0.6 * low;
}
