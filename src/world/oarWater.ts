import * as THREE from 'three';
import type { ShipPhysics } from '../ship/physics';
import type { ShipVisual } from '../ship/shipVisual';
import type { RowEventCursor } from '../ship/rowing';
import type { WaveField } from './waves';
import { FOG_PARS_GLSL, shared } from '../gfx/shared';
import { registerEnvironmentMaterial } from '../gfx/environmentMaterials';
import { LAYER_NOREFLECT } from '../core/pipeline';
import { TRIREME_HULL, type HullShape } from '../ship/hullShape';

/**
 * Close-up water response to the oars, all driven by the blades' actual rendered poses and the
 * physics contact events:
 *
 * - a fine ship-centred disturbance map (~9 cm texels) that the ocean shader reads as surface slope
 *   (R,G = dh/dx, dh/dz, additive), entrained air (B) and a glassy slick (A): expanding ripple rings
 *   at the catch and under every drip, the swirling vortex "puddles" each blade leaves behind, and the
 *   bubble boil the blade face drags through the water during the drive;
 * - 3D spray: the catch splash, the sheet peeling off the blade at extraction, drip trails during the
 *   recovery (each drip rings the water where it lands);
 * - wet wood: how far up each loom the sea reached and how recently, for the oar shader.
 */
const MAX_RIPPLES = 9000;
const MAX_SPRAY = 7000;
const RING = 0, VORTEX = 1, BOIL = 2;
const DROP = 0, MIST = 1;
const G = 9.81;

let seed = 0x2545f491;
const rand = () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
};
const sym = () => rand() * 2 - 1;

export class OarWater {
  readonly target: THREE.WebGLRenderTarget;
  readonly size = 96; // metres covered by the disturbance map
  readonly center = new THREE.Vector2();
  /** world-space spray; add to the scene */
  readonly spray: THREE.Mesh;
  private res: number;
  private scene = new THREE.Scene();
  private cam: THREE.OrthographicCamera;
  private rippleMesh: THREE.Mesh;
  private rippleGeo: THREE.InstancedBufferGeometry;
  private sprayGeo: THREE.InstancedBufferGeometry;
  private rA: THREE.InstancedBufferAttribute; private rB: THREE.InstancedBufferAttribute;
  private sA: THREE.InstancedBufferAttribute; private sB: THREE.InstancedBufferAttribute; private sC: THREE.InstancedBufferAttribute;

  // ripple particles (structure of arrays, swap-remove)
  private rn = 0;
  private rx = new Float32Array(MAX_RIPPLES); private rz = new Float32Array(MAX_RIPPLES);
  private rAge = new Float32Array(MAX_RIPPLES); private rLife = new Float32Array(MAX_RIPPLES);
  private rKind = new Uint8Array(MAX_RIPPLES); private rAmp = new Float32Array(MAX_RIPPLES);
  private rSize = new Float32Array(MAX_RIPPLES); private rParam = new Float32Array(MAX_RIPPLES);
  // spray particles
  private sn = 0;
  private sp = new Float32Array(MAX_SPRAY * 3); private sv = new Float32Array(MAX_SPRAY * 3);
  private sAge = new Float32Array(MAX_SPRAY); private sLife = new Float32Array(MAX_SPRAY);
  private sSize = new Float32Array(MAX_SPRAY); private sKind = new Uint8Array(MAX_SPRAY);
  private sLand = new Float32Array(MAX_SPRAY); private sSeed = new Float32Array(MAX_SPRAY);

  // per-blade state
  private n = 0;
  private prev = new Float32Array(0); private vel = new Float32Array(0); private hasPrev = new Uint8Array(0);
  private water = new Float32Array(0);
  /** loom coordinate (m from the thole) outboard of which the wood is wet */
  wetLine = new Float32Array(0);
  /** soaked darkening 0..1 and surface film gloss 0..1 */
  soak = new Float32Array(0);
  film = new Float32Array(0);
  private drip = new Float32Array(0); private dripAcc = new Float32Array(0); private boilAcc = new Float32Array(0);
  private cursor: RowEventCursor | null = null;
  private tmp = new THREE.Vector3();
  private viewH = { value: 1080 };
  private size2 = new THREE.Vector2();
  private fwd = new THREE.Vector3();
  private readonly hull: HullShape;

  constructor(res = 1024, hull: HullShape = TRIREME_HULL) {
    this.hull = hull;
    this.res = res;
    this.target = new THREE.WebGLRenderTarget(res, res, { type: THREE.HalfFloatType, depthBuffer: false });
    this.target.texture.minFilter = this.target.texture.magFilter = THREE.LinearFilter;
    this.target.texture.generateMipmaps = false;
    // same top-down convention as the foam map (up = -z), so the ocean uses the same uv mapping
    this.cam = new THREE.OrthographicCamera(-this.size / 2, this.size / 2, this.size / 2, -this.size / 2, -10, 10);
    this.cam.up.set(0, 0, -1);
    this.cam.position.set(0, 5, 0);
    this.cam.lookAt(0, 0, 0);

    const quad = new THREE.PlaneGeometry(1, 1);
    // ---------- disturbance splats ----------
    this.rippleGeo = new THREE.InstancedBufferGeometry();
    this.rippleGeo.index = quad.index;
    this.rippleGeo.setAttribute('position', quad.attributes.position);
    this.rippleGeo.setAttribute('uv', quad.attributes.uv);
    this.rA = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RIPPLES * 4), 4); // x, z (map-relative), quad size, kind
    this.rB = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RIPPLES * 4), 4); // age, life, amp, param
    for (const a of [this.rA, this.rB]) a.setUsage(THREE.DynamicDrawUsage);
    this.rippleGeo.setAttribute('aA', this.rA);
    this.rippleGeo.setAttribute('aB', this.rB);
    this.rippleGeo.instanceCount = 0;
    const rippleMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute vec4 aA; attribute vec4 aB;
        varying vec2 vD; varying vec4 vA; varying vec4 vB;
        void main(){
          vA = aA; vB = aB;
          vD = position.xy * aA.z; // world offset (dx, dz) from the splat centre
          vec2 p = aA.xy + vD;
          gl_Position = projectionMatrix * viewMatrix * vec4(p.x, 0.0, p.y, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vD; varying vec4 vA; varying vec4 vB;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        float vnoise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + 1.0), f.x), f.y);
        }
        void main(){
          float age = vB.x, f = clamp(vB.x / vB.y, 0.0, 1.0), amp = vB.z, param = vB.w;
          float r = length(vD);
          vec2 dir = vD / max(r, 1e-4);
          vec2 tang = vec2(-dir.y, dir.x);
          vec4 o = vec4(0.0);
          float edge = 1.0 - smoothstep(0.42, 0.5, r / vA.z); // stay inside the quad
          if (vA.w < 0.5) {
            // ring: a short capillary-gravity packet running outward, spreading and dying
            // the shortest ring the map can carry cleanly is ~4 texels; finer capillaries come from the FFT
            float lambda = 0.36 + 0.3 * f;
            float k = 6.2832 / lambda;
            float R = param * age + 0.05;
            float w = lambda * 0.75;
            float x = r - R;
            float env = exp(-x * x / (w * w)) * amp * pow(1.0 - f, 1.6) / sqrt(1.0 + 6.0 * R);
            float dhdr = env * (k * cos(k * x) - 2.0 * x / (w * w) * sin(k * x));
            o.xy = dir * dhdr;
          } else if (vA.w < 1.5) {
            // vortex puddle: a dimple with a low rim and two spiral arms turning with the swirl
            float sig = vA.z / 6.0 - 0.04 * vB.y + 0.04 * age;
            float rise = smoothstep(0.0, 0.25, age);
            float D = amp * rise * pow(1.0 - f, 1.3);
            float q = r / sig;
            float g = exp(-q * q);
            // h = -D g (1 - 0.6 q^2): dimple plus rim
            float dhdr = D * g * (2.0 * q * (1.0 - 0.6 * q * q) + 1.2 * q) / sig;
            float th = atan(vD.y, vD.x);
            float spin = param;
            float ph = 2.0 * th + spin * (3.5 * q - age * 5.0);
            float arm = 0.45 * D * q * exp(-q * q * 0.45);
            // gradient of arm * sin(ph): radial and tangential parts
            float darm = 0.45 * D * exp(-q * q * 0.45) * (1.0 - 0.9 * q * q) / sig;
            float dr = darm * sin(ph) + arm * cos(ph) * spin * 3.5 / sig;
            float dt = arm * cos(ph) * 2.0 / max(r, 0.02);
            o.xy = dir * (dhdr + dr) + tang * dt;
            o.z = 0.12 * rise * pow(1.0 - f, 2.0) * exp(-pow((q - 1.1) * 1.6, 2.0)) * smoothstep(0.0, 0.5, sin(ph) + 0.4);
            o.w = 0.8 * g * (1.0 - f);
          } else {
            // boil: entrained air carried down by the blade face, fraying as it rises and clears
            float rad = vA.z * (0.3 + 0.25 * sqrt(f));
            float q = r / rad;
            float h = vnoise(vD * 4.0 + param) * 0.65 + vnoise(vD * 9.0 - param) * 0.35;
            float body = exp(-q * q * 2.2);
            o.z = amp * body * pow(1.0 - f, 1.5) * mix(1.0, smoothstep(0.15 + 0.7 * f, 1.0, h + 0.25), 0.6 + 0.4 * f);
            o.w = 0.6 * body * (1.0 - f);
          }
          gl_FragColor = o * edge;
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
      side: THREE.DoubleSide,
    });
    this.rippleMesh = new THREE.Mesh(this.rippleGeo, rippleMat);
    this.rippleMesh.frustumCulled = false;
    this.scene.add(this.rippleMesh);

    // ---------- spray ----------
    this.sprayGeo = new THREE.InstancedBufferGeometry();
    this.sprayGeo.index = quad.index;
    this.sprayGeo.setAttribute('position', quad.attributes.position);
    this.sprayGeo.setAttribute('uv', quad.attributes.uv);
    this.sA = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPRAY * 4), 4); // world xyz, size
    this.sB = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPRAY * 4), 4); // velocity xyz, alpha
    this.sC = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPRAY * 4), 4); // kind, seed, age01, shutter
    for (const a of [this.sA, this.sB, this.sC]) a.setUsage(THREE.DynamicDrawUsage);
    this.sprayGeo.setAttribute('aP', this.sA);
    this.sprayGeo.setAttribute('aV', this.sB);
    this.sprayGeo.setAttribute('aM', this.sC);
    this.sprayGeo.instanceCount = 0;
    const sprayMat = new THREE.ShaderMaterial({
      uniforms: {
        uFogEnv: shared.uFogEnv, uFogDensity: shared.uFogDensity, uFogHeight: shared.uFogHeight,
        uFogEnvNext: shared.uFogEnvNext, uEnvBlend: shared.uEnvBlend,
        uFogEnvScale: shared.uFogEnvScale, uSunDir: shared.uSunDir, uSunColor: shared.uSunColor,
        uViewH: this.viewH,
      },
      vertexShader: /* glsl */ `
        attribute vec4 aP; attribute vec4 aV; attribute vec4 aM;
        uniform float uViewH;
        varying vec2 vQ; varying float vAlpha; varying vec4 vM; varying vec3 vWorld;
        void main(){
          vM = aM; vQ = position.xy * 2.0; vWorld = aP.xyz;
          vec4 mv = viewMatrix * vec4(aP.xyz, 1.0);
          // drops streak along their screen-plane motion over a film-like shutter
          vec3 vv = (viewMatrix * vec4(aV.xyz, 0.0)).xyz;
          float sl = length(vv.xy);
          vec2 ax = sl > 1e-4 ? vv.xy / sl : vec2(0.0, 1.0);
          vec2 ay = vec2(ax.y, -ax.x); // (ay, ax) keeps the quad's winding facing the camera
          float len = aP.w + sl * aM.w;
          // never thinner than ~1.2 px, fading instead, so far drops don't shimmer
          float px = 1.2 * 2.0 * -mv.z / (projectionMatrix[1][1] * uViewH);
          float wid = max(aP.w, px);
          vAlpha = aV.w * min(1.0, aP.w / max(px, 1e-5)) * (1.0 - smoothstep(70.0, 220.0, -mv.z));
          mv.xy += ax * position.y * max(len, wid) + ay * position.x * wid;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        ${FOG_PARS_GLSL}
        varying vec2 vQ; varying float vAlpha; varying vec4 vM; varying vec3 vWorld;
        void main(){
          float r2 = dot(vQ, vQ);
          if (r2 > 1.0) discard;
          vec3 L = normalize(uSunDir);
          vec3 V = normalize(vWorld - cameraPosition);
          vec3 skyIrr = sampleSkyEnv(vec3(0.0, 1.0, 0.0), 5.0);
          float sun = max(L.y, 0.0);
          // white water: the same light balance the ocean uses for foam
          vec3 white = uSunColor * (sun * 0.3 + 0.05) + skyIrr * 0.95;
          float a;
          vec3 col;
          if (vM.x < 0.5) {
            // drop: a clear lens, bright rim, with a forward-scattered glint toward the sun
            float rim = smoothstep(0.2, 0.9, r2);
            float glint = pow(max(dot(V, L), 0.0), 7.0) * 2.5 + step(0.82, fract(vM.y * 7.31 + vM.z * 3.0)) * 0.6 * sun;
            col = white * (0.4 + 0.55 * rim) + uSunColor * glint * 0.35;
            a = (1.0 - r2 * r2) * (0.4 + 0.25 * rim);
          } else {
            // mist: soft, mostly forward-scattering
            float fwdS = pow(max(dot(V, L), 0.0), 4.0);
            col = white * 0.9 + uSunColor * fwdS * 0.25;
            a = (1.0 - r2) * (1.0 - r2) * 0.1;
          }
          a *= vAlpha;
          col = applyAerial(col, vWorld);
          gl_FragColor = vec4(col, a);
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    registerEnvironmentMaterial(sprayMat);
    this.spray = new THREE.Mesh(this.sprayGeo, sprayMat);
    this.spray.frustumCulled = false;
    this.spray.renderOrder = 30;
    this.spray.layers.set(LAYER_NOREFLECT);
  }

  private ensure(n: number) {
    if (this.n === n) return;
    this.n = n;
    this.prev = new Float32Array(n * 3); this.vel = new Float32Array(n * 3); this.hasPrev = new Uint8Array(n);
    this.water = new Float32Array(n);
    this.wetLine = new Float32Array(n).fill(99);
    this.soak = new Float32Array(n);
    this.film = new Float32Array(n);
    this.drip = new Float32Array(n); this.dripAcc = new Float32Array(n); this.boilAcc = new Float32Array(n);
  }

  private ripple(kind: number, x: number, z: number, life: number, amp: number, size: number, param: number) {
    let i = this.rn;
    if (i >= MAX_RIPPLES) i = Math.floor(rand() * MAX_RIPPLES); // full: overwrite something at random
    else this.rn++;
    this.rx[i] = x; this.rz[i] = z; this.rAge[i] = 0; this.rLife[i] = life; this.rKind[i] = kind;
    this.rAmp[i] = amp; this.rSize[i] = size; this.rParam[i] = param;
  }

  private drop(kind: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, land: number) {
    let i = this.sn;
    if (i >= MAX_SPRAY) i = Math.floor(rand() * MAX_SPRAY);
    else this.sn++;
    const o = i * 3;
    this.sp[o] = x; this.sp[o + 1] = y; this.sp[o + 2] = z;
    this.sv[o] = vx; this.sv[o + 1] = vy; this.sv[o + 2] = vz;
    this.sAge[i] = 0; this.sLife[i] = life; this.sSize[i] = size; this.sKind[i] = kind; this.sLand[i] = land; this.sSeed[i] = rand();
  }

  update(dt: number, ship: ShipPhysics, model: ShipVisual, waves: WaveField, renderer: THREE.WebGLRenderer, renderTime = ship.time, consumeEvents = true) {
    const rowing = ship.rowing, slots = rowing.slots;
    this.ensure(slots.length);
    const t = renderTime;
    const live = dt > 0;

    // ---------- per blade: motion, water level, wet wood, drips, boil ----------
    for (const slot of slots) {
      const i = slot.id, o = i * 3;
      const c = model.bladeWorld[i], ax = model.bladeAxis[i];
      if (this.hasPrev[i] && live) {
        const k = 1 - Math.exp(-dt / 0.03);
        this.vel[o] += ((c.x - this.prev[o]) / dt - this.vel[o]) * k;
        this.vel[o + 1] += ((c.y - this.prev[o + 1]) / dt - this.vel[o + 1]) * k;
        this.vel[o + 2] += ((c.z - this.prev[o + 2]) / dt - this.vel[o + 2]) * k;
      }
      // a jump (teleport, reset) is not motion
      if (!this.hasPrev[i] || Math.abs(c.x - this.prev[o]) + Math.abs(c.z - this.prev[o + 2]) > 5) this.vel.fill(0, o, o + 3);
      this.prev[o] = c.x; this.prev[o + 1] = c.y; this.prev[o + 2] = c.z; this.hasPrev[i] = 1;
      const h = waves.heightAt(c.x, c.z, t);
      this.water[i] = h;
      if (!live) continue;
      const vx = this.vel[o], vy = this.vel[o + 1], vz = this.vel[o + 2];

      // where the loom crosses the surface, measured from the thole along the loom
      const half = slot.bladeLength / 2;
      const tip = slot.bladeRadius + half;
      const pivotY = c.y - ax.y * slot.bladeRadius;
      let xw = Infinity;
      if (ax.y < -0.01) xw = (pivotY - h) / -ax.y;
      else if (pivotY < h) xw = -slot.inboard;
      // lowest corner of the blade: the tip when dipped, the lower edge when feathered
      const wa = model.bladeWidthAxis[i];
      const lowY = c.y - half * Math.abs(ax.y) - slot.bladeWidth / 2 * Math.abs(wa.y);
      const wetNow = xw < tip - 0.02;
      const dryRate = 0.035;
      if (wetNow) {
        this.wetLine[i] = Math.min(this.wetLine[i] + dryRate * dt, xw);
        this.soak[i] = 1; this.film[i] = 1;
        this.drip[i] = Math.min(1, this.drip[i] + dt * 6);
      } else {
        this.wetLine[i] = Math.min(tip + 0.1, this.wetLine[i] + dryRate * dt);
        this.soak[i] *= Math.exp(-dt / 14);
        this.film[i] *= Math.exp(-dt / 1.6);
        this.drip[i] *= Math.exp(-dt / 0.75);
      }

      // drips once the blade is clear of the water: from the low edge, carried with the blade
      if (lowY > h + 0.015 && this.drip[i] > 0.04) {
        this.dripAcc[i] += dt * 24 * this.drip[i] * this.drip[i];
        while (this.dripAcc[i] >= 1) {
          this.dripAcc[i] -= 1;
          // bias toward the tip and the lower edge: water runs down and off the end
          const l = half * (1 - Math.pow(rand(), 1.8) * 2);
          const s = rand() * 0.6 + 0.4;
          const down = wa.y > 0 ? -1 : 1;
          const px = c.x + ax.x * l + wa.x * down * slot.bladeWidth / 2 * s;
          const py = c.y + ax.y * l + wa.y * down * slot.bladeWidth / 2 * s;
          const pz = c.z + ax.z * l + wa.z * down * slot.bladeWidth / 2 * s;
          this.drop(DROP, px, py, pz, vx * 0.95 + sym() * 0.08, vy * 0.6 - 0.15, vz * 0.95 + sym() * 0.08, 0.01 + rand() * 0.008, 2, h);
        }
      } else this.dripAcc[i] = 0;

      // drive: the loaded face drags a boil of entrained air through the water
      const contact = rowing.current.contact[i] !== 0;
      if (contact) {
        const f = Math.hypot(rowing.current.forceWorld[o], rowing.current.forceWorld[o + 1], rowing.current.forceWorld[o + 2]);
        const load = Math.min(1, f / 260);
        const slip = Math.hypot(vx - ship.vel.x, vz - ship.vel.z);
        this.boilAcc[i] += dt * (2 + 3 * load);
        while (this.boilAcc[i] >= 1) {
          this.boilAcc[i] -= 1;
          const l = half * sym() * 0.8;
          this.ripple(BOIL, c.x + ax.x * l + sym() * 0.08, c.z + ax.z * l + sym() * 0.08, 1.6 + rand() * 1.2, 0.05 + 0.14 * load, 0.6 + 0.4 * load, rand() * 50);
        }
        // a moving loom/blade cutting the surface sheds small rings
        if (slip > 0.6 && rand() < dt * 6 * Math.min(1, slip / 2)) {
          const wx2 = c.x - ax.x * half * 0.9, wz2 = c.z - ax.z * half * 0.9;
          this.ripple(RING, wx2, wz2, 1.6, 0.006, 1.8, 0.45);
        }
      } else this.boilAcc[i] = 0;
    }
    for (const slot of slots) model.setOarWet(slot.id, this.wetLine[slot.id], this.soak[slot.id], this.film[slot.id]);

    // ---------- contact events at their recorded time and place ----------
    if (!this.cursor || this.cursor.epoch !== rowing.events.generation) {
      this.cursor = { next: rowing.events.oldestId, epoch: rowing.events.generation };
    }
    if (consumeEvents) rowing.events.read(this.cursor, renderTime, (e) => {
      if (e.kind === 'catchBeat' || e.bladeId < 0) return;
      const i = e.bladeId, o = i * 3, slot = slots[i];
      const I = Math.min(1, Math.max(0.08, e.intensity));
      const ax = model.bladeAxis[i];
      const vx = this.vel[o], vy = this.vel[o + 1], vz = this.vel[o + 2];
      const h = waves.heightAt(e.x, e.z, e.time);
      // horizontal loom direction for spreading things along the blade
      const al = Math.hypot(ax.x, ax.z) || 1, hx = ax.x / al, hz = ax.z / al;
      const half = slot.bladeLength / 2;
      if (e.kind === 'enterWater') {
        // catch: a crown of drops thrown up and back off the entering blade
        const n = Math.round(4 + 12 * I);
        for (let k = 0; k < n; k++) {
          const l = half * sym();
          const up = 0.8 + 2.2 * I * (0.4 + 0.6 * rand());
          const spread = 0.25 + 0.6 * I;
          this.drop(DROP, e.x + hx * l, h + 0.02, e.z + hz * l,
            -vx * 0.25 + sym() * spread, up, -vz * 0.25 + sym() * spread, 0.014 + rand() * 0.018 * (0.5 + I), 2.5, h);
        }
        if (I > 0.6 && rand() < 0.4) this.drop(MIST, e.x, h + 0.08, e.z, sym() * 0.3, 0.5 + 0.5 * I, sym() * 0.3, 0.12 + 0.12 * I, 0.6, h - 1);
        this.ripple(RING, e.x, e.z, 2.6, 0.012 + 0.02 * I, 3.4, 0.62);
        this.ripple(BOIL, e.x, e.z, 1.4 + I, 0.2 + 0.35 * I, 0.8, rand() * 50);
      } else {
        // extraction: the water sheet tears off the blade into drops and a little mist
        const n = Math.round(6 + 16 * I);
        for (let k = 0; k < n; k++) {
          const l = half * sym();
          const lift = 0.3 + 1.3 * rand() * (0.4 + I);
          this.drop(DROP, e.x + hx * l, Math.max(e.y, h) + 0.03, e.z + hz * l,
            vx * (0.6 + 0.3 * rand()) + sym() * 0.25, Math.max(vy, 0) * 0.5 + lift, vz * (0.6 + 0.3 * rand()) + sym() * 0.25,
            0.012 + rand() * 0.016 * (0.5 + I), 2.5, h);
        }
        if (I > 0.45 && rand() < 0.4) this.drop(MIST, e.x, h + 0.1, e.z, vx * 0.4, 0.4 + 0.4 * I, vz * 0.4, 0.12 + 0.15 * I, 0.7, h - 1);
        // the stroke's puddle pair: counter-rotating vortices shed from the two ends of the blade
        const depth = 0.012 + 0.03 * I;
        const life = 5 + 4 * I;
        const sz = 0.13 + 0.06 * I;
        this.ripple(VORTEX, e.x + hx * half * 0.85, e.z + hz * half * 0.85, life, depth, sz, 1);
        this.ripple(VORTEX, e.x - hx * half * 0.85, e.z - hz * half * 0.85, life, depth, sz, -1);
        this.ripple(BOIL, e.x, e.z, 2.5 + 2 * I, 0.15 + 0.3 * I, 1.1 + 0.4 * I, rand() * 50);
        this.ripple(RING, e.x, e.z, 2.2, 0.008 + 0.012 * I, 3.0, 0.5);
      }
    });

    // ---------- advance spray ----------
    let j = 0;
    const sa = this.sA.array as Float32Array, sb = this.sB.array as Float32Array, sc = this.sC.array as Float32Array;
    for (let i = 0; i < this.sn; i++) {
      const o = i * 3;
      let x = this.sp[o], y = this.sp[o + 1], z = this.sp[o + 2];
      let vx = this.sv[o], vy = this.sv[o + 1], vz = this.sv[o + 2];
      const kind = this.sKind[i];
      let age = this.sAge[i];
      if (live) {
        age += dt;
        if (kind === MIST) {
          const d = Math.exp(-dt * 2.5);
          vx *= d; vy = vy * d - 0.6 * dt; vz *= d;
        } else {
          const d = Math.exp(-dt * 0.15);
          vx *= d; vz *= d; vy = vy * d - G * dt;
        }
        x += vx * dt; y += vy * dt; z += vz * dt;
      }
      if (age >= this.sLife[i]) continue;
      if (kind === DROP && y < this.sLand[i]) {
        // landed: ring the water, bigger drops more (a sample of them; the rest are lost in the others' rings)
        const s = this.sSize[i];
        if (rand() < 0.35 + s * 12) this.ripple(RING, x, z, 1.2 + s * 25, 0.002 + s * 0.25 * Math.min(1, -vy / 4), 1.4, 0.3 + s * 4);
        continue;
      }
      // compact in place
      const p = j * 3;
      this.sp[p] = x; this.sp[p + 1] = y; this.sp[p + 2] = z;
      this.sv[p] = vx; this.sv[p + 1] = vy; this.sv[p + 2] = vz;
      this.sAge[j] = age; this.sLife[j] = this.sLife[i]; this.sSize[j] = this.sSize[i];
      this.sKind[j] = kind; this.sLand[j] = this.sLand[i]; this.sSeed[j] = this.sSeed[i];
      const f = age / this.sLife[j];
      const q = j * 4;
      const grow = kind === MIST ? 1 + 1.5 * f : 1;
      sa[q] = x; sa[q + 1] = y; sa[q + 2] = z; sa[q + 3] = this.sSize[j] * grow;
      sb[q] = vx; sb[q + 1] = vy; sb[q + 2] = vz;
      sb[q + 3] = kind === MIST ? (1 - f) * Math.min(1, age * 10) : Math.min(1, age * 30) * (1 - f * f);
      sc[q] = kind; sc[q + 1] = this.sSeed[j]; sc[q + 2] = f; sc[q + 3] = kind === MIST ? 0 : 1 / 55;
      j++;
    }
    this.sn = j;
    this.sprayGeo.instanceCount = j;
    for (const a of [this.sA, this.sB, this.sC]) { a.clearUpdateRanges(); a.addUpdateRange(0, j * 4); a.needsUpdate = true; }

    // ---------- advance and pack the disturbance splats ----------
    // centred a little aft so the puddle trail stays in the map
    this.fwd.set(0, 0, -1).applyQuaternion(ship.quat);
    this.fwd.y = 0;
    this.fwd.normalize();
    const texel = this.size / this.res;
    this.tmp.copy(ship.pos).addScaledVector(this.fwd, -this.hull.length * 0.4);
    this.center.set(Math.round(this.tmp.x / texel) * texel, Math.round(this.tmp.z / texel) * texel);
    const ra = this.rA.array as Float32Array, rb = this.rB.array as Float32Array;
    const lim = this.size / 2 + 4;
    j = 0;
    for (let i = 0; i < this.rn; i++) {
      const age = this.rAge[i] + dt;
      if (age >= this.rLife[i]) continue;
      const dx = this.rx[i] - this.center.x, dz = this.rz[i] - this.center.y;
      if (Math.abs(dx) > lim || Math.abs(dz) > lim) continue;
      this.rx[j] = this.rx[i]; this.rz[j] = this.rz[i]; this.rAge[j] = age; this.rLife[j] = this.rLife[i];
      this.rKind[j] = this.rKind[i]; this.rAmp[j] = this.rAmp[i]; this.rSize[j] = this.rSize[i]; this.rParam[j] = this.rParam[i];
      const kind = this.rKind[j];
      // quad must contain the whole pattern for its life
      const quad = kind === RING ? 2 * (this.rParam[j] * this.rLife[j] + 0.9) : kind === VORTEX ? 6 * (this.rSize[j] + 0.04 * this.rLife[j]) : this.rSize[j] * 1.4;
      const q = j * 4;
      ra[q] = dx; ra[q + 1] = dz; ra[q + 2] = quad; ra[q + 3] = kind;
      rb[q] = age; rb[q + 1] = this.rLife[j]; rb[q + 2] = this.rAmp[j]; rb[q + 3] = this.rParam[j];
      j++;
    }
    this.rn = j;
    this.rippleGeo.instanceCount = j;
    for (const a of [this.rA, this.rB]) { a.clearUpdateRanges(); a.addUpdateRange(0, j * 4); a.needsUpdate = true; }

    this.viewH.value = renderer.getDrawingBufferSize(this.size2).y;
    const prevT = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    if (j > 0) renderer.render(this.scene, this.cam);
    renderer.setRenderTarget(prevT);
  }

  /** splat statistics for the dev overlay / tests */
  get counts() { return { ripples: this.rn, spray: this.sn }; }
}
