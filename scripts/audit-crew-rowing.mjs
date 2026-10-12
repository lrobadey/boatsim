import './register-ts.mjs';
// Behaviour audit of the merchant's agent crew (docs/merchant-crew/behaviour-audit.md).
// node scripts/audit-crew-rowing.mjs <section> [--out=dir]
// sections: calm, ablate, vary, disturb, turn, endurance, whatif
// Measurement only: water.ts parts are ablated by wrapping WaterReader methods at runtime; src/ is untouched.
// Unlike scripts/test-crew-rowing.mjs, the sea here is built at a real wind speed (Wind's constructor
// argument is a seed, not a speed) and waves.update() is called so Gerstner steepness q, and with it
// the horizontal orbital flow, is on, as in the game.
import fs from 'node:fs';
import * as THREE from 'three';
const { Crew } = await import('../src/ship/crew.ts');
const { ShipPhysics } = await import('../src/ship/physics.ts');
const { Wind } = await import('../src/world/wind.ts');
const { WaveField, createFlowSample } = await import('../src/world/waves.ts');
const { MERCHANT } = await import('../src/ship/design.ts');
const { MERCHANT_CREW } = await import('../src/ship/crew/params.ts');
const { WaterReader } = await import('../src/ship/crew/water.ts');

const dt = 1 / 120, KN = 1.943844;
const BACK = 0, STOP = 1, SLOW = 2, HALF = 3, FULL = 4;
const section = process.argv[2] ?? 'calm';
const outDir = process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? '.';
const terrain = { heightAt: () => -100, normalAt: (x, z, out) => out.set(0, 1, 0) };
const deg = (r) => (r * 180) / Math.PI;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const corr = (a, b) => { const ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db); };
const wrapPi = (a) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
const r3 = (x) => (Number.isFinite(x) ? +x.toFixed(3) : x);

// ------------------------------------------------------------------ ablation of water.ts
export const ABL = { shift: false, trim: false, chop: false, missed: false, track: false };
const REC = { shiftCalls: 0, shiftNonZero: 0, lastShift: new Map(), trims: [], chopK: [], missedTrig: 0, plans: 0 };
const WR = WaterReader.prototype, orig = { catchShift: WR.catchShift, dipTrim: WR.dipTrim, trackDepth: WR.trackDepth, chopResponse: WR.chopResponse };
WR.catchShift = function (o, body, waves, tStar, now) {
  if (ABL.shift) return 0;
  const s = orig.catchShift.call(this, o, body, waves, tStar, now);
  REC.shiftCalls++; if (s !== 0) REC.shiftNonZero++;
  REC.lastShift.set(o, s);
  return s;
};
WR.dipTrim = function (o, body, waves, now) { if (ABL.trim) return 0; const v = orig.dipTrim.call(this, o, body, waves, now); REC.trims.push(v); return v; };
WR.trackDepth = function (o, body, waves, now) { return ABL.track ? o.dip.q1 : orig.trackDepth.call(this, o, body, waves, now); };
WR.chopResponse = function (o) {
  REC.plans++;
  if (o.missed) REC.missedTrig++;
  if (ABL.missed) o.missed = false;
  const r = orig.chopResponse.call(this, o);
  REC.chopK.push((1 - r.arc) / 0.15);
  return ABL.chop ? { arc: 1, lift: 0 } : r;
};
function resetRec() { REC.shiftCalls = REC.shiftNonZero = REC.missedTrig = REC.plans = 0; REC.lastShift.clear(); REC.trims = []; REC.chopK = []; }

// ------------------------------------------------------------------ setup
/** a sea at mean wind U (m/s); returns the field and the direction the waves come from */
function sea(U, seed = 1) {
  if (!U) { const w = new WaveField(new Wind(seed)); w.waves.length = 0; return { waves: w, from: 0, hs: 0 }; }
  // meanSpeed = baseSpeed * (1 + slow(t)), so base 1 gives the slow factor and base U / (1 + slow) makes the mean speed U at t = 0.
  // (The first version of this helper used U*U/meanSpeed, which gave means of 3.0 / 8.3 / 16.3 m/s for U = 6 / 10 / 14.)
  const wind = new Wind(seed);
  wind.baseSpeed = 1; wind.update(0);
  wind.baseSpeed = U / wind.meanSpeed; wind.update(0);
  const waves = new WaveField(wind);
  waves.update(Infinity); // amplitudes at target and Gerstner steepness on, as in the game
  return { waves, from: wind.from, hs: waves.hs, q: waves.waves[0].q };
}
function vessel(water, heading = 0, over = {}) {
  const design = { ...MERCHANT, oars: { ...MERCHANT.oars, crew: { ...MERCHANT_CREW, ...over } } };
  const crew = new Crew(), ship = new ShipPhysics(water, { vx: 0, vz: 0 }, terrain, crew, design);
  ship.place(0, 0, heading);
  for (let i = 0; i < 240; i++) ship.step(dt);
  ship.vel.set(0, 0, 0); ship.angVel.set(0, 0, 0);
  return ship;
}

/**
 * Instrumented run. Records per-stroke data for every oar and drive-phase water contact.
 * opts: seconds, order, from (s, start of the stats window), autopilot heading (or null), onStep(t, ship)
 */
function run(ship, { seconds, order = FULL, from = 60, hold = null, onStep } = {}) {
  const s = ship.rowing, oars = s.oars, waves = ship.waves;
  ship.crew.setOrder(order);
  const st = oars.map(() => ({ prevMode: 'rest', catchT: NaN, catchTheta: 0, extractTheta: 0, peakF: 0, driveWetSum: 0, driveN: 0 }));
  const strokes = [];
  const depths = [], wetS = [], dipDev = [];
  let drive = 0, miss = 0, deep = 0;
  let speedSum = 0, ogSum = 0, n = 0, work0 = null, dist = 0, helmAbs = 0, thrust = 0, power = 0, hullP = 0;
  const workNow = () => oars.reduce((a, o) => a + o.audit.posWork + o.audit.dipPos, 0);
  const breakdown = { drive: 0, catch: 0, extract: 0, recover: 0, dip: 0, other: 0 };
  const slips = [];
  const prevC = oars.map(() => new THREE.Vector3(NaN, 0, 0));
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    const t = i * dt;
    if (hold !== null) {
      // autopilot: a helmsman holding the course with small helm (crew turning demand stays near zero)
      const err = wrapPi(ship.heading - hold), rate = -ship.angVel.y;
      ship.helm = THREE.MathUtils.clamp(-1.2 * err - 4 * rate, -0.3, 0.3);
    }
    onStep?.(t, ship);
    const preWork = oars.map((o) => o.audit.posWork);
    const preDip = oars.map((o) => o.audit.dipPos);
    ship.step(dt);
    const inWin = t >= from;
    if (inWin) {
      if (work0 === null) work0 = workNow();
      speedSum += ship.speed; n++;
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.quat);
      dist += ship.vel.dot(fwd) * dt;
      helmAbs += Math.abs(ship.helm);
      thrust += s.telemetry.oarThrust; power += s.telemetry.positivePower; hullP += s.telemetry.hullPower;
    }
    for (let k = 0; k < oars.length; k++) {
      const o = oars[k], q = st[k];
      if (inWin) {
        const dw = o.audit.posWork - preWork[k], dd = o.audit.dipPos - preDip[k];
        const m = o.mode;
        if (m === 'drive' || m === 'catch' || m === 'extract' || m === 'recover') breakdown[m] += dw; else breakdown.other += dw;
        breakdown.dip += dd;
      }
      // blade-centre slip in calm water: finite-difference speed of the blade centre (water at rest)
      const c = s.current.centerWorld, cx = c[k * 3], cy = c[k * 3 + 1], cz = c[k * 3 + 2];
      if (inWin && o.mode === 'drive' && Number.isFinite(prevC[k].x) && !waves.waves.length) {
        const span = o.plan.thetaF - o.plan.thetaC, prog = span ? (o.theta - o.plan.thetaC) / span : 0;
        if (prog > 0.35 && prog < 0.65) slips.push(Math.hypot(cx - prevC[k].x, cz - prevC[k].z) / dt);
      }
      prevC[k].set(cx, cy, cz);
      if (o.mode === 'drive') {
        q.peakF = Math.max(q.peakF, o.Fh);
        if (o.modeT > 0.12) {
          q.driveWetSum += o.wet; q.driveN++;
          if (inWin) {
            drive++; if (o.wet < 0.3) miss++;
            if (i % 4 === 0 && waves.waves.length) { const d = waves.heightAt(cx, cz, ship.time) - cy; depths.push(d); }
            wetS.push(o.wet); dipDev.push(o.dip.o[0] - o.dWet);
          }
        }
      }
      if (o.mode !== q.prevMode) {
        if (o.mode === 'catch') {
          if (Number.isFinite(q.catchT) && q.prevMode !== 'ready' && q.prevMode !== 'transfer') {
            strokes.push({ t: q.catchT, oar: k, hand: o.hand?.id, period: ship.time - q.catchT, arc: Math.abs(q.extractTheta - q.catchTheta),
              planArc: o.lastArc, u: o.plan.u, peakF: q.peakF, wet: q.driveN ? q.driveWetSum / q.driveN : 0, lastDrive: o.lastDrive,
              shift: REC.lastShift.get(o) ?? 0, dipTrim: o.dipTrim, dryLift: o.dryLift, alloc: o.alloc });
          }
          q.catchT = ship.time; q.catchTheta = o.theta; q.peakF = 0; q.driveWetSum = 0; q.driveN = 0;
          REC.lastShift.set(o, 0);
        }
        if (o.mode === 'extract') q.extractTheta = o.theta;
        q.prevMode = o.mode;
      }
    }
  }
  const W = workNow() - (work0 ?? 0);
  const v = speedSum / n;
  return {
    ship, strokes,
    kn: (speedSum / n) * KN, knOverGround: (dist / (n * dt)) * KN, missedPct: (100 * miss) / Math.max(1, drive),
    depthMean: mean(depths), depthSd: sd(depths), dipSdDeg: deg(sd(dipDev)), handleSdCm: 100 * MERCHANT_CREW.handR * Math.sin(sd(dipDev)), wetMean: mean(wetS), wetSd: sd(wetS),
    jPerM: W / Math.max(1, dist), crewW: power / n, thrustN: thrust / n, eff: Math.abs((thrust / n) * v) / (power / n), hullW: hullP / n,
    breakdown, slipMid: slips.length ? mean(slips) : NaN, helmAbs: helmAbs / n,
  };
}

/** followers' catch offsets from each of the stroke's catches (as in the rhythm test) */
function rhythm(ship, t0 = 0) {
  const log = ship.rowing.catchLog, out = [];
  const leads = log.filter((c) => c.lead && c.t >= t0);
  for (let k = 0; k < leads.length; k++) {
    const t = leads[k].t, T = k + 1 < leads.length ? leads[k + 1].t - t : 3;
    const offs = [];
    for (const c of log) if (!c.lead && c.t > t - T / 2 && c.t <= t + T / 2) offs.push({ oar: c.oar, d: c.t - t });
    if (offs.length) out.push({ t, offs, spread: sd(offs.map((x) => x.d)), range: Math.max(...offs.map((x) => x.d)) - Math.min(...offs.map((x) => x.d)) });
  }
  return out;
}

/** stroke-to-stroke variation per oar (steady strokes only) */
function variation(strokes, ship, t0) {
  const per = new Map();
  for (const s of strokes) if (s.t >= t0) { if (!per.has(s.oar)) per.set(s.oar, []); per.get(s.oar).push(s); }
  const cvP = [], sdArc = [], sdF = [], meanArc = [], meanP = [];
  for (const [, a] of per) {
    const P = a.map((x) => x.period), A = a.map((x) => deg(x.arc)), F = a.map((x) => x.peakF);
    cvP.push(sd(P) / mean(P)); sdArc.push(sd(A)); sdF.push(sd(F) / mean(F)); meanArc.push(mean(A)); meanP.push(mean(P));
  }
  const r = rhythm(ship, t0);
  // a follower's catch offset from the stroke, stroke to stroke (how much his timing moves)
  const offByOar = new Map();
  for (const x of r) for (const o of x.offs) { if (!offByOar.has(o.oar)) offByOar.set(o.oar, []); offByOar.get(o.oar).push(o.d); }
  const sdOff = [...offByOar.values()].map((v) => sd(v) * 1000);
  const shifts = strokes.filter((s) => s.t >= t0).map((s) => s.shift);
  return {
    strokes: strokes.filter((s) => s.t >= t0).length,
    periodS: r3(mean(meanP)), periodCvPct: r3(100 * mean(cvP)), arcDeg: r3(mean(meanArc)), arcSdDeg: r3(mean(sdArc)), peakForceCvPct: r3(100 * mean(sdF)),
    catchOffsetSdMs: r3(mean(sdOff)), spreadMedianMs: r3(1000 * median(r.map((x) => x.spread))), spreadP90Ms: r3(1000 * pct(r.map((x) => x.spread), 0.9)),
    rangeMedianMs: r3(1000 * median(r.map((x) => x.range))),
    shiftNonZeroPct: r3((100 * shifts.filter((x) => x !== 0).length) / Math.max(1, shifts.length)),
    dryLiftDeg: r3(deg(mean(strokes.filter((s) => s.t >= t0).map((s) => s.dryLift)))),
  };
}

const results = {};
const save = () => {
  const f = `${outDir}/audit-${section}.json`;
  fs.writeFileSync(f, JSON.stringify(results, null, 1));
  console.log('wrote', f);
};

// ------------------------------------------------------------------ sections
if (section === 'calm') {
  const { waves } = sea(0);
  for (const order of [SLOW, HALF, FULL, BACK]) {
    resetRec();
    const ship = vessel(sea(0).waves);
    let to1 = null, to2 = null, t30 = 0, t60 = 0;
    const r = run(ship, { seconds: 300, order, from: 180, onStep: (t, sh) => {
      const k = Math.abs(sh.speed * KN);
      if (to1 === null && k >= 1) to1 = t; if (to2 === null && k >= 2) to2 = t;
      if (Math.abs(t - 30) < dt / 2) t30 = sh.speed * KN; if (Math.abs(t - 60) < dt / 2) t60 = sh.speed * KN;
    } });
    const active = r.ship.rowing.oars.filter((o) => Math.abs(o.alloc) > 0.12).length;
    const st = r.strokes.filter((s) => s.t > 180);
    const L = r.ship.rowing.leader();
    const v = variation(r.strokes, r.ship, 180);
    const B = r.breakdown, Btot = B.drive + B.catch + B.extract + B.recover + B.other + B.dip;
    results[['Back', 'Up', 'Slow', 'Half', 'Full'][order]] = {
      kn: r3(r.kn), t30: r3(t30), t60: r3(t60), to1, to2, eff: r3(r.eff), crewW: r3(r.crewW), wPerHand: r3(r.crewW / active), thrustN: r3(r.thrustN),
      hullW: r3(r.hullW), jPerM: r3(r.jPerM), slipMidDrive: r3(r.slipMid), spm: r3(60 / v.periodS),
      arcDeg: v.arcDeg, planArcDeg: r3(deg(mean(st.map((s) => s.planArc)))), arcCapDeg: r3(deg(MERCHANT_CREW.arcMax)), u: r3(mean(st.map((s) => s.u))), uMax: r3(Math.max(...st.map((s) => s.u))),
      driveS: r3(mean(st.map((s) => s.lastDrive))), peakF: r3(mean(st.map((s) => s.peakF))),
      workShare: Object.fromEntries(Object.entries(B).map(([k, x]) => [k, r3(x / Btot)])),
      variation: v,
    };
    console.log(order, JSON.stringify(results[['Back', 'Up', 'Slow', 'Half', 'Full'][order]]));
  }
  save();
}

const VARIANTS = {
  all_on: {}, no_shift: { shift: true }, no_trim: { trim: true }, no_chop: { chop: true }, no_missed: { missed: true }, no_track: { track: true },
  all_off: { shift: true, trim: true, chop: true, missed: true, track: true },
  track_trim_only: { shift: true, chop: true, missed: true },
};
function setAbl(v) { for (const k of Object.keys(ABL)) ABL[k] = !!v[k]; }

if (section === 'ablate') {
  const winds = (process.argv.find((a) => a.startsWith('--winds='))?.slice(8) ?? '6,10,14').split(',').map(Number);
  const heads = (process.argv.find((a) => a.startsWith('--heads='))?.slice(8) ?? 'head,beam').split(',');
  const seeds = (process.argv.find((a) => a.startsWith('--seeds='))?.slice(8) ?? '1,2').split(',').map(Number);
  const secs = +(process.argv.find((a) => a.startsWith('--secs='))?.slice(7) ?? 300);
  const only = process.argv.find((a) => a.startsWith('--variants='))?.slice(11).split(',');
  for (const U of winds) for (const hd of heads) for (const [name, v] of Object.entries(VARIANTS)) {
    if (only && !only.includes(name)) continue;
    const acc = [];
    for (const seed of seeds) {
      setAbl(v); resetRec();
      const S = sea(U, seed), heading = S.from + (hd === 'beam' ? Math.PI / 2 : 0);
      const ship = vessel(S.waves, heading);
      const r = run(ship, { seconds: secs, order: FULL, from: 60, hold: heading });
      const vv = variation(r.strokes, r.ship, 60);
      acc.push({ hs: S.hs, kn: r.kn, og: r.knOverGround, miss: r.missedPct, dSd: r.depthSd, dMean: r.depthMean, wet: r.wetMean, jpm: r.jPerM, eff: r.eff,
        spread: vv.spreadMedianMs, cvP: vv.periodCvPct, arc: vv.arcDeg, helm: r.helmAbs, shiftPct: (100 * REC.shiftNonZero) / Math.max(1, REC.shiftCalls),
        missedTrigPct: (100 * REC.missedTrig) / Math.max(1, REC.plans), chopK: mean(REC.chopK), trimAbsDeg: deg(mean(REC.trims.map(Math.abs))) });
    }
    const m = (k) => r3(mean(acc.map((x) => x[k])));
    const key = `U${U}_${hd}_${name}`;
    results[key] = { hs: m('hs'), kn: m('kn'), knOG: m('og'), missedPct: m('miss'), depthMean: m('dMean'), depthSd: m('dSd'), wet: m('wet'), jPerM: m('jpm'), eff: m('eff'),
      spreadMs: m('spread'), periodCvPct: m('cvP'), arcDeg: m('arc'), helm: m('helm'), shiftEvalNonZeroPct: m('shiftPct'), missedTrigPct: m('missedTrigPct'), chopK: m('chopK'), trimAbsDeg: m('trimAbsDeg'),
      perSeedKn: acc.map((x) => r3(x.kn)) };
    console.log(key, JSON.stringify(results[key]));
  }
  setAbl({});
  save();
}

if (section === 'vary') {
  // stroke-to-stroke variation, calm vs rough, reading on vs off; correlation of stroke data with the water
  for (const [U, hd] of [[0, 'head'], [6, 'head'], [10, 'head'], [10, 'beam'], [14, 'head']]) for (const name of ['all_on', 'no_shift', 'all_off']) {
    if (U === 0 && name !== 'all_on') continue;
    setAbl(VARIANTS[name]); resetRec();
    const S = sea(U), heading = S.from + (hd === 'beam' ? Math.PI / 2 : 0);
    const ship = vessel(S.waves, heading);
    // per catch: the along-ship orbital flow at the hull during the following second
    const flowLog = [];
    const fs0 = createFlowSample();
    const r = run(ship, { seconds: 400, order: FULL, from: 60, hold: U ? heading : null, onStep: (t, sh) => {
      if (!U || Math.round(t / dt) % 6) return;
      const f = sh.waves.sampleFlowAt(sh.pos.x, sh.pos.y, sh.pos.z, sh.time, fs0);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(sh.quat);
      flowLog.push([sh.time, f.vx * fwd.x + f.vz * fwd.z, f.height]);
    } });
    const v = variation(r.strokes, r.ship, 60);
    // does the water explain stroke-to-stroke changes? correlate the stroke oar's per-stroke drive time and
    // period with the mean along-ship orbital flow during that drive
    let cDrive = NaN, cPeriod = NaN;
    if (U) {
      const L = r.strokes.filter((s) => s.t >= 60 && s.oar === 5);
      const fl = L.map((s) => mean(flowLog.filter(([t]) => t >= s.t && t <= s.t + s.lastDrive).map((x) => x[1])));
      cDrive = corr(L.map((s) => s.lastDrive), fl); cPeriod = corr(L.map((s) => s.period), fl);
    }
    results[`U${U}_${hd}_${name}`] = { ...v, kn: r3(r.kn), dipSdDeg: r3(r.dipSdDeg), handleSdCm: r3(r.handleSdCm), missedPct: r3(r.missedPct), corrDriveTimeVsOrbitalSurge: r3(cDrive), corrPeriodVsOrbitalSurge: r3(cPeriod) };
    console.log(`U${U}_${hd}_${name}`, JSON.stringify(results[`U${U}_${hd}_${name}`]));
  }
  setAbl({});
  save();
}

if (section === 'disturb') {
  // 1) a surge kick (a breaking crest takes 0.5 m/s off her) at Full in calm water
  // 2) a sudden helm hard over for 15 s at Full, then centred
  // 3) a rogue wave group: one 0.9 m-amplitude, 35 m wave from ahead, ramped in over 4 s and out after 12 s
  const cases = {
    kick: (t, sh) => { if (Math.abs(t - 150) < dt / 2) { const f = new THREE.Vector3(0, 0, -1).applyQuaternion(sh.quat); sh.vel.addScaledVector(f, -0.5); } },
    helm: (t, sh) => { sh.helm = t >= 150 && t < 165 ? 1 : 0; },
    wave: null,
  };
  for (const [name, fn] of Object.entries(cases)) {
    const S = sea(0), ship = vessel(S.waves);
    let onStep = fn;
    if (name === 'wave') {
      const k = (2 * Math.PI) / 35, comp = { dx: 0, dz: 1, k, omega: Math.sqrt(9.81 * k), phase: 0, amp: 0, target: 0, q: 0.5 };
      S.waves.waves.push(comp);
      onStep = (t) => { comp.amp = 0.9 * THREE.MathUtils.smoothstep(t, 146, 150) * (1 - THREE.MathUtils.smoothstep(t, 162, 166)); };
    }
    const r = run(ship, { seconds: 220, order: FULL, from: 100, onStep });
    const rh = rhythm(r.ship, 100).map((x) => ({ t: r3(x.t - 150), spreadMs: Math.round(x.spread * 1000), rangeMs: Math.round(x.range * 1000) }));
    const lead = r.strokes.filter((s) => s.oar === 5 && s.t > 120).map((s) => ({ t: r3(s.t - 150), period: r3(s.period), arcDeg: r3(deg(s.arc)), peakF: Math.round(s.peakF) }));
    results[name] = { rhythm: rh, stroke: lead };
    console.log(name, JSON.stringify(rh.filter((x) => x.t > -10 && x.t < 40)));
  }
  save();
}

if (section === 'turn') {
  // helm hard over at 2 kn (Full, calm): who eases, who backs, turn rate, speed
  for (const helm of [1, 0.5]) {
    const ship = vessel(sea(0).waves), s = ship.rowing;
    ship.crew.setOrder(FULL);
    // get to about 2 kn
    let t = 0;
    while (Math.abs(ship.speed * KN) < 2.0 && t < 200) { ship.step(dt); t += dt; }
    const h0 = ship.heading, log = [];
    for (let i = 0; i < 90 / dt; i++) {
      ship.helm = helm; ship.step(dt);
      if (i % 120 === 0) log.push({ t: i * dt, kn: r3(ship.speed * KN), turned: r3(deg(wrapPi(ship.heading - h0))), rate: r3(deg(-ship.angVel.y)),
        N: r3(s.intent.N), X: r3(s.intent.X), alloc: s.oars.map((o) => r3(o.alloc)), modes: s.oars.map((o) => o.mode[0] + (o.dir > 0 ? '+' : '')) });
    }
    let unwrap = 0, prev = h0;
    results[`helm${helm}`] = { startKn: r3(ship.speed), log };
    console.log('helm', helm); for (const l of log.filter((_, i) => i % 5 === 0)) console.log(JSON.stringify(l));
  }
  save();
}

if (section === 'endurance') {
  for (const rotation of [true, false]) {
    const ship = vessel(sea(0).waves, 0, { rotation }), s = ship.rowing;
    const bins = [];
    let sum = 0, n = 0, Ssum = 0;
    run(ship, { seconds: 3600, order: FULL, from: 0, onStep: (t, sh) => {
      sum += sh.speed; n++;
      if (Math.round(t / dt) % 120 === 0) Ssum += mean(s.oars.map((o) => o.hand.S(s.p)));
      if (n === 300 * 120) { bins.push({ min: Math.round(t / 60), kn: r3((sum / n) * KN), S: r3(Ssum / 300), stamina: r3(sh.crew.stamina) }); sum = 0; n = 0; Ssum = 0; }
    } });
    const rh = rhythm(ship, 60);
    const spreadByBin = [];
    for (let m = 0; m < 60; m += 10) spreadByBin.push(Math.round(1000 * median(rh.filter((x) => x.t >= m * 60 && x.t < (m + 10) * 60).map((x) => x.spread))));
    results[rotation ? 'rotation' : 'noRotation'] = { bins, swaps: s.rotation.swaps.length, swapTimes: s.rotation.swaps.map((w) => Math.round(w.t)), spreadMsPer10min: spreadByBin };
    console.log(rotation, JSON.stringify(results[rotation ? 'rotation' : 'noRotation']));
  }
  save();
}

if (section === 'whatif') {
  // calm Full with parameter overrides (params only; no src change) to see what is left on the table
  const cases = {
    base: {},
    taperOff: { taperTo: 1 },
    taperLight: { taperTo: 0.6, taperFrac: 0.2 },
    rate20: { orders: MERCHANT_CREW.orders.map((o, i) => (i === 4 ? { ...o, rate: 20 } : o)) },
    rate16: { orders: MERCHANT_CREW.orders.map((o, i) => (i === 4 ? { ...o, rate: 16 } : o)) },
    driveFrac40: { driveFrac: 0.4 },
    blade125: { bladeWidth: 0.25 },
    noCatchMatch: { catchMatch: false },
    lightOar: { Ioar: 55 },
  };
  for (const [name, over] of Object.entries(cases)) {
    const ship = vessel(sea(0).waves, 0, over);
    let to1 = null;
    const r = run(ship, { seconds: 300, order: FULL, from: 180, onStep: (t, sh) => { if (to1 === null && sh.speed * KN >= 1) to1 = t; } });
    const v = variation(r.strokes, r.ship, 180);
    const B = r.breakdown, Btot = B.drive + B.catch + B.extract + B.recover + B.other + B.dip;
    results[name] = { kn: r3(r.kn), to1, eff: r3(r.eff), crewW: r3(r.crewW), jPerM: r3(r.jPerM), spm: r3(60 / v.periodS), arcDeg: v.arcDeg,
      recoverShare: r3(B.recover / Btot), dipShare: r3(B.dip / Btot), slip: r3(r.slipMid) };
    console.log(name, JSON.stringify(results[name]));
  }
  save();
}
