// Sea state field (docs/sea-state-spec.md §9.1): the bake on synthetic and generated worlds, the
// envelope's validity rule, sampling, the exact no-field fallback and the inverse heightAt.
import './register-ts.mjs';
import assert from 'node:assert/strict';
const { bakeSeaState, SeaStateField, FETCH_CAP, SEA_DIRS, pierMole } = await import('../src/world/seaState.ts');
const { WaveField, createFlowSample, GERSTNER_MIN_LAMBDA } = await import('../src/world/waves.ts');
const { Wind } = await import('../src/world/wind.ts');

let failures = 0;
const report = {};
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { failures++; console.error('FAIL', name, '\n  ', e.stack ?? e.message); }
}
const FFT_A = [(2 * Math.PI) / GERSTNER_MIN_LAMBDA, (2 * Math.PI) / 1.0];
const deg = Math.PI / 180;
const WORLD = 12000;

/** a world of open sea at depth -50 m with optional conical islands [x, z, radius, peak] */
function world(N, islands = []) {
  const H = new Float32Array(N * N).fill(-50);
  const cell = WORLD / N;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const x = -WORLD / 2 + (i + 0.5) * cell, z = -WORLD / 2 + (j + 0.5) * cell;
      for (const [cx, cz, r, peak] of islands) {
        const d = Math.hypot(x - cx, z - cz);
        if (d < r * 1.4) H[j * N + i] = Math.max(H[j * N + i], peak * (1 - d / r) - (d > r ? 30 * (d / r - 1) : 0));
      }
    }
  return H;
}

function field(bake, windSpeed = 12, windFrom = 0, swellFrom = 0) {
  const wind = new Wind(3);
  wind.baseSpeed = windSpeed;
  wind.update(0);
  const waves = new WaveField(wind, 11);
  const f = new SeaStateField(bake, waves, FFT_A);
  f.compose(wind.meanSpeed, windFrom, swellFrom);
  return { f, waves, wind };
}
const env = (f, x, z) => { const a = new Float64Array(4), b = new Float64Array(4); f.sample(x, z, a, b); return { e0: [...a], e1: [...b] }; };

// ---------------------------------------------------------------- synthetic worlds

const openBake = bakeSeaState({ heights: world(256), N: 256, worldSize: WORLD, detail: [] });
report.openBakeMs = Math.round(openBake.ms);

test('open world: fetch at the cap, no shelter, open swell, envelope 1 everywhere', () => {
  const m = openBake.maps[0];
  for (let k = 0; k < m.F.length; k++) {
    assert.ok(Math.abs(m.F[k] / FETCH_CAP - 1) < 1e-5, `F ${m.F[k]}`);
    assert.equal(m.S[k], 1);
    assert.ok(Math.abs(m.W[k] - 1) < 1e-6, `W ${m.W[k]}`);
  }
  for (const from of [0, 1.3, 3.9, 5.5]) {
    const { f } = field(openBake, 12, from, from);
    for (let k = 0; k < f.env0.length; k++) assert.ok(Math.abs(f.env0[k] - 1) < 1e-4, `env0 ${f.env0[k]} at ${k}`);
    for (let k = 0; k < f.env1.length; k += 4) assert.ok(Math.abs(f.env1[k] - 1) < 1e-4 && f.env1[k + 1] === 1, `env1 ${f.env1[k]}`);
  }
});

// a 1 km island (radius 500 m, 200 m high) in the middle; wind and swell from the north (-z)
const islandBake = bakeSeaState({ heights: world(512, [[0, 0, 500, 200]]), N: 512, worldSize: WORLD, detail: [] });
report.islandBakeMs = Math.round(islandBake.ms);

test('round island: open upwind, a calm lee, mirror symmetric, swell shadow filling in', () => {
  const { f } = field(islandBake, 12, 0, 0);
  const up = env(f, 0, -1500), lee = env(f, 0, 1500);
  report.island = { upwind: up, lee1km: lee };
  for (let b = 1; b < 4; b++) assert.ok(up.e0[b] > 0.98, `upwind band ${b}: ${up.e0[b]}`);
  assert.ok(lee.e0[1] < 0.3, `lee long band ${lee.e0[1]}`);
  // about 7 hill heights downwind the mean wind has mostly recovered; close under the island it has not
  const close = env(f, 0, 700);
  report.island.leeClose = close;
  assert.ok(lee.e1[1] < 0.85, `lee wind shelter at 1 km ${lee.e1[1]}`);
  assert.ok(close.e1[1] < 0.65, `lee wind shelter at 200 m ${close.e1[1]}`);
  for (const [x, z] of [[300, 1200], [700, 2000], [450, 900]]) {
    const a = env(f, x, z), b = env(f, -x, z);
    for (let k = 0; k < 4; k++) assert.ok(Math.abs(a.e0[k] - b.e0[k]) <= 0.01 + 0.01 * a.e0[k], `asymmetry at ${x},${z} band ${k}: ${a.e0[k]} vs ${b.e0[k]}`);
  }
  const far = env(f, 0, 500 + 6000 - 600);
  report.island.swellFar = far.e0[0];
  assert.ok(far.e0[0] > 0.6, `swell 6 km downwind ${far.e0[0]}`);
});

test('envelope never exceeds 1 (validity rule), over winds and directions', () => {
  for (const U of [4, 8, 12, 16])
    for (let d = 0; d < SEA_DIRS; d += 3) {
      const { f } = field(islandBake, U, (d * 2 * Math.PI) / SEA_DIRS, 5.2);
      for (let k = 0; k < f.env0.length; k++) assert.ok(f.env0[k] >= 0 && f.env0[k] <= 1, `env0 ${f.env0[k]} at U ${U}, d ${d}`);
      for (let k = 0; k < f.env1.length; k += 4) assert.ok(f.env1[k] >= 0 && f.env1[k] <= 1, `fft ${f.env1[k]}`);
    }
});

test('a mole shelters its lee side, and the sheltered side follows the wind', () => {
  // a straight coast along z = 0 (land for z > 0), a mole running north (-z) from it at x = 0
  const N = 1024, H = world(N), cell = WORLD / N;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) if (-WORLD / 2 + (j + 0.5) * cell > 0) H[j * N + i] = 6;
  const pier = { x: 0, z: 0, angle: -Math.PI / 2, length: 160, width: 6 };
  const bake = bakeSeaState({ heights: H, N, worldSize: WORLD, detail: [{ cx: 0, cz: -80, size: 512, n: 128, moles: [pierMole(pier)] }] });
  report.moleBakeMs = Math.round(bake.ms);
  const hs = (f, x, z) => { const e = env(f, x, z).e0; return Math.hypot(e[1], e[2], e[3]); };
  // wind from the west (bearing 270): the east side (x > 0) is in the lee of the mole
  const W = field(bake, 12, 270 * deg, 270 * deg).f, E = field(bake, 12, 90 * deg, 90 * deg).f;
  const r = { westWind: { east: hs(W, 6, -100), west: hs(W, -6, -100) }, eastWind: { east: hs(E, 6, -100), west: hs(E, -6, -100) } };
  report.mole = r;
  assert.ok(r.westWind.east < 0.6 * r.westWind.west, `west wind: east ${r.westWind.east} vs west ${r.westWind.west}`);
  assert.ok(r.eastWind.west < 0.6 * r.eastWind.east, `east wind: west ${r.eastWind.west} vs east ${r.eastWind.east}`);
});

// ---------------------------------------------------------------- the wave model with a field

test('no field: queries take the original path (enveloped flag off)', () => {
  const waves = new WaveField(new Wind(3), 11);
  const s = createFlowSample();
  waves.sampleFlowAt(10, -1, 20, 5, s);
  assert.equal(s.enveloped, false);
});

test('inverse heightAt converges with the envelope on (residual < 1 mm)', () => {
  const { f, waves } = field(islandBake, 16, 0, 0);
  waves.field = f;
  const d = new Float64Array(3);
  let worst = 0, rnd = 1;
  const r = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 1000; k++) {
    const x = (r() - 0.5) * 6000, z = (r() - 0.5) * 6000, t = r() * 100;
    if (Math.hypot(x, z) < 650) continue;
    // the surface point above (x, z): find its undisplaced label, then check the forward map lands on x, z
    let px = x, pz = z;
    for (let it = 0; it < 4; it++) { waves.displacement(px, pz, t, d); px = x - d[0]; pz = z - d[2]; }
    waves.displacement(px, pz, t, d);
    worst = Math.max(worst, Math.hypot(px + d[0] - x, pz + d[2] - z));
  }
  report.inverseResidual = worst;
  assert.ok(worst < 1e-3, `residual ${worst}`);
});

test('CPU sampling: texel centres exact, edges clamped, detail feather blends', () => {
  const { f } = field(islandBake, 12, 0, 0);
  const m = islandBake.maps[0], n = m.n;
  for (const [i, j] of [[3, 5], [64, 64], [100, 20]]) {
    const x = m.originX + (i + 0.5) * m.cell, z = m.originZ + (j + 0.5) * m.cell;
    const a = new Float64Array(4);
    f.sample(x, z, a);
    for (let k = 0; k < 4; k++) assert.equal(a[k], f.env0[(j * f.atlasWidth + i) * 4 + k]);
  }
  const edge = new Float64Array(4), out = new Float64Array(4);
  f.sample(m.originX + 0.1, m.originZ + 0.1, edge);
  f.sample(m.originX - 500, m.originZ - 500, out);
  assert.deepEqual([...out], [...edge]);
  void n;
});

test('tick relaxes toward a new target on simulation time, deterministically', () => {
  const a = field(islandBake, 12, 0, 0).f, b = field(islandBake, 12, 0, 0).f;
  for (const f of [a, b]) {
    f.compose(12, 90 * deg, 0);
    for (let k = 0; k < 40; k++) f.tick(0.25);
    f.tick(0.1); f.tick(0.15); // a split tick gives the same as one 0.25 s tick
  }
  assert.deepEqual([...a.env0], [...b.env0]);
  const e = env(a, 0, 1500).e0[1];
  assert.ok(e > 0.2, `lee long band after 10 s of an east wind ${e}`);
});

// ---------------------------------------------------------------- a generated world

/** run the worldgen worker in this process (it only needs self.onmessage / self.postMessage) */
async function generateWorld(seed, size) {
  let result = null;
  globalThis.self = { postMessage: (m) => { if (m.type === 'done') result = m.result; } };
  await import('../src/world/worldgen.worker.ts');
  const W = new Wind(3);
  globalThis.self.onmessage({ data: { seed, size, worldSize: WORLD, windFrom: W.baseFrom, vegetationDensity: 0.1 } });
  return result;
}
const gen = await generateWorld(1, 512);
report.generated = { bakeMs: Math.round(gen.seaState.ms) };

test('generated world: berths far calmer than open water in the prevailing wind; validity rule holds', () => {
  const { f, waves, wind } = field(gen.seaState, 12, new Wind(3).baseFrom, (300 * Math.PI) / 180);
  waves.field = f;
  for (let k = 0; k < f.env0.length; k++) assert.ok(f.env0[k] >= 0 && f.env0[k] <= 1, `env0 ${f.env0[k]}`);
  const p = gen.sites.pier, ux = Math.cos(p.angle), uz = Math.sin(p.angle);
  const mid = (p.berthStart + p.length) / 2;
  const berth = (side) => waves.localHs(p.x + ux * mid - uz * 6 * side, p.z + uz * mid + ux * 6 * side);
  waves.field = null;
  const open = waves.localHs(0, 0);
  waves.field = f;
  const r = { open, east: berth(1), west: berth(-1), windFrom: wind.from };
  report.generated.berths = r;
  assert.ok(r.east <= 0.25 * open && r.west <= 0.25 * open, `berth Hs ${r.east}, ${r.west} vs open ${open}`);
});

console.log(JSON.stringify(report, null, 2));
if (failures) { console.error(`${failures} sea state test(s) failed`); process.exitCode = 1; }
else console.log('all sea state tests passed');
