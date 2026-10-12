import * as THREE from 'three';
import { LAYER_NOREFLECT } from '../core/pipeline';

/**
 * Planar reflection of the world in the sea (islands, the hull, oars, sail, village lights).
 *
 * The scene is rendered once more from the camera mirrored about the mean sea level (y = 0), at
 * reduced resolution, with the sky hidden and alpha cleared to 0 — so the ocean shader blends it
 * over its own sky-cube reflection exactly where there is geometry. Geometry below the waterline is
 * clipped with a renderer clipping plane (the reversed-Z projection rules out the oblique-frustum
 * trick). The target is mip-mapped so the ocean can blur the reflection by its sub-pixel slope
 * variance, just like the sky reflection.
 */
export class PlanarReflection {
  readonly target: THREE.WebGLRenderTarget;
  readonly textureMatrix = new THREE.Matrix4();
  readonly camera = new THREE.PerspectiveCamera();
  enabled = true;
  private clip = [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.15)];
  private tmp = new THREE.Vector3();
  private rot = new THREE.Matrix4();
  private look = new THREE.Vector3();
  private scale: number;

  constructor(scale = 0.5) {
    this.scale = scale;
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      depthBuffer: true,
    });
  }

  setSize(w: number, h: number) {
    this.target.setSize(Math.max(1, Math.floor(w * this.scale)), Math.max(1, Math.floor(h * this.scale)));
  }

  /** Precompile the reflection's HDR, clipped scene variant before the first render. */
  async compileEnvironmentVariant(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    cam: THREE.PerspectiveCamera,
  ): Promise<void> {
    if (!this.enabled) return;
    const cameraLayerMask = this.camera.layers.mask;
    const renderTarget = renderer.getRenderTarget();
    const activeCubeFace = renderer.getActiveCubeFace();
    const activeMipmapLevel = renderer.getActiveMipmapLevel();
    const clippingPlanes = renderer.clippingPlanes;
    try {
      this.camera.layers.mask = cam.layers.mask & ~(1 << LAYER_NOREFLECT);
      renderer.clippingPlanes = this.clip;
      renderer.setRenderTarget(this.target);
      await renderer.compileAsync(scene, this.camera);
    } finally {
      this.camera.layers.mask = cameraLayerMask;
      renderer.clippingPlanes = clippingPlanes;
      renderer.setRenderTarget(renderTarget, activeCubeFace, activeMipmapLevel);
    }
  }

  /** hide: objects that must not appear in the reflection (the sea itself, the sky dome, stars) */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, cam: THREE.PerspectiveCamera, hide: THREE.Object3D[]) {
    if (!this.enabled) return;
    const c = this.camera;
    const cp = this.tmp.setFromMatrixPosition(cam.matrixWorld);
    // mirror position, view direction and up vector about y = 0
    c.position.set(cp.x, -cp.y, cp.z);
    this.rot.extractRotation(cam.matrixWorld);
    const f = this.look.set(0, 0, -1).applyMatrix4(this.rot);
    const up = new THREE.Vector3(0, 1, 0).applyMatrix4(this.rot);
    c.up.set(up.x, -up.y, up.z);
    c.lookAt(cp.x + f.x, -cp.y - f.y, cp.z + f.z);
    c.near = cam.near;
    c.far = cam.far;
    c.layers.mask = cam.layers.mask & ~(1 << LAYER_NOREFLECT);
    c.updateMatrixWorld();
    c.projectionMatrix.copy(cam.projectionMatrix);
    c.projectionMatrixInverse.copy(cam.projectionMatrixInverse);
    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(c.projectionMatrix).multiply(c.matrixWorldInverse);

    const vis = hide.map((o) => o.visible);
    for (const o of hide) o.visible = false;
    const prevTarget = renderer.getRenderTarget();
    const prevClip = renderer.clippingPlanes;
    const prevShadow = renderer.shadowMap.autoUpdate;
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevBg = scene.background;
    scene.background = null;
    renderer.shadowMap.autoUpdate = false;
    renderer.clippingPlanes = this.clip;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(scene, c);
    renderer.setRenderTarget(prevTarget);
    renderer.clippingPlanes = prevClip;
    renderer.shadowMap.autoUpdate = prevShadow;
    renderer.setClearColor(prevClear, prevAlpha);
    scene.background = prevBg;
    hide.forEach((o, i) => (o.visible = vis[i]));
  }
}
