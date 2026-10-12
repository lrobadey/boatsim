import './register-ts.mjs';
// scratch: Full order in rough water, merchant
const { Crew } = await import('../src/ship/crew.ts');
const { ShipPhysics } = await import('../src/ship/physics.ts');
const { Wind } = await import('../src/world/wind.ts');
const { WaveField } = await import('../src/world/waves.ts');
const { MERCHANT } = await import('../src/ship/design.ts');
const dt = 1/120, KN = 1.943844, SECS = +(process.env.SECS ?? 120);
const terrain = { heightAt: () => -100, normalAt: (x, z, out) => out.set(0, 1, 0) };
const still = { vx: 0, vz: 0, sampleAt: (x, y, z, t, out) => out.set(0, 0, 0) };
function sea(U) {
  const wind = new Wind(1); wind.update(0);
  wind.baseSpeed = ((U || 12) ** 2) / wind.meanSpeed; wind.update(0);
  const waves = new WaveField(wind);
  if (!U) waves.waves.length = 0; else waves.update(Infinity);
  return { wind, waves };
}
const rows = [];
const Us = (process.env.US ?? '0,8,12,16').split(',').map(Number);
const rels = (process.env.RELS ?? '0,90,180').split(',').map(Number);
for (const U of Us) for (const relDeg of (U ? rels : [0])) {
  const S = sea(U), heading = S.wind.from + Math.PI + relDeg * Math.PI / 180; // rel 0 = heading into the waves
  const crew = new Crew(), ship = new ShipPhysics(S.waves, process.env.WIND ? S.wind : still, terrain, crew, MERCHANT);
  ship.place(0, 0, heading);
  for (let i = 0; i < 240; i++) ship.step(dt);
  ship.vel.set(0, 0, 0); ship.angVel.set(0, 0, 0);
  crew.setOrder(4);
  let n = 0, v = 0, th = 0, pw = 0, wet = 0, miss = 0, cap = 0, hullP = 0, t30 = 0;
  for (let i = 0; i < SECS / dt; i++) {
    if (U) S.waves.update(dt);
    ship.step(dt);
    const t = (i + 1) * dt, tl = ship.rowing.telemetry;
    if (Math.abs(t - 30) < dt / 2) t30 = ship.speed * KN;
    if (t > SECS - 40) { n++; v += ship.speed; th += tl.oarThrust; pw += tl.positivePower; wet += tl.wetBlades; miss = tl.missedDriveFraction; cap += tl.forceCapFraction; hullP += tl.hullPower; }
  }
  rows.push({ U, rel: relDeg, hs: +S.waves.hs.toFixed(2), kn30: +t30.toFixed(2), knEnd: +(v / n * KN).toFixed(2), thrustN: Math.round(th / n), crewW: Math.round(pw / n), wetBlades: +(wet / n).toFixed(2), missed: +miss.toFixed(2), spm: +ship.crew.rate.toFixed(1), hullW: Math.round(hullP / n) });
}
console.table(rows);
