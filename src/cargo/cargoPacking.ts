// Deterministic whole-package subset visible through the hold hatches. Fixed dunnage gives packages
// a real wooden support surface; the hold remains authoritative for inventory and physics.
import * as THREE from 'three';
import type { ShipDesign } from '../ship/design';
import { GOODS, type GoodId } from '../trade/goods';
import { lookGeometry, type CargoLook } from './cargoModels';
import type { Manifest } from './hold';

export interface CargoPlacement {
  id: string;
  good: GoodId;
  look: CargoLook;
  /** InstancedMesh origin in ship-local coordinates, including model bbox-min correction. */
  position: THREE.Vector3;
  yaw: number;
  /** Exact mesh-vertex bounds after yaw and translation, in ship-local coordinates. */
  bounds: THREE.Box3;
}

export interface DunnageBearer {
  x0: number; x1: number; z0: number; z1: number;
  y0: number; y1: number;
}

export interface DunnagePlatform {
  hatchIndex: number;
  x0: number; x1: number; z0: number; z1: number;
  /** top of the horizontal plank faces */
  top: number;
  thickness: 0.04;
  bearers: DunnageBearer[];
}

const HATCH_INSET = 0.075;
const CLEARANCE = 0.015;
const MAX_PER_LOOK = 400;
const HULL_MARGIN = 0.025;
const MAST_CLEAR = 0.3;
const FLOOR_CLEAR = 0.01;
const DUNNAGE_THICKNESS = 0.04;
const BEARER_THICKNESS = 0.06;
const BEARER_WIDTH = 0.08;

interface ShapeCache { min: THREE.Vector3; max: THREE.Vector3; points: THREE.Vector3[]; }
const shapeCache = new Map<CargoLook, ShapeCache>();

function localBounds(look: CargoLook): ShapeCache {
  const cached = shapeCache.get(look);
  if (cached) return cached;
  const geometry = lookGeometry(look);
  const pos = geometry.getAttribute('position');
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const points: THREE.Vector3[] = [];
  const seen = new Set<string>();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    min.min(v); max.max(v);
    const key = `${v.x.toFixed(5)}:${v.y.toFixed(5)}:${v.z.toFixed(5)}`;
    if (!seen.has(key)) { seen.add(key); points.push(v.clone()); }
  }
  geometry.dispose();
  const value = { min, max, points };
  shapeCache.set(look, value);
  return value;
}

function hatchRects(design: ShipDesign) {
  const cargo = design.cargo!;
  return cargo.hatches.map((h, hatchIndex) => {
    const za = design.hull.zOf(h.s0), zb = design.hull.zOf(h.s1);
    return {
      hatchIndex,
      x0: -cargo.hatchHalfWidth + HATCH_INSET,
      x1: cargo.hatchHalfWidth - HATCH_INSET,
      z0: Math.min(za, zb) + HATCH_INSET,
      z1: Math.max(za, zb) - HATCH_INSET,
    };
  });
}

const sampleZ = (z0: number, z1: number, i: number) => z0 + ((z1 - z0) * i) / 8;

/** Lowest y whose actual hull section supports the full dunnage width at this longitudinal sample. */
function minimumSupportY(design: ShipDesign, z: number, maxAbsX: number): number | null {
  const s = design.hull.sOf(z);
  const low0 = -design.hull.keelDepth(s);
  const high0 = design.deck.deckY(s) - design.cargo!.hold.ceilingBelowDeck;
  if (design.hull.halfWidthAt(s, high0) < maxAbsX) return null;
  let low = low0, high = high0;
  for (let i = 0; i < 36; i++) {
    const mid = (low + high) / 2;
    if (design.hull.halfWidthAt(s, mid) >= maxAbsX) high = mid;
    else low = mid;
  }
  return high;
}

/** Fixed wooden decklet per hatch, statically supported by the hull profile. */
export function getDunnagePlatforms(design: ShipDesign): DunnagePlatform[] {
  const cargo = design.cargo;
  if (!cargo) return [];
  const platforms: DunnagePlatform[] = [];
  const maxAbsX = Math.max(...hatchRects(design).map((r) => Math.max(Math.abs(r.x0), Math.abs(r.x1)))) + HULL_MARGIN;
  const tallest = Math.max(...GOODS.map((g) => localBounds(g.look as CargoLook).max.y - localBounds(g.look as CargoLook).min.y));
  for (const rect of hatchRects(design)) {
    const supportYs: number[] = [];
    let minimumDeckY = Infinity;
    let fits = true;
    for (let i = 0; i < 9; i++) {
      const z = sampleZ(rect.z0, rect.z1, i), s = design.hull.sOf(z);
      const y = minimumSupportY(design, z, maxAbsX);
      if (y === null) { fits = false; break; }
      supportYs.push(y);
      minimumDeckY = Math.min(minimumDeckY, design.deck.deckY(s) - cargo.hold.ceilingBelowDeck);
    }
    if (!fits || supportYs.length !== 9) continue;
    const top = Math.max(...supportYs) + DUNNAGE_THICKNESS;
    if (top + FLOOR_CLEAR + tallest > minimumDeckY + 1e-6) continue;
    const bearers: DunnageBearer[] = [];
    let bearersFit = true;
    for (const fraction of [0.1, 0.5, 0.9]) {
      const center = rect.z0 + fraction * (rect.z1 - rect.z0);
      const z0 = Math.max(rect.z0, center - BEARER_WIDTH / 2);
      const z1 = Math.min(rect.z1, center + BEARER_WIDTH / 2);
      const bearerBottom = top - DUNNAGE_THICKNESS - BEARER_THICKNESS;
      const halfWidths = [z0, (z0 + z1) / 2, z1].map((z) => {
        const s = design.hull.sOf(z);
        return design.hull.halfWidthAt(s, bearerBottom);
      });
      const halfWidth = Math.min(...halfWidths) - 0.005;
      if (halfWidth <= 0) { bearersFit = false; break; }
      bearers.push({ x0: -halfWidth, x1: halfWidth, z0, z1, y0: bearerBottom, y1: top - DUNNAGE_THICKNESS });
    }
    if (!bearersFit) continue;
    platforms.push({ ...rect, top, thickness: DUNNAGE_THICKNESS, bearers });
  }
  return platforms;
}

function makeBounds(shape: ShapeCache, x: number, bottom: number, z: number) {
  return new THREE.Box3(
    new THREE.Vector3(x + shape.min.x, bottom, z + shape.min.z),
    new THREE.Vector3(x + shape.max.x, bottom + (shape.max.y - shape.min.y), z + shape.max.z),
  );
}

function overlaps(a: THREE.Box3, b: THREE.Box3) {
  return a.min.x < b.max.x + CLEARANCE && a.max.x + CLEARANCE > b.min.x &&
    a.min.y < b.max.y + CLEARANCE && a.max.y + CLEARANCE > b.min.y &&
    a.min.z < b.max.z + CLEARANCE && a.max.z + CLEARANCE > b.min.z;
}

function fitsHull(bounds: THREE.Box3, design: ShipDesign, shape: ShapeCache, x: number, originY: number, z: number) {
  const { hull, deck, cargo } = design;
  const mastZ = hull.zOf(design.rig.mastStation);
  const closestX = bounds.min.x <= 0 && bounds.max.x >= 0 ? 0 : Math.min(Math.abs(bounds.min.x), Math.abs(bounds.max.x));
  const closestZ = mastZ < bounds.min.z ? bounds.min.z - mastZ : mastZ > bounds.max.z ? mastZ - bounds.max.z : 0;
  if (Math.hypot(closestX, closestZ) < MAST_CLEAR) return false;
  for (const zBound of [bounds.min.z, bounds.max.z]) {
    const s = hull.sOf(zBound);
    if (bounds.max.y > deck.deckY(s) - cargo!.hold.ceilingBelowDeck + 1e-6) return false;
  }
  // Follow the actual mesh surface through each hull section, not corners that the curved model lacks.
  for (const point of shape.points) {
    const px = x + point.x, py = originY + point.y, pz = z + point.z;
    const s = hull.sOf(pz);
    if (Math.abs(px) > hull.halfWidthAt(s, py) - HULL_MARGIN) return false;
  }
  return true;
}

interface Candidate { hatchIndex: number; x: number; z: number; d2: number; }
function rowCandidates(rect: ReturnType<typeof hatchRects>[number], shape: ShapeCache): Candidate[] {
  const width = rect.x1 - rect.x0, depth = rect.z1 - rect.z0;
  const px = shape.max.x - shape.min.x, pz = shape.max.z - shape.min.z;
  const nx = Math.floor((width + CLEARANCE) / (px + CLEARANCE));
  const nz = Math.floor((depth + CLEARANCE) / (pz + CLEARANCE));
  if (nx < 1 || nz < 1) return [];
  const stepX = px + CLEARANCE, stepZ = pz + CLEARANCE;
  const xCenter = (rect.x0 + rect.x1) / 2, zCenter = (rect.z0 + rect.z1) / 2;
  const out: Candidate[] = [];
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
    const x = xCenter + (ix - (nx - 1) / 2) * stepX - (shape.min.x + shape.max.x) / 2;
    const z = zCenter + (iz - (nz - 1) / 2) * stepZ - (shape.min.z + shape.max.z) / 2;
    out.push({ hatchIndex: rect.hatchIndex, x, z, d2: (x - xCenter) ** 2 + (z - zCenter) ** 2 });
  }
  out.sort((a, b) => a.d2 - b.d2 || a.z - b.z || a.x - b.x);
  return out;
}

/** Pack complete mesh models on fixed dunnage tops, never adding hidden units to the visible subset. */
export function packVisibleCargo(manifest: Manifest, design: ShipDesign): CargoPlacement[] {
  const cargo = design.cargo;
  if (!cargo) return [];
  const platforms = getDunnagePlatforms(design);
  const platformByHatch = new Map(platforms.map((p) => [p.hatchIndex, p]));
  const rects = hatchRects(design);
  const goods = GOODS.filter((g) => Math.floor(manifest[g.id] ?? 0) > 0).slice().sort(
    (a, b) => b.mass / b.stow - a.mass / a.stow || GOODS.indexOf(a) - GOODS.indexOf(b),
  );
  const out: CargoPlacement[] = [];
  const lookCounts: Partial<Record<CargoLook, number>> = {};
  for (const good of goods) {
    const requested = Math.max(0, Math.floor(manifest[good.id] ?? 0));
    const look = good.look as CargoLook;
    const left = Math.max(0, MAX_PER_LOOK - (lookCounts[look] ?? 0));
    const shape = localBounds(look);
    const spots = rects.flatMap((rect) => platformByHatch.has(rect.hatchIndex) ? rowCandidates(rect, shape) : []);
    const count = Math.min(requested, left);
    for (let ordinal = 1; ordinal <= count; ordinal++) {
      let placement: CargoPlacement | undefined;
      for (const spot of spots) {
        const platform = platformByHatch.get(spot.hatchIndex)!;
        const boxBottom = platform.top + FLOOR_CLEAR;
        const originY = boxBottom - shape.min.y;
        const bounds = makeBounds(shape, spot.x, boxBottom, spot.z);
        if (!fitsHull(bounds, design, shape, spot.x, originY, spot.z)) continue;
        if (out.some((prior) => overlaps(bounds, prior.bounds))) continue;
        placement = {
          id: `${good.id}:${ordinal}`, good: good.id, look,
          position: new THREE.Vector3(spot.x, originY, spot.z), yaw: 0, bounds,
        };
        break;
      }
      if (!placement) break;
      out.push(placement);
      lookCounts[look] = (lookCounts[look] ?? 0) + 1;
    }
  }
  return out;
}
