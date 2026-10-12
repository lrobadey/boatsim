import { jonswap } from './spectrum';

/**
 * Sea state field (docs/sea-state-spec.md): how big the waves are at each place.
 *
 * The worldgen worker bakes geometry only, per incoming direction: effective fetch, wind shelter and
 * swell open fraction, plus a blurred depth (bakeSeaState). On the main thread SeaStateField composes,
 * for the current wind, an amplitude envelope E <= 1 per wave band and samples it identically for the
 * CPU (buoyancy, flow) and the GPU (ocean shader: same Float32 bytes, same manual bilinear).
 *
 * Directions: index d covers the compass bearing d * 360/SEA_DIRS the waves or wind come FROM
 * (0 = north = -z, clockwise). This module has no three.js dependency so it runs in the worker and in Node.
 */
export const SEA_DIRS = 16;
export const SEA_RAYS = 64;
/** open-sea fetch, the reference all envelopes are relative to (m) */
export const FETCH_CAP = 40_000;
export const SEA_N = 128;
/** wind shading reaches this far upwind (m) */
const SHELTER_RANGE = 8000;
/** wake length in obstacle heights, obstacle height ramp (m), deepest lee wind fraction */
const WAKE_HEIGHTS = 15;
const OBST_H0 = 5, OBST_H1 = 40;
const LEE_FLOOR = 0.3;
/** half-widths of the ray fans (in rays of 360/64 degrees): fetch ±45, shelter ±11, swell ±22.5 */
const FAN_FETCH = 8, FAN_SHELTER = 2, FAN_SWELL = 4;
/** swell wraps round islands and moles (diffraction, refraction): the least swell exposure at sea */
const SWELL_FLOOR = 0.2;
/** detail map edge feather (m) */
export const DETAIL_FEATHER = 64;
/** wave band centres (wavelength, m) for the soft band weights: long, mid, short */
export const BAND_LAMBDA = [48, 26, 14] as const;
/** lee gustiness: gust amplitude multiplier = 1 + GUST_LEE * (1 - S) */
const GUST_LEE = 0.8;
/** depth-limited random sea: Hs <= DEPTH_HS * h */
const DEPTH_HS = 0.5;
/** relaxation of the live envelope toward its target (s) and the tick it runs on (s) */
export const SEA_TAU = 40;
export const SEA_TICK = 0.25;
/** lookup table ranges: local wind fraction and fetch */
const LUT_S = 15, LUT_F = 32, LUT_FMIN = 50;

export interface SeaMap {
  /** world position of the map's corner (min x, min z), cell size (m), cells per side */
  originX: number;
  originZ: number;
  cell: number;
  n: number;
  /** per cell and direction [cell * SEA_DIRS + d]: effective fetch (m), wind shelter (0.3..1), swell open fraction */
  F: Float32Array;
  S: Float32Array;
  W: Float32Array;
  /** per cell: blurred water depth (m), and 1 where waves meet land (terrain above water, or the mole) */
  hb: Float32Array;
  land: Uint8Array;
}

export interface SeaStateBake {
  dirs: number;
  /** [0] = the whole world; [1..] = detail regions (harbours) */
  maps: SeaMap[];
  /** bake time in the worker (ms) */
  ms: number;
}

/** a mole: a wave-blocking strip from (x0, z0) along (ux, uz) */
export interface Mole {
  x0: number;
  z0: number;
  ux: number;
  uz: number;
  length: number;
  halfWidth: number;
}

export interface SeaBakeInput {
  heights: Float32Array;
  /** heightmap resolution and world size (m) */
  N: number;
  worldSize: number;
  detail: { cx: number; cz: number; size: number; n: number; moles: Mole[] }[];
}

/**
 * The mole of a generated pier site (Sites['pier']): a wave-blocking strip. Ships lie alongside its
 * vertical faces, so it is padded by only 1 m, enough that a ray stepping one 4 m detail cell cannot
 * jump it.
 */
export function pierMole(p: { x: number; z: number; angle: number; length: number; width: number }): Mole {
  return { x0: p.x, z0: p.z, ux: Math.cos(p.angle), uz: Math.sin(p.angle), length: p.length, halfWidth: p.width / 2 + 1 };
}

// ------------------------------------------------------------------------------------------- bake

interface Grid {
  ox: number;
  oz: number;
  cell: number;
  n: number;
  /** highest terrain in the cell (m), for wind shelter */
  hmax: Float32Array;
  /** 1 where waves meet land */
  land: Uint8Array;
  depth: Float32Array;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function heightSampler(H: Float32Array, N: number, S: number) {
  const cell = S / N, half = S / 2;
  return (x: number, z: number) => {
    const fx = (x + half) / cell - 0.5, fz = (z + half) / cell - 0.5;
    if (fx < 0 || fz < 0 || fx >= N - 1 || fz >= N - 1) return -60;
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, k = j * N + i;
    return (H[k] * (1 - tx) + H[k + 1] * tx) * (1 - tz) + (H[k + N] * (1 - tx) + H[k + N + 1] * tx) * tz;
  };
}

/** the whole world at SEA_N cells: max height and mean depth over the heightmap texels in each cell */
function globalGrid(H: Float32Array, N: number, S: number): Grid {
  const n = SEA_N, cell = S / n;
  const hmax = new Float32Array(n * n), depth = new Float32Array(n * n), land = new Uint8Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const i0 = Math.floor((i * N) / n), i1 = Math.max(i0 + 1, Math.floor(((i + 1) * N) / n));
      const j0 = Math.floor((j * N) / n), j1 = Math.max(j0 + 1, Math.floor(((j + 1) * N) / n));
      let mx = -Infinity, dsum = 0, cnt = 0;
      for (let b = j0; b < j1; b++)
        for (let a = i0; a < i1; a++) {
          const h = H[b * N + a];
          if (h > mx) mx = h;
          dsum += Math.max(0, -h);
          cnt++;
        }
      const c = j * n + i;
      hmax[c] = mx;
      depth[c] = dsum / cnt;
      land[c] = mx > 0 ? 1 : 0;
    }
  return { ox: -S / 2, oz: -S / 2, cell, n, hmax, land, depth };
}

/** a detail region: terrain from 3 x 3 bilinear samples per cell; moles block waves (not wind) */
function detailGrid(height: (x: number, z: number) => number, d: SeaBakeInput['detail'][number]): Grid {
  const n = d.n, cell = d.size / n, ox = d.cx - d.size / 2, oz = d.cz - d.size / 2;
  const hmax = new Float32Array(n * n), depth = new Float32Array(n * n), land = new Uint8Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      let mx = -Infinity, dsum = 0;
      for (let b = 0; b < 3; b++)
        for (let a = 0; a < 3; a++) {
          const h = height(ox + (i + (a + 0.5) / 3) * cell, oz + (j + (b + 0.5) / 3) * cell);
          if (h > mx) mx = h;
          dsum += Math.max(0, -h);
        }
      const c = j * n + i;
      hmax[c] = mx;
      depth[c] = dsum / 9;
      let l = mx > 0 ? 1 : 0;
      const x = ox + (i + 0.5) * cell, z = oz + (j + 0.5) * cell;
      for (const m of d.moles) {
        const dx = x - m.x0, dz = z - m.z0;
        const along = Math.min(m.length, Math.max(0, dx * m.ux + dz * m.uz));
        if (Math.hypot(dx - along * m.ux, dz - along * m.uz) <= m.halfWidth) l = 1;
      }
      land[c] = l;
    }
  return { ox, oz, cell, n, hmax, land, depth };
}

/**
 * Give land cells their sea neighbours' values (a few rings deep), so texel-centre bilinear sampling
 * near a coast or a quay wall reads the nearby water instead of being pulled toward zero.
 */
function dilate(v: Float32Array, stride: number, n: number, land: Uint8Array, rings = 4) {
  const filled = new Uint8Array(n * n);
  for (let c = 0; c < n * n; c++) filled[c] = land[c] ? 0 : 1;
  for (let r = 0; r < rings; r++) {
    const next = filled.slice();
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const c = j * n + i;
        if (filled[c]) continue;
        let cnt = 0;
        const acc = new Float64Array(stride);
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
          const q = jj * n + ii;
          if (!filled[q]) continue;
          for (let k = 0; k < stride; k++) acc[k] += v[q * stride + k];
          cnt++;
        }
        if (!cnt) continue;
        for (let k = 0; k < stride; k++) v[c * stride + k] = acc[k] / cnt;
        next[c] = 1;
      }
    filled.set(next);
  }
}

/** separable Gaussian of values over the cells where mask is 1 (normalised convolution); in place */
function maskedBlur(v: Float32Array, stride: number, n: number, mask: Uint8Array | null, sigma: number) {
  const r = Math.ceil(sigma * 3);
  const w: number[] = [];
  for (let k = -r; k <= r; k++) w.push(Math.exp((-k * k) / (2 * sigma * sigma)));
  const num = new Float64Array(n * n), den = new Float64Array(n * n);
  for (let ch = 0; ch < stride; ch++) {
    for (let c = 0; c < n * n; c++) {
      const m = mask ? 1 - mask[c] : 1;
      num[c] = v[c * stride + ch] * m;
      den[c] = m;
    }
    for (const horiz of [true, false]) {
      const tn = new Float64Array(n * n), td = new Float64Array(n * n);
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          let a = 0, b = 0;
          for (let k = -r; k <= r; k++) {
            const ii = horiz ? i + k : i, jj = horiz ? j : j + k;
            if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
            const q = jj * n + ii;
            a += w[k + r] * num[q];
            b += w[k + r] * den[q];
          }
          tn[j * n + i] = a;
          td[j * n + i] = b;
        }
      num.set(tn);
      den.set(td);
    }
    for (let c = 0; c < n * n; c++) if (!mask || !mask[c]) v[c * stride + ch] = den[c] > 1e-9 ? num[c] / den[c] : v[c * stride + ch];
  }
}

/**
 * Bake fetch, wind shelter and swell exposure for every sea cell and incoming direction, on the
 * world grid and each detail region (spec §3). Rays march upwind cell by cell; inside a detail region
 * they step over its fine grid, then continue on the world grid.
 */
export function bakeSeaState(inp: SeaBakeInput): SeaStateBake {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { heights: H, N, worldSize: S } = inp;
  const half = S / 2;
  const G = globalGrid(H, N, S);
  const height = heightSampler(H, N, S);
  const grids = [G, ...inp.detail.map((d) => detailGrid(height, d))];
  const details = grids.slice(1);

  const rdx = new Float64Array(SEA_RAYS), rdz = new Float64Array(SEA_RAYS);
  for (let r = 0; r < SEA_RAYS; r++) {
    const b = (r * 2 * Math.PI) / SEA_RAYS;
    rdx[r] = Math.sin(b);
    rdz[r] = -Math.cos(b);
  }
  const fan = (h: number, sq: boolean) => {
    const w: number[] = [];
    for (let k = -h; k <= h; k++) {
      const c = Math.cos((k * 2 * Math.PI) / SEA_RAYS);
      w.push(sq ? c * c : c);
    }
    const s = w.reduce((a, b) => a + b, 0);
    return w.map((x) => x / s);
  };
  // fetch: cos^2 weights normalised by their own sum, so open sea gives exactly the cap (spec §3.3 note)
  const wF = fan(FAN_FETCH, true), wS = fan(FAN_SHELTER, false), wW = fan(FAN_SWELL, false);

  const maps: SeaMap[] = [];
  const dLand = new Float64Array(SEA_RAYS), sh = new Float64Array(SEA_RAYS);
  for (const g of grids) {
    const n = g.n, F = new Float32Array(n * n * SEA_DIRS), Sh = new Float32Array(n * n * SEA_DIRS), W = new Float32Array(n * n * SEA_DIRS);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const c = j * n + i;
        if (g.land[c]) {
          for (let d = 0; d < SEA_DIRS; d++) {
            F[c * SEA_DIRS + d] = 1;
            Sh[c * SEA_DIRS + d] = 1;
          }
          continue;
        }
        const x0 = g.ox + (i + 0.5) * g.cell, z0 = g.oz + (j + 0.5) * g.cell;
        // a world-grid cell outside every detail region marches on the world grid only (spec §3.1 step 6);
        // detail cells keep the finest grid
        const worldOnly = g === G && !details.some((dg) => {
          const ii = Math.floor((x0 - dg.ox) / dg.cell), jj = Math.floor((z0 - dg.oz) / dg.cell);
          return ii >= 0 && jj >= 0 && ii < dg.n && jj < dg.n;
        });
        for (let r = 0; r < SEA_RAYS; r++) {
          const dx = rdx[r], dz = rdz[r];
          // the finest grid covering a point sets the lookup there and the step to the next point
          let d = 0, fetch = -1, s = 0, step = g.cell;
          for (;;) {
            d += step;
            const px = x0 + dx * d, pz = z0 + dz * d;
            if (px < -half || pz < -half || px >= half || pz >= half) {
              if (fetch < 0) fetch = FETCH_CAP;
              break;
            }
            let q = -1, gq = G;
            for (let k = 0; !worldOnly && k < details.length; k++) {
              const dg = details[k];
              const ii = Math.floor((px - dg.ox) / dg.cell), jj = Math.floor((pz - dg.oz) / dg.cell);
              if (ii >= 0 && jj >= 0 && ii < dg.n && jj < dg.n) { q = jj * dg.n + ii; gq = dg; break; }
            }
            if (q < 0) q = Math.floor((pz - G.oz) / G.cell) * G.n + Math.floor((px - G.ox) / G.cell);
            step = gq.cell;
            if (fetch < 0 && gq.land[q]) fetch = d;
            if (d <= SHELTER_RANGE) {
              const h = gq.hmax[q];
              if (h > OBST_H0) {
                const v = Math.max(0, 1 - d / (WAKE_HEIGHTS * h)) * smooth(OBST_H0, OBST_H1, h);
                if (v > s) s = v;
              }
            } else if (fetch >= 0) break;
          }
          dLand[r] = Math.min(fetch, FETCH_CAP);
          sh[r] = s;
        }
        for (let dd = 0; dd < SEA_DIRS; dd++) {
          const r0 = dd * (SEA_RAYS / SEA_DIRS);
          let f = 0, s = 0, w = 0;
          for (let k = -FAN_FETCH; k <= FAN_FETCH; k++) f += wF[k + FAN_FETCH] * dLand[(r0 + k + SEA_RAYS) % SEA_RAYS];
          for (let k = -FAN_SHELTER; k <= FAN_SHELTER; k++) s += wS[k + FAN_SHELTER] * sh[(r0 + k + SEA_RAYS) % SEA_RAYS];
          for (let k = -FAN_SWELL; k <= FAN_SWELL; k++) w += wW[k + FAN_SWELL] * (dLand[(r0 + k + SEA_RAYS) % SEA_RAYS] >= FETCH_CAP ? 1 : 0);
          F[c * SEA_DIRS + dd] = Math.min(FETCH_CAP, f);
          Sh[c * SEA_DIRS + dd] = 1 - (1 - LEE_FLOOR) * s;
          W[c * SEA_DIRS + dd] = SWELL_FLOOR + (1 - SWELL_FLOOR) * w;
        }
      }
    // smoothing over sea cells only (spec §3.4): fetch in log space
    const fine = g !== G;
    for (let k = 0; k < F.length; k++) F[k] = Math.log(Math.max(1, F[k]));
    maskedBlur(F, SEA_DIRS, n, g.land, 1);
    dilate(F, SEA_DIRS, n, g.land);
    for (let k = 0; k < F.length; k++) F[k] = Math.min(FETCH_CAP, Math.exp(F[k]));
    maskedBlur(Sh, SEA_DIRS, n, g.land, 1);
    dilate(Sh, SEA_DIRS, n, g.land);
    maskedBlur(W, SEA_DIRS, n, g.land, 1);
    maskedBlur(W, SEA_DIRS, n, g.land, fine ? 4 : 3);
    dilate(W, SEA_DIRS, n, g.land);
    // depth averaged over water only: a berth beside a quay is as deep as its own water, not half land
    const hb = new Float32Array(g.depth);
    maskedBlur(hb, 1, n, g.land, fine ? 2.5 : 1.6);
    dilate(hb, 1, n, g.land);
    maps.push({ originX: g.ox, originZ: g.oz, cell: g.cell, n, F, S: Sh, W, hb, land: g.land });
  }
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { dirs: SEA_DIRS, maps, ms: t1 - t0 };
}

/** transferable buffers of a bake (worker -> main thread) */
export function seaStateBuffers(b: SeaStateBake): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const m of b.maps) out.push(m.F.buffer as ArrayBuffer, m.S.buffer as ArrayBuffer, m.W.buffer as ArrayBuffer, m.hb.buffer as ArrayBuffer, m.land.buffer as ArrayBuffer);
  return out;
}

// --------------------------------------------------------------------------------------- runtime

/** what the field needs from the wave model (WaveField implements it) */
export interface SeaWaveModel {
  /** wind-sea variance (m^2) of the long, mid and short bands for wind U and fetch F, with the current directional shares */
  windBandVariance(U: number, F: number, out: Float64Array): void;
  /** current swell variance (m^2) */
  swellVariance(): number;
}

const G0 = 9.81;
/** 1D JONSWAP variance over a wavenumber band (deep water): the FFT cascade A's share */
function bandIntegral(U: number, F: number, k0: number, k1: number) {
  const w0 = Math.sqrt(G0 * k0), w1 = Math.sqrt(G0 * k1), steps = 48;
  let v = 0;
  for (let s = 0; s < steps; s++) {
    const a = w0 * Math.pow(w1 / w0, s / steps), b = w0 * Math.pow(w1 / w0, (s + 1) / steps);
    v += jonswap(Math.sqrt(a * b), U, F) * (b - a);
  }
  return v;
}

/**
 * The live envelope. Atlas layout: map k occupies texel columns [k n, (k + 1) n); env0 = (swell, long,
 * mid, short) amplitude envelopes in rows [0, n), env1 = (FFT cascade A envelope, wind shelter S,
 * blurred depth, lee gustiness) in rows [n, 2n). One texture (`data`), so the ocean spends one unit.
 */
export class SeaStateField {
  readonly n: number;
  readonly atlasWidth: number;
  /** env0 then env1: the texture's bytes */
  readonly data: Float32Array;
  readonly env0: Float32Array;
  readonly env1: Float32Array;
  private target0: Float32Array;
  private target1: Float32Array;
  /** bumped on every change of env0/env1 (the GPU wrapper uploads on change) */
  version = 0;
  private lut = new Float64Array(LUT_S * LUT_F * 4);
  private refVar = new Float64Array(4); // long, mid, short, FFT A at the open sea
  private swellVar = 0;
  private composed = false;
  private tickAcc = 0;
  private tmp = new Float64Array(3);

  constructor(readonly bake: SeaStateBake, private model: SeaWaveModel, private fftBand: [number, number]) {
    this.n = bake.maps[0].n;
    for (const m of bake.maps) if (m.n !== this.n) throw new Error('sea state maps must share one resolution');
    this.atlasWidth = this.n * bake.maps.length;
    const len = this.atlasWidth * this.n * 4;
    this.data = new Float32Array(2 * len).fill(1);
    this.env0 = this.data.subarray(0, len);
    this.env1 = this.data.subarray(len);
    this.target0 = new Float32Array(len);
    this.target1 = new Float32Array(len);
  }

  get global() {
    return this.bake.maps[0];
  }
  get details() {
    return this.bake.maps.slice(1);
  }

  private lutU = NaN;
  private lutFrom = NaN;
  private lutSwell = NaN;
  private rebuildLut(U: number, from: number) {
    // the table depends on the free wind's speed, its direction (through the components' directional
    // shares) and the swell: skip the rebuild while all three hold
    const sw = this.model.swellVariance();
    if (Math.abs(U - this.lutU) <= 0.005 * U && Math.abs(from - this.lutFrom) <= 0.01 && Math.abs(sw - this.lutSwell) <= 0.005 * sw) return;
    this.lutU = U;
    this.lutFrom = from;
    this.lutSwell = sw;
    const v = this.tmp;
    this.model.windBandVariance(U, FETCH_CAP, v);
    this.refVar.set([v[0], v[1], v[2], bandIntegral(U, FETCH_CAP, this.fftBand[0], this.fftBand[1])]);
    this.swellVar = this.model.swellVariance();
    for (let a = 0; a < LUT_S; a++) {
      const s = LEE_FLOOR + ((1 - LEE_FLOOR) * a) / (LUT_S - 1);
      for (let b = 0; b < LUT_F; b++) {
        const F = Math.exp(Math.log(LUT_FMIN) + ((Math.log(FETCH_CAP) - Math.log(LUT_FMIN)) * b) / (LUT_F - 1));
        this.model.windBandVariance(U * s, F, v);
        const fa = bandIntegral(U * s, F, this.fftBand[0], this.fftBand[1]);
        const o = (a * LUT_F + b) * 4;
        const vals = [v[0], v[1], v[2], fa];
        for (let k = 0; k < 4; k++) this.lut[o + k] = this.refVar[k] > 1e-12 ? Math.min(1, Math.sqrt(Math.max(0, vals[k]) / this.refVar[k])) : 1;
      }
    }
  }

  /** band envelopes [long, mid, short, fftA] for wind fraction s and fetch F: bilinear in (s, log F) */
  private lookup(s: number, F: number, out: Float64Array) {
    const fa = ((Math.min(1, Math.max(LEE_FLOOR, s)) - LEE_FLOOR) / (1 - LEE_FLOOR)) * (LUT_S - 1);
    const fb = ((Math.log(Math.min(FETCH_CAP, Math.max(LUT_FMIN, F))) - Math.log(LUT_FMIN)) / (Math.log(FETCH_CAP) - Math.log(LUT_FMIN))) * (LUT_F - 1);
    const a0 = Math.min(LUT_S - 2, Math.floor(fa)), b0 = Math.min(LUT_F - 2, Math.floor(fb));
    const ta = fa - a0, tb = fb - b0;
    const L = this.lut;
    for (let k = 0; k < 4; k++) {
      const p = L[(a0 * LUT_F + b0) * 4 + k], q = L[(a0 * LUT_F + b0 + 1) * 4 + k];
      const r = L[((a0 + 1) * LUT_F + b0) * 4 + k], t = L[((a0 + 1) * LUT_F + b0 + 1) * 4 + k];
      out[k] = (p * (1 - tb) + q * tb) * (1 - ta) + (r * (1 - tb) + t * tb) * ta;
    }
  }

  /**
   * Compose the target envelope for the current wind (spec §4.1–4.2). windFrom and swellFrom are the
   * compass bearings the wind and swell come from; U the free (mean) wind. The first call also sets
   * the live envelope; so does snap (a deliberate jump, e.g. a dev override of the wind).
   */
  compose(U: number, windFrom: number, swellFrom: number, snap = false) {
    this.rebuildLut(Math.max(1, U), windFrom);
    const D = SEA_DIRS, step = (2 * Math.PI) / D;
    const pos = (b: number) => {
      const f = ((((b % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / step);
      const d0 = Math.floor(f) % D;
      return { d0, d1: (d0 + 1) % D, t: f - Math.floor(f) };
    };
    const wd = pos(windFrom), sd = pos(swellFrom);
    const e = new Float64Array(4);
    const n = this.n, W4 = this.atlasWidth * 4;
    const rv = this.refVar;
    this.bake.maps.forEach((m, k) => {
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const c = j * n + i, o = j * W4 + (k * n + i) * 4;
          const F = Math.exp(Math.log(m.F[c * D + wd.d0]) * (1 - wd.t) + Math.log(m.F[c * D + wd.d1]) * wd.t);
          const S = m.S[c * D + wd.d0] * (1 - wd.t) + m.S[c * D + wd.d1] * wd.t;
          const sw = m.W[c * D + sd.d0] * (1 - sd.t) + m.W[c * D + sd.d1] * sd.t;
          this.lookup(S, F, e);
          const hb = m.hb[c];
          const varLocal = (e[0] * e[0] * rv[0] + e[1] * e[1] * rv[1] + e[2] * e[2] * rv[2] + e[3] * e[3] * rv[3] + sw * sw * this.swellVar);
          const hs = 4 * Math.sqrt(varLocal);
          const cap = hs > 1e-6 ? Math.min(1, (DEPTH_HS * hb) / hs) : 1;
          this.target0[o] = sw * cap;
          this.target0[o + 1] = e[0] * cap;
          this.target0[o + 2] = e[1] * cap;
          this.target0[o + 3] = e[2] * cap;
          this.target1[o] = e[3] * cap;
          this.target1[o + 1] = S;
          this.target1[o + 2] = hb;
          this.target1[o + 3] = GUST_LEE * (1 - S);
        }
    });
    if (!this.composed || snap) {
      this.env0.set(this.target0);
      this.env1.set(this.target1);
      this.composed = true;
      this.version++;
    }
  }

  /** advance on simulation time: every SEA_TICK the live envelope relaxes toward the target (τ = SEA_TAU) */
  tick(dt: number) {
    if (!this.composed) return;
    this.tickAcc += dt;
    if (this.tickAcc < SEA_TICK) return;
    const a = 1 - Math.exp(-this.tickAcc / SEA_TAU);
    this.tickAcc = 0;
    const e0 = this.env0, e1 = this.env1, t0 = this.target0, t1 = this.target1;
    for (let k = 0; k < e0.length; k++) {
      e0[k] += (t0[k] - e0[k]) * a;
      e1[k] += (t1[k] - e1[k]) * a;
    }
    this.version++;
  }

  /**
   * Envelope at world (x, z): bilinear over texel centres, clamped to each map's edge; a detail region
   * blends in over its outer DETAIL_FEATHER metres. GLSL seaEnv() in waves.ts is the same arithmetic.
   */
  sample(x: number, z: number, out0: Float64Array | number[], out1?: Float64Array | number[]) {
    const maps = this.bake.maps;
    this.bilinear(maps[0], 0, x, z, out0, out1);
    for (let k = 1; k < maps.length; k++) {
      const m = maps[k], size = m.n * m.cell;
      const lx = x - m.originX, lz = z - m.originZ;
      if (lx <= 0 || lz <= 0 || lx >= size || lz >= size) continue;
      const f = Math.min(1, Math.min(lx, lz, size - lx, size - lz) / DETAIL_FEATHER);
      const g0 = this.d0, g1 = this.d1;
      this.bilinear(m, k, x, z, g0, g1);
      for (let c = 0; c < 4; c++) {
        out0[c] += (g0[c] - out0[c]) * f;
        if (out1) out1[c] += (g1[c] - out1[c]) * f;
      }
      break;
    }
  }
  private d0 = new Float64Array(4);
  private d1 = new Float64Array(4);

  private bilinear(m: SeaMap, k: number, x: number, z: number, out0: Float64Array | number[], out1?: Float64Array | number[]) {
    const n = this.n, W4 = this.atlasWidth * 4;
    const fx = Math.min(n - 1, Math.max(0, (x - m.originX) / m.cell - 0.5));
    const fz = Math.min(n - 1, Math.max(0, (z - m.originZ) / m.cell - 0.5));
    const i0 = Math.min(n - 2, Math.floor(fx)), j0 = Math.min(n - 2, Math.floor(fz));
    const tx = fx - i0, tz = fz - j0;
    const a = j0 * W4 + (k * n + i0) * 4, b = a + 4, c = a + W4, d = c + 4;
    const w0 = (1 - tx) * (1 - tz), w1 = tx * (1 - tz), w2 = (1 - tx) * tz, w3 = tx * tz;
    const e0 = this.env0, e1 = this.env1;
    for (let q = 0; q < 4; q++) {
      out0[q] = e0[a + q] * w0 + e0[b + q] * w1 + e0[c + q] * w2 + e0[d + q] * w3;
      if (out1) out1[q] = e1[a + q] * w0 + e1[b + q] * w1 + e1[c + q] * w2 + e1[d + q] * w3;
    }
  }
}

/** soft band weights (long, mid, short) of a wind-sea component of wavelength lambda: triangular in log lambda */
export function bandWeights(lambda: number): [number, number, number] {
  const L = Math.log(lambda), p0 = Math.log(BAND_LAMBDA[0]), p1 = Math.log(BAND_LAMBDA[1]), p2 = Math.log(BAND_LAMBDA[2]);
  if (L >= p0) return [1, 0, 0];
  if (L <= p2) return [0, 0, 1];
  if (L >= p1) {
    const t = (p0 - L) / (p0 - p1);
    return [1 - t, t, 0];
  }
  const t = (p1 - L) / (p1 - p2);
  return [0, 1 - t, t];
}
