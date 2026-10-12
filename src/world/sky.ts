import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { shared } from '../gfx/shared';
import { CLOUD_GLSL, type Clouds } from '../gfx/clouds';
import { rng } from '../core/util';
import type { AstroClock } from './astro';
import { evaluateLighting, type LightingState } from './lightingState';
import { SkyEnvironmentCache, type EnvironmentBundle } from '../gfx/skyEnvironment';
import type { EnvironmentInput } from '../gfx/environmentPolicy';
import { GpuProfiler } from '../gfx/gpuProfiler';
import { setEnvironmentShaderBlend } from '../gfx/environmentMaterials';

function cloneUniformValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if ('isTexture' in value) return value; // Shared textures are handles; render targets cannot be cloned.
  if (Array.isArray(value)) return value.map(cloneUniformValue);
  if (ArrayBuffer.isView(value)) return (value as { slice?: () => unknown }).slice?.() ?? value;
  if ('clone' in value && typeof value.clone === 'function') return value.clone();
  return { ...value };
}

function copyUniformValue(target: unknown, source: unknown): unknown {
  if (!source || typeof source !== 'object') return source;
  if ('isTexture' in source) return source;
  if (Array.isArray(source)) {
    if (Array.isArray(target) && target.length === source.length) {
      for (let i = 0; i < source.length; i++) target[i] = copyUniformValue(target[i], source[i]);
      return target;
    }
    return source.map(cloneUniformValue);
  }
  if (ArrayBuffer.isView(source)) {
    if (ArrayBuffer.isView(target) && 'set' in target && typeof target.set === 'function') {
      target.set(source as never);
      return target;
    }
    return cloneUniformValue(source);
  }
  if (target && typeof target === 'object' && 'copy' in target && typeof target.copy === 'function') {
    target.copy(source);
    return target;
  }
  return cloneUniformValue(source);
}

/**
 * Sky, celestial bodies, lighting and environment.
 * - three's Preetham Sky (with its procedural clouds) for the dome
 * - procedural star field rotating about the celestial pole, and a phase-lit moon
 * - sun/moon directional light with colour from atmospheric transmittance
 * - environment cube re-baked from the sky -> PMREM for PBR, raw cube for water reflection & fog
 */
export class SkySystem {
  readonly group = new THREE.Group();
  readonly sky: Sky;
  readonly light: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private readonly environment: SkyEnvironmentCache;
  private envSky!: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private clearSky!: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private envScene = new THREE.Scene();
  private clearSkyScene = new THREE.Scene();
  private pmrem: THREE.PMREMGenerator;
  readonly environmentProfiler: GpuProfiler;
  private environmentSourceVersion = 1;
  private forceEnvironmentPending = false;
  private disposed = false;
  private readonly onContextLost = (event: Event) => {
    event.preventDefault();
    this.environmentProfiler.contextLost();
    this.forceEnvironment();
  };
  private readonly onContextRestored = () => {
    this.environmentProfiler.contextRestored(this.renderer);
    this.forceEnvironment();
  };
  private stars: THREE.Points;
  private starMat: THREE.ShaderMaterial;
  private seaDisc: THREE.Mesh;

  /** 0 = full day, 1 = full night */
  night = 0;
  /** suggested exposure (eye adaptation) */
  exposure = 1;
  sunIntensity = 0;
  clouds: Clouds | null = null;
  lightingState!: LightingState;

  get envTarget(): THREE.WebGLCubeRenderTarget { return this.environment.previous.raw; }
  get envMap(): THREE.Texture | null { return this.environment.previous.pmrem?.texture ?? null; }
  get environmentTelemetry() { return this.environment.telemetry; }
  get stagedCaptures() { return this.environment.stagedCapturesEnabled; }
  set stagedCaptures(value: boolean) { this.environment.stagedCapturesEnabled = value; this.environment.telemetry.stagedCaptures = value; }
  get forceCurrent() { return this.environment.forceCurrentMode; }
  set forceCurrent(value: boolean) {
    this.environment.forceCurrentMode = value;
    this.environment.telemetry.forceCurrent = value;
  }

  constructor(private renderer: THREE.WebGLRenderer, private clock: AstroClock, environmentSize = 256) {
    this.environmentProfiler = new GpuProfiler(renderer);
    this.sky = new Sky();
    this.sky.scale.setScalar(40000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 2.2;
    u.rayleigh.value = 0.85;
    u.mieCoefficient.value = 0.0016;
    u.mieDirectionalG.value = 0.86;
    u.cloudCoverage.value = 0.14;
    u.cloudDensity.value = 0.5;
    u.cloudElevation.value = 0.6;
    u.cloudScale.value = 0.00018;
    // moonlit night sky: the Preetham model only knows the sun, so add the moon's own (dim, blue)
    // Rayleigh sky, a glow around the moon, faint airglow near the horizon, and moonlit clouds
    u.uNightSky = { value: new THREE.Vector3() };
    u.uTwilightSky = { value: new THREE.Vector3() };
    u.uMoonDir = { value: new THREE.Vector3(0, 1, 0) };
    u.uMoonRight = { value: new THREE.Vector3(1, 0, 0) };
    u.uMoonUp = { value: new THREE.Vector3(0, 1, 0) };
    u.uMoonSun = { value: new THREE.Vector3() };
    u.uMoonBright = { value: 0 };
    u.uMoonVisible = { value: 0 };
    const fs = this.sky.material.fragmentShader;
    this.sky.material.fragmentShader = fs
      .replace('uniform float cloudScale;', `uniform float cloudScale;
        uniform vec3 uNightSky;
        uniform vec3 uTwilightSky;
        uniform vec3 uMoonDir;
        uniform vec3 uMoonRight;
        uniform vec3 uMoonUp;
        uniform vec3 uMoonSun;
        uniform float uMoonBright;
        uniform float uMoonVisible;`)
      .replace('void main() {', `float moonHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float moonNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(moonHash(i), moonHash(i + vec2(1.0, 0.0)), f.x),
            mix(moonHash(i + vec2(0.0, 1.0)), moonHash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        void main() {`)
      .replace(
        'if ( direction.y > 0.0 && cloudCoverage > 0.0 ) {',
        `float hz = 1.0 - clamp( direction.y, 0.0, 1.0 );
        float mu = max( dot( direction, uMoonDir ), 0.0 );
        texColor += uTwilightSky * ( 0.55 + 0.65 * hz * hz );
        texColor += uNightSky * ( 0.55 + 1.3 * hz * hz * hz + 2.5 * pow( mu, 12.0 ) + 6.0 * pow( mu, 200.0 ) );
        texColor += vec3( 0.0006, 0.0008, 0.0011 ) * hz * hz;
        if ( direction.y > 0.0 && cloudCoverage > 0.0 ) {`,
      )
      .replace('cloudColor *= max( dayFactor, 0.03 );', 'cloudColor *= max( dayFactor, 0.03 );\n\t\t\t\tcloudColor += uNightSky * ( 1.4 + 3.0 * pow( mu, 6.0 ) );')
      .replace('// Clouds', `// The moon belongs to the sky behind the clouds, including in cube captures.
        float moonFacing = dot(direction, uMoonDir);
        if (uMoonVisible > 0.5 && moonFacing > 0.0) {
          vec2 p = vec2(dot(direction, uMoonRight), dot(direction, uMoonUp)) / (moonFacing * 0.017);
          float r2 = dot(p, p);
          if (r2 < 1.0) {
            vec3 nrm = vec3(p, sqrt(1.0 - r2));
            float lit = smoothstep(-0.05, 0.12, dot(nrm, uMoonSun));
            float maria = 0.75 + 0.25 * moonNoise(p * 3.0 + 4.0)
              - 0.18 * smoothstep(0.55, 0.7, moonNoise(p * 1.7 + 1.3));
            vec3 moonColor = vec3(1.0, 0.97, 0.9) * maria * (lit + 0.015) * uMoonBright;
            texColor = mix(texColor, moonColor, 1.0 - smoothstep(0.995, 1.0, r2));
          }
        }

        // Clouds`);
    this.sky.material.depthTest = false;
    this.sky.renderOrder = -1000;
    this.sky.frustumCulled = false;
    this.group.add(this.sky);

    // --- stars ---
    const r = rng(42);
    const N = 6000;
    const pos = new Float32Array(N * 3);
    const mag = new Float32Array(N);
    const col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      // concentrate some stars in a galactic band
      let x: number, y: number, z: number;
      const band = r() < 0.35;
      const th = r() * Math.PI * 2;
      const ph = band ? (r() - 0.5) * 0.35 : Math.acos(2 * r() - 1) - Math.PI / 2;
      x = Math.cos(ph) * Math.cos(th);
      y = Math.sin(ph);
      z = Math.cos(ph) * Math.sin(th);
      if (band) {
        // tilt band ~60deg to the celestial equator
        const a = 1.05;
        const y2 = y * Math.cos(a) - z * Math.sin(a);
        const z2 = y * Math.sin(a) + z * Math.cos(a);
        y = y2;
        z = z2;
      }
      pos.set([x, y, z], i * 3);
      mag[i] = Math.pow(r(), 6.0); // few bright, many faint
      const t = r();
      col.set(t < 0.15 ? [1.0, 0.8, 0.6] : t < 0.3 ? [0.75, 0.85, 1.0] : [1, 1, 1], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    sg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.starMat = new THREE.ShaderMaterial({
      uniforms: {
        uNight: { value: 0 }, uTime: shared.uTime, uPixel: { value: 1 },
        uMoonDir: u.uMoonDir, uMoonVisible: u.uMoonVisible,
      },
      vertexShader: /* glsl */ `
        attribute float aMag; attribute vec3 color;
        varying float vB; varying vec3 vC; varying vec3 vDir;
        uniform float uTime; uniform float uPixel;
        void main(){
          vec4 wp = modelMatrix * vec4(position * 30000.0, 1.0);
          vec3 d = normalize(wp.xyz - cameraPosition);
          vDir = d;
          float tw = 0.75 + 0.25 * sin(uTime * (2.0 + aMag * 7.0) + position.x * 400.0);
          vB = (0.25 + aMag * 5.0) * tw * smoothstep(-0.02, 0.12, d.y);
          vC = color;
          gl_Position = projectionMatrix * viewMatrix * wp;
          // Stars are a background, but their additive pass follows opaque geometry.
          // Test at the actual far depth so land, sails and rigging can occlude them.
          #ifdef USE_REVERSED_DEPTH_BUFFER
          gl_Position.z = 0.0;
          #else
          gl_Position.z = gl_Position.w;
          #endif
          gl_PointSize = (1.2 + aMag * 2.2) * uPixel;
        }`,
      fragmentShader: /* glsl */ `
        varying float vB; varying vec3 vC; varying vec3 vDir;
        uniform float uNight; uniform vec3 uMoonDir; uniform float uMoonVisible;
        void main(){
          // Stars lie behind the lunar disc even though their point pass renders after the sky.
          if (uMoonVisible > 0.5 && dot(normalize(vDir), uMoonDir) > 0.9998555) discard;
          vec2 c = gl_PointCoord - 0.5;
          float a = exp(-dot(c,c) * 18.0);
          gl_FragColor = vec4(vC * vB * a * uNight * 0.6, 1.0);
        }`,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.stars = new THREE.Points(sg, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -999;
    this.group.add(this.stars);

    // --- lights ---
    this.light = new THREE.DirectionalLight(0xffffff, 3);
    this.light.castShadow = true;
    this.light.shadow.bias = -0.0002;
    this.light.shadow.normalBias = 0.03;
    this.hemi = new THREE.HemisphereLight(0x9ec5ff, 0x1a3a4a, 0.0);

    // --- environment ---
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.environment = new SkyEnvironmentCache(renderer, environmentSize, undefined, this.environmentProfiler);
    this.environment.setPMREMGenerator(this.pmrem);
    // Live profiling found a full cloudy cube exceeds a frame budget; spread its faces.
    this.stagedCaptures = environmentSize >= 128;
    const envMaterial = this.sky.material.clone();
    envMaterial.uniforms = THREE.UniformsUtils.clone(this.sky.material.uniforms);
    envMaterial.defines = { ...envMaterial.defines, SKY_ENV_BLEND: 0 };
    this.envSky = new THREE.Mesh(this.sky.geometry, envMaterial);
    this.envSky.scale.setScalar(40000);
    this.envScene.add(this.envSky);
    // Keep an independent clear-sky radiance source for distant cloud haze. Uniforms are copied
    // from the live sky only when a capture begins, so a generation never aliases moving inputs.
    const clearSkyMaterial = this.sky.material.clone();
    clearSkyMaterial.uniforms = THREE.UniformsUtils.clone(this.sky.material.uniforms);
    clearSkyMaterial.defines = { ...clearSkyMaterial.defines, SKY_ENV_BLEND: 0 };
    this.clearSky = new THREE.Mesh(this.sky.geometry, clearSkyMaterial);
    this.clearSky.scale.setScalar(40000);
    this.clearSkyScene.add(this.clearSky);
    // ocean below the horizon for the environment: dark blue-green, lit by sky
    this.seaDisc = new THREE.Mesh(
      new THREE.CircleGeometry(60000, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x0b2a3a }),
    );
    this.seaDisc.position.y = -30;
    this.envScene.add(this.seaDisc);
    shared.uFogEnv.value = this.envTarget.texture;
    renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  update(dt: number, camera: THREE.Camera, force = false) {
    this.updateLighting(dt, camera, force);
    this.updateEnvironment(dt, force);
  }

  /** Set celestial geometry and light before cloud lighting is evaluated. */
  updateLighting(dt: number, camera: THREE.Camera, force = false) {
    if (this.disposed) return;
    const c = this.clock;
    const state = this.lightingState = evaluateLighting(c);
    this.group.position.copy(camera.position);

    // Keep the established Preetham and custom lunar shader coefficients, sourced from one immutable frame snapshot.
    this.sky.material.uniforms.sunPosition.value.set(...state.sunDir);
    this.sky.material.uniforms.time.value = shared.uTime.value;
    this.night = state.night;
    shared.uNight.value = this.night;

    this.sunIntensity = state.sunIntensity;
    const assign3 = (value: THREE.Vector3, tuple: readonly number[]) => value.set(tuple[0], tuple[1], tuple[2]);
    assign3(this.sky.material.uniforms.uNightSky.value as THREE.Vector3, state.nightSkyRGB);
    assign3(this.sky.material.uniforms.uTwilightSky.value as THREE.Vector3, state.twilightSkyRGB);
    assign3(this.sky.material.uniforms.uMoonDir.value as THREE.Vector3, state.moonDir);

    const L = this.light;
    const sunColor = shared.uSunColor.value;
    assign3(L.position, state.directDir);
    assign3(shared.uSunDir.value, state.directDir);
    sunColor.setRGB(state.directRGB[0], state.directRGB[1], state.directRGB[2]);
    L.color.copy(sunColor);
    const li = Math.max(sunColor.r, sunColor.g, sunColor.b);
    L.intensity = 1;
    L.castShadow = li > 0.02;

    // Bridge the loss of solar skylight before lunar direct light settles in.
    // This gentle twilight fill vanishes at both full day and full night.
    this.hemi.intensity = state.hemiIntensity;
    this.hemi.color.setRGB(0.35, 0.45, 0.8);

    // stars/moon
    // stars emerge through nautical twilight (sun -3deg .. -12deg), not while the sky is still bright
    this.starMat.uniforms.uNight.value = state.starVisibility;
    this.starMat.uniforms.uPixel.value = this.renderer.getPixelRatio();
    this.stars.rotation.set(0, 0, 0);
    this.stars.quaternion
      .setFromAxisAngle(new THREE.Vector3(1, 0, 0), c.latitude - Math.PI / 2)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -c.siderealAngle));
    // Camera-facing frame for the disc. Its +z points toward the viewer, as it did on the
    // former billboard. The sky shader uses this same frame for the view and cube capture.
    assign3(this.sky.material.uniforms.uMoonRight.value as THREE.Vector3, state.moonRight);
    assign3(this.sky.material.uniforms.uMoonUp.value as THREE.Vector3, state.moonUp);
    assign3(this.sky.material.uniforms.uMoonSun.value as THREE.Vector3, state.moonSun);
    this.sky.material.uniforms.uMoonBright.value = state.moonBright;
    this.sky.material.uniforms.uMoonVisible.value = state.moonVisible;
    this.exposure += (state.targetExposure - this.exposure) * (1 - Math.exp(-dt * 1.5));
    if (force) this.exposure = state.targetExposure;
  }

  /** Update the two-generation cache after lighting and clouds have advanced. */
  updateEnvironment(dt: number, force = false, present = true) {
    if (this.disposed) return;
    if (this.renderer.getContext().isContextLost()) {
      this.forceEnvironment();
      return;
    }
    this.environmentProfiler.poll();
    const state = this.lightingState ?? evaluateLighting(this.clock);
    const cloudUniforms = this.clouds?.uniforms;
    const wind = (cloudUniforms?.uCloudWind.value as THREE.Vector2 | undefined) ?? shared.uWindDir.value;
    const input: EnvironmentInput = Object.freeze({
      lighting: state,
      profileName: state.profileName,
      profileVersion: state.profileVersion,
      animationTime: this.sky.material.uniforms.time.value,
      originX: this.group.position.x,
      originY: this.group.position.y,
      originZ: this.group.position.z,
      windX: wind.x,
      windZ: wind.y,
      coverage: cloudUniforms?.uCloudCoverage.value ?? 0,
      density: cloudUniforms?.uCloudDensity.value ?? 0,
      erosion: cloudUniforms?.uCloudErosion.value ?? 0,
      atmosphere: Object.freeze([
        this.sky.material.uniforms.turbidity.value,
        this.sky.material.uniforms.rayleigh.value,
        this.sky.material.uniforms.mieCoefficient.value,
        this.sky.material.uniforms.mieDirectionalG.value,
        this.sky.material.uniforms.cloudElevation.value,
        this.sky.material.uniforms.cloudScale.value,
        this.sky.material.uniforms.cloudDensity.value,
        this.sky.material.uniforms.cloudCoverage.value,
      ]),
      sourceVersion: this.environmentSourceVersion,
      radiance: Math.max(...state.directRGB),
    });
    const forceNow = force || (present && this.forceEnvironmentPending);
    this.environment.update(
      dt, forceNow, present, input, (bundle, face) => this.captureEnvironment(bundle, face),
      () => this.publishEnvironmentPair(),
    );
    if (present && forceNow) this.forceEnvironmentPending = false;
    this.publishEnvironmentPair();
  }

  private publishEnvironmentPair() {
    const blending = this.environment.isBlending;
    setEnvironmentShaderBlend(blending);
    const old = this.environment.previous;
    const next = this.environment.nextBundle;
    shared.uFogEnv.value = old.raw.texture;
    shared.uFogEnvNext.value = next.raw.texture;
    shared.uPbrEnvNext.value = next.pmrem?.texture ?? old.pmrem?.texture ?? null;
    const blend = blending ? this.environment.blend : 0;
    this.environmentTelemetry.appliedBlend = blend;
    shared.uEnvBlend.value = blend;
    if (this.clouds) {
      this.clouds.uniforms.uCloudHazeSky.value = old.clear.texture;
      this.clouds.uniforms.uCloudHazeSkyNext.value = next.clear.texture;
      this.clouds.uniforms.uCloudHazeBlend.value = blend;
      this.clouds.uniforms.uCloudHazeReady.value = 1;
    }
  }

  /** Give environment captures the volumetric cloud layer and their haze its clear-sky colour. */
  attachClouds(clouds: Clouds) {
    if (this.disposed) return;
    this.clouds = clouds;
    this.environmentSourceVersion++;
    const m = this.sky.material as THREE.ShaderMaterial;
    Object.assign(m.uniforms, clouds.uniforms, {
      uCloudOn: { value: 1 },
    });
    clouds.uniforms.uCloudHazeSky.value = this.environment.previous.clear.texture;
    clouds.uniforms.uCloudHazeSkyNext.value = this.environment.nextBundle.clear.texture;
    clouds.uniforms.uCloudHazeBlend.value = this.environment.blend;
    clouds.uniforms.uCloudHazeReady.value = 0;
    m.uniforms.cloudCoverage.value = 0; // volumetric clouds replace the flat procedural layer
    m.fragmentShader = m.fragmentShader
      .replace('uniform float cloudScale;', 'uniform float cloudScale;\n' + CLOUD_GLSL + '\nuniform float uCloudOn;')
      .replace(
        'gl_FragColor = vec4( texColor, 1.0 );',
        `if ( uCloudOn > 0.5 ) {
          vec4 cl = vcMarch( direction, 28.0, 0.5 );
          texColor = texColor * cl.a + cl.rgb;
        }
        gl_FragColor = vec4( texColor, 1.0 );`,
      );
    m.needsUpdate = true;
    this.envSky.material.fragmentShader = m.fragmentShader;
    // The environment pass pins one clear-sky cube for the whole candidate generation. Compile
    // that variant without the live transition sampler to stay within the WebGL texture-unit cap.
    this.envSky.material.defines = {
      ...this.envSky.material.defines,
      SKY_ENV_BLEND: 0,
      CLOUD_HAZE_SINGLE_SOURCE: 1,
    };
    this.envSky.material.needsUpdate = true;
  }

  bakeEnvironment() {
    if (this.disposed) return;
    this.forceEnvironmentPending = true;
    this.updateEnvironment(0, true, true);
  }

  /** Queue a forced, coherent recapture for the next presented environment update. */
  forceEnvironment() {
    if (this.disposed) return;
    this.forceEnvironmentPending = true;
    this.environment.request('forced-request');
  }

  private copyUniforms(source: THREE.ShaderMaterial['uniforms'], destination: THREE.ShaderMaterial['uniforms']) {
    for (const [name, uniform] of Object.entries(source)) {
      if (!destination[name]) destination[name] = { ...uniform, value: cloneUniformValue(uniform.value) };
      else destination[name].value = copyUniformValue(destination[name].value, uniform.value);
    }
  }

  private captureEnvironment(bundle: EnvironmentBundle, face?: number) {
    if (face !== undefined && face >= 0) {
      this.environment.captureRawFace(bundle, this.envScene, face);
      return;
    }
    const live = this.sky.material.uniforms;
    const clearUniforms = this.clearSky.material.uniforms;
    const rawUniforms = this.envSky.material.uniforms;
    this.copyUniforms(live, clearUniforms);
    clearUniforms.showSunDisc.value = 0;
    this.environment.captureClear(bundle, this.clearSkyScene);

    // Full-sky cloud haze samples this generation's frozen clear cube, never the live transition pair.
    this.copyUniforms(live, rawUniforms);
    rawUniforms.showSunDisc.value = 0;
    if (rawUniforms.uCloudOn) rawUniforms.uCloudOn.value = 1;
    if (rawUniforms.uCloudHazeReady) rawUniforms.uCloudHazeReady.value = 1;
    if (rawUniforms.uCloudHazeSky) rawUniforms.uCloudHazeSky.value = bundle.clear.texture;
    if (rawUniforms.uCloudHazeSkyNext) rawUniforms.uCloudHazeSkyNext.value = bundle.clear.texture;
    if (rawUniforms.uCloudHazeBlend) rawUniforms.uCloudHazeBlend.value = 0;
    const k = 0.25 + 0.75 * (1 - this.night);
    (this.seaDisc.material as THREE.MeshBasicMaterial).color.setRGB(0.012 * k, 0.05 * k, 0.07 * k);
    if (face !== -1) this.environment.captureRaw(bundle, this.envScene);
    // Staged mode leaves these cloned uniforms pinned while six raw faces are drawn over later frames.
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);
    const rawTargets = new Set(this.environment.bundles.map((bundle) => bundle.raw.texture));
    const clearTargets = new Set(this.environment.bundles.map((bundle) => bundle.clear.texture));
    const pmremTargets = new Set(this.environment.bundles.flatMap((bundle) => bundle.pmrem ? [bundle.pmrem.texture] : []));
    const ownsSharedEnvironment = rawTargets.has(shared.uFogEnv.value as THREE.CubeTexture)
      || rawTargets.has(shared.uFogEnvNext.value as THREE.CubeTexture)
      || pmremTargets.has(shared.uPbrEnvNext.value as THREE.Texture);
    if (rawTargets.has(shared.uFogEnv.value as THREE.CubeTexture)) shared.uFogEnv.value = null;
    if (rawTargets.has(shared.uFogEnvNext.value as THREE.CubeTexture)) shared.uFogEnvNext.value = null;
    if (pmremTargets.has(shared.uPbrEnvNext.value as THREE.Texture)) shared.uPbrEnvNext.value = null;
    if (ownsSharedEnvironment) shared.uEnvBlend.value = 0;
    if (this.clouds) {
      if (clearTargets.has(this.clouds.uniforms.uCloudHazeSky.value as THREE.CubeTexture)) this.clouds.uniforms.uCloudHazeSky.value = null;
      if (clearTargets.has(this.clouds.uniforms.uCloudHazeSkyNext.value as THREE.CubeTexture)) this.clouds.uniforms.uCloudHazeSkyNext.value = null;
      if (clearTargets.size) {
        this.clouds.uniforms.uCloudHazeBlend.value = 0;
        this.clouds.uniforms.uCloudHazeReady.value = 0;
      }
    }
    this.environment.dispose();
    this.environmentProfiler.dispose();
    this.pmrem.dispose();
    this.sky.geometry.dispose();
    (this.sky.material as THREE.ShaderMaterial).dispose();
    this.stars.geometry.dispose();
    this.starMat.dispose();
    (this.envSky.material as THREE.ShaderMaterial).dispose();
    (this.clearSky.material as THREE.ShaderMaterial).dispose();
    this.seaDisc.geometry.dispose();
    (this.seaDisc.material as THREE.Material).dispose();
  }
}
