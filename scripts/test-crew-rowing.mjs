import './register-ts.mjs';
// Acceptance tests for the merchant's agent crew (docs/merchant-crew-spec.md §12.1, §12.2).
// node scripts/test-crew-rowing.mjs [--test=<name part>] [--quick]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
const { Crew } = await import('../src/ship/crew.ts');
const { ShipPhysics } = await import('../src/ship/physics.ts');
const { Wind } = await import('../src/world/wind.ts');
const { WaveField } = await import('../src/world/waves.ts');
const { MERCHANT } = await import('../src/ship/design.ts');
const { MERCHANT_CREW } = await import('../src/ship/crew/params.ts');
const { CrewRowing } = await import('../src/ship/crew/crewRowing.ts');
const { stanceXZ } = await import('../src/ship/crew/stance.ts');

const dt = 1 / 120, KN = 1.943844, L = MERCHANT.hull.length;
const BACK = 0, STOP = 1, SLOW = 2, HALF = 3, FULL = 4;
const quick = process.argv.includes('--quick');
const filter = process.argv.find((a) => a.startsWith('--test='))?.slice(7);
const report = { tests: [], measured: {} };
let failures = 0;
function test(name, fn) {
  if (filter && !name.includes(filter)) return;
  const t0 = performance.now();
  try { fn(); report.tests.push({ name, status: 'passed', ms: Math.round(performance.now() - t0) }); console.log('PASS', name); }
  catch (e) { failures++; report.tests.push({ name, status: 'failed', error: e.message }); console.error('FAIL', name, '\n  ', e.message); }
}
const flat = () => { const w = new WaveField(new Wind(0)); w.waves.length = 0; return w; };
/**
 * A sea at mean wind U m/s (at t = 0). Wind's constructor argument is a seed, not a speed, so the base
 * speed is set so meanSpeed is U. The returned wind and waves are stepped by run({ sea }) as the game
 * does, so the horizontal orbital flow (Gerstner steepness) is on.
 */
function seaAt(U, seed = 1) {
  const wind = new Wind(seed);
  wind.baseSpeed = 1; wind.update(0);
  wind.baseSpeed = U / wind.meanSpeed; wind.update(0);
  const waves = new WaveField(wind);
  waves.update(Infinity);
  return { wind, waves };
}
function single(amp = 0.5, q = 0.4, phase = 0.3, dir = 1) {
  const w = flat();
  w.waves.push({ dx: 0, dz: dir, k: (2 * Math.PI) / 11, omega: Math.sqrt((9.81 * 2 * Math.PI) / 11), phase, amp, target: amp, q });
  return w;
}
const terrain = { heightAt: () => -100, normalAt: (x, z, out) => out.set(0, 1, 0) };
/** a merchant with optional crew parameter overrides, settled at rest */
function vessel({ water = flat(), crew: over = {}, h = dt } = {}) {
  const design = { ...MERCHANT, oars: { ...MERCHANT.oars, crew: { ...MERCHANT_CREW, ...over } } };
  const crew = new Crew(), ship = new ShipPhysics(water, { vx: 0, vz: 0 }, terrain, crew, design);
  ship.place(0, 0, 0);
  for (let i = 0; i < Math.round(2 / h); i++) ship.step(h);
  ship.vel.set(0, 0, 0); ship.angVel.set(0, 0, 0);
  return ship;
}
/** run for `seconds`, calling onStep(t, ship) before each step; returns mean speed (kn) over the last `tail` s */
function run(ship, seconds, { h = dt, onStep, tail = 60, sea = null } = {}) {
  const n = Math.round(seconds / h);
  let sum = 0, m = 0, untilRetarget = 0;
  for (let i = 0; i < n; i++) {
    onStep?.(i * h, ship);
    if (sea) {
      // the game's order each step: wind, sea target at 1 Hz, sea amplitudes
      sea.wind.update(h);
      if ((untilRetarget -= h) <= 0) { sea.waves.retarget(sea.wind); untilRetarget = 1; }
      sea.waves.update(h);
    }
    ship.step(h);
    if (i >= n - Math.round(tail / h)) { sum += ship.speed; m++; }
  }
  return (sum / m) * KN;
}
const sys = (ship) => ship.rowing;
const deg = (r) => (r * 180) / Math.PI;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const sd = (a) => { const mu = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - mu) ** 2, 0) / a.length); };

// ------------------------------------------------------------------ §12.1 physics

test('seam: the merchant builds the crew system with six sweeps and eight hands', () => {
  const ship = vessel();
  assert.ok(sys(ship) instanceof CrewRowing);
  assert.equal(sys(ship).slots.length, 6);
  assert.equal(sys(ship).hands.length, 8);
  assert.deepEqual(sys(ship).slots.map((s) => s.side), [-1, 1, -1, 1, -1, 1]);
  assert.equal(ship.crew.maxOrder, 4);
});

const orderRuns = {};
function orderRun(order) {
  if (orderRuns[order]) return orderRuns[order];
  const ship = vessel();
  ship.crew.setOrder(order);
  let t30 = 0, t60 = 0, to1 = null, thrust = 0, power = 0, n = 0, minDiss = Infinity;
  const seconds = 240;
  const v = run(ship, seconds, { onStep: (t, s) => {
    const k = Math.abs(s.speed * KN);
    if (Math.abs(t - 30) < dt / 2) t30 = s.speed * KN;
    if (Math.abs(t - 60) < dt / 2) t60 = s.speed * KN;
    if (to1 === null && k >= 1) to1 = t;
    const tl = sys(s).telemetry;
    minDiss = Math.min(minDiss, tl.dissipatedPower);
    if (t >= seconds - 60) { thrust += tl.oarThrust; power += tl.positivePower; n++; }
  } });
  const r = { ship, kn: v, t30, t60, to1, thrust: thrust / n, power: power / n, eff: Math.abs((thrust / n) * (v / KN)) / (power / n), minDiss, rate: ship.crew.rate };
  report.measured[`order${order}`] = { kn: v, t30, t60, to1, thrustN: r.thrust, crewW: r.power, efficiency: r.eff, spm: r.rate };
  return (orderRuns[order] = r);
}

test('energy audit closes per oar at every order; patch power identity holds in calm water', () => {
  for (const order of [BACK, SLOW, HALF, FULL]) {
    const { ship } = orderRun(order);
    for (const o of sys(ship).oars) {
      const a = o.audit, KE = 0.5 * o.Ieff * o.omega * o.omega;
      const balance = a.posWork - a.negWork + a.waterWork - KE - a.numLoss - a.shedKE - a.pickupLoss;
      assert.ok(Math.abs(balance) <= 1e-3 * Math.max(1, a.posWork), `order ${order} oar ${o.slot.id}: oar balance ${balance} J of ${a.posWork} J`);
      const identity = a.hullWork + a.waterWork + a.dipWork + a.slipLoss;
      assert.ok(Math.abs(identity) <= 1e-6 * Math.max(1, a.slipLoss) + 1e-6, `order ${order} oar ${o.slot.id}: patch identity ${identity}`);
    }
  }
});

test('no hidden clipping: no force scaling in the crew code, cap fractions stay zero', () => {
  for (const f of fs.readdirSync('src/ship/crew')) {
    const src = fs.readFileSync(`src/ship/crew/${f}`, 'utf8');
    assert.ok(!/multiplyScalar\(\s*scale/.test(src) && !/Math\.random/.test(src), `${f}: force scaling or Math.random`);
  }
  const { ship } = orderRun(FULL);
  assert.equal(sys(ship).telemetry.forceCapFraction, 0);
  assert.equal(sys(ship).telemetry.powerCapFraction, 0);
});

test('passivity: blades only ever dissipate; a held blade at rest does no rower work', () => {
  for (const order of [BACK, SLOW, HALF, FULL]) assert.ok(orderRun(order).minDiss >= -1e-9, `order ${order}: slip power ${orderRun(order).minDiss}`);
  const ship = vessel();
  ship.crew.holdWater = true;
  run(ship, 10);
  const before = sys(ship).oars.map((o) => o.audit.posWork);
  run(ship, 5);
  sys(ship).oars.forEach((o, i) => assert.ok((o.audit.posWork - before[i]) / 5 < 1, `oar ${i}: ${(o.audit.posWork - before[i]) / 5} W holding at rest`));
});

test('continuity over 10 minutes of mixed orders, helm, hold and shipping', () => {
  const ship = vessel(), s = sys(ship), n = s.oars.length;
  const prevW = new Float64Array(n), prevDipV = new Float64Array(n), prevFeV = new Float64Array(n);
  let maxAcc = 0, maxDipJump = 0, maxFeJump = 0, thMin = Infinity, thMax = -Infinity, maxArc = 0;
  const strokeMin = new Float64Array(n).fill(Infinity), strokeMax = new Float64Array(n).fill(-Infinity);
  const seconds = quick ? 180 : 600;
  run(ship, seconds, { onStep: (t) => {
    const seg = Math.floor(t / 20) % 9;
    ship.crew.setOrder([FULL, HALF, FULL, BACK, SLOW, FULL, STOP, FULL, HALF][seg]);
    ship.crew.holdWater = seg === 5 && t % 20 > 12;
    ship.helm = seg === 2 ? Math.sin(t * 0.3) : seg === 7 ? 1 : 0;
    s.setShipped(-1, seg === 6 && t % 20 > 5);
    for (const o of s.oars) {
      const i = o.slot.id;
      if (t > 0) {
        maxAcc = Math.max(maxAcc, Math.abs(o.omega - prevW[i]) / dt);
        maxDipJump = Math.max(maxDipJump, Math.abs(o.dip.o[1] - prevDipV[i]));
        maxFeJump = Math.max(maxFeJump, Math.abs(o.feather.o[1] - prevFeV[i]));
      }
      prevW[i] = o.omega; prevDipV[i] = o.dip.o[1]; prevFeV[i] = o.feather.o[1];
      const shipping = o.mode === 'shipped' || o.shipped || (o.mode === 'transfer' && (o.next === 'shipped' || Math.abs(o.ref.q0) > 0.6));
      if (!shipping) { thMin = Math.min(thMin, o.theta); thMax = Math.max(thMax, o.theta); }
      if (o.mode === 'drive' || o.mode === 'catch') { strokeMin[i] = Math.min(strokeMin[i], o.theta); strokeMax[i] = Math.max(strokeMax[i], o.theta); }
      else if (Number.isFinite(strokeMin[i])) { maxArc = Math.max(maxArc, strokeMax[i] - strokeMin[i]); strokeMin[i] = Infinity; strokeMax[i] = -Infinity; }
    }
  } });
  report.measured.continuity = { maxAcc, maxDipJump, maxFeJump, thMin, thMax, maxArcDeg: deg(maxArc) };
  assert.ok(maxAcc < 400, `sweep acceleration ${maxAcc} rad/s2`);
  assert.ok(maxDipJump < 2000 * dt && maxFeJump < 2000 * dt, `dip/feather velocity jumps ${maxDipJump} / ${maxFeJump} rad/s per step`);
  assert.ok(thMin >= -0.47 && thMax <= 0.5, `sweep range [${thMin}, ${thMax}]`);
  assert.ok(maxArc <= 0.83 + 0.02, `stroke arc ${deg(maxArc)} deg`);
  for (const o of s.oars) for (const v of [o.theta, o.omega, o.dip.o[0], o.feather.o[0]]) assert.ok(Number.isFinite(v));
});

test('timestep independence: Full and Half steady within 0.5 %, speed at 60 s within 0.02 kn', () => {
  const res = {};
  for (const order of [HALF, FULL]) {
    res[order] = [];
    for (const h of [1 / 60, 1 / 120, 1 / 240]) {
      const ship = vessel({ h });
      ship.crew.setOrder(order);
      let k60 = 0;
      const kn = run(ship, 240, { h, onStep: (t, s) => { if (Math.abs(t - 60) < h / 2) k60 = s.speed * KN; } });
      res[order].push({ h, kn, k60 });
    }
    const ks = res[order].map((r) => r.kn), k60s = res[order].map((r) => r.k60);
    assert.ok((Math.max(...ks) - Math.min(...ks)) / Math.max(...ks) <= 0.005, `order ${order} steady ${ks.map((k) => k.toFixed(3))}`);
    assert.ok(Math.max(...k60s) - Math.min(...k60s) <= 0.02, `order ${order} at 60 s ${k60s.map((k) => k.toFixed(3))}`);
  }
  report.measured.timestep = res;
});

test('speed bands and acceleration (calm, 240 s)', () => {
  const bands = { [SLOW]: [0.9, 1.2], [HALF]: [2.0, 2.3], [FULL]: [2.3, 2.6], [BACK]: [-2.2, -1.8] };
  for (const [order, [lo, hi]] of Object.entries(bands)) {
    const r = orderRun(+order);
    assert.ok(r.kn >= lo && r.kn <= hi, `order ${order}: ${r.kn.toFixed(2)} kn not in [${lo}, ${hi}]`);
  }
  const f = orderRun(FULL);
  assert.ok(f.t30 >= 1.0 && f.t60 >= 1.6 && f.to1 <= 30, `Full: ${f.t30.toFixed(2)} kn at 30 s, ${f.t60.toFixed(2)} at 60 s, 1 kn at ${f.to1?.toFixed(1)} s`);
});

test('propulsive efficiency at Full and Half is at least 0.35', () => {
  for (const order of [HALF, FULL]) assert.ok(orderRun(order).eff >= 0.35, `order ${order}: ${orderRun(order).eff.toFixed(3)}`);
});

test('hold water stops her from 2 kn within 5 lengths, inside the hold capacity', () => {
  const ship = vessel(), s = sys(ship), p = s.p;
  ship.vel.set(0, 0, -2 / KN);
  ship.crew.holdWater = true;
  const z0 = ship.pos.z;
  let dist = null, peak = 0;
  run(ship, 200, { onStep: (t, sh) => {
    for (const o of s.oars) peak = Math.max(peak, o.Fh / Math.max(1e-6, o.hand.S(p) * p.holdF * p.uHold * p.F0));
    if (dist === null && t > 1 && Math.abs(sh.speed) < 0.2) dist = Math.abs(sh.pos.z - z0);
  } });
  report.measured.holdStop = { dist, lengths: dist / L, peakOfCapacity: peak };
  assert.ok(dist !== null && dist <= 5 * L, `stopped in ${dist} m (${(dist / L).toFixed(2)} lengths)`);
  assert.ok(peak <= 1 + 1e-6, `handle force reached ${peak.toFixed(3)} of hold capacity`);
});

test('payload: nine people sink her about 1.7 cm, cost under 1 % at Full, and walking trims her smoothly', () => {
  const settle = (over) => { const sh = vessel({ crew: over }); run(sh, 20, { tail: 5 }); return sh.pos.y; };
  const sink = (settle({ payload: false }) - settle({})) * 100;
  const without = (() => { const sh = vessel({ crew: { payload: false } }); sh.crew.setOrder(FULL); return run(sh, 240); })();
  const withCrew = orderRun(FULL).kn;
  report.measured.payload = { sinkCm: sink, fullWith: withCrew, fullWithout: without };
  assert.ok(Math.abs(sink - 1.7) <= 0.3, `sinkage ${sink.toFixed(2)} cm`);
  assert.ok(Math.abs(withCrew - without) / without < 0.01, `Full ${withCrew.toFixed(3)} vs ${without.toFixed(3)} kn`);
  // a relief walking forward: trim changes smoothly
  const ship = vessel(), s = sys(ship), relief = s.hands[7];
  relief.state = 'walking';
  relief.walk = { from: relief.pos.clone(), to: new THREE.Vector3(0.5, 0, relief.pos.z - 6), t: 7.5, T: 7.5, oar: 0 };
  let prev = ship.pitch, maxStep = 0;
  run(ship, 10, { onStep: () => { maxStep = Math.max(maxStep, Math.abs(ship.pitch - prev)); prev = ship.pitch; } });
  assert.ok(deg(maxStep) < 0.01, `trim step ${deg(maxStep)} deg`);
});

test('waves: a single 0.5 m swell with orders cycled stays finite and physical', () => {
  const ship = vessel({ water: single() }), s = sys(ship), area = s.p.bladeLength * s.p.bladeWidth;
  const overflow0 = s.events.overflows;
  run(ship, quick ? 60 : 180, { onStep: (t) => {
    ship.crew.setOrder([FULL, BACK, HALF, STOP, FULL][Math.floor(t / 12) % 5]);
    ship.crew.holdWater = Math.floor(t / 12) % 5 === 3 && t % 12 > 6;
    for (const o of s.oars) {
      const i = o.slot.id;
      assert.ok(Number.isFinite(o.theta) && Number.isFinite(o.omega) && Number.isFinite(s.current.forceWorld[i * 3]));
      assert.ok(s.current.wetArea[i] <= area + 1e-9);
      if (s.current.wetArea[i] === 0) assert.equal(s.current.forceWorld[i * 3] ** 2 + s.current.forceWorld[i * 3 + 1] ** 2 + s.current.forceWorld[i * 3 + 2] ** 2, 0);
    }
  } });
  assert.equal(s.events.overflows, overflow0);
});

test('determinism: two identical runs are bit-identical', () => {
  const go = () => {
    const ship = vessel({ water: single() });
    run(ship, 60, { onStep: (t) => { ship.crew.setOrder(t < 30 ? FULL : HALF); ship.helm = t > 40 ? 0.7 : 0; } });
    return { pos: ship.pos.toArray(), q: ship.quat.toArray(), joints: Array.from(sys(ship).current.joint), catches: sys(ship).catchLog.map((c) => `${c.t}:${c.oar}`) };
  };
  assert.deepEqual(go(), go());
});

test('CPU: crew propulsion costs at most 0.1 ms per physics step', () => {
  const ship = vessel(), s = sys(ship), step = s.step.bind(s);
  let total = 0, n = 0;
  s.step = (...args) => { const t0 = performance.now(); step(...args); total += performance.now() - t0; n++; };
  ship.crew.setOrder(FULL);
  run(ship, 60);
  report.measured.cpuMsPerStep = total / n;
  assert.ok(total / n <= 0.1, `${(total / n).toFixed(4)} ms per step`);
});

// ------------------------------------------------------------------ §12.2 crew

/** offsets (s) of the followers' catches from each of the stroke's catches */
function rhythm(ship) {
  const log = sys(ship).catchLog, out = [];
  const leads = log.filter((c) => c.lead);
  for (let k = 0; k < leads.length; k++) {
    const t = leads[k].t, T = k + 1 < leads.length ? leads[k + 1].t - t : 3;
    const offs = [];
    for (const c of log) if (!c.lead && c.t > t - T / 2 && c.t <= t + T / 2) offs.push(c.t - t);
    if (offs.length) out.push({ k, t, offs, spread: sd(offs), mean: offs.reduce((a, b) => a + b, 0) / offs.length });
  }
  return out;
}

test('rhythm: a ragged start settles, holds, and falls apart without coupling', () => {
  const ship = vessel();
  ship.crew.setOrder(FULL);
  run(ship, 130);
  const r = rhythm(ship);
  report.measured.rhythm = r.slice(0, 40).map((x) => ({ k: x.k, t: +x.t.toFixed(2), meanMs: Math.round(x.mean * 1000), spreadMs: Math.round(x.spread * 1000) }));
  const s5 = r.find((x) => x.k === 5);
  assert.ok(s5 && s5.spread <= 0.06, `spread at stroke 5: ${s5 && Math.round(s5.spread * 1000)} ms`);
  const mid = r.filter((x) => x.k >= 10 && x.k <= 35).map((x) => x.spread);
  assert.ok(mid.length >= 20 && median(mid) <= 0.035, `median spread strokes 10-35: ${Math.round(median(mid) * 1000)} ms`);
  // first catches lag the stroke's by each follower's reaction time
  const s = sys(ship), first = r[0];
  for (const c of s.catchLog.filter((c) => !c.lead && c.t < first.t + 1.5)) {
    const lag = c.t - first.t, reaction = s.hands[c.hand].reaction;
    assert.ok(Math.abs(lag - reaction) <= 0.02 + dt, `hand ${c.hand}: first lag ${lag.toFixed(3)} s vs reaction ${reaction.toFixed(3)} s`);
  }
  const loose = vessel({ crew: { K: 0, Klead: 0 } });
  loose.crew.setOrder(FULL);
  run(loose, 90);
  const lr = rhythm(loose).find((x) => x.k === 15);
  report.measured.rhythmUncoupled15 = lr && Math.round(lr.spread * 1000);
  assert.ok(lr && lr.spread > 0.3, `uncoupled spread at stroke 15: ${lr && Math.round(lr.spread * 1000)} ms`);
});

test('startup: short heavy strokes that lengthen as she gathers way', () => {
  const ship = vessel(), s = sys(ship);
  ship.crew.setOrder(FULL);
  // the opening stroke uses the starting arc before the rower has felt the water; from then on each
  // stroke's arc is planned at the previous finish from the felt drive time (recorded at its catch,
  // with the peak handle force of the stroke just finished, as in the prototype)
  const arcs = [], peaks = [];
  let lastStrokes = 0, peak = 0;
  run(ship, 90, { onStep: () => {
    const o = s.leader();
    if (!o) return;
    peak = Math.max(peak, o.Fh * (o.mode === 'drive' ? 1 : 0));
    if (o.strokes !== lastStrokes && o.mode === 'catch') {
      if (lastStrokes > 0) { arcs.push(deg(o.plan.arc)); peaks.push(peak); }
      peak = 0; lastStrokes = o.strokes;
    }
  } });
  report.measured.startup = arcs.slice(0, 18).map((a, i) => ({ stroke: i + 1, arcDeg: +a.toFixed(1), peakN: Math.round(peaks[i]) }));
  assert.ok(arcs[0] <= 30, `first arc ${arcs[0].toFixed(1)} deg`);
  for (let i = 1; i < 17; i++) assert.ok(arcs[i] >= arcs[i - 1] - 2, `arc shrank at stroke ${i + 1}: ${arcs[i - 1].toFixed(1)} -> ${arcs[i].toFixed(1)}`);
  // the arc plateaus with about ±1 deg of stroke-to-stroke jitter, so gate on a five-stroke mean
  const plateau = arcs.slice(14, 19).reduce((x, y) => x + y, 0) / 5;
  assert.ok(plateau >= 37, `mean arc over strokes 15-19: ${plateau.toFixed(1)} deg`);
  const strokePeaks = peaks.slice(0, 17), best = strokePeaks.indexOf(Math.max(...strokePeaks)) + 1;
  assert.ok(best >= 3 && best <= 6, `peak handle force at stroke ${best}`);
});

test('turning: a pivot from rest, crew assist underway, no rowing on Oars Up', () => {
  const pivot = vessel();
  pivot.crew.setOrder(FULL); pivot.helm = 1;
  const h0 = pivot.heading;
  let maxV = 0;
  run(pivot, 60, { onStep: (t, s) => { if (t > 10) maxV = Math.max(maxV, Math.abs(s.speed * KN)); } });
  const turned = Math.abs(deg(pivot.heading - h0));
  report.measured.pivot60 = { turnedDeg: turned, maxKn: maxV };
  assert.ok(turned >= 70 && maxV < 0.5, `pivot: ${turned.toFixed(0)} deg in 60 s at up to ${maxV.toFixed(2)} kn`);
  const yawRate = (over) => {
    const ship = vessel({ crew: over });
    ship.crew.setOrder(FULL);
    run(ship, 120);
    ship.helm = 1;
    let sum = 0, n = 0;
    run(ship, 60, { onStep: (t, s) => { if (t > 30) { sum += Math.abs(s.angVel.y); n++; } } });
    return deg(sum / n);
  };
  const assist = yawRate({}), rudder = yawRate({ allocation: false });
  report.measured.turnRate = { assistDegS: assist, rudderOnlyDegS: rudder };
  assert.ok(assist >= 1.5 * rudder, `crew assist ${assist.toFixed(2)} deg/s vs rudder only ${rudder.toFixed(2)}`);
  const idle = vessel();
  idle.crew.setOrder(STOP); idle.helm = 1;
  run(idle, 20);
  assert.ok(sys(idle).oars.every((o) => o.mode === 'rest') && sys(idle).telemetry.oarThrust === 0);
});

test('turning at 2 kn: hard over turns at least 1.3 deg/s on average over 60 s (the inner side backs once she is slow)', () => {
  const ship = vessel();
  ship.crew.setOrder(FULL);
  let t = 0;
  while (Math.abs(ship.speed * KN) < 2 && t < 200) { ship.step(dt); t += dt; }
  ship.helm = 1;
  let sum = 0, n = 0;
  run(ship, 60, { onStep: (_, s) => { sum += Math.abs(s.angVel.y); n++; } });
  const rate = deg(sum / n);
  report.measured.turn2kn = { rateDegS: +rate.toFixed(3), kn: +(ship.speed * KN).toFixed(3), reachedAt: +t.toFixed(1) };
  assert.ok(rate >= 1.3, `hard over at ${(ship.speed * KN).toFixed(2)} kn turns ${rate.toFixed(2)} deg/s`);
});

test('watches: Slow mans one oar per side and keeps the same men on', () => {
  const ship = vessel(), s = sys(ship);
  ship.crew.setOrder(SLOW);
  let sets = new Set();
  run(ship, 120, { onStep: (t) => {
    if (t < 10) return;
    const on = s.oars.filter((o) => Math.abs(o.alloc) > 0.12);
    assert.equal(on.length, 2, `${on.length} oars manned at ${t.toFixed(1)} s`);
    assert.deepEqual(on.map((o) => o.slot.side).sort(), [-1, 1]);
    sets.add(on.map((o) => o.hand.id).join(','));
  } });
  assert.equal(sets.size, 1, `watch changed: ${[...sets].join(' | ')}`);
});

test('rotation: reliefs swap in at Full over an hour without leaving an oar empty', () => {
  const ship = vessel(), s = sys(ship);
  ship.crew.setOrder(FULL);
  const speeds = [];
  run(ship, quick ? 1800 : 3600, { tail: 1, onStep: (t, sh) => {
    if (Math.round(t / dt) % 60 === 0) speeds.push([t, sh.speed]);
    for (const o of s.oars) assert.ok(o.hand, `oar ${o.slot.id} without hands at ${t.toFixed(1)} s`);
  } });
  const swaps = s.rotation.swaps;
  report.measured.rotation = { swaps: swaps.length, list: swaps.slice(0, 10).map((w) => ({ t: Math.round(w.t), oar: w.oar, out: w.out, in: w.in, walk: +w.walk.toFixed(1) })) };
  assert.ok(swaps.length >= 1, 'no swap in an hour at Full');
  for (let i = 1; i < swaps.length; i++) assert.ok(swaps[i].t - swaps[i - 1].t >= 20, 'two handovers within 20 s');
  const mean = (a, b) => { const v = speeds.filter(([t]) => t >= a && t < b).map(([, x]) => x); return v.reduce((x, y) => x + y, 0) / v.length; };
  for (const w of swaps.filter((w) => w.done !== undefined)) {
    const before = mean(w.done - 20, w.done - 5), during = mean(w.done, w.done + 10);
    assert.ok(during >= 0.99 * before, `handover at ${w.done.toFixed(0)} s: ${(during * KN).toFixed(3)} vs ${(before * KN).toFixed(3)} kn`);
  }
});

test('reading the water: fewer missed drives in a real sea, and no speed lost (relative: reading on vs off)', () => {
  // relative gate: absolute speed in waves is dominated by hull drag in waves (audit §1), so only the
  // reading on vs off is compared, on seas built at U = 6 and 10 m/s with the sea stepped as in the game
  const res = {};
  for (const U of [6, 10]) for (const waterRead of [false, true]) {
    const sea = seaAt(U, 1);
    const ship = vessel({ water: sea.waves, crew: { waterRead } });
    ship.crew.setOrder(FULL);
    let drive = 0, miss = 0;
    const kn = run(ship, quick ? 150 : 300, { tail: 120, sea, onStep: (t) => {
      if (t < 60) return;
      for (const o of sys(ship).oars) if (o.mode === 'drive' && o.modeT > 0.12) { drive++; if (o.wet < 0.3) miss++; }
    } });
    res[`U${U}_${waterRead ? 'reading' : 'off'}`] = { kn: +kn.toFixed(3), hs: +sea.waves.hs.toFixed(2), missedPct: +((miss / drive) * 100).toFixed(2) };
  }
  report.measured.waterRead = res;
  for (const U of [6, 10]) {
    const off = res[`U${U}_off`], on = res[`U${U}_reading`];
    assert.ok(on.missedPct < off.missedPct, `U ${U}: missed ${on.missedPct} % reading vs ${off.missedPct} % off`);
    assert.ok(on.kn >= 0.98 * off.kn, `U ${U}: ${on.kn} kn reading vs ${off.kn} kn off`);
  }
});

// ------------------------------------------------------------------ §9.6 animator contract

test('animator view: eight members, valid modes, walks on deck and clear of manned stances, relief swap seen', () => {
  const ship = vessel(), s = sys(ship), hull = MERCHANT.hull;
  ship.crew.setOrder(FULL);
  const MODES = new Set(['row', 'hold', 'shipped', 'walk', 'stepIn', 'stepOut', 'idle', 'rest']);
  const seen = new Set();
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  let minClear = Infinity, walkSamples = 0, worstHalf = -Infinity;
  const sxz = { x: 0, z: 0 };
  // handovers (§6.2): a relief's hands go on the loom before his first drive; the facing turns at most 3 rad/s
  const yawLimit = 3 * dt + 1e-9, stepping = new Set(), gripOn = new Set();
  let maxYawStep = 0, yawPairs = 0, secondSeen = 0, reliefDrives = 0;
  for (let i = 0; i < Math.round((quick ? 1800 : 3600) / dt); i++) {
    ship.step(dt);
    const view = s.crewView, prevView = s.crewViewPrev;
    assert.equal(view.length, 8, 'eight members');
    assert.equal(prevView.length, 8, 'eight previous members');
    const manned = s.oars.filter((o) => o.hand && o.hand.state === 'rowing' && !o.shipped);
    const primaries = new Array(s.oars.length).fill(0);
    for (const v of view) {
      if (v.role === 'primary' && v.oar >= 0) primaries[v.oar]++;
      if (v.role === 'second' && ['row', 'hold', 'shipped'].includes(v.mode)) secondSeen++;
      if (v.mode === 'stepIn') {
        if (!stepping.has(v.id)) { stepping.add(v.id); gripOn.delete(v.id); }
        if (v.handsOn === 1) gripOn.add(v.id);
      }
      if (v.mode === 'row' && v.driving && stepping.has(v.id)) {
        assert.ok(gripOn.has(v.id), `relief ${v.id} drove before his hands were on the loom`);
        stepping.delete(v.id); reliefDrives++;
      }
      const pv = prevView[v.id];
      if (v.walk && pv.walk) {
        const d = Math.atan2(Math.sin(v.walk.yaw - pv.walk.yaw), Math.cos(v.walk.yaw - pv.walk.yaw));
        maxYawStep = Math.max(maxYawStep, Math.abs(d)); yawPairs++;
        assert.ok(Math.abs(d) <= yawLimit, `member ${v.id}: facing turned ${deg(d).toFixed(2)} deg in one step`);
      }
    }
    for (const o of manned) assert.equal(primaries[o.slot.id], 1, `oar ${o.slot.id}: ${primaries[o.slot.id]} primary members, want 1`);
    for (const v of view) {
      assert.ok(v.role === 'primary' || v.role === 'second', `member ${v.id}: role ${v.role}`);
      seen.add(v.mode);
      assert.ok(MODES.has(v.mode), `member ${v.id}: mode ${v.mode}`);
      assert.ok(v.fatigue >= 0 && v.fatigue <= 1 && v.strokePhase >= 0 && v.strokePhase < 1, `member ${v.id}: fatigue or phase out of range`);
      if (['row', 'hold', 'shipped'].includes(v.mode)) assert.ok(v.oar >= 0, `member ${v.id}: ${v.mode} without an oar`);
      if (v.mode === 'row' || v.mode === 'hold') assert.ok(v.effort >= 0 && v.effort <= 1, `member ${v.id}: effort ${v.effort}`);
      if (v.walk) {
        walkSamples++;
        const { x, z } = v.walk.pos, sc = clamp01(hull.sOf(z));
        worstHalf = Math.max(worstHalf, Math.abs(x) - hull.halfBeam(sc));
        for (const o of manned) {
          // the stance (stance.ts): on the oar's side, 0.6 m forward of the pin
          const q = stanceXZ(o.slot.id, hull, MERCHANT_CREW, sxz), d = Math.hypot(x - q.x, z - q.z);
          minClear = Math.min(minClear, d);
        }
      }
    }
    if (seen.has('walk') && seen.has('stepIn') && seen.has('stepOut') && reliefDrives > 0 && s.rotation.swaps.some((w) => w.done !== undefined)) break;
  }
  report.measured.animatorView = { walkSamples, minStanceClearance: +minClear.toFixed(3), worstHalfBeamExcess: +worstHalf.toFixed(3), modes: [...seen],
    reliefFirstDrives: reliefDrives, secondMenOnLoom: secondSeen, yawPairs, maxYawStepDeg: +deg(maxYawStep).toFixed(2) };
  assert.ok(reliefDrives > 0, 'no relief drove after a handover');
  assert.ok(secondSeen > 0, 'no second man on a loom during a handover');
  assert.ok(yawPairs > 0, 'no walking facing sampled');
  assert.ok(seen.has('walk') && seen.has('stepIn') && seen.has('stepOut'), `modes seen: ${[...seen]}`);
  assert.ok(s.rotation.swaps.some((w) => w.done !== undefined), 'no relief swap completed');
  assert.ok(walkSamples > 0, 'no walk sampled');
  assert.ok(worstHalf <= 0, `walk outside the hull by ${worstHalf.toFixed(3)} m`);
  assert.ok(minClear >= 0.63, `walk within ${minClear.toFixed(3)} m of a manned stance`);
});

test('animator view: fillView and updatePayload allocate nothing per step (needs --expose-gc)', () => {
  if (typeof globalThis.gc !== 'function') { report.measured.allocation = 'skipped: run with node --expose-gc'; console.log('  (skipped: run with node --expose-gc)'); return; }
  const ship = vessel(), s = sys(ship);
  ship.crew.setOrder(FULL);
  for (let i = 0; i < Math.round(60 / dt); i++) ship.step(dt);
  const fill = () => { s.fillView(s.viewCur); s.updatePayload(); };
  for (let i = 0; i < 1000; i++) fill();
  globalThis.gc(); const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 10000; i++) fill();
  globalThis.gc(); const growth = process.memoryUsage().heapUsed - before;
  report.measured.allocation = { fills: 10000, heapGrowthKB: +(growth / 1024).toFixed(1) };
  assert.ok(growth < 256 * 1024, `heap grew ${(growth / 1024).toFixed(0)} KB over 10k fills`);
});

fs.mkdirSync('docs/merchant-crew', { recursive: true });
if (!filter) fs.writeFileSync('docs/merchant-crew/test-results.json', JSON.stringify(report, null, 1));
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
