import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { shared } from '../gfx/shared';
import { clamp, smoothstep, rng } from '../core/util';
import type { AstroClock } from './astro';

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
  readonly envTarget: THREE.WebGLCubeRenderTarget;
  envMap: THREE.Texture | null = null;
  private cubeCam: THREE.CubeCamera;
  private envScene = new THREE.Scene();
  private pmrem: THREE.PMREMGenerator;
  private pmremTarget: THREE.WebGLRenderTarget | null = null;
  private stars: THREE.Points;
  private starMat: THREE.ShaderMaterial;
  private moon: THREE.Mesh;
  private moonMat: THREE.ShaderMaterial;
  private lastBakeSun = new THREE.Vector3(9, 9, 9);
  private bakeTimer = 0;
  private seaDisc: THREE.Mesh;

  /** 0 = full day, 1 = full night */
  night = 0;
  /** suggested exposure (eye adaptation) */
  exposure = 1;
  sunIntensity = 0;

  constructor(private renderer: THREE.WebGLRenderer, private clock: AstroClock) {
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
    u.uMoonDir = { value: new THREE.Vector3(0, 1, 0) };
    const fs = this.sky.material.fragmentShader;
    this.sky.material.fragmentShader = fs
      .replace('uniform float cloudScale;', 'uniform float cloudScale;\nuniform vec3 uNightSky;\nuniform vec3 uMoonDir;')
      .replace(
        'if ( direction.y > 0.0 && cloudCoverage > 0.0 ) {',
        `float hz = 1.0 - clamp( direction.y, 0.0, 1.0 );
        float mu = max( dot( direction, uMoonDir ), 0.0 );
        texColor += uNightSky * ( 0.55 + 1.3 * hz * hz * hz + 2.5 * pow( mu, 12.0 ) + 6.0 * pow( mu, 200.0 ) );
        texColor += vec3( 0.0006, 0.0008, 0.0011 ) * hz * hz;
        if ( direction.y > 0.0 && cloudCoverage > 0.0 ) {`,
      )
      .replace('cloudColor *= max( dayFactor, 0.03 );', 'cloudColor *= max( dayFactor, 0.03 );\n\t\t\t\tcloudColor += uNightSky * ( 1.4 + 3.0 * pow( mu, 6.0 ) );');
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
      uniforms: { uNight: { value: 0 }, uTime: shared.uTime, uPixel: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aMag; attribute vec3 color;
        varying float vB; varying vec3 vC;
        uniform float uTime; uniform float uPixel;
        void main(){
          vec4 wp = modelMatrix * vec4(position * 30000.0, 1.0);
          vec3 d = normalize(wp.xyz - cameraPosition);
          float tw = 0.75 + 0.25 * sin(uTime * (2.0 + aMag * 7.0) + position.x * 400.0);
          vB = (0.25 + aMag * 5.0) * tw * smoothstep(-0.02, 0.12, d.y);
          vC = color;
          gl_Position = projectionMatrix * viewMatrix * wp;
          gl_Position.z = 0.0;
          gl_PointSize = (1.2 + aMag * 2.2) * uPixel;
        }`,
      fragmentShader: /* glsl */ `
        varying float vB; varying vec3 vC; uniform float uNight;
        void main(){
          vec2 c = gl_PointCoord - 0.5;
          float a = exp(-dot(c,c) * 18.0);
          gl_FragColor = vec4(vC * vB * a * uNight * 0.6, 1.0);
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.stars = new THREE.Points(sg, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -999;
    this.group.add(this.stars);

    // --- moon ---
    this.moonMat = new THREE.ShaderMaterial({
      uniforms: { uSun: { value: new THREE.Vector3() }, uBright: { value: 1 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position.z = 0.0; }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform vec3 uSun; uniform float uBright;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
        void main(){
          vec2 p = vUv * 2.0 - 1.0;
          float r2 = dot(p,p);
          if (r2 > 1.0) discard;
          vec3 nrm = vec3(p, sqrt(1.0 - r2));
          // uSun is sun direction in the moon's local frame
          float lit = smoothstep(-0.05, 0.12, dot(nrm, uSun));
          float maria = 0.75 + 0.25 * n(p * 3.0 + 4.0) - 0.18 * smoothstep(0.55, 0.7, n(p * 1.7 + 1.3));
          vec3 c = vec3(1.0, 0.97, 0.9) * maria * (lit + 0.015);
          gl_FragColor = vec4(c * uBright, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.moon = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.moonMat);
    this.moon.frustumCulled = false;
    this.moon.renderOrder = -998;
    this.group.add(this.moon);

    // --- lights ---
    this.light = new THREE.DirectionalLight(0xffffff, 3);
    this.light.castShadow = true;
    this.light.shadow.bias = -0.0002;
    this.light.shadow.normalBias = 0.03;
    this.hemi = new THREE.HemisphereLight(0x9ec5ff, 0x1a3a4a, 0.0);

    // --- environment ---
    this.envTarget = new THREE.WebGLCubeRenderTarget(256, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
    });
    this.cubeCam = new THREE.CubeCamera(1, 100000, this.envTarget);
    const envSky = new THREE.Mesh(this.sky.geometry, this.sky.material);
    envSky.scale.setScalar(40000);
    this.envScene.add(envSky);
    // ocean below the horizon for the environment: dark blue-green, lit by sky
    this.seaDisc = new THREE.Mesh(
      new THREE.CircleGeometry(60000, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x0b2a3a }),
    );
    this.seaDisc.position.y = -30;
    this.envScene.add(this.seaDisc);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    shared.uFogEnv.value = this.envTarget.texture;
  }

  update(dt: number, camera: THREE.Camera, force = false) {
    const c = this.clock;
    const sun = c.sunDir;
    const moon = c.moonDir;
    this.group.position.copy(camera.position);

    // Preetham sky wants a sun position vector
    this.sky.material.uniforms.sunPosition.value.copy(sun);
    this.sky.material.uniforms.time.value = shared.uTime.value;

    // day/night weights
    const sunY = sun.y;
    this.night = smoothstep(0.05, -0.16, sunY);
    shared.uNight.value = this.night;

    // Sun transmittance through air mass (Kasten-Young), Rayleigh + hazy aerosol
    const altDeg = (Math.asin(clamp(sunY, -1, 1)) * 180) / Math.PI;
    const m = 1 / (Math.max(0.0, Math.sin((Math.max(altDeg, -1) * Math.PI) / 180)) + 0.50572 * Math.pow(Math.max(altDeg, -3.5) + 6.07995, -1.6364));
    const tr = [Math.exp(-(0.045 + 0.06) * m), Math.exp(-(0.1 + 0.07) * m), Math.exp(-(0.23 + 0.08) * m)];
    const sunVis = smoothstep(-0.035, 0.03, sunY);
    this.sunIntensity = 4.2 * sunVis;

    // moon light (bluish, purkinje shift), brightness by phase
    const phaseLight = 0.5 - 0.5 * Math.cos(c.moonPhase * Math.PI * 2);
    const moonVis = smoothstep(-0.02, 0.1, moon.y) * this.night;
    const moonI = 0.22 * phaseLight * moonVis;
    const skyMoon = phaseLight * smoothstep(-0.05, 0.15, moon.y) * smoothstep(0.0, -0.1, sunY);
    (this.sky.material.uniforms.uNightSky.value as THREE.Vector3).set(0.0022, 0.0048, 0.0115).multiplyScalar(skyMoon);
    (this.sky.material.uniforms.uMoonDir.value as THREE.Vector3).copy(moon).normalize();

    const L = this.light;
    const sunColor = shared.uSunColor.value;
    if (sunY > -0.04) {
      L.position.copy(sun);
      sunColor.setRGB(tr[0], tr[1], tr[2]).multiplyScalar(this.sunIntensity);
      shared.uSunDir.value.copy(sun);
    } else {
      L.position.copy(moon);
      sunColor.setRGB(0.55, 0.68, 1.0).multiplyScalar(moonI);
      shared.uSunDir.value.copy(moon);
    }
    L.color.copy(sunColor);
    const li = Math.max(sunColor.r, sunColor.g, sunColor.b);
    L.intensity = 1;
    L.castShadow = li > 0.02;

    // ambient fill is handled by the PMREM environment; a faint night hemisphere avoids pure black
    this.hemi.intensity = 0.05 * this.night;
    this.hemi.color.setRGB(0.35, 0.45, 0.8);

    // stars/moon
    // stars emerge through nautical twilight (sun -3deg .. -12deg), not while the sky is still bright
    this.starMat.uniforms.uNight.value = smoothstep(-0.05, -0.2, sunY);
    this.starMat.uniforms.uPixel.value = this.renderer.getPixelRatio();
    this.stars.rotation.set(0, 0, 0);
    this.stars.quaternion
      .setFromAxisAngle(new THREE.Vector3(1, 0, 0), c.latitude - Math.PI / 2)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -c.siderealAngle));
    const moonDist = 20000;
    this.moon.position.copy(moon).multiplyScalar(moonDist);
    this.moon.updateMatrixWorld();
    this.moon.lookAt(camera.position); // +z (the lit hemisphere's frame) faces the viewer
    this.moon.scale.setScalar(moonDist * 0.034); // ~2deg: exaggerated like the eye perceives it low over the sea
    this.moon.updateMatrixWorld();
    const inv = new THREE.Matrix4().copy(this.moon.matrixWorld).invert();
    const sunLocal = sun.clone().transformDirection(inv);
    this.moonMat.uniforms.uSun.value.copy(sunLocal);
    this.moonMat.uniforms.uBright.value = 1.6 * (0.25 + 0.75 * this.night) * (0.3 + 0.7 * smoothstep(-0.05, 0.05, moon.y));
    this.moon.visible = moon.y > -0.1;

    // eye adaptation: brighter exposure at night, gentle
    // eye adaptation from the scene illuminance (direct sun on a horizontal surface + sky)
    const E = Math.max(sunColor.r, sunColor.g, sunColor.b) * Math.max(shared.uSunDir.value.y, 0) + 0.5 * (1 - this.night) + 0.02;
    const targetExp = 0.62 * Math.pow(1.35 / (E + 0.5), 0.42) * (1 + 5.5 * this.night);
    this.exposure += (targetExp - this.exposure) * (1 - Math.exp(-dt * 1.5));
    if (force) this.exposure = targetExp;

    // environment re-bake when the sun moved or clouds drifted
    this.bakeTimer += dt;
    if (force || this.lastBakeSun.distanceToSquared(sun) > 2e-5 || this.bakeTimer > 3) {
      this.bakeEnvironment();
    }
  }

  bakeEnvironment() {
    this.bakeTimer = 0;
    this.lastBakeSun.copy(this.clock.sunDir);
    const u = this.sky.material.uniforms;
    u.showSunDisc.value = 0;
    // sea colour in the environment follows sky brightness
    const k = 0.25 + 0.75 * (1 - this.night);
    (this.seaDisc.material as THREE.MeshBasicMaterial).color.setRGB(0.012 * k, 0.05 * k, 0.07 * k);
    this.envScene.position.set(0, 0, 0);
    this.cubeCam.position.set(0, 0, 0);
    this.cubeCam.update(this.renderer, this.envScene);
    u.showSunDisc.value = 1;
    const prev = this.pmremTarget;
    this.pmremTarget = this.pmrem.fromCubemap(this.envTarget.texture);
    this.envMap = this.pmremTarget.texture;
    prev?.dispose();
  }
}
