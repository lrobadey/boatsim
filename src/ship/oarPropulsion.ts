import type * as THREE from 'three';
import type { OarSlot } from './oarLayout';
import type { BladeFrame, OarKinematics, RowBody, RowEventRing, RowSide } from './rowing';
import type { WaveField } from '../world/waves';

/** Programmatic rowing telemetry, shared by every propulsion system (see docs/rowing-spec.md §9). */
export interface RowTelemetry {
  portThrust: number; starboardThrust: number; oarThrust: number; yawMoment: number;
  wetArea: number; wetBlades: number; positivePower: number; dissipatedPower: number; crewLoad: number;
  forceCapFraction: number; powerCapFraction: number; missedDriveFraction: number;
  fallbackQueries: number; guardedQueries: number;
}

/**
 * What ShipPhysics, the oar visuals, oar water, foam and audio need from a ship's oars. Two systems
 * implement it: CrewRowing (the agent crew both ships row with: docs/merchant-crew-spec.md,
 * docs/trireme-crew-plan.md) and RowingSystem (the trireme's older scripted banks, kept selectable as 'banks').
 */
export interface OarPropulsion {
  readonly slots: readonly OarSlot[];
  readonly previous: BladeFrame;
  readonly current: BladeFrame;
  readonly events: RowEventRing;
  readonly telemetry: RowTelemetry;
  /** called exactly once per physics step, before rigid-body integration */
  step(dt: number, time: number, body: RowBody, helm: number, waves: WaveField, forceOut: THREE.Vector3, torqueOut: THREE.Vector3): void;
  reset(body: RowBody, time: number): void;
  /** after integration: world display centres follow the newly integrated hull */
  refreshWorld(body: RowBody): void;
  renderPose(index: number, alpha: number, out: OarKinematics): void;
  /** ship (or run out) one side's oars; systems whose ships stow oars visually ignore it */
  setShipped(side: RowSide, on: boolean): void;
}
