// Cargo hold (cargo-trade spec §5.3, §6.1): hold cells, stowage and the static load it adds to the ship.
// Pure: no scene and no physics. Coordinates are ship-local (y = 0 at the design waterline).
import * as THREE from 'three';
import type { CargoDesign, ShipDesign } from '../ship/design';
import { GOODS, type GoodId } from '../trade/goods';

/** units per good (jars, sacks, bundles) */
export type Manifest = Partial<Record<GoodId, number>>;

/** one hold cell: the clipped box the cell keeps inside the hull */
export interface HoldCell {
  /** centre of the clipped width (static-load position), ship-local */
  x: number;
  y: number;
  z: number;
  /** station of the cell centre */
  s: number;
  /** bottom and top of the cell (y) */
  bottom: number;
  top: number;
  /** layer index above the station's own floor (fill order, tier by tier) */
  layer: number;
  /** inner edge |x| (fill order) */
  xIn: number;
  /** clipped width across x (m) */
  width: number;
  /** capacity of the cell (m³) = width x cell[1] x cell[2] */
  volume: number;
}

export interface StowedPart {
  good: GoodId;
  /** hold volume taken (m³) */
  volume: number;
}

/** a cell with its stowage: mass in kg, parts in stowing order */
export interface StowedCell {
  cell: HoldCell;
  mass: number;
  parts: StowedPart[];
}

/** a mass at a ship-local point, as setStaticLoad takes it */
export interface StaticItem {
  mass: number;
  local: THREE.Vector3;
}

/** the hold column under a deck point: floor, top of the cargo there, and the parts in it */
export interface ColumnFill {
  /** hold floor under the point (y) */
  floorY: number;
  /** top of the highest filled cell in the column (y); the floor when it is empty */
  topY: number;
  parts: StowedPart[];
}

/** Build the hold cells of a design (§6.1), in fill order. */
function buildCells(design: ShipDesign, cargo: CargoDesign): HoldCell[] {
  const { hull } = design;
  const h = cargo.hold;
  const [cellX, cellY, cellZ] = h.cell;
  const zA = hull.zOf(h.sFrom), zB = hull.zOf(h.sTo);
  const zLo = Math.min(zA, zB), zHi = Math.max(zA, zB);
  const nz = Math.floor((zHi - zLo) / cellZ + 1e-9);
  const zMast = hull.zOf(design.rig.mastStation);
  const cells: HoldCell[] = [];
  for (let k = 0; k < nz; k++) {
    const zc = zLo + (k + 0.5) * cellZ;
    const sc = hull.sOf(zc);
    const floorY = -hull.keelDepth(sc) + h.floorAboveKeel;
    const ceilY = design.deck.deckY(sc) - h.ceilingBelowDeck;
    const nLayers = Math.floor((ceilY - floorY) / cellY + 1e-9);
    for (let j = 0; j < nLayers; j++) {
      const y0 = floorY + j * cellY, y1 = y0 + cellY, yc = (y0 + y1) / 2;
      const hw = hull.halfWidthAt(sc, yc) - h.margin;
      for (let i = 0; i * cellX < hw; i++) {
        const xIn = i * cellX, xOut = xIn + cellX;
        for (const sg of [-1, 1]) {
          const xc = (sg * (xIn + xOut)) / 2;
          // the mast's clearance uses the unclipped cell centre
          if (Math.hypot(xc, zc - zMast) <= h.mastClear) continue;
          const edge = Math.min(xOut, hw);
          const width = edge - xIn;
          if (width <= 0) continue;
          cells.push({
            x: (sg * (xIn + edge)) / 2,
            y: yc,
            z: zc,
            s: sc,
            bottom: y0,
            top: y1,
            layer: j,
            xIn,
            width,
            volume: width * cellY * cellZ,
          });
        }
      }
    }
  }
  // fill order (§6.1): layer above each station's own floor, then |x| out, then |z - design CG z| out
  // with fore before aft, port before starboard
  const cgZ = design.mass.cgZ;
  cells.sort(
    (a, b) =>
      a.layer - b.layer ||
      a.xIn - b.xIn ||
      Math.abs(a.z - cgZ) - Math.abs(b.z - cgZ) ||
      a.z - b.z ||
      a.x - b.x,
  );
  return cells;
}

export class Hold {
  /** cells in fill order */
  readonly cells: HoldCell[];
  /** total capacity (m³) */
  readonly capacity: number;
  /** the design's baked-in block that the hold takes over */
  readonly reference: { mass: number; local: THREE.Vector3 };
  /** half the cell's z extent (column membership) */
  private readonly halfCellZ: number;
  /** stowage of the current manifest (setManifest) */
  private stowed: StowedCell[] = [];

  constructor(readonly design: ShipDesign) {
    const cargo = design.cargo;
    if (!cargo) throw new Error(`${design.name} has no cargo hold`);
    this.cells = buildCells(design, cargo);
    this.halfCellZ = cargo.hold.cell[2] / 2;
    this.capacity = this.cells.reduce((a, c) => a + c.volume, 0);
    this.reference = { mass: cargo.reference.mass, local: new THREE.Vector3(...cargo.reference.local) };
  }

  /**
   * Stowage of a manifest (pure, a function of the manifest alone): goods sorted by density (mass/stow)
   * descending, then poured into the cells in fill order, spilling into the next cell. Throws when the
   * manifest's volume is above the hold's capacity.
   */
  stow(manifest: Manifest): StowedCell[] {
    const out: StowedCell[] = this.cells.map((cell) => ({ cell, mass: 0, parts: [] }));
    const lots = GOODS.filter((g) => (manifest[g.id] ?? 0) > 0).sort(
      (a, b) => b.mass / b.stow - a.mass / a.stow || (a.id < b.id ? -1 : 1),
    );
    let total = 0;
    for (const g of lots) total += (manifest[g.id] ?? 0) * g.stow;
    if (total > this.capacity + 1e-9) {
      throw new Error(`stow: ${total.toFixed(3)} m³ is over the hold's ${this.capacity.toFixed(3)} m³`);
    }
    let k = 0;
    let room = this.cells.length ? this.cells[0].volume : 0;
    for (const g of lots) {
      let left = (manifest[g.id] ?? 0) * g.stow;
      while (left > 1e-12) {
        while (room <= 1e-12 && k + 1 < this.cells.length) room = this.cells[++k].volume;
        if (room <= 1e-12) break; // rounding at the very top of a full hold
        const take = Math.min(left, room);
        const cell = out[k];
        const part = cell.parts.find((p) => p.good === g.id);
        if (part) part.volume += take;
        else cell.parts.push({ good: g.id, volume: take });
        cell.mass += (take / g.stow) * g.mass;
        left -= take;
        room -= take;
      }
    }
    return out;
  }

  /**
   * Static load for setStaticLoad: the reference block comes out, then each filled cell goes in at its
   * centre. An empty manifest still removes the reference: she floats light.
   */
  staticLoad(manifest: Manifest): StaticItem[] {
    const items: StaticItem[] = [{ mass: -this.reference.mass, local: this.reference.local.clone() }];
    for (const sc of this.stow(manifest)) {
      if (sc.mass > 0) items.push({ mass: sc.mass, local: new THREE.Vector3(sc.cell.x, sc.cell.y, sc.cell.z) });
    }
    return items;
  }

  /** the stowage shown by the visuals: stow(manifest) kept as the current state */
  setManifest(manifest: Manifest) {
    this.stowed = this.stow(manifest);
  }

  /** the hold column under a deck point (x, z), from the current stowage */
  columnFill(x: number, z: number): ColumnFill {
    return this.columnFillOf(this.stowed, x, z);
  }

  /** the hold column under a deck point (x, z), from the given stowage (stow() output) */
  columnFillOf(stowed: StowedCell[], x: number, z: number): ColumnFill {
    let floorY = Infinity;
    for (const c of this.cells) {
      if (Math.abs(c.z - z) <= this.halfCellZ + 1e-9 && Math.abs(c.x - x) <= c.width / 2 + 1e-9) floorY = Math.min(floorY, c.bottom);
    }
    let topY = -Infinity;
    const acc = new Map<GoodId, number>();
    for (const sc of stowed) {
      const c = sc.cell;
      if (sc.mass <= 0 || Math.abs(c.z - z) > this.halfCellZ + 1e-9 || Math.abs(c.x - x) > c.width / 2 + 1e-9) continue;
      topY = Math.max(topY, c.top);
      for (const p of sc.parts) acc.set(p.good, (acc.get(p.good) ?? 0) + p.volume);
    }
    if (!Number.isFinite(floorY)) floorY = 0;
    if (!Number.isFinite(topY)) topY = floorY;
    return { floorY, topY, parts: [...acc].map(([good, volume]) => ({ good, volume })) };
  }
}
