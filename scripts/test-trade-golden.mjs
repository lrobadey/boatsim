// Golden trace of the trade system (docs/expectations-mvp-spec.md section 7, Gate 1a). Records the exact
// purse, manifest, job projection and market stocks after every action of fixed scenarios, so the
// cargo-lot / receipt / save-v2 refactor can be proven to change nothing.
//   node scripts/test-trade-golden.mjs --record   write scripts/golden/trade.json and the v1 fixtures
//                                                 (scripts/golden/trade-v1/*.json) from the current code
//   node scripts/test-trade-golden.mjs            compare the current code against them with ===
//
// Rules for this file: it reads voyage fields but never assigns voyage.purse, voyage.manifest or any
// other voyage field (after the refactor they are derived). Cargo is obtained by buying. It records
// only what the public APIs below return; the job is projected to the seven fields that exist today.
//
// --record refuses to run once src/trade/save.ts has parseAnySave: the fixtures must stay the v1
// files that today's code wrote. Pass --force-record only if you mean to replace them.
import './register-ts.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const { GOOD_IDS } = await import('../src/trade/goods.ts');
const { Economy } = await import('../src/trade/economy.ts');
const { TradeSession } = await import('../src/trade/session.ts');
const { newVoyage } = await import('../src/trade/voyage.ts');
const saveMod = await import('../src/trade/save.ts');
const { buildSave } = saveMod;
const parse = saveMod.parseAnySave ?? saveMod.parseSave;

const RECORD = process.argv.includes('--record');
const FORCE = process.argv.includes('--force-record');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = path.join(HERE, 'golden', 'trade.json');
const FIXTURE_DIR = path.join(HERE, 'golden', 'trade-v1');

// ---------- synthetic economy (same numbers as scripts/test-voyage.mjs) ----------

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
const T0 = 24 * 100 + 8; // day 100, 08:00
const HOLD = 20.1;
const SEED = 1729;
const SIZE = 2048;
const SAVED_AT = 1760000000000;
const CLOCK = { dayCount: 100, hours: 8.5, dayOfYear: 165, moonPhase: 0.25 };
const WIND_TIME = 1234.5;
const BERTH = { id: 0, bowOut: true };

function setup({ hands = 0 } = {}) {
  const economy = new Economy({ seed: SEED, ports: ports3(), doyAt, hands, startT: T0 });
  const voyage = newVoyage();
  const session = new TradeSession({ economy, voyage, holdCapacity: HOLD });
  return { economy, voyage, session };
}

// ---------- snapshots ----------

/** Deep copy with object keys sorted, so the file is stable. */
function canon(x) {
  if (Array.isArray(x)) return x.map(canon);
  if (x !== null && typeof x === 'object') {
    const out = {};
    for (const k of Object.keys(x).sort()) out[k] = canon(x[k]);
    return out;
  }
  return x;
}

/** The job as it exists today, projected to exactly these fields. */
function projectJob(job) {
  if (!job) return null;
  return canon({
    port: job.port,
    berth: job.berth,
    incoming: job.incoming,
    outgoing: job.outgoing,
    quay: job.quay,
    active: job.active ? { good: job.active.good, direction: job.active.direction, workKg: job.active.workKg } : null,
    cartAt: job.cartAt,
  });
}

/** Purse, manifest, hatchUntil and job of a bare voyage (used for a parsed save). */
function projectVoyage(v) {
  return { purse: v.purse, manifest: canon(v.manifest), hatchUntil: v.hatchUntil ?? null, job: projectJob(v.job) };
}

const QUOTE_ORDER = { wheat: 3, wine: -2 };

function state(economy, session) {
  const v = session.voyage;
  const aboard = {};
  const limits = {};
  for (const g of GOOD_IDS) {
    aboard[g] = session.aboard(g);
    limits[g] = canon(session.limits(0, {}, g));
  }
  return {
    T: economy.now,
    purse: v.purse,
    manifest: canon(v.manifest),
    hatchUntil: v.hatchUntil ?? null,
    hatchesOpen: session.hatchesOpen(economy.now),
    job: projectJob(v.job),
    pendingUnits: session.pendingUnits,
    aboard,
    stocks: economy.ports.map((p) => GOOD_IDS.map((g) => economy.market(p.id, g).S)),
    limits0: limits,
    quote0: canon(session.quote(0, QUOTE_ORDER)),
  };
}

// ---------- actions ----------

const rep = (n, a) => Array.from({ length: n }, () => ({ ...a }));
const confirm = (orders, port = 0, berth = 0) => ({ op: 'confirm', port, berth, orders });
const tick = (dt) => ({ op: 'tick', dt });
const tickTo = (to) => ({ op: 'tick', to });
const castOff = () => ({ op: 'castOff' });

function label(a) {
  if (a.op === 'confirm') return `confirm port ${a.port} berth ${a.berth} ${JSON.stringify(a.orders)}`;
  if (a.op === 'tick') return a.to !== undefined ? `tick to ${a.to}` : `tick +${a.dt}`;
  return a.op;
}

function act(h, a) {
  const { economy, session } = h;
  try {
    if (a.op === 'confirm') {
      const r = session.confirm(a.port, a.berth, a.orders);
      return canon(r);
    }
    if (a.op === 'tick') return session.tick(a.to !== undefined ? a.to : economy.now + a.dt).map(canon);
    if (a.op === 'castOff') {
      session.castOff();
      return { ok: true };
    }
  } catch (e) {
    return { error: e.message };
  }
  throw new Error(`unknown op ${a.op}`);
}

/** Runs the plan, appending one step per action. */
function run(h, plan, steps) {
  for (const a of plan) {
    const result = act(h, a);
    steps.push({ action: label(a), result, state: state(h.economy, h.session) });
  }
}

function start(h) {
  return [{ action: 'init', result: null, state: state(h.economy, h.session) }];
}

// ---------- scenarios ----------

const SCENARIOS = [
  {
    name: 'a-buys',
    run() {
      const h = setup();
      const steps = start(h);
      run(h, [confirm({ wheat: 12, oil: 3, pitch: 4 }), ...rep(8, tick(1))], steps);
      return steps;
    },
  },
  {
    name: 'b-sells',
    run() {
      const h = setup();
      const steps = start(h);
      run(h, [confirm({ wine: -25 }), ...rep(8, tick(1))], steps);
      return steps;
    },
  },
  {
    name: 'c-mixed',
    run() {
      const h = setup();
      const steps = start(h);
      run(h, [
        confirm({ wine: -30, wheat: 6, oil: 2 }),
        ...rep(2, tick(1)),
        confirm({ wheat: 1 }, 0, 1), // wrong berth
        confirm({ wheat: 1 }, 1, 0), // wrong port
        confirm({ wine: -999 }), // more than aboard
        confirm({ pitch: 1e9 }), // beyond stock
        confirm({ wine: -10, pitch: 3, honey: 2 }), // second order while the first job still runs
        ...rep(12, tick(1)),
      ], steps);
      return steps;
    },
  },
  {
    // Save and restore mid-unload: a unit is partly unloaded and bought units wait on the quay.
    name: 'd-save-restore',
    run() {
      const h = setup({ hands: 8 });
      const steps = start(h);
      run(h, [confirm({ wine: -10, wheat: 5 }), tick(0.3)], steps);
      const active = h.session.voyage.job?.active;
      if (!active || !(active.workKg > 0)) throw new Error('scenario d: no partly handled unit at the save');
      const json = JSON.stringify(
        buildSave({
          seed: SEED, heightmapSize: SIZE, clock: CLOCK, windTime: WIND_TIME, berth: BERTH,
          voyage: h.voyage, economy: h.economy.snapshot(), savedAt: SAVED_AT,
        }),
      );
      const save = parse(json, SEED, SIZE);
      if (!save) throw new Error('scenario d: save rejected');
      steps.push({ action: 'parse', result: { voyage: projectVoyage(save.voyage), economyT: save.economy.T }, state: state(h.economy, h.session) });
      const economy = new Economy({ seed: SEED, ports: ports3(), doyAt, hands: 8, startT: T0 });
      economy.restore(save.economy);
      const session = new TradeSession({ economy, voyage: save.voyage, holdCapacity: HOLD });
      const r = { economy, session, voyage: save.voyage };
      steps.push({ action: 'restored', result: null, state: state(economy, session) });
      run(r, [...rep(6, tick(0.5)), ...rep(10, tick(1))], steps);
      return steps;
    },
  },
  {
    // Wages over several days and midnights, with trades between. The purse goes negative.
    name: 'e-wages',
    run() {
      const h = setup({ hands: 8 });
      const steps = start(h);
      const day = (n) => rep(n, tick(24));
      run(h, [
        confirm({ oil: 8, wheat: 3 }), // spends most of the 300 dr
        ...rep(4, tick(1)),
        tick(20), // crosses the first midnight
        ...day(2),
        confirm({ pitch: 4 }), // may be refused by the purse
        ...rep(3, tick(1)),
        ...day(4), // wages drive the purse below zero
        confirm({ wheat: 1 }), // refused: purse below zero
        confirm({ wine: -20 }), // a sale is allowed
        ...rep(4, tick(0.5)),
        ...day(6),
        confirm({ wine: -30, fish: 2 }),
        ...rep(4, tick(1)),
        ...day(8),
        confirm({ oil: -3 }),
        ...rep(3, tick(1)),
        ...day(4),
      ], steps);
      const purses = steps.map((s) => s.state.purse);
      if (!(Math.min(...purses) < 0)) throw new Error('scenario e: the purse never went negative');
      return steps;
    },
  },
  {
    name: 'f-jump-72h',
    run() {
      const h = setup({ hands: 8 });
      const steps = start(h);
      run(h, [confirm({ wine: -30, wheat: 5, oil: 2 }), tickTo(T0 + 72)], steps);
      return steps;
    },
  },
  {
    name: 'g-fragmented-72h',
    run() {
      const h = setup({ hands: 8 });
      const steps = start(h);
      run(h, [confirm({ wine: -30, wheat: 5, oil: 2 }), ...rep(288, tick(0.25))], steps);
      return steps;
    },
  },
  {
    name: 'h-cast-off',
    run() {
      const h = setup();
      const steps = start(h);
      run(h, [
        confirm({ wine: -10, wheat: 4 }),
        castOff(), // refused: units pending
        tick(0.2),
        castOff(), // refused: a unit is part way
        ...rep(2, tick(0.25)),
        castOff(),
        tick(0.5),
        tick(0.5), // the job is done; the cart is pending
        castOff(), // accepted with the quay clear but the cart not yet gone
        ...rep(3, tick(1)),
        castOff(), // nothing to close
        confirm({ oil: 2 }),
        ...rep(4, tick(1)),
      ], steps);
      return steps;
    },
  },
];

// ---------- v1 save fixtures ----------

/** Fixture builders run on today's code only (record mode). Each returns the live h at the save point. */
const FIXTURES = [
  {
    name: 'idle-open-hatch',
    hands: 8,
    build(h) {
      run(h, [confirm({ wine: -20, wheat: 5, almonds: 3 })], []);
      for (let n = 0; n < 200 && h.voyage.job !== null; n++) h.session.tick(h.economy.now + 0.25);
      h.session.noteOpened(0, h.economy.now);
      if (h.voyage.job !== null || !h.session.hatchesOpen(h.economy.now)) throw new Error('fixture idle-open-hatch: wrong state');
    },
    // replay: the hatch is open at the load, closes during the first tick; then a new order
    plan: () => [tick(0.4), tick(0.7), confirm({ wine: -5, oil: 1, wheat: -2 }), ...rep(6, tick(0.25)), ...rep(4, tick(1)), castOff()],
  },
  {
    name: 'idle-cast-off',
    hands: 0,
    build(h) {
      run(h, [confirm({ wine: -10, oil: 2, pitch: 2 })], []);
      for (let n = 0; n < 200 && h.session.pendingUnits > 0; n++) h.session.tick(h.economy.now + 0.25);
      h.session.castOff();
      h.session.noteOpened(0, h.economy.now);
      if (h.voyage.job !== null || h.voyage.hatchUntil !== null) throw new Error('fixture idle-cast-off: wrong state');
    },
    plan: () => [...rep(3, tick(1)), confirm({ fish: 4, wine: -3 }), ...rep(3, tick(1)), castOff(), tick(24), tick(24)],
  },
  {
    name: 'job-cart-wait',
    hands: 8,
    build(h) {
      run(h, [confirm({ wine: -5 }), tick(0.6)], []);
      const j = h.voyage.job;
      if (!j || h.session.pendingUnits !== 0 || j.cartAt === null) throw new Error('fixture job-cart-wait: wrong state');
    },
    plan: () => [tick(0.3), confirm({ wheat: 3 }), ...rep(5, tick(0.5)), ...rep(3, tick(1))],
  },
  {
    name: 'mid-unload',
    hands: 8,
    build(h) {
      run(h, [confirm({ wine: -10, pitch: 3, honey: 2 }), tick(0.3)], []);
      const j = h.voyage.job;
      if (!j?.active || j.active.direction !== 'unload' || !(j.active.workKg > 0) || !(j.quay.pitch > 0)) {
        throw new Error('fixture mid-unload: wrong state');
      }
      h.session.noteOpened(0, h.economy.now);
    },
    plan: () => [tick(0.1), tick(0.2), confirm({ wine: -4, oil: 1 }), ...rep(4, tick(0.5)), ...rep(6, tick(1)), ...rep(2, tick(24))],
  },
  {
    name: 'mid-load',
    hands: 0,
    build(h) {
      run(h, [confirm({ wheat: 6, oil: 2 }), tick(0.35)], []);
      const j = h.voyage.job;
      if (!j?.active || j.active.direction !== 'load' || !(j.active.workKg > 0) || !(j.quay.wheat > 0)) {
        throw new Error('fixture mid-load: wrong state');
      }
    },
    plan: () => [tick(0.1), castOff(), confirm({ wine: -6 }), ...rep(5, tick(0.5)), ...rep(4, tick(1))],
  },
];

function buildFixtureJson(fx) {
  const h = setup({ hands: fx.hands });
  fx.build(h);
  return JSON.stringify(
    buildSave({
      seed: SEED, heightmapSize: SIZE, clock: CLOCK, windTime: WIND_TIME, berth: BERTH,
      voyage: h.voyage, economy: h.economy.snapshot(), talk: fx.name === 'idle-open-hatch' ? { news: [], notes: { kyrios: 'paid in full' } } : undefined,
      savedAt: SAVED_AT,
    }),
    null,
    2,
  ) + '\n';
}

const fixturePath = (fx) => path.join(FIXTURE_DIR, `${fx.name}.json`);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function replayFixture(fx, json) {
  const save = parse(json, SEED, SIZE);
  if (!save) return [{ action: 'parse', result: { error: 'save rejected' }, state: null }];
  const economy = new Economy({ seed: SEED, ports: ports3(), doyAt, hands: fx.hands, startT: T0 });
  economy.restore(save.economy);
  const session = new TradeSession({ economy, voyage: save.voyage, holdCapacity: HOLD });
  const h = { economy, session, voyage: save.voyage };
  const meta = canon({ clock: save.clock, windTime: save.windTime, berth: save.berth, savedAt: save.savedAt, talk: save.talk ?? null, economyT: save.economy.T });
  const steps = [{ action: 'parse', result: { voyage: projectVoyage(save.voyage), meta }, state: state(economy, session) }];
  run(h, fx.plan(), steps);
  return steps;
}

// ---------- run everything ----------

/** Returns { scenarios, fixtureSha256 }; the fixture JSON comes from `fixtureJson` (name -> string). */
function runAll(fixtureJson) {
  const scenarios = {};
  for (const sc of SCENARIOS) scenarios[sc.name] = sc.run();
  const fixtureSha256 = {};
  for (const fx of FIXTURES) {
    const json = fixtureJson[fx.name];
    fixtureSha256[fx.name] = sha(json);
    scenarios[`v1-${fx.name}`] = replayFixture(fx, json);
  }
  // normalise exactly as the file will hold it (drops undefined, as JSON does)
  return JSON.parse(JSON.stringify({ scenarios, fixtureSha256 }));
}

function assertFinite(x, where) {
  if (typeof x === 'number' && !Number.isFinite(x)) throw new Error(`refusing to record a non-finite number at ${where}`);
  if (Array.isArray(x)) x.forEach((v, i) => assertFinite(v, `${where}[${i}]`));
  else if (x !== null && typeof x === 'object') for (const [k, v] of Object.entries(x)) assertFinite(v, `${where}.${k}`);
}

/** First mismatch between expected (from the file) and got, compared with ===; null when identical. */
function firstMismatch(a, b, where) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return { path: where, a, b };
    if (a.length !== b.length) return { path: `${where}.length`, a: a.length, b: b.length };
    for (let i = 0; i < a.length; i++) {
      const m = firstMismatch(a[i], b[i], `${where}[${i}]`);
      if (m) return m;
    }
    return null;
  }
  if (a !== null && typeof a === 'object' && b !== null && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      if (!(k in a)) return { path: `${where}.${k}`, a: '<absent>', b: b[k] };
      if (!(k in b)) return { path: `${where}.${k}`, a: a[k], b: '<absent>' };
      const m = firstMismatch(a[k], b[k], `${where}.${k}`);
      if (m) return m;
    }
    return null;
  }
  return a === b ? null : { path: where, a, b };
}

const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));

/** One scenario per block, one step per line, so a diff of the file reads. */
function writeGolden(data) {
  const names = Object.keys(data.scenarios);
  const blocks = names.map((n) => `    ${JSON.stringify(n)}: [\n${data.scenarios[n].map((s) => `      ${JSON.stringify(s)}`).join(',\n')}\n    ]`);
  const text = [
    '{',
    `  "note": ${JSON.stringify('Golden trace of the trade system (Pass 1a, docs/expectations-mvp-spec.md section 7). Synthetic 3-port economy, seed 1729, start day 100 08:00. stocks[p][g] follows port order 0,1,2 and GOOD_IDS order. Compared with === by scripts/test-trade-golden.mjs. Re-record only when a trade-behaviour change is intended; never to make a refactor pass.')},`,
    `  "fixtureSha256": ${JSON.stringify(data.fixtureSha256)},`,
    '  "scenarios": {',
    blocks.join(',\n'),
    '  }',
    '}',
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
  fs.writeFileSync(GOLDEN_PATH, text);
}

// ---------- main ----------

if (RECORD) {
  if (saveMod.parseAnySave && !FORCE) {
    console.log('FAIL record refused: save.ts already has parseAnySave, so the v1 fixtures and this trace were already recorded. Use --force-record only to replace them deliberately.');
    process.exit(1);
  }
  const fixtureJson = {};
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const fx of FIXTURES) {
    fixtureJson[fx.name] = buildFixtureJson(fx);
    fs.writeFileSync(fixturePath(fx), fixtureJson[fx.name]);
  }
  const first = runAll(fixtureJson);
  const second = runAll(fixtureJson);
  const nd = firstMismatch(first, second, '');
  if (nd) {
    console.log(`FAIL nondeterministic within one process at ${nd.path}: ${show(nd.a)} vs ${show(nd.b)}`);
    process.exit(1);
  }
  assertFinite(first, 'trace');
  writeGolden(first);
  for (const [n, steps] of Object.entries(first.scenarios)) console.log(`recorded ${n}: ${steps.length} steps`);
  console.log(`recorded ${FIXTURES.length} fixtures`);
} else {
  if (!fs.existsSync(GOLDEN_PATH)) {
    console.log(`No golden file at ${GOLDEN_PATH}. Run: node scripts/test-trade-golden.mjs --record`);
    process.exit(1);
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  const fixtureJson = {};
  let failed = 0;
  for (const fx of FIXTURES) {
    const p = fixturePath(fx);
    if (!fs.existsSync(p)) {
      console.log(`FAIL fixture ${fx.name}: missing ${p}`);
      failed++;
      fixtureJson[fx.name] = '{}';
      continue;
    }
    fixtureJson[fx.name] = fs.readFileSync(p, 'utf8');
  }
  const got = runAll(fixtureJson);
  const names = [...new Set([...Object.keys(golden.scenarios), ...Object.keys(got.scenarios)])];
  for (const n of names) {
    const m = firstMismatch(golden.scenarios[n], got.scenarios[n], n);
    if (m) {
      failed++;
      console.log(`FAIL ${n}: first mismatch at ${m.path}: golden ${show(m.a)}, now ${show(m.b)}`);
    } else {
      console.log(`PASS ${n} (${got.scenarios[n].length} steps)`);
    }
  }
  const fm = firstMismatch(golden.fixtureSha256, got.fixtureSha256, 'fixtureSha256');
  if (fm) {
    failed++;
    console.log(`FAIL fixtures changed on disk: ${fm.path}: golden ${show(fm.a)}, now ${show(fm.b)}`);
  } else {
    console.log('PASS fixture files unchanged');
  }
  if (failed > 0) {
    console.log(`${failed} failed`);
    process.exit(1);
  }
  console.log('all trade golden scenarios match');
}
