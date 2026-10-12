import * as THREE from 'three';
import { patchMaterial } from './shared';

export interface LightingFixtureRig {
  setVisible(visible: boolean): void;
  /** Place the fixtures five metres ahead and 1.5 metres below the current camera pose. */
  align(camera: THREE.PerspectiveCamera): void;
  /** Current world pose for optional review telemetry. */
  getWorldPose(): { position: readonly [number, number, number]; quaternion: readonly [number, number, number, number] };
  /** World-space centres and material metadata for the opt-in HDR readback. */
  getSamplePoints(): readonly { name: string; label: string; position: readonly [number, number, number]; radius: number; roughness: number }[];
  dispose(): void;
}

/**
 * Opt-in neutral-material fixtures for the development lighting review. This rig is not imported
 * by the normal game entry and remains a fixed scene object that is explicitly repositioned.
 */
export function createLightingFixtures(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): LightingFixtureRig {
  const root = new THREE.Group();
  root.name = 'lighting-fixture-rig';
  root.visible = false;

  const geometry = new THREE.SphereGeometry(0.22, 24, 16);
  const meshes: THREE.Mesh[] = [];
  const fixtures = [
    { name: 'neutral-gray', color: 0x808080, roughness: 0.82, label: 'Gray reference' },
    { name: 'neutral-white', color: 0xf2f2f2, roughness: 0.82, label: 'White reference' },
    { name: 'roughness-015', color: 0xb7b7b7, roughness: 0.15, label: 'Roughness 0.15' },
    { name: 'roughness-035', color: 0xb7b7b7, roughness: 0.35, label: 'Roughness 0.35' },
    { name: 'roughness-055', color: 0xb7b7b7, roughness: 0.55, label: 'Roughness 0.55' },
    { name: 'roughness-075', color: 0xb7b7b7, roughness: 0.75, label: 'Roughness 0.75' },
    { name: 'roughness-095', color: 0xb7b7b7, roughness: 0.95, label: 'Roughness 0.95' },
  ];
  const spacing = 0.63;
  for (let i = 0; i < fixtures.length; i++) {
    const spec = fixtures[i];
    const material = patchMaterial(new THREE.MeshStandardMaterial({
      color: spec.color,
      roughness: spec.roughness,
      metalness: 0,
    }), undefined, `lighting-fixture-${spec.name}`);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `lighting-fixture-${spec.name}`;
    mesh.position.set((i - (fixtures.length - 1) / 2) * spacing, 0, 0);
    mesh.userData.lightingFixture = { name: spec.name, label: spec.label, roughness: spec.roughness };
    root.add(mesh);
    meshes.push(mesh);
  }
  scene.add(root);

  const worldPosition = new THREE.Vector3();
  const worldQuaternion = new THREE.Quaternion();
  const forward = new THREE.Vector3(0, 0, -1);
  const up = new THREE.Vector3(0, 1, 0);
  const align = (viewCamera: THREE.PerspectiveCamera) => {
    viewCamera.updateWorldMatrix(true, false);
    viewCamera.getWorldPosition(worldPosition);
    viewCamera.getWorldQuaternion(worldQuaternion);
    root.position.copy(worldPosition)
      .addScaledVector(forward.clone().applyQuaternion(worldQuaternion), 5)
      .addScaledVector(up.clone().applyQuaternion(worldQuaternion), -1.5);
    root.quaternion.copy(worldQuaternion);
    root.updateMatrixWorld(true);
  };
  align(camera);

  return {
    setVisible(visible) {
      root.visible = visible;
    },
    align,
    getWorldPose() {
      root.getWorldPosition(worldPosition);
      root.getWorldQuaternion(worldQuaternion);
      return {
        position: Object.freeze([worldPosition.x, worldPosition.y, worldPosition.z]) as readonly [number, number, number],
        quaternion: Object.freeze([worldQuaternion.x, worldQuaternion.y, worldQuaternion.z, worldQuaternion.w]) as readonly [number, number, number, number],
      };
    },
    getSamplePoints() {
      root.updateWorldMatrix(true, true);
      return meshes.map((mesh) => {
        mesh.getWorldPosition(worldPosition);
        const meta = mesh.userData.lightingFixture as { name: string; label: string; roughness: number };
        return {
          name:meta.name, label:meta.label,
          position:Object.freeze([worldPosition.x, worldPosition.y, worldPosition.z]) as readonly [number, number, number],
          radius:0.22, roughness:meta.roughness,
        };
      });
    },
    dispose() {
      scene.remove(root);
      root.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
        else object.material.dispose();
      });
      geometry.dispose();
    },
  };
}
