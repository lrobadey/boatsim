// Quay stack (cargo-trade spec §7.5): the cargo waiting on the quay top at the docked berth, in two
// halves either side of the plank axis. World frame; the lead adds `group` to the scene and the
// returned solids to the world walk geometry.
import * as THREE from 'three';
import type { Berth } from '../world/harbour';
import type { BoxSolid } from '../world/walkable';
import { GOODS, type GoodId } from '../trade/goods';
import { hash01 } from '../trade/hash';
import { createCargoMeshes, LOOK_FOOTPRINT, LOOK_LAYER, LOOK_LAYERS, LOOKS, type CargoLook } from './cargoModels';

const MAX_PER_LOOK = 400;
/** each half: 1.0 to 2.5 m either side of the plank axis, 0.9 to 2.5 m off the face */
const INNER = 0.9;
const ACROSS = 1.6;
const NEAR = 2.5;
/** the nearest unit of each half is this far either side of the plank axis */
const PLANK_GAP = 1.0;
const DOCK_CLEAR = 1.0;

export class QuayStack {
  readonly group = new THREE.Group();
  private readonly meshes = createCargoMeshes(MAX_PER_LOOK);
  private readonly m = new THREE.Matrix4();
  private readonly c = new THREE.Color();

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
    if (!berth) return solids;
    const units = GOODS.map((g) => ({ good: g, n: Math.max(0, Math.floor(quay[g.id] ?? 0)) })).filter((u) => u.n > 0);
    if (!units.length) return solids;

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

    // per half (sign of the column's u): used u range and the tallest unit
    const half: Record<'sea' | 'land', { u0: number; u1: number; top: number } | null> = { sea: null, land: null };
    for (const { good, n } of units) {
      const look = good.look as CargoLook;
      const [pu, pd] = LOOK_FOOTPRINT[look];
      const rows = Math.max(1, Math.floor(ACROSS / pd));
      const dStep = ACROSS / rows;
      const layers = LOOK_LAYERS[look];
      const pitchY = LOOK_LAYER[look];
      let remaining = n;
      while (remaining > 0) {
        const [ua, ub] = takeColumn(pu);
        const uc = (ua + ub) / 2;
        const key = uc >= 0 ? 'sea' : 'land';
        for (let j = 0; j < rows && remaining > 0; j++) {
          const d = INNER + (j + 0.5) * dStep;
          for (let l = 0; l < layers && remaining > 0; l++) {
            const y = top + l * pitchY;
            at(uc, d, y, p);
            if (near(p)) continue;
            const k = counts[look];
            if (k >= MAX_PER_LOOK) {
              remaining = 0;
              break;
            }
            const tint = good.tint;
            this.m.makeRotationY(look === 'jar' || look === 'sack' ? hash01(k) * Math.PI * 2 : look === 'bundle' ? Math.atan2(ax, az) : 0);
            this.m.setPosition(p.x, p.y, p.z);
            const mesh = this.meshes[look];
            mesh.setMatrixAt(k, this.m);
            mesh.setColorAt(k, this.c.setHex(tint));
            counts[look] = k + 1;
            remaining--;
            const h = half[key] ?? { u0: ua, u1: ub, top: top };
            h.u0 = Math.min(h.u0, ua);
            h.u1 = Math.max(h.u1, ub);
            h.top = Math.max(h.top, y + pitchY);
            half[key] = h;
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
      const uMid = (h.u0 + h.u1) / 2 - uPlank;
      at(uMid, INNER + ACROSS / 2, top, p);
      solids.push({
        kind: 'box',
        cx: p.x,
        cz: p.z,
        hx: (h.u1 - h.u0) / 2,
        hz: ACROSS / 2,
        // local x along the pier: (cos rot, -sin rot) = (ax, az)
        rot: Math.atan2(-az, ax),
        y0: top - 0.3,
        y1: h.top,
        surface: 'stone',
        walkTop: false,
      });
    }
    return solids;
  }
}
