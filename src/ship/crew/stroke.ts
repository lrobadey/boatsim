import { clamp, smoothstep } from '../../core/util';
import { predictedCatch, recMin, retime, targetPeriod } from './coupling';
import type { CrewIntent } from './intent';
import type { Oar, OarMode, TransferTo } from './oar';
import type { CrewRowingParams } from './params';
import type { RowBody } from '../rowing';
import type { WaveField } from '../../world/waves';
import type { WaterReader } from './water';

/** what a rower's decisions can see of the crew (spec §5.4–5.5) */
export interface CrewContext {
  readonly p: CrewRowingParams;
  readonly oars: Oar[];
  readonly intent: CrewIntent;
  /** simulation time (s) */
  readonly time: number;
  /** ship speed through the water along her heading (m/s) */
  readonly speedNow: number;
  /** the stroke: the aftmost manned oar actively rowing */
  leader(): Oar | null;
  /** a catch happened: events, the catch log */
  onCatch(o: Oar, lead: boolean): void;
  /** seconds since a relief became ready at this oar (Infinity if none): a takeover needs his hands on first */
  reliefAge(o: Oar): number;
  /** the hull and the sea this step (for reading the water) */
  readonly body: RowBody | null;
  readonly waves: WaveField | null;
  readonly water: WaterReader;
}

type Want = 'rest' | 'row' | 'hold' | 'shipped';

/**
 * turning (audit §3, §6.4): the blade checks her only at or above this speed (m/s), and for at most
 * CHECK_HOLD_MAX seconds at a time. The audit's 2 s limit gave 0.96 deg/s in the hard-over test (the
 * inner side backs while she still has way on, which yaws less than holding); 10 s gives 1.34 deg/s
 * and still ends the check if she carries way for long. Speed alone (no limit) gave 1.33 deg/s but
 * left her nearly stopped at 60 s.
 */
const CHECK_MIN_SPEED = 0.6;
const CHECK_HOLD_MAX = 10.0;
/** modes of an oar in the stroke cycle (its plan reflects the current water) */
const IN_STROKE: ReadonlySet<OarMode> = new Set(['catch', 'drive', 'extract', 'recover']);
/** a relief takes an oar's catch only once his hands have been on the loom this long (s) (spec §6.2) */
const HANDS_ON_S = 1.0;

/**
 * Each rower's stroke: the per-oar mode machine (rest, transfer, ready, catch, drive, extract,
 * recover, hold, shipped), the stroke planner and the within-stroke motor command (spec §3.6, §5.6).
 * Decisions happen at events (finish, catch) and at 20 Hz in the recovery; everything is a pure
 * function of state, so the crew is deterministic.
 */
export class StrokeControl {
  constructor(private ctx: CrewContext) {}

  private get p() { return this.ctx.p; }

  desiredMode(o: Oar): Want {
    const it = this.ctx.intent;
    if (o.shipped) return 'shipped';
    if (!o.hand || o.hand.state !== 'rowing') return 'rest';
    if (it.hold) { o.checkT = 0; return 'hold'; }
    if (Math.abs(o.alloc) < 0.12) { o.checkT = 0; return 'rest'; }
    // felt rule: a blade driven against strong way is held square first (check her), then rowed.
    // The check ends below CHECK_MIN_SPEED or after CHECK_HOLD_MAX seconds held, and the blade backs
    // (in a turn the inner side must not hold water for the whole manoeuvre)
    const against = o.alloc < 0 ? this.ctx.speedNow : -this.ctx.speedNow;
    if (!(against > 0.35 && (o.mode === 'hold' || o.mode === 'rest' || against > 0.5))) { o.checkT = 0; return 'row'; }
    return against >= CHECK_MIN_SPEED && o.checkT < CHECK_HOLD_MAX ? 'hold' : 'row';
  }

  /** at each finish: arc, effort and arc placement for the next stroke from felt drive time and power */
  planStroke(o: Oar) {
    const p = this.p, it = this.ctx.intent, L = this.ctx.leader();
    const T = targetPeriod(this.ctx, o, L), Td = p.driveFrac * T;
    const S = o.hand ? o.hand.S(p) : 0.5;
    const pl = o.plan;
    if (o.strokes > 0) {
      pl.arc = clamp(pl.arc * Math.pow(Td / Math.max(0.3, o.lastDrive), 0.6), p.arcMin, p.arcMax * (0.8 + 0.2 * S));
      const Pt = Math.abs(o.alloc) * it.P;
      const ratio = clamp(Math.pow(Pt / Math.max(5, o.lastCycleP), 0.5), 0.8, 1.25);
      pl.u = clamp(pl.u * ratio, 0.12, Math.min(1, S));
      // reading the water: shorter, higher strokes in chop; a shorter stroke after missing water
      const chop = this.ctx.water.chopResponse(o);
      pl.arc = Math.max(p.arcMin, pl.arc * chop.arc * (o.missed && p.waterRead ? 0.9 : 1));
      o.dryLift = chop.lift;
      o.missed = false;
    }
    pl.P = Math.abs(o.alloc) * it.P;
    // stay in the rhythm: drive + shortest comfortable recovery + catch + extraction must fit the beat
    if (o.strokes > 0 && o.lastArc > 0) {
      const rh = o.handR * Math.cos(o.dDry), Idry = o.Ioar + p.mRowerRefl * rh * rh;
      const fits = (arc: number) =>
        (o.lastDrive * arc) / o.lastArc + Math.max(p.recMin + p.recPerRad * arc, Math.sqrt((5.77 * (arc + 0.05) * Idry) / (0.8 * o.recoveryF(p) * rh))) + p.Tcatch + p.Textract <= 0.97 * T;
      for (let guard = 0; pl.arc > p.arcMin && !fits(pl.arc) && guard < 40; guard++) pl.arc *= 0.96;
      // a man behind the beat takes a shorter reach so his recovery makes the next catch (without it a stroke that
      // fills the whole beat leaves no time to catch up, and a late man stays late). Behind is measured against
      // the called beat (the stroke's next catch), which the crew cannot drift with
      if (p.catchUp && Number.isFinite(o.lastCatch)) {
        const t = this.ctx.time, pred = predictedCatch(this.ctx, o, L);
        let beat = pred;
        if (L && L !== o && Number.isFinite(L.lastCatch) && L.period > 0) beat = L.lastCatch + L.period * Math.max(1, Math.round((pred - L.lastCatch) / L.period));
        const left = Math.min(pred, beat) - t;
        const rec = (arc: number) => Math.max(p.recMin + p.recPerRad * arc, Math.sqrt((5.77 * (arc + 0.05) * Idry) / (0.8 * o.recoveryF(p) * rh)));
        for (let guard = 0; pl.arc > p.arcMin && rec(pl.arc) > left && guard < 40; guard++) pl.arc *= 0.96;
      }
    }
    o.lastArc = pl.arc;
    const mid = p.thetaMid + 0.12 * o.bias;
    let c = mid + pl.arc / 2, f = mid - pl.arc / 2;
    if (c > p.catchMax) { f -= c - p.catchMax; c = p.catchMax; }
    if (f < p.finishMin) { c += p.finishMin - f; f = p.finishMin; }
    c = Math.min(c, p.catchMax);
    // backing: catch at the aft end, push forward
    pl.thetaC = o.dir > 0 ? f : c;
    pl.thetaF = o.dir > 0 ? c : f;
  }

  private startTransfer(o: Oar, target: number, featherTo: number, after: TransferTo) {
    const p = this.p, dist = Math.abs(target - o.theta);
    const shipping = after === 'shipped' || o.mode === 'shipped';
    // shipping ripples from bow to stern
    const lag = shipping ? 0.6 * clamp((o.slot.z + p.shipRipple / 2) / p.shipRipple, 0, 1) : 0;
    o.ref.set(o.theta, o.omega, target, 0.35 + 0.6 * dist + lag);
    o.dip.retarget(after === 'shipped' ? p.shippedDip : o.dDry, shipping ? 0.5 + lag : 0.2);
    o.feather.retarget(featherTo, 0.25);
    o.next = after;
    o.setMode('transfer');
  }

  private startRowing(o: Oar, dir: -1 | 1) {
    o.dir = dir;
    o.period = 60 / Math.max(8, this.ctx.intent.rate);
    o.strokes = 0;
    // joining a crew already rowing this way (the inner side after a turn): take the nearest rower's stroke
    // and effort on the same bank instead of a cold start, or the sides stay unequal for several strokes
    let mate: Oar | null = null;
    for (const j of this.ctx.oars) {
      if (j === o || j.dir !== dir || j.strokes === 0 || j.slot.bank !== o.slot.bank || !IN_STROKE.has(j.mode)) continue;
      if (!mate || Math.abs(j.slot.z - o.slot.z) < Math.abs(mate.slot.z - o.slot.z)) mate = j;
    }
    o.plan.arc = mate ? mate.plan.arc : this.p.arcStart;
    o.plan.u = mate ? mate.plan.u : 0.55;
    this.planStroke(o);
    this.startTransfer(o, o.plan.thetaC, 0, 'ready');
  }

  private beginCatch(o: Oar) {
    const p = this.p, t = this.ctx.time;
    o.prevCatch = o.lastCatch;
    o.lastCatch = t;
    if (Number.isFinite(o.prevCatch)) {
      const iv = o.lastCatch - o.prevCatch;
      if (iv < 3 * o.period) o.period += 0.5 * (iv - o.period);
      o.lastCycleP = o.cycleWork / Math.max(0.5, iv);
    }
    o.strokes++;
    o.cycleWork = 0;
    o.driveStart = t;
    // reading the water: set the blade's depth for the surface where it goes in
    o.dipTrim = this.ctx.water.dipTrim(o, this.ctx.body, this.ctx.waves, t);
    o.dip.retarget(o.dWet + o.dipTrim, p.Tcatch);
    o.feather.retarget(0, 0.08);
    // skilled catch: the blade goes in already travelling with the water (zero slip at entry)
    const cd = Math.cos(o.dWet), v = this.ctx.speedNow;
    let wm = p.catchMatch ? -v / (o.slot.bladeRadius * cd) : 0;
    if (o.dir * wm < 0) wm = 0;
    o.catchRef = { q0: o.theta, v0: o.omega, v1: wm, q1: o.theta + 0.5 * (o.omega + wm) * p.Tcatch, H: p.Tcatch, o: [0, 0, 0] };
    o.setMode('catch');
    this.ctx.onCatch(o, o === this.ctx.leader());
  }

  private beginRecovery(o: Oar) {
    const p = this.p, t = this.ctx.time, L = this.ctx.leader();
    let tStar = Number.isFinite(o.lastCatch) ? predictedCatch(this.ctx, o, L) : t + 1;
    // only the stroke shifts his catch for the water; the others follow his beat (audit §6.3)
    if (o === L) tStar += this.ctx.water.catchShift(o, this.ctx.body, this.ctx.waves, tStar, t);
    const Trec = clamp(tStar - t, recMin(this.ctx, o), p.recMax);
    o.ref.set(o.theta, o.omega, o.plan.thetaC, Trec);
    if (p.featherRecovery) o.feather.retarget(Math.PI / 2, p.Tfeather);
    o.catchAt = t + Trec;
    o.retimeClock = 0.05;
    o.setMode('recover');
  }

  private beginExtract(o: Oar) {
    const p = this.p;
    o.lastDrive = this.ctx.time - o.driveStart;
    o.dip.retarget(o.dDry, p.Textract);
    o.extractRef = { q0: o.theta, v0: o.omega, q1: o.theta + 0.5 * o.omega * p.Textract, v1: 0, H: p.Textract, o: [0, 0, 0] };
    o.setMode('extract');
  }

  private enterHold(o: Oar) {
    const p = this.p;
    o.ref.set(o.theta, o.omega, p.thetaHold, 0.45);
    o.feather.retarget(0, 0.15);
    o.dip.retarget(o.dWet, 0.25);
    o.setMode('hold');
  }

  private leave(o: Oar, want: Want, dirWanted: -1 | 1) {
    if (want === 'hold') return this.enterHold(o);
    if (o.mode === 'catch' || o.mode === 'drive') return this.beginExtract(o);
    if (want === 'row') return this.startRowing(o, dirWanted);
    if (want === 'shipped') return this.startTransfer(o, this.p.shippedSweep, Math.PI / 2, 'shipped');
    this.startTransfer(o, this.p.thetaRest, Math.PI / 2, 'rest');
  }

  /** advance one oar's mode machine by dt and set its motor command */
  decide(o: Oar, dt: number) {
    const p = this.p, ctx = this.ctx, want = this.desiredMode(o);
    o.modeT += dt;
    if (o.mode === 'hold' && !ctx.intent.hold) o.checkT += dt;
    const dirWanted: -1 | 1 = o.alloc < 0 ? 1 : -1;
    switch (o.mode as OarMode) {
      case 'rest':
        if (want !== 'rest') this.leave(o, want, dirWanted);
        break;
      case 'shipped':
        if (want !== 'shipped') this.startTransfer(o, p.thetaRest, Math.PI / 2, 'rest');
        break;
      case 'transfer':
        if (want === 'shipped' && o.next !== 'shipped') { this.leave(o, want, dirWanted); break; }
        if (o.ref.done && o.dip.done) {
          if (o.next === 'ready') { o.setMode('ready'); o.catchAt = Infinity; }
          else if (o.next === 'rest') o.setMode('rest');
          else if (o.next === 'shipped') o.setMode('shipped');
          else { o.dip.retarget(o.dWet, 0.22); o.setMode('hold'); }
        }
        break;
      case 'ready': {
        if (want !== 'row' || dirWanted !== o.dir) { this.leave(o, want, dirWanted); break; }
        const L = ctx.leader();
        if (!Number.isFinite(o.catchAt)) {
          if (o === L || !L) {
            // the stroke goes once the others are squared away (or after 1.5 s)
            const allReady = ctx.oars.every((j) => j === o || j.mode !== 'transfer');
            if (allReady || o.modeT > 1.5) o.catchAt = ctx.time + 0.3;
          } else if (L.mode !== 'ready' && L.mode !== 'transfer' && L.mode !== 'rest' && Number.isFinite(L.lastCatch) && L.lastCatch + p.delay <= ctx.time) {
            // join the rhythm: the first stroke on seeing his catch, later strokes on the predicted beat
            const pc = predictedCatch(ctx, o, L);
            o.catchAt = ctx.time - L.lastCatch < 1.0 ? Math.max(ctx.time, L.lastCatch + (o.hand ? o.hand.reaction : 0.2)) : pc > ctx.time ? pc : ctx.time;
          }
        }
        if (ctx.time >= o.catchAt && ctx.reliefAge(o) >= HANDS_ON_S) this.beginCatch(o);
        break;
      }
      case 'catch':
        if (o.modeT >= p.Tcatch) o.setMode('drive');
        break;
      case 'drive': {
        const pastFinish = o.dir * (o.theta - o.plan.thetaF) + Math.abs(o.omega) * p.Textract * 0.5 >= 0;
        o.stall = Math.abs(o.omega) < 0.05 ? o.stall + dt : 0;
        // keep the blade buried: re-aim the handle height at 20 Hz as the surface moves
        if ((o.retimeClock -= dt) <= 0) { o.retimeClock = 0.05; o.dip.retarget(this.ctx.water.trackDepth(o, this.ctx.body, this.ctx.waves, ctx.time), 0.12); }
        // missed water: the blade barely wet for a while in the drive
        o.missT = o.modeT > 0.1 && o.wet < 0.3 ? o.missT + dt : 0;
        if (o.missT > 0.3) o.missed = true;
        if (pastFinish || o.stall > 0.6 || o.modeT > 3.5 || want !== 'row') this.beginExtract(o);
        break;
      }
      case 'extract':
        if (o.modeT >= p.Textract) {
          if (want === 'row' && dirWanted === o.dir) { this.planStroke(o); this.beginRecovery(o); }
          else this.leave(o, want, dirWanted);
        }
        break;
      case 'recover':
        if (want !== 'row' || dirWanted !== o.dir) { this.leave(o, want, dirWanted); break; }
        if (ctx.time >= o.catchAt - 0.18 && o.feather.q1 !== 0) o.feather.retarget(0, 0.16);
        if (p.retime && (o.retimeClock -= dt) <= 0) { o.retimeClock = 0.05; retime(ctx, o); }
        if ((o.ref.done || ctx.time >= o.catchAt) && ctx.reliefAge(o) >= HANDS_ON_S) this.beginCatch(o);
        break;
      case 'hold':
        if (want !== 'hold') this.leave(o, want, dirWanted);
        break;
    }
    // within-stroke motor command: build at immersion, taper over the last of the arc, release at extraction
    if (o.mode === 'catch' || o.mode === 'drive') {
      const span = o.plan.thetaF - o.plan.thetaC;
      const prog = span !== 0 ? (o.theta - o.plan.thetaC) / span : 0;
      const taper = 1 - (1 - p.taperTo) * smoothstep(1 - p.taperFrac, 1, prog);
      o.uCmd = o.plan.u * (o.mode === 'catch' ? smoothstep(0.35, 1.0, o.modeT / p.Tcatch) : taper);
    } else o.uCmd = 0;
  }
}
