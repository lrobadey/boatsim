import { Vector3 } from 'three';

export const DEFAULT_WIND_SPEED = 12;

// Inlined value noise keeps the per-sample wind query allocation-free.
function windNoise1(x: number, seed: number) {
  const i = Math.floor(x);
  const f = x - i;
  const a = (i + seed * 57.13) * 127.1;
  const b = (i + 1 + seed * 57.13) * 127.1;
  const sa = Math.sin(a) * 43758.5453;
  const sb = Math.sin(b) * 43758.5453;
  const ha = sa - Math.floor(sa);
  const hb = sb - Math.floor(sb);
  const u = f * f * (3 - 2 * f);
  return (ha + (hb - ha) * u) * 2 - 1;
}

/**
 * Global wind field. Meltemi-like prevailing wind from the N-NE that slowly veers,
 * freshens and gusts. Direction convention: `from` = compass bearing the wind blows FROM
 * (radians, 0 = north (-z), clockwise). `vector` = direction the air moves, world XZ.
 */
export class Wind {
  baseFrom = (20 * Math.PI) / 180; // NNE
  baseSpeed = DEFAULT_WIND_SPEED; // m/s; fresh prevailing breeze, about 23 kn at the 10 m reference height
  from = this.baseFrom;
  speed = this.baseSpeed;
  /** slowly-varying mean speed (what the sea responds to) */
  meanSpeed = this.baseSpeed;
  vx = 0;
  vz = 0;
  /**
   * Terrain shelter at a point (docs/sea-state-spec.md §5): s = local mean wind / free wind, g = extra
   * relative gustiness in the lee. Set by the game once the world exists; null = open everywhere.
   */
  shelterAt: ((x: number, z: number, out: { s: number; g: number }) => void) | null = null;
  private t = 0;
  private shelter = { s: 1, g: 0 };
  /** simulation time this wind has advanced to (s) */
  get time() {
    return this.t;
  }

  constructor(private seed = 1) {
    this.update(0);
  }

  update(dt: number) {
    if (!Number.isFinite(dt) || dt < 0) return;
    this.t += dt;
    const t = this.t;
    const speedBase = Number.isFinite(this.baseSpeed) ? Math.max(0, this.baseSpeed) : 0;
    const fromBase = Number.isFinite(this.baseFrom) ? this.baseFrom : 0;
    const slow = 0.35 * windNoise1(t / 600, this.seed + 7);
    this.meanSpeed = speedBase * Math.max(0, 1 + slow);
    this.sampleFree(0, 10, 0, t, _windSample);
    this.speed = Math.hypot(_windSample.x, _windSample.z);
    // `from` is the source bearing at the sea-surface origin; cached fields serve existing consumers.
    this.from = fromBase + 0.42 * windNoise1(t / 420, this.seed) + 0.08 * windNoise1(t / 37, this.seed + 3);
    this.vx = _windSample.x;
    this.vz = _windSample.z;
  }

  /** Pure, deterministic air flow at an absolute simulation time and world point, including terrain shelter. */
  sampleAt(x: number, y: number, z: number, time: number, out: import('three').Vector3) {
    if (!this.shelterAt) return this.sampleFree(x, y, z, time, out);
    this.shelterAt(x, z, this.shelter);
    return this.sampleFree(x, y, z, time, out, this.shelter.s, this.shelter.g);
  }

  /** air flow without terrain shelter (s = 1, g = 0), or with the given shelter */
  private sampleFree(x: number, y: number, z: number, time: number, out: import('three').Vector3, s = 1, g = 0) {
    const t = Number.isFinite(time) ? time : 0;
    const speedBase = Number.isFinite(this.baseSpeed) ? Math.max(0, this.baseSpeed) : 0;
    if (speedBase === 0) return out.set(0, 0, 0);
    const fromBase = Number.isFinite(this.baseFrom) ? this.baseFrom : 0;
    const slow = 0.35 * windNoise1(t / 600, this.seed + 7);
    const gust =
      0.18 * windNoise1(t / 6 + x / 180 + z / 240, this.seed + 11) +
      0.08 * windNoise1(t / 1.7 - x / 70 + z / 95, this.seed + 13);
    const localFrom =
      fromBase +
      0.42 * windNoise1(t / 420, this.seed) +
      0.08 * windNoise1(t / 37 + x / 600 - z / 800, this.seed + 3);
    const height = Number.isFinite(y) ? Math.max(0.5, y) : 0.5;
    const heightFactor = Math.pow(height / 10, 0.11);
    const speed = s === 1 && g === 0
      ? speedBase * Math.max(0, 1 + slow) * Math.max(0, 1 + gust) * heightFactor
      : speedBase * Math.max(0, 1 + slow) * Math.max(0, 1 + gust * (1 + g)) * heightFactor * s;
    const to = localFrom + Math.PI;
    return out.set(Math.sin(to) * speed, 0, -Math.cos(to) * speed);
  }

  /** unit vector the air flows toward */
  get dirX() {
    return Math.sin(this.from + Math.PI);
  }
  get dirZ() {
    return -Math.cos(this.from + Math.PI);
  }
}

const _windSample = new Vector3();
