import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { DevVessel } from '../game';
import type { WorldGenResult } from '../world/worldgenTypes';
import { findOpenWaterStart } from '../world/openWaterStart';
import { demiBeam, HULL_OFFSET } from '../../ship-study/browser/design';
import shellUrl from '../../ship-study/browser/assets/thalassa-shell.glb?url';
import woodColorUrl from '../../harbor-study/blender/textures/wood_color.png?url';
import { ThalassaModel } from './thalassaModel';
import { isPaddleVariant } from './paddleVariants';
export { makeThalassaDesign } from './thalassaDesign';

/**
 * Blender's wood_color.png tints (build_thalassa.py), each scaled by one brightness factor. That palette
 * was judged under studio area lights and AgX and reads near-black in the game's sun and sky; the
 * scales keep its hue and bring luminance toward the game's planking (≈ 0.3): deck 0.31,
 * hull 0.17, oiled structure 0.10.
 */
const TIMBER_TINTS: Record<string, [number, number, number]> = {
  'Honey teak | deck': [1.65 * 2.2, 1.42 * 2.2, 1.12 * 2.2],
  'Cedar | hull': [0.60 * 3.8, 0.45 * 3.8, 0.28 * 3.8],
  'Oiled timber | structure': [0.34 * 3.6, 0.27 * 3.6, 0.20 * 3.6],
};

/** The export drops Blender's color texture; restore it, sharing the normal map's UV transform. */
function applyTimberColor(shell: THREE.Object3D, wood: THREE.Texture) {
  shell.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      const tint = TIMBER_TINTS[material.name];
      if (!tint || !(material instanceof THREE.MeshStandardMaterial) || material.map) continue;
      const map = wood.clone();
      const ref = material.normalMap;
      if (ref) { map.offset.copy(ref.offset); map.repeat.copy(ref.repeat); map.rotation = ref.rotation; map.center.copy(ref.center); map.channel = ref.channel; }
      map.needsUpdate = true;
      material.map = map;
      material.color.setRGB(...tint, THREE.LinearSRGBColorSpace);
      material.needsUpdate = true;
    }
  });
}

export async function loadThalassa(gen: WorldGenResult, heading: number, paddles = false): Promise<DevVessel> {
  const start = findOpenWaterStart(gen, heading);
  const [{ scene }, wood] = await Promise.all([new GLTFLoader().loadAsync(shellUrl), new THREE.TextureLoader().loadAsync(woodColorUrl)]);
  // glTF texture transforms assume an unflipped image
  wood.flipY = false; wood.colorSpace = THREE.SRGBColorSpace;
  wood.wrapS = wood.wrapT = THREE.RepeatWrapping; wood.anisotropy = 8;
  applyTimberColor(scene, wood);
  const requested = new URLSearchParams(location.search).get('paddle');
  const variant = paddles ? (isPaddleVariant(requested) ? requested : 'helios') : undefined;
  return { start, hullOffset: HULL_OFFSET,
    hullWidths: Float32Array.from({ length: 16 }, (_, i) => demiBeam(i / 15)),
    createModel: ship => new ThalassaModel(scene, ship, undefined, variant),
    buildSolids: solids => {
      for (const [z, height] of [[-12, 24], [14.8, 19]]) {
        solids.add({ kind: 'cyl', cx: 0, cz: z, r: 0.4, y0: 5.55, y1: 5.55 + height, surface: 'wood', walkTop: false });
      }
      for (const side of [-1, 1]) {
        solids.add({ kind: 'box', cx: side * 8.5, cz: 20, hx: 2.15, hz: 7, rot: 0,
          y0: 5.55, y1: 8.62, surface: 'wood', walkTop: true });
      }
    },
  };
}
