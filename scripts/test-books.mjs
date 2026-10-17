// Pass 1a gate: what the golden trace cannot see (docs/pass-1a-contract.md): books stay consistent through a
// real flow and a save round trip, a v1 save migrates, and bad saves are kept aside, never deleted.
// Run: node scripts/test-books.mjs
import './register-ts.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { GOOD_IDS } = await import('../src/trade/goods.ts');
const { Economy } = await import('../src/trade/economy.ts');
const { TradeSession } = await import('../src/trade/session.ts');
const { newVoyage } = await import('../src/trade/voyage.ts');
const { checkBooks } = await import('../src/trade/books.ts');
const { buildSave, parseSave, parseAnySave, loadSave, writeSave, deleteSave, saveKey, legacySaveKey, rejectedSaveKey } = await import('../src/trade/save.ts');

let passed = 0;
let failed = 0;
function test(name, fn) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e.stack ?? e.message).split('\n').slice(0, 5).join('\n     ')}`); }
  finally { if (desc) Object.defineProperty(globalThis, 'localStorage', desc); else delete globalThis.localStorage; }
}

const SHAPES = [
  { houses: 140, area: 60e6, s: { wheat: 0.14, oil: 0.1, honey: 0.08, pitch: 0.05, wine: 0.12, almonds: 0.03, fish: 0.01, firewood: 0.2 } },
  { houses: 40, area: 4e6, s: { wheat: 0.22, oil: 0.12, honey: 0.04, pitch: 0.02, wine: 0.15, almonds: 0.05, fish: 0.03, firewood: 0.2 } },
  { houses: 30, area: 3e6, s: { wheat: 0.22, oil: 0.12, honey: 0.04, pitch: 0.02, wine: 0.15, almonds: 0.05, fish: 0.03, firewood: 0.2 } },
];
// the same three ports as the golden trace (scripts/test-trade-golden.mjs), so its v1 fixtures restore
const ports = () => SHAPES.map(({ houses, area, s }, id) => ({ id, x: id === 1 ? 3000 : 0, z: id === 2 ? 6000 : 0, profile: { houses, area, features: Object.fromEntries(GOOD_IDS.map((g) => [g, (s[g] ?? 0) * area])) } }));
const doyAt = (T) => (((65 + Math.floor(T / 24)) % 365) + 365) % 365;
const T0 = 24 * 100 + 8;
const SEED = 1729, SIZE = 2048;
const newEconomy = () => new Economy({ seed: SEED, ports: ports(), doyAt, hands: 0, startT: T0 });
const CLOCK = { dayCount: 100, hours: 8.5, dayOfYear: 165, moonPhase: 0.25 };
const bookSave = (v, e, extra = {}) => buildSave({ seed: SEED, heightmapSize: SIZE, clock: CLOCK, windTime: 1, berth: { id: 0, bowOut: true }, voyage: v, economy: e.snapshot(), savedAt: 1760000000123, ...extra });

/** checkBooks plus the two views, restated here so a no-op checkBooks cannot hide a break. */
function ok(v, label) {
  checkBooks(v);
  assert.equal(v.purse, v.receipts.reduce((a, r) => a + r.amount, 0), `${label}: purse !== sum of receipts`);
  const aboard = {};
  for (const l of v.lots) if (l.custody.at === 'aboard') aboard[l.good] = (aboard[l.good] ?? 0) + l.qty;
  assert.deepEqual(v.manifest, aboard, `${label}: manifest !== aboard lots`);
}
const qty = (v, f) => v.lots.filter(f).reduce((a, l) => a + l.qty, 0);
const run = (s, v, steps, dt, label) => { for (let i = 0; i < steps; i++) { s.tick(s.economy.now + dt); ok(v, `${label} ${i}`); } };

test('flow: sell wine + buy wheat, tick to completion, save round trip, carry on; books valid at every step', () => {
  const economy = newEconomy();
  const voyage = newVoyage();
  const session = new TradeSession({ economy, voyage, holdCapacity: 20.1 });
  ok(voyage, 'new');
  assert.deepEqual(voyage.lots.map((l) => [l.owner, l.good, l.qty, l.origin]), [['player', 'wine', 70, 'opening']]);
  session.confirm(0, 0, { wine: -30, wheat: 10 });
  ok(voyage, 'confirm');
  // a sold jar still aboard belongs to the port; a bought jar on the quay is the player's
  assert.equal(qty(voyage, (l) => l.owner === 'market:0' && l.custody.at === 'aboard' && l.good === 'wine'), 30);
  assert.equal(qty(voyage, (l) => l.owner === 'player' && l.custody.at === 'aboard' && l.good === 'wine'), 40);
  assert.equal(qty(voyage, (l) => l.owner === 'player' && l.custody.at === 'quay' && l.good === 'wheat'), 10);
  assert.equal(voyage.manifest.wine, 70, 'manifest changes only as jars move');
  for (let i = 0; i < 30; i++) {
    session.tick(economy.now + 0.2);
    ok(voyage, `tick ${i}`);
    const out = qty(voyage, (l) => l.owner === 'market:0' && l.custody.at === 'aboard');
    assert.equal(out, voyage.job?.outgoing.wine ?? 0, 'market aboard lots follow job.outgoing');
    assert.equal(qty(voyage, (l) => l.owner === 'player' && l.custody.at === 'quay'), voyage.job?.incoming.wheat ?? 0, 'player quay follows job.incoming');
    if (i === 1) {
      // save mid-job, restore into a fresh session, and carry on from there
      const back = parseSave(JSON.stringify(bookSave(voyage, economy)), SEED, SIZE);
      assert.ok(back, 'a mid-job v2 save must parse');
      assert.deepEqual(back.voyage.lots, voyage.lots);
      assert.deepEqual(back.voyage.receipts, voyage.receipts);
      assert.equal(back.voyage.nextId, voyage.nextId);
      assert.equal(back.voyage.purse, voyage.purse);
    }
  }
  assert.equal(voyage.job, null);
  assert.deepEqual(voyage.manifest, { wine: 40, wheat: 10 });
  assert.equal(voyage.lots.length, 2);
  assert.ok(voyage.lots.every((l) => l.owner === 'player' && l.custody.at === 'aboard'), 'nothing left on the quay');
  const back = parseSave(JSON.stringify(bookSave(voyage, economy)), SEED, SIZE);
  const economy2 = newEconomy();
  economy2.restore(back.economy);
  const session2 = new TradeSession({ economy: economy2, voyage: back.voyage, holdCapacity: 20.1 });
  session2.confirm(0, 0, { wine: -5 });
  run(session2, back.voyage, 20, 0.2, 'after load');
  assert.deepEqual(back.voyage.manifest, { wine: 35, wheat: 10 });
});

test('a v1 save mid-unload migrates: lot mapping, notebook kept, notes re-keyed, ticks to completion', () => {
  const d = JSON.parse(fs.readFileSync(new URL('./golden/trade-v1/mid-unload.json', import.meta.url), 'utf8'));
  d.talk = { news: [], notes: { 0: 'Old friend.', 1: 'Short weights.' } };
  const m = parseAnySave(JSON.stringify(d), SEED, SIZE);
  assert.ok(m, 'v1 fixture refused');
  const v = m.voyage;
  ok(v, 'migrated');
  assert.equal(m.v, 2);
  assert.ok(v.lots.every((l) => l.origin === 'migrated'));
  const job = d.voyage.job;
  const at = (f) => qty(v, f);
  assert.equal(at((l) => l.owner === 'player' && l.custody.at === 'aboard' && l.good === 'wine'), d.voyage.manifest.wine - job.outgoing.wine);
  assert.equal(at((l) => l.owner === `market:${job.port}` && l.custody.at === 'aboard' && l.good === 'wine'), job.outgoing.wine);
  assert.equal(at((l) => l.owner === 'player' && l.custody.at === 'quay' && l.good === 'honey'), job.incoming.honey);
  assert.equal(at((l) => l.owner === `market:${job.port}` && l.custody.at === 'quay' && l.good === 'wine'), job.quay.wine, 'landed jars wait for the cart');
  assert.deepEqual(v.receipts.map((r) => [r.kind, r.amount, r.T]), [['opening', d.voyage.purse, d.economy.T]]);
  assert.equal(v.purse, d.voyage.purse);
  assert.deepEqual(v.notebook, d.voyage.notebook, 'notebook carried over unchanged');
  assert.deepEqual(m.talk.notes, { 'trader:0': 'Old friend.', 'trader:1': 'Short weights.' });
  const economy = newEconomy();
  economy.restore(m.economy);
  const session = new TradeSession({ economy, voyage: v, holdCapacity: 20.1 });
  run(session, v, 40, 0.2, 'migrated');
  assert.equal(v.job, null);
  assert.deepEqual(v.manifest, { wine: d.voyage.manifest.wine - job.outgoing.wine, honey: 2, pitch: 3 });
  assert.ok(v.lots.every((l) => l.owner === 'player' && l.custody.at === 'aboard'));
});

// ---------- save safety, with an in-memory localStorage ----------

function store({ lieAbout } = {}) {
  const m = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: {
    getItem: (k) => (lieAbout?.(k) ?? (m.has(k) ? m.get(k) : null)),
    setItem: (k, x) => void m.set(k, String(x)),
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  } });
  return m;
}
const v1Text = () => fs.readFileSync(new URL('./golden/trade-v1/mid-unload.json', import.meta.url), 'utf8');
const v2Data = () => { const economy = newEconomy(); return bookSave(newVoyage(), economy); };

test('an unreadable save is kept aside byte for byte and never deleted; loading a v1 save leaves it in place', () => {
  const m = store();
  const bad = JSON.stringify({ ...v2Data(), voyage: { ...v2Data().voyage, purse: 1 } }, null, 1); // books fail, savedAt readable
  m.set(saveKey(SEED, SIZE), bad);
  const r = loadSave(SEED, SIZE);
  assert.deepEqual(r, { status: 'rejected', key: rejectedSaveKey(SEED, SIZE, 1760000000123) });
  assert.equal(m.get(r.key), bad);
  assert.equal(m.has(saveKey(SEED, SIZE)), false);
  assert.equal(deleteSave(SEED, SIZE), true);
  assert.equal(m.get(r.key), bad, 'deleteSave never touches a rejected key');
  assert.deepEqual(loadSave(SEED, SIZE), { status: 'none' });
  m.set(legacySaveKey(SEED, SIZE), v1Text());
  const l = loadSave(SEED, SIZE);
  assert.equal(l.status === 'ok' && l.from, 'v1');
  assert.equal(m.get(legacySaveKey(SEED, SIZE)), v1Text(), 'v1 stays until a v2 write is confirmed');
  m.set(saveKey(SEED, SIZE), 'garbage');
  const g = loadSave(SEED, SIZE);
  assert.equal(g.status, 'rejected');
  assert.equal(m.get(g.key), 'garbage');
});

test('writeSave removes v1 only after v2 reads back; deleteSave removes v2 and v1', () => {
  const m = store();
  m.set(legacySaveKey(SEED, SIZE), v1Text());
  m.set(rejectedSaveKey(SEED, SIZE, 7), 'kept');
  assert.equal(writeSave(SEED, SIZE, v2Data()), true);
  assert.ok(parseSave(m.get(saveKey(SEED, SIZE)), SEED, SIZE));
  assert.equal(m.has(legacySaveKey(SEED, SIZE)), false);
  assert.equal(deleteSave(SEED, SIZE), true);
  assert.deepEqual([...m.keys()], [rejectedSaveKey(SEED, SIZE, 7)]);
  const m2 = store({ lieAbout: (k) => (k === saveKey(SEED, SIZE) ? '{"corrupt' : undefined) });
  m2.set(legacySaveKey(SEED, SIZE), v1Text());
  assert.equal(writeSave(SEED, SIZE, v2Data()), false, 'read-back failed');
  assert.equal(m2.get(legacySaveKey(SEED, SIZE)), v1Text(), 'v1 survives a failed write');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
