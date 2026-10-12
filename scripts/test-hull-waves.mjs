import './register-ts.mjs';
// Hull in waves (docs/merchant-crew/hull-drag-fix.md): the hull's drag must not turn zero-mean orbital
// flow into a large steady resistance, while calm water and wave motions stay as they were.
// node scripts/test-hull-waves.mjs [--quick] [--report]
//   env PHYSICS=<path to a physics.ts copy> and HULL_FIX=<mode> are for prototyping only.
// The sea is built at a real mean wind speed (Wind's constructor argument is a seed) and
// waves.update() is called, so Gerstner steepness and horizontal orbital flow are on, as in the game.
import assert from 'node:assert/strict';
import * as THREE from 'three';
const physicsPath = process.env.PHYSICS ?? '../src/ship/physics.ts';
const physicsModule = await import(physicsPath);
const { ShipPhysics } = physicsModule;
if (process.env.HULL_FIX && physicsModule.HULL_FIX) physicsModule.HULL_FIX.mode = process.env.HULL_FIX;
if (process.env.HULL_TAU && physicsModule.HULL_FIX) physicsModule.HULL_FIX.tau = +process.env.HULL_TAU;
const { Crew } = await import('../src/ship/crew.ts');
const { Wind } = await import('../src/world/wind.ts');
const { WaveField } = await import('../src/world/waves.ts');
const { MERCHANT, TRIREME } = await import('../src/ship/design.ts');

const dt = 1 / 120, KN = 1.943844;
const quick = process.argv.includes('--quick');
const report = process.argv.includes('--report');
const SECS = quick ? 180 : 300, TAIL = quick ? 100 : 180;
const terrain = { heightAt: () => -100, normalAt: (x, z, out) => out.set(0, 1, 0) };
const still = { vx: 0, vz: 0, sampleAt: (x, y, z, t, out) => out.set(0, 0, 0) };
const wrapPi = (a) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };

/** a sea at mean wind U (m/s): the wind (seed 1) and its wave field; U = 0 is flat water under a 12 m/s wind */
function sea(U) {
  const wind = new Wind(1);
  wind.update(0);
  wind.baseSpeed = ((U || 12) ** 2) / wind.meanSpeed;
  wind.update(0);
  const waves = new WaveField(wind);
  if (!U) waves.waves.length = 0;
  else waves.update(Infinity);
  return { wind, waves, from: wind.from };
}

/**
 * Run one ship and return mean speed through the water (kn), motion SDs (deg, m) and heading change.
 * mode: 'tow' (oars idle or shipped, constant forward force F), 'row' (an order), 'sail' (sail set, auto trim)
 */
function trial(design, { U = 0, rel = 0, mode = 'tow', F = 0, order = 1, helm = null, wind = false, v0 = 0 } = {}) {
  const S = sea(U), heading = S.from + rel;
  const crew = new Crew();
  const ship = new ShipPhysics(S.waves, wind ? S.wind : still, terrain, crew, design);
  ship.place(0, 0, heading);
  ship.rowing.setShipped(-1, mode !== 'row');
  ship.rowing.setShipped(1, mode !== 'row');
  for (let i = 0; i < 240; i++) ship.step(dt);
  // start at the expected speed so a short run measures the steady state
  ship.vel.set(0, 0, -v0).applyQuaternion(ship.quat); ship.angVel.set(0, 0, 0);
  crew.setOrder(mode === 'row' ? order : 1);
  if (mode === 'sail') ship.sailing.deploymentTarget = 1;
  const m = ship.mass + ship.payloadMass, h0 = ship.heading;
  let sum = 0, n = 0;
  const heave = [], pitch = [], roll = [];
  for (let i = 0; i < SECS / dt; i++) {
    const t = i * dt;
    if (wind) S.wind.update(dt);
    if (helm === null) {
      const err = wrapPi(ship.heading - heading);
      ship.helm = THREE.MathUtils.clamp(-1.2 * err - 4 * -ship.angVel.y, -0.3, 0.3);
    } else ship.helm = helm;
    ship.step(dt);
    if (F) ship.vel.addScaledVector(_fwd.set(0, 0, -1).applyQuaternion(ship.quat), (F / m) * dt);
    if (t >= SECS - TAIL) {
      sum += ship.speed; n++;
      heave.push(ship.pos.y); pitch.push(ship.pitch); roll.push(ship.heel);
    }
  }
  return { kn: (sum / n) * KN, heaveSd: sd(heave), pitchSd: (sd(pitch) * 180) / Math.PI, rollSd: (sd(roll) * 180) / Math.PI,
    turnedDeg: (Math.abs(ship.heading - h0) * 180) / Math.PI, hs: S.waves.hs };
}
const _fwd = new THREE.Vector3();

// reference values measured with the current physics.ts (before the fix), 2026-10-10
const REF = {
  merchantCalmTow: 2.24, triremeCalmTow: null,
  motion: null,
};

const results = {};
let failures = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { failures++; console.error('FAIL', name, '\n  ', e.message); }
}
const HEAD = 0, BEAM = Math.PI / 2;
const TOW = { merchant: 193, trireme: 4900 };
const V0 = { merchant: 1.15, trireme: +(process.env.TRIREME_V0 ?? 3.44) };

for (const [name, design] of [['merchant', MERCHANT], ['trireme', TRIREME]]) {
  const tow = { F: TOW[name], v0: V0[name] };
  const calm = trial(design, tow);
  const head = trial(design, { U: 6, rel: HEAD, ...tow });
  const beam = trial(design, { U: 6, rel: BEAM, ...tow });
  const head12 = trial(design, { U: 12, rel: HEAD, ...tow });
  const beam12 = trial(design, { U: 12, rel: BEAM, ...tow });
  const restHead = trial(design, { U: 12, rel: HEAD });
  const restBeam = trial(design, { U: 12, rel: BEAM });
  results[name] = { calm, head, beam, head12, beam12, restHead, restBeam };
  test(`${name}: a towed hull keeps 85 % of its calm speed in a 0.4 m sea, head and beam`, () => {
    for (const [k, r] of [['head', head], ['beam', beam]]) assert.ok(r.kn >= 0.85 * calm.kn, `${k}: ${r.kn.toFixed(2)} kn vs calm ${calm.kn.toFixed(2)} kn`);
  });
}
test('merchant: calm-water tow unchanged (2.24 kn at 193 N, within 1 %)', () => {
  assert.ok(Math.abs(results.merchant.calm.kn / REF.merchantCalmTow - 1) <= 0.01, `${results.merchant.calm.kn.toFixed(3)} kn`);
});

// sailing: beam reach in a 12 m/s wind, waves vs flat water under the same wind
for (const [name, design] of [['merchant', MERCHANT], ['trireme', TRIREME]]) {
  const flat = trial(design, { mode: 'sail', rel: BEAM, wind: true });
  const rough = trial(design, { U: 12, mode: 'sail', rel: BEAM, wind: true });
  results[name].sail = { flat, rough };
}
// the merchant at Full in the default 12 m/s sea, and a hard-over pivot from rest
const fullCalm = trial(MERCHANT, { mode: 'row', order: 4 });
const fullHead = trial(MERCHANT, { U: 12, rel: HEAD, mode: 'row', order: 4 });
const fullBeam = trial(MERCHANT, { U: 12, rel: BEAM, mode: 'row', order: 4 });
results.merchant.full = { calm: fullCalm, head12: fullHead, beam12: fullBeam };

const r2 = (x) => +x.toFixed(3);
const flatten = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : flatten(v)]));
if (report || failures) console.log(JSON.stringify(flatten(results)));
const jsonOut = process.argv.find((a) => a.startsWith('--json='))?.slice(7);
if (jsonOut) (await import('node:fs')).writeFileSync(jsonOut, JSON.stringify(flatten(results), null, 1));
if (failures) { console.error(`${failures} failed`); process.exit(1); }
