import * as THREE from 'three';
import type { Berth, HarbourLayout } from './harbour';
import type { Mooring } from '../ship/mooring';
import { halfWidthAt, zOf } from '../ship/hull';
import { outrigger } from '../ship/trireme';
import { LAYER_NOREFLECT } from '../core/pipeline';

/**
 * Berth target on the water while the ship is in reach of a free berth: her waterline outline as a
 * dashed glowing ribbon (colour = approach quality), a faint fill, chevrons leading in from the ship
 * and a soft ring round each bollard. Lives on LAYER_NOREFLECT: the sea reflection and the
 * refraction pre-pass leave it out, the main camera draws it after the water.
 */

const FADE_T = 0.4;
const FAR = 120;
const GONE = 180;
const CHEV_NEAR = 40;

const RED = 0xc4492f;
const AMBER = 0xd9b56a;
const GREEN = 0x7fc48a;

const hex = (h: number) => new THREE.Vector3(((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255);
const C_RED = hex(RED);
const C_AMBER = hex(AMBER);
const C_GREEN = hex(GREEN);
/** quality 0..1 -> red / amber / green, written straight into the sRGB-valued uniform */
function qualityColor(q: number, out: THREE.Vector3) {
  return q < 0.5 ? out.copy(C_RED).lerp(C_AMBER, q * 2) : out.copy(C_AMBER).lerp(C_GREEN, (q - 0.5) * 2);
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const toward = (v: number, t: number, step: number) => v + Math.max(-step, Math.min(step, t - v));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** ship-local waterline outline (x = starboard, z = aft), closed: the last point repeats the first */
function waterlineLoop(): THREE.Vector2[] {
  const N = 40;
  const stbd: THREE.Vector2[] = [];
  const port: THREE.Vector2[] = [];
  for (let k = 0; k < N; k++) {
    const s = k / (N - 1);
    const w = halfWidthAt(s, 0.4) + outrigger(s);
    const z = zOf(s);
    stbd.push(new THREE.Vector2(w, z));
    port.unshift(new THREE.Vector2(-w, z)); // stern first, so the loop runs bow → stbd → stern → port
  }
  // port[0] is the stern, port[last] the bow point (shared with stbd[0]): drop it to avoid a zero-length segment
  const loop = [...stbd, ...port.slice(0, -1)];
  loop.push(loop[0].clone());
  return loop;
}

/** flat ribbon along a closed loop: aDist = arc length (dash crawl), aSide = -1..1 across the width */
function ribbonGeometry(loop: THREE.Vector2[], hw: number): THREE.BufferGeometry {
  const U = loop.length - 1; // unique points; loop[U] === loop[0]
  const pos: number[] = [];
  const dist: number[] = [];
  const side: number[] = [];
  const idx: number[] = [];
  let d = 0;
  for (let k = 0; k <= U; k++) {
    const p = loop[k];
    if (k > 0) d += p.distanceTo(loop[k - 1]);
    const prev = loop[(k - 1 + U) % U];
    const next = loop[(k + 1) % U];
    let tx = next.x - prev.x;
    let tz = next.y - prev.y;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    const nx = -tz * hw;
    const nz = tx * hw;
    pos.push(p.x + nx, 0, p.y + nz, p.x - nx, 0, p.y - nz);
    dist.push(d, d);
    side.push(1, -1);
  }
  for (let k = 0; k < U; k++) {
    const a = 2 * k;
    const b = a + 2;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aDist', new THREE.Float32BufferAttribute(dist, 1));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  g.setIndex(idx);
  return g;
}

// chevron: pointing along local -z (forward), about 3 m across
const CHEVRON: [number, number][] = [
  [0, -1.2],
  [1.5, 0.6],
  [0.9, 0.6],
  [0, -0.3],
  [-0.9, 0.6],
  [-1.5, 0.6],
];

const FLAT_VS = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const LINE_VS = /* glsl */ `
  attribute float aDist;
  attribute float aSide;
  varying float vDist;
  varying float vSide;
  void main() {
    vDist = aDist;
    vSide = aSide;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

// dashes crawl along the outline; uDash = 0 gives a solid glow (the halo)
const LINE_FS = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform float uGain;
  uniform float uDash;
  uniform float uEdge;
  varying float vDist;
  varying float vSide;
  void main() {
    float edge = 1.0 - smoothstep(uEdge, 1.0, abs(vSide));
    float p = mod(vDist - uTime * 2.2, 2.4);
    float on = smoothstep(0.0, 0.15, p) * (1.0 - smoothstep(1.25, 1.4, p));
    float dash = mix(1.0, on, uDash);
    gl_FragColor = vec4(uColor, edge * dash * uAlpha * uGain);
  }`;

const FILL_FS = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  varying vec2 vUv;
  void main() {
    gl_FragColor = vec4(uColor, uAlpha * 0.05);
  }`;

const RING_FS = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uAlpha;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float ring = exp(-pow((r - 0.56) / 0.13, 2.0));
    float core = 0.16 * (1.0 - smoothstep(0.0, 0.56, r));
    float pulse = 0.8 + 0.2 * sin(uTime * 2.2);
    gl_FragColor = vec4(uColor, uAlpha * (ring * 0.85 + core) * pulse);
  }`;

const CHEV_FS = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  varying vec2 vUv;
  void main() {
    gl_FragColor = vec4(uColor, uAlpha * 0.9);
  }`;

interface BerthSet {
  berth: Berth;
  /** world space: holds the bollard rings */
  root: THREE.Group;
  /** transform of the ship-local outline: centre at the berth, yaw along the berth axis */
  pose: THREE.Group;
  rings: THREE.Mesh[];
}

interface Chevron {
  mesh: THREE.Mesh;
  alpha: { value: number };
}

export class BerthMarker {
  readonly group = new THREE.Group();
  // uniforms shared by every line-type material, so one write per frame drives them all
  private readonly U = {
    uTime: { value: 0 },
    uColor: { value: new THREE.Vector3() },
    uAlpha: { value: 0 },
  };
  private readonly sets = new Map<number, BerthSet>();
  private readonly chevrons: Chevron[] = [];
  private cur: BerthSet | null = null;
  /** scene exposure: the marker is unlit, so it is scaled to hold a steady on-screen brightness */
  exposure = 1;
  private fade = 0;
  private time = 0;
  private quality = 0.5;
  private dist = Infinity;
  private shipX = 0;
  private shipZ = 0;
  private yaw = 0;
  private waterY = 0;

  constructor(layout: HarbourLayout) {
    const U = this.U;
    const loop = waterlineLoop();
    const line = ribbonGeometry(loop, 0.22);
    const halo = ribbonGeometry(loop, 0.9);
    const fill = new THREE.ShapeGeometry(new THREE.Shape(loop.slice(0, -1))).rotateX(Math.PI / 2);
    const ring = new THREE.PlaneGeometry(2.8, 2.8).rotateX(-Math.PI / 2);
    const chevGeo = new THREE.ShapeGeometry(new THREE.Shape(CHEVRON.map(([x, z]) => new THREE.Vector2(x, z)))).rotateX(Math.PI / 2);

    const lineMat = (gain: number, dash: number, edge: number) =>
      new THREE.ShaderMaterial({
        uniforms: { ...U, uGain: { value: gain }, uDash: { value: dash }, uEdge: { value: edge } },
        vertexShader: LINE_VS,
        fragmentShader: LINE_FS,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
    const lineM = lineMat(1, 1, 0.5);
    const haloM = lineMat(0.22, 0, 0);
    const fillM = new THREE.ShaderMaterial({
      uniforms: { uColor: U.uColor, uAlpha: U.uAlpha },
      vertexShader: FLAT_VS,
      fragmentShader: FILL_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const ringM = new THREE.ShaderMaterial({
      uniforms: { uTime: U.uTime, uColor: U.uColor, uAlpha: U.uAlpha },
      vertexShader: FLAT_VS,
      fragmentShader: RING_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, order: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      m.renderOrder = order;
      return m;
    };

    for (const b of layout.berths) {
      const root = new THREE.Group();
      const pose = new THREE.Group();
      const rings: THREE.Mesh[] = [];
      pose.add(mesh(fill, fillM, 58), mesh(halo, haloM, 59), mesh(line, lineM, 60));
      for (const v of b.bollards) {
        const r = mesh(ring, ringM, 60);
        r.position.set(v.x, v.y + 0.05, v.z);
        rings.push(r);
        root.add(r);
      }
      root.add(pose);
      root.visible = false;
      this.group.add(root);
      this.sets.set(b.id, { berth: b, root, pose, rings });
    }

    for (let i = 0; i < 3; i++) {
      const alpha = { value: 0 };
      const mat = new THREE.ShaderMaterial({
        uniforms: { uColor: U.uColor, uAlpha: alpha },
        vertexShader: FLAT_VS,
        fragmentShader: CHEV_FS,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const m = mesh(chevGeo, mat, 61);
      m.visible = false;
      this.group.add(m);
      this.chevrons.push({ mesh: m, alpha });
    }

    this.group.traverse((o) => o.layers.set(LAYER_NOREFLECT));
  }

  /**
   * Once per frame, after the mooring step. waveHeightAtBerth is the sea surface height at (x, z);
   * cameraPos keeps the bollard rings readable at range.
   */
  update(dt: number, mooring: Mooring, waveHeightAtBerth: (x: number, z: number) => number, cameraPos: THREE.Vector3): void {
    this.time += dt;
    this.U.uTime.value = this.time;
    const a = mooring.approach;
    const live = mooring.state === 'free' && a !== null;

    if (a && live) {
      const b = a.berth;
      this.cur = this.sets.get(b.id) ?? this.cur;
      this.dist = a.dist;
      // ship CoG from the berth-frame offsets (approach.along / lateral are along a and n)
      this.shipX = b.cx + a.along * b.ax + a.lateral * b.nx;
      this.shipZ = b.cz + a.along * b.az + a.lateral * b.nz;
      // the allowed heading nearest to her current one: bowOut means bow along +a
      const hA = Math.atan2(b.ax, -b.az);
      const yawT = -(a.bowOut ? hA : hA + Math.PI);
      const waterT = waveHeightAtBerth(b.cx, b.cz) + 0.05;
      const k = this.fade < 0.01 ? 1 : Math.min(1, dt * 4);
      this.yaw += wrap(yawT - this.yaw) * k;
      this.waterY += (waterT - this.waterY) * k;
      this.quality += (a.quality - this.quality) * k;
    }

    const want = live && this.dist < GONE ? 1 : 0;
    this.fade = toward(this.fade, want, dt / FADE_T);
    const distFade = 1 - smooth(FAR, GONE, this.dist);
    this.U.uAlpha.value = this.fade * distFade;
    qualityColor(this.quality, this.U.uColor.value);
    this.U.uColor.value.multiplyScalar(0.85 / Math.max(1e-4, this.exposure));

    const cur = this.cur;
    const shown = cur !== null && this.fade > 0.002;
    for (const s of this.sets.values()) s.root.visible = shown && s === cur;
    if (cur && shown) {
      cur.pose.position.set(cur.berth.cx, this.waterY, cur.berth.cz);
      cur.pose.rotation.set(0, this.yaw, 0);
      for (const r of cur.rings) {
        const d = cameraPos.distanceTo(r.position);
        r.scale.setScalar(THREE.MathUtils.clamp(d / 40, 1, 2.5));
      }
    }

    // chevrons flow from the ship toward the berth, only when she is well out
    const chevAmt = this.fade * distFade * smooth(CHEV_NEAR, CHEV_NEAR + 15, this.dist);
    const showC = cur !== null && chevAmt > 0.002;
    for (let i = 0; i < 3; i++) {
      const c = this.chevrons[i];
      if (!showC || !cur) {
        c.mesh.visible = false;
        continue;
      }
      const u = (this.time * 0.09 + i / 3) % 1;
      const p = 0.1 + 0.8 * u;
      const bx = cur.berth.cx;
      const bz = cur.berth.cz;
      const dx = bx - this.shipX;
      const dz = bz - this.shipZ;
      const x = this.shipX + dx * p;
      const z = this.shipZ + dz * p;
      c.mesh.position.set(x, waveHeightAtBerth(x, z) + 0.08, z);
      // local -z is forward: rotate so it points at the berth
      c.mesh.rotation.set(0, Math.atan2(-dx, -dz), 0);
      c.alpha.value = chevAmt * Math.sin(Math.PI * u) * 0.9;
      c.mesh.visible = true;
    }
  }
}
