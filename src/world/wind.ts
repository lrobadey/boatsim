import { noise1 } from '../core/util';

/**
 * Global wind field. Meltemi-like prevailing wind from the N-NE that slowly veers,
 * freshens and gusts. Direction convention: `from` = compass bearing the wind blows FROM
 * (radians, 0 = north (-z), clockwise). `vector` = direction the air moves, world XZ.
 */
export class Wind {
  baseFrom = (20 * Math.PI) / 180; // NNE
  baseSpeed = 8; // m/s  (~15 kn)
  from = this.baseFrom;
  speed = this.baseSpeed;
  /** slowly-varying mean speed (what the sea responds to) */
  meanSpeed = this.baseSpeed;
  vx = 0;
  vz = 0;
  private t = 0;

  constructor(private seed = 1) {
    this.update(0);
  }

  update(dt: number) {
    this.t += dt;
    const t = this.t;
    // slow veer (+-25 deg over ~10 min), slow freshening, fast gusts
    this.from = this.baseFrom + 0.42 * noise1(t / 420, this.seed) + 0.08 * noise1(t / 37, this.seed + 3);
    this.meanSpeed = this.baseSpeed * (1 + 0.35 * noise1(t / 600, this.seed + 7));
    const gust = 0.18 * noise1(t / 6, this.seed + 11) + 0.08 * noise1(t / 1.7, this.seed + 13);
    this.speed = Math.max(0.5, this.meanSpeed * (1 + gust));
    // air moves toward (from + 180deg). bearing b -> world dir (sin b, -cos b)
    const to = this.from + Math.PI;
    this.vx = Math.sin(to) * this.speed;
    this.vz = -Math.cos(to) * this.speed;
  }

  /** unit vector the air flows toward */
  get dirX() {
    return Math.sin(this.from + Math.PI);
  }
  get dirZ() {
    return -Math.cos(this.from + Math.PI);
  }
}
