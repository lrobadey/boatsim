import * as THREE from 'three';
import { TRIREME, type SailRig } from './design';

/** Shared planar square-rig dimensions used by cloth rendering and sail loading. */
export const SAIL_RIG = Object.freeze({
  width: 10,
  height: 7,
  area: 70,
  mastStation: 0.42,
  mastHeight: 11.5,
  yardDrop: 0.7,
  clothTopDrop: 0.1,
  clothOffsetZ: 0.2,
  yardLength: 12.5,
  maxYardAngle: Math.PI / 4,
  sampleCount: 9,
});

const ROWS = 3;
const COLUMNS = 3;

/**
 * Return the hull-local center of one of the row-major 3×3 sail panels.
 * `set` is exposed sail height as a fraction of the full cloth.
 */
export function evaluateSailSample(index: number, set: number, yard: number, out: THREE.Vector3, rig: SailRig = TRIREME.rig): THREE.Vector3 {
  const column = index % COLUMNS;
  const row = Math.floor(index / COLUMNS);
  const fraction = Number.isFinite(set) ? Math.max(0, Math.min(1, set)) : 0;
  const x = rig.width * ((column + 0.5) / COLUMNS - 0.5);
  const y = -rig.clothTopDrop - rig.height * fraction * ((row + 0.5) / ROWS);
  const z = rig.clothOffsetZ;
  const c = Math.cos(yard);
  const s = Math.sin(yard);
  const yardY = rig.yardY;
  const yardZ = rig.yardZ;
  // THREE's positive y rotation: x'=x*cos+z*sin, z'=-x*sin+z*cos.
  return out.set(x * c + z * s, yardY + y, -x * s + z * c + yardZ);
}

/** Geometric area represented by each of the nine equally sized samples. */
export function sailSampleArea(set: number, rig: SailRig = TRIREME.rig): number {
  const fraction = Number.isFinite(set) ? Math.max(0, Math.min(1, set)) : 0;
  return (rig.area * fraction) / rig.sampleCount;
}
