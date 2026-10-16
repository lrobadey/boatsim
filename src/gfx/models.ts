import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { patchMaterial } from './shared';
import type { VisualAssets } from './assets';

/** Blender kit exported by tools/blender (WS-C). Every object is built at its file's origin. */
export const MODEL_FILES = [
  'quay_segment.glb',
  'quay_head.glb',
  'bollard.glb',
  'gangplank.glb',
  'anchor.glb',
  'fender.glb',
  'dock_props.glb',
  'house_a.glb',
  'house_b.glb',
  'house_c.glb',
  'figures.glb',
  'crew.glb',
];

export interface ModelKit {
  /** every named object across the kit (source copies; prefer get() for an instance) */
  objects: Map<string, THREE.Object3D>;
  /** a new instance of a named object; geometry and slot materials are shared */
  get(name: string): THREE.Object3D;
  /** the geometries under a named object */
  geometry(name: string): THREE.BufferGeometry[];
  /** every sub-mesh under the named objects with its shared slot material, for InstancedMesh batches */
  parts(names: string | string[]): { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial }[];
  /** the shared material behind a slot; the game drives `fire` (lamps, house windows) by night */
  material(slot: string): THREE.MeshStandardMaterial;
  /** the AnimationClips of a loaded glb, by file name (e.g. 'crew.glb'); empty if it has none or is not loaded */
  clips(file: string): THREE.AnimationClip[];
}

const ROOT = '/assets/models/';

/** One shared material per Blender slot, all routed through the game's shader patch. */
function makeSlots(assets: VisualAssets): Map<string, THREE.Material> {
  const slots = new Map<string, THREE.Material>();
  const textured = (key: string, maps: VisualAssets['stone'], tint: number, normal: number) =>
    patchMaterial(
      new THREE.MeshStandardMaterial({
        map: maps.color,
        normalMap: maps.normal,
        roughnessMap: maps.roughness,
        normalScale: new THREE.Vector2(normal, normal),
        roughness: 1,
        color: tint,
      }),
      undefined,
      key,
    );
  const plain = (key: string, p: THREE.MeshStandardMaterialParameters) =>
    patchMaterial(new THREE.MeshStandardMaterial(p), undefined, key);

  slots.set('stone', textured('stone', assets.stone, 0xffffff, 0.5));
  slots.set('stone_dark', textured('stone_dark', assets.stone, 0x9c968a, 0.5));
  slots.set('wood', textured('wood', assets.planks, 0xffffff, 0.4));
  slots.set('wood_dark', textured('wood_dark', assets.planks, 0x7a6252, 0.4));
  slots.set('bronze', plain('bronze', { color: 0xb8863e, metalness: 0.85, roughness: 0.35 }));
  slots.set('iron', plain('iron', { color: 0x4a4d52, metalness: 0.9, roughness: 0.5 }));
  slots.set('rope', plain('rope', { color: 0xb9a27a, roughness: 0.95, side: THREE.DoubleSide }));
  slots.set('clay', plain('clay', { color: 0xa8603a, roughness: 0.85 }));
  slots.set('plaster', plain('plaster', { color: 0xf2eee4, roughness: 0.92 }));
  slots.set('roof_tile', plain('roof_tile', { color: 0xa4553a, roughness: 0.8 }));
  slots.set('cloth', plain('cloth', { color: 0xe8e0cc, roughness: 0.9, side: THREE.DoubleSide }));
  slots.set('cloth_red', plain('cloth_red', { color: 0x8f2a1c, roughness: 0.9, side: THREE.DoubleSide }));
  slots.set('cloth_blue', plain('cloth_blue', { color: 0x2a4a7a, roughness: 0.9, side: THREE.DoubleSide }));
  slots.set('crew', plain('crew', {color:0xffffff,vertexColors:true,roughness:.8,side:THREE.DoubleSide}));
  slots.set('skin', plain('skin', { color: 0xb07a5a, roughness: 0.6 }));
  slots.set('hair', plain('hair', { color: 0x2a1c14, roughness: 0.7 }));
  slots.set('leather', plain('leather', { color: 0x6a4a2a, roughness: 0.7 }));
  // lamp flames and windows: the game drives emissiveIntensity (night lighting)
  slots.set(
    'fire',
    plain('fire', {
      color: 0x3a2412,
      emissive: 0xffb060,
      emissiveIntensity: 0,
      roughness: 0.6,
      side: THREE.DoubleSide,
    }),
  );
  return slots;
}

/**
 * World-scale box projection (1 UV unit = 2 m, the scan scale) for meshes the exporter left without UVs
 * (crate, altar): a textured slot would otherwise sample one corner texel and render black.
 */
function boxUVs(g: THREE.BufferGeometry) {
  const p = g.attributes.position;
  const n = g.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)),
      ay = Math.abs(n.getY(i)),
      az = Math.abs(n.getZ(i));
    let u: number, v: number;
    if (ax >= ay && ax >= az) [u, v] = [p.getZ(i), p.getY(i)];
    else if (ay >= az) [u, v] = [p.getX(i), p.getZ(i)];
    else [u, v] = [p.getX(i), p.getY(i)];
    uv[i * 2] = u / 2;
    uv[i * 2 + 1] = v / 2;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

export async function loadModels(assets: VisualAssets): Promise<ModelKit> {
  const slots = makeSlots(assets);
  const loader = new GLTFLoader();
  const gltfs = await Promise.all(MODEL_FILES.map((f) => loader.loadAsync(ROOT + f)));

  const objects = new Map<string, THREE.Object3D>();
  const clipsByFile = new Map<string, THREE.AnimationClip[]>();
  const skinnedCache = new Map<THREE.Object3D, boolean>();
  gltfs.forEach((gltf, i) => {
    clipsByFile.set(MODEL_FILES[i], gltf.animations);
  });
  for (const gltf of gltfs) {
    gltf.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const src = o.material;
        const list = Array.isArray(src) ? src : [src];
        const mapped = list.map((m) => {
          const slot = slots.get(m.name);
          if (!slot) console.warn(`[models] ${o.name}: unknown material slot "${m.name}"`);
          return slot ?? slots.get('plaster')!;
        });
        o.material = Array.isArray(src) ? mapped : mapped[0];
        if (!o.geometry.attributes.uv && o.geometry.attributes.normal) boxUVs(o.geometry);
        o.castShadow = true;
        o.receiveShadow = true;
      }
      if (!o.name) return;
      // multi-slot objects load as a group of primitives sharing the object name: keep the parent
      if (objects.has(o.name)) return;
      objects.set(o.name, o);
    });
  }

  /** cached per source: does this subtree contain a SkinnedMesh (which needs SkeletonUtils to clone)? */
  const hasSkinned = (src: THREE.Object3D): boolean => {
    let v = skinnedCache.get(src);
    if (v === undefined) {
      v = false;
      src.traverse((c) => {
        if (c instanceof THREE.SkinnedMesh) v = true;
      });
      skinnedCache.set(src, v);
    }
    return v;
  };

  return {
    objects,
    get(name: string): THREE.Object3D {
      const src = objects.get(name);
      if (!src) {
        console.warn(`[models] missing model object "${name}"`);
        return new THREE.Group();
      }
      // a plain clone shares one skeleton across instances, so skinned subtrees need their own
      return hasSkinned(src) ? skeletonClone(src) : src.clone(true);
    },
    clips(file: string): THREE.AnimationClip[] {
      return clipsByFile.get(file) ?? [];
    },
    geometry(name: string): THREE.BufferGeometry[] {
      const src = objects.get(name);
      const out: THREE.BufferGeometry[] = [];
      src?.traverse((c) => {
        if (c instanceof THREE.Mesh) out.push(c.geometry);
      });
      return out;
    },
    parts(names: string | string[]) {
      const out: { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial }[] = [];
      for (const name of Array.isArray(names) ? names : [names]) {
        const src = objects.get(name);
        if (!src) {
          console.warn(`[models] missing model object "${name}"`);
          continue;
        }
        src.traverse((c) => {
          if (c instanceof THREE.Mesh) out.push({ geometry: c.geometry, material: c.material as THREE.MeshStandardMaterial });
        });
      }
      return out;
    },
    material(slot: string): THREE.MeshStandardMaterial {
      const m = slots.get(slot);
      if (!m) console.warn(`[models] unknown material slot "${slot}"`);
      return m as THREE.MeshStandardMaterial;
    },
  };
}
