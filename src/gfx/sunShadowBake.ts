import * as THREE from 'three';
import { shared } from './shared';

/**
 * Terrain sun shadows as a baked "horizon height" map instead of a per-pixel ray-march.
 *
 * For every world column (x, z) the bake marches the heightfield toward the sun (or moon) and stores
 *   R: the height below which that column is in the terrain's shadow   (max over the ray of
 *      h(s) - s*tan(altitude) - bias)
 *   G: the penumbra width at the dominant occluder (grows with its distance)
 * so any receiver — terrain, trees, houses, the ship, the sea surface — gets its soft terrain shadow
 * from one texture fetch: smoothstep((y - R) / G). The march can afford many more, longer steps than
 * a per-pixel loop could, so long evening shadows reach across bays.
 *
 * Re-baked when the light has moved ~0.25°, spread over several frames in strips into a back buffer
 * that is swapped in when complete (no visible tearing, no frame spikes).
 */
const FS = /* glsl */ `
precision highp float;
uniform sampler2D uHeightTex;
uniform float uTerrainSize;
uniform float uTerrainMax;
uniform float uN;
uniform vec3 uL;
out vec4 fragColor;
float H(vec2 p) {
  vec2 uv = p / uTerrainSize + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return -80.0;
  return texture(uHeightTex, uv).r;
}
void main() {
  vec2 uv = gl_FragCoord.xy / uN;
  vec2 p0 = (uv - 0.5) * uTerrainSize;
  vec3 L = uL;
  L.y = max(L.y, 0.004);
  float lh = length(L.xz);
  vec2 dir = L.xz / max(lh, 1e-4);
  float tanA = L.y / max(lh, 1e-4);
  // receivers of interest sit on the ground or up to ~40 m above it (masts, the sea over shoals)
  float top = max(H(p0), 0.0) + 40.0;
  float best = -1e4, width = 0.4;
  float s = 1.0;
  for (int i = 0; i < 72; i++) {
    float rise = s * tanA;
    if (top + rise > uTerrainMax + 40.0) break;
    float h = H(p0 + dir * s);
    float t3 = s / max(lh, 1e-3); // distance along the 3D ray
    float v = h - rise - 0.6 - 0.012 * t3;
    if (v > best) { best = v; width = t3 * 0.035 + 0.4; }
    s = s * 1.12 + 1.5;
  }
  fragColor = vec4(best, width, 0.0, 1.0);
}`;

export class SunShadowBake {
  private targets: THREE.WebGLRenderTarget[];
  private front = 0;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.RawShaderMaterial;
  private baked = new THREE.Vector3(0, -1, 0);
  private baking = new THREE.Vector3();
  private strip = -1;
  private strips = 8;

  constructor(private renderer: THREE.WebGLRenderer, private N = 2048) {
    const mk = () =>
      new THREE.WebGLRenderTarget(N, N, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        generateMipmaps: false,
      });
    this.targets = [mk(), mk()];
    this.mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: 'in vec3 position; void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: FS,
      uniforms: {
        uHeightTex: shared.uHeightTex,
        uTerrainSize: shared.uTerrainSize,
        uTerrainMax: shared.uTerrainMax,
        uN: { value: N },
        uL: { value: new THREE.Vector3() },
      },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    quad.frustumCulled = false;
    this.scene.add(quad);
    shared.uSunShadowTex.value = this.targets[0].texture;
  }

  /** call once per frame; bakes a strip when the light has moved (all strips at once if forced / first) */
  update(force = false) {
    const L = shared.uSunDir.value;
    const first = this.baked.y === -1;
    if (this.strip < 0) {
      if (this.baked.angleTo(L) < 0.0045) return;
      this.baking.copy(L);
      this.strip = 0;
    }
    const back = this.targets[1 - this.front];
    const prevT = this.renderer.getRenderTarget();
    const prevAuto = this.renderer.autoClear;
    this.renderer.autoClear = false;
    (this.mat.uniforms.uL.value as THREE.Vector3).copy(this.baking);
    const h = this.N / this.strips;
    const n = force || first ? this.strips : 1;
    for (let k = 0; k < n && this.strip < this.strips; k++, this.strip++) {
      back.scissor.set(0, this.strip * h, this.N, h);
      back.scissorTest = true;
      this.renderer.setRenderTarget(back);
      this.renderer.render(this.scene, this.cam);
    }
    back.scissorTest = false;
    this.renderer.setRenderTarget(prevT);
    this.renderer.autoClear = prevAuto;
    if (this.strip >= this.strips) {
      this.front = 1 - this.front;
      shared.uSunShadowTex.value = this.targets[this.front].texture;
      this.baked.copy(this.baking);
      this.strip = -1;
    }
  }
}
