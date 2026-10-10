import './register-ts.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import * as THREE from 'three';

const { SAIL_RIG, evaluateSailSample, sailSampleArea } = await import('../src/ship/sailGeometry.ts');
const { evaluateSailForce, SailingSystem } = await import('../src/ship/sailing.ts');
const { hullLateralForce } = await import('../src/ship/hullLateral.ts');
const { Crew } = await import('../src/ship/crew.ts');
const { ShipPhysics } = await import('../src/ship/physics.ts');
const { Wind } = await import('../src/world/wind.ts');
const { WaveField } = await import('../src/world/waves.ts');
const { rng, noise1 } = await import('../src/core/util.ts');
const { deckY, zOf } = await import('../src/ship/hull.ts');

const dt = 1 / 120, kn = 1.943844, DEG = Math.PI / 180;
const report = { host: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, runtime: process.version }, tests: [], measured: {} };
let failures = 0;
const filter = process.argv.find(a => a.startsWith('--test='))?.slice(7);
function test(name, fn) {
  if (filter && !name.includes(filter)) return;
  const start = performance.now();
  try { fn(); report.tests.push({ name, status: 'passed', ms: performance.now() - start }); console.log('PASS', name); }
  catch (e) { failures++; report.tests.push({ name, status: 'failed', error: e?.stack ?? String(e) }); console.error('FAIL', name, e?.stack ?? e); }
}
const near = (a, b, e = 1e-9, message = '') => assert.ok(Math.abs(a - b) <= e, `${message}${a} != ${b} (tol ${e})`);
const relative = (a, b, e, message = '') => assert.ok(Math.abs(a - b) <= e * Math.max(1e-9, Math.abs(a), Math.abs(b)), `${message}${a} != ${b} (relative tol ${e})`);
const terrain = { heightAt: () => -100, normalAt: (x, z, out) => out.set(0, 1, 0) };
function flat() { const waves = new WaveField(new Wind(1)); waves.waves.length = 0; return waves; }
function uniformWind(vx = 0, vz = 0) { return { vx, vz }; }
function bodyState() { return { pos: new THREE.Vector3(2, 3, -4), quat: new THREE.Quaternion(), vel: new THREE.Vector3(), angVel: new THREE.Vector3(), cg: new THREE.Vector3(0, .3, 0) }; }
function localToWorld(body, local, out = new THREE.Vector3()) { return out.copy(local).sub(body.cg).applyQuaternion(body.quat).add(body.pos); }
function worldPointVelocity(body, p, out = new THREE.Vector3()) { return out.copy(body.angVel).cross(p.clone().sub(body.pos)).add(body.vel); }
function ship({ wind = new Wind(3), waves = flat(), heading = 0 } = {}) {
  const crew = new Crew(), s = new ShipPhysics(waves, wind, terrain, crew); s.place(0, 0, heading); return s;
}
function runShip(s, seconds, h = dt, update = () => {}) {
  const n = Math.round(seconds / h); let sailImpulse = 0, oarImpulse = 0, last = [];
  for (let i = 0; i < n; i++) {
    update(i * h, s); s.step(h);
    sailImpulse += s.sailing.telemetry.forwardForce * h; oarImpulse += s.oarThrust * h;
    if (i >= n - Math.round(Math.min(30, seconds / 4) / h)) last.push(s.speed);
  }
  const mean = last.reduce((a, b) => a + b, 0) / Math.max(1, last.length);
  return { meanLast30Mps: mean, meanLast30Kn: mean * kn, speedMps: s.speed, stamina: s.crew.stamina, sailImpulseNs: sailImpulse, oarImpulseNs: oarImpulse, heel: s.heel, leeway: s.leeway };
}

test('1 geometry: shared yard samples, exposed area, extents and rigid-body velocity', () => {
  const origin = new THREE.Vector3(0, deckY(SAIL_RIG.mastStation) + SAIL_RIG.mastHeight - SAIL_RIG.yardDrop, zOf(SAIL_RIG.mastStation));
  const basis = new THREE.Vector3();
  let maxVelocityError = 0;
  for (const set of [0, .5, 1]) {
    let totalArea = 0;
    for (let i = 0; i < SAIL_RIG.sampleCount; i++) totalArea += sailSampleArea(set);
    near(totalArea, SAIL_RIG.area * set, 1e-10, `set ${set} area `);
    if (set === 0) continue;
    const points = [];
    for (const yard of [-Math.PI / 4, 0, Math.PI / 4]) {
      for (let i = 0; i < SAIL_RIG.sampleCount; i++) {
        const p = evaluateSailSample(i, set, yard, new THREE.Vector3()); points.push(p.clone());
        const x = SAIL_RIG.width * ((i % 3 + .5) / 3 - .5);
        const y = -SAIL_RIG.clothTopDrop - SAIL_RIG.height * set * (Math.floor(i / 3) + .5) / 3;
        basis.set(x, y, SAIL_RIG.clothOffsetZ).applyAxisAngle(new THREE.Vector3(0, 1, 0), yard).add(origin);
        assert.ok(p.distanceTo(basis) < 1e-10, `sample ${i}, yard ${yard}`);
      }
      const tangent = new THREE.Vector3(Math.cos(yard), 0, -Math.sin(yard));
      const normal = new THREE.Vector3(Math.sin(yard), 0, Math.cos(yard));
      near(tangent.dot(normal), 0, 1e-12);
      near(tangent.length(), 1, 1e-12); near(normal.length(), 1, 1e-12);
    }
    if (set === 1) {
      const xs = points.map(p => p.x), ys = points.map(p => p.y);
      assert.ok(Math.max(...xs) - Math.min(...xs) <= SAIL_RIG.width + 1e-10);
      assert.ok(Math.max(...ys) - Math.min(...ys) <= SAIL_RIG.height + 1e-10);
    }
  }
  const body = bodyState(); body.quat.setFromEuler(new THREE.Euler(.13, -.27, .08)); body.vel.set(1.4, -.2, 2.1); body.angVel.set(.17, -.23, .31);
  const h = 1e-5;
  for (let i = 0; i < SAIL_RIG.sampleCount; i++) {
    const pLocal = evaluateSailSample(i, .63, .31, new THREE.Vector3());
    const p = localToWorld(body, pLocal), expected = worldPointVelocity(body, p);
    const moved = bodyState(), before = bodyState();
    moved.quat.setFromAxisAngle(body.angVel.clone().normalize(), body.angVel.length() * h).multiply(body.quat); moved.pos.copy(body.pos).addScaledVector(body.vel, h);
    before.quat.setFromAxisAngle(body.angVel.clone().normalize(), -body.angVel.length() * h).multiply(body.quat); before.pos.copy(body.pos).addScaledVector(body.vel, -h);
    const pNext = localToWorld(moved, pLocal), pPrev = localToWorld(before, pLocal); const measured = pNext.sub(pPrev).multiplyScalar(1 / (2 * h));
    maxVelocityError = Math.max(maxVelocityError, expected.distanceTo(measured));
  }
  assert.ok(maxVelocityError < 1e-5, `sample rigid-body velocity error ${maxVelocityError}`);
  const accumulatorProbe = () => { const sail = new SailingSystem(), b = bodyState(), wind = uniformWind(0, -8), f = new THREE.Vector3(), m = new THREE.Vector3(); sail.deploymentTarget = 1; sail.trimMode = 'manual'; for (let i = 0; i < 1200; i++) sail.step(dt, (i + 1) * dt, b, wind, f.set(0, 0, 0), m.set(0, 0, 0)); return { sail, b, wind }; };
  const a = accumulatorProbe(), b = accumulatorProbe(), f0 = new THREE.Vector3(1e6, -2e6, 3e6), m0 = new THREE.Vector3(-4e6, 5e6, -6e6), f = f0.clone(), m = m0.clone(), fExpected = new THREE.Vector3(), mExpected = new THREE.Vector3();
  a.sail.step(dt, 1200 * dt + dt, a.b, a.wind, fExpected, mExpected); b.sail.step(dt, 1200 * dt + dt, b.b, b.wind, f, m);
  assert.ok(f.distanceTo(f0) > 0 && m.distanceTo(m0) > 0, 'sailing cleared or skipped caller accumulators');
  assert.ok(f.clone().sub(f0).distanceTo(fExpected) < 1e-8 && m.clone().sub(m0).distanceTo(mExpected) < 1e-8, 'sail contribution differs with preloaded accumulators');
  report.measured.geometry = { maxVelocityErrorMps: maxVelocityError, fullArea: sailSampleArea(1) * 9, halfArea: sailSampleArea(.5) * 9, accumulatorSailLoadN: a.sail.telemetry.load };
});

test('2 pure aero: passivity, symmetry, broadside lift and continuous coefficients', () => {
  const random = rng(2301), out = new THREE.Vector3(), mirror = new THREE.Vector3(), coeff = { alpha: 0, liftCoefficient: 0, dragCoefficient: 0 };
  let maxPowerRatio = -Infinity, maxMirror = 0, maxContinuityJump = 0;
  for (let i = 0; i < 1000; i++) {
    const u = new THREE.Vector3(random() * 30 - 15, random() * 8 - 4, random() * 30 - 15);
    const n = new THREE.Vector3(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).normalize();
    const fill = random() * 2 - 1; const area = random() * 70;
    evaluateSailForce(u, n, area, fill, out, coeff);
    const power = out.dot(u), tolerance = 1e-8 * Math.max(1, out.length() * u.length());
    assert.ok(power >= -tolerance, `active sail power ${power}`); maxPowerRatio = Math.max(maxPowerRatio, -power / Math.max(1, out.length() * u.length()));
    const um = new THREE.Vector3(-u.x, u.y, u.z), nm = new THREE.Vector3(-n.x, n.y, n.z);
    evaluateSailForce(um, nm, area, fill, mirror); const expected = out.clone().set(-out.x, out.y, out.z);
    maxMirror = Math.max(maxMirror, mirror.distanceTo(expected) / Math.max(1, mirror.length(), expected.length()));
  }
  evaluateSailForce(new THREE.Vector3(), new THREE.Vector3(0, 0, 1), 70, 1, out); near(out.length(), 0, 0, 'zero flow ');
  const broadside = new THREE.Vector3(8, 0, 0), normal = new THREE.Vector3(0, 0, 1);
  evaluateSailForce(broadside, normal, 70, 1, out, coeff); near(coeff.liftCoefficient, 0, 1e-12, 'broadside lift ');
  const evalAlpha = alpha => { const u = new THREE.Vector3(Math.cos(alpha), 0, Math.sin(alpha)); evaluateSailForce(u, normal, 70, 1, out, coeff); return [coeff.liftCoefficient, coeff.dragCoefficient]; };
  for (const angle of [18 * DEG, 32 * DEG, 90 * DEG]) {
    const left = evalAlpha(angle - 1e-5), right = evalAlpha(angle + 1e-5);
    for (let j = 0; j < 2; j++) { const jump = Math.abs(left[j] - right[j]); maxContinuityJump = Math.max(maxContinuityJump, jump); assert.ok(jump < .001, `coefficient discontinuity ${angle} ${jump}`); }
  }
  assert.ok(maxMirror <= 1e-8, `mirror error ${maxMirror}`);
  report.measured.aero = { samples: 1000, maxNegativePowerRatio: maxPowerRatio, maxMirrorRelativeError: maxMirror, maxCoefficientJump: maxContinuityJump };
});

test('3 cloth state: luffing, signed fill, reversal, flutter and actuator limits', () => {
  const body = bodyState(), wind = uniformWind(), force = new THREE.Vector3(), torque = new THREE.Vector3();
  const run = (windValue, seconds, initialYard = 0) => {
    const sailing = new SailingSystem(); sailing.deploymentTarget = 1; sailing.trimMode = 'manual'; sailing.manualYardTarget = initialYard;
    const w = uniformWind(...windValue); for (let i = 0; i < Math.round(seconds / dt); i++) sailing.step(dt, (i + 1) * dt, body, w, force.set(0, 0, 0), torque.set(0, 0, 0)); return sailing;
  };
  const edge = run([8, 0], 12, 0); assert.ok(Math.abs(edge.current.fill) < .05, `edge fill ${edge.current.fill}`);
  const following = run([0, -8], 12, 0), head = run([0, 8], 12, 0);
  assert.ok(following.current.fill < -.8, `following signed fill ${following.current.fill}`);
  assert.ok(head.current.fill > .8, `headwind signed fill ${head.current.fill}`);
  assert.ok(following.telemetry.pressure < 0 && head.telemetry.pressure > 0, `pressure sign should follow loaded cloth ${following.telemetry.pressure}/${head.telemetry.pressure}`);
  assert.equal(edge.telemetry.status, 'luffing'); assert.equal(following.telemetry.status, 'drawing'); assert.equal(head.telemetry.status, 'aback');
  const reversing = new SailingSystem(); reversing.deploymentTarget = 1; reversing.trimMode = 'manual';
  const steps = []; let maxFillDelta = 0;
  for (let i = 0; i < 600; i++) { const w = i < 300 ? uniformWind(0, -8) : uniformWind(0, 8); const before = reversing.current.fill; reversing.step(dt, (i + 1) * dt, body, w, force.set(0, 0, 0), torque.set(0, 0, 0)); const d = Math.abs(reversing.current.fill - before); maxFillDelta = Math.max(maxFillDelta, d); steps.push(reversing.current.fill); }
  assert.ok(steps.slice(300).some((v, i, a) => i > 0 && v * a[i - 1] <= 0), 'fill crosses zero after reversal');
  assert.ok(maxFillDelta <= .1, `fill step ${maxFillDelta}`);
  const calm = run([0, 0], 12, 0); near(calm.telemetry.flutter, 0, 1e-12, 'calm flutter ');
  const actuator = new SailingSystem(); actuator.deploymentTarget = 1; actuator.trimMode = 'manual'; actuator.manualYardTarget = -Math.PI / 4;
  let maxYardRate = 0;
  for (let i = 0; i < 720; i++) { const old = actuator.current.yardAngle, oldSet = actuator.current.deployment; actuator.step(dt, (i + 1) * dt, body, uniformWind(0, -8), force.set(0, 0, 0), torque.set(0, 0, 0)); maxYardRate = Math.max(maxYardRate, Math.abs(actuator.current.yardAngle - old) / dt); assert.ok(Math.abs(actuator.current.deployment - oldSet) <= dt / 6 + 1e-9); }
  near(actuator.current.deployment, 1, 1 / 120 + 1e-10); assert.ok(maxYardRate <= .25 + 1e-9);
  report.measured.clothState = { followingFill: following.current.fill, headwindFill: head.current.fill, maxFillStep: maxFillDelta, maxYardRateRadS: maxYardRate, deploymentAfterSixSeconds: actuator.current.deployment };
});

test('4 wind: calm, height shear, pure explicit-time determinism and update cadence', () => {
  const w = new Wind(71), outA = new THREE.Vector3(), outB = new THREE.Vector3();
  w.baseSpeed = 0;
  for (const y of [0, 10, 30]) for (const [x, z, t] of [[0, 0, 0], [23, -41, 7.3], [-11, 5, 31]]) { w.sampleAt(x, y, z, t, outA); near(outA.length(), 0, 0); }
  w.baseSpeed = 8;
  for (const [x, z, t] of [[0, 0, 0], [31, -12, 9], [-53, 18, 19]]) {
    w.sampleAt(x, 10, z, t, outA); w.sampleAt(x, 0, z, t, outB); near(outB.length() / outA.length(), Math.pow(.05, .11), 1e-12);
    w.sampleAt(x, 30, z, t, outB); near(outB.length() / outA.length(), Math.pow(3, .11), 1e-12);
  }
  const points = [[3, 10, -7, 14], [-12, 0, 31, 4], [8, 30, 19, 2.5]], base = points.map(p => { w.sampleAt(...p, outA); return outA.clone(); });
  for (let j = points.length - 1; j >= 0; j--) { w.sampleAt(...points[j], outA); assert.deepEqual(outA.toArray(), base[j].toArray()); }
  const t10 = 10, slow10 = .35 * noise1(t10 / 600, 71 + 7), gust10 = .18 * noise1(t10 / 6, 71 + 11) + .08 * noise1(t10 / 1.7, 71 + 13);
  const from10 = w.baseFrom + .42 * noise1(t10 / 420, 71) + .08 * noise1(t10 / 37, 71 + 3), speed10 = 8 * (1 + slow10) * (1 + gust10);
  w.sampleAt(0, 10, 0, t10, outA); near(outA.length(), speed10, 1e-12); near(outA.x, Math.sin(from10 + Math.PI) * speed10, 1e-12); near(outA.z, -Math.cos(from10 + Math.PI) * speed10, 1e-12);
  w.sampleAt(0, 10, 0, 10, outA); w.sampleAt(.01, 10, 0, 10.001, outB); const localDelta = outA.distanceTo(outB);
  assert.ok(localDelta < .02, `nearby wind discontinuity ${localDelta}`);
  const a = new Wind(82), b = new Wind(82), n120 = 1200, n240 = 2400;
  // Keep this cadence fixture pinned to its original 8 m/s reference after the default wind changes.
  a.baseSpeed = b.baseSpeed = 8;
  for (let i = 0; i < n120; i++) a.update(1 / 120); for (let i = 0; i < n240; i++) b.update(1 / 240);
  near(a.speed, b.speed, 1e-9); near(a.from, b.from, 1e-9); near(a.meanSpeed, b.meanSpeed, 1e-9);
  near(a.meanSpeed, 8 * (1 + .35 * noise1(10 / 600, 82 + 7)), 1e-9, 'mean sea wind must exclude gusts ');
  const withoutGust = 8 * (1 + .35 * noise1(10 / 600, 82 + 7));
  report.measured.wind = { calmSamples: 9, tenMeterSpeedMps: speed10, cadenceDeltaSpeed: Math.abs(a.speed - b.speed), cadenceDeltaDirection: Math.abs(a.from - b.from), localDeltaMps: localDelta, finalMeanSpeed: a.meanSpeed, finalGustSpeed: a.speed, recoveredSlowMean: withoutGust };
});

test('5 reef: area, load scaling, load-center motion and continuous deployment', () => {
  const body = bodyState(), wind = uniformWind(0, -8), force = new THREE.Vector3(), torque = new THREE.Vector3();
  const settled = set => { const s = new SailingSystem(); s.trimMode = 'manual'; s.manualYardTarget = 0; s.deploymentTarget = set; for (let i = 0; i < 900; i++) s.step(dt, (i + 1) * dt, body, wind, force.set(0, 0, 0), torque.set(0, 0, 0)); return s; };
  const full = settled(1), half = settled(.5);
  assert.ok(half.telemetry.load / full.telemetry.load >= .45 && half.telemetry.load / full.telemetry.load <= .55, `uniform half/full load ${half.telemetry.load / full.telemetry.load}`);
  const windField = new Wind(3), sheared = set => { const s = new SailingSystem(); s.trimMode = 'manual'; s.manualYardTarget = 0; s.deploymentTarget = set; for (let i = 0; i < 900; i++) s.step(dt, (i + 1) * dt, body, windField, force.set(0, 0, 0), torque.set(0, 0, 0)); return s; };
  const shearedFull = sheared(1), shearedHalf = sheared(.5);
  assert.ok(shearedHalf.telemetry.load < shearedFull.telemetry.load * .65, `sheared reef reduction ${shearedHalf.telemetry.load / shearedFull.telemetry.load}`);
  function centerY(set) { let y = 0, area = 0; const p = new THREE.Vector3(); for (let i = 0; i < 9; i++) { const a = sailSampleArea(set); y += evaluateSailSample(i, set, 0, p).y * a; area += a; } return y / area; }
  assert.ok(centerY(.5) > centerY(1), `reef load center did not rise: ${centerY(.5)} vs ${centerY(1)}`);
  const moving = new SailingSystem(); moving.deploymentTarget = 1; moving.trimMode = 'manual'; let priorLoad = 0, maxStepFraction = 0;
  for (let i = 0; i < 720; i++) { moving.step(dt, (i + 1) * dt, body, wind, force.set(0, 0, 0), torque.set(0, 0, 0)); maxStepFraction = Math.max(maxStepFraction, Math.abs(moving.telemetry.load - priorLoad) / Math.max(full.telemetry.load, 1)); priorLoad = moving.telemetry.load; }
  assert.ok(maxStepFraction <= .03, `deployment force step fraction ${maxStepFraction}`);
  report.measured.reef = { uniformLoadRatio: half.telemetry.load / full.telemetry.load, shearedLoadRatio: shearedHalf.telemetry.load / shearedFull.telemetry.load, fullCenterY: centerY(1), halfCenterY: centerY(.5), maxDeploymentForceStepFraction: maxStepFraction };
});

test('6 hull balance and mirrored sail/water response', () => {
  const random = rng(916), out = new THREE.Vector3(); let maxPower = -Infinity, maxMirror = 0;
  for (let i = 0; i < 1000; i++) { const vx = random() * 12 - 6, vz = random() * 12 - 6, area = random() * 4; hullLateralForce(vx, vz, area, out); const p = out.x * vx + out.z * vz; maxPower = Math.max(maxPower, p); assert.ok(p <= 1e-8, `hull injects water-relative power ${p}`); hullLateralForce(-vx, vz, area, new THREE.Vector3()); }
  for (const vz of [-5, -1, 1, 5]) { hullLateralForce(0, vz, .5, out); near(out.x, 0, 1e-10); near(out.z, 0, 1e-9); }
  // At pure axial velocity the helper preserves only the old crossflow lateral term (zero).
  hullLateralForce(0, -4, .7, out); near(out.x, 0, 1e-10); near(out.z, 0, 1e-9);
  const make = sign => { const w = uniformWind(-8 * sign, 0); const s = ship({ wind: w, heading: 0 }); s.sailing.deploymentTarget = 1; s.sailing.trimMode = 'manual'; s.sailing.manualYardTarget = sign * Math.PI / 4; s.crew.setOrder(1); for (let i = 0; i < 1800; i++) s.step(dt); return s; };
  const port = make(-1), starboard = make(1);
  assert.ok(Number.isFinite(port.leeway) && Number.isFinite(port.heel));
  assert.ok(Math.abs(port.sailing.telemetry.lateralForce) > 1 && Math.abs(port.sailing.telemetry.heelMoment) > 1, `loaded sail sideforce/moment ${port.sailing.telemetry.lateralForce}, ${port.sailing.telemetry.heelMoment}`);
  assert.ok(Math.abs(port.vel.x) > .01 && Math.abs(port.heel) > .05 * DEG, `measured lateral slip/heel ${port.vel.x}, ${port.heel}`);
  assert.ok(Math.abs(port.vel.x + starboard.vel.x) < .02, `lateral acceleration response mirror ${port.vel.x}/${starboard.vel.x}`);
  assert.ok(Math.abs(port.leeway + starboard.leeway) < .02, `leeway mirror ${port.leeway}/${starboard.leeway}`);
  assert.ok(Math.abs(port.heel + starboard.heel) < .02, `heel mirror ${port.heel}/${starboard.heel}`);
  report.measured.hull = { maxWaterRelativePowerW: maxPower, mirrorLateralVelocityMps: port.vel.x + starboard.vel.x, mirrorLeewayRadians: port.leeway + starboard.leeway, mirrorHeelRadians: port.heel + starboard.heel, lateralVelocityMps: port.vel.x, leewayRadians: port.leeway, heelDegrees: port.heel / DEG };
});

test('7 propulsion regimes: sail-only, row-only, combined and calm coupling', () => {
  const make = (kind, windSpeed = 8) => {
    const w = uniformWind(0, -windSpeed);
    const s = ship({ wind: w }); s.crew.setOrder(kind === 'sail' ? 1 : 4); s.sailing.deploymentTarget = kind === 'row' ? 0 : 1; s.sailing.trimMode = 'manual'; s.sailing.manualYardTarget = 0; return s;
  };
  const sail = runShip(make('sail'), 120), row = runShip(make('row'), 120), combinedShip = make('combined');
  const staticSail = new SailingSystem(), staticBody = bodyState(); staticSail.deploymentTarget = 1; staticSail.trimMode = 'manual';
  for (let i = 0; i < 2400; i++) staticSail.step(dt, (i + 1) * dt, staticBody, uniformWind(0, -8), new THREE.Vector3(), new THREE.Vector3());
  const staticLoad = staticSail.telemetry.load; const combined = runShip(combinedShip, 120);
  assert.ok(sail.meanLast30Mps > .3, `sail-only ${sail.meanLast30Mps}`); assert.ok(sail.stamina >= 1 - 1e-12, `sail stamina ${sail.stamina}`);
  assert.ok(row.meanLast30Mps > .3, `row-only ${row.meanLast30Mps}`);
  assert.ok(combined.meanLast30Mps > row.meanLast30Mps + .05, `combined ${combined.meanLast30Mps} row ${row.meanLast30Mps}`);
  assert.ok(Math.abs(combined.meanLast30Mps - sail.meanLast30Mps) > .01, 'combined indistinguishable from sail-only');
  assert.ok(Math.abs(combinedShip.sailing.telemetry.load - staticLoad) > 1, 'boat speed did not change apparent-wind sail load');
  const calmRow = runShip(make('row', 0), 60), calmCombinedShip = make('combined', 0); const calmCombined = runShip(calmCombinedShip, 60);
  relative(calmCombined.meanLast30Mps, calmRow.meanLast30Mps, .05, 'calm row/combined speed ');
  report.measured.regimes = { sailOnly: sail, rowOnly: row, combined, combinedStaticSailLoadN: staticLoad, combinedMovingSailLoadN: combinedShip.sailing.telemetry.load, calmRowOnly: calmRow, calmCombined };
});

test('8 no-go crossing: continuous sweep and rowing through headwind', () => {
  const wind = uniformWind(0, 8), body = bodyState(), force = new THREE.Vector3(), torque = new THREE.Vector3();
  const sailing = new SailingSystem(); sailing.deploymentTarget = 1; sailing.trimMode = 'auto';
  const sweep = []; let prevFill = 0, prevYard = 0, maxYardStepRate = 0, maxFillJump = 0, maxForceJump = 0, prevForward = 0, minPressure = Infinity, maxPressure = -Infinity; const statuses = new Set();
  for (let i = 0; i <= 4800; i++) { const heading = (-80 + 160 * i / 4800) * DEG; body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading); sailing.step(dt, i * (40 / 4800), body, wind, force.set(0, 0, 0), torque.set(0, 0, 0)); const dFill = Math.abs(sailing.current.fill - prevFill), dForce = Math.abs(sailing.telemetry.forwardForce - prevForward); maxFillJump = Math.max(maxFillJump, dFill); maxForceJump = Math.max(maxForceJump, dForce); if (i > 0) maxYardStepRate = Math.max(maxYardStepRate, Math.abs(sailing.current.yardAngle - prevYard) / dt); minPressure = Math.min(minPressure, sailing.telemetry.pressure); maxPressure = Math.max(maxPressure, sailing.telemetry.pressure); statuses.add(sailing.telemetry.status); sweep.push({ heading, fill: sailing.current.fill, forward: sailing.telemetry.forwardForce, yard: sailing.current.yardAngle, status: sailing.telemetry.status, pressure: sailing.telemetry.pressure }); prevFill = sailing.current.fill; prevYard = sailing.current.yardAngle; prevForward = sailing.telemetry.forwardForce; }
  const head = sweep.reduce((best, p) => Math.abs(p.heading) < Math.abs(best.heading) ? p : best, sweep[0]);
  assert.ok(head.forward <= 0, `headwind forward sail force ${head.forward}`);
  assert.ok(maxFillJump <= .1, `fill discontinuity ${maxFillJump}`);
  assert.ok(maxYardStepRate <= .25 + 1e-9, `auto yard rate ${maxYardStepRate}`);
  // Heading sweep changes in 0.04 degrees; this bound is a continuity diagnostic, not a performance polar.
  assert.ok(maxForceJump < Math.max(100, Math.abs(head.forward) * .1), `sail-force discontinuity ${maxForceJump}`);
  const runHead = active => { const w = uniformWind(0, 8); const s = ship({ wind: w }); s.sailing.deploymentTarget = 1; s.sailing.trimMode = 'manual'; s.sailing.manualYardTarget = 0; s.crew.setOrder(active ? 4 : 1); const data = runShip(s, 20); return { data, forwardProgressM: -s.pos.z }; };
  const row = runHead(true), rest = runHead(false); assert.ok(row.data.oarImpulseNs > 0, `headwind oar impulse ${row.data.oarImpulseNs}`); assert.ok(row.forwardProgressM > rest.forwardProgressM, `rowing progress ${row.forwardProgressM} vs rest ${rest.forwardProgressM}`);
  report.measured.noGo = { sweepPoints: sweep.length, sweepDurationSeconds: 40, nearHeadwind: head, maxFillJump, maxYardStepRateRadS: maxYardStepRate, maxForwardForceStepN: maxForceJump, pressureRange: [minPressure, maxPressure], statuses: [...statuses], rowingHeadwind: row, restHeadwind: rest };
});

test('9 coupled gust: roll and blade immersion respond to wind while rowing invariants hold', () => {
  const calmWind = uniformWind();
  const gustWind = { vx: -8, vz: 0, sampleAt(x, y, z, time, out) { const gust = 1 + .2 * Math.sin(time * 1.7 + x / 90 + z / 140); return out.set(-8 * gust, 0, 0); } };
  const make = w => { const s = ship({ wind: w }); s.crew.setOrder(4); s.sailing.deploymentTarget = 1; return s; };
  const calm = make(calmWind), windy = make(gustWind); let calmWet = 0, windWet = 0, maxRollDifference = 0;
  for (let i = 0; i < 2400; i++) { calm.step(dt); windy.step(dt); const wetA = calm.rowing.current.wetArea, wetB = windy.rowing.current.wetArea; for (let j = 0; j < 170; j++) { assert.ok(calm.rowing.current.forceWorld.slice(j * 3, j * 3 + 3).every(Number.isFinite)); assert.ok(windy.rowing.current.forceWorld.slice(j * 3, j * 3 + 3).every(Number.isFinite)); calmWet += wetA[j]; windWet += wetB[j]; } maxRollDifference = Math.max(maxRollDifference, Math.abs(calm.heel - windy.heel)); }
  assert.ok(Math.abs(windy.heel - calm.heel) > .05 * DEG || maxRollDifference > .05 * DEG, 'gust did not change actual roll');
  assert.ok(Math.abs(windWet - calmWet) > 1e-3, 'gust did not change total blade immersion');
  assert.ok(Math.abs(windy.sailing.telemetry.forwardForce) + Math.abs(windy.sailing.telemetry.lateralForce) > 0, 'no sail load');
  report.measured.coupling = { calmWetAreaM2Steps: calmWet, gustWetAreaM2Steps: windWet, finalCalmHeelDegrees: calm.heel / DEG, finalGustHeelDegrees: windy.heel / DEG, maxRollDifferenceDegrees: maxRollDifference / DEG };
});

test('10 convergence: 60-second smooth-wind integration at 120 and 240 Hz', () => {
  const trimCadence = h => {
    const sail = new SailingSystem(), b = bodyState(), w = uniformWind(-6, -4), f = new THREE.Vector3(), m = new THREE.Vector3();
    sail.deploymentTarget = 1;
    let trimCalls = 0;
    const originalUpdate = sail.updateAutoTrim.bind(sail);
    sail.updateAutoTrim = (...args) => { trimCalls++; return originalUpdate(...args); };
    const boundaryCalls = [];
    for (let i = 0; i < Math.round(1 / h); i++) {
      sail.step(h, (i + 1) * h, b, w, f.set(0, 0, 0), m.set(0, 0, 0));
      const seconds = (i + 1) * h, boundary = Math.round(seconds * 4);
      if (boundary > 0 && Math.abs(seconds - boundary / 4) < 1e-10) { assert.equal(trimCalls, boundary, `${h}s update schedule at t=${seconds}`); boundaryCalls.push({ time: seconds, calls: trimCalls, yard: sail.current.yardAngle }); }
    }
    return boundaryCalls;
  };
  const trim120 = trimCadence(1 / 120), trim240 = trimCadence(1 / 240);
  assert.deepEqual(trim120.map(p => p.calls), [1, 2, 3, 4]); assert.deepEqual(trim240.map(p => p.calls), [1, 2, 3, 4]);
  const sim = h => { const w = new Wind(201), waves = flat(w), s = ship({ wind: w, waves }); s.sailing.deploymentTarget = 1; s.sailing.trimMode = 'auto'; s.crew.setOrder(3); let impulse = 0, accum = 0; const steps = Math.round(60 / h); for (let i = 0; i < steps; i++) { const t = (i + 1) * h; // smooth, deterministic open-water wind; no frame sampling
      w.baseSpeed = 8 + 1.2 * Math.sin(t * .07); w.baseFrom = .3 + .12 * Math.sin(t * .03); w.update(h); s.step(h); impulse += s.sailing.telemetry.forwardForce * h; accum += h; }
    return { speed: s.speed, pos: s.pos.clone(), impulse, yard: s.yardAngle, time: accum }; };
  const a = sim(1 / 120), b = sim(1 / 240), speedError = Math.abs(a.speed - b.speed), posError = a.pos.distanceTo(b.pos), impulseError = Math.abs(a.impulse - b.impulse) / Math.max(1, Math.abs(a.impulse), Math.abs(b.impulse)), yardError = Math.abs(a.yard - b.yard);
  report.measured.convergence = { trimCadence120: trim120, trimCadence240: trim240, speed120Mps: a.speed, speed240Mps: b.speed, speedErrorMps: speedError, positionErrorM: posError, impulse120Ns: a.impulse, impulse240Ns: b.impulse, impulseRelativeError: impulseError, yard120Rad: a.yard, yard240Rad: b.yard, yardErrorRad: yardError };
  assert.ok(speedError <= Math.max(.03, .02 * Math.max(Math.abs(a.speed), Math.abs(b.speed))), `speed convergence ${speedError}`);
  assert.ok(posError <= 1, `position convergence ${posError}`); assert.ok(impulseError <= .02, `sail impulse convergence ${impulseError}`); assert.ok(yardError <= .01, `yard convergence ${yardError}`);
});

if (!process.argv.includes('--quick')) test('11 long run: 300-second varied wind/wave stability and runtime', () => {
  const weather = new Wind(87), waves = new WaveField(weather, 11), s = ship({ wind: weather, waves }), random = rng(87);
  const kineticEnergy = ship => { const localW = ship.angVel.clone().applyQuaternion(ship.quat.clone().invert()); return .5 * ship.mass * ship.vel.lengthSq() + .5 * (ship.inertia.x * localW.x ** 2 + ship.inertia.y * localW.y ** 2 + ship.inertia.z * localW.z ** 2); };
  let maxSpeed = 0, maxAngularSpeed = 0, maxLoad = 0, maxHeel = 0, maxEnergy = 0, start = performance.now(), calmEnergyStart = 0, calmEnergyEnd = 0;
  for (let i = 0; i < 300 / dt; i++) {
    const t = i * dt;
    if (i % 1200 === 0 && (i < 12000 || i >= 18000)) { s.crew.setOrder([1, 2, 3, 4, 5, 0][Math.floor(random() * 6)]); s.helm = random() * .8 - .4; s.sailing.deploymentTarget = [0, .5, 1][Math.floor(random() * 3)]; }
    if (i === 12000) { weather.baseSpeed = 0; for (const wave of waves.waves) { wave.amp = 0; wave.target = 0; wave.q = 0; } s.crew.setOrder(1); s.sailing.deploymentTarget = 0; s.helm = 0; calmEnergyStart = kineticEnergy(s); }
    if (i === 18000) { calmEnergyEnd = kineticEnergy(s); weather.baseSpeed = 8; }
    weather.update(dt); if (i % 120 === 0 && (i < 12000 || i >= 18000)) waves.retarget(weather); waves.update(dt); s.step(dt);
    for (const v of [s.pos.x, s.pos.y, s.pos.z, s.vel.x, s.vel.y, s.vel.z, s.angVel.x, s.angVel.y, s.angVel.z, s.sailing.telemetry.load, s.sailing.current.fill, s.heel]) assert.ok(Number.isFinite(v), `nonfinite at ${t}`);
    near(s.quat.length(), 1, 1e-5); maxSpeed = Math.max(maxSpeed, s.vel.length()); maxAngularSpeed = Math.max(maxAngularSpeed, s.angVel.length()); maxLoad = Math.max(maxLoad, s.sailing.telemetry.load); maxHeel = Math.max(maxHeel, Math.abs(s.heel));
    maxEnergy = Math.max(maxEnergy, .5 * s.mass * s.vel.lengthSq());
  }
  const elapsedMs = performance.now() - start; assert.ok(calmEnergyEnd <= calmEnergyStart * 1.1 + 1e4, `calm energy growth ${calmEnergyStart} -> ${calmEnergyEnd}`);
  report.measured.longRun = { simulatedSeconds: 300, elapsedMs, maxSpeedMps: maxSpeed, maxAngularSpeedRadS: maxAngularSpeed, maxSailLoadN: maxLoad, maxHeelDegrees: maxHeel / DEG, maxKineticEnergyJ: maxEnergy, calmKineticEnergyStartJ: calmEnergyStart, calmKineticEnergyEndJ: calmEnergyEnd };
});

if (process.env.SAILING_REPORT) fs.writeFileSync(process.env.SAILING_REPORT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.measured, null, 2));
if (failures) process.exitCode = 1;
