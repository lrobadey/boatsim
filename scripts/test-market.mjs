// T0 economy tests (docs/cargo-trade-spec.md §13). Headless, synthetic ports. Run: node scripts/test-market.mjs
import './register-ts.mjs';
import assert from 'node:assert/strict';

const { GOODS, GOOD_IDS, goodIndex, season } = await import('../src/trade/goods.ts');
const { fmix32, hash01 } = await import('../src/trade/hash.ts');
const { shockMultipliers, ShockTrack } = await import('../src/trade/shocks.ts');
const { formatDr } = await import('../src/trade/money.ts');
const { Market, SPREAD, DUTY } = await import('../src/trade/market.ts');
const { Economy, referenceFlows, POP_PER_HOUSE } = await import('../src/trade/economy.ts');
const { newVoyage, applyWages, porterFeePerUnit, START_PURSE } = await import('../src/trade/voyage.ts');
const { rebuildBooks } = await import('../src/trade/books.ts');

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

// Deterministic test randomness (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Synthetic profiles shaped like seed 1729 (§16.1). Shares are features / area, so the land-use ratio
// is what matters. Mean wheat share = (0.14 + 0.22 + 0.22) / 3 = 0.193.
//   home (Serrothos): wheat share 0.14 → ratio 0.725, r = 0.85 · 0.725^1.5 = 0.52   (wheat importer)
//   Kormakos:         wheat share 0.22 → ratio 1.138, r = 0.85 · 1.138^1.5 = 1.03   (wheat producer)
//   Korkia:           wheat share 0.22 → same as Kormakos
// Honey: home share 0.08 over mean 0.053 → r = 1.84 (home exports honey, as in §16.1).
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
const DOY0 = 65;
const doyAt = (T) => (((DOY0 + Math.floor(T / 24)) % 365) + 365) % 365;
const T_START = 24 * 100 + 8; // day 100, 08:00 (integer hour)
const makeEconomy = (over = {}) =>
  new Economy({ seed: 1729, ports: ports3(), doyAt, hands: 8, startT: T_START, ...over });

const sameJSON = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));

// ---------- hash and shocks ----------

test('hash: fmix32 is murmur3 finaliser (fmix32(0) = 0, fmix32(1) = 0x514E28B7)', () => {
  assert.equal(fmix32(0), 0);
  assert.equal(fmix32(1), 0x514e28b7);
});

test('hash: hash01 in [0, 1), deterministic, order and sign sensitive', () => {
  const R = rng(3);
  for (let i = 0; i < 2000; i++) {
    const a = Math.floor(R() * 2e6) - 1e6, b = Math.floor(R() * 40), c = Math.floor(R() * 9);
    const h = hash01(a, b, c);
    assert.ok(h >= 0 && h < 1, `out of range: ${h}`);
    assert.equal(h, hash01(a, b, c));
  }
  assert.notEqual(hash01(1, 2), hash01(2, 1));
  assert.notEqual(hash01(-1), hash01(1));
});

test('shocks: cached ShockTrack equals the direct shockMultipliers call', () => {
  const R = rng(11);
  for (let port = 0; port < 3; port++) {
    for (let gi = 0; gi < GOODS.length; gi++) {
      const track = new ShockTrack(1729, port, gi, GOODS[gi]);
      let T = -4000 + R() * 1000;
      for (let i = 0; i < 400; i++) {
        T += R() * 40;
        const a = track.at(T), b = shockMultipliers(1729, port, gi, GOODS[gi], T);
        assert.ok(Object.is(a.p, b.p) && Object.is(a.d, b.d), `mismatch at T=${T}`);
      }
    }
  }
});

test('shocks: continuous at epoch boundaries, one side at a time, bounded by shockAmp', () => {
  const gi = goodIndex('wheat');
  const g = GOODS[gi];
  const off = hash01(1729, 0, gi, 0x0ff) * g.epochDays;
  for (let k = -3; k < 60; k++) {
    const Tb = (k * g.epochDays - off) * 24; // x = (T/24 + off)/epochDays is an integer here
    const m = shockMultipliers(1729, 0, gi, g, Tb);
    assert.equal(m.p, 1, `p at boundary ${k}`);
    assert.equal(m.d, 1, `d at boundary ${k}`);
    const near = shockMultipliers(1729, 0, gi, g, Tb + 0.02);
    assert.ok(Math.abs(near.p - 1) < 0.05 && Math.abs(near.d - 1) < 0.05, `not continuous at ${k}`);
  }
  const bound = Math.exp(2 * g.shockAmp) + 1e-12;
  const R = rng(5);
  for (let i = 0; i < 5000; i++) {
    const m = shockMultipliers(1729, 1, gi, g, R() * 80000 - 20000);
    assert.ok(m.p <= bound && m.p >= 1 / bound && m.d <= bound && m.d >= 1 / bound, 'multiplier outside exp(±amp·2)');
    assert.ok(m.p === 1 || m.d === 1, 'both sides shocked');
  }
});

test('shocks: frequency and production share match the table', () => {
  const gi = goodIndex('wine');
  const g = GOODS[gi];
  const off = hash01(1729, 2, gi, 0x0ff) * g.epochDays;
  let shocks = 0, prod = 0;
  const N = 20000;
  for (let k = 0; k < N; k++) {
    // phase 0.5 is where the envelope is 1, so any shock shows at full size
    const T = ((k + 0.5) * g.epochDays - off) * 24;
    const m = shockMultipliers(1729, 2, gi, g, T);
    if (m.p !== 1 || m.d !== 1) {
      shocks++;
      if (m.p !== 1) prod++;
    }
  }
  const f = shocks / N, pf = prod / shocks;
  assert.ok(Math.abs(f - g.shockChance) < 0.01, `shock frequency ${f}`);
  assert.ok(Math.abs(pf - 0.6) < 0.02, `production share ${pf}`);
  return `freq ${f.toFixed(3)}, production ${pf.toFixed(2)}`;
});

// ---------- goods and money ----------

test('goods: table order, goodIndex, and season has year mean 1, minimum > 0, no season for amp 0', () => {
  assert.deepEqual(GOOD_IDS, ['wine', 'oil', 'wheat', 'almonds', 'fish', 'honey', 'firewood', 'pitch']);
  assert.equal(goodIndex('pitch'), 7);
  for (const g of GOODS) {
    let sum = 0, min = Infinity;
    const N = 365000;
    for (let i = 0; i < N; i++) {
      const s = season(g, i / 1000);
      sum += s;
      if (s < min) min = s;
    }
    const mean = sum / N;
    assert.ok(Math.abs(mean - 1) < 1e-6, `${g.id} mean ${mean}`);
    assert.ok(min > 0, `${g.id} min ${min}`);
    if (g.season[2] === 0) assert.equal(season(g, 100), 1);
  }
});

test('goods: season is continuous at the edge of the harvest window', () => {
  const g = GOODS[goodIndex('wheat')];
  const [peak, half, amp] = g.season;
  const edge = 1 - (amp * half) / 365;
  // the season factor at Δ = half is exactly 1 − amp·half/365 (g = 0), and just inside it is equal
  assert.ok(Math.abs(season(g, peak + half - 1e-9) - edge) < 1e-8);
  assert.ok(Math.abs(season(g, peak + half + 1e-9) - edge) < 1e-8);
});

test('money: formatDr (one decimal, thin no-break space above 9 999 dr)', () => {
  assert.equal(formatDr(750), '7.5 dr');
  assert.equal(formatDr(1000), '10.0 dr');
  assert.equal(formatDr(1245000), '12 450.0 dr');
  assert.equal(formatDr(999950), '9999.5 dr');
  assert.equal(formatDr(1000000), '10 000.0 dr');
  assert.equal(formatDr(-30000), '−300.0 dr');
});

// ---------- market ----------

test('market: quoteBuy throws above maxBuy, quotes duty and rounds in the port favour', () => {
  const g = GOODS[goodIndex('wine')];
  const m = new Market(g, 100, 10); // S_ref = 400
  assert.equal(m.S_ref, 400);
  assert.equal(m.maxBuy(), Math.floor(400 - 0.05 * 400));
  assert.throws(() => m.quoteBuy(m.maxBuy() + 1), RangeError);
  const q1 = m.quoteBuy(1);
  const mid = m.price();
  assert.equal(q1.total, Math.ceil(m.ask(399.5) * 1.02));
  assert.ok(q1.duty >= 0 && q1.duty <= Math.ceil(0.02 * m.ask(399.5)) + 1);
  assert.equal(q1.unitFirst, m.ask(399.5));
  assert.equal(m.quoteBuy(0).total, 0);
  assert.ok(Math.abs(mid - g.pRef) < 1e-9, 'price at S_ref is pRef');
});

test('market: price clamp at the extremes and buy/sell round trip restores stock', () => {
  const g = GOODS[goodIndex('oil')];
  const m = new Market(g, 1, 10); // S_ref = 600
  m.S = 0;
  assert.ok(Math.abs(m.price() - 3.5 * g.pRef) < 1e-9);
  m.S = 1e9;
  assert.ok(Math.abs(m.price() - 0.3 * g.pRef) < 1e-9);
  m.S = 600;
  const before = m.S;
  const b = m.buy(25);
  const s = m.sell(25);
  assert.ok(b.total > s.total, 'a round trip loses money');
  assert.ok(Math.abs(m.S - before) < 1e-9);
  assert.equal(Math.round(m.S), 600);
});

test('market: fuzz, buy-then-sell over 10 000 random (market, q) loses at least (σ + 0.04)·V', () => {
  const R = rng(7);
  let checked = 0;
  let worst = Infinity;
  for (let i = 0; i < 10000; i++) {
    const g = GOODS[Math.floor(R() * GOODS.length)];
    const D = 5 + R() * 2000;
    const P = D * (0.2 + R() * 2.5);
    const m = new Market(g, P, D, 0);
    m.S = m.S_ref * (0.06 + R() * 3);
    const mb = m.maxBuy();
    if (mb < 1) continue;
    const q = 1 + Math.floor(R() * Math.min(mb, 400));
    let V = 0;
    for (let k = 0; k < q; k++) V += m.price(m.S - k - 0.5);
    const buy = m.buy(q);
    const sell = m.sell(q);
    const loss = buy.total - sell.total;
    const need = (SPREAD + 0.04) * V - 1e-9 * V;
    assert.ok(loss >= need, `loss ${loss} < ${need} (q ${q}, ${g.id})`);
    worst = Math.min(worst, loss / V);
    checked++;
  }
  assert.ok(checked > 9000, `checked ${checked}`);
  return `${checked} trades, worst loss ${(worst * 100).toFixed(2)}% of mid value (floor ${((SPREAD + 0.04) * 100).toFixed(0)}%)`;
});

test('market: stock converges to S_eq within 1% after 5τ (no shocks, no shipments)', () => {
  const g = GOODS[goodIndex('wheat')];
  const D = 50, P = 65; // r = 1.3
  const m = new Market(g, P, D);
  m.S = 0.1 * m.S_ref;
  const Seq = (m.S_ref * P) / D;
  const tauDays = m.S_ref / D;
  const hours = Math.round(5 * tauDays * 24);
  for (let h = 0; h < hours; h++) m.relax(P, D);
  assert.ok(Math.abs(m.S - Seq) <= 0.01 * Seq, `S ${m.S} vs S_eq ${Seq}`);
});

test('market: a 0.6·S_ref dump depresses price and recovers half-way in about τ·ln2', () => {
  const economy = new Economy({
    seed: 1729, ports: [{ id: 0, profile: profileOf(SHAPES.home), x: 0, z: 0 }], doyAt, hands: 0,
    startT: T_START, noShocks: true, noShipments: true,
  });
  const g = GOODS[goodIndex('firewood')]; // no season: a constant equilibrium
  const m = economy.market(0, 'firewood');
  economy.advanceTo(T_START + 24 * 30); // settle
  const Seq = m.S;
  const p0 = m.price();
  const dump = Math.round(0.6 * m.S_ref);
  m.sell(dump);
  assert.ok(m.price() < p0, 'price did not fall');
  const t0 = economy.now;
  const tau = m.S_ref / m.D_ref; // days
  economy.advanceTo(t0 + Math.round(24 * tau * Math.LN2));
  const frac = (m.S - Seq) / dump;
  assert.ok(Math.abs(frac - 0.5) < 0.02, `remaining excess ${frac.toFixed(4)} of the dump, want 0.5`);
  void g;
  return `tau ${tau.toFixed(1)} d, half-life excess ${frac.toFixed(3)}`;
});

// ---------- clock and economy ----------

test('economy: advanceTo throws when T decreases, equal T is fine', () => {
  const e = makeEconomy();
  e.advanceTo(T_START + 100);
  assert.throws(() => e.advanceTo(T_START + 99), RangeError);
  e.advanceTo(T_START + 100);
});

test('economy: deterministic, two runs equal (state and events)', () => {
  const run = () => {
    const e = makeEconomy();
    e.advanceTo(T_START + 60 * 24);
    return JSON.stringify({ snap: e.snapshot(), ev: e.drainEvents() });
  };
  assert.equal(run(), run());
});

test('economy: quantum invariance, 100 days in one call equals 2 400 hourly calls bit for bit', () => {
  const A = makeEconomy();
  A.advanceTo(T_START + 2400);
  const B = makeEconomy();
  for (let h = 1; h <= 2400; h++) B.advanceTo(T_START + h);
  const a = A.snapshot(), b = B.snapshot();
  assert.equal(a.T, b.T);
  for (let pi = 0; pi < a.stocks.length; pi++) {
    for (let gi = 0; gi < GOODS.length; gi++) {
      assert.ok(Object.is(a.stocks[pi][gi], b.stocks[pi][gi]), `stock ${pi},${gi}`);
    }
  }
  sameJSON(a.shipments, b.shipments);
  sameJSON(a.fleetBusyUntil, b.fleetBusyUntil);
  sameJSON(A.drainEvents(), B.drainEvents());
  return `${a.shipments.length} shipments in flight at the end`;
});

test('economy: pre-run pays no wages; a 3-day skip pays exactly three midnights', () => {
  const e = makeEconomy();
  assert.deepEqual(e.drainEvents(), []);
  e.advanceTo(T_START + 72);
  const ev = e.drainEvents();
  const wages = ev.filter((x) => x.type === 'wages');
  assert.equal(wages.length, 3);
  const v = newVoyage();
  assert.equal(applyWages(v, ev), 3 * 8 * 150);
  assert.equal(v.purse, START_PURSE - 3600);
});

test('economy: price stays within 0.3–3.5 × pRef over 10 simulated years with random trades', () => {
  const e = makeEconomy();
  const R = rng(99);
  const ports = e.ports;
  const checkAll = () => {
    for (const p of ports) {
      for (const id of GOOD_IDS) {
        const m = e.market(p.id, id);
        const pr = m.price();
        assert.ok(pr >= 0.3 * m.good.pRef - 1e-9 && pr <= 3.5 * m.good.pRef + 1e-9, `${id} price ${pr}`);
        assert.ok(m.S >= 0.05 * m.S_ref - 1e-9, `${id} stock ${m.S} under floor`);
      }
    }
  };
  let T = T_START;
  let trades = 0;
  for (let day = 0; day < 3650; day++) {
    for (let k = 0; k < 3; k++) {
      const p = ports[Math.floor(R() * ports.length)];
      const m = e.market(p.id, GOOD_IDS[Math.floor(R() * GOOD_IDS.length)]);
      if (R() < 0.5) m.buy(Math.floor(R() * Math.min(m.maxBuy(), 60)));
      else m.sell(Math.floor(R() * 60));
      trades++;
      checkAll();
    }
    T += 24;
    e.advanceTo(T);
    checkAll();
  }
  return `${trades} trades`;
});

test('economy: shipments respond to an artificial gap within 3 days', () => {
  const e = new Economy({
    seed: 1729,
    ports: [
      { id: 0, profile: profileOf(SHAPES.home), x: 0, z: 0 },
      { id: 1, profile: profileOf(SHAPES.kormakos), x: 3000, z: 0 },
    ],
    doyAt, hands: 0, startT: T_START, noShocks: true,
  });
  // Home over-stocked, Kormakos bare: every good has a gap far above the 15 % threshold.
  for (const g of GOODS) {
    e.market(0, g.id).S = 3 * e.market(0, g.id).S_ref;
    e.market(1, g.id).S = 0.2 * e.market(1, g.id).S_ref;
  }
  e.drainEvents();
  let launched = false;
  for (let h = 0; h < 72 && !launched; h++) {
    e.advanceTo(e.now + 1);
    if (e.shipments.length > 0) launched = true;
  }
  assert.ok(launched, 'no shipment within 3 days');
  return `first shipment by ${(e.now - T_START).toFixed(0)} h`;
});

test('economy: every NPC cargo is at most 0.4·S_ref of its destination and at least 10 units', () => {
  const e = makeEconomy();
  let arrivals = 0, maxRatio = 0;
  for (let day = 1; day <= 365; day++) {
    e.advanceTo(T_START + 24 * day);
    for (const ev of e.drainEvents()) {
      if (ev.type !== 'arrival') continue;
      arrivals++;
      const m = e.market(ev.port, ev.good);
      assert.ok(ev.qty <= 0.4 * m.S_ref + 1e-9, `${ev.good} arrival ${ev.qty} above 0.4·S_ref ${m.S_ref}`);
      assert.ok(ev.qty >= 10, `arrival of ${ev.qty}`);
      maxRatio = Math.max(maxRatio, m.S / m.S_ref);
    }
  }
  assert.ok(arrivals > 0, 'no NPC shipments in a year');
  return `${arrivals} arrivals in a year, highest stock ${maxRatio.toFixed(2)} × S_ref`;
});

test('economy: reference flows, one port gives r = base; equal ports give r = base', () => {
  const one = referenceFlows([profileOf(SHAPES.home)]);
  GOODS.forEach((g, gi) => {
    const { P_ref, D_ref } = one[0][gi];
    assert.ok(Math.abs(D_ref - POP_PER_HOUSE * 140 * g.perCapita) < 1e-9);
    assert.ok(Math.abs(P_ref - g.base * D_ref) < 1e-9, `${g.id}`);
  });
  const two = referenceFlows([profileOf(SHAPES.kormakos), profileOf(SHAPES.kormakos)]);
  assert.ok(Math.abs(two[0][2].P_ref / two[0][2].D_ref - GOODS[2].base) < 1e-12);
});

test('economy: first move, a Kormakos wheat round trip from 300 dr is profitable after all costs', () => {
  const e = makeEconomy();
  const porter = porterFeePerUnit(GOODS[goodIndex('wheat')]);
  const v = newVoyage();
  v.purse = START_PURSE;
  v.manifest = {};
  rebuildBooks(v);
  const toIslet = T_START + 24; // one day out
  const toHome = toIslet + 24; // one day back
  // Sail out: wages from the midnight hook.
  let wages = applyWages(v, (e.advanceTo(toIslet), e.drainEvents()));
  const kor = e.market(1, 'wheat');
  // Largest load the purse covers, including the porterage on loading.
  let q = 0;
  while (q + 1 <= kor.maxBuy() && kor.quoteBuy(q + 1).total + porter * (q + 1) <= v.purse) q++;
  const islet = kor.price();
  const buy = kor.buy(q);
  v.purse -= buy.total + porter * q;
  // Sail home and sell in the dearer market.
  e.advanceTo(toHome);
  wages += applyWages(v, e.drainEvents());
  const home = e.market(0, 'wheat');
  const homePrice = home.price();
  const sell = home.sell(q);
  v.purse += sell.total - porter * q;
  const net = v.purse - START_PURSE;
  assert.ok(net > 0, `net ${net} c`);
  const d = (c) => formatDr(c);
  return `${q} sacks: paid ${d(buy.total)}, sold ${d(sell.total)}, wages ${d(wages)}, porterage ${d(2 * porter * q)}, net ${d(net)}; mid price islet ${(islet / 100).toFixed(1)} dr, home ${(homePrice / 100).toFixed(1)} dr`;
});

test('economy: save and restore at day 37 equals the continuous run at day 90, bit for bit', () => {
  const startT = T_START + 0.25; // a fractional start, so the snapshot time is fractional too
  const A = makeEconomy({ startT });
  A.advanceTo(startT + 37 * 24 + 0.3);
  const snap = JSON.parse(JSON.stringify(A.snapshot()));
  A.drainEvents();
  const B = makeEconomy({ startT });
  B.restore(snap);
  A.advanceTo(startT + 90 * 24);
  B.advanceTo(startT + 90 * 24);
  sameJSON(A.snapshot(), B.snapshot());
  sameJSON(A.drainEvents(), B.drainEvents());
});

test('economy: one game year for 3 ports (constructor included) takes under 50 ms', () => {
  const t0 = performance.now();
  const e = makeEconomy();
  e.advanceTo(T_START + 8760);
  const ms = performance.now() - t0;
  assert.ok(ms < 50, `${ms.toFixed(1)} ms`);
  return `${ms.toFixed(1)} ms`;
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
