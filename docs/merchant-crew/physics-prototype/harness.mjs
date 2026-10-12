import '/Users/lucarobadey/Developer/boatsim/scripts/register-ts.mjs';
const R = '/Users/lucarobadey/Developer/boatsim/src/';
export const THREE = await import('/Users/lucarobadey/Developer/boatsim/node_modules/three/build/three.module.js');
export const { Crew, ORDERS } = await import(R + 'ship/crew.ts');
export const { ShipPhysics } = await import(R + 'ship/physics.ts');
export const { Wind } = await import(R + 'world/wind.ts');
export const { WaveField, createFlowSample } = await import(R + 'world/waves.ts');
export const { MERCHANT } = await import(R + 'ship/design.ts');
export const rowingMod = await import(R + 'ship/rowing.ts');
export const KN = 1.943844;
export const terrain = { heightAt: () => -100, normalAt: (x, z, out) => out.set(0, 1, 0) };
export function calm() { const w = new WaveField(new Wind(0)); w.waves.length = 0; return w; }
/** Build a merchant ShipPhysics; optionally replace its rowing system with `sys` (same step/refreshWorld/reset/telemetry seam). */
export function makeShip({ water = calm(), sys = null, payload = [], settle = 2 } = {}) {
  const crew = new Crew();
  const ship = new ShipPhysics(water, { vx: 0, vz: 0 }, terrain, crew, MERCHANT);
  if (sys) { Object.defineProperty(ship, 'rowing', { value: sys, writable: true }); }
  for (const p of payload) ship.payload.push({ mass: p.mass, local: new THREE.Vector3(...p.local) });
  ship.place(0, 0, 0);
  for (let i = 0; i < settle * 120; i++) ship.step(1 / 120);
  ship.vel.set(0, 0, 0); ship.angVel.set(0, 0, 0);
  return { ship, crew };
}
/** constant-force stub that plugs into the rowing seam */
export class Tow {
  constructor(F = 0, N = 0) { this.F = F; this.N = N; this.telemetry = { oarThrust: 0 }; this.slots = []; }
  reset() {} refreshWorld() {}
  step(dt, t, body, helm, waves, force, torque) {
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(body.quat).multiplyScalar(this.F);
    force.add(f); torque.y += this.N; this.telemetry.oarThrust = this.F;
  }
}
