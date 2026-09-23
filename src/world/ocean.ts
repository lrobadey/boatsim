import * as THREE from 'three';
import { WAVES_GLSL, WaveField } from './waves';
import type { OceanFFT } from './oceanFFT';
import { FOG_PARS_GLSL, TERRAIN_LIGHT_GLSL, shared } from '../gfx/shared';

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
  private params: OceanParams;

  constructor(
    waves: WaveField,
    private fft: OceanFFT,
    textures: { ripple: THREE.Texture; noise: THREE.Texture; height: THREE.Texture; terrainSize: number },
    params: Partial<OceanParams> = {},
  ) {
    this.params = { grid: 128, levels: 12, cell0: 0.25, ...params };
    const { grid: N } = this.params;

    this.uniforms = {
      uWaveA: { value: waves.packedA },
      uWaveB: { value: waves.packedB },
      uTime: shared.uTime,
      uSunDir: shared.uSunDir,
      uSunColor: shared.uSunColor,
      uFogEnv: shared.uFogEnv,
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
      uSlopeA: { value: fft.slope(0) },
      uSlopeB: { value: fft.slope(1) },
      uDispA: { value: fft.disp(0) },
      uFoamA: { value: fft.foam(0) },
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
      uHullDeck: { value: 2.0 },
    };

    const levelGeo0 = this.makeGrid(N, false);
    const levelGeo = this.makeGrid(N, true);
    for (let l = 0; l < this.params.levels; l++) {
      const cell = this.params.cell0 * Math.pow(2, l);
      const mat = new THREE.ShaderMaterial({
        uniforms: {
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
        side: THREE.FrontSide,
      });
      const mesh = new THREE.Mesh(l === 0 ? levelGeo0 : levelGeo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 10 + l; // near levels first (early-z)
      this.group.add(mesh);
      this.levels.push({ mesh, cell, mat });
    }
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

  update(camera: THREE.Camera) {
    // FFT outputs ping-pong (persistent foam reads last frame's)
    this.uniforms.uSlopeA.value = this.fft.slope(0);
    this.uniforms.uSlopeB.value = this.fft.slope(1);
    this.uniforms.uDispA.value = this.fft.disp(0);
    this.uniforms.uFoamA.value = this.fft.foam(0);
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
${WAVES_GLSL}
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
  vec3 N; float J;
  vec3 d = gerstner(p, dist, N, J);
  // short-wave chop from the FFT cascade, prefiltered to this level's vertex spacing
  float fadeA = 1.0 - smoothstep(250.0, 900.0, dist);
  if (fadeA > 0.0) d += textureLod(uDispA, p / uLA, max(0.0, log2(uCell / uTexelA))).xyz * fadeA;
  vec3 wp = vec3(p.x + d.x, d.y, p.y + d.z);
  vWorld = wp;
  vN = N;
  vJ = J;
  vWaveH = d.y;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vViewDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
#include <packing>
${FOG_PARS_GLSL}
${TERRAIN_LIGHT_GLSL}
${WAVES_GLSL}
uniform float uNight;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform sampler2D uRipple;
uniform sampler2D uNoise;
uniform sampler2D uHeight;
uniform sampler2D uRefract;
uniform sampler2D uRefractDepth;
uniform vec2 uScreen;
uniform float uNear;
uniform float uFar;
uniform sampler2D uSlopeA;
uniform sampler2D uSlopeB;
uniform sampler2D uDispA;
uniform sampler2D uFoamA;
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
uniform vec2 uInnerCenter;
uniform float uInnerHalf;
uniform float uLastLevel;
uniform mat4 uShipInv;
uniform float uHullLen;
uniform float uHullW[16];
uniform float uHullDeck;
varying vec3 vWorld;
varying vec2 vGrid;
varying vec3 vN;
varying float vJ;
varying float vWaveH;
varying float vViewDepth;

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

void main() {
  // exact hole where the finer level renders
  if (uInnerHalf > 0.0) {
    vec2 q = abs(vGrid - uInnerCenter);
    if (q.x < uInnerHalf && q.y < uInnerHalf) discard;
  }
  // keep the sea out of the hull
  vec3 lp = (uShipInv * vec4(vWorld, 1.0)).xyz;
  if (abs(lp.z) < uHullLen * 0.5 && lp.y < uHullDeck) {
    if (abs(lp.x) < hullHalfWidth(lp.z) - 0.05) discard;
  }

  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;

  // ---- normal: Gerstner swell + FFT short waves + far macro variation ----
  vec2 wd = normalize(uWindDir + 1e-4);
  // cat's paws: gust patches drifting downwind roughen the short waves and ripples
  float gust = texture2D(uNoise, vWorld.xz / 420.0 - wd * uTime * 0.011).r;
  gust += 0.35 * (texture2D(uNoise, vWorld.xz / 110.0 - wd * uTime * 0.028).g - 0.5);
  gust = smoothstep(0.28, 0.78, gust);
  vec2 r4 = texture2D(uRipple, vWorld.xz / 61.0 + wd * uTime * 0.016).xy * 2.0 - 1.0;
  vec2 r3 = texture2D(uRipple, vWorld.xz / 1.9 + wd * uTime * 0.092).xy * 2.0 - 1.0;
  float f2 = 1.0 - smoothstep(60.0, 500.0, dist);
  float f4 = 1.0 - smoothstep(1500.0, 6000.0, dist);

  // wake foam / turbulence map
  vec2 fd = (vWorld.xz - uFoamCenter) / uFoamSize;
  vec2 fuv = vec2(fd.x, -fd.y) + 0.5; // ortho foam camera: up = -z
  vec2 wake = vec2(0.0);
  if (all(greaterThan(fuv, vec2(0.0))) && all(lessThan(fuv, vec2(1.0)))) wake = texture2D(uFoamMap, fuv).rg;
  float slick = clamp(wake.g, 0.0, 1.0);

  // FFT cascades are sampled at the undisplaced (Lagrangian) position so short waves ride the swell.
  // Their mip chain carries mean slope AND mean squared slope: the difference is the slope variance
  // hidden inside this pixel, which becomes microfacet roughness below.
  vec2 uvA = vGrid / uLA, uvB = vGrid / uLB;
  vec4 sA = texture2D(uSlopeA, uvA);
  vec4 sB = texture2D(uSlopeB, uvB);
  float gA = mix(0.8, 1.15, gust) * (1.0 - 0.45 * slick);
  // the wake's turbulence flattens the ripples into a glassy slick
  float gB = mix(0.3, 1.3, gust) * (1.0 - 0.85 * slick);
  vec2 dS = sA.xy * gA + sB.xy * gB;
  vec2 varS = max(sA.zw - sA.xy * sA.xy, 0.0) * gA * gA + max(sB.zw - sB.xy * sB.xy, 0.0) * gB * gB;
  dS += r4 * 0.05 * f4 * (0.6 + 0.4 * gust);
  dS += r3 * 0.06 * clamp(wake.r, 0.0, 1.0) * f2; // churned surface right in the foam

  // Gerstner normal & Jacobian evaluated per pixel at the undisplaced position: identical across
  // clipmap levels (no seams) and sharper than per-vertex interpolation
  vec3 gN; float gJ;
  gerstner(vGrid, dist, gN, gJ);
  vec2 gS = -gN.xz / max(gN.y, 0.2);
  vec3 N = normalize(vec3(-(gS.x + dS.x), 1.0, -(gS.y + dS.y)));
  float slopeVar = varS.x + varS.y + gLostVar;
  // far away, flatten normals toward the mean (reduces sparkle aliasing & grazing-angle darkness)
  N = normalize(mix(N, vec3(0.0, 1.0, 0.0), smoothstep(3000.0, 25000.0, dist) * 0.85));

  float NdotV = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);

  // ---- reflection (sky environment) ----
  vec3 R = reflect(-V, N);
  R.y = abs(R.y) * 0.9 + 0.02;
  // unresolved slope variance blurs the reflection (cube texel ~0.006 rad at lod 0)
  float lod = clamp(log2(1.0 + 330.0 * sqrt(slopeVar)), 0.0, 6.0);
  vec3 sky = textureLod(uFogEnv, R, lod).rgb;
  // planar reflection of the world (islands, hull, sail, lights) over the sky reflection; the wave
  // normal displaces it (more for near water) and slope variance blurs it via the mip chain
  if (uReflOn > 0.5) {
    vec4 rp = uReflMatrix * vec4(vWorld.x, 0.0, vWorld.z, 1.0);
    vec2 ruvR = rp.xy / rp.w + N.xz * mix(0.05, 0.012, smoothstep(10.0, 600.0, dist)) * vec2(1.0, 0.6);
    float edgeR = smoothstep(0.0, 0.03, ruvR.x) * smoothstep(1.0, 0.97, ruvR.x) * smoothstep(0.0, 0.03, ruvR.y) * smoothstep(1.0, 0.97, ruvR.y);
    vec4 pr = textureLod(uReflect, clamp(ruvR, 0.001, 0.999), max(lod - 0.5, 0.0));
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
  float sunVis = terrainShadow(vWorld, L);
  vec3 spec = sunVis * uSunColor * min(D * Fs * NdotL / (4.0 * max(NdotV, 0.15) * max(NdotL, 0.15)), 60.0) * NdotL;

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

  vec3 sigma = vec3(0.34, 0.075, 0.042);            // absorption+scatter extinction (1/m), clear Aegean
  vec3 T = exp(-sigma * thick);
  // light available under water
  vec3 skyIrr = textureLod(uFogEnv, vec3(0.0, 1.0, 0.0), 5.0).rgb;
  vec3 light = uSunColor * max(L.y, 0.0) * 0.55 * sunVis + skyIrr * 1.1;
  vec3 scatterCol = vec3(0.012, 0.075, 0.105);
  vec3 inscatter = scatterCol * light * (1.0 - T);
  // aerated water (wake) glows turquoise
  inscatter += vec3(0.04, 0.15, 0.15) * light * clamp(wake.g, 0.0, 1.0) * 0.12;
  vec3 refr = sceneCol * T + inscatter;

  // subsurface: light through backlit wave crests
  float sssDot = pow(max(dot(V, -normalize(L + N * 0.6)), 0.0), 4.0);
  float crest = clamp(vWaveH * 0.8 + 0.3, 0.0, 1.5);
  refr += vec3(0.04, 0.22, 0.2) * uSunColor * sssDot * crest * 0.35 * (1.0 - uNight) * sunVis;

  vec3 col = mix(refr, sky, F) + spec;

  // ---- foam ----
  vec2 fp = vWorld.xz;
  float fn = texture2D(uNoise, fp * 0.045 + uTime * 0.004).r * 0.6 + texture2D(uNoise, fp * 0.18 - uTime * 0.01).g * 0.4;
  // whitecaps: break where the combined surface compresses (Jacobians compose multiplicatively);
  // the FFT's persistent foam then trails off the crests as streaks that fray and fade
  float fadeF = 1.0 - smoothstep(300.0, 2500.0, dist);
  float JA = mix(1.0, texture2D(uDispA, uvA).w, fadeF);
  float Jt = gJ * JA;
  float trail = texture2D(uFoamA, uvA).r * fadeF;
  // threshold set from the sea's statistics (see OceanFFT.whitecaps); gusts push more crests over
  float wj = uWhiteJ + (gust - 0.5) * uWhiteRamp;
  float crestSrc = smoothstep(wj + uWhiteRamp * 0.5, wj - uWhiteRamp, Jt) + trail * smoothstep(1.1, 0.85, gJ);
  float band = 0.5 + 0.5 * sin(depthV * 4.0 - uTime * 1.6 + fn * 6.0);
  float shoreFoam = (1.0 - smoothstep(0.0, 1.8, depthV)) * smoothstep(0.3, 0.7, fn * 0.7 + band * 0.5);
  shoreFoam += (1.0 - smoothstep(0.0, 0.35, depthV)) * 0.8;
  // wake foam as coverage of a lace pattern: dense foam covers solidly, thin foam survives only as
  // filaments and bubbles, so the wake frays naturally as it ages
  float wf = clamp(wake.r, 0.0, 2.0);
  float lace = texture2D(uNoise, fp * 0.13 + uTime * 0.006).b * 0.55 + texture2D(uNoise, fp * 0.41 - uTime * 0.01).a * 0.3 + texture2D(uNoise, fp * 1.3).r * 0.15;
  lace = clamp((lace - 0.5) * 2.4 + 0.5, 0.0, 1.0); // the octave sum clusters near 0.5: restore contrast
  float wakeFoam = clamp((wf * 1.05 - (1.0 - lace)) * 3.5, 0.0, 1.0) * 0.95;
  float crestFoam = clamp((crestSrc * 1.1 - (1.0 - lace)) * 3.0, 0.0, 1.0);
  float foam = clamp(max(max(crestFoam * 0.9, shoreFoam), wakeFoam), 0.0, 1.0);
  foam *= 1.0 - smoothstep(1500.0, 5000.0, dist) * 0.7;
  vec3 foamCol = uSunColor * (max(L.y, 0.0) * 0.28 + 0.05) * sunVis + skyIrr * 0.9;
  // foam is bubbly, not flat paint: shade by the lace so dense patches still read as texture
  foamCol *= 0.78 + 0.35 * lace;
  col = mix(col, foamCol, foam * 0.9);

  col = applyAerial(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
}
`;
