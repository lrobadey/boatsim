import './register-ts.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const { makeThalassaDesign } = await import('../src/dev/thalassaDesign.ts');
const { ThalassaModel } = await import('../src/dev/thalassaModel.ts');
const { findOpenWaterStart, seabedAt } = await import('../src/world/openWaterStart.ts');
const { ShipPhysics } = await import('../src/ship/physics.ts');
const { Wind } = await import('../src/world/wind.ts');
const { WaveField } = await import('../src/world/waves.ts');
const { Crew } = await import('../src/ship/crew.ts');
const { Terrain } = await import('../src/world/terrain.ts');

// Exercise the actual authored-harbour world, not an invented deep-water terrain.
const holder = { onmessage: null, postMessage(message) { if (message.type === 'done') this.gen = message.result; } };
globalThis.self = holder;
await import('../src/world/worldgen.worker.ts');
const wind = new Wind(3); wind.baseSpeed = 8; wind.update(0);
holder.onmessage({ data: { authoredHarbour: true, seed: 1729, size: 2048, worldSize: 12000,
  windFrom: wind.baseFrom, vegetationDensity: 0.7 } });
const gen = holder.gen;
assert.ok(gen);
const start = findOpenWaterStart(gen, wind.baseFrom + Math.PI * 0.6);
const terrain = { heightAt: (x, z) => seabedAt(gen, x, z), normalAt: (_x, _z, out) => out.set(0, 1, 0) };
// Independently compare the headless query to the production Terrain method.
const terrainQuery = { N: gen.size, half: gen.worldSize / 2, cell: gen.worldSize / gen.size, heights: gen.heights };
for (let x = -5000; x <= 5000; x += 137) {
  assert.equal(terrain.heightAt(x, x / 3), Terrain.prototype.heightAt.call(terrainQuery, x, x / 3));
}
for (const h of gen.sites.harbours) assert.ok(Math.hypot(start.x - h.harbour.x, start.z - h.harbour.z) >= 1200);
let shallowest = -Infinity;
for (let dx = -350; dx <= 350; dx += 10) for (let dz = -350; dz <= 350; dz += 10) {
  if (dx * dx + dz * dz <= 350 ** 2) shallowest = Math.max(shallowest, terrain.heightAt(start.x + dx, start.z + dz));
}
assert.ok(shallowest < -20, `Spawn disk too shallow: ${shallowest}`);
for (let d = 0; d <= 1000; d += 10) for (let side = -75; side <= 75; side += 10) {
  assert.ok(terrain.heightAt(start.x + Math.sin(start.heading) * d + Math.cos(start.heading) * side,
    start.z - Math.cos(start.heading) * d + Math.sin(start.heading) * side) < -20);
}
console.log('PASS offshore start: default generated world, 350 m clear radius, 1 km departure corridor, 1.2 km from harbours', start);

const design = makeThalassaDesign(), crew = new Crew(), waves = new WaveField(wind, 11);
const ship = new ShipPhysics(waves, wind, terrain, crew, design);
ship.place(start.x, start.z, start.heading);
assert.equal(ship.additionalSails.length, 1);
assert.equal(ship.rowing.slots.length, 188);
assert.equal(design.cargo, undefined);
assert.ok(ship.columns.every(c => Math.abs(c.x) > 5));
const glb = await readFile(new URL('../ship-study/browser/assets/thalassa-shell.glb', import.meta.url));
const buffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
// Validate embedded PNG streams separately. Geometry parsing uses texture placeholders because
// Node has no browser image decoder; this check does not claim GPU upload/render validation.
const jsonLength = glb.readUInt32LE(12), json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString());
const binaryOffset = 20 + jsonLength + 8;
for (const image of json.images) {
  const view = json.bufferViews[image.bufferView];
  const png = glb.subarray(binaryOffset + view.byteOffset, binaryOffset + view.byteOffset + view.byteLength);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), type = png.subarray(offset + 4, offset + 8).toString();
    if (type === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  assert.ok(inflateSync(Buffer.concat(chunks)).length > 0);
}
const loader = new GLTFLoader();
loader.register(() => ({ name: 'headless-textures', loadTexture: async () => new THREE.Texture() }));
const gltf = await loader.parseAsync(buffer, '');
const model = new ThalassaModel(gltf.scene, ship);
crew.setOrder(4); ship.sailTarget = 1;
let maxGrounding = 0, maxHeel = 0;
for (let i = 0; i < 120 * 90; i++) {
  const dt = 1 / 120;
  wind.update(dt);
  if (i % 120 === 0) waves.retarget(wind);
  waves.update(dt);
  if (i >= 120 * 60) ship.helm = 1;
  ship.step(dt);
  assert.equal(ship.additionalSails[0].current.deployment, ship.sailing.current.deployment);
  assert.equal(ship.additionalSails[0].current.yardAngle, ship.sailing.current.yardAngle);
  maxGrounding = Math.max(maxGrounding, ship.grounding); maxHeel = Math.max(maxHeel, Math.abs(ship.heel));
  assert.ok([...ship.pos, ...ship.vel, ...ship.angVel].every(Number.isFinite));
  if (i % 120 === 0) {
    model.group.position.copy(ship.pos).sub(ship.cg.clone().applyQuaternion(ship.quat));
    model.group.quaternion.copy(ship.quat); model.group.updateMatrixWorld(true);
    model.update(ship, crew, 0, ship.time, 1);
    assert.equal(model.bladeWorld.length, 188);
    assert.ok(model.bladeWorld.every(v => [...v].every(Number.isFinite)));
  }
}
assert.equal(ship.mooring.onLines, false);
assert.equal(maxGrounding, 0);
assert.ok(ship.speed > 0.5, `Ship did not accelerate: ${ship.speed}`);
assert.ok(ship.additionalSails[0].current.deployment > 0.9);
assert.ok(Math.abs(ship.heading - start.heading) > 0.001, 'Helm produced no heading change');
ship.sailing.trimMode = 'manual'; ship.sailing.manualYardTarget = 0.3; ship.sailTarget = 0;
for (let i = 0; i < 120 * 7; i++) {
  ship.step(1 / 120);
  assert.equal(ship.additionalSails[0].current.deployment, ship.sailing.current.deployment);
  assert.equal(ship.additionalSails[0].current.yardAngle, ship.sailing.current.yardAngle);
}
assert.equal(ship.sailing.current.deployment, 0);
assert.equal(ship.additionalSails[0].deploymentTarget, 0);
assert.equal(ship.additionalSails[0].trimMode, 'manual');
assert.equal(ship.additionalSails[0].manualYardTarget, 0.3);
const speedKn = ship.speed * 1.943844, headingChangeDegrees = (ship.heading - start.heading) * 180 / Math.PI;
ship.place(start.x, start.z, start.heading);
assert.deepEqual(ship.additionalSails[0].previous, ship.additionalSails[0].current);
console.log('PASS main-game vessel: GLB geometry and embedded PNGs, 188 animated oars, 90 s real waves/wind, propulsion and helm, both rigs share controls and placement history',
  { speedKn, headingChangeDegrees, maxGrounding, maxHeelDegrees: maxHeel * 180 / Math.PI });
