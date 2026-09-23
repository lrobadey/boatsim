import * as THREE from 'three';
import { shared } from './shared';

/**
 * Volumetric cumulus.
 *
 * A layer of fair-weather cumulus between ~1.4 and ~3.6 km, on a curved Earth so the deck of
 * clouds sinks toward the horizon. Density follows the Nubis recipe (Schneider 2015): a large-scale
 * coverage map, a Perlin-Worley shape texture shaped by a cumulus height profile, eroded at the
 * edges by Worley detail. Lighting: a short march toward the sun with Beer's law plus a multiple-
 * scattering term, the "powder" darkening on sun-facing edges, a dual-lobe Henyey-Greenstein phase
 * (bright silver lining toward the sun) and sky ambient that is brighter at the tops.
 *
 * Rendered at reduced resolution with per-frame jitter and temporal accumulation (history
 * re-projected by camera rotation — clouds are effectively at infinity), then composited into the
 * sky dome. The environment-cube bake runs the same march inline, so reflections and aerial fog see
 * the same clouds. A top-down cloud-shadow map lets terrain and sea receive moving cloud shadows.
 */
export const CLOUD_GLSL = /* glsl */ `
uniform highp sampler3D uCloudShape;
uniform highp sampler3D uCloudDetail;
uniform sampler2D uCloudCover;
uniform vec3 uCloudOrigin;   // world position rays start from (the main camera)
uniform vec2 uCloudWind;     // accumulated drift (m)
uniform float uCloudCoverage;
uniform float uCloudDensity;
uniform vec3 uCloudSunDir;
uniform vec3 uCloudSunColor;
uniform vec3 uCloudAmbTop;
uniform vec3 uCloudAmbBottom;
const float C_EARTH = 6360000.0;
const float C_BOTTOM = 1400.0;
const float C_TOP = 3600.0;

vec2 vcRaySphere(vec3 ro, vec3 rd, float r) {
  // ro relative to the Earth's centre
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(-1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}
float vcHeightFrac(vec3 p) {
  return (length(p + vec3(0.0, C_EARTH, 0.0) - vec3(uCloudOrigin.x, 0.0, uCloudOrigin.z)) - C_EARTH - C_BOTTOM) / (C_TOP - C_BOTTOM);
}
float vcRemap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }

// density at world position p (m); cheap = skip the detail erosion (light march)
float vcDensity(vec3 p, float hf, bool cheap) {
  if (hf < 0.0 || hf > 1.0) return 0.0;
  vec3 q = p + vec3(uCloudWind.x, 0.0, uCloudWind.y);
  // weather: large coverage patches drifting with the wind
  float cov = texture(uCloudCover, q.xz / 42000.0).r * 0.7 + texture(uCloudCover, q.xz / 13000.0 + 0.37).g * 0.3;
  cov = clamp(vcRemap(cov, 0.5 - uCloudCoverage * 0.5, 0.95, 0.0, 1.0), 0.0, 1.0) * clamp(uCloudCoverage * 2.5, 0.0, 1.0);
  if (cov < 0.02) return 0.0;
  // cumulus profile: flat base, rounded towers; taller where coverage is heavy
  float top = mix(0.45, 1.0, cov);
  float prof = smoothstep(0.0, 0.035, hf) * smoothstep(top, top * 0.5, hf);
  float base = texture(uCloudShape, q * (1.0 / 5200.0) + vec3(0.0, hf * 0.08, 0.0)).r;
  float d = clamp(vcRemap(base * prof, 1.0 - cov, 1.0, 0.0, 1.0), 0.0, 1.0);
  if (d <= 0.0 || cheap) return d * uCloudDensity;
  // detail erosion: wispy at the base, billowy at the top
  float det = texture(uCloudDetail, q * (1.0 / 900.0) + vec3(uCloudWind * 0.00002, 0.0).xzy).r;
  float erode = mix(det, 1.0 - det, clamp(hf * 3.0, 0.0, 1.0)) * 0.38;
  d = clamp(vcRemap(d, erode, 1.0, 0.0, 1.0), 0.0, 1.0);
  return d * uCloudDensity;
}
float vcHG(float c, float g) { float g2 = g * g; return (1.0 - g2) / (12.566 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }

// march a view ray; returns premultiplied radiance (rgb) and transmittance (a)
vec4 vcMarch(vec3 rd, float steps, float jitter) {
  vec3 ro = uCloudOrigin;
  vec3 roE = vec3(0.0, ro.y + C_EARTH, 0.0);
  vec2 inner = vcRaySphere(roE, rd, C_EARTH + C_BOTTOM);
  vec2 outer = vcRaySphere(roE, rd, C_EARTH + C_TOP);
  if (outer.y < 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
  float t0 = max(inner.y, 0.0);
  float t1 = outer.y;
  if (rd.y < 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
  t1 = min(t1, t0 + 26000.0);
  float len = t1 - t0;
  float dt = len / steps;
  float t = t0 + dt * jitter;
  float cosT = dot(rd, uCloudSunDir);
  float phase = mix(vcHG(cosT, 0.78), vcHG(cosT, -0.25), 0.3) * 12.566 * 0.55 + 0.45;
  vec3 col = vec3(0.0);
  float T = 1.0;
  float firstHit = -1.0;
  for (int i = 0; i < 96; i++) {
    if (float(i) >= steps || T < 0.015) break;
    vec3 p = ro + rd * t;
    float hf = vcHeightFrac(p);
    float d = vcDensity(p, hf, false);
    if (d > 0.002) {
      if (firstHit < 0.0) firstHit = t;
      // light march toward the sun
      float od = 0.0;
      float ls = 90.0;
      vec3 lp = p;
      for (int j = 0; j < 5; j++) {
        lp += uCloudSunDir * ls;
        od += vcDensity(lp, vcHeightFrac(lp), true) * ls;
        ls *= 1.8;
      }
      float sigma = 0.045;
      float beer = exp(-od * sigma) + 0.35 * exp(-od * sigma * 0.2); // + multiple scattering
      float powder = 1.0 - exp(-d * 60.0);
      vec3 sun = uCloudSunColor * beer * mix(1.0, powder, 0.55) * phase;
      vec3 amb = mix(uCloudAmbBottom, uCloudAmbTop, hf);
      vec3 S = sun + amb;
      float Ts = exp(-d * sigma * dt);
      col += T * S * (1.0 - Ts);
      T *= Ts;
    }
    t += dt;
  }
  // aerial perspective: distant clouds dissolve into the horizon haze
  if (firstHit > 0.0) {
    float fade = exp(-max(firstHit - 4000.0, 0.0) / 30000.0);
    col *= fade;
    T = mix(1.0, T, fade);
  }
  return vec4(col, T);
}
`;

const PASS_FS = /* glsl */ `
precision highp float;
${CLOUD_GLSL}
uniform sampler2D uHistory;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform vec2 uRes;
uniform float uFrame;
uniform float uSteps;
uniform float uBlend;
out vec4 fragColor;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 clip = vec4(uv * 2.0 - 1.0, 0.5, 1.0);
  vec4 wp = uInvViewProj * clip;
  vec3 rd = normalize(wp.xyz / wp.w - cameraPos());
  float j = fract(ign(gl_FragCoord.xy + vec2(uFrame * 5.588, uFrame * 3.17)));
  vec4 cur = vcMarch(rd, uSteps, j);
  // temporal accumulation: re-project the direction into last frame's view
  vec4 pc = uPrevViewProj * vec4(cameraPos() + rd * 1000.0, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  if (pc.w > 0.0 && all(greaterThan(puv, vec2(0.0))) && all(lessThan(puv, vec2(1.0)))) {
    vec4 hist = texture(uHistory, puv);
    cur = mix(hist, cur, uBlend);
  }
  fragColor = cur;
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
  private cur = 0;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.RawShaderMaterial;
  private prevVP = new THREE.Matrix4();
  private frame = 0;
  private wind = new THREE.Vector2();
  private scale: number;
  enabled = true;
  coverage = 0.32;
  private shadowRT = new THREE.WebGLRenderTarget(512, 512, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
  private shadowMat: THREE.RawShaderMaterial;
  private shadowScene = new THREE.Scene();

  constructor(shape: Uint8Array, detail: Uint8Array, cover: THREE.Texture, scale = 0.33) {
    this.scale = scale;
    const tex3 = (data: Uint8Array, n: number) => {
      const t = new THREE.Data3DTexture(data, n, n, n);
      t.format = THREE.RedFormat;
      t.type = THREE.UnsignedByteType;
      t.minFilter = t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
      t.unpackAlignment = 1;
      t.needsUpdate = true;
      return t;
    };
    this.uniforms = {
      uCloudShape: { value: tex3(shape, 128) },
      uCloudDetail: { value: tex3(detail, 32) },
      uCloudCover: { value: cover },
      uCloudOrigin: { value: new THREE.Vector3() },
      uCloudWind: { value: this.wind },
      uCloudCoverage: { value: this.coverage },
      uCloudDensity: { value: 1.0 },
      uCloudSunDir: shared.uSunDir,
      uCloudSunColor: { value: new THREE.Color() },
      uCloudAmbTop: { value: new THREE.Color() },
      uCloudAmbBottom: { value: new THREE.Color() },
    };
    const mk = () =>
      new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    this.targets = [mk(), mk()];
    this.mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: 'in vec3 position; void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: PASS_FS.replace('precision highp float;', 'precision highp float;\nuniform vec3 uCamPos;\nvec3 cameraPos() { return uCamPos; }'),
      uniforms: {
        ...this.uniforms,
        uCamPos: { value: new THREE.Vector3() },
        uHistory: { value: null },
        uInvViewProj: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uRes: { value: new THREE.Vector2(1, 1) },
        uFrame: { value: 0 },
        uSteps: { value: 64 },
        uBlend: { value: 0.2 },
      },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    quad.frustumCulled = false;
    this.scene.add(quad);
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

  /** top-down cloud shadow map around the camera (snapped to its texels so shadows don't swim) */
  renderShadow(renderer: THREE.WebGLRenderer, camPos: THREE.Vector3) {
    const P = shared.uCloudShadowParams.value;
    if (!this.enabled) {
      P.w = 0;
      return;
    }
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
  }

  set steps(n: number) {
    this.mat.uniforms.uSteps.value = n;
  }

  get texture() {
    return this.targets[this.cur].texture;
  }

  setSize(w: number, h: number) {
    const W = Math.max(1, Math.floor(w * this.scale)),
      H = Math.max(1, Math.floor(h * this.scale));
    if (this.targets[0].width === W && this.targets[0].height === H) return;
    for (const t of this.targets) t.setSize(W, H);
    (this.mat.uniforms.uRes.value as THREE.Vector2).set(W, H);
  }

  /** advance weather & lighting inputs (call every frame, also when not rendering) */
  step(dt: number, windX: number, windZ: number, sunColor: THREE.Color, ambTop: THREE.Color, ambBottom: THREE.Color, camPos: THREE.Vector3) {
    // upper-level wind carries the clouds ~1.6x the surface wind
    this.wind.x -= windX * 1.6 * dt;
    this.wind.y -= windZ * 1.6 * dt;
    this.uniforms.uCloudCoverage.value = this.coverage;
    (this.uniforms.uCloudSunColor.value as THREE.Color).copy(sunColor);
    (this.uniforms.uCloudAmbTop.value as THREE.Color).copy(ambTop);
    (this.uniforms.uCloudAmbBottom.value as THREE.Color).copy(ambBottom);
    (this.uniforms.uCloudOrigin.value as THREE.Vector3).copy(camPos);
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera) {
    if (!this.enabled) return;
    const u = this.mat.uniforms;
    const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    // ray directions only need the rotation: build the inverse from a camera at the origin so the
    // unprojected points stay precise
    const rotView = camera.matrixWorldInverse.clone().setPosition(0, 0, 0);
    const vpRot = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, rotView);
    (u.uInvViewProj.value as THREE.Matrix4).copy(vpRot).invert();
    (u.uPrevViewProj.value as THREE.Matrix4).copy(this.frame === 0 ? vpRot : this.prevVP);
    (u.uCamPos.value as THREE.Vector3).set(0, 0, 0);
    this.prevVP.copy(vpRot);
    void vp;
    u.uFrame.value = this.frame++ % 64;
    u.uHistory.value = this.targets[this.cur].texture;
    this.cur ^= 1;
    const prevT = renderer.getRenderTarget();
    renderer.setRenderTarget(this.targets[this.cur]);
    renderer.render(this.scene, this.cam);
    renderer.setRenderTarget(prevT);
  }
}
