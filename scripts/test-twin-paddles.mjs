import './register-ts.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const { makeThalassaDesign } = await import('../src/dev/thalassaDesign.ts');
const { ShipPhysics } = await import('../src/ship/physics.ts');
const { Wind } = await import('../src/world/wind.ts');
const { WaveField } = await import('../src/world/waves.ts');
const { Crew } = await import('../src/ship/crew.ts');
const { TwinPaddles, PADDLE } = await import('../src/dev/twinPaddles.ts');
const { ThalassaModel } = await import('../src/dev/thalassaModel.ts');
const terrain = { heightAt: () => -100, normalAt: (_x, _z, out) => out.set(0, 1, 0) };
function setup(windy = false) {
  const wind = new Wind(3); wind.baseSpeed = windy ? 8 : 0; wind.update(0);
  const waves = new WaveField(wind, 11);
  if (!windy) for (const w of waves.waves) w.amp = w.target = 0;
  const crew = new Crew(), ship = new ShipPhysics(waves, wind, terrain, crew, makeThalassaDesign());
  const drive = new TwinPaddles(crew); drive.mount(ship);
  ship.place(0, 0, windy ? wind.baseFrom + Math.PI * .6 : 0); drive.manual = true;
  return { ship, drive, waves, wind, crew };
}
// Authored moving nodes agree with physical axle and swept blade geometry.
const readGLB = async path => {
  const bytes = fs.readFileSync(path); const loader = new GLTFLoader();
  loader.register(() => ({ name: 'headless-textures', loadTexture: async () => new THREE.Texture() }));
  return (await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
};
const shell = await readGLB('ship-study/browser/assets/thalassa-shell.glb');
const asset = await readGLB('ship-study/browser/assets/thalassa-twin-paddles.glb');
const f = setup(), model = new ThalassaModel(shell, f.ship, asset);
model.group.updateMatrixWorld(true);
for (const [i, side] of ['port', 'starboard'].entries()) {
  const rotor = asset.getObjectByName(`Paddle_${side}_rotor`);
  assert.ok(rotor); const p = rotor.getWorldPosition(new THREE.Vector3());
  assert.ok(p.distanceTo(new THREE.Vector3((i ? 1 : -1) * PADDLE.x, PADDLE.y, PADDLE.z)) < 1e-5, `Axle mismatch ${p.toArray()}`);
  // Follow an actual radial board through a quarter turn and compare its centre to the water sampler.
  const board = asset.getObjectByName(`Paddle_${side}_blade_probe`);
  assert.ok(board);
  const before = board.getWorldPosition(new THREE.Vector3()).sub(p);
  model.paddleDrive.wheels[i].angle = Math.PI / 2;
  model.update(f.ship, f.crew, 0, 0, 1); model.group.updateMatrixWorld(true);
  const after = board.getWorldPosition(new THREE.Vector3()).sub(p);
  const expected = before.clone().applyAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  assert.ok(after.distanceTo(expected) < 1e-5, `Wrong visual shaft axis ${after.toArray()} vs ${expected.toArray()}`);
}
console.log('PASS Blender axle positions, moving board radius and physical shaft axis; oar model suppressed');
const rows = [];
for (const scenario of [
  { name: 'ahead-12kW', command: [1, 1], seconds: 360 },
  { name: 'ahead-6kW', command: [1, 1], seconds: 360, kw: 6 },
  { name: 'pivot-stbd-12kW', command: [1, -1], seconds: 180 },
  { name: 'pivot-port-12kW', command: [-1, 1], seconds: 180 },
  { name: 'underway-turn-12kW', command: [1, 1], seconds: 480, turnAt: 240 },
  { name: 'coast-12kW', command: [1, 1], seconds: 240, coastAt: 120 },
  { name: 'brake-12kW', command: [1, 1], seconds: 240, brakeAt: 120 },
  { name: 'open-sea-8mps', command: [1, 1], seconds: 120, windy: true },
]) {
  const { ship, drive, wind, waves, crew } = setup(scenario.windy);
  drive.commands = scenario.command; drive.setWatchPower(ship, scenario.kw ?? 12);
  let maxPower = 0, maxHeel = 0, minDissipation = 0, maxShaftClosure = 0, maxMomentumClosure = 0, maxFluidClosure = 0;
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.quat);
  let heading = Math.atan2(forward.x, -forward.z), turn = 0, inputJ = 0, firstThrust = 0, maxGround = 0;
  let time90 = null; const trace = [];
  for (let i = 0; i < scenario.seconds * 120; i++) {
    const dt = 1 / 120;
    if (scenario.turnAt && i === scenario.turnAt * 120) drive.commands = [1, -1];
    if (scenario.coastAt && i === scenario.coastAt * 120) drive.commands = [0, 0];
    if (scenario.brakeAt && i === scenario.brakeAt * 120) crew.holdWater = true;
    wind.update(dt);
    if (scenario.windy) { if (i % 120 === 0) waves.retarget(wind); waves.update(dt); }
    const before = ship.vel.clone(); ship.step(dt);
    assert.ok([...ship.pos, ...ship.vel, ...ship.angVel, ...drive.wheels.map(w => w.omega)].every(Number.isFinite));
    maxFluidClosure = Math.max(maxFluidClosure, Math.abs(drive.hullW - drive.reactionW + drive.wheels.reduce((s, w) => s + w.waterW, 0) + drive.dissipationW - drive.waveW));
    const power = drive.wheels.reduce((s, w) => s + w.sourceW, 0);
    maxPower = Math.max(maxPower, power); inputJ += power * dt;
    maxHeel = Math.max(maxHeel, Math.abs(ship.heel)); maxGround = Math.max(maxGround, ship.grounding);
    minDissipation = Math.min(minDissipation, drive.dissipationW);
    maxMomentumClosure = Math.max(maxMomentumClosure, before.sub(ship.vel).multiplyScalar(-ship.mass / dt).sub(ship.pendingForce).length());
    for (const w of drive.wheels) maxShaftClosure = Math.max(maxShaftClosure,
      Math.abs(w.shaftW + w.waterW - w.frictionW - w.storedW + w.numericalW));
    const dh = Math.atan2(Math.sin(ship.heading - heading), Math.cos(ship.heading - heading));
    turn += dh; heading = ship.heading;
    if (i === 120) firstThrust = drive.wheels.reduce((s, w) => s + w.thrust, 0);
    if (Math.abs(turn) >= Math.PI / 2 && time90 === null) time90 = i / 120;
    if (i % 120 === 0) trace.push({ seconds: i / 120, speed_kn: ship.speed * 1.943844,
      heading_deg: turn * 180 / Math.PI, source_W: power, thrust_N: drive.wheels.reduce((s, w) => s + w.thrust, 0),
      rpm: drive.wheels.map(w => w.rpm), position: ship.pos.toArray() });
  }
  assert.ok(maxPower <= drive.sourceKW * 1000 + 1e-6, `Power exceeded ${maxPower}`);
  assert.ok(maxShaftClosure < 1e-6, `Shaft energy mismatch ${maxShaftClosure}`);
  assert.ok(maxMomentumClosure < 1e-5, `Momentum mismatch ${maxMomentumClosure}`);
  assert.ok(maxFluidClosure < 1e-6, `Fluid power mismatch ${maxFluidClosure}`);
  assert.ok(minDissipation >= -1e-6); assert.equal(maxGround, 0);
  if (scenario.name.startsWith('ahead')) assert.ok(ship.speed > .2 && firstThrust > 0);
  if (scenario.name.startsWith('pivot-stbd')) assert.ok(turn > .2);
  if (scenario.name.startsWith('pivot-port')) assert.ok(turn < -.2);
  if (scenario.coastAt) assert.equal(drive.wheels.reduce((s, w) => s + w.sourceW, 0), 0);
  if (scenario.brakeAt) { assert.ok(drive.wheels.every(w => Math.abs(w.rpm) < .05)); assert.equal(drive.wheels.reduce((s, w) => s + w.sourceW, 0), 0); }
  const result = { scenario: scenario.name, seconds: scenario.seconds, speed_kn: ship.speed * 1.943844,
    heading_deg: turn * 180 / Math.PI, time90, maxSource_W: maxPower, input_kWh: inputJ / 3600000,
    firstThrust_N: firstThrust, maxHeel_deg: maxHeel * 180 / Math.PI,
    maxFluidClosure_W: maxFluidClosure, maxShaftClosure_W: maxShaftClosure, maxMomentumClosure_N: maxMomentumClosure,
    finalRPM: drive.wheels.map(w => w.rpm), finalThrust_N: drive.wheels.map(w => w.thrust), trace };
  rows.push(result); fs.writeFileSync('ship-study/propulsion/results/twin-paddles.json', JSON.stringify({ assumptions: PADDLE, results: rows }, null, 2)); console.log('PASS', JSON.stringify({ ...result, trace: undefined }));
}
fs.writeFileSync('ship-study/propulsion/results/twin-paddles.json', JSON.stringify({ assumptions: PADDLE, results: rows }, null, 2));
