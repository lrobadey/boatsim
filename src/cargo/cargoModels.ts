// Cargo models (cargo-trade spec §7.3): four procedural looks, merged and centred, feet at y = 0.
// One InstancedMesh per look with a per-instance colour from the good's tint.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchMaterial } from '../gfx/shared';

export type CargoLook = 'amphora' | 'jar' | 'sack' | 'bundle';
export const LOOKS: readonly CargoLook[] = ['amphora', 'jar', 'sack', 'bundle'];

/** the merchant's amphora profile (radius, height), moved here from merchantModel.ts */
export const AMPHORA_PROFILE: [number, number][] = [
  [0.0, 0],
  [0.06, 0.02],
  [0.17, 0.2],
  [0.2, 0.45],
  [0.16, 0.65],
  [0.07, 0.75],
  [0.06, 0.9],
  [0.08, 0.93],
];

/** a squat sack's profile (radius, height), scaled 1.15 in x */
export const SACK_PROFILE: [number, number][] = [
  [0, 0],
  [0.2, 0.02],
  [0.24, 0.12],
  [0.22, 0.3],
  [0.12, 0.4],
  [0.05, 0.44],
  [0, 0.45],
];

/** footprint pitch for the hold's visual grid (m, along x then along z) */
export const LOOK_FOOTPRINT: Record<CargoLook, [number, number]> = {
  amphora: [0.42, 0.42],
  jar: [0.32, 0.32],
  sack: [0.56, 0.5],
  bundle: [0.95, 0.3],
};
/** layer pitch in the hold (m) */
export const LOOK_LAYER: Record<CargoLook, number> = { amphora: 0.55, jar: 0.5, sack: 0.3, bundle: 0.32 };
/** layers on the quay: two for jars and sacks, one otherwise */
export const LOOK_LAYERS: Record<CargoLook, number> = { amphora: 1, jar: 2, sack: 2, bundle: 1 };

function lathe(profile: [number, number][], segments: number) {
  return new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), segments);
}

/** one look's geometry, feet at y = 0, centred on its axis */
export function lookGeometry(look: CargoLook): THREE.BufferGeometry {
  let parts: THREE.BufferGeometry[];
  switch (look) {
    case 'amphora':
      parts = [lathe(AMPHORA_PROFILE, 10)];
      break;
    case 'jar':
      // the amphora profile at 0.55 m tall and 0.30 m wide
      parts = [lathe(AMPHORA_PROFILE, 10).scale(0.75, 0.59, 0.75)];
      break;
    case 'sack':
      parts = [lathe(SACK_PROFILE, 12).scale(1.15, 1, 1)];
      break;
    case 'bundle': {
      // five rods, 0.9 m long along z: three low, two above; two rope bands
      const rods: THREE.BufferGeometry[] = [];
      for (const [x, y] of [[-0.1, 0.05], [0, 0.05], [0.1, 0.05], [-0.05, 0.145], [0.05, 0.145]] as [number, number][]) {
        rods.push(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 8).rotateX(Math.PI / 2).translate(x, y, 0));
      }
      for (const z of [-0.3, 0.3]) rods.push(new THREE.TorusGeometry(0.165, 0.01, 4, 16).scale(1, 0.6, 1).translate(0, 0.095, z));
      parts = rods;
      break;
    }
  }
  const stripped = parts.map((g) => {
    g.deleteAttribute('uv');
    return g;
  });
  const merged = mergeGeometries(stripped, false);
  merged.computeBoundingBox();
  return merged;
}

/** one InstancedMesh per look (maxPerLook instances each), per-instance colour set to white until used */
export function createCargoMeshes(maxPerLook = 400): Record<CargoLook, THREE.InstancedMesh> {
  const out = {} as Record<CargoLook, THREE.InstancedMesh>;
  for (const look of LOOKS) {
    const mat = patchMaterial(
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: look === 'sack' ? 0.95 : 0.85 }),
      undefined,
      `cargo_${look}`,
    );
    const mesh = new THREE.InstancedMesh(lookGeometry(look), mat, maxPerLook);
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < maxPerLook; i++) mesh.setColorAt(i, new THREE.Color(0xffffff));
    out[look] = mesh;
  }
  return out;
}
