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
}
