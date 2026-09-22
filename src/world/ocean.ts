import * as THREE from 'three';
import { WAVES_GLSL, WaveField } from './waves';
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
uniform float uTime;
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

  // ---- normal: gerstner + two scrolling ripple layers (fade with distance) ----
  vec2 wd = normalize(uWindDir + 1e-4);
  mat2 rot = mat2(wd.y, -wd.x, wd.x, wd.y);
  // cat's paws: gust patches drifting downwind modulate the capillary ripples
  float gust = texture2D(uNoise, vWorld.xz / 420.0 - wd * uTime * 0.011).r;
  gust += 0.35 * (texture2D(uNoise, vWorld.xz / 110.0 - wd * uTime * 0.028).g - 0.5);
  gust = smoothstep(0.28, 0.78, gust);
  float rs = (0.3 + 0.7 * uWindStrength) * (0.35 + 0.95 * gust);
  mat2 r30 = mat2(0.866, 0.5, -0.5, 0.866);
  vec2 uv1 = rot * vWorld.xz / 13.0 + wd * uTime * 0.034;
  vec2 uv2 = (r30 * rot) * vWorld.xz / 5.3 + wd * uTime * 0.058;
  vec2 uv3 = (rot * r30) * vWorld.xz / 1.9 + wd * uTime * 0.092;
  vec2 uv4 = vWorld.xz / 61.0 + wd * uTime * 0.016;
  vec2 r1 = texture2D(uRipple, uv1).xy * 2.0 - 1.0;
  vec2 r2 = texture2D(uRipple, uv2).xy * 2.0 - 1.0;
  vec2 r3 = texture2D(uRipple, uv3).xy * 2.0 - 1.0;
  vec2 r4 = texture2D(uRipple, uv4).xy * 2.0 - 1.0;
  float f1 = 1.0 - smoothstep(150.0, 1400.0, dist);
  float f2 = 1.0 - smoothstep(60.0, 500.0, dist);
  float f3 = 1.0 - smoothstep(12.0, 90.0, dist);
  float f4 = 1.0 - smoothstep(1500.0, 6000.0, dist);
  vec2 slope = (r1 * 0.15 * f1 + r2 * 0.11 * f2 + r3 * 0.08 * f3) * rs + r4 * 0.09 * f4 * (0.6 + 0.4 * gust);
  vec3 r2v = vec3(r2, 0.0);
  vec3 r1v = vec3(r1, 0.0);

  // wake foam / turbulence map
  vec2 fd = (vWorld.xz - uFoamCenter) / uFoamSize;
  vec2 fuv = vec2(fd.x, -fd.y) + 0.5; // ortho foam camera: up = -z
  vec2 wake = vec2(0.0);
  if (all(greaterThan(fuv, vec2(0.0))) && all(lessThan(fuv, vec2(1.0)))) wake = texture2D(uFoamMap, fuv).rg;
  slope += (r2v.xy * 0.3 + r1v.xy * 0.18) * clamp(wake.g, 0.0, 1.0);

  vec3 N = normalize(vN + vec3(slope.x, 0.0, slope.y));
  // far away, flatten normals toward the mean (reduces sparkle aliasing & grazing-angle darkness)
  N = normalize(mix(N, vec3(0.0, 1.0, 0.0), smoothstep(3000.0, 25000.0, dist) * 0.85));

  float NdotV = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);

  // ---- reflection (sky environment) ----
  vec3 R = reflect(-V, N);
  R.y = abs(R.y) * 0.9 + 0.02;
  float lod = clamp(log2(dist / 30.0 + 1.0) * 0.8, 0.0, 5.0);
  vec3 sky = textureLod(uFogEnv, R, lod).rgb;

  // sun / moon glitter: GGX, roughness grows with distance (sub-pixel waves)
  vec3 L = normalize(uSunDir);
  vec3 H = normalize(L + V);
  float rough = 0.06 + 0.12 * smoothstep(20.0, 3000.0, dist);
  float a2 = rough * rough * rough * rough;
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
  inscatter += vec3(0.05, 0.16, 0.16) * light * clamp(wake.g, 0.0, 1.0) * 0.35;
  vec3 refr = sceneCol * T + inscatter;

  // subsurface: light through backlit wave crests
  float sssDot = pow(max(dot(V, -normalize(L + N * 0.6)), 0.0), 4.0);
  float crest = clamp(vWaveH * 0.8 + 0.3, 0.0, 1.5);
  refr += vec3(0.04, 0.22, 0.2) * uSunColor * sssDot * crest * 0.35 * (1.0 - uNight) * sunVis;

  vec3 col = mix(refr, sky, F) + spec;

  // ---- foam ----
  vec2 fp = vWorld.xz;
  float fn = texture2D(uNoise, fp * 0.045 + uTime * 0.004).r * 0.6 + texture2D(uNoise, fp * 0.18 - uTime * 0.01).g * 0.4;
  // whitecaps: where the surface compresses (Jacobian), breaking more inside gust patches
  float crestFoam = smoothstep(0.55 + 0.12 * gust, 0.15, vJ) * smoothstep(0.42, 0.7, fn) * (0.35 + 0.65 * gust);
  float band = 0.5 + 0.5 * sin(depthV * 4.0 - uTime * 1.6 + fn * 6.0);
  float shoreFoam = (1.0 - smoothstep(0.0, 1.8, depthV)) * smoothstep(0.3, 0.7, fn * 0.7 + band * 0.5);
  shoreFoam += (1.0 - smoothstep(0.0, 0.35, depthV)) * 0.8;
  float wakeFoam = smoothstep(0.15, 0.9, wake.r * (0.55 + 0.9 * fn));
  float foam = clamp(max(max(crestFoam * 0.8, shoreFoam), wakeFoam), 0.0, 1.0);
  foam *= 1.0 - smoothstep(1500.0, 5000.0, dist) * 0.7;
  vec3 foamCol = uSunColor * (max(L.y, 0.0) * 0.28 + 0.05) * sunVis + skyIrr * 0.9;
  col = mix(col, foamCol, foam * 0.92);

  col = applyAerial(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
}
`;
