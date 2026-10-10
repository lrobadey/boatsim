import type { Column } from './hull';
import type { HullOffsets, HullShape } from './hullShape';

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * A hull defined by an offsets table (see `HullOffsets`). Each station holds a flat list of
 * [x, y] points running from the keel (t = 0) to the sheer (t = 1), starboard side. The section at
 * (s, t) is bilinear: linear along each station's points, then linear between the two stations
 * that bracket s.
 */
export class TableHull implements HullShape {
  readonly length: number;
  readonly bowOverhang: number;
  readonly sternOverhang: number;
  readonly keelHalf: number;
  readonly waterlineAboveKeel: number;
  private readonly sArr: Float64Array;
  private readonly pts: Float64Array[];
  /** points per station */
  private readonly n: number;
  private readonly sc = { x: 0, y: 0 };

  constructor(readonly offsets: HullOffsets) {
    this.length = offsets.length;
    this.bowOverhang = offsets.stemOverhang;
    this.sternOverhang = offsets.postOverhang;
    this.keelHalf = offsets.keelHalf;
    this.waterlineAboveKeel = offsets.waterlineAboveKeel;

    const count = offsets.stations.length;
    if (count < 2) throw new Error(`TableHull needs at least 2 stations, got ${count}`);
    const flatLen = offsets.stations[0].pts.length;
    this.n = flatLen / 2;
    if (!Number.isInteger(this.n) || this.n < 2) throw new Error(`TableHull needs at least 2 points per station, got ${flatLen / 2}`);
    this.sArr = new Float64Array(count);
    this.pts = [];
    for (let i = 0; i < count; i++) {
      const st = offsets.stations[i];
      if (st.pts.length !== flatLen) throw new Error(`TableHull station ${i} has ${st.pts.length / 2} points, expected ${this.n}`);
      this.sArr[i] = st.s;
      this.pts.push(Float64Array.from(st.pts));
    }
  }

  zOf(s: number): number {
    return -this.length / 2 + s * this.length;
  }

  sOf(z: number): number {
    return z / this.length + 0.5;
  }

  /** section point at (s, t); no allocation */
  section(s: number, t: number, out: { x: number; y: number }): { x: number; y: number } {
    s = clamp01(s);
    t = clamp01(t);
    const sa = this.sArr;
    const count = sa.length;
    // largest index i in [0, count - 2] with sa[i] <= s
    let lo = 0,
      hi = count - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (sa[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    const i = lo;
    const w = (s - sa[i]) / (sa[i + 1] - sa[i]);
    const u = t * (this.n - 1);
    const k = Math.min(Math.floor(u), this.n - 2);
    const f = u - k;
    const a = this.pts[i];
    const b = this.pts[i + 1];
    const xa = a[2 * k] + (a[2 * k + 2] - a[2 * k]) * f;
    const ya = a[2 * k + 1] + (a[2 * k + 3] - a[2 * k + 1]) * f;
    const xb = b[2 * k] + (b[2 * k + 2] - b[2 * k]) * f;
    const yb = b[2 * k + 1] + (b[2 * k + 3] - b[2 * k + 1]) * f;
    out.x = xa + (xb - xa) * w;
    out.y = ya + (yb - ya) * w;
    return out;
  }

  halfBeam(s: number): number {
    return this.section(s, 1, this.sc).x;
  }

  keelDepth(s: number): number {
    return -this.section(s, 0, this.sc).y;
  }

  sheer(s: number): number {
    return this.section(s, 1, this.sc).y;
  }

  halfWidthAt(s: number, y: number): number {
    const sc = this.sc;
    const y0 = this.section(s, 0, sc).y;
    if (y <= y0) return 0;
    if (y >= this.sheer(s)) return this.halfBeam(s);
    let lo = 0,
      hi = 1;
    for (let i = 0; i < 24; i++) {
      const m = (lo + hi) / 2;
      if (this.section(s, m, sc).y < y) lo = m;
      else hi = m;
    }
    return this.section(s, (lo + hi) / 2, sc).x;
  }

  bottomAt(s: number, x: number): number {
    const sc = this.sc;
    const B = this.halfBeam(s);
    const ax = Math.abs(x);
    if (ax >= B) return this.sheer(s);
    if (ax <= this.section(s, 0, sc).x) return this.section(s, 0, sc).y;
    let lo = 0,
      hi = 1;
    for (let i = 0; i < 24; i++) {
      const m = (lo + hi) / 2;
      if (this.section(s, m, sc).x < ax) lo = m;
      else hi = m;
    }
    return this.section(s, (lo + hi) / 2, sc).y;
  }

  /**
   * Buoyancy and drag columns. Strip edges are cosine-spaced (narrow at the sides, where the
   * waterline crosses the flaring topsides) and each column's bottom is the mean hull bottom across
   * its strip, so a fully submerged column holds exactly the strip's volume even over the deep,
   * narrow keel of a wineglass section.
   */
  buildColumns(stations = 22, strips = 8): Column[] {
    const cols: Column[] = [];
    const SUB = 16;
    for (let i = 0; i < stations; i++) {
      const s0 = i / stations,
        s1 = (i + 1) / stations;
      const s = (s0 + s1) / 2;
      const B = this.halfBeam(s);
      if (B < 0.05) continue;
      const dz = (s1 - s0) * this.length;
      for (let k = 0; k < strips; k++) {
        const x0 = -B * Math.cos((Math.PI * k) / strips);
        const x1 = -B * Math.cos((Math.PI * (k + 1)) / strips);
        let bottom = 0;
        for (let m = 0; m < SUB; m++) bottom += this.bottomAt(s, x0 + ((x1 - x0) * (m + 0.5)) / SUB);
        bottom /= SUB;
        cols.push({ x: (x0 + x1) / 2, z: this.zOf(s), bottom, top: this.sheer(s), area: (x1 - x0) * dz, dz, dx: x1 - x0, keel: -this.keelDepth(s), latW: (x1 - x0) / (2 * B) });
      }
    }
    return cols;
  }

  /**
   * 16 half-widths at s = i / 15 for the ocean's water cut-out, taken 0.5 m below the waterline.
   * The cut-out discards sea pixels inside this outline, so it must stay inside the hull wherever
   * the sea meets it: on flaring topsides, half-widths from above the waterline cut a visible gap
   * in the water along the planking.
   */
  hullWidthTable(): Float32Array {
    const t = new Float32Array(16);
    for (let i = 0; i < 16; i++) t[i] = this.halfWidthAt(i / 15, -0.5);
    return t;
  }
}
