import * as THREE from 'three';
import { rng } from '../core/util';
import { GERSTNER_MIN_LAMBDA, jonswap, jonswapPeak } from './waves';

/**
 * Short-wave detail for the ocean: a Tessendorf FFT sea on the GPU.
 *
 * The long, energetic waves stay analytic (Gerstner, shared with the CPU buoyancy). Everything shorter
 * than GERSTNER_MIN_LAMBDA comes from the same JONSWAP spectrum here, split over two tiling cascades
 * of incommensurate size so their repeats never line up:
 *   A  ~80 m tile : waves 11 m .. ~1 m   (visible chop, displacement, whitecaps)
 *   B  ~13 m tile : waves ~1 m .. ~10 cm (wind ripples; strongly modulated by gusts in the shader)
 *
 * Per cascade and frame: evolve h(k,t) and its derivative spectra -> 2 x log2(N) Stockham butterfly
 * passes (inverse DFT, no bit reversal) -> one combine pass that writes
 *   slope  (sx, sz, sx^2 + sz^2, J) — mip-mapped, so filtered texels also carry the slope *variance*
 *                                   the shader turns into GGX roughness (LEAN-style), keeping the
 *                                   distant sea glittering correctly instead of aliasing; and the
 *                                   choppy surface's Jacobian (compression -> whitecaps);
 *   disp   (Dx, Dy, Dz, foam)    — choppy displacement, and persistent whitecap foam:
 *                                   max(previous * decay, breaking(J)) — it lives in the periodic tile
 *                                   domain, so foam drifts and frays with the waves that made it.
 * Two outputs, not three: the ocean's vertex and fragment stages share one texture unit for disp
 * (three.js counts units across both stages against a 16-unit budget).
 * Real-valued outputs are packed two per complex IFFT (a + i b) so 8 fields cost 4 transforms.
 */
const G = 9.81;
const KM = 370; // capillary wavenumber: dispersion w^2 = g k (1 + (k/km)^2)
const LOOP = 240; // s — frequencies quantised so the animation is exactly periodic (keeps float phase precise)

interface Cascade {
  L: number;
  kMin: number;
  kMax: number;
  /** variance of the first-order Jacobian (chop-scaled horizontal divergence) of this cascade */
  jVar: number;
  noise: Float32Array;
  h0Data: Float32Array;
  h0: THREE.DataTexture;
  ping: THREE.WebGLRenderTarget;
  pong: THREE.WebGLRenderTarget;
  out: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  cur: number;
}

const QUAD_VS = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const COMMON = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
vec2 ci(vec2 a) { return vec2(-a.y, a.x); } // i * a
`;

const EVOLVE_FS = /* glsl */ `
${COMMON}
uniform sampler2D uH0;
uniform float uT;
uniform float uL;
uniform float uN;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
  vec4 h0 = texelFetch(uH0, id, 0); // h0(k), conj(h0(-k))
  vec2 k = (vec2(id) - uN * 0.5) * 6.28318530718 / uL;
  float kl = max(length(k), 1e-6);
  float w0 = 6.28318530718 / ${LOOP.toFixed(1)};
  float w = floor(sqrt(${G} * kl * (1.0 + kl * kl / ${(KM * KM).toFixed(1)})) / w0) * w0;
  float ph = w * uT;
  vec2 e = vec2(cos(ph), sin(ph));
  vec2 h = cmul(h0.xy, e) + cmul(h0.zw, vec2(e.x, -e.y));
  vec2 ih = ci(h);
  vec2 kh = k / kl;
  // pack two real fields a, b as A + iB
  o0.xy = ih * kh.x + ci(h);                        // Dx, Dy
  o0.zw = ih * kh.y + ci(-h * k.x * kh.y);          // Dz, dDx/dz
  o1.xy = ih * k.x + ci(ih * k.y);                  // dh/dx, dh/dz
  o1.zw = -h * k.x * kh.x + ci(-h * k.y * kh.y);    // dDx/dx, dDz/dz
}`;

const BUTTERFLY_FS = /* glsl */ `
${COMMON}
uniform sampler2D uIn0;
uniform sampler2D uIn1;
uniform int uSub;
uniform int uHoriz;
uniform int uN;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
  int index = uHoriz == 1 ? id.x : id.y;
  int hs = uSub / 2;
  int ev = (index / uSub) * hs + (index % hs);
  int od = ev + uN / 2;
  ivec2 ie = uHoriz == 1 ? ivec2(ev, id.y) : ivec2(id.x, ev);
  ivec2 io = uHoriz == 1 ? ivec2(od, id.y) : ivec2(id.x, od);
  float arg = 6.28318530718 * float(index) / float(uSub);
  vec2 tw = vec2(cos(arg), sin(arg));
  vec4 a = texelFetch(uIn0, ie, 0), b = texelFetch(uIn0, io, 0);
  o0 = vec4(a.xy + cmul(tw, b.xy), a.zw + cmul(tw, b.zw));
  a = texelFetch(uIn1, ie, 0); b = texelFetch(uIn1, io, 0);
  o1 = vec4(a.xy + cmul(tw, b.xy), a.zw + cmul(tw, b.zw));
}`;

const COMBINE_FS = /* glsl */ `
${COMMON}
uniform sampler2D uIn0;
uniform sampler2D uIn1;
uniform sampler2D uPrevFoam;
uniform float uChop;
uniform float uDecay;
uniform float uFoamBias;
uniform float uFoamGain;
layout(location = 0) out vec4 oSlope;
layout(location = 1) out vec4 oDisp;
void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
  // centred spectrum -> (-1)^(x+y) after the transform
  float sgn = ((id.x + id.y) & 1) == 1 ? -1.0 : 1.0;
  vec4 a = texelFetch(uIn0, id, 0) * sgn;
  vec4 b = texelFetch(uIn1, id, 0) * sgn;
  float jxx = 1.0 + uChop * b.z, jzz = 1.0 + uChop * b.w, jxz = uChop * a.w;
  float J = jxx * jzz - jxz * jxz;
  // slope of the choppy (displaced) surface: horizontal compression steepens the faces
  vec2 s = b.xy / max(vec2(jxx, jzz), 0.35);
  // the shader needs only the total slope variance: mean of (sx^2 + sz^2) minus the mean slope squared
  oSlope = vec4(s, dot(s, s), J);
  float prev = texelFetch(uPrevFoam, id, 0).a;
  float src = clamp((uFoamBias - J) * uFoamGain, 0.0, 1.0);
  oDisp = vec4(a.x * uChop, a.y, a.z * uChop, max(prev * uDecay, src));
}`;

/** Lanczos log-gamma (for the directional spreading normalisation) */
function lgamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const ci of c) ser += ci / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

export class OceanFFT {
  readonly N: number;
  readonly cascades: Cascade[] = [];
  chop = 0.9;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private evolve: THREE.RawShaderMaterial;
  private butterfly: THREE.RawShaderMaterial;
  private combine: THREE.RawShaderMaterial;
  private lastU = -1;
  private lastDir = 0;
  private lastFetch = 0;

  constructor(N = 256, seed = 11) {
    this.N = N;
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    const raw = (fs: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: QUAD_VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false });
    this.evolve = raw(EVOLVE_FS, { uH0: { value: null }, uT: { value: 0 }, uL: { value: 1 }, uN: { value: N } });
    this.butterfly = raw(BUTTERFLY_FS, { uIn0: { value: null }, uIn1: { value: null }, uSub: { value: 2 }, uHoriz: { value: 1 }, uN: { value: N } });
    this.combine = raw(COMBINE_FS, {
      uIn0: { value: null },
      uIn1: { value: null },
      uPrevFoam: { value: null },
      uChop: { value: this.chop },
      uDecay: { value: 1 },
      uFoamBias: { value: 0.72 },
      uFoamGain: { value: 3 },
    });

    // cascade A: 80 m tile from the Gerstner cutoff to ~1 m; cascade B: 13.1 m tile down to the ripples
    const LA = 80,
      LB = 13.1;
    const kSplit = Math.min((2 * Math.PI) / 0.9, 0.7 * ((Math.PI * N) / LA));
    const defs = [
      { L: LA, kMin: (2 * Math.PI) / GERSTNER_MIN_LAMBDA, kMax: kSplit },
      { L: LB, kMin: kSplit, kMax: 0.9 * ((Math.PI * N) / LB) },
    ];
    const r = rng(seed);
    const gauss = () => {
      const u = Math.max(1e-9, r()),
        v = r();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const ffOpts = { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false, count: 2 };
    const outOpts = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
      generateMipmaps: true,
      count: 2,
    };
    for (const d of defs) {
      const noise = new Float32Array(N * N * 2);
      // E|xi|^2 = 1: real and imaginary parts each carry variance 1/2
      for (let i = 0; i < noise.length; i++) noise[i] = gauss() * Math.SQRT1_2;
      const h0Data = new Float32Array(N * N * 4);
      const h0 = new THREE.DataTexture(h0Data, N, N, THREE.RGBAFormat, THREE.FloatType);
      h0.minFilter = h0.magFilter = THREE.NearestFilter;
      h0.needsUpdate = true;
      const mk = () => {
        const t = new THREE.WebGLRenderTarget(N, N, outOpts);
        for (const tex of t.textures) tex.anisotropy = 8;
        return t;
      };
      this.cascades.push({ ...d, jVar: 0, noise, h0Data, h0, ping: new THREE.WebGLRenderTarget(N, N, ffOpts), pong: new THREE.WebGLRenderTarget(N, N, ffOpts), out: [mk(), mk()], cur: 0 });
    }
  }

  /** Rebuild the initial spectra h0(k) when the wind has changed appreciably. */
  retarget(U: number, windToBearing: number, fetch: number, force = false) {
    U = Math.max(1, U);
    if (!force && Math.abs(U - this.lastU) < 0.03 * this.lastU && Math.abs(windToBearing - this.lastDir) < 0.03 && fetch === this.lastFetch) return;
    this.lastU = U;
    this.lastDir = windToBearing;
    this.lastFetch = fetch;
    const N = this.N;
    const wx = Math.sin(windToBearing),
      wz = -Math.cos(windToBearing);
    const wp = jonswapPeak(U, fetch);
    // directional spreading D(theta) = Ns cos^2s(theta/2), s narrowing toward the peak (Mitsuyasu)
    const spread = (w: number) => {
      const s = Math.min(12, Math.max(0.6, 11.5 * Math.pow(w / wp, -2.5)));
      const ns = Math.exp(lgamma(s + 1) - lgamma(s + 0.5)) / (2 * Math.sqrt(Math.PI));
      return { s, ns };
    };
    const S2 = (kx: number, kz: number, kMin: number, kMax: number) => {
      const k = Math.hypot(kx, kz);
      if (k < kMin || k >= kMax) return 0;
      const w = Math.sqrt(G * k * (1 + (k * k) / (KM * KM)));
      const dwdk = (G * (1 + (3 * k * k) / (KM * KM))) / (2 * w);
      const cosT = (kx * wx + kz * wz) / k;
      const { s, ns } = spread(w);
      const half = Math.sqrt(Math.max(0, (1 + cosT) / 2)); // cos(theta/2)
      const D = ns * Math.pow(half, 2 * s);
      // soft band edges avoid a hard spectral cut (ringing)
      const edge = Math.min(1, (k - kMin) / (0.15 * kMin) + 0.5) * Math.min(1, (kMax - k) / (0.1 * kMax) + 0.5);
      return ((jonswap(w, U, fetch) * dwdk) / k) * D * Math.max(0, edge);
    };
    for (const c of this.cascades) {
      const dk = (2 * Math.PI) / c.L;
      const amp = new Float32Array(N * N);
      let jv = 0;
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const kx = (i - N / 2) * dk,
            kz = (j - N / 2) * dk;
          const e = S2(kx, kz, c.kMin, c.kMax) * dk * dk;
          amp[j * N + i] = Math.sqrt(e / 2);
          jv += (kx * kx + kz * kz) * e;
        }
      c.jVar = jv * this.chop * this.chop;
      const h = c.h0Data,
        n = c.noise;
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const o = j * N + i;
          h[o * 4] = n[o * 2] * amp[o];
          h[o * 4 + 1] = n[o * 2 + 1] * amp[o];
          // conj(h0(-k)): mirrored index
          const mi = (N - i) % N,
            mj = (N - j) % N;
          if (i === 0 || j === 0) {
            h[o * 4 + 2] = 0;
            h[o * 4 + 3] = 0;
          } else {
            const m = mj * N + mi;
            h[o * 4 + 2] = n[m * 2] * amp[m];
            h[o * 4 + 3] = -n[m * 2 + 1] * amp[m];
          }
        }
      c.h0.needsUpdate = true;
    }
  }

  /**
   * Whitecaps from the statistics of the sea instead of a fixed threshold: the surface Jacobian is
   * ~Gaussian around 1, so the level below which a fraction W of the surface lies is 1 - sigma*z(W).
   * W follows Monahan & O'Muircheartaigh (1980): W = 3.84e-6 U^3.41 — nothing below ~3 m/s,
   * scattered white horses at 7 m/s, ~1.5 % of the sea white at 11 m/s.
   * Returns the ocean shader's breaking threshold and ramp; sets this cascade's foam source.
   */
  whitecaps(U: number, gerstnerJVar: number) {
    const W = Math.min(0.08, 3.84e-6 * Math.pow(Math.max(U, 0.5), 3.41));
    const z = (p: number) => {
      // Abramowitz & Stegun 26.2.23: upper-tail quantile of the standard normal
      const t = Math.sqrt(-2 * Math.log(Math.max(p, 1e-9)));
      return t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
    };
    const sa = Math.sqrt(this.cascades[0].jVar);
    const st = Math.sqrt(gerstnerJVar + this.cascades[0].jVar);
    // the short-wave foam that persists (breaking of the chop itself) seeds a fraction of the coverage
    const cu = this.combine.uniforms;
    cu.uFoamBias.value = 1 - sa * z(W * 0.5);
    cu.uFoamGain.value = 1 / Math.max(0.02, 0.5 * sa);
    // active breaking is a fraction of total coverage; the rest is decaying foam
    return { threshold: 1 - st * z(W * 0.45), ramp: 0.6 * st, coverage: W };
  }

  /** textures for the ocean shader */
  slope(i: number) {
    const c = this.cascades[i];
    return c.out[c.cur].textures[0];
  }
  disp(i: number) {
    const c = this.cascades[i];
    return c.out[c.cur].textures[1];
  }

  update(renderer: THREE.WebGLRenderer, time: number, dt: number) {
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    const N = this.N;
    const t = ((time % LOOP) + LOOP) % LOOP;
    const cu = this.combine.uniforms;
    cu.uChop.value = this.chop;
    // foam half-life ~2.5 s: whitecaps fade into streaks, then lace, then nothing
    cu.uDecay.value = Math.exp(-dt / 3.6);
    for (const c of this.cascades) {
      this.evolve.uniforms.uH0.value = c.h0;
      this.evolve.uniforms.uT.value = t;
      this.evolve.uniforms.uL.value = c.L;
      this.quad.material = this.evolve;
      renderer.setRenderTarget(c.ping);
      renderer.render(this.scene, this.cam);
      let src = c.ping,
        dst = c.pong;
      this.quad.material = this.butterfly;
      const bu = this.butterfly.uniforms;
      for (const horiz of [1, 0]) {
        bu.uHoriz.value = horiz;
        for (let sub = 2; sub <= N; sub *= 2) {
          bu.uIn0.value = src.textures[0];
          bu.uIn1.value = src.textures[1];
          bu.uSub.value = sub;
          renderer.setRenderTarget(dst);
          renderer.render(this.scene, this.cam);
          const tmp = src;
          src = dst;
          dst = tmp;
        }
      }
      const prev = c.out[c.cur];
      c.cur ^= 1;
      cu.uIn0.value = src.textures[0];
      cu.uIn1.value = src.textures[1];
      cu.uPrevFoam.value = prev.textures[1];
      this.quad.material = this.combine;
      renderer.setRenderTarget(c.out[c.cur]);
      renderer.render(this.scene, this.cam);
    }
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAuto;
  }

  /** dev: statistics of a cascade's output (height rms, slope rms, Jacobian min / fraction < bias) */
  stats(renderer: THREE.WebGLRenderer, i: number) {
    const c = this.cascades[i];
    const N = this.N;
    const buf = new Uint16Array(N * N * 4);
    const out = { hRms: 0, sRms: 0, jMin: 9, jBelow: 0, foam: 0 };
    renderer.readRenderTargetPixels(c.out[c.cur], 0, 0, N, N, buf, undefined, 1);
    const f = THREE.DataUtils.fromHalfFloat;
    for (let p = 0; p < N * N; p++) {
      const h = f(buf[p * 4 + 1]);
      out.hRms += h * h;
    }
    renderer.readRenderTargetPixels(c.out[c.cur], 0, 0, N, N, buf, undefined, 0);
    for (let p = 0; p < N * N; p++) {
      out.sRms += f(buf[p * 4 + 2]);
      const J = f(buf[p * 4 + 3]);
      out.jMin = Math.min(out.jMin, J);
      if (J < this.combine.uniforms.uFoamBias.value) out.jBelow++;
    }
    out.hRms = Math.sqrt(out.hRms / (N * N));
    out.sRms = Math.sqrt(out.sRms / (N * N));
    out.jBelow /= N * N;
    return out;
  }
}
