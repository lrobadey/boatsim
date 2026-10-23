// Matched headless wind-only comparison. No browser, fake thrust or changes to the study fixture.
import './register-ts.mjs';
import assert from 'node:assert/strict';
const { makeThalassaDesign } = await import('../src/dev/thalassaDesign.ts');
const { MAIN_RIG, AFT_RIG } = await import('../ship-study/browser/design.ts');
const { ShipPhysics } = await import('../src/ship/physics.ts');
const { Wind } = await import('../src/world/wind.ts');
const { WaveField } = await import('../src/world/waves.ts');
const { Crew } = await import('../src/ship/crew.ts');
const terrain = { heightAt: () => -100, normalAt: (_x, _z, out) => out.set(0, 1, 0) };
const rows = [];
for (const original of [true, false]) {
  const design = makeThalassaDesign();
  if (original) { design.rig = MAIN_RIG; design.additionalRigs = [AFT_RIG]; }
  const wind = new Wind(3); wind.baseSpeed = 8; wind.update(0);
  const waves = new WaveField(wind, 11), crew = new Crew();
  const ship = new ShipPhysics(waves, wind, terrain, crew, design);
  const heading = wind.baseFrom + Math.PI * 0.6;
  ship.place(0, 0, heading); crew.setOrder(1); ship.sailTarget = 1;
  let impulse = 0, maxHeel = 0, maxGrounding = 0;
  const speeds = {};
  for (let i = 0; i < 180 * 120; i++) {
    const dt = 1 / 120;
    wind.update(dt); if (i % 120 === 0) waves.retarget(wind); waves.update(dt);
    ship.step(dt);
    impulse += ship.sailForce * dt;
    maxHeel = Math.max(maxHeel, Math.abs(ship.heel)); maxGrounding = Math.max(maxGrounding, ship.grounding);
    assert.ok([...ship.pos, ...ship.vel, ...ship.angVel].every(Number.isFinite));
    assert.equal(ship.additionalSails[0].current.deployment, ship.sailing.current.deployment);
    assert.equal(ship.additionalSails[0].current.yardAngle, ship.sailing.current.yardAngle);
    if ((i + 1) % (60 * 120) === 0) speeds[(i + 1) / 120] = ship.speed * 1.943844;
  }
  assert.equal(maxGrounding, 0); assert.equal(ship.mooring.onLines, false);
  const row = { sails: original ? 'original' : 'enlarged',
    areaM2: design.rig.area + design.additionalRigs[0].area,
    speedKnAtSeconds: speeds, meanSailForwardKN: impulse / 180 / 1000,
    maxHeelDegrees: maxHeel * 180 / Math.PI };
  rows.push(row); console.log(JSON.stringify(row));
}
assert.ok(rows[1].speedKnAtSeconds[180] > rows[0].speedKnAtSeconds[180] * 1.25, 'Larger rig should materially improve wind-only acceleration');
assert.ok(rows[1].meanSailForwardKN > rows[0].meanSailForwardKN * 1.5, 'Larger rig should collect substantially more wind load');
console.log('PASS matched 180 s wind-only acceleration: 8 m/s prevailing wind, normal waves, oars resting, no heading hold.');
