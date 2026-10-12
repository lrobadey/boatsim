// Cargo in the hold (cargo-trade spec §7.4). Only what shows through the hatches is drawn: per hatch
// rectangle plus 0.3 m, a grid at each look's footprint pitch, the column's stack from the floor up,
// and its top two layers. Ship-local; the lead adds `group` to the model. Rebuilt only by update().
import * as THREE from 'three';
import type { ShipDesign } from '../ship/design';
import { goodById, type GoodId } from '../trade/goods';
import { hash01 } from '../trade/hash';
import type { ColumnFill, Hold, StowedCell } from './hold';
import { createCargoMeshes, LOOK_FOOTPRINT, LOOK_LAYER, LOOKS, type CargoLook } from './cargoModels';

const MARGIN = 0.3;
const MAX_PER_LOOK = 400;

interface Layer {
  good: GoodId;
  look: CargoLook;
  y: number;
}

/** the column's layers from the floor up: each good takes its share of the filled height, one layer per look pitch */
function columnLayers(col: ColumnFill): Layer[] {
  const H = col.topY - col.floorY;
  const total = col.parts.reduce((a, p) => a + p.volume, 0);
  const out: Layer[] = [];
  if (total <= 0 || H <= 0) return out;
  let base = col.floorY;
  for (const p of col.parts) {
    const good = goodById(p.good);
    const h = (H * p.volume) / total;
    const pitch = LOOK_LAYER[good.look as CargoLook];
    const n = Math.max(1, Math.floor(h / pitch + 0.5));
    for (let l = 0; l < n; l++) out.push({ good: p.good, look: good.look as CargoLook, y: base + l * pitch });
    base += h;
  }
  return out;
}

export class CargoVisual {
  readonly group = new THREE.Group();
  private readonly meshes = createCargoMeshes(MAX_PER_LOOK);
  /** ship-local grid areas: each hatch rectangle plus the margin */
  readonly areas: { x0: number; x1: number; z0: number; z1: number }[];
  private readonly m = new THREE.Matrix4();
  private readonly c = new THREE.Color();
  private readonly counts: Record<CargoLook, number> = { amphora: 0, jar: 0, sack: 0, bundle: 0 };

  constructor(private readonly hold: Hold, design: ShipDesign) {
    const cargo = design.cargo;
    if (!cargo) throw new Error(`${design.name} has no cargo hold`);
    const hw = cargo.hatchHalfWidth + MARGIN;
    this.areas = cargo.hatches.map((h) => {
      const za = design.hull.zOf(h.s0), zb = design.hull.zOf(h.s1);
      return { x0: -hw, x1: hw, z0: Math.min(za, zb) - MARGIN, z1: Math.max(za, zb) + MARGIN };
    });
    for (const look of LOOKS) this.group.add(this.meshes[look]);
  }

  /** instances drawn per look at the last update */
  get instanceCounts(): Readonly<Record<CargoLook, number>> {
    return this.counts;
  }

  /** rebuild from a stowage (Hold.stow output); deterministic for the same stowage */
  update(stowed: StowedCell[]) {
    for (const look of LOOKS) {
      const mesh = this.meshes[look];
      let k = 0;
      // footprint pitch in x and z; bundles lie along z in the hold, so their 0.95 m pitch is along z
      const [px, pz] = look === 'bundle' ? [LOOK_FOOTPRINT.bundle[1], LOOK_FOOTPRINT.bundle[0]] : LOOK_FOOTPRINT[look];
      for (const a of this.areas) {
        const nx = Math.max(1, Math.floor((a.x1 - a.x0) / px));
        const nz = Math.max(1, Math.floor((a.z1 - a.z0) / pz));
        const xc = (a.x0 + a.x1) / 2, zc = (a.z0 + a.z1) / 2;
        for (let i = 0; i < nx; i++) {
          for (let j = 0; j < nz; j++) {
            const x = xc + (i - (nx - 1) / 2) * px;
            const z = zc + (j - (nz - 1) / 2) * pz;
            const layers = columnLayers(this.hold.columnFillOf(stowed, x, z));
            // top two layers of the column only
            const top = layers.slice().sort((p, q) => q.y - p.y).slice(0, 2);
            for (const l of top) {
              if (l.look !== look || k >= MAX_PER_LOOK) continue;
              const good = goodById(l.good);
              // a fixed yaw per instance for the round looks; amphorae and bundles stand as modelled
              const yaw = look === 'jar' || look === 'sack' ? hash01(k) * Math.PI * 2 : 0;
              this.m.makeRotationY(yaw).setPosition(x, l.y, z);
              mesh.setMatrixAt(k, this.m);
              mesh.setColorAt(k, this.c.setHex(good.tint));
              k++;
            }
          }
        }
      }
      mesh.count = k;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.counts[look] = k;
    }
  }
}
