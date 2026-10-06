import { rng } from '../core/util';
import type { Wind } from './wind';

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

/** JONSWAP spectral density S(omega) [m^2 s] for wind speed U [m/s] and fetch F [m] */
export function jonswap(omega: number, U: number, F: number) {
  const alpha = 0.076 * Math.pow((U * U) / (F * G), 0.22);
  const wp = jonswapPeak(U, F);
  const gamma = 3.3;
  const sigma = omega <= wp ? 0.07 : 0.09;
  const r = Math.exp(-((omega - wp) ** 2) / (2 * sigma * sigma * wp * wp));
  return ((alpha * G * G) / Math.pow(omega, 5)) * Math.exp(-1.25 * Math.pow(wp / omega, 4)) * Math.pow(gamma, r);
}
export function jonswapPeak(U: number, F: number) {
  return 22 * Math.pow((G * G) / (U * F), 1 / 3);
}

export interface WaveComponent {
  dx: number;
  dz: number;
  k: number;
  omega: number;
  phase: number;
  amp: number; // current (smoothed) amplitude
  target: number;
  q: number; // steepness
}

export interface FlowSample {
  height: number; hx: number; hz: number; vx: number; vy: number; vz: number;
  sigma: number; H: number; Hx: number; guarded: boolean;
  sin: Float64Array; cos: Float64Array;
}
export function createFlowSample(count = WAVE_COUNT): FlowSample {
  return { height: 0, hx: 0, hz: 0, vx: 0, vy: 0, vz: 0,
    sigma: 1, H: 0, Hx: 0, guarded: false, sin: new Float64Array(count), cos: new Float64Array(count) };
}

export class WaveField {
  waves: WaveComponent[] = [];
  /** packed for GPU: [dx, dz, k, amp] and [omega, phase, q, lambda] */
  readonly packedA = new Float32Array(WAVE_COUNT * 4);
  readonly packedB = new Float32Array(WAVE_COUNT * 4);
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
    }
  }

  /** Gerstner displacement at undisplaced grid point (x,z). Writes into out[0..2]. */
  displacement(x: number, z: number, t: number, out: Float64Array | number[]) {
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

  private tmp = new Float64Array(3);
  /** Water surface height at world (x,z): inverts the horizontal displacement by fixed-point iteration. */
  heightAt(x: number, z: number, t: number) {
    let px = x,
      pz = z;
    const d = this.tmp;
    for (let it = 0; it < 4; it++) {
      this.displacement(px, pz, t, d);
      px = x - d[0];
      pz = z - d[2];
    }
    this.displacement(px, pz, t, d);
    return d[1];
  }

  /** World-coordinate inverse query shared by hull, rudders and every oar. Frozen amplitudes:
   * slow weather amplitude derivatives are omitted; orbital velocity decays as deep-water flow. */
  sampleFlowAt(x: number, y: number, z: number, t: number, out: FlowSample) {
    let px = x, pz = z;
    for (let it = 0; it < 4; it++) {
      this.displacement(px, pz, t, this.tmp);
      px = x - this.tmp[0]; pz = z - this.tmp[2];
    }
    let height = 0, gx = 0, gz = 0, jxx = 1, jzz = 1, jxz = 0, H = 0, Hx = 0;
    if (this.waves.length > out.sin.length) throw new Error('Flow cache is too small');
    for (let i = 0; i < this.waves.length; i++) {
      const w = this.waves[i];
      const th = w.k * (w.dx * px + w.dz * pz) - w.omega * t + w.phase;
      const sn = Math.sin(th), cs = Math.cos(th);
      out.sin[i] = sn; out.cos[i] = cs;
      height += w.amp * sn;
      gx += w.amp * w.k * w.dx * cs; gz += w.amp * w.k * w.dz * cs;
      const jk = w.q * w.amp * w.k * sn;
      jxx -= jk * w.dx * w.dx; jzz -= jk * w.dz * w.dz; jxz -= jk * w.dx * w.dz;
      H += Math.abs(w.amp) * w.k * w.k; Hx += Math.abs(w.q * w.amp) * w.k * w.k;
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
    for (let i = 0; i < this.waves.length; i++) {
      const w = this.waves[i];
      const a = Math.exp(-w.k * Math.max(0, depth)) * w.amp * w.omega;
      vx += a * w.q * w.dx * cache.sin[i]; vz += a * w.q * w.dz * cache.sin[i];
      vy -= a * cache.cos[i];
    }
    out.vx = vx; out.vy = vy; out.vz = vz;
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
uniform float uTime;

// slope variance of the components faded out by distance (sub-pixel waves): becomes roughness
float gLostVar;
// p: undisplaced world xz; dist: distance to camera for anti-alias fade.
// returns displacement; outputs normal and jacobian (surface compression -> foam).
vec3 gerstner(vec2 p, float dist, out vec3 N, out float J) {
  vec3 d = vec3(0.0);
  float nx = 0.0, nz = 0.0, ny = 0.0;
  float jxx = 0.0, jzz = 0.0, jxz = 0.0;
  gLostVar = 0.0;
  for (int i = 0; i < WAVE_COUNT; i++) {
    vec4 A = uWaveA[i];
    vec4 B = uWaveB[i];
    float lambda = B.w;
    float fade = 1.0 - smoothstep(lambda * 30.0, lambda * 110.0, dist);
    float lost = A.z * A.w * (1.0 - fade);
    gLostVar += 0.5 * lost * lost;
    float amp = A.w * fade;
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
