import './register-ts.mjs';
// Exact merchant trace for refactor checks of the crew code: node scripts/trace-merchant.mjs <out.json>
// Records hull state and every oar's joint at 1 Hz through orders, a turn, hold water, shipping and a sea.
import fs from 'node:fs';
const { Crew } = await import('../src/ship/crew.ts');
const { ShipPhysics } = await import('../src/ship/physics.ts');
const { Wind } = await import('../src/world/wind.ts');
const { WaveField } = await import('../src/world/waves.ts');
const { MERCHANT } = await import('../src/ship/design.ts');
const dt = 1 / 120;
const terrain = { heightAt: () => -100, normalAt: (x, z, o) => o.set(0, 1, 0) };
const out = [];
for (const seaOn of [false, true]) {
  const w = new WaveField(new Wind(3), seaOn ? 11 : undefined); if (!seaOn) w.waves.length = 0;
  const crew = new Crew(), ship = new ShipPhysics(w, { vx: 0, vz: 0 }, terrain, crew, MERCHANT);
  ship.place(0, 0, 0);
  for (let i = 0; i < 120 * 200; i++) {
    const t = i * dt;
    crew.setOrder(t < 60 ? 4 : t < 90 ? 3 : t < 110 ? 0 : t < 140 ? 4 : 2);
    ship.helm = t > 40 && t < 70 ? 0.8 : t > 150 && t < 170 ? -1 : 0;
    crew.holdWater = t > 120 && t < 130;
    if (Math.abs(t - 175) < dt / 2) ship.rowing.setShipped(1, true);
    if (Math.abs(t - 185) < dt / 2) ship.rowing.setShipped(1, false);
    ship.step(dt);
    if (i % 120 === 0) out.push([ship.pos.x, ship.pos.y, ship.pos.z, ship.quat.x, ship.quat.y, ship.quat.z, ship.quat.w, ...ship.rowing.current.joint, crew.stamina]);
  }
}
fs.writeFileSync(process.argv[2], JSON.stringify(out));
console.log('frames', out.length);
