export type QualityName = 'low' | 'medium' | 'high' | 'ultra';

export interface Quality {
  name: QualityName;
  renderScale: number;
  minScale: number;
  maxScale: number;
  refractionScale: number;
  shadowMapSize: number;
  oceanGrid: number; // cells per clipmap level side
  heightmapSize: number;
  vegetationDensity: number;
  terrainChunkLods: number;
}

export const QUALITY: Record<QualityName, Quality> = {
  low: { name: 'low', renderScale: 1.0, minScale: 0.7, maxScale: 1.25, refractionScale: 0.5, shadowMapSize: 1024, oceanGrid: 80, heightmapSize: 1024, vegetationDensity: 0.4, terrainChunkLods: 3 },
  medium: { name: 'medium', renderScale: 1.25, minScale: 0.85, maxScale: 1.5, refractionScale: 0.5, shadowMapSize: 2048, oceanGrid: 112, heightmapSize: 2048, vegetationDensity: 0.7, terrainChunkLods: 4 },
  high: { name: 'high', renderScale: 1.5, minScale: 1.0, maxScale: 2.0, refractionScale: 0.6, shadowMapSize: 4096, oceanGrid: 128, heightmapSize: 2048, vegetationDensity: 1.0, terrainChunkLods: 4 },
  ultra: { name: 'ultra', renderScale: 2.0, minScale: 1.25, maxScale: 2.0, refractionScale: 1.0, shadowMapSize: 4096, oceanGrid: 160, heightmapSize: 2048, vegetationDensity: 1.4, terrainChunkLods: 4 },
};
