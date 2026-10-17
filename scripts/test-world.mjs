// Lane B world tests (pass 1b): land use, the celebration and Philon's buying, and the save round trip.
// Headless, synthetic ports shaped like test-voyage.mjs. Run: node scripts/test-world.mjs
import './register-ts.mjs';
import assert from 'node:assert/strict';

const { GOODS, GOOD_IDS, goodIndex } = await import('../src/trade/goods.ts');
const { Economy, referenceFlows } = await import('../src/trade/economy.ts');
const { landUseProfile } = await import('../src/trade/landUse.ts');
const { freshWorld, oldSaveWorld, celebrationPort, CelebrationActor } = await import('../src/trade/world.ts');

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

// Synthetic profiles shaped like seed 1729 (same numbers as test-voyage.mjs).
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
const SEED = 1729;
const START = 7.4;
const DAY = 17;
const END = 18 * 24;
const HOURS = [];
for (let k = 1; START + k < END; k++) HOURS.push(START + k);
HOURS.push(END);

const philonOf = (w) => w.characters.find((c) => c.id === 'philon');
const jars = (w) => w.lots.filter((l) => l.good === 'wine' && l.owner === 'char:philon').reduce((a, l) => a + l.qty, 0);
const bought = (w) => w.lots.filter((l) => l.origin === 'purchase').reduce((a, l) => a + l.qty, 0);

function fresh() {
  const ports = ports3();
  const world = freshWorld({ ports, celebrationDay: DAY });
  const economy = new Economy({ seed: SEED, ports, doyAt, hands: 0, startT: START, actors: [new CelebrationActor(world)] });
  return { ports, world, economy };
}

test('land use: zero share gives zero wine production; other goods and shares keep the formula', () => {
  const base = ports3();
  const noWine = base.map((p) => (p.id === 1 ? { ...p, profile: landUseProfile(p.profile, { wine: 0 }) } : p));
  const fl = referenceFlows(noWine.map((p) => p.profile));
  const ref = referenceFlows(base.map((p) => p.profile));
  const wi = goodIndex('wine');
  assert.equal(fl[1][wi].P_ref, 0);
  assert.ok(fl[1][wi].D_ref > 0, 'demand is unchanged');
  for (let i = 0; i < 3; i++) {
    GOODS.forEach((g, gi) => {
      if (gi !== wi) assert.deepEqual(fl[i][gi], ref[i][gi], `${g.id} at port ${i}`);
    });
  }
  const shares = noWine.map((p) => p.profile.features.wine / p.profile.area);
  const mean = shares.reduce((a, b) => a + b, 0) / shares.length;
  for (const i of [0, 2]) {
    const r = GOODS[wi].base * Math.min(3, Math.max(0.25, Math.pow(shares[i] / mean, 1.5)));
    assert.ok(Math.abs(fl[i][wi].P_ref - r * fl[i][wi].D_ref) < 1e-6, `wine at port ${i}`);
  }
  assert.deepEqual(landUseProfile(base[1].profile).features, base[1].profile.features, 'no land use keeps the features');
});

test('fresh run: Philon buys within the limit, never overspends, and the celebration is met or short', () => {
  const { world, economy } = fresh();
  const c = world.celebration;
  const philon = philonOf(world);
  assert.equal(celebrationPort(ports3()), 1);
  assert.equal(c.port, 1);
  const wallet0 = c.requirement * c.limit;
  assert.equal(freshWorld({ ports: ports3(), celebrationDay: DAY }).characters.find((ch) => ch.id === 'philon').wallet, wallet0);
  let flips = 0;
  let doneAt = null;
  let beforeFallback = 0;
  let atFallback = 0;
  for (const T of HOURS) {
    const wasFallback = c.fallbackDone;
    const wasDone = c.done;
    const boughtBefore = bought(world);
    const walletBefore = philon.wallet;
    economy.advanceTo(T);
    assert.ok(philon.wallet >= 0, `wallet ${philon.wallet} at ${T}`);
    assert.ok(jars(world) <= c.requirement, `owned ${jars(world)} at ${T}`);
    if (!wasFallback && c.fallbackDone) {
      flips++;
      beforeFallback = boughtBefore;
      atFallback = bought(world) - boughtBefore;
    } else if (!wasFallback && !c.fallbackDone && bought(world) > boughtBefore) {
      const qty = bought(world) - boughtBefore;
      const spent = walletBefore - philon.wallet;
      assert.ok(spent <= qty * c.limit, `paid ${spent} for ${qty} jars at ${T}, limit ${c.limit}`);
    }
    if (!wasDone && c.done) doneAt = T;
  }
  assert.equal(flips, 1, 'fallback flips once');
  assert.ok(doneAt !== null && doneAt >= c.cutoffT && doneAt < c.cutoffT + 1, `done at ${doneAt}`);
  assert.equal(c.consumed + c.shortfall, c.requirement);
  return `requirement ${c.requirement}, wallet ${wallet0}, before fallback ${beforeFallback}, at fallback ${atFallback}, consumed ${c.consumed}, shortfall ${c.shortfall}`;
});

test('equivalence: one advance to the end equals hourly advances, bit for bit', () => {
  const a = fresh();
  a.economy.advanceTo(END);
  const b = fresh();
  for (const T of HOURS) b.economy.advanceTo(T);
  assert.equal(
    JSON.stringify({ world: a.world, snap: a.economy.snapshot() }),
    JSON.stringify({ world: b.world, snap: b.economy.snapshot() }),
  );
});

test('save and restore at day 10: the restored run matches the uninterrupted one', () => {
  const MID = 240;
  const a = fresh();
  a.economy.advanceTo(MID);
  const saved = JSON.parse(JSON.stringify({ world: a.world, snap: a.economy.snapshot() }));
  a.economy.advanceTo(END);
  const eco = new Economy({ seed: SEED, ports: ports3(), doyAt, hands: 0, startT: START });
  eco.restore(saved.snap);
  eco.addActor(new CelebrationActor(saved.world));
  eco.advanceTo(END);
  assert.equal(
    JSON.stringify({ world: saved.world, snap: eco.snapshot() }),
    JSON.stringify({ world: a.world, snap: a.economy.snapshot() }),
  );
});

test('an old save gets the cast, no money, no lots and no celebration', () => {
  const w = oldSaveWorld(ports3());
  assert.equal(w.celebration, null);
  assert.deepEqual(w.lots, []);
  assert.equal(w.nextId, 1);
  assert.deepEqual(
    w.characters.map((c) => [c.id, c.port, c.wallet]),
    [['damaris', 0, 0], ['philon', 1, 0], ['myrto', 2, 0]],
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
