// Cargo handling invariants, persistence, and timing. Run: node scripts/test-cargo-handling.mjs
import './register-ts.mjs';
import assert from 'node:assert/strict';

const { GOODS, GOOD_IDS } = await import('../src/trade/goods.ts');
const { Economy } = await import('../src/trade/economy.ts');
const { TradeSession } = await import('../src/trade/session.ts');
const { newVoyage } = await import('../src/trade/voyage.ts');
const { CARGO_WORK_KG_PER_HOUR, CART_AFTER_JOB, jobSummary, pendingUnits, restoreJob } = await import('../src/trade/job.ts');
const { buildSave, parseSave } = await import('../src/trade/save.ts');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e.message).split('\n').join('\n     ')}`); }
}

const T0 = 2408;
const portList = [
  { id: 0, profile: { houses: 100, area: 10e6, features: Object.fromEntries(GOOD_IDS.map((id) => [id, 1e6])) }, x: 0, z: 0 },
];
const doyAt = (T) => Math.floor(T / 24) % 365;
function setup({ manifest = { wine: 70 }, cap = 100, startT = T0, hands = 0 } = {}) {
  const economy = new Economy({ seed: 173, ports: portList, doyAt, hands, startT });
  const voyage = newVoyage();
  voyage.manifest = { ...manifest };
  voyage.purse = 1e9;
  const session = new TradeSession({ economy, voyage, holdCapacity: cap });
  return { economy, voyage, session, cap };
}
const job = (x) => x.voyage.job;
const assertPhysicalSafe = (s) => {
  for (const id of GOOD_IDS) {
    assert.ok((s.voyage.manifest[id] ?? 0) >= 0, `${id} manifest underflow`);
    assert.ok((job(s)?.quay[id] ?? 0) >= 0, `${id} quay underflow`);
  }
  assert.ok(s.session.physicalHoldUse().volume <= s.cap + 1e-9, 'physical hold overflow');
};

test('opposing wine orders remain 20 crossings, 840 kg, 2.1 h, and one fee each', () => {
  const s = setup({ cap: 20 });
  s.session.confirm(0, 0, { wine: -10 });
  s.session.confirm(0, 0, { wine: 10 });
  const afterOrders = s.voyage.purse;
  assert.equal(pendingUnits(job(s)), 20);
  assert.equal(job(s).incoming.wine, 10);
  assert.equal(job(s).outgoing.wine, 10);
  assert.equal(job(s).quay.wine, 10);
  assert.equal(s.session.aboard('wine'), 70, 'committed semantics net only for capacity');
  assert.equal(s.session.physicalHoldUse().tonnes, 2.94);
  assert.throws(() => s.session.castOff(), /still moving/);
  const e = s.session.tick(T0 + 2.1);
  assert.equal(s.voyage.manifest.wine, 70);
  assert.equal(job(s).cartAt, T0 + 3.1);
  assert.equal(afterOrders - s.voyage.purse, 20 * 11);
  assert.deepEqual(e.filter((x) => x.type === 'job-done'), [{ type: 'job-done', kind: 'stowed' }]);
  assert.ok(!e.some((x) => x.type === 'moved' && x.good === 'wine'), 'net-zero movement should not invent a manifest delta');
  assertPhysicalSafe(s);
});

test('buying cannot be resold before landing; repeated sales cannot reserve the same units', () => {
  const s = setup({ manifest: {}, cap: 20 });
  s.session.confirm(0, 0, { honey: 2 });
  assert.equal(s.session.aboard('honey'), 2);
  assert.equal(s.session.physicalHoldUse().tonnes, 0);
  assert.throws(() => s.session.confirm(0, 0, { honey: -1 }), /exceeds what is aboard/);
  const stocked = setup();
  stocked.session.confirm(0, 0, { wine: -50 });
  assert.throws(() => stocked.session.confirm(0, 0, { wine: -21 }), /exceeds what is aboard/);
  assert.equal(stocked.session.limits(0, {}, 'wine').min, -20);
});

test('handling time follows mass for wheat, wine, and honey', () => {
  assert.equal(CARGO_WORK_KG_PER_HOUR, 400);
  for (const [good, count, expected] of [['wheat', 10, 1], ['wine', 10, 1.05], ['honey', 10, 0.625]]) {
    const s = setup({ manifest: {}, cap: 100 });
    s.session.confirm(0, 0, { [good]: count });
    assert.ok(Math.abs(jobSummary(job(s)).hours - expected) < 1e-12);
    s.session.tick(T0 + expected);
    assert.equal(s.voyage.manifest[good], count);
    assert.equal(s.session.pendingUnits, 0);
  }
});

test('active incoming unit finishes before a newly requested unload and retains its admitted slot', () => {
  const s = setup({ manifest: { wine: 1 }, cap: 0.14 });
  s.session.confirm(0, 0, { wheat: 1 });
  s.session.tick(T0 + 0.05); // 20 kg on the active wheat sack
  assert.equal(job(s).active.good, 'wheat');
  assert.equal(job(s).active.direction, 'load');
  assert.ok(Math.abs(job(s).active.workKg - 20) < 1e-8);
  s.session.confirm(0, 0, { wine: -1, firewood: 1 });
  assert.ok(Math.abs(job(s).active.workKg - 20) < 1e-8);
  assertPhysicalSafe(s);
  s.session.tick(T0 + 0.105); // finish the reserved sack exactly; sale has not crossed
  assert.equal(s.voyage.manifest.wheat, 1);
  assert.equal(s.voyage.manifest.wine, 1);
  assert.equal(job(s).outgoing.wine, 1);
  assertPhysicalSafe(s);
  s.session.tick(T0 + 0.21);
  assert.equal(s.voyage.manifest.wine ?? 0, 0);
  assert.equal(s.voyage.manifest.firewood ?? 0, 0, 'new loading waits for unloading');
  assertPhysicalSafe(s);
  s.session.tick(T0 + 0.2725);
  assert.equal(s.voyage.manifest.firewood, 1);
  assertPhysicalSafe(s);
});

test('repeated opposing orders conserve obligations and mass across partial ticks', () => {
  const s = setup({ cap: 20 });
  s.session.confirm(0, 0, { wine: -10 });
  s.session.confirm(0, 0, { wine: 10 });
  const purseAfterInitialOrders = s.voyage.purse;
  const totalFirst = jobSummary(job(s)).remainingKg;
  s.session.tick(T0 + 0.5);
  const purseAfterPartial = s.voyage.purse;
  assert.equal(s.voyage.manifest.wine, 66);
  assert.equal(job(s).active.good, 'wine');
  assert.equal(job(s).active.direction, 'unload');
  assert.ok(Math.abs(job(s).active.workKg - 32) < 1e-8);
  const afterWork = jobSummary(job(s)).remainingKg;
  assert.ok(Math.abs((totalFirst - afterWork) - 200) < 1e-8);
  s.session.confirm(0, 0, { wine: -5 });
  s.session.confirm(0, 0, { wine: 3 });
  const purseAfterAllOrders = s.voyage.purse;
  assert.equal(job(s).outgoing.wine, 11);
  assert.equal(job(s).incoming.wine, 13);
  assert.equal(s.session.pendingUnits, 24);
  let moved = 0;
  for (const dt of [0.013, 0.27, 0.004, 0.619, 0.3, 0.8, 0.8, 0.35]) {
    const beforeKg = job(s) ? jobSummary(job(s)).remainingKg : 0;
    const oldT = s.economy.now;
    const events = s.session.tick(oldT + dt);
    moved += events.filter((x) => x.type === 'moved').reduce((n, x) => n + Math.abs(x.delta), 0);
    if (job(s)) assert.ok(Math.abs(jobSummary(job(s)).remainingKg - Math.max(0, beforeKg - CARGO_WORK_KG_PER_HOUR * dt)) < 1e-8);
    assertPhysicalSafe(s);
  }
  assert.equal(s.voyage.manifest.wine, 68);
  assert.equal(s.session.pendingUnits, 0);
  assert.ok(moved > 0);
  assert.equal(job(s).quay.wine, 15);
  assert.equal(purseAfterInitialOrders - purseAfterPartial, 4 * 11);
  assert.equal(purseAfterAllOrders - s.voyage.purse, 24 * 11);
  const soldUnits = 10 + 5;
  const boughtUnits = 10 + 3;
  assert.equal(soldUnits + boughtUnits, 28, '15 sold and 13 bought units cross the rail');
  assert.equal((purseAfterInitialOrders - purseAfterPartial) + (purseAfterAllOrders - s.voyage.purse), 28 * 11, 'one porter fee per crossing');
  assert.equal(s.voyage.manifest.wine, 68);
});

test('one long tick, irregular ticks, and save/restore mid-unit agree', () => {
  const a = setup({ manifest: { wine: 70 }, cap: 100 });
  const b = setup({ manifest: { wine: 70 }, cap: 100 });
  const c = setup({ manifest: { wine: 70 }, cap: 100 });
  for (const s of [a, b, c]) {
    s.session.confirm(0, 0, { wine: -3 });
    s.session.confirm(0, 0, { wheat: 5 });
  }
  a.session.tick(T0 + 0.73);
  b.session.tick(T0 + 0.07);
  b.session.tick(T0 + 0.203);
  b.session.tick(T0 + 0.3);
  b.session.tick(T0 + 0.73);
  c.session.tick(T0 + 0.2);
  const save = buildSave({
    seed: 173, heightmapSize: 16, clock: { dayCount: 100, hours: 8.2, dayOfYear: 100, moonPhase: 0.2 },
    windTime: 3, berth: { id: 0, bowOut: false }, voyage: JSON.parse(JSON.stringify(c.voyage)), economy: c.economy.snapshot(), savedAt: 1,
  });
  const restored = parseSave(JSON.stringify(save), 173, 16);
  assert.ok(restored);
  const econ = new Economy({ seed: 173, ports: portList, doyAt, hands: 0, startT: T0 });
  econ.restore(restored.economy);
  const d = { economy: econ, voyage: restored.voyage, session: new TradeSession({ economy: econ, voyage: restored.voyage, holdCapacity: 100 }) };
  d.session.tick(T0 + 0.73);
  const mid = [a, b, d];
  for (const s of mid) {
    assert.deepEqual(s.voyage.manifest, a.voyage.manifest);
    assert.deepEqual(job(s).incoming, job(a).incoming);
    assert.deepEqual(job(s).outgoing, job(a).outgoing);
    assert.deepEqual(job(s).quay, job(a).quay);
    assert.equal(s.voyage.purse, a.voyage.purse);
    assert.equal(s.session.pendingUnits, a.session.pendingUnits);
    assert.equal(job(s).active.good, 'wheat');
    assert.equal(job(s).active.direction, 'load');
    assert.ok(Math.abs(job(s).active.workKg - job(a).active.workKg) < 1e-8);
    assert.ok(Math.abs(jobSummary(job(s)).remainingKg - jobSummary(job(a)).remainingKg) < 1e-8);
  }
  const completedEvents = mid.map((s) => s.session.tick(T0 + 0.815));
  for (const s of mid) {
    assert.equal(s.session.pendingUnits, 0);
    assert.ok(Math.abs(job(s).cartAt - (T0 + 1.815)) < 1e-8);
    assert.deepEqual(s.voyage.manifest, a.voyage.manifest);
    assert.equal(s.voyage.purse, a.voyage.purse);
  }
  for (const ev of completedEvents) assert.deepEqual(ev.filter((x) => x.type === 'job-done'), [{ type: 'job-done', kind: 'stowed' }]);
  for (const s of mid) s.session.tick(T0 + 1.815);
  for (const s of mid) {
    assert.equal(s.voyage.job, null);
    assert.equal(s.voyage.hatchUntil, T0 + 2.815);
    assert.equal(s.session.hatchesOpen(T0 + 2.815 - 1e-9), true);
    assert.equal(s.session.hatchesOpen(T0 + 2.815), false);
  }
});

test('mixed goods follow GOODS order independently for unloading and loading', () => {
  const s = setup({ manifest: { wine: 1, honey: 1 }, cap: 100 });
  s.session.confirm(0, 0, { honey: -1, wine: -1 });
  s.session.confirm(0, 0, { honey: 1, wheat: 1 });
  s.session.tick(T0 + 0.105); // wine (42 kg) precedes honey (25 kg)
  assert.equal(s.voyage.manifest.wine ?? 0, 0);
  assert.equal(s.voyage.manifest.honey, 1);
  assert.equal(job(s).outgoing.honey, 1);
  s.session.tick(T0 + 0.1675); // honey unload finishes; wheat is the first incoming good
  assert.equal(s.voyage.manifest.honey ?? 0, 0);
  assert.equal(job(s).active.good, 'wheat');
  assert.equal(job(s).active.direction, 'load');
  s.session.tick(T0 + 0.2675);
  assert.equal(s.voyage.manifest.wheat, 1);
  assert.equal(s.voyage.manifest.honey ?? 0, 0);
  s.session.tick(T0 + 0.33);
  assert.equal(s.voyage.manifest.honey, 1);
  assert.equal(s.session.pendingUnits, 0);
});

test('paused handling advances wages and clock without away work, then resumes from saved work', () => {
  const startT = 2399.5;
  const s = setup({ manifest: {}, cap: 100, startT, hands: 8 });
  s.session.confirm(0, 0, { wheat: 10 });
  s.session.tick(startT + 0.125);
  assert.equal(job(s).active.good, 'wheat');
  assert.ok(Math.abs(job(s).active.workKg - 10) < 1e-8);
  const manifestBeforePause = { ...s.voyage.manifest };
  const quayBeforePause = { ...job(s).quay };
  const purseBeforePause = s.voyage.purse;
  const awayEvents = s.session.tick(2400.5, false);
  const wage = awayEvents.find((e) => e.type === 'wages');
  assert.ok(wage, 'midnight wages must continue while handling is paused');
  assert.ok(!awayEvents.some((e) => e.type === 'moved' || e.type === 'job-done'));
  assert.equal(s.voyage.purse, purseBeforePause - wage.amount, 'paused time charges wages, no porter fees');
  assert.deepEqual(s.voyage.manifest, manifestBeforePause);
  assert.deepEqual(job(s).quay, quayBeforePause);
  assert.ok(Math.abs(job(s).active.workKg - 10) < 1e-8);

  const save = buildSave({
    seed: 173, heightmapSize: 16,
    clock: { dayCount: 100, hours: 0.5, dayOfYear: 100, moonPhase: 0.2 },
    windTime: 7, berth: { id: 0, bowOut: false },
    voyage: JSON.parse(JSON.stringify(s.voyage)), economy: s.economy.snapshot(), savedAt: 3,
  });
  const parsed = parseSave(JSON.stringify(save), 173, 16);
  assert.ok(parsed);
  const economy = new Economy({ seed: 173, ports: portList, doyAt, hands: 8, startT });
  economy.restore(parsed.economy);
  const voyage = parsed.voyage;
  const restored = { economy, voyage, session: new TradeSession({ economy, voyage, holdCapacity: 100 }) };

  for (const run of [s, restored]) {
    run.session.tick(2401.25, false);
    assert.equal(run.session.pendingUnits, 9);
    assert.ok(Math.abs(job(run).active.workKg - 10) < 1e-8, 'no handling credit accumulates while away');
  }
  assert.deepEqual(restored.voyage.manifest, s.voyage.manifest);
  assert.equal(restored.voyage.purse, s.voyage.purse);
  assert.deepEqual(job(restored), job(s));

  for (const run of [s, restored]) {
    run.session.tick(2401.25, true); // zero elapsed time after the paused tick
    assert.equal(run.session.pendingUnits, 9);
    assert.ok(Math.abs(job(run).active.workKg - 10) < 1e-8);
    run.session.tick(2402.25, true); // 1 h since the immediately previous tick
    assert.equal(run.voyage.manifest.wheat, 10);
    assert.equal(run.session.pendingUnits, 0);
    assert.ok(Math.abs(job(run).cartAt - 2403.125) < 1e-8);
    assert.equal(run.voyage.purse, purseBeforePause - wage.amount - 90);
  }
  assert.deepEqual(restored.voyage.manifest, s.voyage.manifest);
  assert.equal(restored.voyage.purse, s.voyage.purse);
  assert.deepEqual(job(restored), job(s));
  for (const run of [s, restored]) {
    run.session.tick(2403.125, false); // completed cart timers still progress while disconnected
    assert.equal(run.voyage.job, null);
    assert.ok(Math.abs(run.voyage.hatchUntil - 2404.125) < 1e-8);
    assert.equal(run.session.hatchesOpen(2404.125 - 1e-9), true);
    assert.equal(run.session.hatchesOpen(2404.125), false);
  }
});

test('confirm at a different berth is rejected before any state mutation', () => {
  const s = setup({ manifest: { wine: 5 }, cap: 100 });
  s.session.confirm(0, 8, { wine: -1 });
  const before = JSON.stringify({ voyage: s.voyage, economy: s.economy.snapshot() });
  assert.throws(() => s.session.confirm(0, 9, { wheat: 2 }), RangeError);
  assert.equal(JSON.stringify({ voyage: s.voyage, economy: s.economy.snapshot() }), before);
});

test('legacy signed job migrates signs, quay, fractional effort, and empty-job cart delay', () => {
  const legacy = restoreJob({ port: 2, berth: 4, pending: { wine: -2, wheat: 3 }, quay: { wheat: 3 }, carry: 0.25 }, T0, { wine: 2 });
  assert.equal(legacy.version, 2);
  assert.equal(legacy.outgoing.wine, 2);
  assert.equal(legacy.incoming.wheat, 3);
  assert.equal(legacy.quay.wheat, 3);
  assert.deepEqual(legacy.active, { good: 'wine', direction: 'unload', workKg: 10.5 });
  const empty = restoreJob({ port: 0, berth: 0, pending: {}, quay: {}, carry: 0 }, T0, {});
  assert.equal(empty.cartAt, T0 + CART_AFTER_JOB);
  const noCarry = restoreJob({ port: 0, berth: 0, pending: { honey: 1 }, quay: { honey: 1 } }, T0, {});
  assert.equal(noCarry.active, null);
});

test('strict restore rejects malformed v2 and legacy jobs and inconsistent save cargo', () => {
  const bad = [
    { version: 3 },
    { version: 2, port: 0, berth: 0, incoming: { wheat: -1 }, outgoing: {}, quay: {}, active: null, cartAt: null },
    { version: 2, port: 0, berth: 0, incoming: {}, outgoing: {}, quay: {}, active: { good: 'wine', direction: 'load', workKg: 1 }, cartAt: null },
    { version: 2, port: 0, berth: 0, incoming: { wheat: 1 }, outgoing: {}, quay: { wheat: 1 }, active: null, cartAt: T0 },
    { version: 2, port: 0, berth: 0, incoming: {}, outgoing: {}, quay: {}, active: null, cartAt: null },
    { port: 0, berth: 0, pending: { wine: 1 }, quay: {}, carry: 1 },
  ];
  for (const raw of bad) assert.throws(() => restoreJob(raw, T0, {}));
  const v2 = (incoming, outgoing, quay) => ({ version: 2, port: 0, berth: 0, incoming, outgoing, quay, active: null, cartAt: null });
  assert.throws(() => restoreJob(v2({ wheat: 2 }, {}, { wheat: 1 }), T0, {}), /exceeds quay/);
  assert.throws(() => restoreJob(v2({}, { wine: 2 }, {}), T0, { wine: 1 }), /exceeds physical/);
  assert.doesNotThrow(() => restoreJob(v2({ wheat: 1 }, { wine: 1 }, { wheat: 1 }), T0, { wine: 1 }));
  const s = setup();
  s.voyage.job = { version: 2, port: 0, berth: 0, incoming: { wheat: 2 }, outgoing: {}, quay: { wheat: 1 }, active: null, cartAt: null };
  const save = buildSave({ seed: 173, heightmapSize: 16, clock: { dayCount: 0, hours: 0, dayOfYear: 0, moonPhase: 0 }, windTime: 0, berth: { id: 0, bowOut: false }, voyage: s.voyage, economy: s.economy.snapshot() });
  const warnings = [];
  const oldWarn = console.warn;
  console.warn = (...x) => warnings.push(x.join(' '));
  try { assert.equal(parseSave(JSON.stringify(save), 173, 16), null); }
  finally { console.warn = oldWarn; }
  assert.equal(warnings.length, 1);
});

test('restoring an active load must preserve its admitted physical slot', () => {
  const s = setup({ manifest: { wine: 1 }, cap: 0.075 });
  s.voyage.job = {
    version: 2, port: 0, berth: 0,
    incoming: { honey: 1 }, outgoing: { wine: 1 }, quay: { honey: 1 },
    active: { good: 'honey', direction: 'load', workKg: 1 }, cartAt: null,
  };
  assert.ok(s.session.holdUse().volume < s.cap, 'outgoing commitment makes the forecast fit');
  assert.throws(() => new TradeSession({ economy: s.economy, voyage: s.voyage, holdCapacity: s.cap }), /active load exceeds physical hold/);
});

test('save and restore during cart delay preserves cart and hatch release times', () => {
  const s = setup({ manifest: {}, cap: 100 });
  s.session.confirm(0, 0, { honey: 10 });
  const completeAt = T0 + 0.625;
  s.session.tick(completeAt);
  assert.equal(job(s).cartAt, completeAt + 1);
  const saved = buildSave({ seed: 173, heightmapSize: 16, clock: { dayCount: 100, hours: 8.625, dayOfYear: 100, moonPhase: 0.2 }, windTime: 5, berth: { id: 0, bowOut: false }, voyage: JSON.parse(JSON.stringify(s.voyage)), economy: s.economy.snapshot(), savedAt: 2 });
  const parsed = parseSave(JSON.stringify(saved), 173, 16);
  assert.ok(parsed);
  const econ = new Economy({ seed: 173, ports: portList, doyAt, hands: 0, startT: T0 });
  econ.restore(parsed.economy);
  const voy = parsed.voyage;
  const resumed = new TradeSession({ economy: econ, voyage: voy, holdCapacity: 100 });
  resumed.tick(completeAt + 1 - 1e-9);
  assert.ok(voy.job);
  resumed.tick(completeAt + 1);
  assert.equal(voy.job, null);
  assert.equal(voy.hatchUntil, completeAt + 2);
  assert.equal(resumed.hatchesOpen(completeAt + 2 - 1e-9), true);
  assert.equal(resumed.hatchesOpen(completeAt + 2), false);
});

test('completion, cart, hatch, zero-time, backwards-time, and cast-off boundaries are exact', () => {
  const s = setup({ manifest: { wine: 70 }, cap: 20 });
  s.session.confirm(0, 0, { wine: -10 });
  s.session.confirm(0, 0, { wine: 10 });
  const purse = s.voyage.purse;
  assert.deepEqual(s.session.tick(T0), []);
  assert.equal(s.voyage.purse, purse, 'zero time has no duplicate porterage');
  assert.throws(() => s.session.tick(T0 - 0.01), /backwards/);
  const end = T0 + 2.1;
  s.session.tick(end);
  assert.equal(job(s).cartAt, end + 1);
  assert.equal(s.session.hatchesOpen(end + 1), true);
  s.session.tick(end + 1 - 1e-9);
  assert.ok(job(s));
  s.session.tick(end + 1);
  assert.equal(job(s), null);
  assert.equal(s.voyage.hatchUntil, end + 2);
  assert.equal(s.session.hatchesOpen(end + 2 - 1e-9), true);
  assert.equal(s.session.hatchesOpen(end + 2), false);
  s.session.castOff();
  assert.equal(s.voyage.hatchUntil, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
