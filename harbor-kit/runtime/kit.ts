import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

export type Vec3 = [number, number, number];
export interface Anchor { name: string; position: Vec3; normal?: Vec3; kind: string }
export type Collider =
  | { type: 'box'; name: string; center: Vec3; size: Vec3; walkableTop: boolean; surface: string }
  | { type: 'cylinder'; name: string; center: Vec3; radius: number; height: number; walkableTop: boolean; surface: string }
  | { type: 'mesh'; name: string; file: string; walkableTop: boolean; surface: string };
export interface Asset {
  id: string; family: string; description: string; tags: string[];
  source: { blend: string; collection: string; recipe: string };
  origin: string; front: Vec3; bounds: { min: Vec3; max: Vec3 }; footprint: [number, number];
  anchors: Anchor[]; collision: Collider[]; materials: string[]; triangles: number;
  lods: { level: number; file: string; distance: number; bytes?: number; sha256?: string }[];
}
export interface Manifest {
  schemaVersion: number; kit: string; version: string; units: 'metres'; up: Vec3;
  assets: Asset[]; materialPolicy: 'preserve-glTF-PBR';
}
export interface KitOptions {
  /** Inject the game's patchMaterial here. Called once per shared material. */
  patchMaterial?: (material: THREE.MeshStandardMaterial, name: string) => THREE.MeshStandardMaterial;
  anisotropy?: number;
}

/** A lazy, PBR-preserving asset library. No game state or global loaders change. */
export class HarborKit {
  readonly assets: ReadonlyMap<string, Asset>;
  private readonly loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private readonly pending = new Map<string, Promise<THREE.Group>>();
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly baked = new WeakMap<THREE.Mesh, THREE.BufferGeometry>();
  private readonly prepared = new WeakMap<THREE.Material, THREE.MeshStandardMaterial>();
  private disposed = false;

  private constructor(readonly manifest: Manifest, readonly baseURL: URL, private options: KitOptions) {
    this.assets = new Map(manifest.assets.map(a => [a.id, a]));
  }
  static async open(url: string | URL, options: KitOptions = {}): Promise<HarborKit> {
    const absolute = new URL(url, typeof location === 'undefined' ? 'http://localhost/' : location.href);
    const response = await fetch(absolute);
    if (!response.ok) throw new Error(`Kit manifest: HTTP ${response.status}`);
    const manifest = await response.json() as Manifest;
    if (manifest.schemaVersion !== 1 || manifest.units !== 'metres' || manifest.materialPolicy !== 'preserve-glTF-PBR') throw new Error('Unsupported kit contract');
    if (!Array.isArray(manifest.assets) || new Set(manifest.assets.map(a => a.id)).size !== manifest.assets.length) throw new Error('Invalid kit asset IDs');
    return new HarborKit(manifest, new URL('.', absolute), options);
  }
  asset(id: string): Asset {
    const asset = this.assets.get(id);
    if (!asset) throw new Error(`Unknown kit asset: ${id}`);
    return asset;
  }
  private load(file: string): Promise<THREE.Group> {
    if (this.disposed) throw new Error('Kit has been disposed');
    let job = this.pending.get(file);
    if (!job) {
      job = this.loader.loadAsync(new URL(file, this.baseURL).href).then(gltf => {
        gltf.scene.traverse(o => {
          if (!(o instanceof THREE.Mesh)) return;
          this.geometries.add(o.geometry); o.castShadow = true; o.receiveShadow = true;
          const prepare = (material: THREE.Material) => {
            const existing = this.prepared.get(material); if (existing) return existing;
            if (!(material instanceof THREE.MeshStandardMaterial)) throw new Error(`Unsupported material: ${material.name}`);
            for (const channel of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap'] as const) {
              const tex = material[channel]; if (!tex) continue;
              // Exported image names are stable and checked by pack.mjs. Channel
              // and transform stay in the key so data maps never become sRGB.
              const key = [tex.name, tex.colorSpace, tex.wrapS, tex.wrapT, tex.repeat.toArray(), tex.offset.toArray(), tex.rotation].join('|');
              const shared = this.textures.get(key);
              if (shared) { material[channel] = shared; if (tex !== shared) tex.dispose(); }
              else { tex.anisotropy = this.options.anisotropy ?? 4; this.textures.set(key, tex); }
            }
            const key = `${material.name}|${material.vertexColors}|${material.side}`;
            const shared = this.materials.get(key);
            if (shared) { if (material !== shared) material.dispose(); this.prepared.set(material, shared); return shared; }
            const final = this.options.patchMaterial?.(material, material.name) ?? material;
            this.materials.set(key, final); this.prepared.set(material, final); this.prepared.set(final, final); return final;
          };
          o.material = Array.isArray(o.material) ? o.material.map(prepare) : prepare(o.material);
        });
        return gltf.scene;
      }).catch(error => { this.pending.delete(file); throw error; });
      this.pending.set(file, job);
    }
    return job;
  }
  async create(id: string, level = 0): Promise<THREE.Group> {
    const asset = this.asset(id), lod = asset.lods.find(l => l.level === level);
    if (!lod) throw new Error(`${id} has no LOD ${level}`);
    const instance = (await this.load(lod.file)).clone(true);
    instance.name = id; instance.userData.kitAsset = id; instance.userData.kitLevel = level;
    return instance;
  }
  async createLOD(id: string): Promise<THREE.LOD> {
    const asset = this.asset(id), lod = new THREE.LOD(); lod.name = id; lod.userData.kitAsset = id;
    for (const level of asset.lods) lod.addLevel(await this.create(id, level.level), level.distance);
    return lod;
  }
  /** Geometry/material sharing for repeated trees, jars, paving or quay modules. */
  async batch(id: string, matrices: readonly THREE.Matrix4[], level = 0): Promise<THREE.Group> {
    const asset = this.asset(id), file = asset.lods.find(l => l.level === level)?.file;
    if (!file) throw new Error(`${id} has no LOD ${level}`);
    const source = await this.load(file); source.updateMatrixWorld(true);
    const group = new THREE.Group(); group.name = `${id}-batch`; group.userData.kitAsset = id;
    source.traverse(o => {
      if (!(o instanceof THREE.Mesh)) return;
      let geometry = this.baked.get(o);
      if (!geometry) { const created: THREE.BufferGeometry = o.geometry.clone().applyMatrix4(o.matrixWorld); this.baked.set(o, created); this.geometries.add(created); geometry = created; }
      const mesh = new THREE.InstancedMesh(geometry, o.material, matrices.length);
      matrices.forEach((m, i) => mesh.setMatrixAt(i, m)); mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = mesh.receiveShadow = true; mesh.computeBoundingBox(); mesh.computeBoundingSphere(); group.add(mesh);
    });
    return group;
  }
  async collisionMesh(id: string): Promise<THREE.Group | null> {
    const mesh = this.asset(id).collision.find(c => c.type === 'mesh');
    return mesh?.type === 'mesh' ? (await this.load(mesh.file)).clone(true) : null;
  }
  get stats() { return { loadedFiles: this.pending.size, sharedMaterials: this.materials.size, sharedTextures: this.textures.size, geometries: this.geometries.size }; }
  /** Remove instances from their scenes before disposing the owning kit. */
  async dispose(): Promise<void> {
    this.disposed = true; await Promise.allSettled(this.pending.values());
    this.geometries.forEach(g => g.dispose()); this.materials.forEach(m => m.dispose()); this.textures.forEach(t => t.dispose());
    this.pending.clear(); this.geometries.clear(); this.materials.clear(); this.textures.clear();
  }
}

export function anchorWorld(object: THREE.Object3D, asset: Asset, name: string): THREE.Vector3 {
  const anchor = asset.anchors.find(a => a.name === name);
  if (!anchor) throw new Error(`${asset.id} has no anchor ${name}`);
  object.updateWorldMatrix(true, false);
  return object.localToWorld(new THREE.Vector3(...anchor.position));
}

/** Centre a rigid local-Z span between parent-local endpoints, retaining Y-up.
 * The endpoints must already be one authored span length apart; no stretching.
 */
export function uprightSpanMatrix(start: THREE.Vector3, end: THREE.Vector3, length: number): THREE.Matrix4 {
  const forward=end.clone().sub(start);
  if(Math.abs(forward.length()-length)>1e-4 || length<=0)throw new Error('Rigid span length mismatch');
  forward.normalize();
  const right=new THREE.Vector3(0,1,0).cross(forward);
  if(right.lengthSq()<1e-8)throw new Error('Upright span cannot be vertical');
  right.normalize();const up=forward.clone().cross(right);
  return new THREE.Matrix4().makeBasis(right,up,forward).setPosition(start.clone().add(end).multiplyScalar(.5));
}

/** Snap opposing connectors. Leaves scale unchanged and respects parent frames. */
export function snapAnchor(moving: THREE.Object3D, asset: Asset, ownName: string,
                           target: THREE.Object3D, targetAsset: Asset, targetName: string): void {
  const own = asset.anchors.find(a => a.name === ownName), to = targetAsset.anchors.find(a => a.name === targetName);
  if (!own || !to) throw new Error('Missing snap anchor');
  target.updateWorldMatrix(true, false);
  const worldPosition = anchorWorld(target, targetAsset, targetName);
  if (own.normal && to.normal) {
    const desired = new THREE.Vector3(...to.normal).transformDirection(target.matrixWorld).negate();
    const worldRotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...own.normal), desired);
    if (moving.parent) worldRotation.premultiply(moving.parent.getWorldQuaternion(new THREE.Quaternion()).invert());
    moving.quaternion.copy(worldRotation);
  }
  const inParent = moving.parent ? moving.parent.worldToLocal(worldPosition.clone()) : worldPosition;
  const offset = new THREE.Vector3(...own.position).multiply(moving.scale).applyQuaternion(moving.quaternion);
  moving.position.copy(inParent).sub(offset); moving.updateWorldMatrix(true, true);
}
