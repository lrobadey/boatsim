import './register-ts.mjs';
// Yaw-moment breakdown for the merchant's turns (docs/merchant-crew-spec.md §13.1): which moments
// drive and resist the turn, before anyone tunes turning. Calm water, no wind.
// node scripts/measure-crew-yaw.mjs
const { Crew } = await import('../src/ship/crew.ts');
const { ShipPhysics } = await import('../src/ship/physics.ts');
const { Wind } = await import('../src/world/wind.ts');
const { WaveField } = await import('../src/world/waves.ts');
const { MERCHANT } = await import('../src/ship/design.ts');
const dt = 1 / 120, KN = 1.943844;
const terrain = { heightAt: () => -100, normalAt: (x, z, out) => out.set(0, 1, 0) };

function trial(name, { startKn = 0, order = 4, helm = 1, seconds = 90, from = 30 } = {}) {
  const water = new WaveField(new Wind(0)); water.waves.length = 0;
  const crew = new Crew(), ship = new ShipPhysics(water, { vx: 0, vz: 0 }, terrain, crew, MERCHANT);
  ship.place(0, 0, 0);
  for (let i = 0; i < 240; i++) ship.step(dt);
  ship.vel.set(0, 0, -startKn / KN); ship.angVel.set(0, 0, 0);
  crew.setOrder(order);
  // wrap the moment sources: each adds into ship.torque
  const acc = { oars: 0, hull: 0, angularDamp: 0, rudders: 0, sail: 0, windage: 0 };
  let n = 0, sampling = false;
  const wrap = (key, method) => {
    const f = ship[method].bind(ship);
    ship[method] = (...a) => { const y0 = ship.torque.y; const r = f(...a); if (sampling) acc[key] += ship.torque.y - y0; return r; };
  };
  wrap('hull', 'hydrostatics'); wrap('rudders', 'rudders'); wrap('windage', 'windage');
  const row = ship.rowing.step.bind(ship.rowing);
  ship.rowing.step = (dtt, t, body, h, w, f, m) => { const y0 = m.y; row(dtt, t, body, h, w, f, m); if (sampling) acc.oars += m.y - y0; };
  let rate = 0, speed = 0;
  for (let i = 0; i < seconds / dt; i++) {
    const t = i * dt;
    sampling = t >= from;
    ship.helm = helm;
    if (sampling) { acc.angularDamp += -ship.mass * MERCHANT.hydro.angularDamp * ship.angVel.y; rate += ship.angVel.y; speed += ship.speed; n++; }
    ship.step(dt);
  }
  for (const k in acc) acc[k] /= n;
  // hydrostatics includes the angular damping term: report the hull's own share separately
  acc.hullLateral = acc.hull - acc.angularDamp;
  const r = { name, yawRateDegS: +((rate / n) * 57.2958).toFixed(2), kn: +((speed / n) * KN).toFixed(2) };
  for (const k of ['oars', 'rudders', 'hullLateral', 'angularDamp', 'windage']) r[k] = Math.round(acc[k]);
  return r;
}

const rows = [
  trial('pivot from rest, Full, hard over'),
  trial('underway 2.3 kn, Full, hard over', { startKn: 2.3 }),
  trial('underway 2.3 kn, Half, half helm', { startKn: 2.3, order: 3, helm: 0.5 }),
];
console.log('Mean yaw moments (N m) over the steady part of the turn: the oars drive it, opposite signs resist');
console.table(rows);
