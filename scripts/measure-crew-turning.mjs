import './register-ts.mjs';
// How well the merchant's crew turns with the helm: overshoot when the helmsman steadies on a new
// heading, how long the oars keep turning after the helm is centred, course-keeping in a sea, and
// mode flicker at small helm. Measurement only, no pass/fail.
// node scripts/measure-crew-turning.mjs
const { Crew } = await import('../src/ship/crew.ts');
const { ShipPhysics } = await import('../src/ship/physics.ts');
const { Wind } = await import('../src/world/wind.ts');
const { WaveField } = await import('../src/world/waves.ts');
const { MERCHANT } = await import('../src/ship/design.ts');
const { MERCHANT_CREW } = await import('../src/ship/crew/params.ts');
const dt = 1 / 120, KN = 1.943844, DEG = 180 / Math.PI;
const terrain = { heightAt: () => -100, normalAt: (x, z, out) => out.set(0, 1, 0) };
const FULL = 4, HALF = 3, SLOW = 2;
// optional section filter: node scripts/measure-crew-turning.mjs 1 2b
const only = process.argv.slice(2);
const want = (k) => !only.length || only.includes(k);

function calm() { const w = new WaveField(new Wind(0)); w.waves.length = 0; return { wind: { vx: 0, vz: 0 }, waves: w }; }
/** a sea at mean wind U m/s from the north, stepped as the game does */
function sea(U, seed = 1) {
  const wind = new Wind(seed);
  wind.baseFrom = 0;
  wind.baseSpeed = 1; wind.update(0);
  wind.baseSpeed = U / wind.meanSpeed; wind.update(0);
  const waves = new WaveField(wind);
  waves.update(Infinity);
  return { wind, waves, live: true };
}

/** a merchant settled on `heading` (deg), brought up to steady speed under `order` with the helm amidships */
function vessel({ env = calm(), order = FULL, heading = 0, allocation = true, spinup = 60 } = {}) {
  const design = { ...MERCHANT, oars: { ...MERCHANT.oars, crew: { ...MERCHANT_CREW, allocation } } };
  const crew = new Crew(), ship = new ShipPhysics(env.waves, env.wind, terrain, crew, design);
  ship.place(0, 0, heading / DEG);
  const s = { ship, env, t: 0, retarget: 0, hdg: heading, lastRaw: heading };
  for (let i = 0; i < 240; i++) ship.step(dt);
  ship.vel.set(0, 0, 0); ship.angVel.set(0, 0, 0);
  crew.setOrder(order);
  for (let i = 0; i < spinup / dt; i++) step(s);
  return s;
}
function step(s) {
  const { ship, env } = s;
  if (env.live) {
    env.wind.update(dt);
    if ((s.retarget -= dt) <= 0) { env.waves.retarget(env.wind); s.retarget = 1; }
    env.waves.update(dt);
  }
  ship.step(dt);
  s.t += dt;
  // unwrapped heading (deg, + = to starboard)
  const raw = ship.heading * DEG;
  let d = raw - s.lastRaw; d -= 360 * Math.round(d / 360);
  s.hdg += d; s.lastRaw = raw;
}
const yawRate = (s) => -s.ship.angVel.y * DEG; // deg/s, + = to starboard (heading increasing)

/**
 * The helmsman's turn: put the helm over at the game's key rate (0.9/s) to `helm`, hold until the heading
 * has changed by `target` - `lead` deg, then centre with X (exp -4/s) or let it self-centre (exp -0.25/s).
 */
function turnAndSteady(s, { helm = 1, target = 90, lead = 0, centre = 'x' }) {
  const h0 = s.hdg, ship = s.ship;
  let phase = 'over', tCentre = 0, rateAtCentre = 0, maxPast = -Infinity, settle = NaN, tStart = s.t;
  let oarYawAtCentre = 0, oarFadeT = NaN;
  // oar yaw moment, averaged over ~one stroke (exponential, 2 s)
  let oarYaw = 0;
  const row = ship.rowing.step.bind(ship.rowing);
  ship.rowing.step = (a, b, c, d, e, f, m) => { const y0 = m.y; row(a, b, c, d, e, f, m); oarYaw += ((m.y - y0) - oarYaw) * (a / 2); };
  for (let i = 0; i < 120 / dt; i++) {
    const turned = s.hdg - h0;
    if (phase === 'over') {
      ship.helm = Math.min(helm, ship.helm + 0.9 * dt);
      if (turned >= target - lead) { phase = 'centre'; tCentre = s.t; rateAtCentre = yawRate(s); oarYawAtCentre = oarYaw; }
    } else {
      ship.helm *= Math.exp(-dt * (centre === 'x' ? 4 : 0.25));
      maxPast = Math.max(maxPast, turned - target);
      if (Number.isNaN(oarFadeT) && Math.abs(oarYaw) < 0.1 * Math.abs(oarYawAtCentre)) oarFadeT = s.t - tCentre;
      if (Number.isNaN(settle) && Math.abs(yawRate(s)) < 0.1 && s.t - tCentre > 1) settle = s.t - tCentre;
      if (!Number.isNaN(settle) && !Number.isNaN(oarFadeT) && s.t - tCentre > settle + 5) break;
    }
    step(s);
  }
  ship.rowing.step = row;
  return {
    timeToTargetS: +(tCentre - tStart).toFixed(1),
    rateAtCentreDegS: +rateAtCentre.toFixed(2),
    overshootDeg: +maxPast.toFixed(1),
    settleS: +settle.toFixed(1),
    oarYawFadeS: +oarFadeT.toFixed(1),
    knAfter: +(ship.speed * KN).toFixed(2),
  };
}

if (want('1')) {
console.log('\n1. Turn 90 deg and steady (helmsman centres with X the moment she is on the new heading)');
const turnRows = [];
for (const [name, order, spinup] of [['from rest, Full', FULL, 0], ['underway, Full', FULL, 60], ['underway, Half', HALF, 60], ['underway, Slow', SLOW, 60]]) {
  for (const allocation of [true, false]) {
    for (const helm of [1, 0.5]) {
      const s = vessel({ order, allocation, spinup });
      const kn0 = +(s.ship.speed * KN).toFixed(2);
      turnRows.push({ case: name, crew: allocation ? 'turning' : 'straight', helm, kn0, ...turnAndSteady(s, { helm }) });
    }
  }
}
console.table(turnRows);

}
if (want('1b')) {
console.log('\n1b. Same, but the helmsman lets go and the helm self-centres (exp -0.25/s)');
const relRows = [];
for (const [name, order, spinup] of [['from rest, Full', FULL, 0], ['underway, Full', FULL, 60]]) {
  for (const allocation of [true, false]) {
    const s = vessel({ order, allocation, spinup });
    relRows.push({ case: name, crew: allocation ? 'turning' : 'straight', ...turnAndSteady(s, { helm: 1, centre: 'release' }) });
  }
}
console.table(relRows);

}
if (want('2')) {
console.log('\n2. Course-keeping in a sea, helm amidships, Full (wind and sea from the north = 0 deg)');
const seaRows = [];
for (const U of [8, 12]) {
  for (const heading of [0, 45, 90, 135, 180]) {
    const s = vessel({ env: sea(U), heading, spinup: 30 });
    const h0 = s.hdg; let sum = 0, sum2 = 0, n = 0, maxDev = 0;
    for (let i = 0; i < 120 / dt; i++) {
      s.ship.helm = 0; step(s);
      const r = yawRate(s); sum += r; sum2 += r * r; n++;
      maxDev = Math.max(maxDev, Math.abs(s.hdg - h0));
    }
    const mean = sum / n;
    seaRows.push({ windKn: +(U * KN).toFixed(0), heading, driftDeg120s: +(s.hdg - h0).toFixed(1), maxDevDeg: +maxDev.toFixed(1),
      meanYawDegS: +mean.toFixed(2), rmsYawDegS: +Math.sqrt(sum2 / n - mean * mean).toFixed(2), kn: +(s.ship.speed * KN).toFixed(2) });
  }
}
console.table(seaRows);

}
if (want('2b')) {
console.log('\n2b. Hard-over turn rate in a sea vs calm (Full, underway, mean and spread of yaw rate over 30 s once turning)');
const seaTurnRows = [];
for (const [label, mk] of [['calm', () => calm()], ['17 kn wind', () => sea(9)], ['23 kn wind', () => sea(12)]]) {
  for (const heading of [0, 90, 180]) {
    if (label === 'calm' && heading) continue;
    const s = vessel({ env: mk(), heading, spinup: 40 });
    for (let i = 0; i < 5 / dt; i++) { s.ship.helm = Math.min(1, s.ship.helm + 0.9 * dt); step(s); }
    const rates = [];
    for (let i = 0; i < 30 / dt; i++) { s.ship.helm = 1; step(s); rates.push(yawRate(s)); }
    const m = rates.reduce((a, b) => a + b) / rates.length;
    const sd = Math.sqrt(rates.reduce((a, b) => a + (b - m) ** 2, 0) / rates.length);
    seaTurnRows.push({ sea: label, startHeading: heading, meanYawDegS: +m.toFixed(2), sdYawDegS: +sd.toFixed(2), min: +Math.min(...rates).toFixed(2), kn: +(s.ship.speed * KN).toFixed(2) });
  }
}
console.table(seaTurnRows);

}
if (want('3')) {
console.log('\n3. Small helm: oar mode changes and allocation sign/rest crossings per minute (60 s at a steady helm)');
const flickRows = [];
for (const [name, order, spinup] of [['from rest, Full', FULL, 0], ['underway, Full', FULL, 60], ['underway, Half', HALF, 60], ['underway, Slow', SLOW, 60]]) {
  for (const helm of [0.1, 0.2, 0.3, 0.5]) {
    const s = vessel({ order, spinup });
    s.ship.helm = helm;
    for (let i = 0; i < 10 / dt; i++) step(s); // settle into the turn
    const oars = s.ship.rowing.oars;
    const restLike = (o) => o.mode === 'rest' || o.mode === 'hold';
    let prevRest = oars.map(restLike), prevSign = oars.map((o) => Math.sign(o.alloc)), toggles = 0, signFlips = 0;
    const allocMin = oars.map(() => Infinity), allocMax = oars.map(() => -Infinity);
    let rateSum = 0, n = 0;
    for (let i = 0; i < 60 / dt; i++) {
      step(s);
      oars.forEach((o, k) => {
        const r = restLike(o); if (r !== prevRest[k]) { toggles++; prevRest[k] = r; }
        const sg = Math.sign(o.alloc); if (sg && sg !== prevSign[k]) { if (prevSign[k]) signFlips++; prevSign[k] = sg; }
        allocMin[k] = Math.min(allocMin[k], o.alloc); allocMax[k] = Math.max(allocMax[k], o.alloc);
      });
      rateSum += yawRate(s); n++;
    }
    const range = oars.map((o, k) => `${o.slot.side > 0 ? 'S' : 'P'}${allocMin[k].toFixed(2)}..${allocMax[k].toFixed(2)}`).join(' ');
    flickRows.push({ case: name, helm, restToggles: toggles, signFlips, yawDegS: +(rateSum / n).toFixed(2), kn: +(s.ship.speed * KN).toFixed(2), allocRanges: range });
  }
}
console.table(flickRows);
}
