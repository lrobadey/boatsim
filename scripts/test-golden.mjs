// Golden trace: records the trireme's exact state over three fixed scenarios so that a refactor
// can be checked for bit-for-bit identical physics.
//   node scripts/test-golden.mjs --record   write scripts/golden/trireme.json from the current code
//   node scripts/test-golden.mjs            compare the current code against that file with ===
import './register-ts.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { Crew } = await import('../src/ship/crew.ts');
const { ShipPhysics } = await import('../src/ship/physics.ts');
const { Wind } = await import('../src/world/wind.ts');
const { WaveField } = await import('../src/world/waves.ts');

const dt = 1 / 120;
const SAMPLE_EVERY = 120; // steps, i.e. every 1 s
const RECORD = process.argv.includes('--record');
const GOLDEN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden', 'trireme.json');
const terrain = { heightAt: () => -30, normalAt: (x, z, o) => o.set(0, 1, 0) };
const flatWaves = () => { const w = new WaveField(new Wind(3)); w.waves.length = 0; return w; };
const calmWind = () => ({ vx: 0, vz: 0 });

const SCENARIOS = [
  {
    name: 'calm-rowing',
    seconds: 30,
    waves: flatWaves,
    wind: calmWind,
    start(ship) { ship.crew.setOrder(4); },
    controls(ship) { ship.helm = ship.time >= 10 ? 0.3 : 0; },
  },
  {
    name: 'waves-sail',
    seconds: 40,
    waves: () => new WaveField(new Wind(3), 11),
    wind: () => ({ vx: 6, vz: -8 }),
    start(ship) { ship.sailing.deploymentTarget = 1; },
    controls(ship) { ship.helm = -0.2; },
  },
  {
    name: 'turn-hold',
    seconds: 20,
    waves: flatWaves,
    wind: calmWind,
    start(ship) { ship.crew.setOrder(3); },
    controls(ship) {
      if (ship.time < 10) {
        ship.helm = 1;
      } else {
        ship.helm = 0;
        ship.crew.holdWater = true;
      }
    },
  },
];

function sample(s) {
  return [
    s.pos.x, s.pos.y, s.pos.z,
    s.quat.x, s.quat.y, s.quat.z, s.quat.w,
    s.vel.x, s.vel.y, s.vel.z,
    s.angVel.x, s.angVel.y, s.angVel.z,
  ];
}

function runScenario(sc) {
  const ship = new ShipPhysics(sc.waves(), sc.wind(), terrain, new Crew());
  ship.place(0, 0, 0);
  const trace = [sample(ship)];
  sc.start(ship);
  const steps = Math.round(sc.seconds / dt);
  for (let n = 1; n <= steps; n++) {
    sc.controls(ship);
    ship.step(dt);
    if (n % SAMPLE_EVERY === 0) trace.push(sample(ship));
  }
  return trace;
}

function runAll() {
  const out = {};
  for (const sc of SCENARIOS) out[sc.name] = runScenario(sc);
  return out;
}

/** Exact comparison with ===. Returns null when identical, otherwise the first mismatch and the largest |diff|. */
function compareTraces(expected, got) {
  if (expected.length !== got.length) return { error: `sample count expected ${expected.length}, got ${got.length}` };
  let first = null;
  let maxDiff = 0;
  for (let i = 0; i < expected.length; i++) {
    for (let j = 0; j < expected[i].length; j++) {
      const a = expected[i][j];
      const b = got[i][j];
      if (a === b) continue;
      maxDiff = Math.max(maxDiff, Math.abs(a - b));
      if (!first) first = { i, j, a, b };
    }
  }
  return first ? { ...first, maxDiff } : null;
}

// Determinism: two runs in the same process must agree exactly, otherwise there is hidden state.
const first = runAll();
const second = runAll();
let nondeterministic = false;
for (const sc of SCENARIOS) {
  const r = compareTraces(first[sc.name], second[sc.name]);
  if (r) {
    nondeterministic = true;
    const detail = r.error ?? `sample ${r.i}, component ${r.j} (run 1 ${r.a}, run 2 ${r.b})`;
    console.log(`FAIL ${sc.name}: nondeterministic within one process: ${detail}; hidden state suspected`);
  }
}
if (nondeterministic) {
  process.exitCode = 1;
} else if (RECORD) {
  for (const sc of SCENARIOS) {
    for (const s of first[sc.name]) {
      if (!s.every(Number.isFinite)) throw new Error(`refusing to record non-finite values in ${sc.name}`);
    }
  }
  const data = {
    note: 'Golden trace of the trireme (ShipPhysics), dt = 1/120 s, sampled every 1 s. Compared with === by scripts/test-golden.mjs. Re-record only when a physics change is intended.',
    scenarios: first,
  };
  fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
  fs.writeFileSync(GOLDEN_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log('recorded');
} else if (!fs.existsSync(GOLDEN_PATH)) {
  console.log(`No golden file at ${GOLDEN_PATH}. Run: node scripts/test-golden.mjs --record`);
  process.exitCode = 1;
} else {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  let failures = 0;
  for (const sc of SCENARIOS) {
    const expected = golden.scenarios?.[sc.name];
    if (!expected) {
      failures++;
      console.log(`FAIL ${sc.name}: no golden trace in ${path.basename(GOLDEN_PATH)}; run with --record`);
      continue;
    }
    const r = compareTraces(expected, first[sc.name]);
    if (!r) {
      console.log(`PASS ${sc.name}`);
    } else {
      failures++;
      if (r.error) console.log(`FAIL ${sc.name}: ${r.error}`);
      else console.log(`FAIL ${sc.name}: first mismatch at sample ${r.i}, component ${r.j} (expected ${r.a}, got ${r.b}); max |diff| = ${r.maxDiff}`);
    }
  }
  if (failures) process.exitCode = 1;
}
