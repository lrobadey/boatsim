import * as THREE from 'three';
import type { ShipPhysics } from '../ship/physics';
import type { ShipVisual } from '../ship/shipVisual';
import type { RowEventCursor } from '../ship/rowing';
import { TRIREME_HULL, type HullShape } from '../ship/hullShape';

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
  /** fraction of the life over which the white foam decays (the turbulent slick lasts the whole life) */
  ff: number;
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
  private slamCd = 0;
  private rowingCursor: RowEventCursor | null = null;
  private readonly hull: HullShape;

  constructor(res = 1024, hull: HullShape = TRIREME_HULL) {
    this.hull = hull;
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
      // foam coverage saturates: overlapping splashes take the max, they don't sum to a white sheet
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      side: THREE.DoubleSide, // xy->xz mapping mirrors the winding under the top-down camera
    });
    this.mesh = new THREE.InstancedMesh(geo as unknown as THREE.BufferGeometry, mat, MAX);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.scene.add(this.mesh);
  }

  private spawn(p: Partial<P> & { x: number; z: number }) {
    if (this.parts.length >= MAX) this.parts.shift();
    this.parts.push({ vx: 0, vz: 0, age: 0, life: 20, size0: 2, size1: 6, foam: 0.6, turb: 0.4, ring: 0, ff: 0.6, ...p });
  }

  update(dt: number, ship: ShipPhysics, model: ShipVisual, renderer: THREE.WebGLRenderer, renderTime = ship.time, consumeEvents = true) {
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

    const bow = ship.toWorld(new THREE.Vector3(0, 0, this.hull.zOf(0) - this.hull.bowOverhang * 0.6), new THREE.Vector3());
    const stern = ship.toWorld(new THREE.Vector3(0, 0, this.hull.zOf(0.93)), new THREE.Vector3());
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
          life: 45 + 25 * k,
          size0: 2.2,
          size1: 10,
          foam: 0.65 * k + 0.1,
          turb: 0.6 * k,
          ff: 0.3,
        });
      }
      // stern wash: a rowed hull leaves a broad glassy slick with fraying foam, not a prop wash
      this.spawn({
        x: stern.x + (Math.random() - 0.5) * 2,
        z: stern.z + (Math.random() - 0.5) * 2,
        vx: fwd.x * vAbs * 0.15,
        vz: fwd.z * vAbs * 0.15,
        life: 80,
        size0: 3,
        size1: 18,
        foam: 0.85 * k,
        turb: 0.8 * k + 0.1,
        ff: 0.25,
      });
    }
    // hull-side foam where the bow wave rolls along the hull
    this.sideAcc += dt * speed * 6;
    while (this.sideAcc > 1 && speed > 1) {
      this.sideAcc -= 1;
      const s = Math.random() * 0.5 + 0.05;
      const side = Math.random() < 0.5 ? -1 : 1;
      const lp = new THREE.Vector3(side * (this.hull.halfBeam(s) + 0.3), 0, this.hull.zOf(s));
      const wp = ship.toWorld(lp, lp);
      this.spawn({ x: wp.x, z: wp.z, vx: right.x * side * 0.6, vz: right.z * side * 0.6, life: 8, size0: 1.0, size1: 3.2, foam: 0.75 * Math.min(1, speed / 4), turb: 0.4 });
    }
    // bow slamming into a wave throws a burst of foam
    this.slamCd -= dt;
    if (ship.bowSlam > 1.5 && speed > 1.5 && this.slamCd <= 0) {
      this.slamCd = 0.5;
      for (let i = 0; i < 6; i++)
        this.spawn({ x: bow.x + (Math.random() - 0.5) * 4, z: bow.z + (Math.random() - 0.5) * 4, vx: (Math.random() - 0.5) * 2, vz: (Math.random() - 0.5) * 2, life: 12, size0: 2, size1: 7, foam: 0.8, turb: 0.6 });
    }
    // Oar contacts live in the finer OarWater map. Here they only leave the lasting slick, so the
    // stroke marks still trail the wake beyond that map's reach.
    if (!this.rowingCursor || this.rowingCursor.epoch !== ship.rowing.events.generation)
      this.rowingCursor = { next: ship.rowing.events.oldestId, epoch: ship.rowing.events.generation };
    if (consumeEvents) ship.rowing.events.read(this.rowingCursor, renderTime, (event) => {
      if (event.kind !== 'leaveWater' || event.intensity <= 0) return;
      this.spawn({ x: event.x, z: event.z, life: 14, size0: 0.8, size1: 2.6, foam: 0, turb: 0.35 * event.intensity, ring: 0 });
    });

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
      // white foam decays over the first part of a particle's life; the slick (turbulence) lingers
      const fade = Math.pow(Math.max(0, 1 - t / p.ff), 1.5) * Math.min(1, p.age * 6);
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
