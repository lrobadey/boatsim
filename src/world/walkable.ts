import * as THREE from 'three';

/**
 * Static walk/collision geometry for people (not the ship): terrain plus a set of simple solids —
 * vertical oriented boxes and cylinders. Boxes with `walkTop` are floors (quay, steps, stylobate,
 * crates); everything else only blocks. The same type describes ship-local solids (deck pieces),
 * with coordinates in the ship frame and no terrain.
 */
export type SurfaceKind = 'wood' | 'stone' | 'sand' | 'grass' | 'rock' | 'shallows';

export interface BoxSolid {
  kind: 'box';
  cx: number;
  cz: number;
  /** half extents along the box's local x / z */
  hx: number;
  hz: number;
  /** yaw (rad): local x axis = (cos rot, -sin rot) in world xz, matching THREE rotation.y */
  rot: number;
  y0: number;
  y1: number;
  surface: SurfaceKind;
  walkTop: boolean;
}
export interface CylSolid {
  kind: 'cyl';
  cx: number;
  cz: number;
  r: number;
  y0: number;
  y1: number;
  surface: SurfaceKind;
  walkTop: boolean;
}
export type Solid = BoxSolid | CylSolid;

export interface Support {
  y: number;
  nx: number;
  ny: number;
  nz: number;
  kind: SurfaceKind;
  /** the solid supplying the floor, null for terrain */
  solid: Solid | null;
}

export interface GroundSource {
  heightAt(x: number, z: number): number;
  normalAt(x: number, z: number, out: THREE.Vector3): unknown;
}

const CELL = 16;

/** box-local coordinates of a world point */
function toBox(b: BoxSolid, x: number, z: number, out: { u: number; v: number }) {
  const dx = x - b.cx,
    dz = z - b.cz;
  const c = Math.cos(b.rot),
    s = Math.sin(b.rot);
  // inverse of rotation.y: local x = (c, -s), local z = (s, c)
  out.u = dx * c - dz * s;
  out.v = dx * s + dz * c;
  return out;
}

export class WalkGeometry {
  readonly solids: Solid[] = [];
  /**
   * Per-frame solids (moving crew, spec §9.8), checked brute-force in every query. Keep it short.
   * Dynamic solids must have walkTop false; they never act as floors.
   */
  readonly dynamic: Solid[] = [];
  private grid = new Map<number, Solid[]>();
  private uv = { u: 0, v: 0 };
  private n = new THREE.Vector3();

  /** @param ground terrain (world) or null (ship frame: only solids) */
  constructor(private ground: GroundSource | null, private groundKind: (x: number, z: number, y: number, slopeY: number) => SurfaceKind = defaultKind) {}

  add(s: Solid) {
    this.solids.push(s);
    const r = s.kind === 'cyl' ? s.r : Math.hypot(s.hx, s.hz);
    for (let gx = Math.floor((s.cx - r) / CELL); gx <= Math.floor((s.cx + r) / CELL); gx++)
      for (let gz = Math.floor((s.cz - r) / CELL); gz <= Math.floor((s.cz + r) / CELL); gz++) {
        const k = key(gx, gz);
        let list = this.grid.get(k);
        if (!list) this.grid.set(k, (list = []));
        list.push(s);
      }
  }

  remove(s: Solid) {
    const i = this.solids.indexOf(s);
    if (i < 0) return;
    this.solids.splice(i, 1);
    for (const list of this.grid.values()) {
      const j = list.indexOf(s);
      if (j >= 0) list.splice(j, 1);
    }
  }

  clear() {
    this.solids.length = 0;
    this.grid.clear();
  }

  near(x: number, z: number): readonly Solid[] {
    return this.grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) ?? EMPTY;
  }

  /** is (x,z) inside the solid's footprint, grown by r */
  inside(s: Solid, x: number, z: number, r = 0) {
    if (s.kind === 'cyl') return Math.hypot(x - s.cx, z - s.cz) < s.r + r;
    const p = toBox(s, x, z, this.uv);
    return Math.abs(p.u) < s.hx + r && Math.abs(p.v) < s.hz + r;
  }

  /**
   * Highest floor under (x,z) whose top is at or below maxY (feet + step height). Terrain always
   * counts when present. Returns false (out untouched) when nothing supports the point.
   */
  support(x: number, z: number, maxY: number, out: Support): boolean {
    let found = false;
    if (this.ground) {
      const h = this.ground.heightAt(x, z);
      if (h <= maxY) {
        this.ground.normalAt(x, z, this.n);
        const n = this.n;
        out.y = h;
        out.nx = n.x;
        out.ny = n.y;
        out.nz = n.z;
        out.kind = this.groundKind(x, z, h, n.y);
        out.solid = null;
        found = true;
      }
    }
    for (const s of this.near(x, z)) {
      if (!s.walkTop || s.y1 > maxY || (found && s.y1 <= out.y)) continue;
      if (!this.inside(s, x, z)) continue;
      out.y = s.y1;
      out.nx = 0;
      out.ny = 1;
      out.nz = 0;
      out.kind = s.surface;
      out.solid = s;
      found = true;
    }
    for (const s of this.dynamic) {
      if (!s.walkTop || s.y1 > maxY || (found && s.y1 <= out.y)) continue;
      if (!this.inside(s, x, z)) continue;
      out.y = s.y1;
      out.nx = 0;
      out.ny = 1;
      out.nz = 0;
      out.kind = s.surface;
      out.solid = s;
      found = true;
    }
    return found;
  }

  /**
   * Push a vertical capsule (centre x,z radius r, spanning y0..y1) out of every solid it overlaps
   * whose vertical span intersects it. Solids whose top is within `stepUp` of y0 are ignored (they
   * are floors to step onto). Writes the corrected position; returns true on contact.
   */
  collide(x: number, z: number, r: number, y0: number, y1: number, stepUp: number, out: { x: number; z: number }): boolean {
    let hit = false;
    out.x = x;
    out.z = z;
    for (let iter = 0; iter < 2; iter++) {
      for (const s of this.near(out.x, out.z)) if (this.pushOut(s, r, y0, y1, stepUp, out)) hit = true;
      for (const s of this.dynamic) if (this.pushOut(s, r, y0, y1, stepUp, out)) hit = true;
    }
    return hit;
  }

  /** one push-out of the capsule (centre in out, radius r) from solid s; true when it overlapped */
  private pushOut(s: Solid, r: number, y0: number, y1: number, stepUp: number, out: { x: number; z: number }): boolean {
    if (s.y1 <= y0 + stepUp || s.y0 >= y1) return false;
    if (s.kind === 'cyl') {
      const dx = out.x - s.cx,
        dz = out.z - s.cz;
      const d = Math.hypot(dx, dz);
      const min = s.r + r;
      if (d >= min) return false;
      const k = d > 1e-6 ? min / d : 0;
      out.x = s.cx + (d > 1e-6 ? dx * k : min);
      out.z = s.cz + dz * k;
      return true;
    }
    const p = toBox(s, out.x, out.z, this.uv);
    const ox = s.hx + r - Math.abs(p.u),
      oz = s.hz + r - Math.abs(p.v);
    if (ox <= 0 || oz <= 0) return false;
    // shove along the axis of least penetration, back to world
    let du = 0,
      dv = 0;
    if (ox < oz) du = Math.sign(p.u || 1) * ox;
    else dv = Math.sign(p.v || 1) * oz;
    const c = Math.cos(s.rot),
      sn = Math.sin(s.rot);
    out.x += du * c + dv * sn;
    out.z += -du * sn + dv * c;
    return true;
  }
}

const EMPTY: Solid[] = [];
const key = (gx: number, gz: number) => (gx + 4096) * 8192 + (gz + 4096);

function defaultKind(_x: number, _z: number, y: number, slopeY: number): SurfaceKind {
  if (y < 0.4) return 'sand';
  if (slopeY < 0.82) return 'rock';
  return y < 2.5 ? 'sand' : 'grass';
}
