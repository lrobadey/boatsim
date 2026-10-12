// Crew rowing prototype for the Kyrenia merchant: six standing sweeps, per-oar force-balance sweep
// dynamics, individual rower agents (stroke planning, phase coupling, fatigue), crew intent and
// allocation, reliefs. Plugs into ShipPhysics through the same seam as RowingSystem
// (step / refreshWorld / reset / telemetry / renderPose / events / current / previous).
import { THREE, rowingMod, createFlowSample, MERCHANT } from './harness.mjs';
const { evaluateOar, createKinematics, BladeClipper, bladeDrag, nominalDip, RowEventRing, BladeFrame } = rowingMod;
const H = MERCHANT.hull;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// deterministic hash noise in [-1,1]
const hash = (i, k) => { const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return 2 * (s - Math.floor(s)) - 1; };

// ------------------------------------------------------------------ parameters
export const DEFAULTS = {
  // sweep geometry
  stations: [ // s, side  (fore P S P, aft S P S; stroke = aftmost)
    [0.17, -1], [0.25, 1], [0.33, -1], [0.62, 1], [0.70, -1], [0.78, 1]],
  length: 5.6, inboard: 1.5, handR: 1.25, bladeLength: 0.9, bladeWidth: 0.2, pinDx: 0.02, pinDy: 0.27,
  // inertia (kg m^2 about the thole): oar, rower body reflected through the hands, blade added mass (kg)
  Ioar: 80, mRowerRefl: 20, addedMass: 14.5,
  // rower: linear force-velocity at the hands, scaled by activation u (0..1) and a position factor g(theta)
  F0: 900, v0: 2.8, eccMax: 1.5, eccV: 0.25, pushFactor: 0.85,
  thetaMid: 0.0, thetaHalf: 0.5, gEdge: 0.45,
  tauUp: 0.06, tauDown: 0.09,
  // reach limits (rad, + = blade forward) and arc
  catchMax: 0.43, finishMin: -0.40, arcMin: 0.30, arcMax: 0.85, arcStart: 0.45,
  // servo (recovery / rest / hold): natural frequency, damping, force bound at the hands (N)
  servoWn: 12, servoZeta: 1.0, servoF: 220, holdF: 1.25, // holdF x F0 x strength x uHold
  uHold: 0.75,
  // stroke timing
  Tcatch: 0.22, Textract: 0.2, Tfeather: 0.15, driveFrac: 0.5, recMin: 0.55, recPerRad: 0.45, recMax: 3.2,
  thetaRest: 0.07, thetaHold: 0.07,
  // coupling
  K: 0.7, Klead: 0.1, delay: 0.15, wStroke: 1.0, wVisible: 0.5, wAudible: 0.15, jitter: 0.035,
  rateBias: 0.02, retime: true, wanderAmp: 0.012,
  // physiology (mechanical): critical power W, W' J, long-term reserve
  CP: 100, Wp: 14000, tEnd: 9000, tRecover: 5400,
  massHand: 65,
  // orders: [Back, Stop, Slow, Half, Full]
  orders: [
    { dir: -1, P: 80, rate: 15, manned: 6 },
    { dir: 0, P: 0, rate: 0, manned: 0 },
    { dir: 1, P: 45, rate: 14, manned: 2 },
    { dir: 1, P: 80, rate: 16, manned: 6 },
    { dir: 1, P: 115, rate: 18, manned: 6 },
  ],
  hands: 6, // 6..8 (>6 = reliefs)
  rotation: true, swapW: 0.35, swapR: 0.15,
  allocation: true, featherRecovery: true, catchMatch: true, taperFrac: 0.3, taperTo: 0.25,
};

// quintic from (q0,v0, a0=0) to (q1, 0, 0) over Hd; returns [q, dq, ddq] at t
function quintic(q0, v0, q1, Hd, t, out) {
  const x = clamp(t / Hd, 0, 1), x2 = x * x, x3 = x2 * x, x4 = x3 * x, x5 = x4 * x;
  const Q = x3 * (10 + x * (-15 + 6 * x)), dQ = 30 * x2 * (x - 1) * (x - 1), ddQ = 60 * x - 180 * x2 + 120 * x3;
  out[0] = q0 + (q1 - q0) * Q + Hd * v0 * (x - 6 * x3 + 8 * x4 - 3 * x5);
  out[1] = (q1 - q0) * dQ / Hd + v0 * (1 - 18 * x2 + 32 * x3 - 15 * x4);
  out[2] = t >= Hd ? 0 : (q1 - q0) * ddQ / (Hd * Hd) + v0 * (-36 * x + 96 * x2 - 60 * x3) / Hd;
  return out;
}
function hermite3(q0, v0, q1, v1, Hd, t, out) {
  const x = clamp(t / Hd, 0, 1), x2 = x * x, x3 = x2 * x;
  out[0] = (2 * x3 - 3 * x2 + 1) * q0 + (x3 - 2 * x2 + x) * Hd * v0 + (-2 * x3 + 3 * x2) * q1 + (x3 - x2) * Hd * v1;
  out[1] = ((6 * x2 - 6 * x) * q0 + (3 * x2 - 4 * x + 1) * Hd * v0 + (-6 * x2 + 6 * x) * q1 + (3 * x2 - 2 * x) * Hd * v1) / Hd;
  out[2] = t >= Hd ? 0 : ((12 * x - 6) * q0 + (6 * x - 4) * Hd * v0 + (-12 * x + 6) * q1 + (6 * x - 2) * Hd * v1) / (Hd * Hd);
  return out;
}
class Track { // kinematic joint track (dip / feather / servo reference)
  constructor(q) { this.q0 = q; this.v0 = 0; this.q1 = q; this.Hd = 1e-6; this.t = 1; this.o = [q, 0, 0]; }
  set(q0, v0, q1, Hd) { this.q0 = q0; this.v0 = v0; this.q1 = q1; this.Hd = Math.max(1e-6, Hd); this.t = 0; }
  retarget(cur, vel, q1, Hd) { this.set(cur, vel, q1, Hd); }
  eval(t) { this.t = t; return quintic(this.q0, this.v0, this.q1, this.Hd, t, this.o); }
  get done() { return this.t >= this.Hd; }
}

// ------------------------------------------------------------------ layout
export function buildLayout(p) {
  return p.stations.map(([s, side], id) => {
    const hb = H.halfBeam(s), sheer = H.sheer(s);
    return { id, s, length: p.length, inboard: p.inboard, bladeLength: p.bladeLength, bladeWidth: p.bladeWidth,
      bladeThickness: 0.03, bladeRadius: p.length - p.inboard - p.bladeLength / 2, bank: 0, side,
      x: side * (hb + p.pinDx), y: sheer + p.pinDy, z: H.zOf(s), jitter: 0, deckY: sheer - 0.3 };
  });
}

// ------------------------------------------------------------------ hand (person)
class Hand {
  constructor(id, p) {
    this.id = id;
    this.strength = 1 + 0.08 * hash(id, 1); this.cpScale = 1 + 0.08 * hash(id, 2);
    this.rateBias = p.rateBias * hash(id, 3); this.reaction = 0.18 + 0.06 * (0.5 + 0.5 * hash(id, 4));
    this.Wbal = p.Wp; this.R = 1; this.oar = -1; this.state = 'waiting'; this.walk = null; this.rowTime = 0;
    this.pos = new THREE.Vector3(); this.power = 0; this.work = 0; this.restTime = 0;
  }
  S(p) { // strength factor available now: short-term W' balance and long-term reserve
    const w = clamp(this.Wbal / p.Wp, 0, 1);
    return this.strength * (0.6 + 0.4 * Math.sqrt(w)) * (0.65 + 0.35 * this.R);
  }
  fatigue(p, P, dt) { // P: mechanical power equivalent (W)
    const CP = p.CP * this.cpScale * (0.75 + 0.25 * this.R);
    if (P > CP) this.Wbal -= (P - CP) * dt;
    else this.Wbal += (CP - P) * (p.Wp - this.Wbal) / p.Wp * dt;
    this.Wbal = clamp(this.Wbal, 0, p.Wp);
    const x = P / (p.CP * this.cpScale);
    this.R += (-(x > 0 ? Math.pow(x, 2.5) : 0) / p.tEnd + (P < 25 ? (1 - this.R) / p.tRecover : 0)) * dt;
    this.R = clamp(this.R, 0, 1);
  }
}

// ------------------------------------------------------------------ oar station (one sweep + its rower's motor control)
class Oar {
  constructor(slot, p) {
    this.slot = slot; this.p = p;
    this.theta = p.thetaRest; this.omega = 0; this.dip = new Track(nominalDip(slot, false)); this.feather = new Track(Math.PI / 2);
    this.ref = new Track(p.thetaRest); this.mode = 'rest'; this.modeT = 0; this.u = 0; this.uCmd = 0; this.dir = -1;
    this.hand = null; this.second = null; this.alloc = 0; this.bias = 0; this.next = null; // pending destination
    this.lastArc = 0; this.plan = { arc: p.arcStart, u: 0.6, thetaC: p.arcStart / 2, thetaF: -p.arcStart / 2, P: 0 };
    this.lastCatch = -Infinity; this.prevCatch = -Infinity; this.period = 3; this.strokes = 0; this.driveStart = 0;
    this.lastDrive = 1.2; this.cycleWork = 0; this.lastCycleP = 0; this.catchAt = Infinity; this.Fh = 0; this.Mr = 0; this.Mw = 0;
    this.stall = 0; this.wet = 0; this.contact = false; this.lastContactT = -1;
    this.audit = { posWork: 0, negWork: 0, waterWork: 0, numLoss: 0, shedKE: 0, KE0: 0, hullWork: 0, slipLoss: 0 };
    this.Ieff = p.Ioar;
  }
  get dDry() { return nominalDip(this.slot, false); }
  get dWet() { return nominalDip(this.slot, true); }
}

// ------------------------------------------------------------------ the system
export class CrewRowing {
  constructor(crew, opts = {}) {
    const p = this.p = { ...DEFAULTS, ...opts };
    this.crew = crew;
    this.slots = Object.freeze(buildLayout(p));
    const n = this.slots.length;
    this.oars = this.slots.map((s) => new Oar(s, p));
    this.hands = Array.from({ length: p.hands }, (_, i) => new Hand(i, p));
    for (let i = 0; i < n && i < this.hands.length; i++) { this.hands[i].oar = i; this.hands[i].state = 'rowing'; this.oars[i].hand = this.hands[i]; }
    this.previous = new BladeFrame(n); this.current = new BladeFrame(n); this.events = new RowEventRing();
    this.telemetry = { oarThrust: 0, portThrust: 0, starboardThrust: 0, yawMoment: 0, wetArea: 0, wetBlades: 0, positivePower: 0,
      dissipatedPower: 0, hullPower: 0, crewLoad: 0, forceCapFraction: 0, powerCapFraction: 0, missedDriveFraction: 0, fallbackQueries: 0, guardedQueries: 0 };
    this.k = createKinematics(); this.k1 = createKinematics(); this.clipper = new BladeClipper(); this.flow = createFlowSample(); this.fv = { vx: 0, vy: 0, vz: 0 };
    this.v = Array.from({ length: 16 }, () => new THREE.Vector3());
    this.patch = Array.from({ length: 4 }, () => ({ A: 0, n: new THREE.Vector3(), b: new THREE.Vector3(), s: new THREE.Vector3(), pos: new THREE.Vector3(), F: new THREE.Vector3() }));
    this.intent = { X: 0, N: 0, P: 0, rate: 0, hold: false, dir: 0 };
    this.byMode = {}; this.decisionClock = 0; this.allocClock = 0; this.rotClock = 0; this.time = 0;
    this.leaderRate = 0; this.catchLog = []; this.speedPerceived = 0; this.swaps = [];
    this.payloadRefs = null; this.relief = { fore: new THREE.Vector3(0, 0, H.zOf(0.40)), aft: new THREE.Vector3(0, 0, H.zOf(0.57)) };
    for (const o of this.oars) this.writeFrame(o, true);
    this.previous.copy(this.current);
  }
  reset(body, time) { this.time = time; this.events.clear(); this.previous.copy(this.current); }

  // ---------------- crew intent (10 Hz): order + helm + ship state -> normalised surge/yaw demand and power level
  updateIntent(helm, speed) {
    const o = this.p.orders[this.crew.orderIndex], it = this.intent;
    it.hold = this.crew.holdWater; it.dir = o.dir; it.P = o.P; it.rate = o.rate; it.manned = o.manned;
    const low = 1 - smooth(0.5, 2.0, Math.abs(speed));
    const turn = smooth(0.05, 1, Math.abs(helm)) * Math.sign(helm);
    it.X = o.dir * (1 - 0.6 * Math.abs(turn) * low); // hard over at low speed: the crew gives up way for the pivot
    // oars help the helm fully at rest and still ease the inner side at speed
    it.N = turn * (0.35 + 0.65 * low);
    it.yawPriority = 0.4 + 0.6 * low;
  }
  // ---------------- allocation (10 Hz): who pulls, backs or rests and how hard; fatigue-weighted
  allocate() {
    const it = this.intent, oars = this.oars, n = oars.length, p = this.p;
    if (it.dir === 0) { for (const o of oars) { o.alloc = 0; o.bias = 0; } return; } // Oars Up: no rowing whatever the helm (a pivot is a manoeuvre intent)
    // effectiveness per unit allocation: thrust 1, yaw -side (port pulling ahead turns to starboard = +N)
    const a = new Float64Array(n), cost = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const h = oars[i].hand; const rowing = h && h.state === 'rowing';
      cost[i] = rowing ? 0.02 + 0.25 * (1 - clamp(h.Wbal / p.Wp, 0, 1)) + 0.2 * (1 - h.R) : 1e3;
      a[i] = oars[i].alloc;
    }
    const X = it.dir === 0 ? 0 : it.X, N = it.N, wn = 3.0 * it.yawPriority, wx = 1.0;
    let cmax = 0; for (let i = 0; i < n; i++) if (cost[i] < 1e3) cmax = Math.max(cmax, cost[i]);
    const step = 0.9 / (2 * (wx + wn) / n + 2 * cmax / n); // 1/Lipschitz of the quadratic
    for (let i = 0; i < n; i++) if (cost[i] >= 1e3) a[i] = 0;
    for (let iter = 0; iter < 80; iter++) {
      let sx = 0, sn = 0; for (let i = 0; i < n; i++) { sx += a[i] / n; sn += -oars[i].slot.side * a[i] / n; }
      const ex = sx - X, en = sn - N;
      for (let i = 0; i < n; i++) {
        if (cost[i] >= 1e3) continue;
        const g = 2 * wx * ex / n + 2 * wn * en * (-oars[i].slot.side) / n + 2 * cost[i] * a[i] / n;
        a[i] = clamp(a[i] - g * step, -1, 1);
      }
    }
    // a manned limit (e.g. Slow with fewer oars): rest the most tired, keep sides balanced
    for (let i = 0; i < n; i++) {
      oars[i].alloc = a[i];
      // arc bias adds yaw: fore oars reach forward, aft oars finish long when their side must turn harder
      const fore = oars[i].slot.z < 0 ? 1 : -1, want = -oars[i].slot.side * Math.sign(a[i]) * N;
      oars[i].bias = clamp(fore * want, -1, 1) * smooth(0.2, 0.8, Math.abs(N));
    }
    if (it.manned < n && it.dir !== 0 && Math.abs(N) < 0.3) {
      // rowing in watches: keep the same men at the oars (hysteresis); swap a side's man only when he is clearly more tired
      for (const side of [-1, 1]) {
        const idx = [...oars.keys()].filter((i) => oars[i].slot.side === side);
        const want = it.manned / 2;
        let on = idx.filter((i) => oars[i].watch);
        if (on.length !== want) { on = [...idx].sort((i, j) => Math.abs(oars[i].slot.z) - Math.abs(oars[j].slot.z)).slice(0, want); }
        const off = idx.filter((i) => !on.includes(i));
        for (const i of on) for (const j of off) if (cost[i] - cost[j] > 0.15 && cost[j] < 1) { on[on.indexOf(i)] = j; break; }
        for (const i of idx) { oars[i].watch = on.includes(i); if (!oars[i].watch) oars[i].alloc = 0; }
      }
    } else for (const o of oars) o.watch = false;
  }
  // ---------------- per-rower decisions (events + 20 Hz re-timing)
  leader() { // the stroke: aftmost station with a rower actively rowing
    let best = null; for (const o of this.oars) if (o.hand && o.hand.state === 'rowing' && Math.abs(o.alloc) > 0.12 && (!best || o.slot.z > best.slot.z)) best = o; return best;
  }
  desiredMode(o) {
    const it = this.intent;
    if (!o.hand || o.hand.state !== 'rowing') return 'rest';
    if (it.hold) return 'hold';
    if (Math.abs(o.alloc) < 0.12) return 'rest';
    // felt rule: a blade driven against strong way is held square first (check her), then rowed
    const against = o.alloc < 0 ? this.speedNow : -this.speedNow;
    if (against > 0.35 && (o.mode === 'hold' || o.mode === 'rest' || against > 0.5)) return 'hold';
    return 'row';
  }
  targetPeriod(o, L) {
    const p = this.p, it = this.intent;
    if (o === L || !L || !isFinite(L.lastCatch)) {
      const wander = p.wanderAmp * Math.sin(this.time * 0.11 + 1.3) + 0.6 * p.wanderAmp * Math.sin(this.time * 0.047);
      return 60 / Math.max(8, it.rate) * (1 + o.hand.rateBias + wander);
    }
    return L.period * (1 + o.hand.rateBias);
  }
  predictedCatch(o, L) { // when this rower intends to catch next: own rhythm pulled towards what he sees/hears
    const p = this.p, T = this.targetPeriod(o, L);
    // a rower joining the rhythm has no own beat yet: anchor on the stroke's next predicted catch
    const tNat = isFinite(o.lastCatch) ? o.lastCatch + T : (L && isFinite(L.lastCatch) ? L.lastCatch + L.period : this.time + 0.5);
    let wsum = 0, acc = 0;
    for (const j of this.oars) {
      if (j === o || !j.hand || j.hand.state !== 'rowing' || !isFinite(j.lastCatch) || j.mode === 'rest' || j.mode === 'hold') continue;
      if (j.lastCatch + p.delay > this.time) continue; // not yet perceived
      const visible = j.slot.z > o.slot.z; // facing aft: sees those aft of him
      const w = j === L ? (visible ? p.wStroke : p.wAudible * 2) : visible ? p.wVisible : p.wAudible;
      let pred = j.lastCatch + j.period;
      const per = Math.max(0.5, j.period);
      pred += per * Math.round((tNat - pred) / per); // nearest beat to his own (bounded, no loop)
      acc += w * pred; wsum += w;
    }
    const K = o === L ? p.Klead : p.K;
    const jit = p.jitter * hash(o.hand.id * 31 + o.strokes, 7);
    return wsum > 0 ? tNat + K * (acc / wsum - tNat) + jit : tNat + jit;
  }
  planStroke(o) { // at each finish: arc, effort and arc placement for the next stroke from felt drive time and power
    const p = this.p, it = this.intent, h = o.hand, L = this.leader();
    const T = this.targetPeriod(o, L), Td = p.driveFrac * T;
    const S = h.S(p);
    const pl = o.plan;
    if (o.strokes > 0) {
      pl.arc = clamp(pl.arc * Math.pow(Td / Math.max(0.3, o.lastDrive), 0.6), p.arcMin, p.arcMax * (0.8 + 0.2 * S));
      const Pt = Math.abs(o.alloc) * it.P;
      const ratio = clamp(Math.pow(Pt / Math.max(5, o.lastCycleP), 0.5), 0.8, 1.25);
      pl.u = clamp(pl.u * ratio, 0.12, Math.min(1, S));
    }
    pl.P = Math.abs(o.alloc) * it.P;
    // keep the stroke inside the rhythm: drive + shortest comfortable recovery + catch + extraction must fit the beat
    if (o.strokes > 0 && o.lastArc > 0) {
      const rh = p.handR * Math.cos(o.dDry), Idry = p.Ioar + p.mRowerRefl * rh * rh;
      const fits = (arc) => o.lastDrive * arc / o.lastArc + Math.max(p.recMin + p.recPerRad * arc, Math.sqrt(5.77 * (arc + 0.05) * Idry / (0.8 * p.servoF * rh))) + p.Tcatch + p.Textract <= 0.97 * T;
      let guard = 0; while (pl.arc > p.arcMin && !fits(pl.arc) && guard++ < 40) pl.arc *= 0.96;
    }
    o.lastArc = pl.arc;
    const mid = p.thetaMid + 0.12 * o.bias;
    const back = o.dir > 0; // backing: catch at the aft end, push forward
    let c = mid + pl.arc / 2, f = mid - pl.arc / 2;
    if (c > p.catchMax) { f -= c - p.catchMax; c = p.catchMax; }
    if (f < p.finishMin) { c += p.finishMin - f; f = p.finishMin; }
    c = Math.min(c, p.catchMax);
    pl.thetaC = back ? f : c; pl.thetaF = back ? c : f;
  }
  // ---------------- mode machine
  setMode(o, mode, t) { o.mode = mode; o.modeT = 0; }
  startTransfer(o, target, featherTo, after) {
    const p = this.p, dist = Math.abs(target - o.theta);
    o.ref.retarget(o.theta, o.omega, target, 0.35 + 0.6 * dist);
    o.dip.retarget(o.dip.o[0], o.dip.o[1], o.dDry, 0.2);
    o.feather.retarget(o.feather.o[0], o.feather.o[1], featherTo, 0.25);
    o.next = after; this.setMode(o, 'transfer');
  }
  beginCatch(o) {
    const p = this.p;
    o.prevCatch = o.lastCatch; o.lastCatch = this.time;
    if (isFinite(o.prevCatch)) { const iv = o.lastCatch - o.prevCatch; if (iv < 3 * o.period) o.period += 0.5 * (iv - o.period); }
    if (isFinite(o.prevCatch)) o.lastCycleP = o.cycleWork / Math.max(0.5, o.lastCatch - o.prevCatch);
    o.strokes++; o.cycleWork = 0; o.driveStart = this.time;
    o.dip.retarget(o.dip.o[0], o.dip.o[1], o.dWet, p.Tcatch);
    o.feather.retarget(o.feather.o[0], o.feather.o[1], 0, 0.08);
    // skilled catch: the blade goes in already travelling with the water (zero slip at entry)
    const cd = Math.cos(o.dWet), v = this.speedNow;
    let wm = p.catchMatch ? -v / (o.slot.bladeRadius * cd) : 0; if (o.dir * wm < 0) wm = 0;
    o.catchRef = { q0: o.theta, v0: o.omega, v1: wm, q1: o.theta + 0.5 * (o.omega + wm) * p.Tcatch, H: p.Tcatch, o: [0, 0, 0] };
    this.setMode(o, 'catch');
    if (o === this.leader()) this.events.push('catchBeat', this.time, -1, o.slot.side, 0, 0, 0, o.plan.u);
    this.catchLog.push({ t: this.time, oar: o.slot.id, hand: o.hand.id, lead: o === this.leader() });
  }
  beginRecovery(o) {
    const p = this.p, L = this.leader();
    const tStar = isFinite(o.lastCatch) ? this.predictedCatch(o, L) : this.time + 1;
    const Trec = clamp(tStar - this.time, this.recMin(o), p.recMax);
    o.ref.retarget(o.theta, o.omega, o.plan.thetaC, Trec);
    if (p.featherRecovery) o.feather.retarget(o.feather.o[0], o.feather.o[1], Math.PI / 2, p.Tfeather);
    o.catchAt = this.time + Trec; this.setMode(o, 'recover');
  }
  decide(o, dt) {
    const p = this.p, want = this.desiredMode(o), L = this.leader();
    o.modeT += dt;
    const dirWanted = o.alloc < 0 ? 1 : -1; // +1 backing (theta increases in the drive)
    switch (o.mode) {
      case 'rest':
        if (want === 'row') { o.dir = dirWanted; o.period = 60 / Math.max(8, this.intent.rate); o.strokes = 0; o.plan.arc = p.arcStart; o.plan.u = 0.55; this.planStroke(o); this.startTransfer(o, o.plan.thetaC, 0, 'ready'); }
        else if (want === 'hold') this.enterHold(o);
        break;
      case 'transfer':
        if (o.ref.done && o.dip.done) {
          if (o.next === 'ready') { this.setMode(o, 'ready'); o.catchAt = Infinity; }
          else if (o.next === 'rest') this.setMode(o, 'rest');
          else if (o.next === 'hold') { o.dip.retarget(o.dip.o[0], o.dip.o[1], o.dWet, 0.22); this.setMode(o, 'hold'); }
        }
        break;
      case 'ready': {
        if (want !== 'row' || dirWanted !== o.dir) { this.leave(o, want, dirWanted); break; }
        if (!isFinite(o.catchAt)) {
          if (o === L || !L) {
            // the stroke goes once the others are squared away (or after 1.5 s)
            const allReady = this.oars.every((j) => j === o || j.mode !== 'transfer');
            if (allReady || o.modeT > 1.5) o.catchAt = this.time + 0.3;
          } else if (L.mode !== 'ready' && L.mode !== 'transfer' && L.mode !== 'rest' && isFinite(L.lastCatch) && L.lastCatch + p.delay <= this.time) {
            // join the rhythm: first stroke on seeing his catch, later strokes on the predicted beat
            const pc = this.predictedCatch(o, L);
            o.catchAt = this.time - L.lastCatch < 1.0 ? Math.max(this.time, L.lastCatch + o.hand.reaction) : (pc > this.time ? pc : this.time);
          }
        }
        if (this.time >= o.catchAt) this.beginCatch(o);
        break;
      }
      case 'catch':
        if (o.modeT >= p.Tcatch) this.setMode(o, 'drive');
        break;
      case 'drive': {
        const pastFinish = o.dir * (o.theta - o.plan.thetaF) + Math.abs(o.omega) * p.Textract * 0.5 >= 0;
        o.stall = Math.abs(o.omega) < 0.05 ? o.stall + dt : 0;
        if (pastFinish || o.stall > 0.6 || o.modeT > 3.5 || want !== 'row') {
          o.lastDrive = this.time - o.driveStart;
          o.dip.retarget(o.dip.o[0], o.dip.o[1], o.dDry, p.Textract);
          o.extractRef = { q0: o.theta, v0: o.omega, q1: o.theta + 0.5 * o.omega * p.Textract, v1: 0, H: p.Textract, o: [0, 0, 0] };
          this.setMode(o, 'extract');
        }
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
        if (this.time >= o.catchAt - 0.18 && o.feather.q1 !== 0) o.feather.retarget(o.feather.o[0], o.feather.o[1], 0, 0.16);
        if (p.retime && (o.retimeClock = (o.retimeClock ?? 0) - dt) <= 0) { o.retimeClock = 0.05; this.retime(o); }
        if (o.ref.done || this.time >= o.catchAt) this.beginCatch(o);
        break;
      case 'hold':
        if (want !== 'hold') this.leave(o, want, dirWanted);
        break;
    }
    if (o.mode === 'catch' || o.mode === 'drive' || o.mode === 'extract') {
      // within-stroke motor command: build at full immersion, shape over the stroke, release at extraction
      const prog = (o.theta - o.plan.thetaC) / (o.plan.thetaF - o.plan.thetaC);
      const taper = 1 - (1 - p.taperTo) * smooth(1 - p.taperFrac, 1, prog);
      const x = o.mode === 'catch' ? smooth(0.35, 1.0, o.modeT / p.Tcatch) : o.mode === 'drive' ? taper : 0;
      o.uCmd = o.plan.u * x;
    } else o.uCmd = 0;
  }
  recMin(o) { // shortest comfortable recovery: rest-to-rest quintic peak accel within ~70% of the recovery hand force
    const p = this.p, arc = Math.abs(o.plan.thetaC - o.theta) + Math.abs(o.omega) * 0.3, rh = p.handR * Math.cos(o.dip.o[0]);
    return Math.max(p.recMin + p.recPerRad * arc, Math.sqrt(5.77 * arc * o.Ieff / (0.8 * p.servoF * rh)));
  }
  retime(o) { // 20 Hz: keep re-aiming the catch at the beat he sees and hears
    const p = this.p, L = this.leader();
    const tStar = this.predictedCatch(o, L), left = o.catchAt - this.time;
    if (left < 0.25 || Math.abs(tStar - o.catchAt) < 0.02) return;
    const T = clamp(tStar - this.time, this.recMin(o), p.recMax);
    if (this.time + T > o.catchAt - 0.02 && tStar < o.catchAt) return; // late already: never postpone further
    if (Math.abs(this.time + T - o.catchAt) < 0.02) return;
    o.ref.retarget(o.theta, o.omega, o.plan.thetaC, T); o.catchAt = this.time + T;
  }
  leave(o, want, dirWanted) {
    if (want === 'hold') return this.enterHold(o);
    if (o.mode === 'catch' || o.mode === 'drive') { o.lastDrive = this.time - o.driveStart; o.dip.retarget(o.dip.o[0], o.dip.o[1], o.dDry, this.p.Textract);
      o.extractRef = { q0: o.theta, v0: o.omega, q1: o.theta + 0.5 * o.omega * this.p.Textract, v1: 0, H: this.p.Textract, o: [0, 0, 0] }; this.setMode(o, 'extract'); return; }
    if (want === 'row') { o.dir = dirWanted; o.period = 60 / Math.max(8, this.intent.rate); o.strokes = 0; o.plan.arc = this.p.arcStart; o.plan.u = 0.55; this.planStroke(o); this.startTransfer(o, o.plan.thetaC, 0, 'ready'); }
    else this.startTransfer(o, this.p.thetaRest, Math.PI / 2, 'rest');
  }
  enterHold(o) {
    const p = this.p;
    o.ref.retarget(o.theta, o.omega, p.thetaHold, 0.45);
    o.feather.retarget(o.feather.o[0], o.feather.o[1], 0, 0.15);
    o.dip.retarget(o.dip.o[0], o.dip.o[1], o.dWet, 0.25);
    this.setMode(o, 'hold');
  }
  // ---------------- physics helpers
  Fhand(o, vh, S) { // rower handle force (N) along the drive direction at handle speed vh (m/s, + = moving with the stroke)
    const p = this.p;
    const g = clamp(1 - (1 - p.gEdge) * Math.pow((o.theta - p.thetaMid) / p.thetaHalf, 2), p.gEdge, 1);
    const Fmax = o.u * p.F0 * S * g * (o.dir > 0 ? p.pushFactor : 1);
    return vh >= 0 ? Fmax * Math.max(0, 1 - vh / p.v0) : Fmax * (1 + (p.eccMax - 1) * (1 - Math.exp(vh / p.eccV)));
  }
  waterMoment(o, w, patches, nwet) { // generalised sweep moment of water forces at sweep rate w
    let M = 0; const s = this.v[0], F = this.v[1];
    for (let j = 0; j < nwet; j++) {
      const pa = patches[j]; s.copy(pa.b).addScaledVector(pa.s, w);
      bladeDrag(pa.A, s, pa.n, F); M += F.dot(pa.s);
    }
    return M;
  }
  // ---------------- main step
  step(dt, time, body, helm, waves, forceOut, torqueOut) {
    const p = this.p; this.time = time; this.previous.copy(this.current);
    const fwd = this.v[2].set(0, 0, -1).applyQuaternion(body.quat);
    const speed = body.vel.dot(fwd); this.speedNow = speed;
    this.speedPerceived += (speed - this.speedPerceived) * (1 - Math.exp(-dt / 2));
    this.allocClock -= dt; this.rotClock -= dt;
    if (this.allocClock <= 0) { this.allocClock += 0.1; this.updateIntent(helm, speed); if (p.allocation) this.allocate(); else for (const o of this.oars) { o.alloc = this.intent.dir; o.bias = 0; } }
    if (this.rotClock <= 0) { this.rotClock += 1; if (p.rotation && this.hands.length > this.oars.length) this.rotate(); }
    this.updateWalkers(dt);
    const tele = this.telemetry;
    for (const k in tele) tele[k] = 0;
    const up = this.v[3].set(0, 1, 0).applyQuaternion(body.quat);
    for (const o of this.oars) {
      this.decide(o, dt);
      const h = o.hand, S = h ? h.S(p) : 0, slot = o.slot;
      // activation dynamics
      o.u += (o.uCmd - o.u) * (1 - Math.exp(-dt / (o.uCmd > o.u ? p.tauUp : p.tauDown)));
      // kinematic dip/feather at t1
      const dp = o.dip.eval(o.dip.t + dt), fe = o.feather.eval(o.feather.t + dt);
      const th0 = o.theta, w0 = o.omega, thPred = th0 + w0 * dt;
      // geometry & per-patch linearisation (slip = b + w*s)
      const J = { sweep: thPred, dip: dp[0], feather: fe[0], dSweep: 1, dDip: 0, dFeather: 0 };
      evaluateOar(slot, J, this.k1); // unit sweep-rate velocities
      J.dSweep = 0; J.dDip = dp[1]; J.dFeather = fe[1]; evaluateOar(slot, J, this.k); // dip/feather velocities
      const q = body.quat, k = this.k, k1 = this.k1;
      const cW = this.v[4].copy(k.center).sub(body.cg).applyQuaternion(q).add(body.pos);
      const axis = this.v[5].copy(k.axis).applyQuaternion(q), width = this.v[6].copy(k.widthAxis).applyQuaternion(q), normal = this.v[7].copy(k.normal).applyQuaternion(q);
      const du0 = this.v[8].copy(k.axisVelocity).applyQuaternion(q), dB0 = this.v[9].copy(k.widthAxisVelocity).applyQuaternion(q);
      const du1 = this.v[10].copy(k1.axisVelocity).applyQuaternion(q), dB1 = this.v[11].copy(k1.widthAxisVelocity).applyQuaternion(q);
      waves.sampleFlowAt(cW.x, cW.y, cW.z, time, this.flow);
      const fl = this.flow; let nwet = 0, area = 0;
      for (let j = 0; j < 4; j++) {
        const l0 = -slot.bladeLength / 2 + j * slot.bladeLength / 4, l1 = l0 + slot.bladeLength / 4;
        const depth = fl.height - cW.y, dl = fl.hx * axis.x + fl.hz * axis.z - axis.y, dw = fl.hx * width.x + fl.hz * width.z - width.y;
        const wet = this.clipper.clip(l0, l1, -slot.bladeWidth / 2, slot.bladeWidth / 2, depth, dl, dw);
        if (wet.area === 0) continue;
        const pa = this.patch[nwet++]; pa.A = wet.area; area += wet.area; pa.n.copy(normal);
        pa.pos.copy(cW).addScaledVector(axis, wet.l).addScaledVector(width, wet.w);
        const ph = fl.height + fl.hx * (pa.pos.x - cW.x) + fl.hz * (pa.pos.z - cW.z);
        waves.flowAtDepth(fl, Math.max(0, ph - pa.pos.y), this.fv);
        const r = this.v[12].copy(pa.pos).sub(body.pos);
        pa.b.copy(body.angVel).cross(r).add(body.vel); pa.b.x -= this.fv.vx; pa.b.y -= this.fv.vy; pa.b.z -= this.fv.vz;
        pa.d = (pa.d ?? new THREE.Vector3()).copy(du0).multiplyScalar(slot.bladeRadius + wet.l).addScaledVector(dB0, wet.w); pa.b.add(pa.d);
        pa.s.copy(du1).multiplyScalar(slot.bladeRadius + wet.l).addScaledVector(dB1, wet.w);
      }
      const full = slot.bladeLength * slot.bladeWidth, wetFrac = area / full;
      // effective inertia: oar + rower's moving mass through the hands + blade added mass when wet and square
      const cd = Math.cos(dp[0]), rh = p.handR * cd;
      const Inew = p.Ioar + (h ? p.mRowerRefl * rh * rh : 0) + (o.second ? p.mRowerRefl * rh * rh : 0) + p.addedMass * (slot.bladeRadius ** 2 + slot.bladeLength ** 2 / 12) * wetFrac * Math.cos(fe[0]) ** 2;
      // added mass: leaving the water sheds its energy into the wake (rate kept); entering picks it up
      // momentum-conservingly (inelastic, I0 w0 = I1 w0'), so no energy appears from a changing inertia
      let w0e = w0;
      if (Inew < o.Ieff) o.audit.shedKE += 0.5 * (o.Ieff - Inew) * w0 * w0;
      else if (Inew > o.Ieff) { w0e = o.Ieff * w0 / Inew; o.audit.pickupLoss = (o.audit.pickupLoss ?? 0) + 0.5 * o.Ieff * w0 * w0 - 0.5 * Inew * w0e * w0e; }
      const I = Inew; o.Ieff = Inew;
      // rower moment law
      const physMode = o.mode === 'drive' || (o.mode === 'extract' && !o.extractRef) || (o.mode === 'catch' && !p.catchMatch);
      let refq = null, beta = 1;
      if (o.mode === 'catch' && p.catchMatch) { const c = o.catchRef; refq = hermite3(c.q0, c.v0, c.q1, c.v1, c.H, o.modeT + dt, c.o); beta = smooth(0.6, 1.0, (o.modeT + dt) / c.H); }
      else if (o.mode === 'extract' && o.extractRef) { const c = o.extractRef; refq = hermite3(c.q0, c.v0, c.q1, c.v1, c.H, o.modeT + dt, c.o); }
      else if (!physMode) {
        refq = o.mode === 'rest' ? [p.thetaRest, 0, 0] : o.mode === 'ready' ? [o.plan.thetaC, 0, 0] : o.ref.eval(o.ref.t + dt);
      }
      const Kp = I * p.servoWn ** 2, Kd = 2 * p.servoZeta * I * p.servoWn;
      const Mmax = o.mode === 'hold' ? p.holdF * p.uHold * p.F0 * S * rh : (h ? p.servoF * rh : 30);
      const MmaxC = o.mode === 'catch' || o.mode === 'extract' ? p.F0 * S * rh : Mmax;
      const Mr = (w) => {
        const fv = () => { const vh = o.dir * w * rh; return o.dir * this.Fhand(o, vh, S) * rh; };
        if (physMode) return fv();
        const sv = clamp(I * refq[2] + Kp * (refq[0] - th0 - w * dt) + Kd * (refq[1] - w), -MmaxC, MmaxC);
        return o.mode === 'catch' ? (1 - beta) * sv + beta * fv() : sv;
      };
      const G = (w) => I * (w - w0e) / dt - Mr(w) - this.waterMoment(o, w, this.patch, nwet);
      // monotone G: safeguarded Newton
      let w = w0, lo = -40, hi = 40;
      for (let it = 0; it < 8; it++) {
        const g = G(w); if (Math.abs(g) < 1e-7 * I / dt) break;
        if (g > 0) hi = w; else lo = w;
        const h2 = 1e-5, dg = (G(w + h2) - G(w - h2)) / (2 * h2);
        let wn = w - g / dg; if (!(wn > lo && wn < hi)) wn = 0.5 * (lo + hi); w = wn;
      }
      const Mr1 = Mr(w), Mw1 = this.waterMoment(o, w, this.patch, nwet);
      // audit (oar side)
      const a = o.audit, Pr = Mr1 * w;
      if (Pr > 0) a.posWork += Pr * dt; else a.negWork -= Pr * dt;
      a.waterWork += Mw1 * w * dt; a.numLoss += 0.5 * I * (w - w0e) ** 2;
      o.omega = w; o.theta = th0 + w * dt; o.Mr = Mr1; o.Mw = Mw1; o.Fh = Math.abs(Mr1) / Math.max(1e-6, rh);
      // forces to hull at final sweep rate
      let fx = 0, fy = 0, fz = 0, Pjoint = 0, Pdiss = 0, Phull = 0;
      const sl = this.v[13], F = this.v[14], rr = this.v[15];
      for (let j = 0; j < nwet; j++) {
        const pa = this.patch[j]; sl.copy(pa.b).addScaledVector(pa.s, w); bladeDrag(pa.A, sl, pa.n, F);
        forceOut.add(F); rr.copy(pa.pos).sub(body.pos); const m = rr.cross(F); torqueOut.add(m); tele.yawMoment += m.y;
        fx += F.x; fy += F.y; fz += F.z; Pdiss += -F.dot(sl);
        // hull-side work: F . (v_body - v_water) = F.(slip) - F.(v_joint)
      }
      // recompute exact hull power: F.(v_body - v_water) per patch
      Phull = 0; for (let j = 0; j < nwet; j++) { const pa = this.patch[j]; sl.copy(pa.b).addScaledVector(pa.s, w); bladeDrag(pa.A, sl, pa.n, F);
        const r2 = this.v[12].copy(pa.pos).sub(body.pos); const vb = this.v[1].copy(body.angVel).cross(r2).add(body.vel); Phull += F.dot(vb); a.dipWork = (a.dipWork ?? 0) + F.dot(pa.d) * dt; }
      let Pdip = 0; for (let j = 0; j < nwet; j++) { const pa = this.patch[j]; sl.copy(pa.b).addScaledVector(pa.s, w); bladeDrag(pa.A, sl, pa.n, F); Pdip -= F.dot(pa.d); }
      const PdipPos = Math.max(0, Pdip); a.dipPos = (a.dipPos ?? 0) + PdipPos * dt; a.dipNeg = (a.dipNeg ?? 0) + Math.max(0, -Pdip) * dt;
      a.hullWork += Phull * dt; a.slipLoss += Pdiss * dt;
      { const bm = (this.byMode[o.mode] ??= { pos: 0, neg: 0, slip: 0, hull: 0, imp: 0, t: 0 }); bm.pos += (Math.max(0, Pr) + PdipPos) * dt; bm.dip = (bm.dip ?? 0) + PdipPos * dt; bm.neg += Math.max(0, -Pr) * dt; bm.slip += Pdiss * dt; bm.hull += Phull * dt; bm.imp += (fx * fwd.x + fz * fwd.z) * dt; bm.t += dt; }
      const thrust = fx * fwd.x + fy * fwd.y + fz * fwd.z;
      tele.oarThrust += thrust; if (slot.side < 0) tele.portThrust += thrust; else tele.starboardThrust += thrust;
      tele.wetArea += area; if (area > 0) tele.wetBlades++; tele.positivePower += Math.max(0, Pr) + PdipPos; tele.dissipatedPower += Pdiss; tele.hullPower += Phull;
      o.cycleWork += (Math.max(0, Pr) + PdipPos) * dt;
      if (o.mode === 'catch' && o.modeT < dt * 1.5 && o.strokes > 1) { /* cycle boundary handled in beginCatch */ }
      // physiology: mechanical power + isometric holding cost
      if (h) { const Peq = Math.max(0, Pr) + PdipPos + 0.25 * Math.max(0, -Pr) + 0.04 * o.Fh * (o.mode === 'hold' ? 1 : 0.3);
        h.power += (Peq - h.power) * (1 - Math.exp(-dt / 8)); h.fatigue(p, h.power, dt); /* W prime model runs on stroke-averaged power */ h.work += Math.max(0, Pr) * dt; h.rowTime += dt; }
      o.wet = wetFrac;
      // frame + events
      this.writeFrame(o, false, cW, fx, fy, fz, area, Math.max(0, Pr), Pdiss);
      const was = o.contact, contact = was ? wetFrac >= 0.02 : wetFrac > 0.08;
      if (contact !== was && time - o.lastContactT >= 0.06) { this.events.push(contact ? 'enterWater' : 'leaveWater', time, slot.id, slot.side, cW.x, cW.y, cW.z, Math.min(1, Math.sqrt(Pdiss / 250))); o.contact = contact; o.lastContactT = time; this.current.contact[slot.id] = contact ? 1 : 0; }
    }
    // cycle power bookkeeping at catches
    for (const o of this.oars) if (o.mode === 'catch' && o.modeT <= dt + 1e-9 && isFinite(o.prevCatch)) { /* handled */ }
    // crew compatibility facade
    const L = this.leader();
    this.crew.rate = L && L.mode !== 'rest' ? 60 / L.period : 0; this.crew.phase = L && isFinite(L.lastCatch) ? ((time - L.lastCatch) / L.period) % 1 : 0;
    let st = 0; for (const h of this.hands) st += h.Wbal / p.Wp * (0.5 + 0.5 * h.R); this.crew.stamina = st / this.hands.length;
    this.updatePayload(body);
  }
  writeFrame(o, init, cW, fx = 0, fy = 0, fz = 0, area = 0, pp = 0, pd = 0) {
    const c = this.current, i = o.slot.id, j = i * 6;
    c.joint[j] = o.theta; c.joint[j + 1] = o.dip.o[0]; c.joint[j + 2] = o.feather.o[0]; c.joint[j + 3] = o.omega; c.joint[j + 4] = o.dip.o[1]; c.joint[j + 5] = o.feather.o[1];
    c.forceWorld[i * 3] = fx; c.forceWorld[i * 3 + 1] = fy; c.forceWorld[i * 3 + 2] = fz; c.wetArea[i] = area; c.positivePower[i] = pp; c.handleForce[i] = o.Fh;
    if (cW) { c.centerWorld[i * 3] = cW.x; c.centerWorld[i * 3 + 1] = cW.y; c.centerWorld[i * 3 + 2] = cW.z; }
  }
  refreshWorld(body) {}
  renderPose(i, alpha, out) { const a = clamp(alpha, 0, 1), P = this.previous.joint, C = this.current.joint, j = i * 6;
    const L = (k) => P[j + k] + (C[j + k] - P[j + k]) * a;
    evaluateOar(this.slots[i], { sweep: L(0), dip: L(1), feather: L(2), dSweep: L(3), dDip: L(4), dFeather: L(5) }, out); }
  // ---------------- body pose for animation & payload (standing pull, facing aft)
  bodyPose(o, out = {}) {
    const p = this.p, slot = o.slot, side = slot.side, cd = Math.cos(o.dip.o[0]);
    // handle (outer hand at r 1.45, inner at 1.05) in ship-local coordinates
    const hp = (r) => ({ x: slot.x - side * r * cd * Math.cos(o.theta), y: slot.y + r * Math.sin(o.dip.o[0]), z: slot.z + r * cd * Math.sin(o.theta) });
    out.handOuter = hp(1.45); out.handInner = hp(1.05);
    // stroke progress 0 at the catch (reaching aft) .. 1 at the finish (leaning to the bow)
    const pr = clamp((o.theta - p.catchMax) / (p.finishMin - p.catchMax), 0, 1);
    const legs = smooth(0.0, 0.5, pr), trunk = smooth(0.2, 0.85, pr), arms = smooth(0.6, 1.0, pr);
    const zFeet = slot.z - 0.15; // feet straddle the station; front (aft) foot braced at a cleat
    out.feet = { aft: { x: -side * 0.25, z: zFeet + 0.35 }, fwd: { x: -side * 0.35, z: zFeet - 0.35 } };
    out.pelvis = { x: -side * 0.3, y: slot.deckY + 0.92 - 0.12 * (1 - legs), z: zFeet + 0.25 - 0.45 * legs };
    out.trunkPitch = 0.45 - 0.75 * trunk; // rad, + = leaning aft (towards the stern / catch)
    out.armDraw = arms; out.progress = pr;
    out.gaze = 'stroke';
    out.com = { x: out.pelvis.x, y: out.pelvis.y + 0.1, z: out.pelvis.z + 0.25 * Math.sin(out.trunkPitch) };
    return out;
  }
  updatePayload(body) {
    if (!body.payload || this.noPayload) return;
    if (!this.payloadRefs) { this.payloadRefs = this.hands.map(() => { const r = { mass: this.p.massHand, local: new THREE.Vector3() }; body.payload.push(r); return r; }); }
    for (const h of this.hands) {
      const r = this.payloadRefs[h.id];
      if ((h.state === 'rowing' || h.state === 'handover') && (h.oar >= 0 || h.state === 'handover')) { if (h.oar < 0) { const o = this.oars.find((q) => q.second === h); if (o) { const b = this.bodyPose(o); r.local.set(b.com.x - o.slot.side * 0.35, b.com.y, b.com.z); } continue; } const b = this.bodyPose(this.oars[h.oar]); r.local.set(b.com.x, b.com.y, b.com.z); }
      else r.local.set(h.pos.x, H.sheer(H.sOf ? H.sOf(h.pos.z) : 0.5) - 0.3 + 1.0, h.pos.z);
    }
  }
  // ---------------- rotation (1 Hz): reliefs swap in during a recovery; never during a turn or hold
  rotate() {
    const p = this.p, it = this.intent;
    if (it.hold || Math.abs(it.N) > 0.3 || it.dir === 0) return;
    if (this.swaps.some((s) => this.time - s.t < 20)) return; // one handover at a time, 20 s apart
    const waiting = this.hands.filter((h) => h.state === 'waiting');
    if (!waiting.length) return;
    let worst = null, score = 0;
    for (const o of this.oars) {
      const h = o.hand; if (!h || h.state !== 'rowing') continue;
      const f = 1 - h.Wbal / p.Wp, sc = f + 0.5 * (1 - h.R);
      if (sc > score) { score = sc; worst = o; }
    }
    if (!worst) return;
    const h = worst.hand, fresh = waiting.reduce((a, b) => (b.Wbal + b.R * p.Wp > a.Wbal + a.R * p.Wp ? b : a));
    const need = h.Wbal < p.swapW * p.Wp || (fresh.R - h.R > p.swapR && h.rowTime > 600);
    if (!need || fresh.Wbal < 0.8 * p.Wp) return;
    // walk: fore group reliefs wait by the mast, aft group at the hold's after edge; slalom on the free sides
    const target = this.oars.indexOf(worst), dest = new THREE.Vector3(-worst.slot.side * 0.9, 0, worst.slot.z + 0.6);
    const dist = fresh.pos.distanceTo(dest) * 1.3;
    fresh.state = 'walking'; fresh.walk = { to: dest, oar: target, t: dist / 0.8, from: fresh.pos.clone(), T: dist / 0.8 };
    this.swaps.push({ t: this.time, oar: target, out: h.id, in: fresh.id, walk: dist / 0.8 });
  }
  updateWalkers(dt) {
    for (const h of this.hands) {
      if (h.state === 'walking') {
        h.walk.t -= dt; const k = 1 - clamp(h.walk.t / h.walk.T, 0, 1); h.pos.lerpVectors(h.walk.from, h.walk.to, k);
        if (h.walk.t <= 0) { h.state = 'ready'; }
      }
      if (h.state === 'ready') { // relief's hands go on the loom inboard of the outgoing rower's; he takes the stroke at the next catch
        const o = this.oars[h.walk.oar], old = o.hand;
        if (o.mode === 'catch' || o.mode === 'rest' || o.mode === 'ready') {
          old.state = 'handover'; h.state = 'rowing'; h.oar = h.walk.oar; o.hand = h; o.second = old; h.rowTime = 0;
          const sw = this.swaps[this.swaps.length - 1]; if (sw) sw.done = this.time;
        }
      }
      if (h.state === 'handover') { // lets go at the finish and steps out during the recovery
        const o = this.oars.find((q) => q.second === h);
        if (!o || o.mode === 'recover' || o.mode === 'rest') {
          if (o) o.second = null;
          h.state = 'leaving'; h.oar = -1; const z = o ? o.slot.z : 0, side = o ? o.slot.side : 1; const spot = z < 0 ? this.relief.fore : this.relief.aft;
          h.walk = { from: new THREE.Vector3(-side * 0.9, 0, z + 0.6), to: spot.clone(), t: 0, T: 0 };
          const d = h.walk.from.distanceTo(h.walk.to) * 1.3; h.walk.t = h.walk.T = d / 0.8; h.pos.copy(h.walk.from);
        }
      }
      if (h.state === 'leaving') { h.walk.t -= dt; const k = 1 - clamp(h.walk.t / h.walk.T, 0, 1); h.pos.lerpVectors(h.walk.from, h.walk.to, k); if (h.walk.t <= 0) h.state = 'waiting'; }
      if (h.state === 'waiting') h.fatigue(this.p, 0, dt);
    }
  }
}
// place reliefs at their waiting spots
export function placeReliefs(sys) {
  let i = 0; for (const h of sys.hands) if (h.state === 'waiting') { h.pos.copy(i++ % 2 ? sys.relief.aft : sys.relief.fore); }
}
