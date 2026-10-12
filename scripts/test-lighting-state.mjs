import assert from 'node:assert/strict';
import './register-ts.mjs';
import * as THREE from 'three';
const { clamp, smoothstep } = await import('../src/core/util.ts');
const { AstroClock } = await import('../src/world/astro.ts');
const { evaluateLighting, LIGHTING_PROFILE } = await import('../src/world/lightingState.ts');

function clockAt(hours, phase) {
  const clock = new AstroClock();
  clock.hours = hours;
  clock.moonPhase = phase;
  clock.compute();
  return clock;
}

// Independent copy of the frozen sky.ts and game.ts formulas for source-level regression.
function reference(clock) {
  const sun = clock.sunDir.clone();
  const moon = clock.moonDir.clone();
  const night = smoothstep(0.05, -0.16, sun.y);
  const altDeg = Math.asin(clamp(sun.y, -1, 1)) * 180 / Math.PI;
  const m = 1 / (Math.max(0, Math.sin(Math.max(altDeg, -1) * Math.PI / 180))
    + 0.50572 * Math.pow(Math.max(altDeg, -3.5) + 6.07995, -1.6364));
  const tr = [Math.exp(-0.105 * m), Math.exp(-0.17 * m), Math.exp(-0.31 * m)];
  const sunIntensity = 4.2 * smoothstep(-0.035, 0.03, sun.y);
  const phaseLight = 0.5 - 0.5 * Math.cos(clock.moonPhase * Math.PI * 2);
  const lunarHandoff = smoothstep(-0.04, -0.14, sun.y);
  const moonVis = smoothstep(-0.02, 0.1, moon.y) * night * lunarHandoff;
  const moonI = 0.08 * phaseLight * moonVis;
  const skyMoon = phaseLight * smoothstep(-0.05, 0.15, moon.y) * smoothstep(0, -0.1, sun.y);
  const nightSky = [0.0022, 0.0048, 0.0115].map(v => v * skyMoon * (1 - 0.35 * night));
  const twilightWeight = smoothstep(0, -0.035, sun.y) * (1 - smoothstep(-0.035, -0.20, sun.y));
  const twilightSky = [0.012, 0.020, 0.042].map(v => v * twilightWeight);
  const activeSource = sun.y > -0.04 ? 'sun' : 'moon';
  const directDir = activeSource === 'sun' ? sun : moon;
  const directRGB = activeSource === 'sun' ? tr.map(v => v * sunIntensity) : [0.72 * moonI, 0.8 * moonI, moonI];
  const twilight = 4 * night * (1 - night);
  const hemiIntensity = 0.05 * night + 0.12 * twilight;
  const starVisibility = smoothstep(-0.05, -0.2, sun.y);

  const moonFrame = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().lookAt(new THREE.Vector3(), moon, new THREE.Vector3(0, 1, 0)),
  );
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(moonFrame);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(moonFrame);
  const moonRight = right.toArray();
  const moonUp = up.toArray();
  const moonSun = [sun.dot(right), sun.dot(up), -sun.dot(moon)];
  const moonBright = (0.4 + 0.55 * night) * (0.3 + 0.7 * smoothstep(-0.05, 0.05, moon.y));
  const moonVisible = moon.y > -0.1 ? 1 : 0;

  const day = clamp((sun.y + 0.08) / 0.33, 0, 1);
  const daylight = day * day * (3 - 2 * day);
  const moonlight = phaseLight * smoothstep(-0.02, 0.1, moon.y) * night;
  const solarFill = 0.012 + (1 - 0.012) * daylight;
  const cloudAmbTop = [
    0.36 * solarFill + 0.018 * moonlight + 0.7 * twilightSky[0],
    0.46 * solarFill + 0.027 * moonlight + 0.7 * twilightSky[1],
    0.62 * solarFill + 0.045 * moonlight + 0.7 * twilightSky[2],
  ];
  const cloudAmbBottom = [
    0.09 * solarFill + 0.004 * moonlight + 0.1 * twilightSky[0],
    0.1 * solarFill + 0.006 * moonlight + 0.1 * twilightSky[1],
    0.115 * solarFill + 0.01 * moonlight + 0.1 * twilightSky[2],
  ];
  const E = Math.max(...directRGB) * Math.max(directDir.y, 0) + 0.5 * (1 - night) + 0.02;
  const targetExposure = 0.62 * Math.pow(1.35 / (E + 0.5), 0.42) * (1 + 2.1 * night);
  return {
    profileName: 'aegean-skylight', profileVersion: 2,
    sunDir: sun.toArray(), moonDir: moon.toArray(), directDir: directDir.toArray(), directRGB,
    nightSkyRGB: nightSky, twilightSkyRGB: twilightSky,
    cloudAmbTopRGB: cloudAmbTop, cloudAmbBottomRGB: cloudAmbBottom,
    night, sunIntensity, hemiIntensity, starVisibility, moonBright, moonVisible,
    moonRight, moonUp, moonSun, targetExposure, phase: clock.moonPhase,
    absoluteHours: clock.dayCount * 24 + clock.hours, activeSource,
  };
}

function assertNear(actual, expected, label, eps = 1e-12) {
  if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, `${label} length`);
    expected.forEach((value, i) => assert.ok(Math.abs(actual[i] - value) <= eps,
      `${label}[${i}]: got ${actual[i]}, expected ${value}`));
  } else if (typeof expected === 'number') {
    assert.ok(Math.abs(actual - expected) <= eps, `${label}: got ${actual}, expected ${expected}`);
  } else assert.equal(actual, expected, label);
}

const fixtures = [
  [4.8, 0], [5.8, 0.25], [6.4, 0.5], [7.4, 0.75], [9, 0], [12.5, 0.5],
  [17, 0.25], [18.8, 0.5], [20, 0.75], [23.2, 0.5],
];
for (const [hours, phase] of fixtures) {
  const clock = clockAt(hours, phase);
  const actual = evaluateLighting(clock);
  const expected = reference(clock);
  for (const key of Object.keys(expected)) assertNear(actual[key], expected[key], `${hours}h/${phase} ${key}`);
  for (const key of ['sunDir', 'moonDir', 'directDir', 'directRGB', 'nightSkyRGB', 'twilightSkyRGB', 'cloudAmbTopRGB',
    'cloudAmbBottomRGB', 'moonRight', 'moonUp', 'moonSun']) {
    assert.ok(Object.isFrozen(actual[key]), `${key} tuple is frozen`);
    assert.ok(actual[key].every(Number.isFinite), `${key} is finite`);
  }
  for (const key of ['night', 'sunIntensity', 'hemiIntensity', 'starVisibility', 'moonBright', 'moonVisible',
    'targetExposure', 'phase', 'absoluteHours']) assert.ok(Number.isFinite(actual[key]), `${key} is finite`);
}

assert.deepEqual(LIGHTING_PROFILE, { name: 'aegean-skylight', version: 2, skySpecularShadowCoupling: 0 });
assert.ok(Object.isFrozen(LIGHTING_PROFILE), 'lighting profile identity is immutable');
const profileState = evaluateLighting(clockAt(9, 0.43));
assert.equal(profileState.profileName, LIGHTING_PROFILE.name, 'state carries the named profile');
assert.equal(profileState.profileVersion, LIGHTING_PROFILE.version, 'state carries the profile version');

// The twilight bridge has zero day/full-night endpoints, a positive transition, and a
// continuous envelope. Cloud ambient receives its authored top/bottom share in this interval.
const twilightAtSunY = (sunY) => {
  const clock = clockAt(19.5, 0.43);
  clock.sunDir.y = sunY;
  return evaluateLighting(clock);
};
assert.deepEqual(twilightAtSunY(0).twilightSkyRGB, [0, 0, 0], 'twilight bridge is exactly zero in daylight');
assert.deepEqual(twilightAtSunY(-0.20).twilightSkyRGB, [0, 0, 0], 'twilight bridge is exactly zero at full night');
assertNear(twilightAtSunY(-0.035).twilightSkyRGB, [0.012, 0.020, 0.042], 'twilight bridge peak');
let previousTwilight;
for (let i = 0; i <= 1000; i++) {
  const y = -0.20 * i / 1000;
  const state = twilightAtSunY(y);
  assert.ok(state.twilightSkyRGB.every(Number.isFinite), 'twilight RGB stays finite');
  assert.ok(state.twilightSkyRGB.some((component) => component > 0) || y === 0 || y === -0.20,
    'twilight bridge is positive inside its transition');
  if (previousTwilight) {
    assert.ok(Math.hypot(...state.twilightSkyRGB.map((v, k) => v - previousTwilight[k])) < 0.0005,
      'twilight bridge changes continuously across samples');
  }
  previousTwilight = state.twilightSkyRGB;
}

// Frozen morning/daylight anchors protect the existing directional light and exposure outputs.
const daylightAnchors = [
  // [hour, direct RGB, exposure]
  [7.4, [3.4104474713018704, 2.9979610233954537, 2.271130457119498], 0.46091825003033593],
  [9, [3.6565014973570293, 3.3559020906878896, 2.789745390261978], 0.4019791763364374],
  [12.5, [3.7668246428975634, 3.5213615309551356, 3.045641387756583], 0.3687399121653656],
  [17, [3.2938100091559988, 2.833724384064642, 2.049383710943134], 0.48377237823070773],
];
for (const [hours, directRGB, exposure] of daylightAnchors) {
  const state = evaluateLighting(clockAt(hours, 0.43));
  assertNear(state.directRGB, directRGB, `${hours}h daylight direct RGB`, 1e-12);
  assertNear(state.targetExposure, exposure, `${hours}h daylight exposure`, 1e-12);
}

const sourceClock = clockAt(2.3, 0.3);
const snapshot = evaluateLighting(sourceClock);
const snapshotJSON = JSON.stringify(snapshot);
sourceClock.hours = 14;
sourceClock.dayCount = 8;
sourceClock.moonPhase = 0.9;
sourceClock.sunDir.set(1, 0, 0);
sourceClock.moonDir.set(0, 0, 1);
assert.equal(JSON.stringify(snapshot), snapshotJSON, 'snapshot is isolated from later clock mutation');
assert.ok(Object.isFrozen(snapshot), 'state object is frozen');
assert.throws(() => { snapshot.sunDir[0] = 123; }, TypeError, 'owned tuples reject mutation');

console.log(`lighting-state source regressions passed (${fixtures.length} formula fixtures, 4 daylight anchors)`);
