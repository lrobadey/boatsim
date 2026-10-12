import { clamp } from '../../core/util';

/** [position, velocity, acceleration] */
export type TrackSample = [number, number, number];

/** quintic from (q0, v0, a0 = 0) to rest at q1 over H seconds, sampled at t */
export function quintic(q0: number, v0: number, q1: number, H: number, t: number, out: TrackSample): TrackSample {
  const x = clamp(t / H, 0, 1), x2 = x * x, x3 = x2 * x, x4 = x3 * x, x5 = x4 * x;
  const Q = x3 * (10 + x * (-15 + 6 * x)), dQ = 30 * x2 * (x - 1) * (x - 1), ddQ = 60 * x - 180 * x2 + 120 * x3;
  out[0] = q0 + (q1 - q0) * Q + H * v0 * (x - 6 * x3 + 8 * x4 - 3 * x5);
  out[1] = ((q1 - q0) * dQ) / H + v0 * (1 - 18 * x2 + 32 * x3 - 15 * x4);
  out[2] = t >= H ? 0 : ((q1 - q0) * ddQ) / (H * H) + (v0 * (-36 * x + 96 * x2 - 60 * x3)) / H;
  return out;
}

/** cubic Hermite from (q0, v0) to (q1, v1) over H seconds, sampled at t */
export function hermite3(q0: number, v0: number, q1: number, v1: number, H: number, t: number, out: TrackSample): TrackSample {
  const x = clamp(t / H, 0, 1), x2 = x * x, x3 = x2 * x;
  out[0] = (2 * x3 - 3 * x2 + 1) * q0 + (x3 - 2 * x2 + x) * H * v0 + (-2 * x3 + 3 * x2) * q1 + (x3 - x2) * H * v1;
  out[1] = ((6 * x2 - 6 * x) * q0 + (3 * x2 - 4 * x + 1) * H * v0 + (-6 * x2 + 6 * x) * q1 + (3 * x2 - 2 * x) * H * v1) / H;
  out[2] = t >= H ? 0 : ((12 * x - 6) * q0 + (6 * x - 4) * H * v0 + (-12 * x + 6) * q1 + (6 * x - 2) * H * v1) / (H * H);
  return out;
}

/** a rower-positioned joint track (dip, feather, or the servo reference): quintic to rest */
export class Track {
  q0: number; v0 = 0; q1: number; H = 1e-6; t = 1;
  readonly o: TrackSample;
  constructor(q: number) { this.q0 = this.q1 = q; this.o = [q, 0, 0]; }
  /** start from the current sample (position and velocity stay continuous) */
  retarget(q1: number, H: number) { this.q0 = this.o[0]; this.v0 = this.o[1]; this.q1 = q1; this.H = Math.max(1e-6, H); this.t = 0; }
  /** start from an explicit state */
  set(q0: number, v0: number, q1: number, H: number) { this.q0 = q0; this.v0 = v0; this.q1 = q1; this.H = Math.max(1e-6, H); this.t = 0; }
  /** jump to rest at q (reset only) */
  snap(q: number) { this.q0 = this.q1 = q; this.v0 = 0; this.H = 1e-6; this.t = 1; this.o[0] = q; this.o[1] = this.o[2] = 0; }
  eval(t: number) { this.t = t; return quintic(this.q0, this.v0, this.q1, this.H, t, this.o); }
  get done() { return this.t >= this.H; }
}
