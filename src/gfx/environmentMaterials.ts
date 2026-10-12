import * as THREE from 'three';

/** Compile-time environment sampling modes shared by live scene materials. */
export const ENVIRONMENT_BLEND_DEFINE = 'SKY_ENV_BLEND';

export interface EnvironmentShaderVariantStats {
  registered: number;
  blending: number;
  settled: number;
  transitions: number;
}

const registered = new Set<THREE.Material>();
const disposeHandlers = new WeakMap<THREE.Material, () => void>();
let blending = false;
let transitions = 0;

function definesOf(material: THREE.Material): Record<string, unknown> {
  const m = material as THREE.Material & { defines?: Record<string, unknown> };
  if (!m.defines) m.defines = {};
  return m.defines;
}

function applyVariant(material: THREE.Material, enabled: boolean, invalidate: boolean) {
  const defines = definesOf(material);
  const value = enabled ? 1 : 0;
  if (defines[ENVIRONMENT_BLEND_DEFINE] === value) return false;
  defines[ENVIRONMENT_BLEND_DEFINE] = value;
  if (invalidate) material.needsUpdate = true;
  return true;
}

/** Register a live material that has compile-time SKY_ENV_BLEND branches.
 * Returns an idempotent unregister function; material.dispose also unregisters it. */
export function registerEnvironmentMaterial<T extends THREE.Material>(material: T): () => void {
  if (registered.has(material)) return () => unregisterEnvironmentMaterial(material);
  applyVariant(material, blending, false);
  const onDispose = () => unregisterEnvironmentMaterial(material);
  disposeHandlers.set(material, onDispose);
  material.addEventListener('dispose', onDispose);
  registered.add(material);
  return () => unregisterEnvironmentMaterial(material);
}

/** Remove a live material from future variant flips. */
export function unregisterEnvironmentMaterial(material: THREE.Material): void {
  const onDispose = disposeHandlers.get(material);
  if (onDispose) material.removeEventListener('dispose', onDispose);
  disposeHandlers.delete(material);
  registered.delete(material);
}

/** Change variants only at blend boundaries, never on each fade frame. */
export function setEnvironmentShaderBlend(enabled: boolean): EnvironmentShaderVariantStats {
  enabled = Boolean(enabled);
  if (enabled !== blending) {
    blending = enabled;
    transitions++;
    for (const material of registered) applyVariant(material, blending, true);
  }
  return getEnvironmentShaderVariantStats();
}

export function getEnvironmentShaderVariantStats(): EnvironmentShaderVariantStats {
  return {
    registered: registered.size,
    blending: blending ? registered.size : 0,
    settled: blending ? 0 : registered.size,
    transitions,
  };
}
