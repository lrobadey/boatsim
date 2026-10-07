import * as THREE from 'three';
import type { Sites, WorldGenResult } from './worldgenTypes';
import type { Terrain } from './terrain';
import type { Solid, BoxSolid } from './walkable';

/**
 * Harbour layout derived on the main thread from the generated pier site: berths alongside the
 * mole, bollards, quay steps, and the solids people walk on / the ship collides with.
 * CONTRACT (lead-owned shape): implementers fill in buildHarbour(), not the types.
 */
export interface Berth {
  id: number;
  /** e.g. "Mole, east side" */
  name: string;
  /** where the ship's CoG sits when berthed (world xz) */
  cx: number;
  cz: number;
  /** unit vector along the pier, shore → sea */
  ax: number;
  az: number;
  /** unit normal from the pier face out toward the berthed ship */
  nx: number;
  nz: number;
  /** usable face length (m) */
  length: number;
  /** quay top height (world y) */
  top: number;
  /** bollards on the quay top (world) */
  bollards: THREE.Vector3[];
}

export interface HarbourLayout {
  /** pier root on the shore, unit direction (shore → sea), length, width, top (world y) */
  root: THREE.Vector2;
  dir: THREE.Vector2;
  length: number;
  width: number;
  top: number;
  /** distance along the pier where the berth zone starts */
  berthStart: number;
  berths: Berth[];
  /** walkable/blocking solids for people (world) */
  solids: Solid[];
  /** boxes the ship hull collides with (the mole) */
  shipColliders: BoxSolid[];
  /** quay steps for swimmers, world position of the bottom tread (for UI/minimap) */
  steps: THREE.Vector3;
}

/** Quay dimensions: shared by the solids here and the pier visuals in props.ts. */
export const QUAY = {
  /** 9 risers of 2.8 / 9 m match the modelled quay_head (9 treads, 2.8 m drop) */
  riser: 2.8 / 9,
  tread: 0.35,
  stairWidth: 1.6,
  /** the flight runs from the top down to this world y (rounded to whole risers) */
  stairBottom: -1.0,
  /** bollards sit this far in from the pier face, spaced along the berth */
  bollardInset: 0.7,
  bollardSpacing: 15,
  bollardR: 0.3,
  bollardH: 0.8,
  /** ship centre line from the pier axis when berthed: half mole + outrigger + fenders */
  shipOffset: 6.0,
  /** bottom of the solid mole body (world y) */
  bottom: -8,
} as const;

/** Pier numbers in a convenient form: shore → sea unit direction u and its lateral l = (-uz, ux). */
export interface PierFrame {
  x0: number;
  z0: number;
  ux: number;
  uz: number;
  lx: number;
  lz: number;
  length: number;
  width: number;
  top: number;
  berthStart: number;
  /** walkable body length; the head beyond it is cut into the quay stairs */
  bodyLength: number;
  stairs: number;
  /** berth centre along the pier (distance from the root) */
  mid: number;
}

export function pierFrame(p: Sites['pier']): PierFrame {
  const ux = Math.cos(p.angle),
    uz = Math.sin(p.angle);
  const stairs = Math.max(1, Math.round((p.top - QUAY.stairBottom) / QUAY.riser));
  return {
    x0: p.x,
    z0: p.z,
    ux,
    uz,
    lx: -uz,
    lz: ux,
    length: p.length,
    width: p.width,
    top: p.top,
    berthStart: p.berthStart,
    bodyLength: p.length - stairs * QUAY.tread,
    stairs,
    mid: (p.berthStart + p.length) / 2,
  };
}

/** the three bollards of one side's berth (side -1 port / +1 starboard of the pier axis) */
export function berthBollards(f: PierFrame, side: -1 | 1): THREE.Vector3[] {
  const off = f.width / 2 - QUAY.bollardInset;
  const nx = side * f.lx,
    nz = side * f.lz;
  return [-QUAY.bollardSpacing, 0, QUAY.bollardSpacing].map(
    (a) => new THREE.Vector3(f.x0 + f.ux * (f.mid + a) + nx * off, f.top, f.z0 + f.uz * (f.mid + a) + nz * off),
  );
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
/** compass word for a direction in the game's heading convention (0 = north = -z, clockwise) */
function compassName(nx: number, nz: number) {
  const k = Math.round(Math.atan2(nx, -nz) / (Math.PI / 4));
  return COMPASS[((k % 8) + 8) % 8];
}

/** nominal footprint (w, l) of the house model chosen for a plot of this area */
export function houseFootprint(area: number): [number, number] {
  return area < 22 ? [4, 4] : area < 38 ? [5, 6] : [6, 8];
}

export function buildHarbour(gen: WorldGenResult, terrain: Terrain): HarbourLayout {
  void terrain; // the dredging is already in the heightmap
  const f = pierFrame(gen.sites.pier);
  const hw = f.width / 2,
    top = f.top,
    bottom = QUAY.bottom,
    head = f.bodyLength,
    sw = QUAY.stairWidth / 2;
  const solids: Solid[] = [];

  // a box over pier-along distances a..b and lateral la..lb (m from the pier axis)
  const pierBox = (a: number, b: number, la: number, lb: number, y0: number, y1: number, walkTop: boolean): BoxSolid => {
    const am = (a + b) / 2,
      lm = (la + lb) / 2;
    return {
      kind: 'box',
      cx: f.x0 + f.ux * am + f.lx * lm,
      cz: f.z0 + f.uz * am + f.lz * lm,
      hx: (b - a) / 2,
      hz: (lb - la) / 2,
      rot: Math.atan2(-f.uz, f.ux), // = -pier angle, local x along the pier
      y0,
      y1,
      surface: 'stone',
      walkTop,
    };
  };

  // mole body is walkable up to the head; the head is notched by the stairs down the middle
  solids.push(pierBox(0, head, -hw, hw, bottom, top, true));
  solids.push(pierBox(head, f.length, sw, hw, bottom, top, true), pierBox(head, f.length, -hw, -sw, bottom, top, true));
  for (let k = 0; k < f.stairs; k++) {
    const a = head + k * QUAY.tread;
    solids.push(pierBox(a, a + QUAY.tread, -sw, sw, bottom, top - QUAY.riser * (k + 1), true));
  }
  const shipColliders: BoxSolid[] = [pierBox(0, f.length, -hw, hw, bottom, top, false)];

  const berths: Berth[] = [];
  for (const side of [-1, 1] as const) {
    const nx = side * f.lx,
      nz = side * f.lz;
    const bollards = berthBollards(f, side);
    for (const v of bollards)
      solids.push({ kind: 'cyl', cx: v.x, cz: v.z, r: QUAY.bollardR, y0: top, y1: top + QUAY.bollardH, surface: 'stone', walkTop: false });
    berths.push({
      id: berths.length,
      name: `Mole, ${compassName(nx, nz)} side`,
      cx: f.x0 + f.ux * f.mid + nx * QUAY.shipOffset,
      cz: f.z0 + f.uz * f.mid + nz * QUAY.shipOffset,
      ax: f.ux,
      az: f.uz,
      nx,
      nz,
      length: f.length - f.berthStart,
      top,
      bollards,
    });
  }

  // village houses: blocking boxes (rot follows the same yaw as the rendered house)
  for (const h of gen.sites.houses) {
    // match the rendered house: the variant's footprint scaled within 0.8-1.25 (props.ts buildVillage)
    const [vw, vl] = houseFootprint(h.w * h.l);
    const w = vw * Math.min(1.25, Math.max(0.8, h.w / vw)),
      l = vl * Math.min(1.25, Math.max(0.8, h.l / vl));
    solids.push({ kind: 'box', cx: h.x, cz: h.z, hx: w / 2, hz: l / 2, rot: h.rot, y0: h.y - 1.5, y1: h.maxY + h.hgt, surface: 'stone', walkTop: false });
  }

  // temple: three-tier krepidoma (walkable), cella walls and the peristyle, as in props.ts buildTemple
  const t = gen.sites.temple;
  const TW = 14,
    TL = 31,
    rot = Math.PI / 2; // long axis east-west; local x maps to world z
  for (let s = 0; s < 3; s++)
    solids.push({ kind: 'box', cx: t.x, cz: t.z, hx: (TW + (3 - s) * 1.2) / 2, hz: (TL + (3 - s) * 1.2) / 2, rot, y0: t.y - 2, y1: t.y + 0.1 + 0.5 * s, surface: 'stone', walkTop: true });
  solids.push({ kind: 'box', cx: t.x, cz: t.z, hx: (TW - 5) / 2, hz: (TL - 9) / 2, rot, y0: t.y + 1.1, y1: t.y + 7.7, surface: 'stone', walkTop: false });
  const nxC = 6,
    nzC = 13,
    sxC = (TW - 1.6) / (nxC - 1),
    szC = (TL - 1.6) / (nzC - 1);
  for (let i = 0; i < nxC; i++)
    for (let j = 0; j < nzC; j++) {
      if (i !== 0 && i !== nxC - 1 && j !== 0 && j !== nzC - 1) continue;
      const xl = -TW / 2 + 0.8 + i * sxC,
        zl = -TL / 2 + 0.8 + j * szC;
      // rotation.y = pi/2 maps local (x, z) to world (z, -x)
      solids.push({ kind: 'cyl', cx: t.x + zl, cz: t.z - xl, r: 0.6, y0: t.y + 1.1, y1: t.y + 8.2, surface: 'stone', walkTop: false });
    }

  const bottomTread = top - QUAY.riser * f.stairs;
  const stepAlong = head + (f.stairs - 0.5) * QUAY.tread;
  return {
    root: new THREE.Vector2(f.x0, f.z0),
    dir: new THREE.Vector2(f.ux, f.uz),
    length: f.length,
    width: f.width,
    top,
    berthStart: f.berthStart,
    berths,
    solids,
    shipColliders,
    steps: new THREE.Vector3(f.x0 + f.ux * stepAlong, bottomTread, f.z0 + f.uz * stepAlong),
  };
}
