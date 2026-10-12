import * as THREE from 'three';
import { clamp } from '../../core/util';
import type { CrewRowingParams } from './params';

/** deterministic noise in [-1, 1]: the crew has no random source, so runs are reproducible */
export const hash = (i: number, k: number) => {
  const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return 2 * (s - Math.floor(s)) - 1;
};

export type HandState = 'rowing' | 'handover' | 'walking' | 'ready' | 'leaving' | 'waiting';

/** most waypoints a walk can carry: the two ends and one lane point per manned station */
export const WALK_WAYPOINTS = 10;

/**
 * A walk along a deck polyline (waypoints route around manned stances through the free lanes). The
 * time T is the straight-line timing of spec §6.2; the position follows the polyline over that time.
 */
export interface HandWalk {
  from: THREE.Vector3; to: THREE.Vector3; t: number; T: number; oar: number;
  /** waypoints (ship local x, z); wp[0] = from, wp[n - 1] = to */
  wp: { x: number; z: number }[];
  n: number;
  /** cumulative arc length at each waypoint (m) */
  cum: Float64Array;
  /** total path length (m) */
  len: number;
}

/**
 * One crew member: W'-balance critical-power model for the short term, an endurance reserve R for the
 * long term (spec §4), plus personal traits.
 */
export class Hand {
  readonly strength: number;
  readonly cpScale: number;
  readonly rateBias: number;
  /** reaction time to the stroke's first catch (s) */
  readonly reaction: number;
  /** relief group: 0 fore, 1 aft (a relief's own group; rowers belong to their station's group) */
  home = 0;
  Wbal: number;
  R = 1;
  oar = -1;
  state: HandState = 'waiting';
  walk: HandWalk | null = null;
  /** time on the current oar (s) */
  rowTime = 0;
  /** ship-local position while not at an oar */
  readonly pos = new THREE.Vector3();
  /** stroke-averaged mechanical power equivalent (W), tau 8 s */
  power = 0;
  work = 0;

  constructor(readonly id: number, p: CrewRowingParams) {
    this.strength = 1 + 0.08 * hash(id, 1);
    this.cpScale = 1 + 0.08 * hash(id, 2);
    this.rateBias = p.rateBias * hash(id, 3);
    this.reaction = 0.18 + 0.06 * (0.5 + 0.5 * hash(id, 4));
    this.Wbal = p.Wp;
  }

  /** strength available now: short-term W' balance and long-term reserve */
  S(p: CrewRowingParams) {
    const w = clamp(this.Wbal / p.Wp, 0, 1);
    return this.strength * (0.6 + 0.4 * Math.sqrt(w)) * (0.65 + 0.35 * this.R);
  }

  /** advance fatigue at stroke-averaged power P (W) */
  fatigue(p: CrewRowingParams, P: number, dt: number) {
    const CP = p.CP * this.cpScale * (0.75 + 0.25 * this.R);
    if (P > CP) this.Wbal -= (P - CP) * dt;
    else this.Wbal += ((CP - P) * (p.Wp - this.Wbal) / p.Wp) * dt;
    this.Wbal = clamp(this.Wbal, 0, p.Wp);
    const x = P / (p.CP * this.cpScale);
    this.R += (-(x > 0 ? Math.pow(x, 2.5) : 0) / p.tEnd + (P < 25 ? (1 - this.R) / p.tRecover : 0)) * dt;
    this.R = clamp(this.R, 0, 1);
  }

  /** feed the stroke-averaged power filter with this step's power equivalent and advance fatigue */
  load(p: CrewRowingParams, Peq: number, dt: number) {
    this.power += (Peq - this.power) * (1 - Math.exp(-dt / 8));
    this.fatigue(p, this.power, dt);
  }
}
