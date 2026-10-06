import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export interface SurfaceMaps {
  color: THREE.Texture;
  normal: THREE.Texture;
  roughness: THREE.Texture;
}

export interface VisualAssets {
  rockFace: THREE.Group;
  sand: SurfaceMaps;
  stone: SurfaceMaps;
  planks: SurfaceMaps;
}

const root = '/assets/polyhaven';

async function surface(name: string): Promise<SurfaceMaps> {
  const loader = new THREE.TextureLoader();
  const file = (suffix: string) => `${root}/${name}/${name}_${suffix}_1k.jpg`;
  const [color, normal, roughness] = await Promise.all([
    loader.loadAsync(file('diff')),
    loader.loadAsync(file('nor_gl')),
    loader.loadAsync(file('rough')),
  ]);
  color.colorSpace = THREE.SRGBColorSpace;
  for (const tex of [color, normal, roughness]) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
  }
  return { color, normal, roughness };
}

export async function loadVisualAssets(): Promise<VisualAssets> {
  const [rock, sand, stone, planks] = await Promise.all([
    new GLTFLoader().loadAsync(`${root}/rock_face_01/rock_face_01_2k.gltf`),
    surface('coast_sand_01'),
    surface('stone_wall'),
    surface('brown_planks_03'),
  ]);
  return { rockFace: rock.scene, sand, stone, planks };
}
