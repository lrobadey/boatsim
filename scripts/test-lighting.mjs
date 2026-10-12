// Exercise the production lighting update without creating a WebGL context.
import './register-ts.mjs';
import assert from 'node:assert/strict';
import * as THREE from 'three';
const { AstroClock } = await import('../src/world/astro.ts');
const { SkySystem } = await import('../src/world/sky.ts');
const { shared } = await import('../src/gfx/shared.ts');

const uniforms = new Proxy({}, { get: (o, k) => o[k] ??= { value: new THREE.Vector3() } });
const clock = new AstroClock();
const sky = Object.assign(Object.create(SkySystem.prototype), {
  clock, group: new THREE.Group(), sky: { material: { uniforms } },
  light: new THREE.DirectionalLight(), hemi: new THREE.HemisphereLight(),
  stars: new THREE.Object3D(), starMat: { uniforms: { uNight: {}, uPixel: {} } },
  renderer: { getPixelRatio: () => 1 }, exposure: 1,
});
const camera = new THREE.PerspectiveCamera();
function sample(hour, phase = 0.43) {
  clock.hours = hour; clock.moonPhase = phase; clock.compute();
  sky.updateLighting(0, camera, true);
  return { color: shared.uSunColor.value.clone(), exposure: sky.exposure, night: sky.night };
}
// Regression anchor: successful morning/noon daylight exposure remains identical.
for (const hour of [7.4, 9, 12.5, 17]) {
  const s = sample(hour);
  assert.equal(s.night, 0);
  const E = Math.max(...s.color.toArray()) * Math.max(clock.sunDir.y, 0) + 0.52;
  const legacyExposure = 0.62 * Math.pow(1.35 / (E + 0.5), 0.42);
  assert.ok(Math.abs(s.exposure - legacyExposure) < 1e-12);
}
console.log('PASS daylight exposure anchors');

// The source swap must not introduce a finite jump in visible direct illumination.
const colors = [];
for (const y of [-0.04 + 1e-7, -0.04, -0.04 - 1e-7]) {
  clock.sunDir.set(Math.sqrt(1 - y*y), y, 0);
  clock.moonDir.set(0, 0.8, 0.6);
  sky.updateLighting(0, camera, true); colors.push(shared.uSunColor.value.clone());
}
assert.ok(Math.hypot(...colors[0].toArray().map((v, i) => v - colors[2].toArray()[i])) < 1e-8);
console.log('PASS continuous direct radiance at solar/lunar source swap');

for (const phase of [0, 0.25, 0.43, 0.5, 0.75]) {
  const s = sample(23, phase);
  assert.ok(Number.isFinite(s.exposure) && s.exposure < 2.9);
  assert.ok(Math.max(...s.color.toArray()) <= 0.08 + 1e-12);
  assert.ok(uniforms.uMoonBright.value <= 0.95 + 1e-12, 'lunar disc/environment is independently bounded');
  if (phase === 0) assert.equal(uniforms.uNightSky.value.length(), 0);
  if (phase === 0 || clock.moonDir.y < -0.02) assert.equal(Math.hypot(...s.color.toArray()), 0);
}
console.log('PASS night adaptation bound and lunar phase/horizon gating');

// Sample dusk and dawn in one-minute steps; environment fill and adaptation must
// not acquire another hidden discontinuity while direct light passes the handoff.
for (const [start, end] of [[18.5, 21], [3.5, 6]]) {
  let previous;
  for (let h = start; h < end; h += 1/60) {
    const s = sample(h);
    const fill = uniforms.uNightSky.value.clone();
    if (previous) {
      assert.ok(Math.abs(s.exposure - previous.exposure) < 0.12);
      assert.ok(fill.distanceTo(previous.fill) < 0.001);
    }
    previous = { exposure:s.exposure, fill };
  }
}
console.log('PASS dawn/dusk environment and adaptation continuity');

const target = sample(23).exposure;
sky.exposure = 0.4;
let previous = sky.exposure;
for (let i = 0; i < 300; i++) {
  sky.updateLighting(1/60, camera);
  assert.ok(sky.exposure >= previous && sky.exposure <= target + 1e-12);
  previous = sky.exposure;
}
assert.ok(Math.abs(sky.exposure - target) < 0.002);
console.log('PASS monotonic exposure adaptation without overshoot');
