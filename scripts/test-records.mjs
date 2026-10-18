// Lane B records tests (pass 1c): idempotent adds, warmth, let-down, overdue stages and the trust limit.
// Headless, hand-made world with no economy. Run: node scripts/test-records.mjs
import './register-ts.mjs';
import assert from 'node:assert/strict';

const { addRecord, letDown, warmth, overdueTimes, stage, trustLimit, beliefsOf } = await import(
  '../src/social/records.ts'
);

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

const agreement = (id, owner, expectedT) => ({
  id, proposal: 'P1', revision: 1, owner, terms: {}, acceptedT: 0, expectedT,
  loaded: 0, sold: 0, returned: 0, reserved: 0, closedT: null, settledT: null,
});
const settled = (id, T, agr, { value = 100, full = true, onTime = true, source = 'witnessed' } = {}) => ({
  id, holder: 'damaris', T, source, kind: 'settled', facts: { agreement: agr, value, amount: 0, full, onTime },
});
const news = (id, T) => ({ id, holder: 'damaris', T, source: 'news', kind: 'letter-shown', facts: {} });
const worldOf = ({ warmth0 = 0, trustBase = 0, agreements = [], records = [] } = {}) => ({
  version: 2,
  characters: [{ id: 'damaris', port: 0, wallet: 0, reserved: 0, trustBase, warmth0 }],
  lots: [], nextId: 1, receipts: [], proposals: [], agreements, mail: [], results: {}, records,
  celebration: null,
});

test('addRecord is idempotent on id', () => {
  const w = worldOf();
  const r = news('damaris:letter:1', 5);
  assert.equal(addRecord(w, r), true);
  assert.equal(addRecord(w, { ...r, T: 9 }), false);
  assert.equal(w.records.length, 1);
  assert.equal(w.records[0].T, 5);
  assert.notEqual(w.records[0], r);
});

test('warmth: news letter +1, first full settlement in person +1 only once per agreement, clamped', () => {
  const a = agreement('A1', 'damaris', 500);
  const w = worldOf({ warmth0: -2, agreements: [a] });
  addRecord(w, news('l1', 1));
  assert.equal(warmth(w, 'damaris', 1), -1);
  addRecord(w, settled('s1', 2, 'A1'));
  assert.equal(warmth(w, 'damaris', 2), 0);
  addRecord(w, settled('s2', 3, 'A1'));
  assert.equal(warmth(w, 'damaris', 3), 0);
  addRecord(w, news('l2', 4));
  addRecord(w, news('l3', 5));
  assert.equal(warmth(w, 'damaris', 5), 2);
  addRecord(w, news('l4', 6));
  assert.equal(warmth(w, 'damaris', 6), 2);
  return `${warmth(w, 'damaris', 6)}`;
});

test('letDown: boundary at expectT; a witnessed settlement by expectT clears it', () => {
  const w = worldOf({ agreements: [agreement('A1', 'damaris', 100)] });
  const [b] = beliefsOf(w, 'damaris');
  assert.equal(b.firmness, 'tentative');
  assert.equal(letDown(w, b, 100), false);
  assert.equal(letDown(w, b, 100.5), true);
  addRecord(w, settled('s1', 100, 'A1'));
  assert.equal(letDown(w, b, 101), false);
});

test('stage: exact overdueT and longT boundaries for w=0 and w=1', () => {
  for (const w0 of [0, 1]) {
    const a = agreement('A1', 'damaris', 1000);
    const w = worldOf({ warmth0: w0, agreements: [a] });
    const { overdueT, longT } = overdueTimes(w, a, 0);
    assert.equal(overdueT, 1000 + 24 * w0);
    assert.equal(longT, overdueT + 24 * (14 + 3 * w0));
    assert.equal(stage(w, a, overdueT - 0.5), 'none');
    assert.equal(stage(w, a, overdueT), 'overdue');
    assert.equal(stage(w, a, longT - 0.5), 'overdue');
    assert.equal(stage(w, a, longT), 'long-overdue');
  }
});

test('stage: a time jump matches checking every hour between two times', () => {
  const a = agreement('A1', 'damaris', 1000);
  const w = worldOf({ agreements: [a] });
  addRecord(w, news('l1', 1100));
  const hourly = [];
  for (let t = 990; t <= 1500; t++) hourly.push(stage(w, a, t));
  assert.ok(hourly.includes('overdue') && hourly.includes('long-overdue'));
  assert.equal(stage(w, a, 1500), hourly.at(-1));
  assert.equal(stage(w, a, 1100), hourly[110]);
});

test('trustLimit: raise on time, raise when late, halving, 0 while overdue', () => {
  const onTime = worldOf({ trustBase: 100, agreements: [agreement('A1', 'damaris', 10)], records: [] });
  addRecord(onTime, settled('s1', 5, 'A1', { value: 300 }));
  assert.equal(trustLimit(onTime, 'damaris', 20), 600);

  const late = worldOf({ agreements: [agreement('A1', 'damaris', 10)] });
  addRecord(late, settled('s1', 5, 'A1', { value: 80, onTime: false }));
  assert.equal(trustLimit(late, 'damaris', 20), 80);

  const halved = worldOf({ trustBase: 100, agreements: [agreement('A1', 'damaris', 10)] });
  addRecord(halved, { id: 'h1', holder: 'damaris', T: 5, source: 'witnessed', kind: 'sold-below',
    facts: { agreement: 'A1', receipt: 'X1', unit: 1, heardBid: 2 } });
  assert.equal(trustLimit(halved, 'damaris', 5), 50);

  const overdue = worldOf({ trustBase: 100, agreements: [agreement('A1', 'damaris', 10)] });
  assert.equal(trustLimit(overdue, 'damaris', 9), 100);
  assert.equal(trustLimit(overdue, 'damaris', 10), 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
