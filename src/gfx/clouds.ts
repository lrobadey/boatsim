import * as THREE from 'three';
import { shared } from './shared';
import { CLOUD_MODEL_GLSL } from './cloudModel';
import { CLOUD_FLOW_GLSL } from './cloudFlow';
import { registerEnvironmentMaterial } from './environmentMaterials';

/**
 * Volumetric cumulus.
 *
 * A layer of fair-weather cumulus between ~1.4 and ~3.6 km, on a curved Earth so the deck of
 * clouds sinks toward the horizon. Density follows the Nubis recipe (Schneider 2015): a large-scale
 * coverage map, a Perlin-Worley shape texture shaped by a cumulus height profile, eroded at the
 * edges by Worley detail. Lighting: bounded detailed and filtered samples to the first cloud-layer
 * exit, with separate Beer's-law direct and soft approximate multiple scattering. Powder darkens
 * sun-facing edges, a dual-lobe Henyey-Greenstein phase forms silver linings, and sky ambient
 * brightens the tops.
 *
 * Rendered at reduced resolution with per-frame jitter and temporal accumulation (history
 * re-projected from measured cloud depth with camera translation), then composited into the
 * scene using its depth buffer. The environment-cube bake runs the same march inline, so reflections and aerial fog see
 * the same clouds. A top-down cloud-shadow map lets terrain and sea receive moving cloud shadows.
 */
export const CLOUD_GLSL = /* glsl */ `
#ifndef SKY_ENV_BLEND
#define SKY_ENV_BLEND 0
#endif
${CLOUD_MODEL_GLSL}
uniform samplerCube uCloudHazeSky;
#if SKY_ENV_BLEND && !defined(CLOUD_HAZE_SINGLE_SOURCE)
uniform samplerCube uCloudHazeSkyNext;
uniform float uCloudHazeBlend;
#endif
uniform float uCloudHazeReady;
vec3 vcHazeSkySample(samplerCube sky, vec3 rd) {
#if __VERSION__ >= 300
  return textureLod(sky, rd, 1.0).rgb;
#else
  return textureCube(sky, rd).rgb;
#endif
}
vec3 vcHazeSky(vec3 rd) {
  vec3 currentRadiance = vcHazeSkySample(uCloudHazeSky, rd);
#if SKY_ENV_BLEND && !defined(CLOUD_HAZE_SINGLE_SOURCE)
  vec3 nextEnv = vcHazeSkySample(uCloudHazeSkyNext, rd);
  return mix(currentRadiance, nextEnv, clamp(uCloudHazeBlend, 0.0, 1.0));
#else
  return currentRadiance;
#endif
}
// march a view ray; returns premultiplied radiance (rgb) and transmittance (a).
// Representative distance is the opacity-weighted centre of the visible cloud (metres).
// rayCone is the view-ray spread across one pixel. Pass it explicitly from code that marches
// inside a per-pixel branch, where screen-space derivatives are undefined.
vec4 vcMarchCone(vec3 rd, float steps, float jitter, float maxDistance, float rayCone, out float representativeDistance) {
  representativeDistance = 0.0;
  // A grazing ray can reach clouds hundreds of kilometres away. Filter morphology
  // over its pixel cone as well as the integration interval; LOD0 aliases into bands.
  vec3 ro = uCloudOrigin;
  vec3 roE = vec3(0.0, ro.y + C_EARTH, 0.0);
  vec2 interval = vcCloudInterval(roE, rd);
  if (interval.x < 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
  float t0 = interval.x;
  float t1 = interval.y;
  t1 = min(min(t1, t0 + 26000.0), maxDistance);
  if (t1 <= t0) return vec4(0.0, 0.0, 0.0, 1.0);
  float len = t1 - t0;
  // Every coarse cell is visited unless opacity ends the ray. A long dense stretch cannot
  // exhaust a global fine-step loop before the far silhouette. Empty cells use two cheap
  // probes; occupied cells are refined, and refinement persists across adjacent cells.
  // Short crossings (such as a downward ray from 1500 m) need fewer cells; about 40 m
  // per coarse cell is already much finer than the 1500 m detail field.
  float maxCells = clamp(floor(steps + 0.5), 1.0, 72.0);
  int cellCount = int(clamp(ceil(len / 40.0), 1.0, maxCells));
  float coarse = len / float(cellCount);
  float cosT = dot(rd, uCloudSunDir);
  float directPhase = mix(vcHG(cosT, 0.78), vcHG(cosT, -0.25), 0.3) * 12.566 * 0.55 + 0.45;
  float softPhase = 0.75 + 0.25 * max(cosT, 0.0);
  float lightStrength = max(max(uCloudSunColor.r, uCloudSunColor.g), uCloudSunColor.b);
  vec3 col = vec3(0.0);
  float T = 1.0;
  float firstHit = -1.0;
  float weightedDistance = 0.0;
  float opacityWeight = 0.0;
  bool refining = false;
  for (int i = 0; i < 72; i++) {
    if (i >= cellCount || T < 0.015) break;
    float cellStart = t0 + float(i) * coarse;
    float cellLen = min(coarse, t1 - cellStart);
    if (!refining) {
      float shift = (jitter - 0.5) * 0.2;
      vec3 pa = ro + rd * (cellStart + (0.25 + shift) * cellLen);
      vec3 pb = ro + rd * (cellStart + (0.75 + shift) * cellLen);
      float probeLod = clamp(log2(max(max(cellLen * 0.25, (cellStart + cellLen) * rayCone), 56.25) / 56.25), 0.0, 4.0);
      if (vcDensityLod(pa, vcHeightFrac(pa), true, probeLod) <= 0.0 &&
          vcDensityLod(pb, vcHeightFrac(pb), true, probeLod) <= 0.0) continue;
    }
    // Three samples per cell through 60 cells. Above that, distribute a fixed 180
    // sample budget over the actual cell count, including short clipped rays.
    int fineCount = cellCount <= 60 ? 3 :
      int(floor(float(i + 1) * 180.0 / float(cellCount)) - floor(float(i) * 180.0 / float(cellCount)));
    float fineStep = cellLen / float(fineCount);
    bool cellHit = false;
    for (int j = 0; j < 3; j++) {
      if (j >= fineCount || T < 0.015) break;
      float t = cellStart + (float(j) + 0.5 + (jitter - 0.5) * 0.5) * fineStep;
      vec3 p = ro + rd * t;
      float hf = vcHeightFrac(p);
      float shapeLod = clamp(log2(max(max(fineStep * 0.5, t * rayCone), 56.25) / 56.25), 0.0, 4.0);
      float d = vcDensityLod(p, hf, false, shapeLod);
      if (d <= 0.002) continue;
      cellHit = true;
      if (firstHit < 0.0) firstHit = t;
      float sigma = 0.045;
      vec3 lit = vec3(0.0);
      if (lightStrength > 0.001) {
        float tau = vcLightOpticalDepth(p, d) * sigma;
        float powder = 1.0 - exp(-d * 60.0);
        float direct = exp(-tau) * mix(1.0, powder, 0.55) * directPhase;
        // A low-frequency, weak fill approximates light scattered within the cloud. It does
        // not inherit the forward-peaked direct phase or the surface powder response.
        float multiple = 0.24 * exp(-tau * 0.18) * softPhase * mix(0.65, 1.0, hf);
        lit = uCloudSunColor * (direct + multiple);
      }
      vec3 amb = mix(uCloudAmbBottom, uCloudAmbTop, hf);
      float Ts = exp(-d * sigma * fineStep);
      float weight = T * (1.0 - Ts);
      col += weight * (lit + amb);
      weightedDistance += weight * t;
      opacityWeight += weight;
      T *= Ts;
    }
    refining = cellHit;
  }
  // Only cloud radiance tends toward horizon haze. Transmittance stays physical
  // so the composite retains correct occlusion of the scene behind it.
  if (firstHit > 0.0) {
    float fade = exp(-max(firstHit - 4000.0, 0.0) / 30000.0);
    vec3 haze = uCloudHazeReady > 0.5 ? vcHazeSky(rd) :
      mix(uCloudAmbBottom, uCloudAmbTop, 0.45) * 0.8;
    col = mix(haze * (1.0 - T), col, fade);
  }
  if (opacityWeight > 0.0001) representativeDistance = weightedDistance / opacityWeight;
  return vec4(col, T);
}
vec4 vcMarch(vec3 rd, float steps, float jitter, float maxDistance, out float representativeDistance) {
  // Derivatives also account for reduced-resolution and environment-cube captures.
  float rayCone = max(length(dFdx(rd)), length(dFdy(rd)));
  return vcMarchCone(rd, steps, jitter, maxDistance, rayCone, representativeDistance);
}
vec4 vcMarch(vec3 rd, float steps, float jitter) {
  float representativeDistance;
  return vcMarch(rd, steps, jitter, 1.0e30, representativeDistance);
}
`;

const PASS_FS = /* glsl */ `
precision highp float;
${CLOUD_GLSL}
uniform mat4 uInvViewProj;
uniform vec2 uRes;
uniform float uFrame;
uniform float uSteps;
uniform sampler2D uSceneDepth;
uniform float uHasSceneDepth;
uniform float uReversedDepth;
layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragDepth;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float sceneRayDistance(vec2 uv) {
  if (uHasSceneDepth < 0.5) return -1.0;
  float farthest = 0.0;
  vec2 footprint = 0.5 / uRes;
  // Clip each reduced-resolution pixel at the farthest surface in its footprint, so a
  // pixel straddling a silhouette still carries the full sky behind it. The composite
  // keeps those clouds off the nearer surface; clipping at the nearest surface instead
  // left a band of cloudless taps beside every edge that the full-resolution sky pixels
  // there could not use.
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 duv = uv + vec2(float(x), float(y)) * footprint;
      float d = texture(uSceneDepth, clamp(duv, vec2(0.0), vec2(1.0))).r;
      bool sky = uReversedDepth > 0.5 ? d <= 0.0 : d >= 1.0;
      if (sky) return -1.0;
      float z = uReversedDepth > 0.5 ? d : d * 2.0 - 1.0;
      vec4 p = uInvViewProj * vec4(duv * 2.0 - 1.0, z, 1.0);
      farthest = max(farthest, length(p.xyz / p.w));
    }
  }
  return farthest;
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 clip = vec4(uv * 2.0 - 1.0, 0.5, 1.0);
  vec4 wp = uInvViewProj * clip;
  vec3 rd = normalize(wp.xyz / wp.w);
  float j = fract(ign(gl_FragCoord.xy + vec2(uFrame * 5.588, uFrame * 3.17)));
  float sceneDistance = sceneRayDistance(uv);
  float cloudDistance;
  fragColor = vcMarch(rd, uSteps, j, sceneDistance > 0.0 ? sceneDistance : 1.0e30, cloudDistance);
  fragDepth = vec4(cloudDistance * 0.001, sceneDistance > 0.0 ? sceneDistance * 0.001 : -1.0, 1.0 - fragColor.a, 0.0);
}`;

const RESOLVE_FS = /* glsl */ `
precision highp float;
${CLOUD_FLOW_GLSL}
uniform sampler2D uCurrent;
uniform sampler2D uHistory;
uniform sampler2D uCurrentDepth;
uniform sampler2D uHistoryDepth;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform vec3 uCamWorldPos;
uniform vec3 uPrevCamWorldPos;
uniform vec2 uCurrentWind;
uniform vec2 uPrevWind;
uniform vec2 uRes;
uniform float uBlend;
uniform float uHasHistory;
layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragDepth;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 cur = texture(uCurrent, uv);
  vec4 curDepth = texture(uCurrentDepth, uv);
  fragColor = cur;
  fragDepth = curDepth;
  if (uHasHistory < 0.5 || curDepth.r <= 0.0 || curDepth.b < 0.01) return;

  vec4 clip = vec4(uv * 2.0 - 1.0, 0.5, 1.0);
  vec4 wp = uInvViewProj * clip;
  vec3 rd = normalize(wp.xyz / wp.w);
  // The same height-dependent flow drives weather, shape and detail density.
  vec3 currentPoint = uCamWorldPos + rd * (curDepth.r * 1000.0);
  float hf = (length(currentPoint + vec3(0.0, 6360000.0, 0.0) -
    vec3(uCamWorldPos.x, 0.0, uCamWorldPos.z)) - 6360000.0 - 1400.0) / 2200.0;
  vec2 flowDelta = vcFlowOffset(hf, uCurrentWind) - vcFlowOffset(hf, uPrevWind);
  vec3 oldPoint = currentPoint + vec3(flowDelta.x, 0.0, flowDelta.y);
  vec4 pc = uPrevViewProj * vec4(oldPoint, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  if (pc.w <= 0.0 || any(lessThanEqual(puv, vec2(0.0))) || any(greaterThanEqual(puv, vec2(1.0)))) return;

  vec4 histDepth = texture(uHistoryDepth, puv);
  float expectedOldDistance = length(oldPoint - uPrevCamWorldPos) * 0.001;
  if (histDepth.r <= 0.0 || histDepth.b < 0.01 ||
      abs(histDepth.r - expectedOldDistance) > max(0.05, expectedOldDistance * 0.05)) return;
  // Reject a surface that has appeared in front of the old cloud sample, or a
  // sky/geometry transition. Current coverage is independently clipped by scene depth.
  if ((curDepth.g < 0.0) != (histDepth.g < 0.0)) return;
  if (histDepth.g > 0.0 && histDepth.g < expectedOldDistance - 0.05) return;

  // A current-frame neighborhood bounds the history before blending. This stops old bright
  // cloud edges from lingering as the camera moves or the cloud field drifts.
  vec4 lo = cur, hi = cur;
  vec2 texel = 1.0 / uRes;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 sampleUV = clamp(uv + vec2(float(x), float(y)) * texel, texel * 0.5, 1.0 - texel * 0.5);
      vec4 v = texture(uCurrent, sampleUV);
      lo = min(lo, v);
      hi = max(hi, v);
    }
  }
  vec4 hist = texture(uHistory, puv);
  float curLum = dot(cur.rgb, vec3(0.2126, 0.7152, 0.0722));
  float histLum = dot(hist.rgb, vec3(0.2126, 0.7152, 0.0722));
  // Transmittance and radiance disagreement signal a changed silhouette or lighting.
  if (abs(hist.a - cur.a) > 0.18 || abs(histLum - curLum) > 0.12 + 0.7 * curLum) {
    return;
  }
  vec4 slack = vec4(vec3(0.02), 0.015);
  hist = clamp(hist, lo - slack, hi + slack);
  fragColor = mix(cur, hist, 1.0 - uBlend);
}`;

const SHADOW_FS = /* glsl */ `
precision highp float;
${CLOUD_GLSL}
uniform vec4 uParams; // centre x, z, size, resolution
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uParams.w;
  vec2 xz = uParams.xy + (uv - 0.5) * uParams.z;
  vec3 L = uCloudSunDir;
  float strength = smoothstep(0.03, 0.18, L.y);
  float T = 1.0;
  if (strength > 0.0) {
    float tA = C_BOTTOM / L.y, tB = C_TOP / L.y;
    float dt = (tB - tA) / 10.0;
    float od = 0.0;
    for (int i = 0; i < 10; i++) {
      vec3 p = vec3(xz.x, 0.0, xz.y) + L * (tA + dt * (float(i) + 0.5));
      od += vcDensity(p, vcHeightFrac(p), true) * dt;
    }
    T = exp(-od * 0.045 * 0.6);
  }
  // light scattered through and around the cloud keeps shadows from going black
  fragColor = vec4(mix(1.0, 0.25 + 0.75 * T, strength), 0.0, 0.0, 1.0);
}`;

export class Clouds {
  readonly uniforms: Record<string, THREE.IUniform>;
  private targets: THREE.WebGLRenderTarget[];
  private currentTarget: THREE.WebGLRenderTarget;
  private cur = 0;
  private scene = new THREE.Scene();
  private resolveScene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.RawShaderMaterial;
  private resolveMat: THREE.RawShaderMaterial;
  private prevVP = new THREE.Matrix4();
  private prevCameraPos = new THREE.Vector3();
  private prevCameraRotation = new THREE.Quaternion();
  private prevWind = new THREE.Vector2();
  private historyValid = false;
  private frame = 0;
  private wind = new THREE.Vector2();
  private scale: number;
  private shadowElapsed = Infinity;
  private shadowDirty = true;
  private lastShadowPos = new THREE.Vector3();
  private lastShadowSunDir = new THREE.Vector3();
  private lastShadowSunColor = new THREE.Color();
  enabled = true;
  coverage = 0.32;
  private shadowRT = new THREE.WebGLRenderTarget(512, 512, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
  private shadowMat: THREE.RawShaderMaterial;
  private shadowScene = new THREE.Scene();

  constructor(shape: Uint16Array, detail: Uint16Array, cover: THREE.Texture, scale = 0.33) {
    this.scale = scale;
    const tex3 = (data: Uint16Array, n: number, mipmaps = false) => {
      const t = new THREE.Data3DTexture(data, n, n, n);
      t.format = THREE.RedFormat;
      t.type = THREE.HalfFloatType;
      t.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = mipmaps;
      t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
      t.unpackAlignment = 1;
      t.needsUpdate = true;
      return t;
    };
    this.uniforms = {
      uCloudShape: { value: tex3(shape, 128, true) },
      uCloudDetail: { value: tex3(detail, 64) },
      uCloudCover: { value: cover },
      uCloudOrigin: { value: new THREE.Vector3() },
      uCloudWind: { value: this.wind },
      uCloudCoverage: { value: this.coverage },
      uCloudDensity: { value: 1.0 },
      uCloudErosion: { value: 0.20 },
      uCloudSunDir: shared.uSunDir,
      uCloudSunColor: { value: new THREE.Color() },
      uCloudAmbTop: { value: new THREE.Color() },
      uCloudAmbBottom: { value: new THREE.Color() },
      uCloudHazeSky: { value: null },
      uCloudHazeSkyNext: { value: null },
      uCloudHazeBlend: { value: 0 },
      uCloudHazeReady: { value: 0 },
    };
    const mk = () =>
      new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, count: 2 });
    this.targets = [mk(), mk()];
    this.currentTarget = mk();
    for (const target of [...this.targets, this.currentTarget]) {
      target.textures[1].minFilter = THREE.NearestFilter;
      target.textures[1].magFilter = THREE.NearestFilter;
    }
    this.mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: 'in vec3 position; void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: PASS_FS,
      uniforms: {
        ...this.uniforms,
        uInvViewProj: { value: new THREE.Matrix4() },
        uRes: { value: new THREE.Vector2(1, 1) },
        uFrame: { value: 0 },
        uSteps: { value: 64 },
        uSceneDepth: { value: null },
        uHasSceneDepth: { value: 0 },
        uReversedDepth: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    registerEnvironmentMaterial(this.mat);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    quad.frustumCulled = false;
    this.scene.add(quad);
    this.resolveMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: 'in vec3 position; void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: RESOLVE_FS,
      uniforms: {
        uCurrent: { value: this.currentTarget.texture },
        uHistory: { value: null },
        uCurrentDepth: { value: this.currentTarget.textures[1] },
        uHistoryDepth: { value: null },
        uInvViewProj: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uCamWorldPos: { value: new THREE.Vector3() },
        uPrevCamWorldPos: { value: new THREE.Vector3() },
        uCurrentWind: { value: new THREE.Vector2() },
        uPrevWind: { value: new THREE.Vector2() },
        uRes: { value: new THREE.Vector2(1, 1) },
        uBlend: { value: 0.12 },
        uHasHistory: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    const resolveQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.resolveMat);
    resolveQuad.frustumCulled = false;
    this.resolveScene.add(resolveQuad);
    this.shadowMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: 'in vec3 position; void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: SHADOW_FS,
      uniforms: { ...this.uniforms, uParams: { value: new THREE.Vector4(0, 0, 16000, 512) } },
      depthTest: false,
      depthWrite: false,
    });
    const sq = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.shadowMat);
    sq.frustumCulled = false;
    this.shadowScene.add(sq);
    shared.uCloudShadowTex.value = this.shadowRT.texture;
  }

  /** Compile the currently selected live cloud environment variant before gameplay starts. */
  async compileEnvironmentVariant(renderer: THREE.WebGLRenderer): Promise<void> {
    await renderer.compileAsync(this.scene, this.cam);
  }

  /** top-down cloud shadow map around the camera (snapped to its texels so shadows don't swim) */
  renderShadow(renderer: THREE.WebGLRenderer, camPos: THREE.Vector3) {
    const P = shared.uCloudShadowParams.value;
    if (!this.enabled) {
      P.w = 0;
      this.shadowDirty = true;
      return;
    }
    const sunDir = shared.uSunDir.value as THREE.Vector3;
    const sunColor = this.uniforms.uCloudSunColor.value as THREE.Color;
    const snap = camPos.distanceToSquared(this.lastShadowPos) > 500 * 500;
    const lighting = sunDir.distanceToSquared(this.lastShadowSunDir) > 0.0025 ||
      (sunColor.r - this.lastShadowSunColor.r) ** 2 +
      (sunColor.g - this.lastShadowSunColor.g) ** 2 +
      (sunColor.b - this.lastShadowSunColor.b) ** 2 > 0.01;
    if (!this.shadowDirty && !snap && !lighting && this.shadowElapsed < 1 / 15) return;
    const size = 16000,
      texel = size / 512;
    const cx = Math.round(camPos.x / texel) * texel,
      cz = Math.round(camPos.z / texel) * texel;
    (this.shadowMat.uniforms.uParams.value as THREE.Vector4).set(cx, cz, size, 512);
    const prevT = renderer.getRenderTarget();
    renderer.setRenderTarget(this.shadowRT);
    renderer.render(this.shadowScene, this.cam);
    renderer.setRenderTarget(prevT);
    P.set(cx, cz, size, 1);
    this.shadowElapsed = 0;
    this.shadowDirty = false;
    this.lastShadowPos.copy(camPos);
    this.lastShadowSunDir.copy(sunDir);
    this.lastShadowSunColor.copy(sunColor);
  }

  set steps(n: number) {
    this.mat.uniforms.uSteps.value = n;
  }

  get steps(): number {
    return this.mat.uniforms.uSteps.value;
  }

  get texture() {
    return this.targets[this.cur].texture;
  }

  /** R = opacity-weighted cloud ray distance in km (0 invalid), G = farthest scene
   * ray distance in km (-1 sky), B = cloud opacity, A reserved. */
  get depthTexture() {
    return this.targets[this.cur].textures[1];
  }

  setSize(w: number, h: number) {
    const W = Math.max(1, Math.floor(w * this.scale)),
      H = Math.max(1, Math.floor(h * this.scale));
    if (this.targets[0].width === W && this.targets[0].height === H) return;
    for (const t of this.targets) t.setSize(W, H);
    this.currentTarget.setSize(W, H);
    (this.mat.uniforms.uRes.value as THREE.Vector2).set(W, H);
    (this.resolveMat.uniforms.uRes.value as THREE.Vector2).set(W, H);
    this.resetHistory();
  }

  /** Discard accumulated cloud pixels after a time jump, abrupt lighting change, or camera cut. */
  resetHistory(): void {
    this.historyValid = false;
    this.shadowDirty = true;
  }

  /** Advance cloud weather displacement (call every frame, also when not rendering). */
  advanceWeather(dt: number, windX: number, windZ: number) {
    this.shadowElapsed += Math.max(0, Math.min(dt, 0.1));
    // upper-level wind carries the clouds ~1.6x the surface wind
    this.wind.x -= windX * 1.6 * dt;
    this.wind.y -= windZ * 1.6 * dt;
  }

  /** Apply the finalized lighting and sampling origin without advancing cloud state. */
  applyLighting(sunColor: THREE.Color, ambTop: THREE.Color, ambBottom: THREE.Color, camPos: THREE.Vector3) {
    this.uniforms.uCloudCoverage.value = this.coverage;
    (this.uniforms.uCloudSunColor.value as THREE.Color).copy(sunColor);
    (this.uniforms.uCloudAmbTop.value as THREE.Color).copy(ambTop);
    (this.uniforms.uCloudAmbBottom.value as THREE.Color).copy(ambBottom);
    (this.uniforms.uCloudOrigin.value as THREE.Vector3).copy(camPos);
  }

  /** Backwards-compatible combined update for callers that have not split frame ordering yet. */
  step(dt: number, windX: number, windZ: number, sunColor: THREE.Color, ambTop: THREE.Color, ambBottom: THREE.Color, camPos: THREE.Vector3) {
    this.advanceWeather(dt, windX, windZ);
    this.applyLighting(sunColor, ambTop, ambBottom, camPos);
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, sceneDepth?: THREE.Texture, reversedDepth = false) {
    if (!this.enabled) return;
    const u = this.mat.uniforms;
    const ru = this.resolveMat.uniforms;
    const cameraPos = camera.getWorldPosition(new THREE.Vector3());
    const cameraRotation = camera.getWorldQuaternion(new THREE.Quaternion());
    if (this.historyValid && (cameraPos.distanceToSquared(this.prevCameraPos) > 500 * 500 ||
      cameraRotation.angleTo(this.prevCameraRotation) > Math.PI / 5)) this.resetHistory();
    const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    // ray directions only need the rotation: build the inverse from a camera at the origin so the
    // unprojected points stay precise
    const rotView = camera.matrixWorldInverse.clone().setPosition(0, 0, 0);
    const vpRot = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, rotView);
    const invVP = vpRot.invert();
    (u.uInvViewProj.value as THREE.Matrix4).copy(invVP);
    (ru.uInvViewProj.value as THREE.Matrix4).copy(invVP);
    (ru.uPrevViewProj.value as THREE.Matrix4).copy(this.prevVP);
    (ru.uCamWorldPos.value as THREE.Vector3).copy(cameraPos);
    (ru.uPrevCamWorldPos.value as THREE.Vector3).copy(this.prevCameraPos);
    (ru.uCurrentWind.value as THREE.Vector2).copy(this.wind);
    (ru.uPrevWind.value as THREE.Vector2).copy(this.prevWind);
    ru.uHasHistory.value = this.historyValid ? 1 : 0;
    u.uSceneDepth.value = sceneDepth ?? null;
    u.uHasSceneDepth.value = sceneDepth ? 1 : 0;
    u.uReversedDepth.value = reversedDepth ? 1 : 0;
    u.uFrame.value = this.frame++ % 64;
    ru.uHistory.value = this.targets[this.cur].texture;
    ru.uHistoryDepth.value = this.targets[this.cur].textures[1];
    this.cur ^= 1;
    const prevT = renderer.getRenderTarget();
    renderer.setRenderTarget(this.currentTarget);
    renderer.render(this.scene, this.cam);
    renderer.setRenderTarget(this.targets[this.cur]);
    renderer.render(this.resolveScene, this.cam);
    renderer.setRenderTarget(prevT);
    this.prevVP.copy(vp);
    this.prevCameraPos.copy(cameraPos);
    this.prevCameraRotation.copy(cameraRotation);
    this.prevWind.copy(this.wind);
    this.historyValid = true;
  }
}
