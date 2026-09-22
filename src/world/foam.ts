import * as THREE from 'three';
import type { ShipPhysics } from '../ship/physics';
import type { Trireme } from '../ship/trireme';
import { HULL_LENGTH, RAM_LENGTH, halfBeam, zOf } from '../ship/hull';

/**
 * Wake & foam map. Foam "particles" live in world space on the water (Kelvin wake arms spreading at
 * the 19.47° Kelvin angle, stern wash, hull-side foam, oar splashes). Each frame they are splatted
 * into a ship-centred render target (R = white foam, G = turbulence) that the ocean shader samples.
 */
const MAX = 6000;
const KELVIN = Math.tan((19.47 * Math.PI) / 180);

interface P {
  x: number;
  z: number;
  vx: number;
  vz: number;
  age: number;
  life: number;
  size0: number;
  size1: number;
  foam: number;
  turb: number;
  ring: number;
}

export class FoamSystem {
  readonly target: THREE.WebGLRenderTarget;
  readonly size = 640; // metres covered
  readonly center = new THREE.Vector2();
  private scene = new THREE.Scene();
  private cam: THREE.OrthographicCamera;
  private mesh: THREE.InstancedMesh;
  private aData: THREE.InstancedBufferAttribute; // x, z, size, foam
  private aData2: THREE.InstancedBufferAttribute; // turb, ring, age01, seed
  private parts: P[] = [];
  private distAcc = 0;
  private lastPos = new THREE.Vector3();
  private sideAcc = 0;
  private wasIn: boolean[] = [];

  constructor(res = 1024) {
    this.target = new THREE.WebGLRenderTarget(res, res, { type: THREE.HalfFloatType, depthBuffer: false });
    this.cam = new THREE.OrthographicCamera(-this.size / 2, this.size / 2, this.size / 2, -this.size / 2, -10, 10);
    this.cam.up.set(0, 0, -1);
    this.cam.position.set(0, 5, 0);
    this.cam.lookAt(0, 0, 0);
    const geo = new THREE.InstancedBufferGeometry();
    const base = new THREE.PlaneGeometry(1, 1);
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('uv', base.attributes.uv);
    this.aData = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    this.aData2 = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    this.aData.setUsage(THREE.DynamicDrawUsage);
    this.aData2.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aData', this.aData);
    geo.setAttribute('aData2', this.aData2);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uCenter: { value: this.center } },
      vertexShader: /* glsl */ `
        attribute vec4 aData; attribute vec4 aData2;
        uniform vec2 uCenter;
        varying vec2 vUv; varying vec4 vD; varying vec4 vD2;
        void main(){
          vUv = uv; vD = aData; vD2 = aData2;
          vec2 p = aData.xy - uCenter + position.xy * aData.z;
          gl_Position = projectionMatrix * viewMatrix * vec4(p.x, 0.0, p.y, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying vec4 vD; varying vec4 vD2;
        float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main(){
          vec2 c = vUv - 0.5;
          float r = length(c) * 2.0;
          float blob = exp(-r * r * 3.5);
          float ring = exp(-pow((r - 0.7) * 5.0, 2.0));
          float shape = mix(blob, ring, vD2.y);
          // breakup: foam tears apart as it ages
          float n = h(floor(vUv * 9.0) + vD2.w * 17.0);
          shape *= mix(1.0, smoothstep(0.2 + vD2.z * 0.6, 1.0, n + 0.3), vD2.z);
          gl_FragColor = vec4(vD.w * shape, vD2.x * blob, 0.0, 1.0);
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.InstancedMesh(geo as unknown as THREE.BufferGeometry, mat, MAX);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.scene.add(this.mesh);
  }

  private spawn(p: Partial<P> & { x: number; z: number }) {
    if (this.parts.length >= MAX) this.parts.shift();
    this.parts.push({ vx: 0, vz: 0, age: 0, life: 20, size0: 2, size1: 6, foam: 0.6, turb: 0.4, ring: 0, ...p });
  }

  update(dt: number, ship: ShipPhysics, model: Trireme, renderer: THREE.WebGLRenderer) {
    const q = ship.quat;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    fwd.y = 0;
    fwd.normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const speed = Math.max(0, ship.speed);
    const vAbs = Math.hypot(ship.vel.x, ship.vel.z);
    const moved = this.lastPos.distanceTo(ship.pos);
    this.lastPos.copy(ship.pos);
    if (moved < 20) this.distAcc += moved;

    const bow = ship.toWorld(new THREE.Vector3(0, 0, -HULL_LENGTH / 2 - RAM_LENGTH * 0.6), new THREE.Vector3());
    const stern = ship.toWorld(new THREE.Vector3(0, 0, zOf(0.93)), new THREE.Vector3());
    // spawn by distance travelled so the trail is continuous at any speed
    const spacing = 1.2;
    while (this.distAcc > spacing && vAbs > 0.3) {
      this.distAcc -= spacing;
      const k = Math.min(1, vAbs / 5);
      // Kelvin arms: foam rides outward from the bow at v*tan(19.47deg)
      for (const s of [-1, 1]) {
        const off = s * 0.8;
        this.spawn({
          x: bow.x + right.x * off,
          z: bow.z + right.z * off,
          vx: right.x * s * vAbs * KELVIN,
          vz: right.z * s * vAbs * KELVIN,
          life: 26 + 10 * k,
          size0: 1.6,
          size1: 9,
          foam: 0.55 * k + 0.1,
          turb: 0.5 * k,
        });
      }
      // stern wash: broad turbulent band
      this.spawn({
        x: stern.x + (Math.random() - 0.5) * 2,
        z: stern.z + (Math.random() - 0.5) * 2,
        vx: fwd.x * vAbs * 0.15,
        vz: fwd.z * vAbs * 0.15,
        life: 45,
        size0: 5,
        size1: 22,
        foam: 0.5 * k,
        turb: 0.9 * k + 0.1,
      });
    }
    // hull-side foam where the bow wave rolls along the hull
    this.sideAcc += dt * speed * 6;
    while (this.sideAcc > 1 && speed > 1) {
      this.sideAcc -= 1;
      const s = Math.random() * 0.5 + 0.05;
      const side = Math.random() < 0.5 ? -1 : 1;
      const lp = new THREE.Vector3(side * (halfBeam(s) + 0.3), 0, zOf(s));
      const wp = ship.toWorld(lp, lp);
      this.spawn({ x: wp.x, z: wp.z, vx: right.x * side * 0.6, vz: right.z * side * 0.6, life: 10, size0: 1.2, size1: 4, foam: 0.5 * Math.min(1, speed / 4), turb: 0.3 });
    }
    // bow slamming into a wave throws a burst of foam
    if (ship.bowSlam > 1.5 && speed > 1.5) {
      for (let i = 0; i < 6; i++)
        this.spawn({ x: bow.x + (Math.random() - 0.5) * 4, z: bow.z + (Math.random() - 0.5) * 4, vx: (Math.random() - 0.5) * 2, vz: (Math.random() - 0.5) * 2, life: 12, size0: 2, size1: 7, foam: 0.8, turb: 0.6 });
    }
    // oar splashes: ring where each blade enters the water, and a puddle where it leaves
    for (let i = 0; i < model.bladeWorld.length; i++) {
      const inW = model.bladeIn[i];
      const was = this.wasIn[i] ?? false;
      if (inW !== was) {
        const b = model.bladeWorld[i];
        this.spawn({ x: b.x, z: b.z, life: inW ? 5 : 9, size0: inW ? 0.6 : 0.9, size1: inW ? 2.4 : 3.2, foam: inW ? 0.7 : 0.45, turb: 0.5, ring: inW ? 1 : 0 });
      }
      this.wasIn[i] = inW;
    }

    // advance & pack
    this.center.set(Math.round(ship.pos.x), Math.round(ship.pos.z));
    let n = 0;
    const a = this.aData.array as Float32Array,
      b = this.aData2.array as Float32Array;
    const alive: P[] = [];
    for (const p of this.parts) {
      p.age += dt;
      if (p.age >= p.life) continue;
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      const damping = Math.exp(-dt * 0.08);
      p.vx *= damping;
      p.vz *= damping;
      alive.push(p);
      const t = p.age / p.life;
      const fade = (1 - t) * (1 - t) * Math.min(1, p.age * 6);
      a[n * 4] = p.x;
      a[n * 4 + 1] = p.z;
      a[n * 4 + 2] = p.size0 + (p.size1 - p.size0) * Math.sqrt(t);
      a[n * 4 + 3] = p.foam * fade;
      b[n * 4] = p.turb * (1 - t);
      b[n * 4 + 1] = p.ring;
      b[n * 4 + 2] = t;
      b[n * 4 + 3] = (n * 0.618) % 1;
      n++;
    }
    this.parts = alive;
    this.mesh.count = n;
    this.aData.needsUpdate = true;
    this.aData2.needsUpdate = true;
    this.aData.clearUpdateRanges();
    this.aData.addUpdateRange(0, n * 4);
    this.aData2.clearUpdateRanges();
    this.aData2.addUpdateRange(0, n * 4);

    const prevT = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.render(this.scene, this.cam);
    renderer.setRenderTarget(prevT);
  }
}
