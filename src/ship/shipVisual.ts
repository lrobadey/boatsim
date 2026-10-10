import type * as THREE from 'three';
import type { ShipPhysics } from './physics';
import type { Crew } from './crew';

/** What the game, foam, oar-water and review scenes need from a ship's visual model. */
export interface ShipVisual {
  readonly group: THREE.Group;
  readonly lantern: THREE.PointLight;
  /** world-space blade frame as drawn, per oar slot: centre, loom axis (outboard), width axis, face normal */
  readonly bladeWorld: THREE.Vector3[];
  readonly bladeAxis: THREE.Vector3[];
  readonly bladeWidthAxis: THREE.Vector3[];
  readonly bladeNormal: THREE.Vector3[];
  readonly bladeIn: boolean[];
  readonly mastTop: THREE.Vector3;
  /** 0 run out .. 1 shipped, per side [port, starboard]; animated toward oarStowTarget */
  readonly oarStow: number[];
  readonly oarStowTarget: number[];
  /** read-back of the rendered rig for opt-in browser acceptance scenes */
  sailingVisualState(): {
    deployment: number;
    pressure: number;
    flutter: number;
    yardAngle: number;
    width: number;
    fullHeight: number;
    visible: boolean;
  };
  /** written by the oar-water system each frame */
  setOarWet(id: number, wetLine: number, soak: number, film: number): void;
  /** per-frame visual update from physics and crew state */
  update(physics: ShipPhysics, crew: Crew, night: number, time: number, alpha?: number): void;
}
