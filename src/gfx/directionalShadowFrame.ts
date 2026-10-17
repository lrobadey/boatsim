import * as THREE from 'three';

/** Share a current directional shadow map across the reflection, refraction and main draws.
 * The first scene draw supplies Three's normal renderer/clipping state. Only its shadow
 * traversal uses the complete caster mask; the color pass retains its own camera/layers.
 * No shadow resolution, light frustum, update cadence or simulation state is changed.
 */
export class DirectionalShadowFrame {
  private previousRender: THREE.WebGLRenderer['shadowMap']['render'] | null = null;
  private updated = false;
  private casterMask = 0;
  private readonly otherShadows: THREE.Light[] = [];

  constructor(
    private readonly renderer: Pick<THREE.WebGLRenderer, 'shadowMap'>,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly extraCasterLayers: number,
  ) {}

  // Three replaces this object when a lost WebGL context is restored.
  private get shadowMap() { return this.renderer.shadowMap; }

  /** Synchronous scope: hooks and state are restored even if a scene pass throws. */
  render<T>(scenePasses: () => T): T {
    if (this.previousRender) throw new Error('Directional shadow frames cannot be nested');
    const previous = this.shadowMap.render;
    this.previousRender = previous;
    this.updated = false;
    // Refraction temporarily changes this same camera's layers later in the scope.
    this.casterMask = this.camera.layers.mask | this.extraCasterLayers;
    this.shadowMap.render = this.renderShadows;
    try { return scenePasses(); }
    finally { this.shadowMap.render = previous; this.previousRender = null; }
  }

  private readonly renderShadows = (lights: THREE.Light[], scene: THREE.Scene, viewCamera: THREE.Camera) => {
    const draw = this.previousRender!;
    const map = this.shadowMap;
    if (scene !== this.scene || !map.enabled || !lights.some(light => light instanceof THREE.DirectionalLight)) {
      return draw.call(map, lights, scene, viewCamera);
    }
    if (this.updated) {
      // Other shadow types retain their existing per-pass policy.
      this.otherShadows.length = 0;
      for (const light of lights) if (!(light instanceof THREE.DirectionalLight)) this.otherShadows.push(light);
      if (this.otherShadows.length) draw.call(map, this.otherShadows, scene, viewCamera);
      return;
    }
    const mask = this.camera.layers.mask;
    const autoUpdate = map.autoUpdate;
    const needsUpdate = map.needsUpdate;
    this.camera.layers.mask = this.casterMask;
    // Reflection normally suppresses shadow updates. This first complete update must
    // happen before reflection samples the map, including the first frame after a cut.
    map.autoUpdate = true;
    try {
      scene.traverseVisible(object => {
        if (object instanceof THREE.LOD && object.autoUpdate) object.update(this.camera);
      });
      draw.call(map, lights, scene, this.camera);
      this.updated = true;
    } catch (error) {
      map.needsUpdate = needsUpdate;
      throw error;
    } finally {
      this.camera.layers.mask = mask;
      map.autoUpdate = autoUpdate;
    }
  };
}
