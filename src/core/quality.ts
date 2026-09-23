export type QualityName = 'low' | 'medium' | 'high' | 'ultra';

export interface Quality {
  name: QualityName;
  renderScale: number;
  minScale: number;
  maxScale: number;
  refractionScale: number;
  shadowMapSize: number;
  oceanGrid: number; // cells per clipmap level side
  fftSize: number; // FFT detail-wave resolution per cascade
  reflectionScale: number; // planar sea reflection resolution (0 = off)
  cloudScale: number; // volumetric cloud pass resolution vs the drawing buffer (0 = off)
  cloudSteps: number;
  heightmapSize: number;
  vegetationDensity: number;
  terrainChunkLods: number;
}

export const QUALITY: Record<QualityName, Quality> = {
  low: { name: 'low', cloudScale: 0, cloudSteps: 0, reflectionScale: 0, fftSize: 128, renderScale: 1.0, minScale: 0.7, maxScale: 1.25, refractionScale: 0.5, shadowMapSize: 1024, oceanGrid: 80, heightmapSize: 1024, vegetationDensity: 0.4, terrainChunkLods: 3 },
  medium: { name: 'medium', cloudScale: 0.25, cloudSteps: 40, reflectionScale: 0.35, fftSize: 128, renderScale: 1.25, minScale: 0.85, maxScale: 1.5, refractionScale: 0.5, shadowMapSize: 2048, oceanGrid: 112, heightmapSize: 2048, vegetationDensity: 0.7, terrainChunkLods: 4 },
  high: { name: 'high', cloudScale: 0.3, cloudSteps: 56, reflectionScale: 0.5, fftSize: 256, renderScale: 1.5, minScale: 1.0, maxScale: 2.0, refractionScale: 0.6, shadowMapSize: 4096, oceanGrid: 128, heightmapSize: 2048, vegetationDensity: 1.0, terrainChunkLods: 4 },
  ultra: { name: 'ultra', cloudScale: 0.38, cloudSteps: 72, reflectionScale: 0.6, fftSize: 256, renderScale: 2.0, minScale: 1.3, maxScale: 2.0, refractionScale: 1.0, shadowMapSize: 4096, oceanGrid: 160, heightmapSize: 2048, vegetationDensity: 1.4, terrainChunkLods: 4 },
};
