// The merchant crew's animator: one skinned rower per hand (docs/merchant-crew-spec.md §9.4–9.6).
// Each render frame, per figure: the clip layer (walk / idle / rest) is written by an AnimationMixer, then
// RowerRig solves the procedural layer from the oar's grip positions at render alpha. Everything is
// ship-local: the figures are children of the ship's model group, so the rig's inputs are direct.
// Allocation-free in update(): all vectors and inputs are preallocated per figure.
import * as THREE from 'three';
import type { ModelKit } from '../gfx/models';
import { RowerRig, type RowerRigInput, type RowerBlend, type RowerStance } from './rowerRig';
import type { CrewRowing } from '../ship/crew/crewRowing';
import type { CrewGaze, CrewMemberView, CrewWalkView } from '../ship/crew/view';
import type { ShipDesign } from '../ship/design';
import { createKinematics, type OarKinematics } from '../ship/rowing';
import { SECOND_STEP } from '../ship/crew/stance';
import { stanceFor, STANCE_SPLIT_FWD, STANCE_SPLIT_BACK, STANCE_WIDTH } from './stance';

type ClipKey = 'walk' | 'idle_stand' | 'rest_sit';

const CROSSFADE = 0.3; // s, clip changes
const BODY_S = 0.3; // s, the body blends to the clip, or back to procedural, over this (rig-fixes-2 sec. 1)
// hands ramp on (once the body is fully procedural) and off (once the rig's reach gate lets go) as a critically damped
// follower: C1 at both ends, so the weight has no velocity kink. A linear 0.4 s ramp kinked at shipping onset and
// popped the forearm 12.9 deg (docs/merchant-crew/rig-fixes-2.md sec. 1). Snapped when within 1e-3 of its target.
const HANDS_OM = 5; // 1/s (5 keeps the shipping window under 10 deg at every station; 6 left station 5 at 10.7)
const WALK_CYCLE_M = 1.3; // [est] m covered per walk clip cycle (1.04 s); tune against the clip
const HELM_EYE = 1.4; // m above the deck: the helmsman's eye line
const DT_MAX = 0.1; // s, clamp after a long frame

/**
 * GLTFLoader renames duplicate node names (pelvis_1, pelvis_2 ...) because the three figures in crew.glb
 * share bone names. The first figure keeps the plain names. Each figure's clone has its suffixes stripped
 * so RowerRig's exact-name lookup works.
 */
const NAME_SUFFIX = /_\d+$/;
function stripNodeSuffixes(root: THREE.Object3D): void {
  root.traverse((o) => { o.name = o.name.replace(NAME_SUFFIX, ''); });
}

/**
 * crew.glb's clips are CUBICSPLINE, and quaternion keys flip sign between neighbours: the spline passes near
 * zero and the whole body turns 180 deg for a frame (idle_stand at 3.875 s). Until rowers.py writes sign-continuous
 * linear keys (docs/merchant-crew/rig-fixes-2.md sec. 6), resample each track to its key values, linear, with each
 * quaternion key flipped into the hemisphere of the one before. Same as scripts/test-rowers.mjs sanitizeTrack.
 */
function sanitizeTrack(t: THREE.KeyframeTrack): THREE.KeyframeTrack {
  const isQuat = t instanceof THREE.QuaternionKeyframeTrack;
  if (!isQuat && !(t instanceof THREE.VectorKeyframeTrack)) return t;
  const n = t.times.length, size = isQuat ? 4 : 3;
  const cubic = t.values.length / n === 3 * size, off = cubic ? size : 0;   // cubic keys store [in, value, out]
  const v = new Float32Array(n * size);
  for (let i = 0; i < n; i++) for (let j = 0; j < size; j++) v[i * size + j] = t.values[i * size * (cubic ? 3 : 1) + off + j];
  if (isQuat) for (let i = 1; i < n; i++) {
    let d = 0; for (let j = 0; j < 4; j++) d += v[i * 4 + j] * v[(i - 1) * 4 + j];
    if (d < 0) for (let j = 0; j < 4; j++) v[i * 4 + j] = -v[i * 4 + j];
  }
  const times = Float32Array.from(t.times);
  return isQuat ? new THREE.QuaternionKeyframeTrack(t.name, times, v) : new THREE.VectorKeyframeTrack(t.name, times, v);
}

/**
 * The clip with every track sanitised and its node name stripped of any GLTFLoader suffix, to match the clone's
 * bone names. crew.glb holds one figure's tracks per clip with plain bone names, so every figure shares it.
 * Built once at load.
 */
function figureClip(clip: THREE.AnimationClip): THREE.AnimationClip {
  const tracks = clip.tracks.map((t) => {
    const s = sanitizeTrack(t);
    const [node, ...rest] = s.name.split('.');
    s.name = [node.replace(NAME_SUFFIX, ''), ...rest].join('.');
    return s;
  });
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/** x moved toward target by at most up (rising) or down (falling) */
const approach = (x: number, target: number, up: number, down: number) => x + Math.min(up, Math.max(-down, target - x));

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const wrapAngle = (a: number) => {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
};

interface Figure {
  root: THREE.Object3D;
  head: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Record<ClipKey, THREE.AnimationAction>;
  key: ClipKey;
  rig: RowerRig;
  input: RowerRigInput;
  blend: RowerBlend;
  gripEnd: THREE.Vector3;
  gripInner: THREE.Vector3;
  loomAxis: THREE.Vector3;
  stanceCenter: THREE.Vector3;
  stanceFacing: THREE.Vector3;
  deckUp: THREE.Vector3;
  gazeVec: THREE.Vector3;
  /** procedural body blend, 0 = clip, 1 = rig (ramps 0.3 s; see updateFigure) */
  body: number;
  /** hands on the loom, 0..1 (critically damped, HANDS_OM; only once body is 1) */
  hands: number;
  /** rate of change of hands, 1/s */
  handsV: number;
  /** metres walked, drives the walk clip's time */
  walkDist: number;
  /** false until the figure has a position (relief spot, station or walk) */
  placed: boolean;
  /** last valid grip radius for the inner hand, kept while the hands are off the loom */
  feather: number;
}

export class CrewAnimator {
  private readonly figs: Figure[] = [];
  private readonly kin: OarKinematics = createKinematics();
  private readonly tq = new THREE.Quaternion();
  private readonly shipUp = new THREE.Vector3(0, 1, 0);
  /** per station: the rowing stance (stanceFor), ship-local; the primary stands on it */
  private readonly stationStance: RowerStance[] = [];
  private readonly stationSide: number[] = [];
  private readonly helmPt = new THREE.Vector3();
  private readonly bladeHalf: number;
  // deck height against ship-local z: a table sorted by z, built once
  private readonly tabZ: number[] = [];
  private readonly tabY: number[] = [];
  private heave = 0;
  private vyPrev = 0;
  private primed = false;

  constructor(
    models: ModelKit,
    private readonly parent: THREE.Object3D,
    private readonly crew: CrewRowing,
    private readonly design: ShipDesign,
  ) {
    const p = crew.p;
    const hull = design.hull;
    const deck = design.deck;
    this.bladeHalf = p.bladeLength * 0.5;

    // deck height vs z (zOf is monotone in s, so sort by z once)
    const samples: { z: number; y: number }[] = [];
    for (let k = 0; k <= 200; k++) {
      const s = k / 200;
      samples.push({ z: hull.zOf(s), y: deck.deckY(s) });
    }
    samples.sort((a, b) => a.z - b.z);
    for (const q of samples) { this.tabZ.push(q.z); this.tabY.push(q.y); }

    // station stance (stance.ts, the same numbers the sim's payload uses)
    crew.slots.forEach((slot, k) => {
      this.stationStance.push(stanceFor(k, design, { center: new THREE.Vector3(), facing: new THREE.Vector3(), deckUp: new THREE.Vector3() }));
      this.stationSide.push(slot.side);
    });

    const hs = design.camera.helmS;
    this.helmPt.set(0, deck.deckY(hs) + HELM_EYE, hull.zOf(hs));

    const views = crew.crewView;
    const walkClips = models.clips('crew.glb');
    const clipNamed = (name: ClipKey) => {
      const c = walkClips.find((x) => x.name === name);
      if (!c) throw new Error(`crewAnimator: crew.glb has no clip "${name}"`);
      return c;
    };
    // shared by every figure: crew.glb's clips carry one figure's tracks with plain bone names
    const clips = {
      walk: figureClip(clipNamed('walk')),
      idle_stand: figureClip(clipNamed('idle_stand')),
      rest_sit: figureClip(clipNamed('rest_sit')),
    };

    for (let i = 0; i < views.length; i++) {
      const v = views[i];
      const root = models.get(v.figure);
      stripNodeSuffixes(root);
      root.frustumCulled = false;
      root.traverse((o) => { if (o instanceof THREE.Mesh) o.frustumCulled = false; });
      parent.add(root);
      const mixer = new THREE.AnimationMixer(root);
      const actions = {
        walk: mixer.clipAction(clips.walk),
        idle_stand: mixer.clipAction(clips.idle_stand),
        rest_sit: mixer.clipAction(clips.rest_sit),
      };
      actions.idle_stand.play();
      const head = root.getObjectByName('head') ?? root;
      const rig = new RowerRig(root, v.seed * 1000 + i);
      const blend: RowerBlend = { body: 1, armL: 1, armR: 1, legs: 1, head: 1 };
      const input: RowerRigInput = {
        gripEnd: new THREE.Vector3(), gripInner: new THREE.Vector3(), loomAxis: new THREE.Vector3(0, 0, 1),
        feather: 0, handsOn: 0,
        stance: {
          center: new THREE.Vector3(), facing: new THREE.Vector3(0, 0, 1), deckUp: new THREE.Vector3(0, 1, 0),
          splitFwd: STANCE_SPLIT_FWD, splitBack: STANCE_SPLIT_BACK, width: STANCE_WIDTH,
        },
        shipUp: this.shipUp, heaveAcc: 0, effort: 0, driving: false, fatigue: 0, gazeTarget: null, blend,
      };
      this.figs.push({
        root, head, mixer, actions, key: 'idle_stand', rig, input, blend,
        gripEnd: input.gripEnd, gripInner: input.gripInner, loomAxis: input.loomAxis,
        stanceCenter: input.stance.center, stanceFacing: input.stance.facing, deckUp: input.stance.deckUp,
        gazeVec: new THREE.Vector3(), body: 0, hands: 0, handsV: 0, walkDist: 0, placed: false, feather: 0,
      });
    }
  }

  /**
   * One render frame. dt: real frame seconds. alpha: render interpolation between the last two physics
   * steps. ship.vel: the ship's world velocity (heave acceleration). Call after the ship group's transform
   * is set for this frame.
   */
  update(dt: number, alpha: number, ship: { vel: THREE.Vector3 }): void {
    const h = Math.min(Math.max(dt, 0), DT_MAX);
    const a = clamp01(alpha);
    const parent = this.parent;
    parent.updateWorldMatrix(true, false);

    // world up in ship-local, from the interpolated render quaternion (not the physics pose)
    this.tq.copy(parent.quaternion).invert();
    this.shipUp.set(0, 1, 0).applyQuaternion(this.tq);

    if (h > 0) {
      const acc = THREE.MathUtils.clamp((ship.vel.y - this.vyPrev) / h, -20, 20);
      if (this.primed) this.heave += (acc - this.heave) * (1 - Math.exp(-h * 8));
    }
    this.vyPrev = ship.vel.y;
    this.primed = true;

    const cur = this.crew.crewView;
    const prev = this.crew.crewViewPrev;
    for (let i = 0; i < this.figs.length; i++) this.updateFigure(i, cur[i], prev[i], h, a);
  }

  private updateFigure(i: number, cur: CrewMemberView, prev: CrewMemberView, h: number, a: number): void {
    const f = this.figs[i];
    const mode = cur.mode;
    const stepping = mode === 'walk' || mode === 'stepIn' || mode === 'stepOut';

    // role (view.ts): 'primary' holds the loom, the relief once he takes over; 'second' is the outgoing man
    // still on it. The primary stands on the stance; the second steps SECOND_STEP inboard of it.
    const second = cur.role === 'second';
    // at a station (the root stands on the stance, and the body is drawn at it while the body blend is below 1)
    const atStation = cur.oar >= 0 && !(stepping && cur.walk);

    // ---- placement: ship-local root position and yaw
    if (stepping && cur.walk) {
      this.placeWalk(f, cur.walk, prev.walk, a, h);
    } else if (cur.oar >= 0) {
      f.root.position.copy(this.stationStance[cur.oar].center);
      if (second) f.root.position.x -= this.stationSide[cur.oar] * SECOND_STEP;
      f.root.rotation.y = Math.PI; // rowers face aft
      f.placed = true;
    } else if (!f.placed) {
      const spot = this.crew.p.reliefSpots[i % this.crew.p.reliefSpots.length];
      const s = spot[1];
      f.root.position.set(spot[0], this.design.deck.deckY(s), this.design.hull.zOf(s));
      f.root.rotation.y = 0;
      f.placed = true;
    }
    const yaw = f.root.rotation.y;
    f.stanceCenter.copy(f.root.position);
    f.stanceFacing.set(-Math.sin(yaw), 0, -Math.cos(yaw));

    // ---- clip layer: the clip the body blends to (walk, idle or rest)
    const clip: ClipKey = stepping ? 'walk' : mode === 'rest' ? 'rest_sit' : 'idle_stand';
    this.setClip(f, clip);
    if (clip === 'walk') {
      const walk = f.actions.walk;
      const dur = walk.getClip().duration;
      const t = (f.walkDist / WALK_CYCLE_M) * dur;
      walk.time = ((t % dur) + dur) % dur; // advanced by distance, so the feet do not skate
    }
    // ---- procedural layer (spec 9.5, rig-fixes-2 sec. 1). The body leaves the clip only while the rowing rig is
    // needed, and returns to the clip only once the rig reports the hands fully off (metrics.handsEffective, after
    // its reach gate). Hands ramp on only once the body is fully procedural: the IK never follows a half-blended trunk.
    const handsWant = lerp(prev.handsOn, cur.handsOn, a);
    const procNeeded = mode === 'row' || mode === 'hold' || handsWant > 0 || f.hands > 0
      || f.rig.metrics.handsEffective > 0;
    f.body = approach(f.body, procNeeded ? 1 : 0, h / BODY_S, h / BODY_S);
    const handsT = f.body >= 1 ? handsWant : 0;
    f.handsV += (HANDS_OM * HANDS_OM * (handsT - f.hands) - 2 * HANDS_OM * f.handsV) * h;
    f.hands = clamp01(f.hands + f.handsV * h);
    if (Math.abs(handsT - f.hands) < 1e-3) { f.hands = handsT; f.handsV = 0; }
    const b = f.blend;
    b.body = f.body;
    b.armL = 1; b.armR = 1;                      // the rig's hands gate the arms (wArm = blend * handsOn)
    b.legs = atStation ? 1 : 0;                  // the feet are procedural at a station, the clip's walk otherwise
    b.head = 0.7 + 0.3 * f.body;                 // look-at weight 0.7 on the clip (spec 9.5)
    f.input.handsOn = f.hands;

    // order per figure: rig.beginFrame -> mixer -> rig.update
    f.rig.beginFrame();
    f.mixer.update(h);

    // ---- grips from the oar's render pose at alpha
    if (cur.oar >= 0) {
      this.crew.renderPose(cur.oar, a, this.kin);
      const k = this.kin;
      const gi = lerp(prev.gripInner, cur.gripInner, a);
      // the loom runs inboard from the pin: grip radii are measured along -axis
      f.gripEnd.copy(k.pivot).addScaledVector(k.axis, -this.crew.p.gripOuter);
      f.gripInner.copy(k.pivot).addScaledVector(k.axis, -gi);
      f.loomAxis.copy(k.axis);
      f.feather = this.featherOf(k, this.crew.slots[cur.oar].side);
    }
    f.input.feather = f.feather;
    f.input.effort = lerp(prev.effort, cur.effort, a);
    f.input.fatigue = lerp(prev.fatigue, cur.fatigue, a);
    f.input.driving = cur.driving;
    f.input.heaveAcc = this.heave;

    // ---- gaze
    f.input.gazeTarget = this.gazeFor(i, cur.gaze, a, f.gazeVec);

    f.rig.update(h, f.input);
  }

  private placeWalk(f: Figure, w: CrewWalkView, pw: CrewWalkView | undefined, a: number, h: number): void {
    const p0 = pw ?? w;
    const x = lerp(p0.pos.x, w.pos.x, a);
    const z = lerp(p0.pos.z, w.pos.z, a);
    const yaw = p0.yaw + wrapAngle(w.yaw - p0.yaw) * a;
    f.root.position.set(x, this.deckAt(z), z);
    f.root.rotation.y = yaw;
    f.walkDist += w.speed * h;
    f.placed = true;
  }

  /** deck height at ship-local z, linear over the sorted table */
  private deckAt(z: number): number {
    const zs = this.tabZ, ys = this.tabY, n = zs.length;
    if (z <= zs[0]) return ys[0];
    if (z >= zs[n - 1]) return ys[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (zs[mid] <= z) lo = mid; else hi = mid;
    }
    const t = (z - zs[lo]) / Math.max(1e-9, zs[hi] - zs[lo]);
    return lerp(ys[lo], ys[hi], t);
  }

  private setClip(f: Figure, key: ClipKey): void {
    if (f.key === key) return;
    const next = f.actions[key];
    const prev = f.actions[f.key];
    next.reset();
    next.timeScale = key === 'walk' ? 0 : 1; // walk time is set by distance, not by the clock
    next.fadeIn(CROSSFADE).play();
    prev.fadeOut(CROSSFADE);
    f.key = key;
  }

  /**
   * Roll of the blade about the loom, recovered exactly from the oar's frame (the inverse of evaluateOar's
   * basis): axis = (s cd ca, -sd, -cd sa); widthAxis = b cf + n sf.
   */
  private featherOf(k: OarKinematics, side: number): number {
    const ax = k.axis;
    const cd = Math.max(1e-6, Math.hypot(ax.x, ax.z));
    const sd = -ax.y;
    const ca = (side * ax.x) / cd;
    const sa = -ax.z / cd;
    // b = (s sd ca, cd, -sd sa); n = (sa, 0, s ca)
    const bx = side * sd * ca, by = cd, bz = -sd * sa;
    const nx = sa, nz = side * ca;
    const wx = k.widthAxis.x, wy = k.widthAxis.y, wz = k.widthAxis.z;
    const cf = wx * bx + wy * by + wz * bz;
    const sf = wx * nx + wz * nz;
    return Math.atan2(sf, cf);
  }

  private gazeFor(i: number, g: CrewGaze, a: number, out: THREE.Vector3): THREE.Vector3 | null {
    if (!g) return null;
    switch (g.kind) {
      case 'member': {
        const o = this.figs[g.id];
        if (!o || g.id === i) return null;
        o.head.updateWorldMatrix(true, false);
        o.head.getWorldPosition(out);
        this.parent.worldToLocal(out);
        return out;
      }
      case 'helm':
        return out.copy(this.helmPt);
      case 'blade': {
        const oar = this.crew.crewView[i].oar;
        if (oar < 0) return null;
        this.crew.renderPose(oar, a, this.kin);
        // the outboard tip of the blade
        return out.copy(this.kin.center).addScaledVector(this.kin.axis, this.bladeHalf);
      }
      case 'point':
        return out.set(g.p.x, g.p.y, g.p.z);
      default:
        return null;
    }
  }
}
