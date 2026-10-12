import './register-ts.mjs';
// Calm-water rowing trial for the trireme's agent crew: per order from rest, the steady speed (last 30 s of 120 s),
// stroke rate, arc, power, efficiency, crew stamina and CPU per step. Then a ramming sprint from a converged Full.
// node scripts/measure-trireme-rowing.mjs ['<json crew overrides>'] [--orders=2,3,4,0] [--sprint] [--secs=120]
const { Crew, ORDERS } = await import('../src/ship/crew.ts');
const { ShipPhysics } = await import('../src/ship/physics.ts');
const { Wind } = await import('../src/world/wind.ts');
const { WaveField } = await import('../src/world/waves.ts');
const { TRIREME } = await import('../src/ship/design.ts');
const dt = 1 / 120, terrain = { heightAt: () => -100, normalAt: (x, z, out) => out.set(0, 1, 0) };
const KN = 1.943844;
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const json = process.argv.slice(2).find((a) => a.startsWith('{'));
const over = JSON.parse(json ?? '{}');
const secs = +(arg('secs') ?? 120);
const orders = (arg('orders') ?? '2,3,4,0').split(',').map(Number);
const design = { ...TRIREME, oars: { ...TRIREME.oars, crew: { ...TRIREME.oars.crew, ...over } } };

function vessel() {
  const water = new WaveField(new Wind(0)); water.waves.length = 0;
  const crew = new Crew(), ship = new ShipPhysics(water, { vx: 0, vz: 0 }, terrain, crew, design);
  crew.maxOrder = design.oars.maxOrder;
  ship.place(0, 0, 0);
  for (let i = 0; i < 240; i++) ship.step(dt);
  ship.vel.set(0, 0, 0); ship.angVel.set(0, 0, 0);
  return ship;
}
const arcs = (r) => { let a = 0, n = 0; for (const o of r.oars) if (o.strokes > 1) { a += o.lastArc; n++; } return n ? a / n : 0; };
const spread = (r) => {
  // catch spread of the last beat: catches within half a period of the stroke's last catch
  const L = r.leader(); if (!L || !Number.isFinite(L.lastCatch)) return NaN;
  let lo = Infinity, hi = -Infinity;
  for (const o of r.oars) { const d = o.lastCatch - L.lastCatch, w = d - L.period * Math.round(d / L.period); if (Number.isFinite(w)) { lo = Math.min(lo, w); hi = Math.max(hi, w); } }
  return hi - lo;
};

const rows = [];
for (const order of orders) {
  const ship = vessel(), r = ship.rowing;
  ship.crew.setOrder(order);
  let to3 = null, sum = 0, thrust = 0, power = 0, hull = 0, missed = 0, n = 0, cpu = 0;
  for (let i = 0; i < secs / dt; i++) {
    const t0 = performance.now(); ship.step(dt); cpu += performance.now() - t0;
    const t = (i + 1) * dt;
    if (to3 === null && Math.abs(ship.speed * KN) >= 3) to3 = t;
    const tl = r.telemetry;
    if (t >= secs - 30) { n++; sum += ship.speed; thrust += tl.oarThrust; power += tl.positivePower; hull += tl.hullPower ?? 0; missed += tl.missedDriveFraction; }
  }
  const v = sum / n;
  rows.push({ order: ORDERS[order].short, knSteady: +(v * KN).toFixed(2), sTo3kn: to3 && +to3.toFixed(0), spm: +ship.crew.rate.toFixed(1),
    arcDeg: +(arcs(r) * 57.3).toFixed(0), perManW: Math.round(power / n / 170), thrustN: Math.round(thrust / n),
    efficiency: +(Math.abs((thrust / n) * v) / (power / n)).toFixed(2), spreadMs: Math.round(spread(r) * 1000),
    stamina: +ship.crew.stamina.toFixed(3), missed: +(missed / n).toFixed(3), msPerStep: +(cpu / (secs / dt)).toFixed(3) });
}
console.log(json ?? 'current');
console.table(rows);

if (process.argv.includes('--sprint')) {
  const ship = vessel(), r = ship.rowing;
  ship.crew.setOrder(4);
  for (let i = 0; i < 120 / dt; i++) ship.step(dt);
  const base = ship.speed * KN;
  ship.crew.setOrder(5);
  let best = 0, win = [], demoted = null, trace = [];
  for (let i = 0; i < 200 / dt; i++) {
    ship.step(dt);
    const t = (i + 1) * dt;
    win.push(ship.speed * KN); if (win.length > 600) win.shift();
    if (t <= 30 && win.length === 600) best = Math.max(best, win.reduce((a, b) => a + b, 0) / 600);
    if (demoted === null && ship.crew.orderIndex !== 5) demoted = t;
    if (i % 1200 === 0) trace.push({ t: Math.round(t), kn: +(ship.speed * KN).toFixed(2), spm: +ship.crew.rate.toFixed(1), perManW: Math.round(r.telemetry.positivePower / 170), stamina: +ship.crew.stamina.toFixed(3), order: ORDERS[ship.crew.orderIndex].short });
  }
  console.log(`sprint: Full ${base.toFixed(2)} kn -> best 5 s mean in 30 s ${best.toFixed(2)} kn; demoted at ${demoted && demoted.toFixed(0)} s`);
  console.table(trace);
}
