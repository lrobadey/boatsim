import './register-ts.mjs';
// Acceptance tests for the trireme's agent crew (docs/trireme-crew-plan.md). Speeds are emergent: the speed bands
// are regression bands around the measured values (docs/trireme-crew-plan.md §5), not targets.
// node scripts/test-trireme-crew.mjs [--test=<name part>]
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { Crew } = await import('../src/ship/crew.ts');
const { ShipPhysics } = await import('../src/ship/physics.ts');
const { Wind } = await import('../src/world/wind.ts');
const { WaveField } = await import('../src/world/waves.ts');
const { TRIREME } = await import('../src/ship/design.ts');
const { TRIREME_CREW, MERCHANT_CREW } = await import('../src/ship/crew/params.ts');
const { CrewRowing } = await import('../src/ship/crew/crewRowing.ts');

const dt = 1 / 120, KN = 1.943844, L = 37;
const BACK = 0, STOP = 1, SLOW = 2, HALF = 3, FULL = 4, RAM = 5;
const filter = process.argv.find((a) => a.startsWith('--test='))?.slice(7);
const report = { tests: [], measured: {} };
let failures = 0;
function test(name, fn) {
  if (filter && !name.includes(filter)) return;
  const t0 = performance.now();
  try { fn(); report.tests.push({ name, status: 'passed', ms: Math.round(performance.now() - t0) }); console.log('PASS', name); }
  catch (e) { failures++; report.tests.push({ name, status: 'failed', error: e.message }); console.error('FAIL', name, '\n  ', e.message); }
}
const terrain = { heightAt: () => -100, normalAt: (x, z, out) => out.set(0, 1, 0) };
const flat = () => { const w = new WaveField(new Wind(0)); w.waves.length = 0; return w; };
function seaAt(U, seed = 1) {
  const wind = new Wind(seed);
  wind.baseSpeed = 1; wind.update(0);
  wind.baseSpeed = U / wind.meanSpeed; wind.update(0);
  const waves = new WaveField(wind);
  waves.update(Infinity);
  return { wind, waves };
}
function vessel({ water = flat(), crew: over = {} } = {}) {
  const design = { ...TRIREME, oars: { ...TRIREME.oars, crew: { ...TRIREME_CREW, ...over } } };
  const crew = new Crew(), ship = new ShipPhysics(water, { vx: 0, vz: 0 }, terrain, crew, design);
  ship.place(0, 0, 0);
  for (let i = 0; i < 240; i++) ship.step(dt);
  ship.vel.set(0, 0, 0); ship.angVel.set(0, 0, 0);
  return ship;
}
function run(ship, seconds, { onStep, tail = 30, sea = null } = {}) {
  const n = Math.round(seconds / dt);
  let sum = 0, m = 0, untilRetarget = 0;
  for (let i = 0; i < n; i++) {
    onStep?.(i * dt, ship);
    if (sea) {
      sea.wind.update(dt);
      if ((untilRetarget -= dt) <= 0) { sea.waves.retarget(sea.wind); untilRetarget = 1; }
      sea.waves.update(dt);
    }
    ship.step(dt);
    if (i >= n - Math.round(tail / dt)) { sum += ship.speed; m++; }
  }
  return (sum / m) * KN;
}
/** spread (s) of the crew's last catches around the stroke's beat */
function catchSpread(r) {
  const S = r.leader();
  if (!S || !Number.isFinite(S.lastCatch)) return Infinity;
  let lo = Infinity, hi = -Infinity;
  for (const o of r.oars) {
    if (!Number.isFinite(o.lastCatch)) return Infinity;
    const d = o.lastCatch - S.lastCatch, w = d - S.period * Math.round(d / S.period);
    lo = Math.min(lo, w); hi = Math.max(hi, w);
  }
  return hi - lo;
}
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const deg = (r) => (r * 180) / Math.PI;
const ordersAt = (ramRate) => TRIREME_CREW.orders.map((o, i) => (i === RAM ? { ...o, rate: ramRate } : o));

test('setup: 170 crew oars in three banks, no stance payload, no animator view, merchant switches off', () => {
  const ship = vessel(), r = ship.rowing;
  assert.ok(r instanceof CrewRowing);
  assert.equal(r.slots.length, 170);
  assert.equal(r.hands.length, 170);
  assert.deepEqual([0, 1, 2].map((b) => r.oars.filter((o) => o.slot.bank === b).length), [62, 54, 54]);
  for (const o of r.oars) assert.equal(o.Ioar, TRIREME_CREW.banks[o.slot.bank].Ioar);
  assert.equal(ship.payload.length, 0, 'the rowers are part of her displacement');
  assert.equal(TRIREME_CREW.animated, false);
  for (const k of ['addedMassRelative', 'catchUp', 'recoveryEffort']) assert.equal(MERCHANT_CREW[k], false, `merchant ${k}`);
  assert.equal(MERCHANT_CREW.wCall, 0);
});

test('order ladder from rest: Slow < Half < Full, Back astern, all oars in time', () => {
  const out = {};
  for (const order of [SLOW, HALF, FULL, BACK]) {
    const ship = vessel();
    ship.crew.setOrder(order);
    const kn = run(ship, 120);
    out[order] = { kn: +kn.toFixed(2), spm: +ship.crew.rate.toFixed(1), spreadMs: Math.round(catchSpread(ship.rowing) * 1000), stamina: +ship.crew.stamina.toFixed(3) };
    assert.ok(out[order].spreadMs <= 250, `order ${order}: catch spread ${out[order].spreadMs} ms`);
  }
  report.measured.ladder = out;
  assert.ok(out[SLOW].kn < out[HALF].kn && out[HALF].kn < out[FULL].kn, JSON.stringify(out));
  assert.ok(out[SLOW].kn >= 3.7 && out[SLOW].kn <= 4.8, `Slow ${out[SLOW].kn} kn`);
  assert.ok(out[HALF].kn >= 4.2 && out[HALF].kn <= 5.4, `Half ${out[HALF].kn} kn`);
  assert.ok(out[FULL].kn >= 4.8 && out[FULL].kn <= 6.1, `Full ${out[FULL].kn} kn`);
  assert.ok(out[BACK].kn <= -3.3 && out[BACK].kn >= -4.5, `Back ${out[BACK].kn} kn`);
});

test('the crew keeps time at every ramming call from 30 to 44 spm (no block of the crew settles behind the stroke)', () => {
  const out = {};
  for (const rate of [30, 33, 38, 44]) {
    const ship = vessel({ crew: { orders: ordersAt(rate) } });
    ship.crew.setOrder(RAM);
    run(ship, 60);
    out[rate] = Math.round(catchSpread(ship.rowing) * 1000);
    assert.ok(out[rate] <= 250, `call ${rate} spm: catch spread ${out[rate]} ms`);
  }
  report.measured.ramCallSpreadMs = out;
});

test('ramming speed: faster than Full, then drops to Full when the crew is spent', () => {
  const ship = vessel();
  ship.crew.setOrder(FULL);
  run(ship, 120);
  const full = ship.speed * KN;
  ship.crew.setOrder(RAM);
  let best = 0, demoted = null;
  const win = [];
  run(ship, 600, {
    onStep: (t) => {
      win.push(ship.speed * KN); if (win.length > 600) win.shift();
      if (t <= 60 && win.length === 600) best = Math.max(best, win.reduce((a, b) => a + b, 0) / 600);
      if (demoted === null && ship.crew.orderIndex !== RAM) demoted = t;
    },
  });
  report.measured.ram = { fullKn: +full.toFixed(2), best5sKn: +best.toFixed(2), demotedS: demoted && Math.round(demoted) };
  assert.ok(best >= full + 0.25, `ramming best ${best.toFixed(2)} kn vs Full ${full.toFixed(2)} kn`);
  assert.ok(demoted !== null && demoted >= 60 && demoted <= 600, `demoted at ${demoted}`);
  assert.equal(ship.crew.orderIndex, FULL);
  assert.ok(ship.crew.exhausted || ship.crew.stamina >= 0.3);
});

test('hold water stops her from Full within two lengths', () => {
  const ship = vessel();
  ship.crew.setOrder(FULL);
  run(ship, 90);
  const x0 = ship.pos.clone();
  ship.crew.holdWater = true;
  let t = 0;
  while (ship.speed > 0.1 && t < 60) { ship.step(dt); t += dt; }
  const d = ship.pos.distanceTo(x0);
  report.measured.hold = { seconds: +t.toFixed(1), metres: +d.toFixed(1) };
  assert.ok(t < 60 && d < 2 * L, `${d.toFixed(1)} m in ${t.toFixed(1)} s`);
});

test('turning: pivot from rest, and the oars help the helm at Full', () => {
  const pivot = vessel();
  pivot.crew.setOrder(SLOW); pivot.helm = 1;
  let prev = pivot.heading, turned = 0, maxKn = 0;
  run(pivot, 60, { onStep: () => { turned += wrap(pivot.heading - prev); prev = pivot.heading; maxKn = Math.max(maxKn, Math.abs(pivot.speed * KN)); } });
  const rates = {};
  for (const order of [FULL, STOP]) {
    const s = vessel();
    s.crew.setOrder(FULL); run(s, 90);
    s.crew.setOrder(order); s.helm = 1;
    let p = s.heading, a = 0;
    run(s, 60, { onStep: () => { a += wrap(s.heading - p); p = s.heading; } });
    rates[order] = deg(a) / 60;
  }
  report.measured.turning = { pivotDeg: Math.round(deg(turned)), pivotMaxKn: +maxKn.toFixed(2), fullDegS: +rates[FULL].toFixed(2), oarsUpDegS: +rates[STOP].toFixed(2) };
  assert.ok(deg(turned) >= 60 && maxKn <= 0.8, JSON.stringify(report.measured.turning));
  assert.ok(rates[FULL] > rates[STOP] * 1.5, JSON.stringify(report.measured.turning));
});

test('shipping runs every oar in, dry, and the crew rows again after', () => {
  const ship = vessel(), r = ship.rowing;
  r.setShipped(-1, true); r.setShipped(1, true);
  run(ship, 4);
  assert.ok(r.oars.every((o) => o.mode === 'shipped'));
  assert.ok(r.oars.every((o) => Math.abs(o.theta - TRIREME_CREW.shippedSweep) < 0.05));
  assert.equal(r.telemetry.wetBlades, 0);
  r.setShipped(-1, false); r.setShipped(1, false);
  ship.crew.setOrder(FULL);
  run(ship, 30);
  assert.ok(ship.speed * KN > 3, `${(ship.speed * KN).toFixed(2)} kn after running out`);
  assert.ok(catchSpread(r) <= 0.25);
});

test('a real sea: Full at wind 10 m/s stays finite, in time and in the water', () => {
  const sea = seaAt(10), ship = vessel({ water: sea.waves });
  ship.crew.setOrder(FULL);
  let maxHeel = 0;
  const kn = run(ship, 150, { sea, onStep: () => { maxHeel = Math.max(maxHeel, Math.abs(ship.heel)); } });
  const r = ship.rowing;
  report.measured.sea10 = { kn: +kn.toFixed(2), missed: +r.telemetry.missedDriveFraction.toFixed(3), maxHeelDeg: +deg(maxHeel).toFixed(1) };
  assert.ok(Number.isFinite(kn) && ship.pos.toArray().every(Number.isFinite));
  assert.ok(r.telemetry.missedDriveFraction < 0.05);
  assert.ok(deg(maxHeel) < 20);
  assert.ok(kn > 3);
});

test('entrained water: picked up with the sea, so the catch loses little to pickup', () => {
  const ship = vessel(), r = ship.rowing;
  ship.crew.setOrder(FULL);
  run(ship, 60);
  const a0 = r.oars.map((o) => o.audit.pickupLoss), h0 = r.oars.map((o) => o.audit.hullWork);
  run(ship, 30);
  let pick = 0, hull = 0;
  r.oars.forEach((o, i) => { pick += o.audit.pickupLoss - a0[i]; hull += o.audit.hullWork - h0[i]; });
  report.measured.entrained = { pickupW: +(pick / 30 / 170).toFixed(2), hullW: +(hull / 30 / 170).toFixed(1) };
  assert.ok(pick / 30 / 170 < 2, JSON.stringify(report.measured.entrained));
});

test('deterministic and within the CPU budget', () => {
  const a = vessel(), b = vessel();
  a.crew.setOrder(FULL); b.crew.setOrder(FULL);
  a.helm = b.helm = 0.4;
  let worst = 0;
  const times = [];
  for (let i = 0; i < 3000; i++) {
    const t0 = performance.now(); a.step(dt); times.push(performance.now() - t0);
    b.step(dt);
  }
  for (let k = 0; k < a.rowing.current.joint.length; k++) worst = Math.max(worst, Math.abs(a.rowing.current.joint[k] - b.rowing.current.joint[k]));
  assert.equal(worst, 0);
  assert.ok(a.pos.equals(b.pos));
  times.sort((x, y) => x - y);
  const mean = times.reduce((x, y) => x + y, 0) / times.length;
  report.measured.cpu = { meanMs: +mean.toFixed(3), p95Ms: +times[Math.floor(times.length * 0.95)].toFixed(3) };
  assert.ok(mean <= 1.5, `mean ${mean.toFixed(3)} ms per full physics step`);
});

fs.mkdirSync('docs/trireme-crew', { recursive: true });
fs.writeFileSync('docs/trireme-crew/test-results.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.measured, null, 1));
if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log('all passed');
