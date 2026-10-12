import * as THREE from 'three';
import { clamp, smoothstep } from '../../core/util';
import { ORDERS, type Crew } from '../crew';
import type { ShipDesign } from '../design';
import type { OarSlot } from '../oarLayout';
import type { OarPropulsion, RowTelemetry } from '../oarPropulsion';
import { BladeFrame, createKinematics, evaluateOar, RowEventRing, type JointPose, type OarKinematics, type RowBody, type RowSide } from '../rowing';
import { createFlowSample, type WaveField } from '../../world/waves';
import { Allocator } from './allocation';
import { createIntent, intentFromOrder, type CrewIntent } from './intent';
import { Oar } from './oar';
import { crewSlots, type CrewRowingParams } from './params';
import { Hand, type HandWalk } from './physiology';
import { Rotation, sampleWalk, walkArc, walkLength, type WalkSample } from './rotation';
import { SECOND_STEP, stanceXZ } from './stance';
import { CrewViewBuffer, type CrewMemberView } from './view';
import { StrokeControl, type CrewContext } from './stroke';
import { SweepDynamics } from './sweepDynamics';
import { WaterReader } from './water';

export interface CrewTelemetry extends RowTelemetry {
  /** power delivered to the hull by the blades (W) */
  hullPower: number;
}

export interface CatchRecord { t: number; oar: number; hand: number; lead: boolean }

export interface PayloadEntry { mass: number; local: THREE.Vector3 }

const CATCH_LOG_MAX = 1200;
/** the crew's mean reserve at which ramming speed drops to Full, and at which they count as recovered */
const RAM_SPENT = 0.35;
const RAM_RESTORED = 0.5;
/** the first and last second of a walk are a step (turn in, or step out) (s) */
const STEP_S = 1.0;
/** a walker looks this far ahead along his path (m) */
const GAZE_LOOKAHEAD = 3.0;
/** eye height above the deck for a point gaze (m) */
const HEAD_HEIGHT = 1.6;

const wrap01 = (x: number) => x - Math.floor(x);
/** an oar that is working the water: not holding, resting, shipped, or handing over to a hold or rest */
const isRowing = (o: Oar) => o.mode !== 'hold' && o.mode !== 'rest' && o.mode !== 'shipped' && !(o.mode === 'transfer' && o.next !== 'ready');
/** facing yaw for a direction on the deck: forward (-z) is yaw 0, aft is pi */
const headingYaw = (dx: number, dz: number) => Math.atan2(-dx, -dz);
const TAU = 2 * Math.PI;
/** wrap an angle into [-pi, pi] */
const wrapPi = (a: number) => a - TAU * Math.round(a / TAU);
/** the view's facing turns at most this fast (rad/s): visual only, never read by the physics or walk timing */
const YAW_RATE = 3;

/**
 * The agent crew (docs/merchant-crew-spec.md): every oar a physical force balance driven by an
 * individual rower who plans his strokes, keeps time with what he sees and hears, and tires; a crew
 * intent and allocation turn orders and helm into who pulls, eases or backs; reliefs rotate in.
 * The merchant's six standing sweeps and the trireme's 170 seated oars (docs/trireme-crew-plan.md).
 */
export class CrewRowing implements OarPropulsion, CrewContext {
  readonly p: CrewRowingParams;
  readonly slots: readonly OarSlot[];
  readonly previous: BladeFrame;
  readonly current: BladeFrame;
  readonly events = new RowEventRing();
  readonly telemetry: CrewTelemetry = { portThrust: 0, starboardThrust: 0, oarThrust: 0, yawMoment: 0, wetArea: 0, wetBlades: 0,
    positivePower: 0, dissipatedPower: 0, crewLoad: 0, forceCapFraction: 0, powerCapFraction: 0, missedDriveFraction: 0,
    fallbackQueries: 0, guardedQueries: 0, hullPower: 0 };
  readonly oars: Oar[];
  readonly hands: Hand[];
  readonly intent: CrewIntent = createIntent();
  readonly rotation: Rotation;
  readonly catchLog: CatchRecord[] = [];
  time = 0;
  speedNow = 0;
  body: RowBody | null = null;
  waves: WaveField | null = null;
  readonly water: WaterReader;
  private stroke: StrokeControl;
  private allocator: Allocator;
  private dynamics: SweepDynamics;
  private allocClock = 0;
  private rotClock = 0;
  private flow = createFlowSample();
  private kin = createKinematics();
  private joint: JointPose = { sweep: 0, dip: 0, feather: 0, dSweep: 0, dDip: 0, dFeather: 0 };
  private fwd = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private handLoad: PayloadEntry[] = [];
  private helmLoad: PayloadEntry | null = null;
  private driveSamples = 0;
  private missedSamples = 0;
  private initialized = false;
  // animator view (spec §9.6): two buffers, the current one written at the end of each step
  private viewCur!: CrewViewBuffer;
  private viewPrev!: CrewViewBuffer;
  /** per hand: the station it is tied to (-1 none) and its role (0 none, 1 the station's hand, 2 the man handing over) */
  private handOar!: Int32Array;
  private handRole!: Int8Array;
  /** per hand: when he became ready (s), NaN while not ready */
  private readyT!: Float64Array;
  /** per hand: the slewed view facing (rad) and whether it has been set since the last teleport */
  private yawView!: Float64Array;
  private yawSet!: Uint8Array;
  /** the step length the view slews over (s); 0 while filling at a teleport */
  private viewDt = 0;
  /** per station: the station aft whose rower it watches (same side first), -1 none */
  private watch!: Int32Array;
  private walkNow: WalkSample = { x: 0, z: 0, dx: 0, dz: 0 };
  private walkAhead: WalkSample = { x: 0, z: 0, dx: 0, dz: 0 };
  private walkEnd: WalkSample = { x: 0, z: 0, dx: 0, dz: 0 };
  /** per station: the rowing stance's lateral x and fore-aft z (stance.ts), ship-local */
  private readonly stanceX: Float64Array;
  private readonly stanceZ: Float64Array;

  constructor(readonly crew: Crew, readonly design: ShipDesign, payload: PayloadEntry[] | null) {
    const p = design.oars.crew;
    if (!p) throw new Error(`${design.name}: oars.system 'crew' needs oars.crew parameters`);
    this.p = p;
    this.slots = Object.freeze(crewSlots(design.hull, p).map((s) => Object.freeze(s)));
    const n = this.slots.length;
    this.stanceX = new Float64Array(n);
    this.stanceZ = new Float64Array(n);
    const sxz = { x: 0, z: 0 };
    for (let k = 0; k < p.stations.length; k++) { stanceXZ(k, design.hull, p, sxz); this.stanceX[k] = sxz.x; this.stanceZ[k] = sxz.z; }
    this.oars = this.slots.map((s) => new Oar(s, p));
    this.hands = Array.from({ length: Math.max(n, p.hands) }, (_, i) => new Hand(i, p));
    for (let i = 0; i < n; i++) { const h = this.hands[i]; h.oar = i; h.state = 'rowing'; h.home = this.oars[i].group; this.oars[i].hand = h; }
    this.rotation = new Rotation(p, design.hull);
    this.rotation.placeReliefs(this.hands, n);
    this.stroke = new StrokeControl(this);
    this.allocator = new Allocator(n);
    this.dynamics = new SweepDynamics(p);
    this.water = new WaterReader(p);
    this.previous = new BladeFrame(n);
    this.current = new BladeFrame(n);
    for (const o of this.oars) o.snapRest(p);
    // a layout's rowers sit in the hull, their weight already in her displacement: only stances carry payload
    if (p.payload && p.layout) throw new Error(`${design.name}: crew payload needs stations, not a layout`);
    if (payload && p.payload) {
      this.handLoad = this.hands.map(() => { const e = { mass: p.massHand, local: new THREE.Vector3() }; payload.push(e); return e; });
      // the helmsman (the player) stands at the helm
      const s = design.camera.helmS;
      this.helmLoad = { mass: p.massHand, local: new THREE.Vector3(0, design.deck.deckY(s) + 1.0, design.hull.zOf(s)) };
      payload.push(this.helmLoad);
      this.updatePayload();
    }
    for (const o of this.oars) this.writeFrame(o);
    this.previous.copy(this.current);
    this.handOar = new Int32Array(this.hands.length);
    this.handRole = new Int8Array(this.hands.length);
    this.readyT = new Float64Array(this.hands.length).fill(NaN);
    this.yawView = new Float64Array(this.hands.length);
    this.yawSet = new Uint8Array(this.hands.length);
    this.watch = new Int32Array(this.oars.length);
    this.viewCur = new CrewViewBuffer(this.hands.length);
    this.viewPrev = new CrewViewBuffer(this.hands.length);
    if (p.animated) { this.fillView(this.viewCur); this.fillView(this.viewPrev); }
  }

  /** the crew for the animator this step: one entry per hand (spec §9.6); allocation-free */
  get crewView(): readonly CrewMemberView[] { return this.viewCur.members; }
  /** the same crew one physics step earlier; the animator blends from it at render alpha */
  get crewViewPrev(): readonly CrewMemberView[] { return this.viewPrev.members; }

  // ---------------------------------------------------------------- CrewContext
  /**
   * how long a relief has been at oar o before he takes it over (s; a negative value: he is still walking in).
   * A relief within 1.5 s of arriving holds that oar's catch back (-seconds to arrive); once ready he has been on
   * the loom for this long. Infinity with no relief coming to o. Rotation takes an oar at its first catch, so
   * this keeps the stroke from catching under a man whose hands are not yet on (spec §6.2). Only the relieved
   * oar waits; the rest of the crew keeps the beat.
   */
  reliefAge(o: Oar): number {
    let a = Infinity;
    for (let i = 0; i < this.hands.length; i++) {
      const h = this.hands[i];
      if (!h.walk || this.oars[h.walk.oar] !== o) continue;
      if (h.state === 'walking' && h.walk && h.walk.t < 1.5) a = Math.min(a, -h.walk.t);
      // (a ready hand with no time yet has just arrived: age 0)
      else if (h.state === 'ready') a = Math.min(a, Number.isFinite(this.readyT[i]) ? this.time - this.readyT[i] : 0);
    }
    return a;
  }
  /** the stroke: the aftmost manned oar actively rowing (holding to check her, resting or shipped is not rowing) */
  leader(): Oar | null {
    let best: Oar | null = null;
    for (const o of this.oars) if (o.hand && o.hand.state === 'rowing' && !o.shipped && Math.abs(o.alloc) > 0.12 && isRowing(o) && (!best || o.slot.z > best.slot.z)) best = o;
    return best;
  }
  onCatch(o: Oar, lead: boolean) {
    if (lead) this.events.push('catchBeat', this.time, -1, o.slot.side, 0, 0, 0, o.plan.u);
    if (this.catchLog.length >= CATCH_LOG_MAX) this.catchLog.splice(0, CATCH_LOG_MAX / 2);
    this.catchLog.push({ t: this.time, oar: o.slot.id, hand: o.hand ? o.hand.id : -1, lead });
  }

  // ---------------------------------------------------------------- OarPropulsion
  setShipped(side: RowSide, on: boolean) { for (const o of this.oars) if (o.slot.side === side) o.shipped = on; }

  reset(body: RowBody, time: number) {
    // a teleport resets poses and event history, never physiology or who is at which oar
    this.time = time;
    for (const o of this.oars) o.snapRest(this.p);
    this.current.contact.fill(0); this.current.wetArea.fill(0); this.current.forceWorld.fill(0);
    this.current.positivePower.fill(0); this.current.handleForce.fill(0);
    this.events.clear();
    this.initialized = false;
    for (const o of this.oars) this.writeFrame(o);
    this.refreshWorld(body);
    this.previous.copy(this.current);
    // a teleport is not a motion: both view buffers show the reset crew, facing snapped to the new pose
    this.yawSet.fill(0);
    this.viewDt = 0;
    if (this.p.animated) { this.fillView(this.viewCur); this.fillView(this.viewPrev); }
  }

  step(dt: number, time: number, body: RowBody, helm: number, waves: WaveField, forceOut: THREE.Vector3, torqueOut: THREE.Vector3) {
    if (!(dt > 0) || !Number.isFinite(dt)) throw new Error('Invalid rowing dt');
    const p = this.p;
    this.time = time;
    this.body = body;
    this.waves = waves;
    this.previous.copy(this.current);
    // speed through the water along her heading, as the crew feels it
    waves.sampleFlowAt(body.pos.x, body.pos.y, body.pos.z, time, this.flow);
    const fwd = this.fwd.set(0, 0, -1).applyQuaternion(body.quat);
    this.speedNow = (body.vel.x - this.flow.vx) * fwd.x + (body.vel.y - this.flow.vy) * fwd.y + (body.vel.z - this.flow.vz) * fwd.z;
    // decision clocks advance by exact sums of dt (deterministic)
    this.allocClock -= dt;
    this.rotClock -= dt;
    if (this.allocClock <= 0) {
      this.allocClock += 0.1;
      intentFromOrder(this.intent, p.orders[clamp(this.crew.orderIndex, 0, p.orders.length - 1)], this.crew.holdWater, helm, this.speedNow);
      if (p.allocation) this.allocator.allocate(this.oars, this.intent, p);
      else for (const o of this.oars) { o.alloc = this.intent.dir; o.bias = 0; }
      if (p.waterRead) for (const o of this.oars) this.water.watchChop(o, body, waves, time, 0.1);
    }
    if (this.rotClock <= 0) {
      this.rotClock += 1;
      if (p.rotation && this.hands.length > this.oars.length) this.rotation.decide(time, this.oars, this.hands, this.intent);
    }
    this.rotation.update(dt, time, this.oars, this.hands);

    const tele = this.telemetry;
    tele.portThrust = tele.starboardThrust = tele.oarThrust = tele.yawMoment = tele.wetArea = tele.wetBlades = 0;
    tele.positivePower = tele.dissipatedPower = tele.hullPower = 0;
    let crewPower = 0, rowingHands = 0;
    for (const o of this.oars) {
      this.stroke.decide(o, dt);
      const h = o.hand, S = h ? h.S(p) : 0, manned = (h ? 1 : 0) + (o.second ? 1 : 0);
      const r = this.dynamics.step(o, S, manned, dt, time, body, waves, forceOut, torqueOut);
      const thrust = r.force.dot(fwd);
      tele.oarThrust += thrust;
      if (o.slot.side < 0) tele.portThrust += thrust; else tele.starboardThrust += thrust;
      tele.yawMoment += r.yaw;
      tele.wetArea += r.area;
      if (r.area > 0) tele.wetBlades++;
      const positive = Math.max(0, r.Pr) + r.PdipPos;
      tele.positivePower += positive;
      tele.dissipatedPower += r.Pdiss;
      tele.hullPower += r.Phull;
      o.cycleWork += positive * dt;
      // missed water: the same threshold the planner uses (wet < 0.3, stroke.ts)
      if (o.mode === 'drive' && o.modeT > 0.12) { this.driveSamples++; if (o.wet < 0.3) this.missedSamples++; }
      // physiology: mechanical power, a quarter of negative work, and an isometric holding cost
      if (h) {
        const Peq = positive + 0.25 * Math.max(0, -r.Pr) + 0.04 * o.Fh * (o.mode === 'hold' ? 1 : 0.3);
        h.load(p, Peq, dt);
        h.work += Math.max(0, r.Pr) * dt;
        h.rowTime += dt;
        crewPower += h.power; rowingHands++;
      }
      this.writeFrame(o, r.center, r.force, r.area, positive);
      // blade contact events (hysteresis and cooldown as in the trireme spec)
      const was = o.contact, contact = was ? o.wet >= 0.02 : o.wet > 0.08;
      if (!this.initialized) { o.contact = contact; this.current.contact[o.slot.id] = contact ? 1 : 0; }
      else if (contact !== was && time - o.lastContactT >= 0.06) {
        this.events.push(contact ? 'enterWater' : 'leaveWater', time, o.slot.id, o.slot.side, r.center.x, r.center.y, r.center.z, Math.min(1, Math.sqrt(r.Pdiss / 250)));
        o.contact = contact; o.lastContactT = time;
        this.current.contact[o.slot.id] = contact ? 1 : 0;
      }
    }
    this.initialized = true;
    tele.crewLoad = rowingHands ? crewPower / rowingHands : 0;
    tele.missedDriveFraction = this.driveSamples ? this.missedSamples / this.driveSamples : 0;
    if (this.driveSamples > 6000) { this.driveSamples /= 2; this.missedSamples /= 2; }
    this.updateFacade(dt);
    this.updatePayload();
    if (!p.animated) return;
    // the finished step becomes the previous view; the older buffer is refilled as the new one
    const b = this.viewPrev;
    this.viewPrev = this.viewCur;
    this.viewCur = b;
    this.viewDt = dt;
    this.fillView(b);
  }

  refreshWorld(body: RowBody) {
    const c = this.current;
    for (const slot of this.slots) {
      const o = slot.id * 3;
      this.tmp.fromArray(c.centerLocal, o).sub(body.cg).applyQuaternion(body.quat).add(body.pos);
      c.centerWorld[o] = this.tmp.x; c.centerWorld[o + 1] = this.tmp.y; c.centerWorld[o + 2] = this.tmp.z;
    }
  }

  renderPose(index: number, alpha: number, out: OarKinematics) {
    const a = clamp(alpha, 0, 1), P = this.previous.joint, C = this.current.joint, j = index * 6, J = this.joint;
    J.sweep = P[j] + (C[j] - P[j]) * a; J.dip = P[j + 1] + (C[j + 1] - P[j + 1]) * a; J.feather = P[j + 2] + (C[j + 2] - P[j + 2]) * a;
    J.dSweep = P[j + 3] + (C[j + 3] - P[j + 3]) * a; J.dDip = P[j + 4] + (C[j + 4] - P[j + 4]) * a; J.dFeather = P[j + 5] + (C[j + 5] - P[j + 5]) * a;
    evaluateOar(this.slots[index], J, out);
  }

  // ---------------------------------------------------------------- animator view
  /**
   * Fills one view buffer from the hands and oars (spec §9.5, §9.6). Modes: a rowing hand is
   * row / hold / shipped / idle (on a rest oar); the man on the loom during a handover is row; a
   * relief walking to a station is walk, then stepIn once he is near; the ready relief waits in
   * stepIn; a man leaving is stepOut for his first second, then walk; a waiting relief is rest.
   * Gaze: the stroke watches the helm; the others watch the next man aft on their side (any side
   * if none); a rower at the catch glances at the blade; walkers watch a point ahead on their path.
   */
  private fillView(buf: CrewViewBuffer) {
    const p = this.p, t = this.time, oars = this.oars, L = this.leader();
    const hull = this.design.hull, deck = this.design.deck;
    this.handOar.fill(-1);
    this.handRole.fill(0);
    for (const o of oars) {
      if (o.hand) { this.handOar[o.hand.id] = o.slot.id; this.handRole[o.hand.id] = 1; }
      if (o.second) { this.handOar[o.second.id] = o.slot.id; this.handRole[o.second.id] = 2; }
    }
    for (let i = 0; i < oars.length; i++) {
      const oi = oars[i];
      let best = -1, bestKey = Infinity;
      for (let j = 0; j < oars.length; j++) {
        const oj = oars[j];
        if (j === i || !oj.hand || oj.hand.state !== 'rowing' || oj.shipped || oj.slot.z <= oi.slot.z) continue;
        const key = (oj.slot.side === oi.slot.side ? 0 : 1000) + oj.slot.z;
        if (key < bestKey) { bestKey = key; best = j; }
      }
      this.watch[i] = best;
    }
    for (let i = 0; i < this.hands.length; i++) {
      const h = this.hands[i], role = this.handRole[i], oi = this.handOar[i], o = oi >= 0 ? oars[oi] : null;
      const v = buf.members[i];
      if (h.state !== 'ready') this.readyT[i] = NaN;
      v.fatigue = clamp(1 - h.S(p), 0, 1);
      v.role = role === 1 ? 'primary' : 'second';
      v.mode = 'rest'; v.oar = -1; v.handsOn = 0; v.gripInner = p.gripInner; v.effort = 0; v.driving = false;
      v.strokePhase = 0; v.progress = 0;
      buf.walkOff(i);
      if ((h.state === 'rowing' || h.state === 'handover') && o) {
        v.oar = o.slot.id;
        v.mode = o.shipped || o.mode === 'shipped' ? 'shipped' : o.mode === 'hold' ? 'hold' : o.mode === 'rest' ? 'idle' : 'row';
        v.handsOn = v.mode === 'row' || v.mode === 'hold' ? 1 : 0;
        v.effort = clamp(o.u, 0, 1);
        v.driving = o.mode === 'drive';
        const progress = this.strokeProgress(o, t);
        v.progress = progress;
        v.strokePhase = Number.isFinite(o.lastCatch) && o.period > 0 ? wrap01((t - o.lastCatch) / o.period) : 0;
        // the relief's hands sit inboard on the loom through the drive; the man handing over keeps his grip
        v.gripInner = role === 1 && o.second ? 0.85 + 0.12 * progress : p.gripInner;
        if (o.mode === 'catch' || (o.mode === 'drive' && o.modeT < 0.2)) buf.gazeBlade(i);
        else if (o === L) buf.gazeHelm(i);
        else {
          const w = this.watch[oi];
          if (w >= 0 && oars[w].hand) buf.gazeMember(i, oars[w].hand!.id);
          else buf.gazeHelm(i);
        }
        continue;
      }
      if (h.state === 'ready' && h.walk) {
        // at the station's side, turned aft, waiting for the outgoing man's catch. His hands go on the
        // loom STEP_S after he is ready, so they are in place before he takes the stroke (spec §6.2)
        if (!Number.isFinite(this.readyT[i])) this.readyT[i] = t;
        const onLoom = t - this.readyT[i] >= STEP_S;
        v.mode = 'stepIn'; v.oar = h.walk.oar;
        v.handsOn = onLoom ? 1 : 0; v.gripInner = onLoom ? 0.85 : p.gripInner;
        const cur = h.walk.oar >= 0 ? oars[h.walk.oar].hand : null;
        if (cur && cur !== h) buf.gazeMember(i, cur.id); else buf.gazeHelm(i);
        this.fillWalk(buf, i, h.walk, true, true);
        continue;
      }
      if ((h.state === 'walking' || h.state === 'leaving') && h.walk) {
        const w = h.walk, remaining = w.t, elapsed = w.T - w.t;
        const stepping = h.state === 'walking' ? remaining < STEP_S : elapsed < STEP_S;
        v.mode = h.state === 'walking' ? (stepping ? 'stepIn' : 'walk') : (stepping ? 'stepOut' : 'walk');
        v.oar = h.state === 'walking' ? w.oar : -1;
        const arc = walkArc(w);
        sampleWalk(w, Math.min(walkLength(w), arc + GAZE_LOOKAHEAD), this.walkAhead);
        const s = clamp(hull.sOf(this.walkAhead.z), 0, 1);
        buf.gazePoint(i, this.walkAhead.x, deck.deckY(s) + HEAD_HEIGHT, this.walkAhead.z);
        // walking: faces his heading, ends turned aft at the station; leaving: faces his heading throughout
        this.fillWalk(buf, i, w, false, h.state === 'walking');
        continue;
      }
      // waiting relief: at his spot, resting
      buf.gazeNone(i);
    }
  }

  /** the walk record of a hand: where he is, which way he faces and where his path ends */
  private fillWalk(buf: CrewViewBuffer, i: number, w: HandWalk, turnAft: boolean, arriveAft: boolean) {
    const rec = buf.walkRecord(i), now = this.walkNow, end = this.walkEnd;
    sampleWalk(w, walkArc(w), now);
    sampleWalk(w, walkLength(w), end);
    rec.pos.x = now.x; rec.pos.z = now.z;
    rec.yaw = this.slewYaw(i, turnAft ? Math.PI : headingYaw(now.dx, now.dz));
    rec.speed = w.T > 0 && w.t > 0 ? walkLength(w) / w.T : 0;
    rec.target.x = end.x; rec.target.z = end.z;
    rec.target.yaw = arriveAft ? Math.PI : headingYaw(end.dx, end.dz);
    buf.walkOn(i);
  }

  /** the view facing of hand i, turned toward the wanted facing at most YAW_RATE rad/s (style only) */
  private slewYaw(i: number, want: number): number {
    if (!this.yawSet[i]) { this.yawSet[i] = 1; this.yawView[i] = want; return want; }
    const d = wrapPi(want - this.yawView[i]), lim = YAW_RATE * this.viewDt;
    this.yawView[i] = wrapPi(this.yawView[i] + (d > lim ? lim : d < -lim ? -lim : d));
    return this.yawView[i];
  }

  /** 0 at catch .. 1 at finish in the drive; 1 .. 0 through the recovery (style only) */
  private strokeProgress(o: Oar, t: number): number {
    switch (o.mode) {
      case 'catch': case 'drive': case 'extract': {
        const span = o.plan.thetaF - o.plan.thetaC;
        return span !== 0 ? clamp((o.theta - o.plan.thetaC) / span, 0, 1) : 0;
      }
      case 'recover': {
        if (!Number.isFinite(o.lastCatch)) return 0;
        const finish = o.lastCatch + o.lastDrive, len = Math.max(0.2, o.period - o.lastDrive);
        return clamp(1 - (t - finish) / len, 0, 1);
      }
      default: return 0;
    }
  }

  // ---------------------------------------------------------------- internals
  private writeFrame(o: Oar, centerWorld?: THREE.Vector3, force?: THREE.Vector3, area = 0, positivePower = 0) {
    const c = this.current, i = o.slot.id, j = i * 6, k = i * 3;
    c.joint[j] = o.theta; c.joint[j + 1] = o.dip.o[0]; c.joint[j + 2] = o.feather.o[0];
    c.joint[j + 3] = o.omega; c.joint[j + 4] = o.dip.o[1]; c.joint[j + 5] = o.feather.o[1];
    const J = this.joint;
    J.sweep = o.theta; J.dip = o.dip.o[0]; J.feather = o.feather.o[0]; J.dSweep = o.omega; J.dDip = o.dip.o[1]; J.dFeather = o.feather.o[1];
    evaluateOar(o.slot, J, this.kin);
    c.centerLocal[k] = this.kin.center.x; c.centerLocal[k + 1] = this.kin.center.y; c.centerLocal[k + 2] = this.kin.center.z;
    if (centerWorld) { c.centerWorld[k] = centerWorld.x; c.centerWorld[k + 1] = centerWorld.y; c.centerWorld[k + 2] = centerWorld.z; }
    c.forceWorld[k] = force ? force.x : 0; c.forceWorld[k + 1] = force ? force.y : 0; c.forceWorld[k + 2] = force ? force.z : 0;
    c.wetArea[i] = area; c.positivePower[i] = positivePower; c.handleForce[i] = o.Fh;
  }

  /** the Crew facade the HUD and game read: the stroke's actual rate and phase, the rowing hands' stamina */
  private updateFacade(dt: number) {
    const crew = this.crew, p = this.p, L = this.leader();
    const rowing = L && L.mode !== 'rest' && L.mode !== 'ready' && L.mode !== 'transfer' && Number.isFinite(L.lastCatch);
    crew.rate = rowing ? 60 / L.period : 0;
    crew.phase = rowing ? (((this.time - L.lastCatch) / L.period) % 1 + 1) % 1 : 0;
    if (L) { crew.latchedPeriod = L.period; crew.latchedDriveTime = L.lastDrive; }
    let st = 0, n = 0;
    for (const h of this.hands) if (h.state === 'rowing') { st += (h.Wbal / p.Wp) * (0.5 + 0.5 * h.R); n++; }
    crew.stamina = n ? st / n : 1;
    // ramming speed (the last order) lasts while the crew's reserve does, then drops to the order below. A tiring
    // man's strength falls with his reserve, so the reserve decays rather than empties: by a third of it the sprint
    // is no faster than Full (scripts/measure-trireme-rowing.mjs --sprint)
    if (crew.stamina <= RAM_SPENT && crew.orderIndex === ORDERS.length - 1) { crew.orderIndex--; crew.exhausted = true; }
    if (crew.stamina >= RAM_RESTORED) crew.exhausted = false;
    let active = 0;
    for (const o of this.oars) if (o.mode !== 'rest' && o.mode !== 'shipped') active = 1;
    crew.readiness += (active - crew.readiness) * (1 - Math.exp(-dt / 0.25));
  }

  /** each hand's weight at his body's centre of mass (spec §7.1); the physics integrates payload */
  private updatePayload() {
    if (!this.handLoad.length) return;
    const hull = this.design.hull, deck = this.design.deck, p = this.p, oars = this.oars;
    for (const h of this.hands) {
      const e = this.handLoad[h.id];
      let o: Oar | undefined;
      if (h.state === 'rowing' || h.state === 'handover') {
        for (let k = 0; k < oars.length; k++) if (oars[k].hand === h || oars[k].second === h) { o = oars[k]; break; }
      }
      if (o) {
        // standing pull facing aft: the pelvis travels toward the bow over the first half of the drive
        const span = p.finishMin - p.catchMax;
        const progress = clamp((o.theta - p.catchMax) / span, 0, 1), legs = smoothstep(0, 0.5, progress), trunk = smoothstep(0.2, 0.85, progress);
        // the body stands on the stance (stance.ts; the animator's root): the relief at it, the outgoing man
        // SECOND_STEP inboard of it during a handover. The pelvis travel is measured from the stance.
        const k = o.slot.id, pitch = 0.45 - 0.75 * trunk;
        const zFeet = this.stanceZ[k] - 0.15;
        const x = this.stanceX[k] - (h === o.second ? o.slot.side * SECOND_STEP : 0);
        const s = hull.sOf(o.slot.z);
        e.local.set(x, deck.deckY(s) + 1.02 - 0.12 * (1 - legs), zFeet + 0.25 - 0.45 * legs + 0.25 * Math.sin(pitch));
      } else {
        const s = clamp(hull.sOf(h.pos.z), 0, 1);
        e.local.set(h.pos.x, deck.deckY(s) + 1.0, h.pos.z);
      }
    }
  }
}
