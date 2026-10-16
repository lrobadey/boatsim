import assert from 'node:assert/strict';
import './register-ts.mjs';
import * as THREE from 'three';
const { AstroClock } = await import('../src/world/astro.ts');
const { evaluateLighting } = await import('../src/world/lightingState.ts');
const { environmentDirtyReason } = await import('../src/gfx/environmentPolicy.ts');
const { SkyEnvironmentCache } = await import('../src/gfx/skyEnvironment.ts');
const { SkySystem } = await import('../src/world/sky.ts');

function lightingAt(hours = 12.5, phase = 0.25) {
  const clock = new AstroClock();
  clock.hours = hours;
  clock.moonPhase = phase;
  clock.compute();
  return evaluateLighting(clock);
}

function input({ lighting = lightingAt(), originX = 0, originY = 0, originZ = 0, windX = 0, windZ = 0, coverage = 0.4,
  profileName = 'review', profileVersion = 1, animationTime = 0, density = 1, erosion = 0.5,
  atmosphere = Object.freeze([1, 1, 1]), sourceVersion = 1, radiance } = {}) {
  return Object.freeze({
    lighting, profileName, profileVersion, animationTime, originX, originY, originZ, windX, windZ, coverage,
    density, erosion, atmosphere, sourceVersion,
    radiance: radiance ?? Math.max(...lighting.directRGB),
  });
}

function cacheFixture() {
  let now = 0;
  const cache = new SkyEnvironmentCache({}, 8, () => now);
  // No WebGL context is needed for policy/lifecycle tests. Each mock PMREM target is separately
  // owned, as it would be by the renderer's PMREMGenerator.
  let pmremSerial = 0;
  cache.setPMREMGenerator({
    fromCubemap: () => {
      const target = new THREE.WebGLRenderTarget(1, 1);
      target.texture.name = `mock-pmrem-${++pmremSerial}`;
      return target;
    },
  });
  cache.setNow = value => { now = value; };
  return cache;
}

const baseline = input();
const cache = cacheFixture();
let captures = 0;
const capture = () => { captures++; };

// First publication is available synchronously; an identical frozen input is then reused.
cache.update(0, false, true, baseline, capture);
assert.equal(captures, 1, 'initial generation is captured');
cache.update(0.1, false, true, baseline, capture);
assert.equal(captures, 1, 'unchanged frozen lighting does not rebuild');
assert.equal(environmentDirtyReason(baseline, baseline, 6000), null, 'unchanged state does not age-rebuild after the nominal age limit');

// Lunar phase is an independent input: keep the astronomy vectors fixed to prove phase alone
// can invalidate the retained environment reference.
const phaseLighting = Object.freeze({ ...baseline.lighting, phase: baseline.lighting.phase + 0.02 });
const phaseOnly = input({ lighting: phaseLighting });
assert.equal(environmentDirtyReason(baseline, phaseOnly, 10), 'lunar-phase', 'small phase-only changes invalidate');
const phaseJump = input({ lighting:Object.freeze({ ...baseline.lighting, phase:baseline.lighting.phase + 0.25 }) });
assert.equal(environmentDirtyReason(baseline, phaseJump, 10), 'phase-discontinuity', 'large phase changes become discontinuities');
const phaseWrapA = input({ lighting:Object.freeze({ ...baseline.lighting, phase:0.99 }) });
const phaseWrapB = input({ lighting:Object.freeze({ ...baseline.lighting, phase:0.01 }) });
assert.equal(environmentDirtyReason(phaseWrapA, phaseWrapB, 10), 'lunar-phase', 'phase wrap is compared circularly');
const compoundDiscontinuity = input({
  lighting:Object.freeze({ ...baseline.lighting,
    absoluteHours:baseline.lighting.absoluteHours + 2,
    phase:baseline.lighting.phase + 0.2,
    sunDir:Object.freeze([0, 0, 1]), moonDir:Object.freeze([0, 0, -1]),
  }),
  originX:600,
});
assert.equal(environmentDirtyReason(baseline, compoundDiscontinuity, 0), 'clock-discontinuity',
  'clock discontinuity takes precedence over simultaneous phase, origin, and direction changes');
const compoundPhaseOrigin = input({
  lighting:Object.freeze({ ...baseline.lighting,
    phase:baseline.lighting.phase + 0.2,
    sunDir:Object.freeze([0, 0, 1]), moonDir:Object.freeze([0, 0, -1]),
  }),
  originX:600,
});
assert.equal(environmentDirtyReason(baseline, compoundPhaseOrigin, 0), 'phase-discontinuity',
  'phase discontinuity takes precedence over simultaneous origin and direction changes');
const phaseRefresh = cacheFixture();
phaseRefresh.update(0, false, true, baseline, () => {});
phaseRefresh.update(0, false, true, phaseJump, () => {});
assert.equal(phaseRefresh.telemetry.generation, 2, 'phase discontinuity creates the newest generation immediately');
assert.equal(phaseRefresh.blend, 1, 'phase discontinuity skips interpolation across unrelated times');
const lunarDirection = Object.freeze({ ...baseline.lighting, moonVisible:1, moonDir: Object.freeze([0, 0, 1]) });
assert.equal(environmentDirtyReason(baseline, input({ lighting:lunarDirection }), 10), 'moon-direction', 'lunar direction changes invalidate independently');
const invisibleLunarPrevious = input({ lighting:Object.freeze({ ...baseline.lighting, moonVisible:0 }) });
const invisibleLunarDirection = Object.freeze({ ...lunarDirection, moonVisible:0 });
assert.equal(environmentDirtyReason(invisibleLunarPrevious, input({ lighting:invisibleLunarDirection }), 10), null,
  'a moon absent from both captured domes does not accelerate daylight refreshes');

// Weather and capture origin are distinct invalidation causes.
assert.equal(environmentDirtyReason(baseline, input({ windX: 61 }), 10), 'wind', 'weather displacement invalidates');
assert.equal(environmentDirtyReason(baseline, input({ coverage: 0.43 }), 10), 'cloud-coverage', 'coverage changes invalidate');
assert.equal(environmentDirtyReason(baseline, input({ originX: 61 }), 10), 'origin', 'capture origin changes invalidate');

// The cache compares each new frame with the retained completed input. Three individually small
// movements accumulate against that fixed reference and eventually request a capture.
cache.update(0, false, true, input({ originX: 20 }), capture);
assert.equal(captures, 1, 'first sub-threshold movement reuses the retained generation');
cache.update(0, false, true, input({ originX: 40 }), capture);
assert.equal(captures, 1, 'second sub-threshold movement still uses the retained generation');
cache.update(0, false, true, input({ originX: 61 }), capture);
assert.equal(captures, 2, 'accumulated movement eventually invalidates the retained generation');
assert.ok(Number.isFinite(cache.telemetry.blend) && cache.telemetry.blend >= 0 && cache.telemetry.blend <= 1,
  'published blend weight remains finite and bounded');
cache.update(0.1, false, true, input({ originX: 61 }), capture);
assert.ok(Number.isFinite(cache.telemetry.blend) && cache.telemetry.blend >= 0 && cache.telemetry.blend <= 1,
  'blend remains finite while transitioning');

function blendRun(partitions) {
  const candidate = cacheFixture();
  candidate.update(0, false, true, baseline, () => {});
  const changed = input({ originX:61 });
  candidate.update(0, false, true, changed, () => {});
  const weights = [];
  for (const ms of partitions) {
    candidate.setNow(ms);
    candidate.update(0, false, true, changed, () => {});
    weights.push(candidate.blend);
  }
  return { candidate, weights, activeIndex:candidate.bundles.indexOf(candidate.current) };
}
const coarseBlend = blendRun([100, 200]);
const fineBlend = blendRun([50, 100, 150, 200]);
assert.equal(coarseBlend.candidate.blend, 1, 'blend reaches exact terminal alpha at 200 ms');
assert.equal(fineBlend.candidate.blend, 1, 'partitioned blend reaches exact terminal alpha at 200 ms');
assert.deepEqual(coarseBlend.weights, [0.5, 1]);
assert.deepEqual(fineBlend.weights, [0.25, 0.5, 0.75, 1]);
assert.equal(coarseBlend.activeIndex, fineBlend.activeIndex, 'blend endpoint slot is partition invariant');

const endpoints = cacheFixture();
const writes = [];
endpoints.update(0, false, true, baseline, bundle => writes.push(bundle));
const activeBeforeBlend = endpoints.current;
writes.length = 0;
const nextState = input({ originX:61 });
endpoints.update(0, false, true, nextState, bundle => writes.push(bundle));
const inactiveTarget = endpoints.nextBundle;
assert.notEqual(activeBeforeBlend, inactiveTarget);
const slotWritten = writes[0];
writes.length = 0;
endpoints.setNow(100);
endpoints.update(0, false, true, nextState, bundle => writes.push(bundle));
assert.equal(writes.length, 0, 'neither endpoint is rewritten during the blend');
assert.equal(endpoints.current, activeBeforeBlend, 'old endpoint remains active until the blend completes');
assert.equal(endpoints.nextBundle, inactiveTarget, 'new endpoint remains stable during the blend');
assert.equal(slotWritten, inactiveTarget);

const forcedMidBlend = cacheFixture();
forcedMidBlend.update(0, false, true, baseline, () => {});
forcedMidBlend.update(0, false, true, nextState, () => {});
const sampledBeforeForce = forcedMidBlend.nextBundle;
let overwrittenCurrent = null, forcedTarget = null;
forcedMidBlend.setNow(100);
forcedMidBlend.update(0, true, true, input({ originX:100 }), bundle => { forcedTarget = bundle; }, current => { overwrittenCurrent = current; });
assert.equal(overwrittenCurrent, sampledBeforeForce, 'forced mid-blend first adopts the visible destination');
assert.notEqual(forcedTarget, sampledBeforeForce, 'forced refresh writes the other slot after rebinding');
assert.equal(forcedMidBlend.current, forcedTarget, 'forced target is published coherently');
assert.equal(forcedMidBlend.blend, 1, 'forced discontinuity does not blend unrelated times');
assert.equal(forcedMidBlend.telemetry.forceCurrent, false, 'explicit forced capture does not misreport force-current mode');

const forcedCurrentMode = cacheFixture();
forcedCurrentMode.forceCurrentMode = true;
forcedCurrentMode.update(0, false, true, baseline, () => {});
assert.equal(forcedCurrentMode.telemetry.forceCurrent, true, 'telemetry reports enabled force-current mode');
forcedCurrentMode.forceCurrentMode = false;
forcedCurrentMode.update(0, false, true, baseline, () => {});
assert.equal(forcedCurrentMode.telemetry.forceCurrent, false, 'telemetry tracks mode changes even without another capture');

// Suppressed presentation records the newest state but performs no capture. Resuming presentation
// reconciles once to that state instead of replaying skipped intermediate snapshots.
const suppressed = cacheFixture();
let suppressedCaptures = 0;
const countCapture = () => { suppressedCaptures++; };
suppressed.update(0, false, true, baseline, countCapture);
suppressed.update(0.5, true, false, baseline, countCapture);
assert.equal(suppressedCaptures, 1, 'suppressed presentation performs no environment capture');
suppressed.update(0, false, true, baseline, countCapture);
assert.equal(suppressedCaptures, 2, 'presentation resumes with one newest-state reconciliation');
assert.equal(suppressed.blend, 1, 'suppressed forced jump resumes with coherent presentation');

// If a long frame gap carries the older sampled endpoint to its regime age limit, the cache
// commits the destination and exposes a one-shot deadline fallback record.
const deadline = cacheFixture();
deadline.update(0, false, true, baseline, () => {});
deadline.update(0, false, true, nextState, () => {});
deadline.setNow(4000);
deadline.update(0, false, true, nextState, () => {});
assert.equal(deadline.telemetry.deadlineMissed, true, 'old endpoint age limit activates deadline fallback');
assert.equal(deadline.telemetry.deadlineMisses, 1, 'deadline fallback count is cumulative');
assert.equal(deadline.isBlending, false, 'deadline fallback releases the stale endpoint');

// Staged mode holds one capture snapshot, renders one full cube face per presented update, then
// clears the in-progress marker only after all six faces have completed.
const staged = cacheFixture();
staged.stagedCapturesEnabled = true;
const stagedFaces = [];
staged.update(0, false, true, baseline, (_bundle, face) => stagedFaces.push(face ?? 'full'));
staged.update(0, false, true, input({ originX: 61 }), (_bundle, face) => stagedFaces.push(face ?? 'full'));
assert.equal(staged.telemetry.stagedFace, 1, 'first presented staged update advances face counter');
for (let i = 0; i < 5; i++) staged.update(1 / 60, false, true, input({ originX: 61 }), (_bundle, face) => stagedFaces.push(face ?? 'full'));
assert.equal(staged.telemetry.stagedFace, -1, 'staged counter returns idle after six faces');
assert.equal(staged.telemetry.generation, 2, 'staged generation publishes after all faces and filtering');
assert.deepEqual(stagedFaces.slice(1), [-1, 0, 1, 2, 3, 4, 5], 'clear snapshot is frozen once before face sequence');

// A clock epoch jump during staged capture cancels the stale face sequence and synchronously
// reconciles the newest state before the next presented frame.
const stagedJump = cacheFixture();
stagedJump.stagedCapturesEnabled = true;
const jumpCaptureCalls = [];
stagedJump.update(0, false, true, baseline, (_bundle, face) => jumpCaptureCalls.push(face ?? 'full'));
stagedJump.update(0, false, true, input({ originX:61 }), (_bundle, face) => jumpCaptureCalls.push(face ?? 'full'));
assert.equal(stagedJump.telemetry.stagedFace, 1, 'staged capture is active before the jump');
const epochJump = input({
  lighting:Object.freeze({ ...baseline.lighting,
    absoluteHours:baseline.lighting.absoluteHours + 2,
    phase:baseline.lighting.phase + 0.2,
  }),
  originX:700,
});
stagedJump.update(0, false, true, epochJump, (_bundle, face) => jumpCaptureCalls.push(face ?? 'full'));
assert.equal(stagedJump.telemetry.stagedFace, -1, 'epoch jump cancels staged face work');
assert.equal(stagedJump.telemetry.generation, 2, 'epoch jump captures and publishes the newest state immediately');
assert.equal(jumpCaptureCalls.at(-1), 'full', 'epoch jump uses one complete reconciled capture');
assert.equal(stagedJump.isBlending, false, 'epoch jump does not blend across unrelated snapshots');

// Exercise the production attachment/capture paths without a GPU: screen clouds belong to
// CloudPass, but full and staged environment captures must still contain the cloud layer.
const { Sky } = await import('three/addons/objects/Sky.js');
const cloudSky = Object.create(SkySystem.prototype);
cloudSky.sky = new Sky();
cloudSky.envSky = new Sky();
cloudSky.clearSky = new Sky();
cloudSky.seaDisc = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
cloudSky.environmentSourceVersion = 1;
cloudSky.night = 0;
const clearTexture = new THREE.CubeTexture();
const captureCalls = [];
cloudSky.environment = {
  previous: { clear: { texture: clearTexture } }, nextBundle: { clear: { texture: clearTexture } }, blend: 0,
  captureClear: () => captureCalls.push('clear'),
  captureRaw: () => {
    assert.equal(cloudSky.envSky.material.uniforms.uCloudOn.value, 1);
    captureCalls.push('raw');
  },
  captureRawFace: () => {
    assert.equal(cloudSky.envSky.material.uniforms.uCloudOn.value, 1);
    captureCalls.push('face');
  },
};
const cloudInputs = { uniforms: Object.fromEntries([
  'uCloudHazeSky', 'uCloudHazeSkyNext', 'uCloudHazeBlend', 'uCloudHazeReady',
].map(name => [name, { value: null }])) };
cloudSky.attachClouds(cloudInputs);
assert.equal(cloudSky.sky.material.uniforms.uCloudOn.value, 0,
  'the visible sky must leave volumetric clouds to CloudPass');
assert.ok(cloudSky.envSky.material.fragmentShader.includes('vcMarch( direction, 28.0, 0.5 )'),
  'environment shader retains its inline cloud march');
const cloudBundle = { clear: { texture: new THREE.CubeTexture() } };
cloudSky.captureEnvironment(cloudBundle);
assert.deepEqual(captureCalls, ['clear', 'raw'], 'complete environment capture includes clouds');
assert.equal(cloudSky.sky.material.uniforms.uCloudOn.value, 0,
  'capturing cloudy reflections must not re-enable clouds on screen');
assert.notEqual(cloudSky.sky.material.uniforms.uCloudOn, cloudSky.envSky.material.uniforms.uCloudOn,
  'screen and capture cloud switches must be independent uniforms');
captureCalls.length = 0;
cloudSky.captureEnvironment(cloudBundle, -1);
cloudSky.captureEnvironment(cloudBundle, 0);
assert.deepEqual(captureCalls, ['clear', 'face'], 'staged capture also retains clouds');
assert.equal(cloudSky.sky.material.uniforms.uCloudOn.value, 0);
for (const sky of [cloudSky.sky, cloudSky.envSky, cloudSky.clearSky]) {
  sky.geometry.dispose(); sky.material.dispose();
}
cloudSky.seaDisc.geometry.dispose(); cloudSky.seaDisc.material.dispose();
clearTexture.dispose(); cloudBundle.clear.texture.dispose();

// The production snapshot copier must detach mutable vectors/arrays so later live updates cannot
// change the source selected for staged faces; immutable noise/image textures remain shareable.
const sourceUniforms = {
  direction:{value:new THREE.Vector3(1, 2, 3)},
  color:{value:new THREE.Color(0x336699)},
  weights:{value:[0.2, 0.4, 0.8]},
  renderTargetTexture:{value:new THREE.WebGLRenderTarget(2, 2).texture},
  imageTexture:{value:new THREE.Texture()},
};
const captureUniforms = {};
const previousWarn = console.warn;
const cloneWarnings = [];
console.warn = (...args) => cloneWarnings.push(args.join(' '));
try { SkySystem.prototype.copyUniforms.call({}, sourceUniforms, captureUniforms); }
finally { console.warn = previousWarn; }
sourceUniforms.direction.value.set(9, 8, 7);
sourceUniforms.color.value.setRGB(1, 0, 0);
sourceUniforms.weights.value[0] = 1;
assert.deepEqual(captureUniforms.direction.value.toArray(), [1, 2, 3], 'staged direction snapshot is detached from live state');
assert.notEqual(captureUniforms.color.value.r, 1, 'staged color snapshot is detached from live state');
assert.deepEqual(captureUniforms.weights.value, [0.2, 0.4, 0.8], 'staged scalar array snapshot is copied');
assert.equal(captureUniforms.renderTargetTexture.value, sourceUniforms.renderTargetTexture.value, 'render-target texture handles are shared by reference');
assert.equal(captureUniforms.imageTexture.value, sourceUniforms.imageTexture.value, 'static texture handles are shared by reference');
assert.deepEqual(cloneWarnings, [], 'uniform snapshot copy avoids render-target clone warnings');

// Both complete bundles own separate raw, clear, and filtered resources; no bundle aliases the
// texture currently being written by the other generation.
const [a, b] = cache.bundles;
assert.notEqual(a.raw, b.raw);
assert.notEqual(a.clear, b.clear);
assert.notEqual(a.raw, a.clear);
assert.ok(a.pmrem && b.pmrem && a.pmrem !== b.pmrem, 'each generation owns its own filtered target');
assert.notEqual(a.raw.texture, b.raw.texture);
cache.dispose();
suppressed.dispose();
staged.dispose();
stagedJump.dispose();
deadline.dispose();
phaseRefresh.dispose();
forcedCurrentMode.dispose();

console.log('PASS environment policy invalidation, retained reference, suppression, blend, and resource ownership');
