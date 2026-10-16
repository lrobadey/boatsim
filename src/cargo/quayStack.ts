// Quay stack (cargo-trade spec §7.5): the cargo waiting on the quay top at the docked berth, in two
// halves either side of the plank axis. World frame; the lead adds `group` to the scene and the
// returned solids to the world walk geometry.
import * as THREE from 'three';
import type { Berth } from '../world/harbour';
import type { BoxSolid } from '../world/walkable';
import { GOODS, type GoodId } from '../trade/goods';
import { hash01 } from '../trade/hash';
import { createCargoMeshes, lookGeometry, LOOK_FOOTPRINT, LOOK_LAYERS, LOOKS, type CargoLook } from './cargoModels';

const MAX_PER_LOOK = 400;
/** each half: 1.0 to 2.5 m either side of the plank axis, 0.9 to 2.5 m off the face */
const INNER = 0.9;
const ACROSS = 1.6;
const NEAR = 2.5;
/** the nearest unit of each half is this far either side of the plank axis */
const PLANK_GAP = 1.0;
const DOCK_CLEAR = 1.0;
const LAYER_GAP = 0.015;

const geometryBounds = new Map<CargoLook, { minY: number; height: number; minX: number; maxX: number; minZ: number; maxZ: number; points: THREE.Vector3[] }>();
function actualBounds(look: CargoLook) {
  let bounds = geometryBounds.get(look);
  if (bounds) return bounds;
  const geometry = lookGeometry(look);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const attr = geometry.getAttribute('position');
  const points: THREE.Vector3[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < attr.count; i++) {
    const p = new THREE.Vector3(attr.getX(i), attr.getY(i), attr.getZ(i));
    const key = `${p.x.toFixed(5)}:${p.y.toFixed(5)}:${p.z.toFixed(5)}`;
    if (!seen.has(key)) { seen.add(key); points.push(p); }
  }
  bounds = {
    minY: box.min.y, height: box.max.y - box.min.y,
    minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z, points,
  };
  geometry.dispose();
  geometryBounds.set(look, bounds);
  return bounds;
}

export class QuayStack {
  readonly group = new THREE.Group();
  private readonly meshes = createCargoMeshes(MAX_PER_LOOK);
  private readonly m = new THREE.Matrix4();
  private readonly c = new THREE.Color();
  private currentCounts: Record<CargoLook, number> = { amphora: 0, jar: 0, sack: 0, bundle: 0 };
  private currentSolids: BoxSolid[] = [];

  get instanceCounts(): Readonly<Record<CargoLook, number>> { return this.currentCounts; }
  get solids(): readonly BoxSolid[] { return this.currentSolids; }

  constructor() {
    for (const look of LOOKS) this.group.add(this.meshes[look]);
  }

  /**
   * Lay the quay units out for the docked berth (or clear the stack). `plank` gives the plank's quay end;
   * `avoid` lists world xz points (dock-life figures) that no unit may come within 1.0 m of. Returns one
   * blocking box per non-empty half.
   */
  update(
    berth: Berth | null,
    plank: { shoreWorld: THREE.Vector3 } | null,
    quay: Partial<Record<GoodId, number>>,
    avoid: { x: number; z: number }[],
  ): BoxSolid[] {
    const counts: Record<CargoLook, number> = { amphora: 0, jar: 0, sack: 0, bundle: 0 };
    const solids: BoxSolid[] = [];
    for (const look of LOOKS) this.meshes[look].count = 0;
    if (!berth) { this.currentCounts = counts; this.currentSolids = solids; return solids; }
    const units = GOODS.map((g) => ({ good: g, n: Math.max(0, Math.floor(quay[g.id] ?? 0)) })).filter((u) => u.n > 0);
    if (!units.length) { this.currentCounts = counts; this.currentSolids = solids; return solids; }

    const { ax, az, nx, nz, face, top } = berth;
    // face point: the quay face, `face` back from the berth centre along -n
    const fx = berth.cx - nx * face, fz = berth.cz - nz * face;
    // along-pier coordinate of the plank's quay end (0 when there is no plank)
    const uPlank = plank ? (plank.shoreWorld.x - fx) * ax + (plank.shoreWorld.z - fz) * az : 0;
    // world point at `u` along the pier from the plank axis and `d` inboard from the face
    const at = (u: number, d: number, y: number, out: THREE.Vector3) =>
      out.set(fx - nx * d + ax * (uPlank + u), y, fz - nz * d + az * (uPlank + u));
    const p = new THREE.Vector3();
    const near = (q: THREE.Vector3) => avoid.some((a) => Math.hypot(a.x - q.x, a.z - q.z) < DOCK_CLEAR);

    // column allocation: seaward half first, then landward; past both, the two grow outward in turn
    let sea = PLANK_GAP, land = -PLANK_GAP, flip = 0;
    const seaEnd = NEAR, landEnd = -NEAR;
    const takeColumn = (pu: number): [number, number] => {
      if (sea + pu <= seaEnd + 1e-9) {
        const a = sea;
        sea += pu;
        return [a, a + pu];
      }
      if (land - pu >= landEnd - 1e-9) {
        const a = land - pu;
        land -= pu;
        return [a, a + pu];
      }
      if (flip === 0) {
        const a = sea;
        sea += pu;
        flip = 1;
        return [a, a + pu];
      }
      const a = land - pu;
      land -= pu;
      flip = 0;
      return [a, a + pu];
    };

    // Each half records the union of actual transformed mesh bounds in berth-local coordinates.
    const half: Record<'sea' | 'land', { u0: number; u1: number; d0: number; d1: number; y0: number; y1: number } | null> = { sea: null, land: null };
    for (const { good, n } of units) {
      const look = good.look as CargoLook;
      const startK = counts[look];
      const footprint = shapeForFootprint(look, n, startK, ax, az, nx, nz);
      const pu = Math.max(LOOK_FOOTPRINT[look][0], footprint.u + LAYER_GAP);
      const pd = Math.max(LOOK_FOOTPRINT[look][1], footprint.d + LAYER_GAP);
      const rows = Math.max(1, Math.floor(ACROSS / pd));
      const dStep = ACROSS / rows;
      const layers = LOOK_LAYERS[look];
      const shape = actualBounds(look);
      let remaining = n;
      while (remaining > 0) {
        const [ua, ub] = takeColumn(pu);
        const uc = (ua + ub) / 2;
        const key = uc >= 0 ? 'sea' : 'land';
        for (let j = 0; j < rows && remaining > 0; j++) {
          const d = INNER + (j + 0.5) * dStep;
          let stackTop = top;
          for (let l = 0; l < layers && remaining > 0; l++) {
            const y = stackTop - shape.minY;
            at(uc, d, y, p);
            if (near(p)) break;
            const k = counts[look];
            if (k >= MAX_PER_LOOK) {
              remaining = 0;
              break;
            }
            const tint = good.tint;
            const yaw = look === 'jar' || look === 'sack' ? hash01(k) * Math.PI * 2 : look === 'bundle' ? Math.atan2(ax, az) : 0;
            this.m.makeRotationY(yaw);
            this.m.setPosition(p.x, p.y, p.z);
            const mesh = this.meshes[look];
            mesh.setMatrixAt(k, this.m);
            mesh.setColorAt(k, this.c.setHex(tint));
            counts[look] = k + 1;
            remaining--;
            const cy = Math.cos(yaw), sy = Math.sin(yaw);
            const worldCorners: [number, number, number][] = [];
            for (const lx of [shape.minX, shape.maxX]) for (const lz of [shape.minZ, shape.maxZ]) {
              const wx = p.x + cy * lx + sy * lz;
              const wz = p.z - sy * lx + cy * lz;
              worldCorners.push([wx, wz, p.y + shape.minY]);
              worldCorners.push([wx, wz, p.y + shape.minY + shape.height]);
            }
            const us = worldCorners.map(([wx, wz]) => (wx - fx) * ax + (wz - fz) * az - uPlank);
            const ds = worldCorners.map(([wx, wz]) => -((wx - fx) * nx + (wz - fz) * nz));
            const ys = worldCorners.map(([, , wy]) => wy);
            const h = half[key] ?? { u0: Infinity, u1: -Infinity, d0: Infinity, d1: -Infinity, y0: Infinity, y1: -Infinity };
            h.u0 = Math.min(h.u0, ...us); h.u1 = Math.max(h.u1, ...us);
            h.d0 = Math.min(h.d0, ...ds); h.d1 = Math.max(h.d1, ...ds);
            h.y0 = Math.min(h.y0, ...ys); h.y1 = Math.max(h.y1, ...ys);
            half[key] = h;
            stackTop = y + shape.minY + shape.height + LAYER_GAP;
          }
        }
      }
    }

    for (const look of LOOKS) {
      const mesh = this.meshes[look];
      mesh.count = counts[look];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    for (const key of ['sea', 'land'] as const) {
      const h = half[key];
      if (!h) continue;
      const uMid = (h.u0 + h.u1) / 2;
      const dMid = (h.d0 + h.d1) / 2;
      p.set(fx + ax * (uPlank + uMid) - nx * dMid, 0, fz + az * (uPlank + uMid) - nz * dMid);
      solids.push({
        kind: 'box',
        cx: p.x,
        cz: p.z,
        hx: (h.u1 - h.u0) / 2 + 0.015,
        hz: (h.d1 - h.d0) / 2 + 0.015,
        // local x along the pier: (cos rot, -sin rot) = (ax, az)
        rot: Math.atan2(-az, ax),
        y0: h.y0 - 0.015,
        y1: h.y1 + 0.015,
        surface: 'stone',
        walkTop: false,
      });
    }
    this.currentCounts = counts;
    this.currentSolids = solids;
    return solids;
  }
}

function shapeForFootprint(look: CargoLook, count: number, startK: number, ax: number, az: number, nx: number, nz: number) {
  const shape = actualBounds(look);
  let maxU = 0, maxD = 0;
  for (let i = 0; i < Math.min(count, MAX_PER_LOOK - startK); i++) {
    const k = startK + i;
    const yaw = look === 'jar' || look === 'sack' ? hash01(k) * Math.PI * 2 : look === 'bundle' ? Math.atan2(ax, az) : 0;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    let u0 = Infinity, u1 = -Infinity, d0 = Infinity, d1 = -Infinity;
    for (const p of shape.points) {
      const x = c * p.x + s * p.z, z = -s * p.x + c * p.z;
      const u = x * ax + z * az, d = -(x * nx + z * nz);
      u0 = Math.min(u0, u); u1 = Math.max(u1, u);
      d0 = Math.min(d0, d); d1 = Math.max(d1, d);
    }
    maxU = Math.max(maxU, u1 - u0);
    maxD = Math.max(maxD, d1 - d0);
  }
  return { u: maxU, d: maxD };
}
