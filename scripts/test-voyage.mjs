// T4 voyage and T6 save tests (docs/cargo-trade-spec.md §13). Headless, synthetic ports, hold 20.1 m³.
// Run: node scripts/test-voyage.mjs
import './register-ts.mjs';
import assert from 'node:assert/strict';

const { GOODS, GOOD_IDS, goodById } = await import('../src/trade/goods.ts');
const { Economy } = await import('../src/trade/economy.ts');
const { TradeSession } = await import('../src/trade/session.ts');
const { newVoyage, porterFeePerUnit, LOAD_RATE, START_PURSE } = await import('../src/trade/voyage.ts');
const { buildSave, parseSave, writeSave, readSave, deleteSave, saveKey } = await import('../src/trade/save.ts');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const info = fn();
    passed++;
    console.log(`PASS ${name}${info ? ` (${info})` : ''}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${String(e.message).split('\n').join('\n     ')}`);
  }
}

// Synthetic profiles shaped like seed 1729 (same numbers as scripts/test-market.mjs).
const SHAPES = {
  home: { houses: 140, area: 60e6, s: { wheat: 0.14, oil: 0.1, honey: 0.08, pitch: 0.05, wine: 0.12, almonds: 0.03, fish: 0.01, firewood: 0.2 } },
  kormakos: { houses: 40, area: 4e6, s: { wheat: 0.22, oil: 0.12, honey: 0.04, pitch: 0.02, wine: 0.15, almonds: 0.05, fish: 0.03, firewood: 0.2 } },
  korkia: { houses: 30, area: 3e6, s: { wheat: 0.22, oil: 0.12, honey: 0.04, pitch: 0.02, wine: 0.15, almonds: 0.05, fish: 0.03, firewood: 0.2 } },
};
function profileOf({ houses, area, s }) {
  const features = {};
  for (const id of GOOD_IDS) features[id] = (s[id] ?? 0) * area;
  return { houses, area, features };
}
const ports3 = () => [
  { id: 0, profile: profileOf(SHAPES.home), x: 0, z: 0 },
  { id: 1, profile: profileOf(SHAPES.kormakos), x: 3000, z: 0 },
  { id: 2, profile: profileOf(SHAPES.korkia), x: 0, z: 6000 },
];
const doyAt = (T) => (((65 + Math.floor(T / 24)) % 365) + 365) % 365;
const T0 = 24 * 100 + 8; // day 100, 08:00: no midnight within the first 15 hours
const HOLD = 20.1;

function setup({ hands = 0, startT = T0, purse, manifest, cap = HOLD } = {}) {
  const economy = new Economy({ seed: 1729, ports: ports3(), doyAt, hands, startT });
  const voyage = newVoyage();
  if (purse !== undefined) voyage.purse = purse;
  if (manifest !== undefined) voyage.manifest = manifest;
  const session = new TradeSession({ economy, voyage, holdCapacity: cap });
  return { economy, voyage, session };
}

const sum = (evs, type, key) => evs.filter((e) => e.type === type).reduce((a, e) => a + e[key], 0);

// ---------- T4 voyage ----------

test('wages: a 3-day skip pays three midnights through the session; none in the pre-run', () => {
  const { voyage, session } = setup({ hands: 8 });
  const p0 = voyage.purse;
  const ev = session.tick(T0 + 72);
  const wage = ev.find((e) => e.type === 'wages');
  assert.ok(wage, 'no wages event');
  assert.equal(wage.days, 3);
  assert.equal(wage.amount, 3600);
  assert.equal(voyage.purse, p0 - 3600);
  return '3 days, 36.0 dr';
});

test('purse clamp: buys stop where the order would take the purse below zero, limitedBy purse', () => {
  const { session, voyage } = setup({ purse: 10000 });
  const lim = session.limits(0, {}, 'wheat');
  assert.equal(lim.limitedBy, 'purse');
  const q = lim.max;
  assert.ok(q > 0 && q < 100, `max ${q}`);
  assert.ok(voyage.purse + session.quote(0, { wheat: q }).total >= 0, 'max breaks the purse');
  assert.ok(voyage.purse + session.quote(0, { wheat: q + 1 }).total < 0, 'max is not the limit');
  assert.throws(() => session.confirm(0, 0, { wheat: q + 1 }), RangeError);
  session.confirm(0, 0, { wheat: q });
  assert.ok(voyage.purse >= 0);
  return `${q} sacks`;
});

test('hold clamp: buys stop at the hold volume, limitedBy hold', () => {
  // wine 70 × 0.075 = 5.25 m³ aboard; cap 5.9 leaves 0.65 m³ = 10 wheat sacks (0.065 m³ each)
  const { session } = setup({ purse: 1e12, cap: 5.9 });
  const lim = session.limits(0, {}, 'wheat');
  assert.equal(lim.limitedBy, 'hold');
  assert.equal(lim.max, 10);
  assert.throws(() => session.confirm(0, 0, { wheat: 11 }), RangeError);
  session.confirm(0, 0, { wheat: 10 });
  assert.ok(Math.abs(session.holdUse().volume - 5.9) < 1e-9);
});

test('stock clamp: buys stop at the stock floor, limitedBy stock', () => {
  const { session, economy } = setup({ purse: 1e12, cap: 1e6 });
  const m = economy.market(0, 'wheat');
  const lim = session.limits(0, {}, 'wheat');
  assert.equal(lim.limitedBy, 'stock');
  assert.equal(lim.max, m.maxBuy());
  assert.throws(() => session.confirm(0, 0, { wheat: lim.max + 1 }), RangeError);
  session.confirm(0, 0, { wheat: lim.max });
  assert.ok(m.S >= 0.05 * m.S_ref - 1e-9 && m.S < 0.05 * m.S_ref + 1, `stock ${m.S}`);
});

test('aboard clamp: sells stop at the manifest less what is already going ashore, limitedBy aboard', () => {
  const { session } = setup({ purse: 1e6 });
  const lo = session.limits(0, { wine: -5 }, 'wine');
  assert.equal(lo.min, -70);
  assert.equal(lo.limitedBy, 'aboard');
  session.confirm(0, 0, { wine: -30 });
  assert.equal(session.limits(0, {}, 'wine').min, -40, 'pending out must reduce the sellable');
  assert.throws(() => session.confirm(0, 0, { wine: -41 }), RangeError);
});

test('confirm settles money and stock at once; the manifest changes only through tick', () => {
  const { session, voyage, economy } = setup({ purse: 1e6 });
  const m = economy.market(0, 'wine');
  const S0 = m.S;
  const purse0 = voyage.purse;
  const q = session.quote(0, { wine: -30 });
  const res = session.confirm(0, 0, { wine: -30 });
  const receive = res.sold[0].total;
  assert.equal(voyage.purse - purse0, receive);
  assert.equal(receive, q.total + q.porters, 'quote total is receive less porterage');
  assert.equal(m.S, S0 + 30);
  assert.equal(voyage.manifest.wine, 70, 'manifest unchanged at confirm');
  const purse1 = voyage.purse;
  session.tick(T0 + 3);
  assert.equal(voyage.manifest.wine, 40);
  assert.equal(purse1 - voyage.purse, 30 * porterFeePerUnit(goodById('wine')));
  return `receive ${receive} c, porterage 330 c`;
});

test('porterage: charged per unit moved, ceil(0.25 · mass)', () => {
  assert.equal(porterFeePerUnit(goodById('wine')), 11);
  assert.equal(porterFeePerUnit(goodById('wheat')), 10);
  assert.equal(porterFeePerUnit(goodById('firewood')), 7);
  const { session, voyage } = setup({ purse: 1e6 });
  const q = session.quote(0, { wheat: 5 });
  assert.equal(q.porters, 50);
  const p0 = voyage.purse;
  session.confirm(0, 0, { wheat: 5 });
  const afterOrder = voyage.purse;
  session.tick(T0 + 1);
  assert.equal(afterOrder - voyage.purse, 5 * 10, 'the porterage is taken as the units move');
  void p0;
});

test('LOAD_RATE: 30 units take 3 game hours, and job-done comes with the last unit', () => {
  assert.equal(LOAD_RATE, 10);
  const { session, voyage } = setup({ purse: 1e6 });
  session.confirm(0, 0, { wheat: 30 });
  assert.equal(voyage.manifest.wheat ?? 0, 0);
  const e1 = session.tick(T0 + 1);
  assert.equal(voyage.manifest.wheat, 10);
  assert.equal(sum(e1, 'moved', 'delta'), 10);
  const e2 = session.tick(T0 + 2);
  assert.equal(voyage.manifest.wheat, 20);
  assert.ok(!e2.some((e) => e.type === 'job-done'), 'done too early');
  const e3 = session.tick(T0 + 3);
  assert.equal(voyage.manifest.wheat, 30);
  assert.deepEqual(e3.filter((e) => e.type === 'job-done'), [{ type: 'job-done', kind: 'stowed' }]);
  assert.equal(session.pendingUnits, 0);
});

test('unloading before loading: sells leave before buys come aboard', () => {
  const { session, voyage } = setup({ purse: 1e6 });
  session.confirm(0, 0, { wine: -30, wheat: 30 });
  const e1 = session.tick(T0 + 1);
  assert.equal(voyage.manifest.wine, 60, 'first hour unloads wine');
  assert.ok(!e1.some((e) => e.type === 'moved' && e.good === 'wheat'), 'wheat moved too early');
  const e3 = session.tick(T0 + 3);
  assert.equal(voyage.manifest.wine, 40);
  assert.equal(voyage.manifest.wheat ?? 0, 0, 'wheat must wait for the wine to clear');
  assert.ok(!e3.some((e) => e.type === 'job-done'), 'job done before the wheat loaded');
  const e6 = session.tick(T0 + 6);
  assert.equal(voyage.manifest.wheat, 30);
  assert.deepEqual(e6.filter((e) => e.type === 'job-done'), [{ type: 'job-done', kind: 'stowed' }], 'last kind is a load');
});

test('job-done landed, then the quay is carted off one game hour later and the job ends', () => {
  const { session, voyage } = setup({ purse: 1e6 });
  session.confirm(0, 0, { wine: -30 });
  const e3 = session.tick(T0 + 3);
  assert.deepEqual(e3.filter((e) => e.type === 'job-done'), [{ type: 'job-done', kind: 'landed' }]);
  assert.ok(voyage.job, 'job ends only after the cart');
  assert.equal(voyage.job.quay.wine, 30, 'landed units sit on the quay');
  session.tick(T0 + 3.5);
  assert.ok(voyage.job, 'still on the quay half an hour later');
  session.tick(T0 + 4);
  assert.equal(voyage.job, null);
  assert.equal(session.pendingUnits, 0);
});

test('hatches: open while a job runs and for 1 hour after it ends; castOff refused while moving, then closes them', () => {
  const { session } = setup({ purse: 1e6 });
  session.confirm(0, 0, { wheat: 30 });
  assert.equal(session.hatchesOpen(T0), true);
  assert.throws(() => session.castOff(), /still moving/);
  session.tick(T0 + 3);
  assert.equal(session.hatchesOpen(T0 + 3), true, 'job still in its hour');
  session.castOff();
  assert.equal(session.hatchesOpen(T0 + 3), false, 'cast off closes them at once');
  // a fresh sell job after cast-off reopens them
  session.confirm(0, 0, { wine: -5 });
  assert.equal(session.hatchesOpen(T0 + 3), true);
});

test('hatches close one game hour after a job ends (quay cleared at +1 h)', () => {
  const { session } = setup({ purse: 1e6 });
  session.confirm(0, 0, { wine: -30 });
  session.tick(T0 + 3);
  session.tick(T0 + 4); // quay cleared, job ends
  assert.equal(session.hatchesOpen(T0 + 4), true);
  assert.equal(session.hatchesOpen(T0 + 5), false);
});

test('hold use: aboard volume and tonnes follow the loaded units', () => {
  const { session } = setup({ purse: 1e6 });
  const h0 = session.holdUse();
  assert.ok(Math.abs(h0.volume - 70 * 0.075) < 1e-9);
  assert.ok(Math.abs(h0.tonnes - 70 * 42 / 1000) < 1e-9);
  session.confirm(0, 0, { wheat: 30 });
  session.tick(T0 + 3);
  assert.ok(Math.abs(session.holdUse().volume - (5.25 + 30 * 0.065)) < 1e-9);
});

test('quote: signed total with duty and porterage; buys negative, sells positive', () => {
  const { session, economy } = setup({ purse: 1e6 });
  const m = economy.market(0, 'wine');
  const sell = session.quote(0, { wine: -30 });
  assert.equal(sell.total, m.quoteSell(30).total - 330);
  assert.equal(sell.duty, m.quoteSell(30).duty);
  assert.equal(sell.porters, 330);
  const w = economy.market(0, 'wheat');
  const buy = session.quote(0, { wheat: 10 });
  assert.equal(buy.total, -(w.quoteBuy(10).total + 100));
});

test('wrong port: a second port cannot join a job already at another quay', () => {
  const { session } = setup({ purse: 1e6 });
  session.confirm(0, 0, { wheat: 5 });
  assert.throws(() => session.confirm(1, 0, { wine: -5 }), /another port|cargo job is at port/);
});

test('notebook ages: opened prices carry the hour seen; reopening updates them', () => {
  const { session, voyage, economy } = setup({ purse: 1e6 });
  session.noteOpened(0, T0);
  const m = economy.market(0, 'wine');
  const e0 = voyage.notebook.find((e) => e.port === 0 && e.good === 'wine');
  assert.equal(e0.T, T0);
  assert.equal(e0.ask, m.ask());
  assert.equal(e0.bid, m.bid());
  session.tick(T0 + 5);
  assert.equal(voyage.notebook.find((e) => e.port === 0 && e.good === 'wine').T, T0, 'age is now − T = 5 h');
  session.noteOpened(1, T0 + 5);
  assert.equal(voyage.notebook.filter((e) => e.port === 1).length, GOODS.length);
  session.noteOpened(0, T0 + 5);
  assert.equal(voyage.notebook.find((e) => e.port === 0 && e.good === 'wine').T, T0 + 5);
  assert.equal(voyage.notebook.length, 2 * GOODS.length, 'one entry per (port, good)');
});

test('arrivals from NPC shipments are forwarded as session events', () => {
  const { session, economy } = setup({ purse: 1e6 });
  // Force a large gap at home so shipments launch, then tick a week
  for (const g of GOODS) {
    economy.market(0, g.id).S = 3 * economy.market(0, g.id).S_ref;
    economy.market(1, g.id).S = 0.2 * economy.market(1, g.id).S_ref;
  }
  let arr = 0;
  for (let d = 1; d <= 7; d++) {
    const evs = session.tick(T0 + 24 * d);
    arr += evs.filter((e) => e.type === 'arrival').length;
  }
  assert.ok(arr > 0, 'no arrival events forwarded');
});

// ---------- T6 save ----------

test('save: round trip through JSON; restored session equals the continuous one at day 90', () => {
  const startT = T0 + 0.25;
  const run = (session, from, to) => {
    for (let t = from; t <= to + 1e-9; t += 24) session.tick(t);
  };
  // A: trade, tick to day 37, save, carry on to day 90 with a later trade
  const A = setup({ hands: 8, startT, purse: 1e6 });
  A.session.confirm(0, 0, { wine: -30 });
  run(A.session, startT + 24, startT + 37 * 24);
  assert.equal(A.voyage.job, null, 'save only while docked');
  const snap = A.economy.snapshot();
  const json = JSON.stringify(
    buildSave({
      seed: 1729, heightmapSize: 2048,
      clock: { dayCount: 137, hours: 0.25, dayOfYear: 102, moonPhase: 0.4 },
      windTime: 1234.5, berth: { id: 0, bowOut: true },
      voyage: A.voyage, economy: snap, savedAt: 42,
    }),
  );
  const parsed = parseSave(json, 1729, 2048);
  assert.ok(parsed, 'save rejected');

  // B: fresh economy and session from the save
  const econB = new Economy({ seed: 1729, ports: ports3(), doyAt, hands: 8, startT });
  econB.restore(parsed.economy);
  const voyB = parsed.voyage;
  const sessB = new TradeSession({ economy: econB, voyage: voyB, holdCapacity: HOLD });

  for (const s of [A, { session: sessB, economy: econB, voyage: voyB }]) {
    s.session.tick(startT + 37 * 24 + 24); // the same day for both
  }
  A.session.confirm(0, 0, { wine: -10 });
  sessB.confirm(0, 0, { wine: -10 });
  run(A.session, startT + 38 * 24 + 24, startT + 90 * 24);
  run(sessB, startT + 38 * 24 + 24, startT + 90 * 24);

  assert.equal(A.voyage.purse, voyB.purse, 'purse');
  assert.equal(JSON.stringify(A.voyage.manifest), JSON.stringify(voyB.manifest), 'manifest');
  assert.equal(JSON.stringify(A.voyage.notebook), JSON.stringify(voyB.notebook), 'notebook');
  assert.equal(JSON.stringify(A.economy.snapshot()), JSON.stringify(econB.snapshot()), 'economy');
  return `purse ${(voyB.purse / 100).toFixed(1)} dr`;
});

test('save: a mismatched seed, heightmap or version is ignored with a warning, never thrown', () => {
  const { economy, voyage } = setup({ purse: 1e6 });
  const json = JSON.stringify(
    buildSave({
      seed: 1729, heightmapSize: 2048,
      clock: { dayCount: 1, hours: 0, dayOfYear: 1, moonPhase: 0 },
      windTime: 0, berth: { id: 0, bowOut: true }, voyage, economy: economy.snapshot(),
    }),
  );
  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    assert.ok(parseSave(json, 1729, 2048), 'the matching save is refused');
    assert.equal(parseSave(json, 1, 2048), null, 'seed mismatch');
    assert.equal(parseSave(json, 1729, 1024), null, 'heightmap mismatch');
    assert.equal(parseSave(json.replace('"v":1', '"v":2'), 1729, 2048), null, 'version mismatch');
    assert.equal(parseSave('{not json', 1729, 2048), null, 'corrupt');
    assert.equal(parseSave('[]', 1729, 2048), null, 'not an object');
    assert.equal(parseSave('{"v":1,"seed":1729,"heightmapSize":2048}', 1729, 2048), null, 'malformed');
  } finally {
    console.warn = orig;
  }
  assert.equal(warnings.length, 6);
  return '6 warnings';
});

test('save: storage absent or a stub, so write and delete report false and read returns null', () => {
  const { economy, voyage } = setup({ purse: 1e6 });
  const data = buildSave({
    seed: 1729, heightmapSize: 2048,
    clock: { dayCount: 1, hours: 0, dayOfYear: 1, moonPhase: 0 },
    windTime: 0, berth: { id: 0, bowOut: true }, voyage, economy: economy.snapshot(),
  });
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    // no global at all
    delete globalThis.localStorage;
    assert.equal(writeSave(1729, 2048, data), false);
    assert.equal(readSave(1729, 2048), null);
    assert.equal(deleteSave(1729, 2048), false);
    // a stub without the methods (Node's global) behaves the same
    Object.defineProperty(globalThis, 'localStorage', { value: {}, configurable: true, writable: true });
    assert.equal(writeSave(1729, 2048, data), false);
    assert.equal(readSave(1729, 2048), null);
    assert.equal(deleteSave(1729, 2048), false);
    // a working store round-trips and deletes
    const m = new Map();
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
      },
      configurable: true, writable: true,
    });
    assert.equal(writeSave(1729, 2048, data), true);
    assert.ok(m.has(saveKey(1729, 2048)));
    const back = readSave(1729, 2048);
    assert.ok(back, 'round trip failed');
    assert.equal(back.voyage.purse, voyage.purse);
    assert.equal(readSave(1729, 1024), null, 'another world has no save');
    assert.equal(deleteSave(1729, 2048), true);
    assert.equal(readSave(1729, 2048), null);
  } finally {
    if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
    else delete globalThis.localStorage;
  }
  assert.equal(saveKey(1729, 2048), 'trieres.voyage.v1.1729.2048');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
