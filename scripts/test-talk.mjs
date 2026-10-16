// Trader talk (docs/kormakos-and-traders-spec.md, part B): price news, facts, schema and reply parsing.
// Headless; never calls the model. Run: node scripts/test-talk.mjs
import './register-ts.mjs';
import assert from 'node:assert/strict';

const { GOODS, GOOD_IDS } = await import('../src/trade/goods.ts');
const { Economy } = await import('../src/trade/economy.ts');
const { PriceNews, recordOf, NEWS_KEEP_HOURS } = await import('../src/trade/news.ts');
const { personaFor, traderFacts, traderInstructions, replySchema, parseReply } = await import('../src/trade/trader.ts');
const { buildSave, parseSave } = await import('../src/trade/save.ts');
const { newVoyage } = await import('../src/trade/voyage.ts');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e.message).split('\n').join('\n     ')}`); }
}

const profile = (k) => ({ houses: 60 + 20 * k, area: 8e6, features: Object.fromEntries(GOOD_IDS.map((id, i) => [id, 1e6 * (1 + ((i + k) % 3))])) });
const ports = [0, 1, 2].map((id) => ({ id, profile: profile(id), x: id * 3000, z: id * 1000 }));
const doyAt = (T) => (((Math.floor(T / 24)) % 365) + 365) % 365;
const T0 = 2408;
const econ = (startT = T0) => new Economy({ seed: 1729, ports, doyAt, hands: 0, startT });
const names = { 0: 'Serrothos', 1: 'Kormakos', 2: 'Korkia' };

test('news: one record per game day, lagged by the route, capped at 30 days', () => {
  const e = econ();
  const news = new PriceNews();
  for (let T = T0; T <= T0 + 40 * 24; T += 6) {
    e.advanceTo(T);
    news.observe(e, T);
  }
  const days = new Set(news.records.map((r) => Math.floor(r.T / 24)));
  assert.equal(days.size, news.records.length, 'more than one record in a day');
  assert.ok(news.records[news.records.length - 1].T - news.records[0].T <= NEWS_KEEP_HOURS);
  const now = T0 + 40 * 24;
  const route = (a, b) => e.routeHours(a, b);
  const h = news.heard(1, 2, now, route);
  assert.ok(h && h.T <= now - route(2, 1), 'heard news newer than a ship could bring');
  const newer = news.records.filter((r) => r.T <= now - route(2, 1)).pop();
  assert.equal(h.T, newer.T, 'not the latest record a ship could carry');
  assert.equal(news.heard(1, 1, now, route), null, 'a port hears news of itself');
});

test('news: nothing heard before the first ship could arrive', () => {
  const e = econ();
  const news = new PriceNews();
  news.observe(e, T0);
  assert.equal(news.heard(0, 2, T0 + 1, (a, b) => e.routeHours(a, b)), null);
});

test('news: save round trip, malformed records dropped', () => {
  const e = econ();
  const news = new PriceNews();
  news.add(recordOf(e, T0 - 48));
  news.add(recordOf(e, T0));
  const raw = JSON.parse(JSON.stringify(news.snapshot()));
  raw.push({ T: 'x', ports: [] }, { T: 5, ports: [{ port: 0, ask: [1], bid: [1] }] });
  const back = PriceNews.restore(raw);
  assert.deepEqual(back.snapshot(), news.snapshot());
  const save = buildSave({ seed: 1, heightmapSize: 64, clock: { dayCount: 0, hours: 1, dayOfYear: 1, moonPhase: 0 }, windTime: 0, berth: { id: 0, bowOut: true },
    voyage: newVoyage(), economy: e.snapshot(), talk: { news: news.snapshot(), notes: { 1: 'Sells wine.' } } });
  const parsed = parseSave(JSON.stringify(save), 1, 64);
  assert.ok(parsed && parsed.talk.notes['1'] === 'Sells wine.' && parsed.talk.news.length === 2);
  const old = { ...save };
  delete old.talk;
  assert.ok(parseSave(JSON.stringify(old), 1, 64), 'a save without talk is refused');
});

test('facts: every price is a real ask or bid, formatted, and unknown news says so', () => {
  const e = econ();
  const news = new PriceNews();
  news.add(recordOf(e, T0 - 100));
  const now = T0;
  const facts = JSON.parse(traderFacts({
    persona: personaFor(1729, 1), port: 1, portName: 'Kormakos', portNames: names, now,
    market: (g) => e.market(1, g),
    heard: [0, 2].map((id) => ({ port: id, news: id === 0 ? news.heard(1, 0, now, (a, b) => e.routeHours(a, b)) : null })),
    memory: '', shipHere: true,
  }));
  const real = new Set();
  for (const g of GOOD_IDS) {
    real.add((Math.round(e.market(1, g).ask()) / 100).toFixed(1) + ' dr');
    real.add((e.market(1, g).ask() / 100).toFixed(1) + ' dr');
    real.add((e.market(1, g).bid() / 100).toFixed(1) + ' dr');
  }
  for (const row of facts.your_stall) assert.ok(real.has(row.you_sell_at) && real.has(row.you_buy_at), `invented price ${row.you_sell_at}`);
  const rec = news.records[0].ports.find((p) => p.port === 0);
  const heardPrices = new Set([...rec.ask, ...rec.bid].map((c) => (c / 100).toFixed(1) + ' dr'));
  for (const row of facts.news_from_ships[0].prices_there) assert.ok(heardPrices.has(row.they_sell_at) && heardPrices.has(row.they_buy_at));
  assert.equal(facts.news_from_ships[1].heard, 'nothing: no ship in from there lately');
  assert.equal(facts.this_customer.your_note, 'first time you have spoken');
});

test('instructions: plain-speech rules, no-advice rule, and the facts are inside', () => {
  const p = personaFor(1729, 0);
  const text = traderInstructions(p, 'Serrothos', '{"x":1}');
  for (const must of [p.name, 'Serrothos', 'One to three short sentences', 'never invent a price', 'Never tell them what to buy', '{"x":1}']) assert.ok(text.includes(must), must);
  assert.ok(text.length < 4600, `instructions grew to ${text.length} characters`);
});

test('persona: stable per world and port', () => {
  assert.deepEqual(personaFor(1729, 1), personaFor(1729, 1));
  assert.ok(personaFor(1729, 1).name);
});

test('schema: strict, every property required, other ports only', () => {
  const s = replySchema(['Serrothos', 'Korkia']);
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required.slice().sort(), Object.keys(s.properties).sort());
  const item = s.properties.told.items;
  assert.deepEqual(item.required.slice().sort(), Object.keys(item.properties).sort());
  assert.deepEqual(item.properties.port.enum, ['Serrothos', 'Korkia']);
  assert.deepEqual(item.properties.good.enum, GOODS.map((g) => g.name));
});

test('reply: unknown ports and goods dropped, duplicates merged, text capped', () => {
  const r = parseReply({ say: '  Wheat was 7.1 dr at Korkia, two days ago.  ', told: [{ port: 'Korkia', good: 'Wheat' }, { port: 'Korkia', good: 'Wheat' }, { port: 'Athens', good: 'Wheat' }, { port: 'Korkia', good: 'Gold' }], note: 'x'.repeat(400) }, names);
  assert.equal(r.say, 'Wheat was 7.1 dr at Korkia, two days ago.');
  assert.deepEqual(r.told, [{ port: 2, good: 'wheat' }]);
  assert.equal(r.note.length, 300);
  assert.equal(parseReply({ say: ' ', told: [], note: '' }, names), null);
  assert.equal(parseReply(null, names), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
