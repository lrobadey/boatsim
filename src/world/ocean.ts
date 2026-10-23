import * as THREE from 'three';
import { SEA_ENV_GLSL, WAVES_GLSL, WaveField } from './waves';
import type { SeaStateField } from './seaState';
import type { OceanFFT } from './oceanFFT';
import { FOG_PARS_GLSL, TERRAIN_LIGHT_GLSL, shared } from '../gfx/shared';
import { registerEnvironmentMaterial } from '../gfx/environmentMaterials';

/** Pack the static ripple and noise maps into one WebGL2 array sampler. The noise
 * layer repeats its exact 256² source 2×2 inside the 512² layer; sampling its
 * coordinates at half scale preserves the original normalized repeat period. */
export function packOceanShortWaveTextures(ripple: THREE.Texture, noise: THREE.Texture): THREE.DataArrayTexture {
  const imageOf = (texture: THREE.Texture) => texture.image as { data?: Uint8Array; width?: number; height?: number };
  const ri = imageOf(ripple), ni = imageOf(noise);
  if (ri.width !== 512 || ri.height !== 512 || ni.width !== 256 || ni.height !== 256 || !ri.data || !ni.data) {
    throw new Error('Ocean short-wave textures must be 512² ripple and 256² noise RGBA data textures');
  }
  const layerSize = 512 * 512 * 4;
  const data = new Uint8Array(layerSize * 2);
  data.set(ri.data, 0);
  const noiseOffset = layerSize;
  for (let y = 0; y < 512; y++) {
    const sy = y & 255;
    for (let x = 0; x < 512; x++) {
      const source = (sy * 256 + (x & 255)) * 4;
      const target = noiseOffset + (y * 512 + x) * 4;
      data[target] = ni.data[source];
      data[target + 1] = ni.data[source + 1];
      data[target + 2] = ni.data[source + 2];
      data[target + 3] = ni.data[source + 3];
    }
  }
  const packed = new THREE.DataArrayTexture(data, 512, 512, 2);
  packed.format = THREE.RGBAFormat;
  packed.type = THREE.UnsignedByteType;
  packed.wrapS = packed.wrapT = THREE.RepeatWrapping;
  packed.magFilter = THREE.LinearFilter;
  packed.minFilter = THREE.LinearMipmapLinearFilter;
  packed.generateMipmaps = true;
  packed.anisotropy = ripple.anisotropy || 1;
  packed.needsUpdate = true;
  return packed;
}

/**
 * Ocean surface: camera-centred geometry clipmap. Each level is a square grid of N cells whose cell
 * size doubles per level; levels snap to their own 2x lattice (no swimming), the outer band of each
 * level geomorphs to the next level's tessellation (no cracks), and each level discards fragments
 * covered by the finer level inside it (exact hole, no overlap).
 */
export interface OceanParams {
  grid: number;
  levels: number;
  cell0: number;
}

export class Ocean {
  readonly group = new THREE.Group();
  readonly uniforms: Record<string, THREE.IUniform>;
  private levels: { mesh: THREE.Mesh; cell: number; mat: THREE.ShaderMaterial }[] = [];
  /** Created by Ocean from the caller-owned static ripple/noise maps. */
  private shortWaveTexture: THREE.DataArrayTexture;
  private disposed = false;
  private params: OceanParams;
  private sea: { field: SeaStateField; tex: THREE.DataTexture; version: number } | null = null;

  constructor(
    waves: WaveField,
    private fft: OceanFFT,
    textures: { ripple: THREE.Texture; noise: THREE.Texture; height: THREE.Texture; terrainSize: number },
    params: Partial<OceanParams> = {},
  ) {
    this.params = { grid: 128, levels: 12, cell0: 0.25, ...params };
    const { grid: N } = this.params;

    this.shortWaveTexture = packOceanShortWaveTextures(textures.ripple, textures.noise);
    this.uniforms = {
      uWaveA: { value: waves.packedA },
      uWaveB: { value: waves.packedB },
      uWaveC: { value: waves.packedC },
      // sea state envelope (docs/sea-state-spec.md §7); off until setSeaState
      uSeaOn: { value: 0 },
      uSeaEnv: { value: null },
      uSeaGlobal: { value: new THREE.Vector4(0, 0, 1, 2) },
      uSeaDetail: { value: new THREE.Vector4(0, 0, 0, 0) },
      uSeaDebug: { value: 0 },
      uTime: shared.uTime,
      uSunDir: shared.uSunDir,
      uSunColor: shared.uSunColor,
      uFogEnv: shared.uFogEnv,
      uFogEnvNext: shared.uFogEnvNext,
      uEnvBlend: shared.uEnvBlend,
      uFogDensity: shared.uFogDensity,
      uFogHeight: shared.uFogHeight,
      uFogEnvScale: shared.uFogEnvScale,
      uNight: shared.uNight,
      uHeightTex: shared.uHeightTex,
      uAOTex: shared.uAOTex,
      uSunShadowTex: shared.uSunShadowTex,
      uCloudShadowTex: shared.uCloudShadowTex,
      uCloudShadowParams: shared.uCloudShadowParams,
      uTerrainMax: shared.uTerrainMax,
      uWindDir: shared.uWindDir,
      uWindStrength: shared.uWindStrength,
      uRipple: { value: textures.ripple },
      uNoise: { value: textures.noise },
      uShortWaveTex: { value: this.shortWaveTexture },
      uHeight: { value: textures.height },
      uTerrainSize: { value: textures.terrainSize },
      uRefract: { value: null },
      uRefractDepth: { value: null },
      uScreen: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.1 },
      uFar: { value: 1e5 },
      uFoamMap: { value: null },
      uFoamCenter: { value: new THREE.Vector2() },
      uFoamSize: { value: 600 },
      uOarMap: { value: null },
      uOarCenter: { value: new THREE.Vector2() },
      uOarSize: { value: 96 },
      uSlopeA: { value: fft.slope(0) },
      uSlopeB: { value: fft.slope(1) },
      uDispA: { value: fft.disp(0) },
      uLA: { value: fft.cascades[0].L },
      uWhiteJ: { value: 0.6 },
      uReflect: { value: null },
      uReflMatrix: { value: new THREE.Matrix4() },
      uReflOn: { value: 0 },
      uWhiteRamp: { value: 0.1 },
      uLB: { value: fft.cascades[1].L },
      uTexelA: { value: fft.cascades[0].L / fft.N },
      uShipInv: { value: new THREE.Matrix4() },
      uHullLen: { value: 34 },
      uHullW: { value: new Float32Array(16) },
      uHullOffset: { value: 0 },
      uHullDeck: { value: 2.0 },
    };

    const levelGeo0 = this.makeGrid(N, false);
    const levelGeo = this.makeGrid(N, true);
    for (let l = 0; l < this.params.levels; l++) {
      const cell = this.params.cell0 * Math.pow(2, l);
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          ...THREE.UniformsLib.lights,
          ...this.uniforms,
          uCell: { value: cell },
          uCenter: { value: new THREE.Vector2() },
          uHalf: { value: (N * cell) / 2 },
          uInnerCenter: { value: new THREE.Vector2() },
          uInnerHalf: { value: l === 0 ? -1 : (N * cell) / 4 },
          uLastLevel: { value: l === this.params.levels - 1 ? 1 : 0 },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        lights: true,
        side: THREE.FrontSide,
      });
      const mesh = new THREE.Mesh(l === 0 ? levelGeo0 : levelGeo, mat);
      registerEnvironmentMaterial(mat);
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.renderOrder = 10 + l; // near levels first (early-z)
      this.group.add(mesh);
      this.levels.push({ mesh, cell, mat });
    }
  }

  /** Release Ocean-owned GPU data; source ripple/noise textures and OceanFFT stay caller-owned. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.shortWaveTexture.dispose();
    this.sea?.tex.dispose();
    const geometries = new Set<THREE.BufferGeometry>();
    for (const { mesh, mat } of this.levels) {
      geometries.add(mesh.geometry);
      mat.dispose();
    }
    for (const geometry of geometries) geometry.dispose();
    this.levels.length = 0;
    this.group.clear();
  }

  /** Upload the packed transition-only array before the first blend needs its sampler. */
  prepareEnvironmentTextures(renderer: THREE.WebGLRenderer) {
    renderer.initTexture(this.shortWaveTexture);
  }

  /** grid in integer cell coordinates [-N/2, N/2]; optional hole where the finer level lives */
  private makeGrid(N: number, hole: boolean) {
    const h = N / 2;
    const holeR = N / 4 - 1;
    const pos: number[] = [];
    const idx: number[] = [];
    const vid = new Map<number, number>();
    const v = (i: number, j: number) => {
      const key = (i + h) * (N + 1) + (j + h);
      let id = vid.get(key);
      if (id === undefined) {
        id = pos.length / 3;
        pos.push(i, 0, j);
        vid.set(key, id);
      }
      return id;
    };
    for (let j = -h; j < h; j++)
      for (let i = -h; i < h; i++) {
        if (hole && i >= -holeR && i + 1 <= holeR && j >= -holeR && j + 1 <= holeR) continue;
        const a = v(i, j),
          b = v(i + 1, j),
          c = v(i, j + 1),
          d = v(i + 1, j + 1);
        // diagonal orientation consistent with the coarser level after morphing
        if (((i + j) & 1) === 0) idx.push(a, c, d, a, d, b);
        else idx.push(a, c, b, b, c, d);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    return g;
  }

  /**
   * Bind the sea state envelope: the field's own Float32 arrays become the textures the vertex shader
   * reads with texelFetch, so the GPU and the CPU sample the same bytes.
   */
  setSeaState(field: SeaStateField) {
    const tex = new THREE.DataTexture(field.data, field.atlasWidth, 2 * field.n, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.sea = { field, tex, version: field.version };
    const g = field.global;
    this.uniforms.uSeaEnv.value = tex;
    (this.uniforms.uSeaGlobal.value as THREE.Vector4).set(g.originX, g.originZ, g.cell, g.n);
    this.uniforms.uSeaOn.value = 1;
  }

  update(camera: THREE.Camera) {
    if (this.sea) {
      const s = this.sea;
      if (s.version !== s.field.version) {
        s.version = s.field.version;
        s.tex.needsUpdate = true;
      }
      // one detail slot: the region nearest the camera
      let best = -1, bestD = Infinity;
      s.field.details.forEach((m, k) => {
        const half = (m.n * m.cell) / 2;
        const d = Math.hypot(camera.position.x - (m.originX + half), camera.position.z - (m.originZ + half));
        if (d < bestD) { bestD = d; best = k; }
      });
      const det = this.uniforms.uSeaDetail.value as THREE.Vector4;
      if (best < 0) det.set(0, 0, 0, 0);
      else {
        const m = s.field.details[best];
        det.set(m.originX, m.originZ, m.cell, (best + 1) * s.field.n);
      }
    }
    // FFT outputs ping-pong (persistent foam reads last frame's)
    this.uniforms.uSlopeA.value = this.fft.slope(0);
    this.uniforms.uSlopeB.value = this.fft.slope(1);
    this.uniforms.uDispA.value = this.fft.disp(0);
    const cx = camera.position.x,
      cz = camera.position.z;
    // camera height pushes the fine levels out: skip levels that would be sub-pixel
    let prevCenter: THREE.Vector2 | null = null;
    for (let l = 0; l < this.levels.length; l++) {
      const L = this.levels[l];
      const snap = L.cell * 2;
      const c = L.mat.uniforms.uCenter.value as THREE.Vector2;
      c.set(Math.round(cx / snap) * snap, Math.round(cz / snap) * snap);
      if (prevCenter) (L.mat.uniforms.uInnerCenter.value as THREE.Vector2).copy(prevCenter);
      prevCenter = c;
    }
  }

  setRefraction(color: THREE.Texture, depth: THREE.Texture, w: number, h: number, near: number, far: number) {
    this.uniforms.uRefract.value = color;
    this.uniforms.uRefractDepth.value = depth;
    (this.uniforms.uScreen.value as THREE.Vector2).set(w, h);
    this.uniforms.uNear.value = near;
    this.uniforms.uFar.value = far;
  }
}

const VERT = /* glsl */ `
#include <shadowmap_pars_vertex>
${WAVES_GLSL}
${SEA_ENV_GLSL}
uniform float uCell;
uniform sampler2D uDispA;
uniform float uLA;
uniform float uTexelA;
uniform vec2 uCenter;
uniform float uHalf;
varying vec3 vWorld;
varying vec2 vGrid;
varying vec3 vN;
varying float vJ;
varying float vWaveH;
varying float vViewDepth;
varying vec4 vEnv0;
varying vec2 vEnv1;
void main() {
  vec2 local = position.xz * uCell;
  vec2 p = uCenter + local;
  // geomorph the outer band to the next level's lattice
  float cheb = max(abs(local.x), abs(local.y)) / uHalf;
  float m = clamp((cheb - 0.70) / 0.22, 0.0, 1.0);
  vec2 odd = mod(position.xz, 2.0);
  p -= odd * uCell * m;
  vGrid = p;
  float dist = length(vec3(p.x - cameraPosition.x, cameraPosition.y, p.y - cameraPosition.z));
  // sea state envelope at the undisplaced point (same texels and arithmetic as the CPU buoyancy)
  vec4 env0, env1;
  seaEnv(p, env0, env1);
  vEnv0 = env0;
  vEnv1 = env1.xy;
  vec3 N; float J;
  vec3 d = gerstner(p, dist, env0, N, J);
  // short-wave chop from the FFT cascade, prefiltered to this level's vertex spacing
  float fadeA = (1.0 - smoothstep(250.0, 900.0, dist)) * env1.x;
  if (fadeA > 0.0) d += textureLod(uDispA, p / uLA, max(0.0, log2(uCell / uTexelA))).xyz * fadeA;
  vec3 wp = vec3(p.x + d.x, d.y, p.y + d.z);
  vWorld = wp;
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  // The ocean displaces vertices itself, so shadow coordinates must use the final wave position.
  vec4 shadowWorldPosition = modelMatrix * vec4(wp, 1.0);
  for (int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i++) {
    vec4 biasedPosition = shadowWorldPosition + vec4(0.0, directionalLightShadows[i].shadowNormalBias, 0.0, 0.0);
    vDirectionalShadowCoord[i] = directionalShadowMatrix[i] * biasedPosition;
  }
#endif
  vN = N;
  vJ = J;
  vWaveH = d.y;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vViewDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <packing>
#include <shadowmap_pars_fragment>
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
// The vertex stage's light matrix, also needed here to shadow points beneath the surface.
uniform mat4 directionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];
#endif
${FOG_PARS_GLSL}
${TERRAIN_LIGHT_GLSL}
${WAVES_GLSL}
uniform float uNight;
uniform vec2 uWindDir;
uniform float uWindStrength;
#if SKY_ENV_BLEND
uniform highp sampler2DArray uShortWaveTex;
#else
uniform sampler2D uRipple;
uniform sampler2D uNoise;
#endif
uniform sampler2D uHeight;
uniform sampler2D uRefract;
uniform sampler2D uRefractDepth;
uniform vec2 uScreen;
uniform float uNear;
uniform float uFar;
uniform sampler2D uSlopeA;
uniform sampler2D uSlopeB;
// the FFT displacement texture (also bound to the vertex stage: one unit) carries the persistent foam in .w
uniform sampler2D uDispA;
uniform float uLA;
uniform float uLB;
uniform float uWhiteJ;
uniform sampler2D uReflect;
uniform mat4 uReflMatrix;
uniform float uReflOn;
uniform float uWhiteRamp;
uniform sampler2D uFoamMap;
uniform vec2 uFoamCenter;
uniform float uFoamSize;
uniform sampler2D uOarMap;
uniform vec2 uOarCenter;
uniform float uOarSize;
uniform vec2 uInnerCenter;
uniform float uInnerHalf;
uniform float uLastLevel;
uniform mat4 uShipInv;
uniform float uHullLen;
uniform float uHullW[16];
uniform float uHullOffset;
uniform float uHullDeck;
varying vec3 vWorld;
varying vec2 vGrid;
varying vec3 vN;
varying float vJ;
varying float vWaveH;
varying float vViewDepth;
varying vec4 vEnv0; // sea state: swell, long, mid, short
varying vec2 vEnv1; // sea state: FFT cascade A envelope, wind shelter
uniform float uSeaDebug;

float hullHalfWidth(float z) {
  // z: ship local (bow at -L/2). sample the 16-entry table
  float s = clamp(z / uHullLen + 0.5, 0.0, 1.0) * 15.0;
  int i = int(floor(s));
  int j = min(i + 1, 15);
  float f = s - float(i);
  float a = 0.0, b = 0.0;
  for (int k = 0; k < 16; k++) { if (k == i) a = uHullW[k]; if (k == j) b = uHullW[k]; }
  return mix(a, b, f);
}

vec4 sampleOceanNoise(vec2 uv) {
#if SKY_ENV_BLEND
  // Noise source is 256², duplicated 2×2 in the array layer. Half-scale UVs
  // retain the old period; explicit isotropic LOD matches its former aniso=1.
  vec2 dx = dFdx(uv * 256.0), dy = dFdy(uv * 256.0);
  float lod = max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy))));
  return textureLod(uShortWaveTex, vec3(uv * 0.5, 1.0), lod);
#else
  return texture2D(uNoise, uv);
#endif
}
vec2 sampleOceanRipple(vec2 uv) {
#if SKY_ENV_BLEND
  return texture(uShortWaveTex, vec3(uv, 0.0)).xy;
#else
  return texture2D(uRipple, uv).xy;
#endif
}
void main() {
  // exact hole where the finer level renders
  if (uInnerHalf > 0.0) {
    vec2 q = abs(vGrid - uInnerCenter);
    if (q.x < uInnerHalf && q.y < uInnerHalf) discard;
  }
  // keep the sea out of the hull
  vec3 lp = (uShipInv * vec4(vWorld, 1.0)).xyz;
  if (abs(lp.z) < uHullLen * 0.5 && lp.y < uHullDeck) {
    if (abs(abs(lp.x) - uHullOffset) < hullHalfWidth(lp.z) - 0.05) discard;
  }

  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;

  // ---- normal: Gerstner swell + FFT short waves + far macro variation ----
  vec2 wd = normalize(uWindDir + 1e-4);
  // cat's paws: gust patches drifting downwind roughen the short waves and ripples
  float gust = sampleOceanNoise(vWorld.xz / 420.0 - wd * uTime * 0.011).r;
  gust += 0.35 * (sampleOceanNoise(vWorld.xz / 110.0 - wd * uTime * 0.028).g - 0.5);
  gust = smoothstep(0.28, 0.78, gust);
  vec2 r4 = sampleOceanRipple(vWorld.xz / 61.0 + wd * uTime * 0.016) * 2.0 - 1.0;
  vec2 r3 = sampleOceanRipple(vWorld.xz / 1.9 + wd * uTime * 0.092) * 2.0 - 1.0;
  float f2 = 1.0 - smoothstep(60.0, 500.0, dist);
  float f4 = 1.0 - smoothstep(1500.0, 6000.0, dist);

  // wake foam / turbulence map
  vec2 fd = (vWorld.xz - uFoamCenter) / uFoamSize;
  vec2 fuv = vec2(fd.x, -fd.y) + 0.5; // ortho foam camera: up = -z
  vec2 wake = vec2(0.0);
  if (all(greaterThan(fuv, vec2(0.0))) && all(lessThan(fuv, vec2(1.0)))) wake = texture2D(uFoamMap, fuv).rg;
  // oar disturbance: ripple and puddle slopes (rg), entrained air (b), glassy slick (a)
  vec4 oar = vec4(0.0);
  if (dist < 400.0) {
    vec2 od = (vWorld.xz - uOarCenter) / uOarSize;
    vec2 ouv = vec2(od.x, -od.y) + 0.5;
    vec2 oe = smoothstep(vec2(0.0), vec2(0.06), ouv) * smoothstep(vec2(1.0), vec2(0.94), ouv);
    if (oe.x * oe.y > 0.0) oar = texture2D(uOarMap, ouv) * (oe.x * oe.y) * (1.0 - smoothstep(150.0, 400.0, dist));
  }
  float slick = clamp(max(wake.g, oar.a), 0.0, 1.0);

  // FFT cascades are sampled at the undisplaced (Lagrangian) position so short waves ride the swell.
  // Their mip chain carries mean slope AND mean squared slope: the difference is the slope variance
  // hidden inside this pixel, which becomes microfacet roughness below.
  vec2 uvA = vGrid / uLA, uvB = vGrid / uLB;
  vec4 sA = texture2D(uSlopeA, uvA);
  vec4 sB = texture2D(uSlopeB, uvB);
  // sea state: the 1-11 m chop follows the local envelope, the ripples the local (sheltered) wind
  float gA = mix(0.8, 1.15, gust) * (1.0 - 0.45 * slick) * vEnv1.x;
  // the wake's turbulence flattens the ripples into a glassy slick
  float gB = mix(0.3, 1.3, gust) * (1.0 - 0.85 * slick) * vEnv1.y;
  vec2 dS = sA.xy * gA + sB.xy * gB;
  // slope textures carry (sx, sz, sx^2 + sz^2, J): the filtered total variance hidden in this pixel
  float varS = max(sA.z - dot(sA.xy, sA.xy), 0.0) * gA * gA + max(sB.z - dot(sB.xy, sB.xy), 0.0) * gB * gB;
  dS += r4 * 0.05 * f4 * (0.6 + 0.4 * gust);
  dS += r3 * 0.06 * clamp(wake.r, 0.0, 1.0) * f2; // churned surface right in the foam
  // oar ripples and puddles bend the real surface: reflections and refraction wobble through them
  dS += clamp(oar.xy, -0.6, 0.6);
  varS += 2.0 * (0.25 * dot(oar.xy, oar.xy) + 0.004 * clamp(oar.b, 0.0, 1.0));

  // Gerstner normal & Jacobian evaluated per pixel at the undisplaced position: identical across
  // clipmap levels (no seams) and sharper than per-vertex interpolation
  vec3 gN; float gJ;
  gerstner(vGrid, dist, vEnv0, gN, gJ);
  vec2 gS = -gN.xz / max(gN.y, 0.2);
  vec3 N = normalize(vec3(-(gS.x + dS.x), 1.0, -(gS.y + dS.y)));
  float slopeVar = varS + gLostVar;
  // far away, flatten normals toward the mean (reduces sparkle aliasing & grazing-angle darkness)
  N = normalize(mix(N, vec3(0.0, 1.0, 0.0), smoothstep(3000.0, 25000.0, dist) * 0.85));

  float NdotV = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);

  // ---- reflection (sky environment) ----
  vec3 R = reflect(-V, N);
  R.y = abs(R.y) * 0.9 + 0.02;
  // unresolved slope variance blurs the reflection (cube texel ~0.006 rad at lod 0)
  float lod = clamp(log2(1.0 + 330.0 * sqrt(slopeVar)), 0.0, 6.0);
  vec3 sky = sampleSkyEnv(R, lod);
  // planar reflection of the world (islands, hull, sail, lights) over the sky reflection; the wave
  // normal displaces it (more for near water) and slope variance blurs it via the mip chain
  if (uReflOn > 0.5) {
    vec4 rp = uReflMatrix * vec4(vWorld.x, 0.0, vWorld.z, 1.0);
    vec2 ruvR = rp.xy / rp.w + N.xz * mix(0.05, 0.012, smoothstep(10.0, 600.0, dist)) * vec2(1.0, 0.6);
    float edgeR = smoothstep(0.0, 0.03, ruvR.x) * smoothstep(1.0, 0.97, ruvR.x) * smoothstep(0.0, 0.03, ruvR.y) * smoothstep(1.0, 0.97, ruvR.y);
    // rough water stretches reflections vertically into streaks: smear along screen-y by the
    // unresolved slope (glancing views of a wavy surface see a tall band of mirror directions)
    float smear = clamp(sqrt(slopeVar) * 0.22 + 0.004, 0.0, 0.06);
    float lodR = max(lod - 1.0, 0.0);
    vec4 pr = vec4(0.0);
    for (int k = 0; k < 4; k++) {
      float o = (float(k) - 1.0) * smear;
      pr += textureLod(uReflect, clamp(ruvR + vec2(0.0, o), 0.001, 0.999), lodR);
    }
    pr *= 0.25;
    sky = mix(sky, pr.rgb / max(pr.a, 1e-3), clamp(pr.a, 0.0, 1.0) * edgeR);
  }

  // sun / moon glitter: GGX, roughness grows with distance (sub-pixel waves)
  vec3 L = normalize(uSunDir);
  vec3 H = normalize(L + V);
  // GGX alpha^2 ~ total unresolved mean-square slope (plus a floor for the capillary scale)
  float a2 = 0.0012 + slopeVar;
  float NdotH = max(dot(N, H), 0.0);
  float dd = NdotH * NdotH * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159 * dd * dd);
  float NdotL = max(dot(N, L), 0.0);
  float Fs = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
  float terrainVis = terrainShadow(vWorld, L);
  float sunVis = terrainVis;
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  // Three.js supplies the active directional light's map, matrix and filtering settings.
  sunVis *= getShadow(directionalShadowMap[0], directionalLightShadows[0].shadowMapSize,
    directionalLightShadows[0].shadowIntensity, directionalLightShadows[0].shadowBias,
    directionalLightShadows[0].shadowRadius, vDirectionalShadowCoord[0]);
#endif
  // Height-correlated Smith visibility; the outgoing radiance includes NdotL exactly once.
  float gV = NdotL * sqrt(a2 + (1.0 - a2) * NdotV * NdotV);
  float gL = NdotV * sqrt(a2 + (1.0 - a2) * NdotL * NdotL);
  float ggxVis = 0.5 / max(gV + gL, 1e-4);
  vec3 spec = sunVis * uSunColor * min(D * Fs * ggxVis * NdotL, 60.0);

  // ---- refraction & absorption ----
  vec2 suv = gl_FragCoord.xy / uScreen;
  float distort = 0.035 * (1.0 - smoothstep(10.0, 400.0, dist));
  vec2 ruv = clamp(suv + N.xz * distort, 0.001, 0.999);
  float sceneZ = -perspectiveDepthToViewZ(texture2D(uRefractDepth, ruv).r, uNear, uFar);
  if (sceneZ < vViewDepth) { ruv = suv; sceneZ = -perspectiveDepthToViewZ(texture2D(uRefractDepth, suv).r, uNear, uFar); }
  vec3 sceneCol = texture2D(uRefract, ruv).rgb;
  float thick = max(sceneZ - vViewDepth, 0.0) * dist / max(vViewDepth, 1e-3);
  // vertical depth from the terrain heightmap (precise far away)
  vec2 tuv = vWorld.xz / uTerrainSize + 0.5;
  float ground = -60.0;
  if (all(greaterThan(tuv, vec2(0.0))) && all(lessThan(tuv, vec2(1.0)))) ground = texture2D(uHeight, tuv).r;
  float depthV = max(vWorld.y - ground, 0.0);
  float thickT = depthV / max(V.y, 0.08) * 1.2;
  thick = min(thick, thickT + 0.5);

  // Sunlight scattered back up comes from metres down the refracted view ray, not from the
  // surface point. Shadow each depth where its own sunlight entered the surface, weighted by
  // its share of the in-scatter (extinction ~0.06/m: segments 0-2.5, -7, -16, beyond).
  // A sail's shadow then shows as the soft, partial darkening clear deep water really has,
  // not a hard-edged dark copy of the sail.
  float columnVis = sunVis;
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  if (dist < 400.0) {
    vec3 viewIn = refract(-V, N, 0.75);
    vec3 sunIn = -refract(-L, vec3(0.0, 1.0, 0.0), 0.75);
    vec4 depthT = vec4(1.0, 4.0, 10.0, 22.0);
    vec4 weight = vec4(0.139, 0.204, 0.274, 0.383);
    float vis = 0.0;
    for (int k = 0; k < 4; k++) {
      vec3 p = vWorld + viewIn * min(depthT[k], thick);
      vec3 entry = p + sunIn * ((vWorld.y - p.y) / max(sunIn.y, 0.05));
      vec4 coord = directionalShadowMatrix[0] *
        vec4(entry + vec3(0.0, directionalLightShadows[0].shadowNormalBias, 0.0), 1.0);
      vis += weight[k] * getShadow(directionalShadowMap[0], directionalLightShadows[0].shadowMapSize,
        directionalLightShadows[0].shadowIntensity, directionalLightShadows[0].shadowBias,
        directionalLightShadows[0].shadowRadius, coord);
    }
    columnVis = terrainVis * vis;
  }
#endif

  vec3 sigma = vec3(0.34, 0.075, 0.042);            // absorption+scatter extinction (1/m), clear Aegean
  vec3 T = exp(-sigma * thick);
  // light available under water
  vec3 skyIrr = sampleSkyEnv(vec3(0.0, 1.0, 0.0), 5.0);
  vec3 light = uSunColor * max(L.y, 0.0) * 0.55 * columnVis + skyIrr * 1.1;
  vec3 scatterCol = vec3(0.012, 0.075, 0.105);
  vec3 inscatter = scatterCol * light * (1.0 - T);
  // aerated water (wake) glows turquoise
  inscatter += vec3(0.04, 0.15, 0.15) * light * clamp(wake.g, 0.0, 1.0) * 0.12;
  // the bubble cloud under an oar's boil scatters light back up: pale turquoise under the foam
  float oarAir = 1.0 - exp(-1.3 * max(oar.b, 0.0)); // overlapping boils saturate, never a white sheet
  inscatter += vec3(0.06, 0.2, 0.19) * light * oarAir * 0.35;
  vec3 refr = sceneCol * T + inscatter;
  // and veils what lies beneath it (the submerged blade fades into its own boil)
  refr = mix(refr, scatterCol * light * 2.2 + vec3(0.05, 0.16, 0.16) * light * 0.4, clamp(oarAir * 0.55, 0.0, 0.7));

  // subsurface: light through backlit wave crests
  float sssDot = pow(max(dot(V, -normalize(L + N * 0.6)), 0.0), 4.0);
  float crest = clamp(vWaveH * 0.8 + 0.3, 0.0, 1.5);
  refr += vec3(0.04, 0.22, 0.2) * uSunColor * sssDot * crest * 0.35 * (1.0 - uNight) * sunVis;

  vec3 col = mix(refr, sky, F) + spec;

  // ---- foam ----
  vec2 fp = vWorld.xz;
  float fn = sampleOceanNoise(fp * 0.045 + uTime * 0.004).r * 0.6 + sampleOceanNoise(fp * 0.18 - uTime * 0.01).g * 0.4;
  // whitecaps: break where the combined surface compresses (Jacobians compose multiplicatively);
  // the FFT's persistent foam then trails off the crests as streaks that fray and fade
  float fadeF = 1.0 - smoothstep(300.0, 2500.0, dist);
  // persistent foam from the displacement texture, the compression Jacobian from the slope sample above
  vec2 foamJacobian = vec2(texture2D(uDispA, uvA).w, sA.w);
  float JA = mix(1.0, 1.0 + vEnv1.x * (foamJacobian.g - 1.0), fadeF);
  float Jt = gJ * JA;
  float trail = foamJacobian.r * fadeF * vEnv1.x * vEnv1.x;
  // threshold set from the sea's statistics (see OceanFFT.whitecaps); gusts push more crests over
  float wj = uWhiteJ + (gust - 0.5) * uWhiteRamp;
  float crestSrc = smoothstep(wj + uWhiteRamp * 0.5, wj - uWhiteRamp, Jt) + trail * smoothstep(1.1, 0.85, gJ);
  float band = 0.5 + 0.5 * sin(depthV * 4.0 - uTime * 1.6 + fn * 6.0);
  float shoreFoam = (1.0 - smoothstep(0.0, 1.8, depthV)) * smoothstep(0.3, 0.7, fn * 0.7 + band * 0.5);
  shoreFoam += (1.0 - smoothstep(0.0, 0.35, depthV)) * 0.8;
  // wake foam as coverage of a lace pattern: dense foam covers solidly, thin foam survives only as
  // filaments and bubbles, so the wake frays naturally as it ages
  float wf = clamp(wake.r + oarAir * 0.85, 0.0, 2.0);
  float lace = sampleOceanNoise(fp * 0.13 + uTime * 0.006).b * 0.55 + sampleOceanNoise(fp * 0.41 - uTime * 0.01).a * 0.3 + sampleOceanNoise(fp * 1.3).r * 0.15;
  lace = clamp((lace - 0.5) * 2.4 + 0.5, 0.0, 1.0); // the octave sum clusters near 0.5: restore contrast
  float wakeFoam = clamp((wf * 1.05 - (1.0 - lace)) * 3.5, 0.0, 1.0) * 0.95;
  float crestFoam = clamp((crestSrc * 1.1 - (1.0 - lace)) * 3.0, 0.0, 1.0);
  float foam = clamp(max(max(crestFoam * 0.9, shoreFoam), wakeFoam), 0.0, 1.0);
  foam *= 1.0 - smoothstep(1500.0, 5000.0, dist) * 0.7;
  vec3 foamCol = uSunColor * (max(L.y, 0.0) * 0.28 + 0.05) * sunVis + skyIrr * 0.9;
  // foam is bubbly, not flat paint: shade by the lace so dense patches still read as texture
  foamCol *= 0.78 + 0.35 * lace;
  col = mix(col, foamCol, foam * 0.9);
  // dev view (?debug=seastate): blue = calm, red = exposed
  if (uSeaDebug > 0.5) col = mix(col, mix(vec3(0.05, 0.25, 1.0), vec3(1.0, 0.15, 0.05), clamp(dot(vEnv0, vec4(0.25)), 0.0, 1.0)), 0.55);

  col = applyAerial(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
}
`;
