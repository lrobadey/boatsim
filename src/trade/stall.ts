// The trade stall's interaction (cargo-trade-spec §8). One Interactable per harbour: a 'Talk' prompt at the
// trader's figure, enabled on a merchant design and only while the player is on foot on the quay. Pure
// apart from the Interactable's THREE position; no Game import (the lead passes getters).

import * as THREE from 'three';
import type { Interactable } from '../player/interact';

/** The stall's interaction point for one harbour, from the World lane (HarbourLayout.stall). */
export interface StallPoint {
  port: number;
  x: number;
  y: number;
  z: number;
}

export interface StallOptions {
  /** one entry per harbour; a stall is created for each */
  stalls: readonly StallPoint[];
  /** true when the ship's design has cargo (the merchant) */
  hasCargo: () => boolean;
  /** true when the player is on foot in the world frame (walker.frame === 'world') */
  onFootWorld: () => boolean;
  /** called with the port id when the player presses E at the stall; the lead opens the ledger */
  open: (port: number) => void;
}

/** The prompt sits this far above the stall point (the figure's chest, §8). */
export const STALL_CHEST_HEIGHT = 1.4;
/** Reach of the prompt (m), from the eye. */
export const STALL_RADIUS = 3.5;

/** One 'Talk' interactable per stall point (the ledger is reached from the conversation). Their ids are 'trade-{port}'. */
export function createStallInteractions(opts: StallOptions): Interactable[] {
  return opts.stalls.map((s) => ({
    id: `trade-${s.port}`,
    label: 'Talk',
    frame: 'world' as const,
    pos: new THREE.Vector3(s.x, s.y + STALL_CHEST_HEIGHT, s.z),
    radius: STALL_RADIUS,
    enabled: () => opts.hasCargo() && opts.onFootWorld(),
    act: () => opts.open(s.port),
  }));
}
