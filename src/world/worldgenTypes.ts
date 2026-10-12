import type { SeaStateBake } from './seaState';
import type { GoodId } from '../trade/goods';

export interface WorldGenRequest {
  seed: number;
  size: number; // heightmap resolution
  worldSize: number; // metres
  windFrom: number; // prevailing wind bearing (radians)
  vegetationDensity: number;
}

export interface IslandInfo {
  id: number;
  name: string;
  cx: number;
  cz: number;
  area: number;
  peak: number;
  peakX: number;
  peakZ: number;
}

export interface House {
  x: number;
  z: number;
  y: number;
  maxY: number;
  w: number;
  l: number;
  hgt: number;
  rot: number;
}

export interface Sites {
  harbour: { x: number; z: number; openAngle: number };
  shore: { x: number; z: number };
  temple: { x: number; z: number; y: number };
  houses: House[];
  /** mole from the shore (x,z) along angle; berth zone [berthStart, length] lies in dredged water */
  pier: { x: number; z: number; angle: number; length: number; width: number; top: number; berthStart: number };
  start: { x: number; z: number; heading: number };
  /** all harbours; [0] is the main harbour and mirrors harbour/shore/pier/houses above */
  harbours: HarbourSite[];
}

export interface PortProfile {
  /** village houses, the basis of population */
  houses: number;
  /** land area (m²) of the island: the 48 m grid's land cells × 48² */
  area: number;
  /** terrain feature areas per good (m², weighted), spec §4.3 */
  features: Record<GoodId, number>;
}

export interface HarbourSite {
  /** 0 = the main harbour; stable for a world */
  id: number;
  /** island index into WorldGenResult.islands */
  island: number;
  /** "Serrothos": the island's name */
  name: string;
  harbour: { x: number; z: number; openAngle: number };
  shore: { x: number; z: number };
  pier: Sites['pier'];
  houses: House[];
  /** sea-state detail region index (1-based into the bake's maps) */
  detail: number;
  profile: PortProfile;
}

export interface WorldGenResult {
  heights: Float32Array;
  size: number;
  worldSize: number;
  islands: IslandInfo[];
  sites: Sites;
  /** packed [x, y, z, scale, rot, type] ; type 0 cypress 1 olive 2 bush 3 rock 4 pine */
  vegetation: Float32Array;
  /** sky visibility (ambient occlusion) 0..255, aoSize^2 over the world */
  ao: Uint8Array;
  aoSize: number;
  /** sea state geometry (docs/sea-state-spec.md); absent = the same sea everywhere */
  seaState?: SeaStateBake;
}
