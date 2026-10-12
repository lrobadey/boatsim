import './register-ts.mjs';
// Calm-water rowing trial for the merchant: acceleration, steady speed, thrust and propulsive
// efficiency per order. Optional variants: node scripts/measure-merchant-rowing.mjs '<json oar overrides>'
// e.g. '{"sweepFwd":0.45,"sweepBack":-0.35,"blade":[1.1,0.28]}'
const { Crew, ORDERS } = await import('../src/ship/crew.ts');
const { ShipPhysics } = await import('../src/ship/physics.ts');
const { Wind } = await import('../src/world/wind.ts');
const { WaveField } = await import('../src/world/waves.ts');
const { MERCHANT } = await import('../src/ship/design.ts');
const dt = 1 / 120, terrain = { heightAt: () => -100, normalAt: (x, z, out) => out.set(0, 1, 0) };
const KN = 1.943844, secs = 240;
const { blade, ...over } = JSON.parse(process.argv[2] ?? '{}');
const slots = blade ? () => MERCHANT.oars.slots().map((s) => ({ ...s, bladeLength: blade[0], bladeWidth: blade[1], bladeRadius: s.length - s.inboard - blade[0] / 2 })) : MERCHANT.oars.slots;
const design = { ...MERCHANT, oars: { ...MERCHANT.oars, ...over, slots } };
const rows = [];
for (const order of [2, 3, 4, 0]) {
  const water = new WaveField(new Wind(0)); water.waves.length = 0;
  const crew = new Crew(), ship = new ShipPhysics(water, { vx: 0, vz: 0 }, terrain, crew, design);
  ship.place(0, 0, 0);
  for (let i = 0; i < 240; i++) ship.step(dt);
  ship.vel.set(0, 0, 0); ship.angVel.set(0, 0, 0);
  crew.setOrder(order);
  let t30 = 0, t60 = 0, to1 = null, sum = 0, thrust = 0, power = 0, n = 0;
  for (let i = 0; i < secs / dt; i++) {
    ship.step(dt);
    const t = (i + 1) * dt, kn = Math.abs(ship.speed * KN);
    if (Math.abs(t - 30) < dt / 2) t30 = ship.speed * KN;
    if (Math.abs(t - 60) < dt / 2) t60 = ship.speed * KN;
    if (to1 === null && kn >= 1) to1 = t;
    const tl = ship.rowing.telemetry;
    if (t >= secs - 30) { n++; sum += ship.speed; thrust += tl.oarThrust; power += tl.positivePower; }
  }
  const v = sum / n;
  rows.push({ order: ORDERS[order].short, kn30s: +t30.toFixed(2), kn60s: +t60.toFixed(2), sTo1kn: to1 && +to1.toFixed(0),
    knSteady: +(v * KN).toFixed(2), thrustN: Math.round(thrust / n), crewW: Math.round(power / n),
    efficiency: +(Math.abs(thrust / n * v) / (power / n)).toFixed(2), spm: +ship.crew.rate.toFixed(1) });
}
console.log(process.argv[2] ?? 'current');
console.table(rows);
