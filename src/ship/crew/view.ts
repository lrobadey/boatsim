/**
 * The crew system's output to the animator (docs/merchant-crew-spec.md §9.6). One entry per hand,
 * refreshed at the end of every physics step. Plain numbers only: the sim does not depend on three.js.
 */

export type CrewFigure = 'fig_rower_a' | 'fig_rower_b' | 'fig_rower_c';
export type CrewMode = 'row' | 'hold' | 'shipped' | 'walk' | 'stepIn' | 'stepOut' | 'idle' | 'rest';
export interface Vec2 { x: number; z: number }
export interface Vec3 { x: number; y: number; z: number }
export type CrewGaze =
  | { kind: 'member'; id: number }
  | { kind: 'helm' }
  | { kind: 'blade' }
  | { kind: 'point'; p: Vec3 }
  | null;

export interface CrewWalkView {
  /** ship-local position on deck */
  pos: Vec2;
  /** facing: forward is yaw 0, aft is pi (the body faces the direction of travel) */
  yaw: number;
  /** m/s along the path (0 when standing) */
  speed: number;
  /** where the walk ends, and the facing it ends with */
  target: { x: number; z: number; yaw: number };
}

export interface CrewMemberView {
  id: number;
  figure: CrewFigure;
  /** deterministic per-person seed in [0, 1) for the animator's style noise */
  seed: number;
  mode: CrewMode;
  /** station index (slot id) the hand is at or assigned to; -1 if none */
  oar: number;
  /**
   * who holds the station's stance when two men share its loom (spec §6.2): 'primary' is the man holding the
   * loom, the relief taking over (or the station's own man when alone); 'second' is the outgoing man still on
   * the loom in a handover, and also a man walking to or waiting at the station (he does not hold it)
   */
  role: 'primary' | 'second';
  /** grip target 0..1 */
  handsOn: number;
  /** grip radius of the inner hand (m): 0.97 normally, 0.85..0.97 for a relief during handover */
  gripInner: number;
  /** activation 0..1 */
  effort: number;
  /** blade loaded (in the drive) */
  driving: boolean;
  /** 0..1 since his own last catch; style only */
  strokePhase: number;
  /** 0 at catch .. 1 at finish; style only */
  progress: number;
  /** 1 - S, clamped to 0..1: slump, lower head, slower gaze */
  fatigue: number;
  gaze: CrewGaze;
  /** present while walking, stepping in or out */
  walk?: CrewWalkView;
}

export const CREW_FIGURES: readonly CrewFigure[] = ['fig_rower_a', 'fig_rower_b', 'fig_rower_c'];

/** figure by hand id, so the same man always has the same body */
export const figureFor = (id: number): CrewFigure => CREW_FIGURES[((id % 3) + 3) % 3];
/** golden-ratio sequence: deterministic, spread over [0, 1) */
export const seedFor = (id: number): number => ((id + 1) * 0.6180339887498949) % 1;

/**
 * Double-buffer storage for one frame of views. All objects are allocated once; the crew system
 * writes into them in place. The gaze and walk objects are owned here, so a frame never allocates.
 */
export class CrewViewBuffer {
  readonly members: CrewMemberView[] = [];
  private readonly memberGaze: { kind: 'member'; id: number }[] = [];
  private readonly pointGaze: { kind: 'point'; p: Vec3 }[] = [];
  private readonly walks: CrewWalkView[] = [];
  private readonly helm = Object.freeze({ kind: 'helm' as const });
  private readonly blade = Object.freeze({ kind: 'blade' as const });

  constructor(n: number) {
    for (let i = 0; i < n; i++) {
      this.members.push({
        id: i, figure: figureFor(i), seed: seedFor(i), mode: 'idle', oar: -1, role: 'primary', handsOn: 0, gripInner: 0.97,
        effort: 0, driving: false, strokePhase: 0, progress: 0, fatigue: 0, gaze: null,
      });
      this.memberGaze.push({ kind: 'member', id: i });
      this.pointGaze.push({ kind: 'point', p: { x: 0, y: 0, z: 0 } });
      this.walks.push({ pos: { x: 0, z: 0 }, yaw: 0, speed: 0, target: { x: 0, z: 0, yaw: 0 } });
    }
  }

  gazeMember(i: number, id: number) { const g = this.memberGaze[i]; g.id = id; this.members[i].gaze = g; }
  gazePoint(i: number, x: number, y: number, z: number) { const g = this.pointGaze[i]; g.p.x = x; g.p.y = y; g.p.z = z; this.members[i].gaze = g; }
  gazeHelm(i: number) { this.members[i].gaze = this.helm; }
  gazeBlade(i: number) { this.members[i].gaze = this.blade; }
  gazeNone(i: number) { this.members[i].gaze = null; }
  /** the walk record for hand i, to be filled in place and then made current with walkOn */
  walkRecord(i: number): CrewWalkView { return this.walks[i]; }
  walkOn(i: number) { this.members[i].walk = this.walks[i]; }
  walkOff(i: number) { this.members[i].walk = undefined; }
}
