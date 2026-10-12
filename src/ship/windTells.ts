import * as THREE from 'three';
import { clamp, smoothstep } from '../core/util';
import type { ShipPhysics } from './physics';
import { SEPARATION_FULL, SEPARATION_START } from './sailing';

/**
 * Masthead pennant and sail telltales. Each streamer is a chain of point masses (Verlet, with
 * inextensible links) driven by gravity, the inertia of the rig it hangs from, and aerodynamic
 * drag against the apparent wind sampled from the same wind field the sail and windage use.
 *
 * Telltale ribbons sit in pairs, one on each face of the cloth. The flow each one sees comes from the
 * local apparent wind and the panel's angle of attack, using the sail model's own separation
 * thresholds: the leeward ribbon streams while flow is attached and tumbles once it separates; the
 * windward ribbon lifts when the sail is nearly edge-on to the wind and starts to luff.
 */

const RHO_AIR = 1.225;
const GRAVITY = 9.81;
const STEP = 1 / 240;
const MAX_STEPS = 24;
const ITERATIONS = 6;
const DEG = Math.PI / 180;
// Windward-side disturbance as the sail comes edge-on to the wind (luffing).
const LUFF_START = 10 * DEG;
const LUFF_FULL = 4 * DEG;
// Telltales stand off the cloth slightly so they never sink into it.
const STANDOFF = 0.015;

function noise1(x: number, seed: number) {
  const i = Math.floor(x);
  const f = x - i;
  const sa = Math.sin((i + seed * 57.13) * 127.1) * 43758.5453;
  const sb = Math.sin((i + 1 + seed * 57.13) * 127.1) * 43758.5453;
  const ha = sa - Math.floor(sa);
  const hb = sb - Math.floor(sb);
  const u = f * f * (3 - 2 * f);
  return (ha + (hb - ha) * u) * 2 - 1;
}

interface StrandSpec {
  length: number;
  nodes: number;
  /** render half-width at the root and the tip (m) */
  halfRoot: number;
  halfTip: number;
  /** width presented to the flow at the root and the tip (m) */
  dragRoot: number;
  dragTip: number;
  /** mass per metre of strand per metre of drag width (kg/m^2), or per metre when `perLength` */
  density: number;
  perLength?: boolean;
  cdNormal: number;
  cfTangent: number;
}

class Strand {
  readonly n: number;
  readonly seg: number;
  readonly p: Float32Array;
  readonly prev: Float32Array;
  readonly mass: Float32Array;
  readonly drag: Float32Array;
  readonly half: Float32Array;
  readonly anchor = new THREE.Vector3();
  needsReset = true;

  constructor(readonly spec: StrandSpec, readonly seed: number) {
    this.n = spec.nodes;
    this.seg = spec.length / (spec.nodes - 1);
    this.p = new Float32Array(this.n * 3);
    this.prev = new Float32Array(this.n * 3);
    this.mass = new Float32Array(this.n);
    this.drag = new Float32Array(this.n);
    this.half = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const f = i / (this.n - 1);
      this.half[i] = spec.halfRoot + (spec.halfTip - spec.halfRoot) * f;
      this.drag[i] = spec.dragRoot + (spec.dragTip - spec.dragRoot) * f;
      const share = i === 0 || i === this.n - 1 ? 0.5 : 1;
      this.mass[i] = (spec.perLength ? spec.density : spec.density * this.drag[i]) * this.seg * share;
    }
  }

  /** Lay the strand straight downstream of its anchor. */
  reset(anchor: THREE.Vector3, flow: THREE.Vector3) {
    const d = _a.copy(flow);
    d.y -= 0.5;
    if (d.lengthSq() < 1e-6) d.set(0, -1, 0);
    d.normalize();
    for (let i = 0; i < this.n; i++) {
      const o = i * 3;
      this.p[o] = this.prev[o] = anchor.x + d.x * this.seg * i;
      this.p[o + 1] = this.prev[o + 1] = anchor.y + d.y * this.seg * i;
      this.p[o + 2] = this.prev[o + 2] = anchor.z + d.z * this.seg * i;
    }
    this.anchor.copy(anchor);
    this.needsReset = false;
  }
}

/** Flow seen by a strand: a mean air velocity plus eddies travelling down the strand. */
interface Flow {
  mean: THREE.Vector3;
  eddy: number; // rms eddy speed (m/s)
  freq: number; // eddy frequency (Hz)
  phaseStep: number; // phase lag per node (cycles)
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _t = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _air = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const _root = new THREE.Vector3();
const _n = new THREE.Vector3();
const _w = new THREE.Vector3();
const _inv = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);

function stepStrand(s: Strand, anchorFrom: THREE.Vector3, anchorTo: THREE.Vector3, flow: Flow, t0: number, dt: number, steps: number, plane: { point: THREE.Vector3; normal: THREE.Vector3; side: number } | null) {
  const h = dt / steps;
  const p = s.p, prev = s.prev, n = s.n, seg = s.seg;
  for (let k = 0; k < steps; k++) {
    const t = t0 + h * (k + 1);
    const f = (k + 1) / steps;
    for (let i = 1; i < n; i++) {
      const o = i * 3, q = (i - 1) * 3;
      const vx = (p[o] - prev[o]) / h, vy = (p[o + 1] - prev[o + 1]) / h, vz = (p[o + 2] - prev[o + 2]) / h;
      const ph = t * flow.freq - i * flow.phaseStep;
      _rel.set(
        flow.mean.x + flow.eddy * noise1(ph, s.seed) - vx,
        flow.mean.y + flow.eddy * noise1(ph, s.seed + 1) - vy,
        flow.mean.z + flow.eddy * noise1(ph, s.seed + 2) - vz,
      );
      _t.set(p[o] - p[q], p[o + 1] - p[q + 1], p[o + 2] - p[q + 2]);
      const tl = _t.length();
      if (tl > 1e-6) _t.multiplyScalar(1 / tl);
      else _t.set(0, -1, 0);
      // Pressure drag acts on the cross-flow component, skin friction along the strand.
      const rt = _rel.dot(_t);
      const rnx = _rel.x - rt * _t.x, rny = _rel.y - rt * _t.y, rnz = _rel.z - rt * _t.z;
      const rn = Math.hypot(rnx, rny, rnz);
      const q0 = 0.5 * RHO_AIR * s.drag[i] * seg;
      const kn = q0 * s.spec.cdNormal * rn / s.mass[i];
      const kt = q0 * s.spec.cfTangent * Math.abs(rt) / s.mass[i];
      // Keep explicit drag stable for very light strands in strong gusts.
      const lim = Math.min(1, 0.5 / Math.max(1e-6, (kn + kt) * h));
      const ax = (kn * rnx + kt * rt * _t.x) * lim;
      const ay = (kn * rny + kt * rt * _t.y) * lim - GRAVITY;
      const az = (kn * rnz + kt * rt * _t.z) * lim;
      const x = p[o], y = p[o + 1], z = p[o + 2];
      p[o] = x + (x - prev[o]) * 0.998 + ax * h * h;
      p[o + 1] = y + (y - prev[o + 1]) * 0.998 + ay * h * h;
      p[o + 2] = z + (z - prev[o + 2]) * 0.998 + az * h * h;
      prev[o] = x; prev[o + 1] = y; prev[o + 2] = z;
    }
    // root rides the rig
    _root.lerpVectors(anchorFrom, anchorTo, f);
    prev[0] = p[0]; prev[1] = p[1]; prev[2] = p[2];
    p[0] = _root.x; p[1] = _root.y; p[2] = _root.z;
    for (let it = 0; it < ITERATIONS; it++) {
      for (let i = 1; i < n; i++) {
        const o = i * 3, q = (i - 1) * 3;
        const dx = p[o] - p[q], dy = p[o + 1] - p[q + 1], dz = p[o + 2] - p[q + 2];
        const d = Math.hypot(dx, dy, dz) || 1e-6;
        const err = (d - seg) / d;
        // the root is pinned; free links split the correction
        const wq = i === 1 ? 0 : 0.5;
        const wo = 1 - wq;
        p[o] -= dx * err * wo; p[o + 1] -= dy * err * wo; p[o + 2] -= dz * err * wo;
        p[q] += dx * err * wq; p[q + 1] += dy * err * wq; p[q + 2] += dz * err * wq;
      }
      if (plane) {
        for (let i = 1; i < n; i++) {
          const o = i * 3;
          const d = ((p[o] - plane.point.x) * plane.normal.x + (p[o + 1] - plane.point.y) * plane.normal.y + (p[o + 2] - plane.point.z) * plane.normal.z) * plane.side;
          if (d < STANDOFF) {
            const push = (STANDOFF - d) * plane.side;
            p[o] += plane.normal.x * push; p[o + 1] += plane.normal.y * push; p[o + 2] += plane.normal.z * push;
          }
        }
      }
    }
  }
  s.anchor.copy(anchorTo);
}

class RibbonMesh {
  readonly mesh: THREE.Mesh;
  private pos: Float32Array;
  private geo: THREE.BufferGeometry;

  constructor(private strands: Strand[], color: number) {
    let verts = 0;
    const index: number[] = [];
    for (const s of strands) {
      for (let i = 0; i < s.n - 1; i++) {
        const a = verts + i * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      verts += s.n * 2;
    }
    this.pos = new Float32Array(verts * 3);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(index);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
  }

  /** Write strand ribbons in the parent's local frame. `flat` gives each strand's face normal (world) or null to hang the ribbon vertically. */
  write(toLocal: THREE.Matrix4, flat: (THREE.Vector3 | null)[]) {
    let v = 0;
    for (let si = 0; si < this.strands.length; si++) {
      const s = this.strands[si];
      const p = s.p;
      for (let i = 0; i < s.n; i++) {
        const o = i * 3;
        const a = Math.max(0, i - 1) * 3, b = Math.min(s.n - 1, i + 1) * 3;
        _t.set(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]).normalize();
        const face = flat[si];
        if (face) _w.crossVectors(_t, face);
        else _w.copy(_up).addScaledVector(_t, -_up.dot(_t));
        if (_w.lengthSq() < 1e-8) _w.set(1, 0, 0);
        _w.normalize().multiplyScalar(s.half[i]);
        _a.set(p[o], p[o + 1], p[o + 2]).add(_w).applyMatrix4(toLocal);
        _b.set(p[o], p[o + 1], p[o + 2]).sub(_w).applyMatrix4(toLocal);
        this.pos[v * 3] = _a.x; this.pos[v * 3 + 1] = _a.y; this.pos[v * 3 + 2] = _a.z; v++;
        this.pos[v * 3] = _b.x; this.pos[v * 3 + 1] = _b.y; this.pos[v * 3 + 2] = _b.z; v++;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.computeVertexNormals();
  }
}

const PENNANT: StrandSpec = {
  length: 3.6, nodes: 12,
  halfRoot: 0.22, halfTip: 0.03,
  dragRoot: 0.44, dragTip: 0.06,
  density: 0.18, // light dyed linen, kg/m^2
  cdNormal: 1.1, cfTangent: 0.03,
};

// Light cloth ribbons (~8 cm x 0.9 m) rather than wool yarn, so they read from the helm.
const TELLTALE: StrandSpec = {
  length: 0.9, nodes: 7,
  halfRoot: 0.045, halfTip: 0.035,
  dragRoot: 0.09, dragTip: 0.07,
  density: 0.1, // kg/m^2
  cdNormal: 1.2, cfTangent: 0.04,
};

/** Telltale stations on the cloth: u across (-1..1), v down from the head (0..1). */
const STATIONS: [number, number][] = [[-0.55, 0.3], [0.55, 0.3], [-0.55, 0.65], [0.55, 0.65]];

export class WindTells {
  private pennant = new Strand(PENNANT, 3);
  private yarns: Strand[] = [];
  private pennantMesh: RibbonMesh;
  private yarnMesh: RibbonMesh;
  private lastTime = -1;
  private flow: Flow = { mean: new THREE.Vector3(), eddy: 0, freq: 1, phaseStep: 0 };
  private faceNormals: THREE.Vector3[] = [];
  private attach = STATIONS.map(() => ({ point: new THREE.Vector3(), normal: new THREE.Vector3() }));

  constructor(private group: THREE.Object3D, private mastTop: THREE.Vector3, private sail: THREE.Mesh, private sailWidth: number, private sailHeight: number) {
    for (let i = 0; i < STATIONS.length * 2; i++) {
      this.yarns.push(new Strand(TELLTALE, 10 + i * 3));
      this.faceNormals.push(new THREE.Vector3());
    }
    this.pennantMesh = new RibbonMesh([this.pennant], 0x7d2233);
    this.yarnMesh = new RibbonMesh(this.yarns, 0xc23a2a);
    group.add(this.pennantMesh.mesh, this.yarnMesh.mesh);
  }

  /** Apparent wind (world) at a world point: the wind field minus the rig's own velocity there. */
  private apparent(physics: ShipPhysics, at: THREE.Vector3, time: number, out: THREE.Vector3) {
    physics.wind.sampleAt(at.x, at.y, at.z, time, out);
    _rel.subVectors(at, physics.pos);
    _b.crossVectors(physics.angVel, _rel).add(physics.vel);
    return out.sub(_b);
  }

  update(physics: ShipPhysics, time: number, deployment: number, billow: number, flutter: number) {
    const dt = this.lastTime < 0 ? 0 : clamp(time - this.lastTime, 0, 0.1);
    this.lastTime = time;
    this.sail.updateWorldMatrix(true, false);
    const steps = Math.min(MAX_STEPS, Math.ceil(dt / STEP - 1e-6));

    // ---- pennant
    _anchor.copy(this.mastTop).setY(this.mastTop.y + 0.05).applyMatrix4(this.group.matrixWorld);
    const anchorTo = _n.copy(_anchor);
    this.apparent(physics, anchorTo, time, _air);
    const U = _air.length();
    const f = this.flow;
    f.mean.copy(_air);
    // Flags flap from their own wake instability: lateral eddies of ~10% of the flow travelling aft.
    f.eddy = 0.1 * U;
    f.freq = clamp(0.35 * U, 0.3, 6);
    f.phaseStep = 0.12;
    if (this.pennant.needsReset || this.pennant.anchor.distanceToSquared(anchorTo) > 25) this.pennant.reset(anchorTo, _air);
    else if (steps > 0) stepStrand(this.pennant, _a.copy(this.pennant.anchor), anchorTo, f, time - dt, dt, steps, null);

    // ---- telltales: only while there is cloth set to carry them
    const shown = deployment > 0.55;
    this.yarnMesh.mesh.visible = shown;
    if (shown) {
      const h = this.sailHeight * deployment;
      const halfW = this.sailWidth / 2;
      for (let si = 0; si < STATIONS.length; si++) {
        const [u, v] = STATIONS[si];
        // Same cloth surface the sail shader draws (belly from load, flap from luffing).
        const belly = (1 - u * u) * Math.sin(Math.PI * clamp(v * 0.85 + 0.1, 0, 1));
        const x = u * halfW;
        const flap = Math.sin(x * 1.3 + time * 7 + v * 4) * Math.sin(v * Math.PI) * flutter;
        const z = billow * 1.6 * belly * deployment + flap * 0.35;
        const dbdu = -2 * u * Math.sin(Math.PI * clamp(v * 0.85 + 0.1, 0, 1));
        const at = this.attach[si];
        at.point.set(x, -v * h, z).applyMatrix4(this.sail.matrixWorld);
        at.normal.set((-billow * 1.6 * dbdu / halfW) * deployment, 0, 1).normalize().transformDirection(this.sail.matrixWorld);

        this.apparent(physics, at.point, time, _air);
        const Ua = _air.length();
        // Angle of attack on the flat panel, as the sail force model measures it.
        _w.set(0, 0, 1).transformDirection(this.sail.matrixWorld);
        const alpha = Math.asin(clamp(Math.abs(_air.dot(_w)) / Math.max(1e-4, Ua), 0, 1));
        const an = _air.dot(at.normal);
        const attached = 1 - smoothstep(SEPARATION_START, SEPARATION_FULL, alpha);
        const luff = smoothstep(LUFF_START, LUFF_FULL, alpha);
        // Air moving toward +normal presses on the -normal face: that face is windward.
        const leeSide = _air.dot(_w) >= 0 ? 1 : -1;
        for (let side = -1; side <= 1; side += 2) {
          const yi = si * 2 + (side > 0 ? 1 : 0);
          const yarn = this.yarns[yi];
          const lee = side === leeSide;
          // Near the cloth the flow runs along the surface.
          f.mean.copy(_air).addScaledVector(at.normal, -an);
          const along = lee ? 0.1 + 0.9 * attached : 1 - 0.8 * luff;
          f.mean.multiplyScalar(along);
          const disturbed = lee ? 1 - attached : luff;
          // separated or luffing flow near the cloth is a slow tumble of eddies about the size of the panel
          f.eddy = Ua * (0.03 + 0.8 * disturbed + 0.25 * flutter);
          f.freq = clamp(Ua / 1.5, 0.5, 8);
          f.phaseStep = 0.05;
          this.faceNormals[yi].copy(at.normal);
          _anchor.copy(at.point).addScaledVector(at.normal, STANDOFF * side);
          if (yarn.needsReset || yarn.anchor.distanceToSquared(_anchor) > 4) yarn.reset(_anchor, f.mean);
          else if (steps > 0) stepStrand(yarn, _a.copy(yarn.anchor), _anchor, f, time - dt, dt, steps, { point: at.point, normal: at.normal, side });
        }
      }
    } else {
      for (const y of this.yarns) y.needsReset = true;
    }

    _inv.copy(this.group.matrixWorld).invert();
    this.pennantMesh.write(_inv, [null]);
    if (shown) this.yarnMesh.write(_inv, this.faceNormals);
  }
}
