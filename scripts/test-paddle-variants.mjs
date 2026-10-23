import './register-ts.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
const { PADDLE_VARIANTS } = await import('../src/dev/paddleVariants.ts');
const { buildPaddleVariant, disposePaddleVariant } = await import('../src/dev/paddleVariantModel.ts');
const { TwinPaddles } = await import('../src/dev/twinPaddles.ts');
const { makeThalassaDesign } = await import('../src/dev/thalassaDesign.ts');
const { ShipPhysics } = await import('../src/ship/physics.ts');
const { Crew } = await import('../src/ship/crew.ts');
const { Wind } = await import('../src/world/wind.ts');
const { WaveField } = await import('../src/world/waves.ts');
const sourceKW = Number(process.argv.find(a => a.startsWith('--kw='))?.slice(5) ?? 12);
assert.ok([6,12,24].includes(sourceKW));
const selectedScenario = process.argv.find(a => a.startsWith('--scenario='))?.slice(11);
const selectedVariant = process.argv.find(a=>a.startsWith('--variant='))?.slice(10);
const results = [];
for (const [id, v] of Object.entries(PADDLE_VARIANTS).filter(([id])=>!selectedVariant||id===selectedVariant)) {
  const assembly = buildPaddleVariant(id), e = assembly.engineering;
  const g = { ...v.geometry, inertia: e.rotorInertia, rotorMass: e.rotorMass, machineryMass: e.machineryMass };
  assert.ok(e.rotorInertia > 1000 && e.rotorMass > 500);
  assert.ok(g.x - g.width/2 > 11.8, 'blade clears hull outer envelope');
  const { paddleFrame, createPaddleFrame } = await import('../src/dev/paddleKinematics.ts');
  const frame = createPaddleFrame(), before = createPaddleFrame(), after = createPaddleFrame();
  for(let i=0;i<g.blades;i++) {
    paddleFrame(g,.123,i,frame);paddleFrame(g,.123-1e-5,i,before);paddleFrame(g,.123+1e-5,i,after);
    assert.ok(after.point.sub(before.point).multiplyScalar(1/2e-5).distanceTo(frame.tangent)<1e-4,'Path derivative mismatch');
  }
  // Geometric moving blade centres match the force path, including the articulated sweeps.
  assembly.animate([.123,.123]); assembly.group.updateMatrixWorld(true);
  assert.ok(assembly.group.children.length>0);
  for (const scenario of ['ahead', 'pivot', 'waves'].filter(s => !selectedScenario || s === selectedScenario)) {
    const wind = new Wind(3); wind.baseSpeed = scenario === 'waves' ? 8 : 0; wind.update(0);
    const waves = new WaveField(wind, 11); if (scenario !== 'waves') for (const w of waves.waves) w.amp = w.target = 0;
    const crew = new Crew(), ship = new ShipPhysics(waves, wind,
      { heightAt: () => -100, normalAt: (_x, _z, out) => out.set(0,1,0) }, crew, makeThalassaDesign());
    const drive = new TwinPaddles(crew, g); drive.mount(ship);
    const mass12 = ship.mass; drive.setWatchPower(ship, sourceKW);
    assert.ok(Math.abs(ship.mass - mass12 - (sourceKW - 12)*1000/75*80)<1e-6,'Active worker mass mismatch');
    ship.place(0,0,0);
    drive.manual = true; drive.commands = scenario === 'pivot' ? [1,-1] : [1,1];
    let maxPower = 0, closure = 0, maxRPM = 0, maxThrust = 0;
    for (let i = 0; i < 40*120; i++) {
      if (scenario === 'coast' && i === 30*120) drive.commands = [0,0];
      if (scenario === 'waves') { wind.update(1/120); waves.update(1/120); }
      ship.step(1/120);
      assert.ok([...ship.pos,...ship.vel,...ship.angVel,...drive.wheels.map(w=>w.omega)].every(Number.isFinite));
      maxPower = Math.max(maxPower, drive.wheels.reduce((sum,w)=>sum+w.sourceW,0));
      const fluid = drive.hullW-drive.reactionW+drive.wheels.reduce((sum,w)=>sum+w.waterW,0)+drive.dissipationW-drive.waveW;
      closure = Math.max(closure, Math.abs(fluid));
      for (const w of drive.wheels) {
        closure = Math.max(closure, Math.abs(w.shaftW+w.waterW-w.frictionW-w.storedW+w.numericalW));
        maxRPM = Math.max(maxRPM, Math.abs(w.rpm)); maxThrust = Math.max(maxThrust, Math.abs(w.thrust));
      }
      assert.ok(drive.dissipationW >= -1e-6);
    }
    assert.ok(maxPower <= sourceKW*1000+.0001); assert.ok(closure < 1e-5);
    if (scenario === 'ahead') assert.ok(ship.speed > .03);
    if (scenario === 'pivot') assert.ok(ship.heading > .005);
    if (scenario === 'coast') assert.equal(drive.wheels.reduce((sum,w)=>sum+w.sourceW,0),0);
    // Changing machinery updates mass and resets shaft history without moving the hull frame.
    drive.setGeometry(ship, g); assert.ok(drive.wheels.every(w=>w.angle===0 && w.omega===0));
    const row = { id, scenario, sourceKW, seconds: 40, speed_kn: ship.speed*1.943844, heading_deg: ship.heading*180/Math.PI,
      maxPower, closure, maxRPM, maxThrust, ...e, geometry: g };
    results.push(row); console.log(JSON.stringify(row));
  }
  disposePaddleVariant(assembly.group);
}
fs.writeFileSync(`ship-study/propulsion/results/paddle-variants${selectedVariant?`-${selectedVariant}`:''}${sourceKW===12?'':`-${sourceKW}kw`}.json`, JSON.stringify(results,null,2));
