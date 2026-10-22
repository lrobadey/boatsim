import { rng } from '../core/util';
import { jonswap } from './spectrum';
import type { Wind } from './wind';
import { DETAIL_FEATHER, bandWeights, type SeaStateField, type SeaWaveModel } from './seaState';

/**
 * Gerstner wave field whose components are drawn from a fetch-limited JONSWAP spectrum.
 *
 * A fixed fan of components (frequency x direction) is created once; each frame their amplitudes are
 * re-weighted from the current wind (speed -> spectrum, direction -> cos^2s spreading). Because wave
 * vectors never change, the surface never "pops" when the wind shifts — the sea just re-shapes.
 *
 * The exact same evaluation runs in GLSL (ocean vertex shader) and here on the CPU (buoyancy),
 * so the ship floats on the surface you see.
 */
export const WAVE_COUNT = 24;
/** shortest Gerstner wavelength; shorter waves are synthesised by the FFT detail cascades */
export const GERSTNER_MIN_LAMBDA = 11;
const G = 9.81;

export { jonswap, jonswapPeak } from './spectrum';

export interface WaveComponent {
  dx: number;
  dz: number;
  k: number;
  omega: number;
  phase: number;
  amp: number; // current (smoothed) amplitude
  target: number;
  q: number; // steepness
  /** sea state band weights (swell, long, mid, short); the local amplitude is amp * dot(envelope, band) */
  band?: [number, number, number, number];
}

/**
 * Warm start for the inverse query (world point -> undisplaced point). A caller that queries the same
 * moving point every step keeps one of these: the next query starts from the last solution shifted by the
 * point's motion and needs one fixed-point iteration instead of four (on the merchant in a 1.6 m sea this
 * matched the cold solve within 4 N of hull force). A query too far from the last one in space or time
 * solves cold, so a sample shared between distant points behaves exactly as before.
 */
export interface InverseCache { warm: boolean; qx: number; qz: number; px: number; pz: number; t: number }
export const createInverseCache = (): InverseCache => ({ warm: false, qx: 0, qz: 0, px: 0, pz: 0, t: 0 });

export interface FlowSample extends InverseCache {
  height: number; hx: number; hz: number; vx: number; vy: number; vz: number;
  sigma: number; H: number; Hx: number; guarded: boolean;
  sin: Float64Array; cos: Float64Array;
  /** sea state envelope at the sample's undisplaced point (valid when enveloped) */
  env: Float64Array; enveloped: boolean;
}
export function createFlowSample(count = WAVE_COUNT): FlowSample {
  return { ...createInverseCache(), height: 0, hx: 0, hz: 0, vx: 0, vy: 0, vz: 0,
    sigma: 1, H: 0, Hx: 0, guarded: false, sin: new Float64Array(count), cos: new Float64Array(count),
    env: new Float64Array(4), enveloped: false };
}
/** inverse fixed-point iterations from the query point (cold) and from a cached nearby solution (warm) */
const INVERSE_COLD = 4;
const INVERSE_WARM = 1;
/** a cached solution is reused only for a query within this distance (m) and time (s) of it */
const WARM_DIST = 0.25;
const WARM_DT = 0.05;

export class WaveField implements SeaWaveModel {
  waves: WaveComponent[] = [];
  /** packed for GPU: [dx, dz, k, amp], [omega, phase, q, lambda] and the sea state band weights */
  readonly packedA = new Float32Array(WAVE_COUNT * 4);
  readonly packedB = new Float32Array(WAVE_COUNT * 4);
  readonly packedC = new Float32Array(WAVE_COUNT * 4);
  /**
   * Sea state envelope (docs/sea-state-spec.md). null = the same sea everywhere: every query then runs
   * the original code path unchanged.
   */
  field: SeaStateField | null = null;
  /** per wind-sea component, from the last retarget: directional share and frequency bin width */
  private share = new Float64Array(WAVE_COUNT);
  private dOmega = new Float64Array(WAVE_COUNT);
  fetch = 40_000; // m — Aegean between islands
  swellHeight = 0.35; // m — residual swell from distant weather
  swellFrom = (300 * Math.PI) / 180; // WNW
  /** significant wave height of the wind sea (diagnostic) */
  hs = 0;
  peakLambda = 0;
  /** variance of the surface Jacobian (first order): sets the whitecap threshold statistically */
  jVar = 0;
  private swellCount = 3;

  constructor(wind: Wind, seed = 7) {
    const r = rng(seed);
    const meanTo = wind.from + Math.PI;
    // Wind-sea components: log-spaced wavelengths, directions fanned +-80deg around the initial wind
    // (the fan is fixed; amplitudes re-weight as wind veers).
    const windCount = WAVE_COUNT - this.swellCount;
    for (let i = 0; i < windCount; i++) {
      const t = i / (windCount - 1);
      const lambda = 64 * Math.pow(GERSTNER_MIN_LAMBDA / 64, t) * (0.95 + 0.1 * r());
      const k = (2 * Math.PI) / lambda;
      // short waves spread wider (they respond to local gusts and cross-seas)
      const maxSpread = 55 + 45 * t;
      const spread = ((i % 2 ? 1 : -1) * (0.1 + 0.9 * r()) * maxSpread * Math.PI) / 180;
      const b = meanTo + spread;
      this.waves.push({
        dx: Math.sin(b),
        dz: -Math.cos(b),
        k,
        omega: Math.sqrt(G * k),
        phase: r() * Math.PI * 2,
        amp: 0,
        target: 0,
        q: 0,
        band: [0, ...bandWeights(lambda)],
      });
    }
    // Long swell components (independent of local wind)
    for (let i = 0; i < this.swellCount; i++) {
      const lambda = [110, 85, 70][i];
      const k = (2 * Math.PI) / lambda;
      const b = this.swellFrom + Math.PI + (i - 1) * 0.12;
      this.waves.push({
        dx: Math.sin(b),
        dz: -Math.cos(b),
        k,
        omega: Math.sqrt(G * k),
        phase: r() * Math.PI * 2,
        amp: 0,
        target: 0,
        q: 0,
        band: [1, 0, 0, 0],
      });
    }
    this.retarget(wind);
    for (const w of this.waves) w.amp = w.target;
    this.pack();
  }

  /** Recompute target amplitudes from the wind (called at low rate). */
  retarget(wind: Wind) {
    const U = Math.max(1, wind.meanSpeed);
    const windCount = WAVE_COUNT - this.swellCount;
    const to = wind.from + Math.PI;
    const wdx = Math.sin(to);
    const wdz = -Math.cos(to);
    // frequency bins (components are sorted long -> short)
    const s = 2.5; // cos^2s spreading exponent
    let dirNorm = 0;
    const dirW: number[] = [];
    for (let i = 0; i < windCount; i++) {
      const w = this.waves[i];
      const c = Math.max(0, w.dx * wdx + w.dz * wdz);
      const d = Math.pow(c, 2 * s);
      dirW.push(d);
      dirNorm += d;
    }
    let m0 = 0;
    let peak = 0;
    let peakS = 0;
    for (let i = 0; i < windCount; i++) {
      const w = this.waves[i];
      const prev = i > 0 ? this.waves[i - 1].omega : w.omega * 0.8;
      const next = i < windCount - 1 ? this.waves[i + 1].omega : w.omega * 1.25;
      const dOmega = Math.abs(next - prev) * 0.5;
      const S = jonswap(w.omega, U, this.fetch);
      // energy of this frequency band redistributed over directions; each component carries a share
      // proportional to its directional weight (normalised so the total variance is preserved)
      const share = (dirW[i] / Math.max(1e-6, dirNorm)) * windCount;
      const variance = S * dOmega * share;
      w.target = Math.sqrt(2 * variance);
      this.share[i] = share;
      this.dOmega[i] = dOmega;
      m0 += S * dOmega;
      if (S > peakS) {
        peakS = S;
        peak = (2 * Math.PI) / w.k;
      }
    }
    this.hs = 4 * Math.sqrt(m0);
    this.peakLambda = peak;
    for (let i = windCount; i < WAVE_COUNT; i++) {
      this.waves[i].target = (this.swellHeight / 2) * [0.6, 0.3, 0.2][i - windCount];
    }
  }

  update(dt: number) {
    // sea state responds over ~a minute
    const a = 1 - Math.exp(-dt / 40);
    for (const w of this.waves) w.amp += (w.target - w.amp) * a;
    // Steepness budget: sum(Q k A) <= 0.75 so crests sharpen but never loop.
    let sum = 0;
    for (const w of this.waves) sum += w.k * w.amp;
    const budget = 0.75;
    let jv = 0;
    for (const w of this.waves) {
      w.q = sum > 1e-5 ? Math.min(1, budget / sum) : 0;
      jv += 0.5 * (w.q * w.k * w.amp) ** 2;
    }
    this.jVar = jv;
    this.pack();
  }

  private pack() {
    for (let i = 0; i < WAVE_COUNT; i++) {
      const w = this.waves[i];
      this.packedA.set([w.dx, w.dz, w.k, w.amp], i * 4);
      this.packedB.set([w.omega, w.phase, w.q, (2 * Math.PI) / w.k], i * 4);
      this.packedC.set(w.band ?? [0, 0, 0, 0], i * 4);
    }
  }

  /** SeaWaveModel: wind-sea variance of the long, mid and short bands for wind U and fetch F (current directional shares) */
  windBandVariance(U: number, F: number, out: Float64Array) {
    out[0] = out[1] = out[2] = 0;
    const windCount = WAVE_COUNT - this.swellCount;
    for (let i = 0; i < windCount && i < this.waves.length; i++) {
      const b = this.waves[i].band;
      if (!b) continue;
      const v = jonswap(this.waves[i].omega, Math.max(0.5, U), F) * this.dOmega[i] * this.share[i];
      out[0] += b[1] * v;
      out[1] += b[2] * v;
      out[2] += b[3] * v;
    }
  }
  /** SeaWaveModel: variance of the swell components at their targets */
  swellVariance() {
    let v = 0;
    for (let i = WAVE_COUNT - this.swellCount; i < this.waves.length; i++) v += (this.waves[i].target * this.waves[i].target) / 2;
    return v;
  }

  private env4 = new Float64Array(4);
  private envAmp = new Float64Array(WAVE_COUNT);
  /** component amplitudes scaled by an envelope (swell, long, mid, short) */
  private ampsFor(env: Float64Array) {
    const out = this.envAmp;
    for (let i = 0; i < this.waves.length; i++) {
      const w = this.waves[i], b = w.band;
      out[i] = b ? w.amp * (env[0] * b[0] + env[1] * b[1] + env[2] * b[2] + env[3] * b[3]) : w.amp;
    }
    return out;
  }
  /** local over open-sea wave height here (1 without a sea state field) */
  seaRatio(x: number, z: number) {
    if (!this.field) return 1;
    let v = 0;
    for (const w of this.waves) v += (w.amp * w.amp) / 2;
    const open = 4 * Math.sqrt(v);
    return open > 1e-6 ? this.localHs(x, z) / open : 1;
  }
  /** significant wave height here (Gerstner bands, current amplitudes) */
  localHs(x: number, z: number) {
    let v = 0;
    if (this.field) {
      this.field.sample(x, z, this.env4);
      const a = this.ampsFor(this.env4);
      for (let i = 0; i < this.waves.length; i++) v += (a[i] * a[i]) / 2;
    } else for (const w of this.waves) v += (w.amp * w.amp) / 2;
    return 4 * Math.sqrt(v);
  }

  /** Gerstner displacement at undisplaced grid point (x,z). Writes into out[0..2]. */
  displacement(x: number, z: number, t: number, out: Float64Array | number[]) {
    if (this.field) {
      this.field.sample(x, z, this.env4);
      this.displacementWith(this.ampsFor(this.env4), x, z, t, out);
      return;
    }
    let dx = 0,
      dy = 0,
      dz = 0;
    for (let i = 0; i < this.waves.length; i++) {
      const w = this.waves[i];
      const th = w.k * (w.dx * x + w.dz * z) - w.omega * t + w.phase;
      const c = Math.cos(th);
      const qa = w.q * w.amp;
      dx += qa * w.dx * c;
      dz += qa * w.dz * c;
      dy += w.amp * Math.sin(th);
    }
    out[0] = dx;
    out[1] = dy;
    out[2] = dz;
  }

  private displacementWith(amp: Float64Array, x: number, z: number, t: number, out: Float64Array | number[]) {
    let dx = 0, dy = 0, dz = 0;
    for (let i = 0; i < this.waves.length; i++) {
      const w = this.waves[i];
      const th = w.k * (w.dx * x + w.dz * z) - w.omega * t + w.phase;
      const c = Math.cos(th);
      const qa = w.q * amp[i];
      dx += qa * w.dx * c;
      dz += qa * w.dz * c;
      dy += amp[i] * Math.sin(th);
    }
    out[0] = dx;
    out[1] = dy;
    out[2] = dz;
  }

  private tmp = new Float64Array(3);
  /** the undisplaced point found by the last solveInverse */
  private ipx = 0;
  private ipz = 0;
  /** world (x, z) -> undisplaced point by fixed-point iteration on the horizontal displacement, warm when it can */
  private solveInverse(x: number, z: number, t: number, cache: InverseCache | null) {
    let px = x, pz = z, iters = INVERSE_COLD;
    if (cache && cache.warm && Math.abs(t - cache.t) <= WARM_DT && Math.abs(x - cache.qx) <= WARM_DIST && Math.abs(z - cache.qz) <= WARM_DIST) {
      px = cache.px + (x - cache.qx);
      pz = cache.pz + (z - cache.qz);
      iters = INVERSE_WARM;
    }
    const d = this.tmp;
    for (let it = 0; it < iters; it++) {
      this.displacement(px, pz, t, d);
      px = x - d[0];
      pz = z - d[2];
    }
    if (cache) { cache.warm = true; cache.qx = x; cache.qz = z; cache.px = px; cache.pz = pz; cache.t = t; }
    this.ipx = px;
    this.ipz = pz;
  }

  /**
   * Water surface height at world (x,z): inverts the horizontal displacement by fixed-point iteration.
   * A caller tracking one moving point passes its own cache to warm-start the inversion.
   */
  heightAt(x: number, z: number, t: number, cache: InverseCache | null = null) {
    this.solveInverse(x, z, t, cache);
    const d = this.tmp;
    this.displacement(this.ipx, this.ipz, t, d);
    return d[1];
  }

  /** World-coordinate inverse query shared by hull, rudders and every oar. Frozen amplitudes:
   * slow weather amplitude derivatives are omitted; orbital velocity decays as deep-water flow.
   * `out` is also the query's warm-start cache: give each tracked point its own sample. */
  sampleFlowAt(x: number, y: number, z: number, t: number, out: FlowSample) {
    this.solveInverse(x, z, t, out);
    const px = this.ipx, pz = this.ipz;
    let height = 0, gx = 0, gz = 0, jxx = 1, jzz = 1, jxz = 0, H = 0, Hx = 0;
    if (this.waves.length > out.sin.length) throw new Error('Flow cache is too small');
    // sea state: amplitudes from the envelope at the undisplaced point (its gradient is neglected)
    let amp: Float64Array | null = null;
    out.enveloped = this.field !== null;
    if (this.field) {
      this.field.sample(px, pz, out.env);
      amp = this.ampsFor(out.env);
    }
    for (let i = 0; i < this.waves.length; i++) {
      const w = this.waves[i];
      const A = amp ? amp[i] : w.amp;
      const th = w.k * (w.dx * px + w.dz * pz) - w.omega * t + w.phase;
      const sn = Math.sin(th), cs = Math.cos(th);
      out.sin[i] = sn; out.cos[i] = cs;
      height += A * sn;
      gx += A * w.k * w.dx * cs; gz += A * w.k * w.dz * cs;
      const jk = w.q * A * w.k * sn;
      jxx -= jk * w.dx * w.dx; jzz -= jk * w.dz * w.dz; jxz -= jk * w.dx * w.dz;
      H += Math.abs(A) * w.k * w.k; Hx += Math.abs(w.q * A) * w.k * w.k;
    }
    let det = jxx * jzz - jxz * jxz;
    out.guarded = Math.abs(det) < 0.10;
    if (out.guarded) det = det < 0 ? -0.10 : 0.10;
    out.height = height; out.hx = (jzz * gx - jxz * gz) / det; out.hz = (jxx * gz - jxz * gx) / det;
    const delta = Math.hypot(jxx - jzz, 2 * jxz);
    out.sigma = Math.min(Math.abs((jxx + jzz - delta) / 2), Math.abs((jxx + jzz + delta) / 2));
    out.H = H; out.Hx = Hx;
    this.flowAtDepth(out, Math.max(0, height - y), out);
    return out;
  }

  /** Reuse an inverse query's component phases, adjusting only physical sample depth. */
  flowAtDepth(cache: FlowSample, depth: number, out: { vx: number; vy: number; vz: number }) {
    let vx = 0, vy = 0, vz = 0;
    const amp = cache.enveloped ? this.ampsFor(cache.env) : null;
    for (let i = 0; i < this.waves.length; i++) {
      const w = this.waves[i];
      const a = Math.exp(-w.k * Math.max(0, depth)) * (amp ? amp[i] : w.amp) * w.omega;
      vx += a * w.q * w.dx * cache.sin[i]; vz += a * w.q * w.dz * cache.sin[i];
      vy -= a * cache.cos[i];
    }
    out.vx = vx; out.vy = vy; out.vz = vz;
  }

  /** Local fluid acceleration (time derivative of flowAtDepth) from an inverse query's cached phases. */
  accelAtDepth(cache: FlowSample, depth: number, out: { x: number; y: number; z: number }) {
    let ax = 0, ay = 0, az = 0;
    const amp = cache.enveloped ? this.ampsFor(cache.env) : null;
    for (let i = 0; i < this.waves.length; i++) {
      const w = this.waves[i];
      const a = Math.exp(-w.k * Math.max(0, depth)) * (amp ? amp[i] : w.amp) * w.omega * w.omega;
      ax -= a * w.q * w.dx * cache.cos[i]; az -= a * w.q * w.dz * cache.cos[i];
      ay -= a * cache.sin[i];
    }
    out.x = ax; out.y = ay; out.z = az;
    return out;
  }

  private flowScratch = createFlowSample();
  /** Surface material velocity at world coordinates (same inverse convention as heightAt). */
  velocityAt(x: number, z: number, t: number, out: { x: number; y: number; z: number }) {
    const f = this.sampleFlowAt(x, Infinity, z, t, this.flowScratch);
    out.x = f.vx; out.y = f.vy; out.z = f.vz;
  }

}

/** GLSL implementation matching WaveField.displacement. Requires uniforms uWaveA/uWaveB/uTime. */
export const WAVES_GLSL = /* glsl */ `
#define WAVE_COUNT ${WAVE_COUNT}
uniform vec4 uWaveA[WAVE_COUNT]; // dx, dz, k, amp
uniform vec4 uWaveB[WAVE_COUNT]; // omega, phase, q, lambda
uniform vec4 uWaveC[WAVE_COUNT]; // sea state band weights: swell, long, mid, short
uniform float uSeaOn;
uniform float uTime;

// slope variance of the components faded out by distance (sub-pixel waves): becomes roughness
float gLostVar;
// p: undisplaced world xz; dist: distance to camera for anti-alias fade; env: sea state envelope
// (swell, long, mid, short) at p. Returns displacement; outputs normal and jacobian (surface
// compression -> foam).
vec3 gerstner(vec2 p, float dist, vec4 env, out vec3 N, out float J) {
  vec3 d = vec3(0.0);
  float nx = 0.0, nz = 0.0, ny = 0.0;
  float jxx = 0.0, jzz = 0.0, jxz = 0.0;
  gLostVar = 0.0;
  for (int i = 0; i < WAVE_COUNT; i++) {
    vec4 A = uWaveA[i];
    vec4 B = uWaveB[i];
    float lambda = B.w;
    float fade = 1.0 - smoothstep(lambda * 30.0, lambda * 110.0, dist);
    float local = uSeaOn > 0.5 ? A.w * dot(env, uWaveC[i]) : A.w;
    float lost = A.z * local * (1.0 - fade);
    gLostVar += 0.5 * lost * lost;
    float amp = local * fade;
    if (amp < 1e-5) continue;
    float th = A.z * dot(A.xy, p) - B.x * uTime + B.y;
    float s = sin(th), c = cos(th);
    float qa = B.z * amp;
    d.x += qa * A.x * c;
    d.z += qa * A.y * c;
    d.y += amp * s;
    float wa = A.z * amp;
    nx += A.x * wa * c;
    nz += A.y * wa * c;
    ny += B.z * wa * s;
    jxx += B.z * wa * A.x * A.x * s;
    jzz += B.z * wa * A.y * A.y * s;
    jxz += B.z * wa * A.x * A.y * s;
  }
  N = normalize(vec3(-nx, 1.0 - ny, -nz));
  J = (1.0 - jxx) * (1.0 - jzz) - jxz * jxz;
  return d;
}
`;

/**
 * GLSL matching SeaStateField.sample (vertex shader only: the fragment shader is at its sampler limit
 * and receives the envelope as varyings). Same Float32 texels, texel-centre bilinear, edge clamp and
 * detail feather as the CPU.
 */
export const SEA_ENV_GLSL = /* glsl */ `
uniform sampler2D uSeaEnv; // rows [0, n): env0; rows [n, 2n): env1
uniform vec4 uSeaGlobal; // origin x, origin z, cell (m), cells per side
uniform vec4 uSeaDetail; // origin x, origin z, cell (m; 0 = none), atlas column offset
void seaBilinear(vec2 origin, float cell, float off, vec2 p, out vec4 e0, out vec4 e1) {
  float n = uSeaGlobal.w;
  vec2 f = clamp((p - origin) / cell - 0.5, vec2(0.0), vec2(n - 1.0));
  vec2 i0 = min(vec2(n - 2.0), floor(f));
  vec2 t = f - i0;
  ivec2 a = ivec2(int(i0.x + off), int(i0.y));
  ivec2 bx = a + ivec2(1, 0), cz = a + ivec2(0, 1), d = a + ivec2(1, 1), r = ivec2(0, int(n));
  vec4 w = vec4((1.0 - t.x) * (1.0 - t.y), t.x * (1.0 - t.y), (1.0 - t.x) * t.y, t.x * t.y);
  e0 = texelFetch(uSeaEnv, a, 0) * w.x + texelFetch(uSeaEnv, bx, 0) * w.y + texelFetch(uSeaEnv, cz, 0) * w.z + texelFetch(uSeaEnv, d, 0) * w.w;
  e1 = texelFetch(uSeaEnv, a + r, 0) * w.x + texelFetch(uSeaEnv, bx + r, 0) * w.y + texelFetch(uSeaEnv, cz + r, 0) * w.z + texelFetch(uSeaEnv, d + r, 0) * w.w;
}
void seaEnv(vec2 p, out vec4 e0, out vec4 e1) {
  e0 = vec4(1.0);
  e1 = vec4(1.0, 1.0, 60.0, 0.0);
  if (uSeaOn < 0.5) return;
  seaBilinear(uSeaGlobal.xy, uSeaGlobal.z, 0.0, p, e0, e1);
  if (uSeaDetail.z > 0.0) {
    float size = uSeaGlobal.w * uSeaDetail.z;
    vec2 l = p - uSeaDetail.xy;
    if (l.x > 0.0 && l.y > 0.0 && l.x < size && l.y < size) {
      float f = min(1.0, min(min(l.x, l.y), min(size - l.x, size - l.y)) / ${DETAIL_FEATHER.toFixed(1)});
      vec4 g0, g1;
      seaBilinear(uSeaDetail.xy, uSeaDetail.z, uSeaDetail.w, p, g0, g1);
      e0 += (g0 - e0) * f;
      e1 += (g1 - e1) * f;
    }
  }
}
`;
