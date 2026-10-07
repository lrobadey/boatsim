import './register-ts.mjs';
import assert from 'node:assert/strict';
import * as THREE from 'three';
const { Crew } = await import('../src/ship/crew.ts');
const { ShipPhysics } = await import('../src/ship/physics.ts');
const { Wind } = await import('../src/world/wind.ts');
const { WaveField } = await import('../src/world/waves.ts');
const { buildHarbour } = await import('../src/world/harbour.ts');
const { WalkGeometry } = await import('../src/world/walkable.ts');
const { halfBeam, sheer, zOf } = await import('../src/ship/hull.ts');
const { outriggerOf } = await import('../src/ship/mooring.ts');

const dt = 1 / 120, DEG = Math.PI / 180;
let failures = 0;
const report = {};
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { failures++; console.error('FAIL', name, '\n  ', e.message); }
}
const flat = () => { const w = new WaveField(new Wind(3)); w.waves.length = 0; return w; };
const single = (amp = 0.5, q = 0, phase = 0, dir = 1) => {
  const w = flat();
  w.waves.push({ dx: 0, dz: dir, k: 2 * Math.PI / 11, omega: Math.sqrt(9.81 * 2 * Math.PI / 11), phase, amp, target: amp, q });
  return w;
};
const terrain = { heightAt: () => -6, normalAt: (x, z, o) => o.set(0, 1, 0) };

// Synthetic harbour: pier box along +x from the origin (x 0..60, z ±3), one berth on the +z side.
const TOP = 1.8;
const pierBox = { kind: 'box', cx: 30, cz: 0, hx: 30, hz: 3, rot: 0, y0: -8, y1: TOP, surface: 'stone', walkTop: true };
function syntheticLayout() {
  const bollards = [21, 36, 51].map((x) => new THREE.Vector3(x, TOP, 2.3));
  const berth = { id: 0, name: 'Mole, south side', cx: 36, cz: 6, ax: 1, az: 0, nx: 0, nz: 1, length: 48, top: TOP, bollards };
  return {
    root: new THREE.Vector2(0, 0), dir: new THREE.Vector2(1, 0), length: 60, width: 6, top: TOP, berthStart: 12,
    berths: [berth], solids: [pierBox], shipColliders: [{ ...pierBox, walkTop: false }], steps: new THREE.Vector3(58, -0.9, 0),
  };
}
const H0 = Math.PI / 2; // heading with the bow toward +x (seaward)

function makeShip(waves = flat(), wind = { vx: 0, vz: 0 }, layout = syntheticLayout()) {
  const sh = new ShipPhysics(waves, wind, terrain, new Crew());
  sh.mooring.setHarbour(layout);
  return sh;
}
function settle(sh, x, z, heading, seconds = 3) {
  sh.place(x, z, heading);
  for (let i = 0; i < seconds / dt; i++) sh.step(dt);
  sh.vel.set(0, 0, 0);
  sh.angVel.set(0, 0, 0);
}
function probe(x, z, headingDeg, vx = 0, vz = 0) {
  const sh = makeShip();
  settle(sh, x, z, H0 + headingDeg * DEG);
  sh.vel.set(vx, 0, vz);
  sh.step(dt);
  return sh.mooring.approach;
}
/** largest penetration of an outrigger edge point into the pier body (|z| < 3, below the quay top) */
function outriggerPenetration(sh) {
  let pen = 0;
  const p = new THREE.Vector3();
  for (let i = 0; i <= 6; i++) {
    const s = 0.2 + i * 0.1;
    for (const sg of [-1, 1]) {
      sh.toWorld(p.set(sg * (halfBeam(s) + outriggerOf(s)), sheer(s), zOf(s)), p);
      if (p.x > 0 && p.x < 60 && p.y <= TOP) pen = Math.max(pen, 3 - Math.abs(p.z));
    }
  }
  return pen;
}

test('approach: 3 m off, 8 deg off, 0.5 m/s is inside the capture window', () => {
  const a = probe(36, 9, 8, 0, 0.5);
  assert.ok(a, 'approach computed');
  assert.equal(a.berth.name, 'Mole, south side');
  assert.ok(a.canMakeFast, `reason: ${a.reason}`);
  assert.equal(a.reason, null);
  assert.ok(Math.abs(a.lateral - 3) < 0.05, `lateral ${a.lateral}`);
  assert.ok(Math.abs(a.headingErr - 8 * DEG) < 0.01, `heading ${a.headingErr}`);
  assert.ok(a.quality > 0 && a.quality <= 1);
  assert.equal(a.bowOut, true);
});

test('approach reasons come out in plain words, most important first', () => {
  assert.equal(probe(36, 9, 0, 0, 2.0).reason, 'Too fast · slow below 2.5 kn');
  assert.match(probe(36, 12.5, 0).reason, /^\d\.\d m too far from quay$/);
  assert.equal(probe(36, 9, 22).reason, '22° off line');
  assert.match(probe(47, 6, 0).reason, /^\d+ m to berth$/);
  // distance outranks speed: far off at 4 kn the captain is told how far, not to slow down
  assert.match(probe(90, 9, 0, 0, 2.0).reason, /m to berth$/);
  assert.equal(probe(36, 9, 0, 0, 0.5).canMakeFast, true);
  // no berth within 220 m: approach is null
  const far = makeShip();
  settle(far, 400, 400, H0);
  far.step(dt);
  assert.equal(far.mooring.approach, null);
});

test('makeFast hauls the ship in gently (< 0.7 m/s) and reaches moored within 20 s with pose error < 0.4 m', () => {
  const sh = makeShip();
  settle(sh, 36, 9, H0 + 8 * DEG);
  sh.vel.set(0, 0, 0.4);
  sh.step(dt);
  const m = sh.mooring;
  assert.ok(m.approach.canMakeFast);
  assert.equal(m.makeFast(), true);
  assert.equal(m.state, 'warping');
  assert.equal(m.lines.length, 4);
  let t = 0, peak = 0;
  while (m.state !== 'moored' && t < 20.5) { sh.step(dt); t += dt; peak = Math.max(peak, Math.hypot(sh.vel.x, sh.vel.z)); }
  assert.ok(peak < 0.7, `peak speed while hauling ${peak.toFixed(2)} m/s`);
  assert.equal(m.state, 'moored', `state after ${t.toFixed(2)} s, pose error ${Math.hypot(sh.pos.x - 36, sh.pos.z - 6).toFixed(3)} m`);
  assert.ok(t <= 20, `moored after ${t.toFixed(2)} s`);
  const err = Math.hypot(sh.pos.x - 36, sh.pos.z - 6);
  assert.ok(err < 0.4, `pose error ${err}`);
  const ev = m.drain();
  const moored = ev.find((e) => e.type === 'moored');
  assert.ok(moored, 'moored event');
  assert.ok(['Perfect', 'Good', 'Rough'].includes(moored.rating));
  assert.ok(ev.some((e) => e.type === 'made-fast'));
  report.warp = { seconds: t, poseError: err, rating: moored.rating, contactSpeed: moored.contactSpeed };
});

test('gangplank deploys on a 2 s animation while moored and its shore end sits on the quay top', () => {
  const sh = makeShip();
  settle(sh, 36, 9, H0 + 8 * DEG);
  sh.vel.set(0, 0, 0.4);
  sh.step(dt);
  sh.mooring.makeFast();
  let t = 0;
  while (sh.mooring.state !== 'moored' && t < 21) { sh.step(dt); t += dt; }
  assert.ok(sh.mooring.plank.deployed < 0.5);
  for (let i = 0; i < 2.2 / dt; i++) sh.step(dt);
  const p = sh.mooring.plank;
  assert.ok(p.deployed > 0.99, `deployed ${p.deployed}`);
  assert.equal(p.shoreWorld.y, TOP);
  assert.ok(Math.abs(p.shoreWorld.z - 3) < 1.6, `shore z ${p.shoreWorld.z}`);
  assert.equal(p.station, 0.62);
});

test('moored ship in waves stays within 0.6 m of her berth', () => {
  const sh = makeShip(single(0.5, 0.5, 0.3, 1));
  settle(sh, 36, 9, H0 + 8 * DEG);
  sh.vel.set(0, 0, 0.4);
  sh.step(dt);
  sh.mooring.makeFast();
  let t = 0;
  while (sh.mooring.state !== 'moored' && t < 13) { sh.step(dt); t += dt; }
  assert.equal(sh.mooring.state, 'moored');
  let worst = 0;
  for (let i = 0; i < 90 / dt; i++) {
    sh.step(dt);
    worst = Math.max(worst, Math.hypot(sh.pos.x - 36, sh.pos.z - 6));
  }
  assert.equal(sh.mooring.state, 'moored');
  assert.ok(worst < 0.6, `worst drift ${worst}`);
  report.waves = { worstDrift: worst };
});

test('quay impact at 2 m/s: no penetration over 0.2 m, bump event throttled to 0.4 s', () => {
  const sh = makeShip();
  settle(sh, 36, 6, H0);
  sh.step(dt);
  assert.ok(sh.mooring.approach);
  sh.vel.set(0, 0, -2);
  let worst = 0, bumps = [], tBump = [];
  let t = 0;
  for (let i = 0; i < 1.5 / dt; i++) {
    sh.step(dt);
    t += dt;
    worst = Math.max(worst, outriggerPenetration(sh));
    for (const e of sh.mooring.drain()) if (e.type === 'bump') { bumps.push(e.speed); tBump.push(t); }
  }
  assert.ok(bumps.length >= 1, 'bump emitted');
  for (let i = 1; i < tBump.length; i++) assert.ok(tBump[i] - tBump[i - 1] >= 0.39, 'bump throttle');
  assert.ok(bumps[0] > 1.0, `first bump ${bumps[0]}`);
  assert.ok(worst < 0.2, `penetration ${worst} m`);
  report.impact = { penetration: worst, bumps: bumps.length, firstSpeed: bumps[0] };
});

test('anchored ship in 15 kn of wind stays within rode + 3 m', () => {
  const wind = { vx: 15 * 0.5144, vz: 0 };
  const sh = makeShip(flat(), wind, null);
  sh.mooring.setHarbour({ berths: [], solids: [], shipColliders: [], root: null, dir: null, length: 0, width: 0, top: 0, berthStart: 0, steps: null });
  settle(sh, 0, 0, 0);
  assert.equal(sh.mooring.dropAnchor(), true);
  const anchor = sh.mooring.anchorAt.clone();
  assert.equal(sh.mooring.state, 'anchored');
  const bow = new THREE.Vector3();
  let worst = 0;
  for (let i = 0; i < 240 / dt; i++) {
    sh.step(dt);
    sh.toWorld(new THREE.Vector3(0, 0, zOf(0.12)), bow);
    worst = Math.max(worst, Math.hypot(bow.x - anchor.x, bow.z - anchor.z));
  }
  assert.ok(worst <= sh.mooring.rode + 3, `bow drift ${worst}`);
  assert.ok(worst > sh.mooring.rode - 1, `never reached the rode: ${worst}`);
  sh.mooring.weighAnchor();
  assert.equal(sh.mooring.state, 'free');
  const ev = sh.mooring.drain().map((e) => e.type);
  assert.ok(ev.includes('anchor-down') && ev.includes('anchor-up'));
  report.anchor = { maxBowDistance: worst, rode: sh.mooring.rode };
});

test('castOff releases the lines, shoves her off the quay and stows the plank', () => {
  const sh = makeShip();
  settle(sh, 36, 9, H0 + 8 * DEG);
  sh.vel.set(0, 0, 0.4);
  sh.step(dt);
  sh.mooring.makeFast();
  let t = 0;
  while (sh.mooring.state !== 'moored' && t < 13) { sh.step(dt); t += dt; }
  for (let i = 0; i < 2.5 / dt; i++) sh.step(dt);
  const z0 = sh.pos.z;
  sh.mooring.castOff();
  assert.equal(sh.mooring.state, 'free');
  assert.equal(sh.mooring.lines.length, 0);
  for (let i = 0; i < 1 / dt; i++) sh.step(dt);
  assert.ok(sh.pos.z - z0 > 0.1, `shoved ${sh.pos.z - z0} m`);
  for (let i = 0; i < 2.2 / dt; i++) sh.step(dt);
  assert.ok(sh.mooring.plank.deployed < 0.01, `plank ${sh.mooring.plank.deployed}`);
  assert.ok(sh.mooring.drain().some((e) => e.type === 'cast-off'));
});

test('harbour solids: walkable mole, quay steps down to -1.0 m, bollards and collider', () => {
  const pier = { x: 0, z: 0, angle: 0, length: 80, width: 6, top: 1.8, berthStart: 20 };
  const gen = {
    heights: new Float32Array(4), size: 2, worldSize: 2, islands: [], vegetation: new Float32Array(0), ao: new Uint8Array(4), aoSize: 2,
    sites: { harbour: { x: 0, z: 0, openAngle: 0 }, shore: { x: 0, z: 0 }, temple: { x: 300, z: 0, y: 40 }, houses: [{ x: -10, z: 20, y: 3, maxY: 4, w: 5, l: 6, hgt: 3, rot: 0 }], pier, start: { x: 0, z: 0, heading: 0 } },
  };
  const L = buildHarbour(gen, terrain);
  assert.equal(L.berths.length, 2);
  assert.deepEqual(L.berths.map((b) => b.name), ['Mole, north side', 'Mole, south side']);
  for (const b of L.berths) { assert.equal(b.bollards.length, 3); assert.equal(b.cx, 50); assert.equal(Math.abs(b.cz), 6); }
  assert.equal(L.shipColliders.length, 1);
  assert.equal(L.shipColliders[0].hx, 40);
  const g = new WalkGeometry(null);
  for (const s of L.solids) g.add(s);
  const sup = { y: 0, nx: 0, ny: 0, nz: 0, kind: 'stone', solid: null };
  assert.ok(g.support(5, 0, 2.5, sup), 'mole walkable');
  assert.equal(sup.y, 1.8);
  // stairs: nine 2.8/9 m risers from the top (1.8) down to -1.0 at the head
  const bodyLen = 80 - 9 * 0.35;
  assert.ok(g.support(bodyLen + 0.1, 0, 2.5, sup));
  assert.ok(Math.abs(sup.y - (1.8 - 2.8 / 9)) < 1e-9, `first tread ${sup.y}`);
  assert.ok(g.support(80 - 0.1, 0, 2.5, sup));
  assert.ok(Math.abs(sup.y + 1.0) < 1e-9, `bottom tread ${sup.y}`);
  assert.ok(Math.abs(L.steps.y + 1.0) < 1e-9);
  // the stair notch is open to the sides only through the strips
  assert.ok(g.support(bodyLen + 0.1, 2.0, 2.5, sup));
  assert.equal(sup.y, 1.8);
  report.solids = { count: L.solids.length, berthNames: L.berths.map((b) => b.name) };
});

if (failures) process.exitCode = 1;
console.log(JSON.stringify(report, null, 2));
console.log(failures ? `${failures} FAILED` : 'all mooring tests passed');
