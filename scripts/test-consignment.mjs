// Pass 1c gate (docs/expectations-mvp-spec.md §7 gate 1c, docs/pass-1c-plan.md "Gate tests"). Black-box: only
// Dealings, ventureAccount, TradeSession, checkBooks/checkWorld, freshWorld, the record folds and the save are
// used. Expected values are worked out here from the spec rules. Run: node scripts/test-consignment.mjs
import './register-ts.mjs';
import assert from 'node:assert/strict';

const { GOOD_IDS } = await import('../src/trade/goods.ts');
const { Economy } = await import('../src/trade/economy.ts');
const { DUTY } = await import('../src/trade/market.ts');
const { TradeSession } = await import('../src/trade/session.ts');
const { newVoyage } = await import('../src/trade/voyage.ts');
const { resetBooks, checkBooks, checkWorld } = await import('../src/trade/books.ts');
const worldMod = await import('../src/trade/world.ts');
const { freshWorld, CelebrationActor } = worldMod;
const { Dealings, ventureAccount } = await import('../src/trade/consignment.ts');
const { buildSave, parseSave } = await import('../src/trade/save.ts');
const { stage, trustLimit, warmth } = await import('../src/social/records.ts');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { const info = fn(); passed++; console.log(`PASS ${name}${info ? ` (${info})` : ''}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e.stack ?? e.message).split("\n").slice(0, 14).join('\n     ')}`); }
}

// ---------- synthetic two-port world (same shapes as test-world.mjs): home 0, Kormakos 1 (celebration) ----------
const SHAPES = {
  home: { houses: 140, area: 60e6, s: { wheat: 0.14, oil: 0.1, honey: 0.08, pitch: 0.05, wine: 0.12, almonds: 0.03, fish: 0.01, firewood: 0.2 } },
  kormakos: { houses: 40, area: 4e6, s: { wheat: 0.22, oil: 0.12, honey: 0.04, pitch: 0.02, wine: 0.15, almonds: 0.05, fish: 0.03, firewood: 0.2 } },
  korkia: { houses: 30, area: 3e6, s: { wheat: 0.22, oil: 0.12, honey: 0.04, pitch: 0.02, wine: 0.15, almonds: 0.05, fish: 0.03, firewood: 0.2 } },
};
const profileOf = ({ houses, area, s }) => ({ houses, area, features: Object.fromEntries(GOOD_IDS.map((id) => [id, (s[id] ?? 0) * area])) });
const ports3 = () => [[SHAPES.home, 0, 0], [SHAPES.kormakos, 3000, 0], [SHAPES.korkia, 0, 6000]].map(([sh, x, z], id) => ({ id, profile: profileOf(sh), x, z }));
const doyAt = (T) => (((65 + Math.floor(T / 24)) % 365) + 365) % 365;
const [SEED, SIZE, START, HOLD] = [1729, 2048, 7.4, 20.1];
const DAY = 17; // cutoff T 408
const FEE = Math.ceil(0.25 * 42); // porterage per wine jar, centidrachmas
const JAR_H = 42 / 400; // hours of cargo work per wine jar
const CLOCK = { dayCount: 0, hours: 7.4, dayOfYear: 65, moonPhase: 0.25 };

const char = (w, id) => w.characters.find((c) => c.id === id);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const ownedBy = (lots, id, f = () => true) => sum(lots.filter((l) => l.good === 'wine' && l.owner === `char:${id}` && f(l)).map((l) => l.qty));
const storeOf = (w, id) => ownedBy(w.lots, id, (l) => l.custody.at === 'store');
const recs = (w, kind) => w.records.filter((r) => r.kind === kind);
const canon = (x) => Array.isArray(x) ? x.map(canon) : x !== null && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x;
const stateOf = (E) => JSON.stringify(canon({ voyage: E.session.voyage, world: E.world, econ: E.economy.snapshot() }));
const frozen = (E) => JSON.stringify(canon({ voyage: E.session.voyage, world: { ...E.world, results: null }, econ: E.economy.snapshot() }));

// Wired the way tradeLayer will be: world on the session, Philon's actor reading the voyage lots, mail beside it.
const actors = (E, world) => [new CelebrationActor(world, () => E.session?.voyage.lots ?? []), new worldMod.MailActor(world)];
const economyOf = (actors) => new Economy({ seed: SEED, ports: ports3(), doyAt, hands: 0, startT: START, noShocks: true, actors });
function attach(E, economy, world, voyage) {
  Object.assign(E, { economy, world, session: new TradeSession({ economy, voyage, holdCapacity: HOLD, world }) });
  E.dealings = new Dealings({ world, session: E.session, heardBid: (...a) => E.heard(...a) });
  check(E);
  return E;
}
function setup({ ownWine = 10, celebrate = {} } = {}) {
  const world = freshWorld({ ports: ports3(), celebrationDay: DAY });
  Object.assign(world.celebration, celebrate);
  const E = { heard: () => null, seen: new Set(), heardAt: undefined };
  const economy = economyOf(actors(E, world));
  const voyage = newVoyage();
  resetBooks(voyage, { purse: 30000, cargo: ownWine ? { wine: ownWine } : {}, T: START });
  char(world, 'damaris').trustBase = Math.floor(economy.market(0, 'wine').quoteSell(40).total / 40) * 40;
  return attach(E, economy, world, voyage);
}

/** Save to JSON, parse, and rebuild economy, actors, session and dealings in place. */
function reload(E) {
  const json = JSON.stringify(buildSave({ seed: SEED, heightmapSize: SIZE, clock: CLOCK, windTime: 0, berth: { id: 0, bowOut: true }, voyage: E.session.voyage, economy: E.economy.snapshot(), world: E.world, savedAt: 1 }));
  const d = parseSave(json, SEED, SIZE);
  assert.ok(d, 'the save parses');
  const economy = economyOf([]);
  economy.restore(d.economy);
  for (const a of actors(E, d.world)) economy.addActor(a);
  attach(E, economy, d.world, d.voyage);
}

const check = (E) => { checkBooks(E.session.voyage); checkWorld(E.world, E.session.voyage); };
/** The command succeeded; with E, the books still hold. */
function ok(r, E) {
  assert.ok(r && r.ok === true, `refused: ${r?.reason}`);
  if (E) check(E);
  return r;
}
/** The command is refused for reason and nothing but world.results changes. */
function refused(E, fn, reason) {
  const before = frozen(E);
  const r = fn();
  assert.deepEqual([r.ok, r.reason], [false, reason]);
  assert.equal(frozen(E), before, `refusal (${reason}) changed state`);
  check(E);
  return r;
}
function step(E, T, allowed = true) {
  E.session.tick(T, allowed);
  check(E);
  for (const s of E.economy.shipments) if (s.from === 1 && s.to === 0) E.seen.add(s.arriveT);
  if (E.heardAt === undefined && recs(E.world, 'heard-sale').length > 0) E.heardAt = E.economy.now;
}
const hourly = (E, until) => { while (E.economy.now < until) step(E, Math.min(until, Math.floor(E.economy.now) + 1)); };
const advance = (E, T, mode) => (mode === 'jump' ? step(E, T) : hourly(E, T));
function work(E) {
  for (let n = 0; E.session.pendingUnits > 0; n++) { assert.ok(n < 200, 'cargo work never ends'); step(E, Math.floor(E.economy.now) + 1); }
}
const sail = (E, hours, mode = 'hourly') => { E.session.castOff(); advance(E, E.economy.now + hours, mode); };
const inputOf = (E, o = {}) => ({ good: 'wine', qty: 40, alternateSale: true, buyer: 'philon', opportunityT: E.world.celebration.cutoffT, ...o });

/** The opening at home: propose, revise, accept the current revision, start loading, and load all 40 by T 13. */
function opening(E, { mode = 'hourly' } = {}) {
  const d = E.dealings;
  const p = ok(d.propose('p1', 'damaris', inputOf(E, { alternateSale: false })), E);
  const r = ok(d.revise('p2', p.proposal, inputOf(E)), E);
  assert.equal(r.revision, p.revision + 1);
  refused(E, () => d.accept('a0', p.proposal, p.revision), 'stale');
  const a = ok(d.accept('a1', r.proposal, r.revision), E);
  assert.equal(ok(d.startLoading('l1', a.agreement, 0, 0), E).reserved, 2 * 40 * FEE);
  const end = Math.floor(E.economy.now) + 6;
  if (mode === 'reload') {
    hourly(E, Math.floor(E.economy.now) + 2);
    assert.ok(E.session.pendingUnits > 0 && E.session.pendingUnits < 40, 'reload falls mid-load');
    reload(E);
  }
  advance(E, end, mode);
  assert.equal(E.session.pendingUnits, 0);
  return { A: a.agreement, terms: r.terms };
}

// ---------- §3.4 worked examples, through the pure account ----------

const R = (id, kind, amount, agreement) => ({ id, T: 1, kind, amount, ...(agreement ? { agreement } : {}) });
const X = (id, amount, agreement) => ({ id, T: 1, who: 'damaris', kind: 'porterage', amount, agreement });

test('§3.4 example 1: benchmark 100, owner loading 5, gross 150, costs 10 → share 7.00, remit 133.00', () => {
  const a = ventureAccount({ agreement: 'A1', terms: { qty: 10, perJar: 1000, share: 20 }, s: 10, r: 0, closed: true, purse: 100000,
    receipts: [R('R1', 'sale', 15000, 'A1'), R('R2', 'duty', -1000, 'A1'), R('R3', 'wages', -300), R('R4', 'porterage', -77, 'A9')],
    worldReceipts: [X('X1', -500, 'A1'), X('X2', -999, 'A9')] });
  assert.deepEqual([a.G, a.C, a.N, a.profit, a.share, a.payable, a.available], [15000, 1500, 13500, 3500, 700, 13300, 13300]);
});

test('§3.4 example 2: 25 sold, 15 returned → share 17.34, remit 200.41; nothing before closure', () => {
  const o = { agreement: 'A1', terms: { qty: 40, perJar: 500, share: 20 }, s: 25, r: 15, closed: true, purse: 5000,
    receipts: [R('R1', 'sale', 22500, 'A1'), R('R2', 'duty', -450, 'A1'), R('R3', 'porterage', -275, 'A1')],
    worldReceipts: [X('X1', -440, 'A1'), X('X2', -165, 'A1')] };
  const a = ventureAccount(o);
  assert.deepEqual([a.G, a.C, a.N, a.profit, a.share, a.payable], [22500, 1330, 21170, 8670, 1734, 20041]);
  assert.equal(a.available, 5000, 'available is capped by the purse');
  const open = ventureAccount({ ...o, closed: false });
  assert.deepEqual([open.share, open.payable], [0, 21775], 'no commission before closure');
});

// ---------- the round trip, one flow (each case continues the one before) ----------

let RT, A, v;
const sale = {};

test('conservation: allocation, reservation and loading keep jars and money in the books', () => {
  RT = setup({ ownWine: 10 });
  v = Math.floor(RT.economy.market(0, 'wine').quoteSell(40).total / 40);
  const o = opening(RT);
  A = o.A;
  assert.deepEqual([o.terms.perJar, o.terms.share, o.terms.homePort, o.terms.qty], [v, 20, 0, 40]);
  const ag = RT.world.agreements.find((x) => x.id === A);
  assert.ok(Math.abs(ag.expectedT - (RT.world.celebration.cutoffT + RT.economy.routeHours(1, 0) + 72)) < 1e-9, `expectedT ${ag.expectedT}`);
  const dam = char(RT.world, 'damaris');
  assert.deepEqual([dam.wallet, dam.reserved, ag.loaded], [15000 - 40 * FEE, 40 * FEE, 40]);
  assert.equal(sum(RT.world.receipts.filter((x) => x.who === 'damaris' && x.kind === 'porterage' && x.agreement === A).map((x) => x.amount)), -40 * FEE);
  assert.equal(ownedBy(RT.session.voyage.lots, 'damaris', (l) => l.custody.at === 'aboard' && l.agreement === A && !l.moving), 40);
  assert.equal(storeOf(RT.world, 'damaris'), 0);
});

test('stale revision refused; a repeated accept with the same request id does nothing', () => {
  const p = RT.world.proposals[0];
  assert.deepEqual(p.revisions.map((r) => r.status), ['superseded', 'accepted']);
  const before = stateOf(RT);
  assert.deepEqual(RT.dealings.accept('a1', p.id, p.revisions.at(-1).revision), RT.world.results.a1);
  assert.equal(stateOf(RT), before);
  assert.equal(RT.world.agreements.length, 1);
});

test('two owners aboard: the ledger can sell only the player\'s wine', () => {
  assert.equal(RT.session.voyage.manifest.wine, 50);
  assert.equal(RT.session.limits(0, {}, 'wine').min, -10);
  assert.throws(() => RT.session.confirm(0, 0, { wine: -11 }));
  check(RT);
});

test('stale quote: a changed price is refused with the new quote', () => {
  sail(RT, 14);
  const [d, c, philon] = [RT.dealings, RT.world.celebration, char(RT.world, 'philon')];
  const demand = Math.max(0, Math.min(c.earmark, c.requirement - ownedBy(RT.world.lots, 'philon') - ownedBy(RT.session.voyage.lots, 'philon')));
  assert.equal(d.buyerDemand('philon'), demand);
  assert.ok(demand >= 25, `demand ${demand}`);
  sale.q = Math.min(RT.economy.market(1, 'wine').quoteBuy(25).total, philon.wallet - philon.reserved);
  assert.equal(d.buyerQuote('philon', 1, 25), sale.q);
  const r = refused(RT, () => d.sellToBuyer('s1', { buyer: 'philon', port: 1, berth: 0, from: A, qty: 25, quoted: sale.q + 1 }), 'stale');
  assert.equal(r.quote, sale.q);
});

test('partial sales: 25 to Philon at his quote, 5 on the market; units and money move once', () => {
  const [d, philon, purse0, store0] = [RT.dealings, char(RT.world, 'philon'), RT.session.voyage.purse, storeOf(RT.world, 'philon')];
  const w0 = philon.wallet;
  sale.duty = sale.q - Math.floor(sale.q * (1 - DUTY));
  sale.T = RT.economy.now;
  const r = ok(d.sellToBuyer('s2', { buyer: 'philon', port: 1, berth: 0, from: A, qty: 25, quoted: sale.q }), RT);
  assert.deepEqual([r.total, r.duty], [sale.q, sale.duty]);
  assert.deepEqual([philon.wallet, RT.session.voyage.purse], [w0 - sale.q, purse0 + sale.q - sale.duty]);
  const rc = RT.session.voyage.receipts.find((x) => x.kind === 'sale' && x.party === 'char:philon');
  assert.deepEqual([rc.amount, rc.agreement, rc.qty], [sale.q, A, 25]);
  sale.mkt = RT.economy.market(1, 'wine').quoteSell(5);
  const m = ok(d.sellToMarket('m1', { agreement: A, port: 1, berth: 0, qty: 5, quoted: sale.mkt.total }), RT);
  assert.equal(m.total, sale.mkt.total);
  assert.equal(RT.session.limits(1, {}, 'wine').min, -10, 'the ledger still sees only the player\'s 10');
  const purse1 = RT.session.voyage.purse;
  work(RT);
  assert.equal(RT.session.voyage.purse, purse1 - 30 * FEE, 'the purse pays the away unloading of her sold jars');
  assert.deepEqual([storeOf(RT.world, 'philon'), RT.world.agreements[0].sold], [store0 + 25, 30]);
});

test('double confirm: replaying a sale request returns the stored result and moves nothing', () => {
  const before = stateOf(RT);
  const again = RT.dealings.sellToBuyer('s2', { buyer: 'philon', port: 1, berth: 0, from: A, qty: 25, quoted: sale.q });
  assert.deepEqual([again, again.total], [RT.world.results.s2, sale.q]);
  assert.equal(stateOf(RT), before);
});

test('wrong berth: a sale at another berth than the job\'s is refused', () => {
  RT.session.confirm(1, 0, { wheat: 1 }); // a job with work pending at berth 0
  refused(RT, () => RT.dealings.sellToMarket('m2', { agreement: A, port: 1, berth: 1, qty: 1, quoted: RT.economy.market(1, 'wine').quoteSell(1).total }), 'berth');
  work(RT);
});

test('money owed is separate from jars in custody; no commission before closure', () => {
  const a = RT.dealings.account(A);
  const G = sale.q + sale.mkt.total + sale.mkt.duty;
  const C = sale.duty + sale.mkt.duty + 30 * FEE + 40 * FEE;
  assert.deepEqual([a.G, a.C, a.s, a.r, a.closed, a.N, a.profit, a.share], [G, C, 30, 0, false, G - C, Math.max(0, G - C - v * 30), 0]);
  assert.equal(a.payable, sale.q - sale.duty + sale.mkt.total - 30 * FEE, 'payable counts cash only, not the 10 jars still aboard');
  assert.equal(ownedBy(RT.session.voyage.lots, 'damaris', (l) => l.custody.at === 'aboard'), 10);
});

test('unsold jars returned; closure only when every jar is sold or returned and landed', () => {
  sail(RT, 16);
  const dam = char(RT.world, 'damaris');
  const w0 = dam.wallet;
  ok(RT.dealings.returnGoods('ret', { agreement: A, port: 0, berth: 0, qty: 10 }), RT);
  assert.equal(RT.dealings.account(A).closed, false, 'still moving');
  refused(RT, () => RT.dealings.settle('early', { agreement: A, port: 0, amount: RT.dealings.account(A).available }), 'open');
  work(RT);
  assert.equal(dam.wallet, w0 - 10 * FEE, 'she pays the home unloading of her returned jars');
  assert.equal(storeOf(RT.world, 'damaris'), 10);
  assert.equal(ownedBy(RT.world.lots, 'damaris', (l) => l.agreement), 0, 'returned jars land untagged');
  assert.deepEqual([RT.world.agreements[0].returned, RT.dealings.account(A).closed], [10, true]);
});

test('no expense counted twice: the closed account to the cent', () => {
  const a = RT.dealings.account(A);
  const G = sale.q + sale.mkt.total + sale.mkt.duty;
  const C = sale.duty + sale.mkt.duty + 30 * FEE + 40 * FEE + 10 * FEE;
  const profit = Math.max(0, G - C - v * 30);
  const share = Math.floor((profit * 20) / 100);
  const payable = sale.q - sale.duty + sale.mkt.total - 30 * FEE - share;
  assert.deepEqual([a.G, a.C, a.s, a.r, a.N, a.profit, a.share, a.payable], [G, C, 30, 10, G - C, profit, share, payable]);
  assert.equal(a.available, Math.min(payable, Math.max(0, RT.session.voyage.purse)));
  return `G ${G}, C ${C}, profit ${profit}, share ${share}, payable ${payable}`;
});

test('insufficient funds: with the purse spent, settlement pays what is there and leaves a balance', () => {
  const lim = RT.session.limits(0, {}, 'wine');
  assert.equal(lim.limitedBy, 'purse', 'precondition: spend the purse on wine');
  RT.session.confirm(0, 0, { wine: lim.max });
  work(RT);
  const [a, purse, dam] = [RT.dealings.account(A), RT.session.voyage.purse, char(RT.world, 'damaris')];
  assert.ok(purse > 0 && purse < a.payable, `purse ${purse}, payable ${a.payable}`);
  assert.equal(a.available, purse);
  const w0 = dam.wallet;
  const r = ok(RT.dealings.settle('st1', { agreement: A, port: 0, amount: purse }), RT);
  assert.deepEqual([r.paid, r.payable, r.full], [purse, a.payable - purse, false]);
  assert.deepEqual([RT.session.voyage.purse, dam.wallet], [0, w0 + purse]);
  assert.deepEqual([RT.world.agreements[0].settledT, RT.dealings.account(A).payable], [null, a.payable - purse]);
  const before = stateOf(RT);
  assert.deepEqual(RT.dealings.settle('st1', { agreement: A, port: 0, amount: purse }), RT.world.results.st1, 'double settle');
  assert.equal(stateOf(RT), before);
});

test('records written once: full settlement, then a repeated settle and a reload write nothing new', () => {
  RT.session.confirm(0, 0, { wine: RT.session.limits(0, {}, 'wine').min });
  work(RT);
  const [a, dam, T] = [RT.dealings.account(A), char(RT.world, 'damaris'), RT.economy.now];
  assert.equal(a.available, a.payable);
  const w0 = dam.wallet;
  const r = ok(RT.dealings.settle('st2', { agreement: A, port: 0, amount: a.payable }), RT);
  assert.deepEqual([r.paid, r.payable, r.full], [a.payable, 0, true]);
  assert.deepEqual([dam.wallet, dam.reserved], [w0 + a.payable, 0], 'the unused reservation is released at closure');
  assert.equal(RT.world.agreements[0].settledT, T);
  const settled = recs(RT.world, 'settled');
  assert.deepEqual(settled.map((x) => [x.holder, x.source, x.facts.full]), [['damaris', 'witnessed', false], ['damaris', 'witnessed', true]]);
  assert.deepEqual([settled[1].facts.value, settled[1].facts.onTime], [v * 40, true]);
  assert.deepEqual(recs(RT.world, 'returned').map((x) => x.facts.qty), [10]);
  assert.equal(recs(RT.world, 'sold-below').length, 0, 'no news of Kormakos prices: no judgment');
  assert.equal(warmth(RT.world, 'damaris', T), 2, '+1 for the first full settlement in person');
  assert.equal(trustLimit(RT.world, 'damaris', T), 2 * v * 40);
  const [n, purse] = [RT.world.records.length, RT.session.voyage.purse];
  assert.deepEqual(RT.dealings.settle('st2', { agreement: A, port: 0, amount: a.payable }), RT.world.results.st2);
  reload(RT);
  assert.deepEqual(RT.dealings.settle('st2', { agreement: A, port: 0, amount: a.payable }), r);
  assert.deepEqual([RT.world.records.length, RT.session.voyage.purse], [n, purse]);
});

test('news by ship: the heard-sale record arrives only when a shipment from Philon\'s port lands', () => {
  hourly(RT, 170);
  const rh = RT.economy.routeHours(1, 0);
  const expected = Math.min(...[...RT.seen].filter((t) => t - rh >= sale.T - 1e-6));
  assert.ok(Number.isFinite(expected) && expected <= 170, `no shipment from port 1 after T ${sale.T}`);
  const hs = recs(RT.world, 'heard-sale');
  assert.equal(hs.length, 1);
  assert.deepEqual([hs[0].holder, hs[0].source, hs[0].T], ['damaris', 'news', expected]);
  assert.deepEqual([hs[0].facts.qty, hs[0].facts.consignedQty, hs[0].facts.agreement], [25, 25, A]);
  assert.ok(RT.heardAt >= expected, `heard at ${RT.heardAt}, ship landed ${expected}`);
  return `sale T ${sale.T}, ship lands ${expected}, record seen at ${RT.heardAt}`;
});

// ---------- separate scenarios ----------

test('fragmented ticks, one jump, and reloads mid-load and mid-unload give identical state', () => {
  const run = (mode) => {
    const E = setup({ ownWine: 10 });
    const { A: id } = opening(E, { mode });
    sail(E, 14, mode === 'jump' ? 'jump' : 'hourly');
    const d = E.dealings;
    ok(d.sellToBuyer('s1', { buyer: 'philon', port: 1, berth: 0, from: id, qty: 25, quoted: d.buyerQuote('philon', 1, 25) }));
    ok(d.sellToMarket('m1', { agreement: id, port: 1, berth: 0, qty: 5, quoted: E.economy.market(1, 'wine').quoteSell(5).total }));
    const end = E.economy.now + 10;
    if (mode === 'reload') {
      hourly(E, E.economy.now + 2);
      assert.ok(E.session.pendingUnits > 0, 'reload falls mid-unload');
      reload(E);
    }
    advance(E, end, mode);
    assert.equal(E.session.voyage.job, null);
    return stateOf(E);
  };
  const hourlyRun = run('hourly');
  assert.equal(run('jump'), hourlyRun, 'one jump');
  assert.equal(run('reload'), hourlyRun, 'reloads');
});

test('deadline: landing exactly at the cutoff is allowed; a jump across it consumes only landed jars', () => {
  // no fallback buy this year, so Philon still wants wine at the cutoff
  const E = setup({ ownWine: 30, celebrate: { fallbackDone: true } });
  const c = E.world.celebration;
  const T = c.cutoffT - 25 * JAR_H; // 405.375, exact
  step(E, T);
  const store0 = storeOf(E.world, 'philon');
  assert.equal(E.dealings.buyerDemand('philon'), Math.max(0, Math.min(c.earmark, c.requirement - store0)));
  const r = ok(E.dealings.sellToBuyer('d1', { buyer: 'philon', port: 1, berth: 0, from: 'player', qty: 25, quoted: E.dealings.buyerQuote('philon', 1, 25) }));
  assert.equal(r.landT, c.cutoffT);
  step(E, T + 1, false); // lines parted for an hour
  step(E, c.cutoffT + 4); // one jump across the cutoff
  const landed = Math.floor(((c.cutoffT - (T + 1)) * 400) / 42);
  assert.equal(c.consumed, Math.min(c.requirement, store0 + landed));
  assert.deepEqual(recs(E.world, 'undelivered').map((x) => [x.T, x.facts.qty]), [[c.cutoffT, 25 - landed]]);
  assert.equal(storeOf(E.world, 'philon'), store0 + 25 - c.consumed, 'the late jars still land in his store');
  const m = E.world.mail[0];
  assert.deepEqual([m.to, m.facts.consignedQty, m.facts.qty], ['damaris', 0, 25], 'thanks for the player\'s own wine');
  return `landed by cutoff ${landed}, consumed ${c.consumed}`;
});

test('deadline: landing one hour past the cutoff is refused', () => {
  const E = setup({ ownWine: 30, celebrate: { fallbackDone: true } });
  step(E, E.world.celebration.cutoffT - 25 * JAR_H + 1);
  const q = E.dealings.buyerQuote('philon', 1, 25);
  refused(E, () => E.dealings.sellToBuyer('d1', { buyer: 'philon', port: 1, berth: 0, from: 'player', qty: 25, quoted: q }), 'deadline');
});

/** Lowers a wallet and its opening receipt together, so the wallet still equals its receipts. */
function shrink(w, id, to) {
  w.receipts.find((x) => x.who === id && x.kind === 'opening').amount -= char(w, id).wallet - to;
  char(w, id).wallet = to;
}

test('insufficient funds: owner short of the handling reservation; Philon\'s wallet caps his price', () => {
  const E = setup();
  shrink(E.world, 'damaris', 2 * 40 * FEE - 1);
  const p = ok(E.dealings.propose('p1', 'damaris', inputOf(E)), E);
  const a = ok(E.dealings.accept('a1', p.proposal, p.revision), E);
  refused(E, () => E.dealings.startLoading('l1', a.agreement, 0, 0), 'wallet');

  const F = setup({ ownWine: 30 });
  shrink(F.world, 'philon', 20000);
  assert.ok(F.economy.market(1, 'wine').quoteBuy(25).total > 20000, 'precondition: the cap binds');
  assert.equal(F.dealings.buyerQuote('philon', 1, 25), 20000);
  const r = ok(F.dealings.sellToBuyer('c1', { buyer: 'philon', port: 1, berth: 0, from: 'player', qty: 25, quoted: 20000 }), F);
  assert.deepEqual([r.total, char(F.world, 'philon').wallet], [20000, 0]);
});

test('honest loss: fair receipts below the agreed value earn no commission and no sold-below', () => {
  const E = setup({ ownWine: 0 });
  const v40 = Math.floor(E.economy.market(0, 'wine').quoteSell(40).total / 40);
  const { A: id } = opening(E);
  sail(E, 14);
  const heard = Math.floor(E.economy.market(1, 'wine').bid());
  E.heard = (listener, about) => (listener === 0 && about === 1 ? heard : null);
  const q = E.economy.market(1, 'wine').quoteSell(40);
  ok(E.dealings.sellToMarket('m1', { agreement: id, port: 1, berth: 0, qty: 40, quoted: q.total }), E);
  work(E);
  sail(E, 16);
  const N = q.total - 40 * FEE - 40 * FEE;
  assert.ok(N < v40 * 40, 'precondition: a loss');
  const a = E.dealings.account(id);
  assert.deepEqual([a.closed, a.N, a.profit, a.share, a.payable], [true, N, 0, 0, q.total - 40 * FEE]);
  const r = ok(E.dealings.settle('st', { agreement: id, port: 0, amount: a.payable }), E);
  assert.deepEqual([r.full, recs(E.world, 'sold-below').length], [true, 0]);
  assert.deepEqual(recs(E.world, 'settled').map((x) => x.facts.full), [true]);
  assert.equal(char(E.world, 'damaris').reserved, 0);
});

test('trust limit: a proposal worth more than the limit is refused', () => {
  const E = setup();
  const value = (n) => Math.floor(E.economy.market(0, 'wine').quoteSell(n).total / n) * n;
  char(E.world, 'damaris').trustBase = value(20);
  assert.ok(value(21) > value(20), 'precondition');
  refused(E, () => E.dealings.propose('t1', 'damaris', inputOf(E, { qty: 21 })), 'trust');
  const p = ok(E.dealings.propose('t2', 'damaris', inputOf(E, { qty: 20 })));
  assert.equal(p.terms.perJar * 20, value(20));
});

test('overdue and long overdue at exact hours, after one jump past both', () => {
  const E = setup();
  const p = ok(E.dealings.propose('p1', 'damaris', inputOf(E)));
  const { agreement } = ok(E.dealings.accept('a1', p.proposal, p.revision), E);
  const ag = E.world.agreements.find((x) => x.id === agreement);
  const w = 1; // Damaris starts at +1 and nothing has happened since
  assert.equal(warmth(E.world, 'damaris', ag.expectedT), w);
  const overdueT = ag.expectedT + 24 * w;
  const longT = overdueT + 24 * (14 + 3 * w);
  step(E, longT + 5);
  const g = E.world.agreements.find((x) => x.id === agreement);
  assert.deepEqual(
    [overdueT - 1, overdueT, longT - 1, longT, E.economy.now].map((T) => stage(E.world, g, T)),
    ['none', 'overdue', 'overdue', 'long-overdue', 'long-overdue'],
  );
  assert.equal(trustLimit(E.world, 'damaris', overdueT - 1), char(E.world, 'damaris').trustBase);
  assert.equal(trustLimit(E.world, 'damaris', overdueT), 0, 'nothing is entrusted while overdue');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
