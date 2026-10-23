import type { WorldGenResult } from './worldgenTypes';

/** Same cell-centred bilinear height query as Terrain, without constructing any render assets. */
export function seabedAt(gen: WorldGenResult, x: number, z: number): number {
  const cell = gen.worldSize / gen.size;
  const fx = (x + gen.worldSize / 2) / cell - 0.5;
  const fz = (z + gen.worldSize / 2) / cell - 0.5;
  if (fx < 0 || fz < 0 || fx >= gen.size - 1 || fz >= gen.size - 1) return -60;
  const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
  const k = j * gen.size + i, h = gen.heights;
  return (h[k] * (1 - tx) + h[k + 1] * tx) * (1 - tz)
    + (h[k + gen.size] * (1 - tx) + h[k + gen.size + 1] * tx) * tz;
}

/** Deep water in a 350 m radius plus a 1 km, 150 m wide departure corridor. */
export function findOpenWaterStart(gen: WorldGenResult, heading: number): WorldGenResult['sites']['start'] {
  const margin = 1450, bound = gen.worldSize / 2 - margin;
  const harbours = [gen.sites.harbour, ...(gen.sites.harbours ?? []).map(h => h.harbour)];
  const deep = (x: number, z: number) => seabedAt(gen, x, z) <= -20;
  const clear = (x: number, z: number) => {
    if (Math.abs(x) > bound || Math.abs(z) > bound) return false;
    if (harbours.some(h => Math.hypot(x - h.x, z - h.z) < 1200)) return false;
    if (!deep(x, z)) return false;
    for (let dx = -350; dx <= 350; dx += 25) for (let dz = -350; dz <= 350; dz += 25) {
      if (dx * dx + dz * dz <= 350 ** 2 && !deep(x + dx, z + dz)) return false;
    }
    for (let d = 350; d <= 1000; d += 25) for (let side = -75; side <= 75; side += 25) {
      if (!deep(x + Math.sin(heading) * d + Math.cos(heading) * side,
        z - Math.cos(heading) * d + Math.sin(heading) * side)) return false;
    }
    return true;
  };
  const start = gen.sites.start;
  for (let radius = 0; radius <= gen.worldSize; radius += 250) {
    const count = radius === 0 ? 1 : Math.max(24, Math.ceil(2 * Math.PI * radius / 250));
    for (let i = 0; i < count; i++) {
      const angle = heading + i * Math.PI * 2 / count;
      const x = start.x + Math.sin(angle) * radius, z = start.z - Math.cos(angle) * radius;
      if (clear(x, z)) return { x, z, heading };
    }
  }
  throw new Error('No sufficiently deep, clear offshore start was found for this archipelago. Try another seed.');
}
