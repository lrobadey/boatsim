import { HULL_LENGTH, RAM_LENGTH, zOf, sOf, halfBeam, keelDepth, sheer, section, halfWidthAt, bottomAt, buildColumns, hullWidthTable, type Column } from './hull';

/**
 * A hull, as the physics, the visual model and the water cut-out see it. Ship local frame:
 * x = starboard, y = up (0 = design waterline), z = aft. Station s in [0, 1] runs from the bow end
 * (s = 0) to the stern end (s = 1) of the planked hull; overhangs (ram, stem, sternpost) lie
 * beyond it.
 *
 * Contract for `section(s, t)`: t in [0, 1] runs from the keel bottom (t = 0) to the sheer (t = 1)
 * on the starboard side, and both x(t) and y(t) are non-decreasing in t, so `halfBeam(s)` is the
 * widest point and `halfWidthAt` / `bottomAt` can invert the section by bisection.
 */
export interface HullShape {
  /** length of the planked hull that s spans (m) */
  readonly length: number;
  /** hull structure ahead of s = 0 (ram, stem) and abaft s = 1 (sternpost), along z (m) */
  readonly bowOverhang: number;
  readonly sternOverhang: number;
  zOf(s: number): number;
  sOf(z: number): number;
  /** half-beam at the sheer (the widest point of the section) */
  halfBeam(s: number): number;
  /** depth of the keel bottom below the design waterline (negative = keel above water) */
  keelDepth(s: number): number;
  /** sheer (gunwale) height above the design waterline */
  sheer(s: number): number;
  section(s: number, t: number, out: { x: number; y: number }): { x: number; y: number };
  /** hull half-width at height y for station s (0 below the keel, halfBeam above the sheer) */
  halfWidthAt(s: number, y: number): number;
  /** hull bottom height at lateral offset x for station s (sheer outside the hull) */
  bottomAt(s: number, x: number): number;
  /** buoyancy and drag columns sampled from the hull shape */
  buildColumns(stations?: number, strips?: number): Column[];
  /** 16 half-widths at s = i / 15 for the ocean's water cut-out */
  hullWidthTable(): Float32Array;
}

/**
 * Offsets table for a table-driven hull (see `TableHull`). Generated from hull lines; all lengths
 * in metres in the ship local frame above.
 */
export interface HullOffsets {
  /** length of the planked hull that s spans */
  length: number;
  /** hull structure beyond s = 0 and s = 1 along z */
  stemOverhang: number;
  postOverhang: number;
  /** half the sided width of the keel, stem and sternpost */
  keelHalf: number;
  /** height of the design waterline (y = 0) above the lowest point of the keel */
  waterlineAboveKeel: number;
  /** stations sorted by s; every `pts` is a flat [x0, y0, x1, y1, ...] list of the same length */
  stations: { s: number; real: boolean; pts: number[] }[];
  /** lower outline of keel, stem and sternpost: flat [z0, y0, z1, y1, ...], z ascending */
  profileBottom: number[];
  /** outer sheer line: flat [z0, x0, y0, z1, x1, y1, ...], z ascending */
  sheerLine: number[];
}

/** The trireme's analytic hull, unchanged (direct references to hull.ts). */
export const TRIREME_HULL: HullShape = {
  length: HULL_LENGTH,
  bowOverhang: RAM_LENGTH,
  sternOverhang: 0,
  zOf,
  sOf,
  halfBeam,
  keelDepth,
  sheer,
  section,
  halfWidthAt,
  bottomAt,
  buildColumns,
  hullWidthTable,
};
