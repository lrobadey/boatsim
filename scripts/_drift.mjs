import './register-ts.mjs';
import * as THREE from 'three';
const { Crew } = await import('../src/ship/crew.ts');
const { ShipPhysics } = await import('../src/ship/physics.ts');
const { Wind } = await import('../src/world/wind.ts');
const { WaveField } = await import('../src/world/waves.ts');
const D = await import('../src/ship/design.ts');
const design = D[process.env.SHIP ?? 'MERCHANT'];
const dt = 1/120, KN = 1.943844, SECS = 120;
const terrain = { heightAt: () => -100, normalAt: (x, z, out) => out.set(0, 1, 0) };
const still = { vx: 0, vz: 0, sampleAt: (x, y, z, t, out) => out.set(0, 0, 0) };
const U = +(process.env.U ?? 12), rel = +(process.env.REL ?? 180) * Math.PI / 180, order = +(process.env.ORDER ?? -1);
const wind = new Wind(1); wind.update(0); wind.baseSpeed = U * U / wind.meanSpeed; wind.update(0);
const waves = new WaveField(wind); waves.update(Infinity);
const crew = new Crew(), ship = new ShipPhysics(waves, still, terrain, crew, design);
const heading = wind.from + Math.PI + rel; // rel 180 = bow into the waves
ship.place(0, 0, heading);
const row = order >= 0;
ship.rowing.setShipped(-1, !row); ship.rowing.setShipped(1, !row);
for (let i = 0; i < 240; i++) ship.step(dt);
ship.vel.set(0, 0, 0); ship.angVel.set(0, 0, 0);
if (row) crew.setOrder(order);
// wrap to measure each contribution's mean force along the heading
const acc = {}; const add = (k, v) => acc[k] = (acc[k] ?? 0) + v;
const P = Object.getPrototypeOf(ship);
const fwd = new THREE.Vector3();
let on = false;
for (const name of ['hydrostatics', 'columnResponse', 'kirchhoff', 'rudders', 'windage']) {
  const orig = P[name];
  ship[name] = function (...a) { const before = this.force.clone(); const r = orig.apply(this, a); if (on) add(name, this.force.clone().sub(before).dot(fwd)); return r; };
}
const origRow = ship.rowing.step.bind(ship.rowing);
ship.rowing.step = (...a) => { const b = ship.force.clone(); origRow(...a); if (on) add('oars', ship.force.clone().sub(b).dot(fwd)); };
let n = 0, sp = 0;
const f0 = new THREE.Vector3(Math.sin(heading), 0, -Math.cos(heading)); const p0 = ship.pos.clone();
for (let i = 0; i < SECS / dt; i++) {
  fwd.copy(f0);
  on = i * dt > 30; if (on) n++;
  ship.helm = THREE.MathUtils.clamp(-1.2 * (((ship.heading - heading + Math.PI) % (2*Math.PI) + 2*Math.PI) % (2*Math.PI) - Math.PI) - 4 * -ship.angVel.y, -0.3, 0.3);
  waves.update(dt); ship.step(dt);
  if (on) sp += ship.speed;
}
const track = ship.pos.clone().sub(p0).dot(f0) / SECS;
const out = Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, Math.round(v / n)]));
out.dragEtc = out.hydrostatics - out.columnResponse;
console.log(JSON.stringify({ U, rel: process.env.REL ?? 180, order, trackKn: +(track * KN).toFixed(2), speedKn: +(sp / n * KN).toFixed(2), meanFwdForceN: out }));
