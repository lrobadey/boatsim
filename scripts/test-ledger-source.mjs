// Ledger source tests (cargo-trade-spec §6.3, §9): the adapter in src/ui/ledgerSource.ts over a real
// TradeSession and a synthetic 2-port Economy. Headless. Run: node scripts/test-ledger-source.mjs
import './register-ts.mjs';
import assert from 'node:assert/strict';

const { GOODS, GOOD_IDS } = await import('../src/trade/goods.ts');
const { Economy, referenceFlows } = await import('../src/trade/economy.ts');
const { newVoyage } = await import('../src/trade/voyage.ts');
const { addOrder, newJob } = await import('../src/trade/job.ts');
const { handlingStatus } = await import('../src/trade/handlingStatus.ts');
const { tradeLedgerSource } = await import('../src/ui/ledgerSource.ts');

let TradeSession;
try {
  ({ TradeSession } = await import('../src/trade/session.ts'));
} catch (e) {
  console.log('FAIL src/trade/session.ts is not in place, so the adapter cannot be exercised');
  console.log('     ' + String(e.message).split('\n')[0]);
  process.exit(1);
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${String(e.message).split('\n').join('\n     ')}`);
  }
}

// Two synthetic ports shaped like seed 1729's home and Kormakos (test-market.mjs §16.1).
const SHAPES = {
  home: { houses: 140, area: 60e6, s: { wheat: 0.14, oil: 0.1, honey: 0.08, pitch: 0.05, wine: 0.12, almonds: 0.03, fish: 0.01, firewood: 0.2 } },
  kormakos: { houses: 40, area: 4e6, s: { wheat: 0.22, oil: 0.12, honey: 0.04, pitch: 0.02, wine: 0.15, almonds: 0.05, fish: 0.03, firewood: 0.2 } },
};
function profileOf({ houses, area, s }) {
  const features = {};
  for (const id of GOOD_IDS) features[id] = (s[id] ?? 0) * area;
  return { houses, area, features };
}
const DOY0 = 65;
const doyAt = (T) => (((DOY0 + Math.floor(T / 24)) % 365) + 365) % 365;
const T_START = 24 * 100 + 8;
const ports = () => [
  { id: 0, profile: profileOf(SHAPES.home), x: 0, z: 0 },
  { id: 1, profile: profileOf(SHAPES.kormakos), x: 3000, z: 0 },
];

const economy = new Economy({ seed: 1729, ports: ports(), doyAt, hands: 8, startT: T_START });
const voyage = newVoyage();
const session = new TradeSession({ economy, voyage, holdCapacity: 21.8 });
let T = T_START;
const portNames = { 0: 'Serrothos', 1: 'Kormakos' };
const make = (over = {}) =>
  tradeLedgerSource({
    session,
    port: 0,
    portName: 'Serrothos',
    berth: 0,
    mode: 'trade',
    clock: () => ({ dayCount: 100, hours: 8 }),
    T: () => T,
    wagesPerDay: 1200,
    holdCapacity: 21.8,
    portNames,
    ...over,
  });

test('time scale fields expose the live clock and delegate bracket factors', () => {
  let scale = 4;
  const calls = [];
  const src = make({ timeScale: () => scale, changeTimeSpeed: (factor) => { calls.push(factor); scale = Math.max(1, Math.min(480, scale * factor)); } });
  assert.equal(src.timeScale, 4);
  src.changeTimeSpeed(0.5);
  assert.equal(src.timeScale, 2);
  src.changeTimeSpeed(2);
  assert.equal(src.timeScale, 4);
  assert.deepEqual(calls, [0.5, 2]);
  assert.ok(make().timeScale === undefined, 'static sources can omit time scale fields');
});

test('rows: eight goods in table order, stock floored, ask and bid from the market, aboard from the session', () => {
  const src = make();
  const rows = src.rows();
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.map((r) => r.id), GOODS.map((g) => g.id));
  const m = economy.market(0, 'wine');
  const wine = rows[0];
  assert.equal(wine.stock, Math.floor(m.S));
  assert.equal(wine.buy, m.ask());
  assert.equal(wine.sell, m.bid());
  assert.equal(wine.aboard, 70);
  assert.equal(wine.massKg, GOODS[0].mass);
  assert.equal(wine.stowM3, GOODS[0].stow);
  assert.equal(rows[2].aboard, 0);
});

test('hold mode: rows list only the goods aboard', () => {
  const rows = make({ mode: 'hold' }).rows();
  assert.deepEqual(rows.map((r) => r.id), ['wine']);
});

test('quote delegates to the session', () => {
  const src = make();
  const orders = { wine: -10 };
  assert.deepEqual(src.quote(orders), { ...session.quote(0, orders), handlingHours: 1.05 });
});

test('limits: min is −aboard for sells; the row\'s own entry does not change the result', () => {
  const src = make();
  const lim = src.limits({}, 'wine');
  assert.equal(lim.min, -70);
  assert.deepEqual(src.limits({ wine: 5 }, 'wine'), lim);
  assert.ok([null, 'purse', 'hold', 'stock'].includes(lim.limitedBy), `limitedBy ${lim.limitedBy}`);
  assert.notEqual(lim.limitedBy, 'aboard');
});

test('lost berth changes trade to read-only and rejects confirmation before session mutation', () => {
  let connected = true;
  const src = make({ canTrade: () => connected });
  assert.equal(src.mode, 'trade');
  const purse = voyage.purse;
  const stock = economy.market(0, 'wheat').S;
  connected = false;
  assert.equal(src.mode, 'read');
  assert.throws(() => src.confirm({ wheat: 1 }), RangeError);
  assert.equal(voyage.purse, purse);
  assert.equal(economy.market(0, 'wheat').S, stock);
  assert.equal(make({ mode: 'hold', canTrade: () => false }).mode, 'hold', 'Hold remains available while away from the berth');
});

test('jobLine uses shared paused and ready status', () => {
  const pausedVoyage = newVoyage();
  pausedVoyage.job = newJob(0, 0);
  addOrder(pausedVoyage.job, {}, { honey: 1 });
  pausedVoyage.job.active = { good: 'honey', direction: 'load', workKg: 5 };
  const pausedSession = new TradeSession({ economy, voyage: pausedVoyage, holdCapacity: 21.8 });
  const context = { connected: false, portName: 'Serrothos' };
  const pausedSource = make({ session: pausedSession, handlingContext: () => context });
  const paused = handlingStatus(pausedVoyage.job, T, pausedVoyage.hatchUntil, context);
  assert.equal(paused.phase, 'paused');
  assert.equal(pausedSource.jobLine, `${paused.label} · ${paused.detail}`);

  const readyVoyage = newVoyage();
  readyVoyage.job = newJob(0, 0);
  readyVoyage.job.cartAt = T + 1;
  const readySession = new TradeSession({ economy, voyage: readyVoyage, holdCapacity: 21.8 });
  const readySource = make({ session: readySession });
  const ready = handlingStatus(readyVoyage.job, T, readyVoyage.hatchUntil, { connected: true, portName: 'Serrothos' });
  assert.equal(ready.phase, 'ready');
  assert.equal(readySource.jobLine, `${ready.label} · ${ready.detail}`);
});

test('confirm: money and stock move at once, aboard moves with pending units, toast lines match the Line results', () => {
  const src = make();
  const orders = { wine: -10, wheat: 20 };
  const before = voyage.purse;
  const q = session.quote(0, orders);
  const wheatStock = economy.market(0, 'wheat').S;
  const wineStock = economy.market(0, 'wine').S;
  const lines = src.confirm(orders);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Sold 10 wine · \d[\d ]*\.\d dr$/);
  assert.match(lines[1], /^Bought 20 wheat · \d[\d ]*\.\d dr$/);
  // money moves at once: the quoted total less the porterage, which is charged as each unit moves (§6.2)
  assert.equal(voyage.purse, before + q.total + q.porters, 'purse moves by the quoted money at once');
  assert.ok(Math.abs(economy.market(0, 'wheat').S - (wheatStock - 20)) < 1e-9, 'wheat stock falls');
  assert.ok(Math.abs(economy.market(0, 'wine').S - (wineStock + 10)) < 1e-9, 'wine stock rises');
  assert.equal(session.aboard('wine'), 60);
  assert.equal(session.aboard('wheat'), 20);
  let rows = src.rows();
  assert.equal(rows.find((r) => r.id === 'wine').aboard, 70, 'wine remains physically aboard before handling');
  assert.equal(rows.find((r) => r.id === 'wine').committed, 60, 'confirmed sale is reflected in committed cargo');
  assert.equal(rows.find((r) => r.id === 'wheat').aboard, 0, 'purchased wheat is not aboard before handling');
  assert.equal(rows.find((r) => r.id === 'wheat').committed, 20, 'confirmed purchase is reflected in committed cargo');
  const holdRows = make({ mode: 'hold' }).rows();
  assert.ok(holdRows.some((r) => r.id === 'wheat' && r.aboard === 0 && r.committed === 20), 'Hold lists an incoming good without presenting it as physically aboard');
  assert.ok(Math.abs(src.hold.tonnes - 2.94) < 1e-9, 'main hold total reflects the physical manifest');
  assert.ok(Math.abs(src.committedHold.tonnes - 3.32) < 1e-9, 'committed footer reflects confirmed obligations');
  T += 0.11;
  session.tick(T);
  rows = src.rows();
  assert.equal(rows.find((r) => r.id === 'wine').aboard, 69, 'one wine jar leaves the physical manifest after 0.105 game hours');
  assert.equal(rows.find((r) => r.id === 'wine').committed, 60, 'committed total remains the final post-handling quantity');
  assert.equal(rows.find((r) => r.id === 'wheat').aboard, 0, 'incoming wheat waits for outgoing wine handling');
  assert.ok(Math.abs(src.hold.tonnes - 2.898) < 1e-9, 'physical footer changes only when the package crosses');
});

test('jobLine names the scheduler-selected good and shows the pending count', () => {
  const src = make();
  assert.ok(voyage.job, 'a job exists after confirm');
  assert.equal(src.jobLine, 'Unloading wine · 29 left · 1.2 t to handle · 2 h 57 min');
  assert.equal(session.pendingUnits, 29);

  const honeyVoyage = newVoyage();
  honeyVoyage.job = newJob(0, 0);
  addOrder(honeyVoyage.job, {}, { honey: 1 });
  honeyVoyage.job.active = { good: 'honey', direction: 'load', workKg: 0 };
  honeyVoyage.manifest.wheat = 1;
  honeyVoyage.job.outgoing.wheat = 1;
  const honeySession = new TradeSession({ economy, voyage: honeyVoyage, holdCapacity: 21.8 });
  assert.equal(make({ session: honeySession }).jobLine, 'Loading honey · 2 left · 65 kg to handle · 10 min');
});

test('notebook: opened() writes this port; other ports read null until seen; ages count from T', () => {
  const src = make();
  T = T_START + 1000;
  src.opened();
  const nb = src.notebook();
  assert.deepEqual(nb.ports, ['Serrothos', 'Kormakos']);
  assert.equal(nb.current, 0);
  assert.equal(nb.rows.length, 8);
  const wineHome = nb.rows[0].cells[0];
  assert.ok(wineHome, 'the current port is written by opened()');
  assert.equal(wineHome.ageHours, 0);
  assert.equal(nb.rows[0].cells[1], null, 'Kormakos not seen yet');
  // see Kormakos at T, then read five hours later
  session.noteOpened(1, T);
  T += 5;
  const nb2 = src.notebook();
  assert.equal(nb2.rows[0].cells[1].ageHours, 5);
  assert.equal(nb2.rows[0].cells[1].ask, economy.market(1, 'wine').ask());
});

test('timeLabel: day is dayCount + 1; hh:mm from the fractional hour', () => {
  const src = make({ clock: () => ({ dayCount: 2, hours: 14 + 20 / 60 }) });
  assert.equal(src.timeLabel, 'Day 3 · 14:20');
});

test('purse, hold, wages and portName come from the session and options', () => {
  const src = make();
  assert.equal(src.purse, voyage.purse);
  assert.equal(src.wagesPerDay, 1200);
  assert.equal(src.portName, 'Serrothos');
  assert.equal(src.mode, 'trade');
  const h = src.hold;
  assert.equal(h.capacity, 21.8);
  let used = 0;
  let tonnes = 0;
  for (const g of GOODS) {
    used += (voyage.manifest[g.id] ?? 0) * g.stow;
    tonnes += ((voyage.manifest[g.id] ?? 0) * g.mass) / 1000;
  }
  assert.ok(Math.abs(h.used - used) < 1e-9, `used ${h.used} vs ${used}`);
  assert.ok(Math.abs(h.tonnes - tonnes) < 1e-9, `tonnes ${h.tonnes} vs ${tonnes}`);
  assert.ok(Math.abs(src.committedHold.used - session.holdUse().volume) < 1e-9, 'committed footer comes from the session projection');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
