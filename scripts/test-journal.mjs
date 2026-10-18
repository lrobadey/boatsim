// Pass 3: the personal menu's lines come from the books and records (src/social/journal.ts), and a fresh opening
// voyage starts with 300 dr and an empty hold. Run: node scripts/test-journal.mjs
import './register-ts.mjs';
import assert from 'node:assert/strict';

const { GOOD_IDS } = await import('../src/trade/goods.ts');
const { Economy } = await import('../src/trade/economy.ts');
const { TradeSession } = await import('../src/trade/session.ts');
const { openingVoyage } = await import('../src/trade/voyage.ts');
const { freshWorld } = await import('../src/trade/world.ts');
const { Dealings } = await import('../src/trade/consignment.ts');
const { SocialActions } = await import('../src/social/actions.ts');
const { journalView } = await import('../src/social/journal.ts');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e.stack ?? e.message).split('\n').slice(0, 8).join('\n     ')}`); }
}

const shape = (houses, area, wine) => ({ houses, area, features: Object.fromEntries(GOOD_IDS.map((id) => [id, (id === 'wine' ? wine : 0.1) * area])) });
const ports = [[shape(140, 60e6, 0.12), 0, 0], [shape(40, 4e6, 0.15), 3000, 0], [shape(30, 3e6, 0.15), 0, 6000]].map(([profile, x, z], id) => ({ id, profile, x, z }));
const world = freshWorld({ ports, celebrationDay: 17 });
const economy = new Economy({ seed: 1729, ports, doyAt: (T) => (65 + Math.floor(T / 24)) % 365, hands: 0, startT: 7.4, noShocks: true });
const voyage = openingVoyage();
const session = new TradeSession({ economy, voyage, holdCapacity: 20.1, world });
const dealings = new Dealings({ world, session, heardBid: () => null });
const social = new SocialActions({ world, now: () => economy.now });
const names = { damaris: 'Damaris', philon: 'Philon', myrto: 'Myrto' };
const view = () => journalView({
  world, voyage, now: economy.now, names: (id) => names[id], portNames: { 0: 'Serrothos', 1: 'Kormakos', 2: 'Korkia' },
  dateWords: (T) => `day ${Math.floor(T / 24) + 1}`, account: (id) => dealings.account(id),
});

test('the opening voyage: 300 dr, nothing aboard, nothing to show', () => {
  assert.equal(voyage.purse, 30000);
  assert.deepEqual(voyage.manifest, {});
  assert.equal(voyage.lots.length, 0);
  const v = view();
  assert.deepEqual(v.belongings, []);
  assert.deepEqual(v.cargo, []);
  assert.deepEqual(v.expectations, []);
  assert.equal(v.accounts.purse, '300.0 dr');
});

test('an accepted consignment: custody by owner, the terms, and the account', () => {
  const p = dealings.propose('p1', 'damaris', { good: 'wine', qty: 40, alternateSale: false, buyer: 'philon', opportunityT: world.celebration.cutoffT });
  assert.ok(p.ok);
  const a = dealings.accept('a1', p.proposal, p.revision);
  assert.ok(a.ok);
  assert.ok(dealings.startLoading('l1', a.agreement, 0, 0).ok);
  const v = view();
  assert.deepEqual(v.cargo, ["40 jars of wine · Damaris's · on the quay at Serrothos, waiting to load"]);
  const x = v.expectations[0];
  assert.equal(x.title, "Damaris's wine for Philon");
  const per = (p.terms.perJar / 100).toFixed(2);
  assert.ok(x.lines[0].includes(`${per} dr a jar`), x.lines[0]);
  assert.ok(x.lines[1].startsWith('For Philon by the end of day 17 (16 days left).'), x.lines[1]);
  assert.ok(x.lines.includes('Loaded 40 · sold 0 · returned 0.'));
  assert.equal(x.lines.at(-1), 'Open.');
  assert.ok(v.accounts.ventures[0].lines.includes('Your share is worked out once every jar is sold or returned.'));
});

test('a spoken promise shows your words and her reading, apart from the terms; no private numbers', () => {
  world.documents[0].holder = 'player';
  const ag = world.agreements[0];
  const r = social.recordPromise('r1', { holder: 'damaris', claim: 'back within the week', interpretation: 'conditional', citation: "I'll be back within the week.", agreement: ag.id, expectDay: 8 });
  assert.ok(r.ok, JSON.stringify(r));
  const v = view();
  const lines = v.expectations[0].lines;
  assert.ok(lines.some((l) => l.includes('By the terms, Damaris expects you back by')), lines.join(' | '));
  assert.ok(lines.includes("You said: “I'll be back within the week.”"), lines.join(' | '));
  // expectDay 8 is the promised day itself, not the day after
  assert.ok(lines.includes('Damaris took it as a conditional promise, by day 8.'), lines.join(' | '));
  assert.equal(v.belongings.length, 1);
  assert.equal(v.belongings[0].title, 'Letter from Philon to Damaris');
  assert.equal(v.belongings[0].body, world.documents[0].body);
  const text = JSON.stringify(v);
  assert.ok(!/warm|trust/i.test(text));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
