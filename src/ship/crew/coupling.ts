import { clamp } from '../../core/util';
import { hash } from './physiology';
import type { Oar } from './oar';
import type { CrewContext } from './stroke';

/**
 * Timing (spec §5.7). A rower's phase is his oar's physical state, so the only timing he controls is
 * when he catches, i.e. how long his recovery takes. Each rower predicts the beat from the catches he
 * can see (those aft of him: he faces aft) or hear, after a perception delay, and aims his catch
 * part-way from his own rhythm toward it (the discrete Kuramoto map acting on the catch time). On a
 * long ship he sees and hears only the men near him; the stroke's beat reaches everyone as a call.
 */

/** the period this rower means to row: the stroke follows the order's rate (with a slow wander); the others the stroke's period */
export function targetPeriod(ctx: CrewContext, o: Oar, L: Oar | null) {
  const p = ctx.p, bias = o.hand ? o.hand.rateBias : 0;
  if (o === L || !L || !Number.isFinite(L.lastCatch)) {
    const wander = p.wanderAmp * Math.sin(ctx.time * 0.11 + 1.3) + 0.6 * p.wanderAmp * Math.sin(ctx.time * 0.047);
    return (60 / Math.max(8, ctx.intent.rate)) * (1 + bias + wander);
  }
  return L.period * (1 + bias);
}

/**
 * how far the crew trails the stroke (s, mean over the rowing followers, each measured within half a
 * beat of the stroke's last catch): positive when they catch after him. 0 with no followers.
 */
export function crewTrail(ctx: CrewContext, L: Oar | null): number {
  if (!L || !Number.isFinite(L.lastCatch) || !(L.period > 0)) return 0;
  let sum = 0, n = 0;
  for (const j of ctx.oars) {
    if (j === L || !j.hand || j.hand.state !== 'rowing' || !Number.isFinite(j.lastCatch) || j.mode === 'rest' || j.mode === 'hold' || j.mode === 'shipped') continue;
    const d = j.lastCatch - L.lastCatch;
    sum += d - L.period * Math.round(d / L.period);
    n++;
  }
  return n ? sum / n : 0;
}

/** when this rower intends to catch next: his own rhythm pulled toward the beat he sees and hears */
export function predictedCatch(ctx: CrewContext, o: Oar, L: Oar | null) {
  const p = ctx.p, T = targetPeriod(ctx, o, L);
  // a rower joining the rhythm has no beat of his own yet: anchor on the stroke's next predicted catch
  const tNat = Number.isFinite(o.lastCatch) ? o.lastCatch + T : L && Number.isFinite(L.lastCatch) ? L.lastCatch + L.period : ctx.time + 0.5;
  let wsum = 0, acc = 0;
  for (const j of ctx.oars) {
    if (j === o || !j.hand || j.hand.state !== 'rowing' || !Number.isFinite(j.lastCatch) || j.mode === 'rest' || j.mode === 'hold' || j.mode === 'shipped') continue;
    if (j.lastCatch + p.delay > ctx.time) continue; // not yet perceived
    // beyond his neighbours he follows only the stroke, by sight or by the call
    const near = Math.abs(j.slot.z - o.slot.z) <= p.sightRange && (p.crossDeck || j.slot.side === o.slot.side);
    if (!near && j !== L) continue;
    // facing aft: he sees those aft of him; below an open deck only along his own bank
    const visible = near && j.slot.z > o.slot.z && (p.crossDeck || j.slot.bank === o.slot.bank);
    const w = j === L ? (visible ? p.wStroke : p.wAudible * 2 + p.wCall) : visible ? p.wVisible : p.wAudible;
    // with a called beat every man knows the cadence: he expects a neighbour one called beat after his last
    // catch, so neighbours shape his phase but not his tempo (on 170 oars their own intervals, a little long,
    // reinforce one another into a slower crew rhythm than the stroke's, and the crew slips a beat at a time)
    const jp = p.wCall > 0 && L && Number.isFinite(L.lastCatch) ? L.period : j.period;
    const per = Math.max(0.5, jp);
    let pred = j.lastCatch + jp;
    pred += per * Math.round((tNat - pred) / per); // the beat nearest his own
    acc += w * pred;
    wsum += w;
  }
  // the stroke leads loosely, but waits for a crew that trails him (audit §3, §6.6)
  const trail = o === L ? crewTrail(ctx, L) : 0;
  if (o === L && p.wCall > 0 && Number.isFinite(L.lastCatch)) {
    // with a called beat the keleustes faces the whole crew and paces the stroke to their mean catch (the stroke
    // himself perceives only the men beside him at the stern, who keep time with him)
    const per = Math.max(0.5, L.period);
    let pred = L.lastCatch + L.period + trail;
    pred += per * Math.round((tNat - pred) / per);
    acc += p.wCall * pred;
    wsum += p.wCall;
  }
  const K = o === L ? (trail > p.trailLimit ? p.KleadTrail : p.Klead) : p.K;
  const jit = p.jitter * hash((o.hand ? o.hand.id : 0) * 31 + o.strokes, 7);
  return wsum > 0 ? tNat + K * (acc / wsum - tNat) + jit : tNat + jit;
}

/** shortest comfortable recovery: the rest-to-rest quintic's peak acceleration within about 80 % of the recovery hand force */
export function recMin(ctx: CrewContext, o: Oar) {
  const p = ctx.p, arc = Math.abs(o.plan.thetaC - o.theta) + Math.abs(o.omega) * 0.3, rh = o.handR * Math.cos(o.dip.o[0]);
  return Math.max(p.recMin + p.recPerRad * arc, Math.sqrt((5.77 * arc * o.Ieff) / (0.8 * o.recoveryF(p) * rh)));
}

/**
 * 20 Hz during the recovery: keep re-aiming the catch at the beat he sees and hears. Only the stroke
 * shifts his catch for the water; the others follow his beat, so the crew keeps together (audit §3, §6.3).
 */
export function retime(ctx: CrewContext, o: Oar) {
  const p = ctx.p, L = ctx.leader();
  const t0 = predictedCatch(ctx, o, L);
  const tStar = t0 + (o === L ? ctx.water.catchShift(o, ctx.body, ctx.waves, t0, ctx.time) : 0), left = o.catchAt - ctx.time;
  if (left < 0.25 || Math.abs(tStar - o.catchAt) < 0.02) return;
  const T = clamp(tStar - ctx.time, recMin(ctx, o), p.recMax);
  if (ctx.time + T > o.catchAt - 0.02 && tStar < o.catchAt) return; // late already: never postpone further
  if (Math.abs(ctx.time + T - o.catchAt) < 0.02) return;
  o.ref.set(o.theta, o.omega, o.plan.thetaC, T);
  o.catchAt = ctx.time + T;
}
