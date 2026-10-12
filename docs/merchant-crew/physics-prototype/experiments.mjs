import { trial } from './run1.mjs';
import { makeShip, KN, THREE } from './harness.mjs';
import { CrewRowing, placeReliefs } from './crewrow.mjs';
import fs from 'node:fs';
const which = process.argv[2] ?? 'all', out = fs.existsSync('results.json') ? JSON.parse(fs.readFileSync('results.json')) : {};
const save = () => fs.writeFileSync('results.json', JSON.stringify(out, null, 1));
const R = (x, d = 2) => +x.toFixed(d);
function build(opts = {}, payload = true) {
  const { ship, crew } = makeShip({ sys: { telemetry: { oarThrust: 0 }, step() {}, reset() {}, refreshWorld() {} } });
  const sys = new CrewRowing(crew, opts); placeReliefs(sys); ship.rowing = sys; if (!payload) sys.noPayload = true; return { ship, crew, sys };
}
const fwdOf = (ship) => new THREE.Vector3(0, 0, -1).applyQuaternion(ship.quat);
const unwrap = (a, prev) => { let d = a - prev; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

if (which === 'all' || which === 'orders') {
  out.orders = {};
  for (const dtHz of [60, 120, 240]) for (const order of [2, 3, 4, 0]) {
    if (dtHz !== 120 && order !== 4 && order !== 3) continue;
    const r = trial({ order, secs: 240, dt: 1 / dtHz });
    const o = r.sys.oars;
    (out.orders[dtHz] ??= []).push({ order: ['BACK', 'STOP', 'SLOW', 'HALF', 'FULL'][order], kn30: R(r.t30), kn60: R(r.t60), to1kn: r.to1 && R(r.to1, 1), knSteady: R(r.knSteady, 3),
      thrustN: Math.round(r.thrust), crewW: Math.round(r.crewW), eff: R(r.eff, 3), spm: R(r.crew.rate, 1), meanArcDeg: Math.round(o.reduce((a, b) => a + b.plan.arc, 0) / 6 * 57.3), driveS: R(o.reduce((a, b) => a + b.lastDrive, 0) / 6) });
  }
  save();
}
if (which === 'all' || which === 'stop') {
  out.stopping = {};
  for (const mode of ['coast', 'hold', 'back']) {
    const { ship, crew, sys } = build(); ship.vel.copy(fwdOf(ship).multiplyScalar(2 / KN));
    let x = 0, t = 0, maxF = 0, maxFh = 0, vmin = 9;
    ship.step(1 / 120);
    if (mode === 'hold') crew.holdWater = true; if (mode === 'back') crew.setOrder(0);
    while (t < 400) { ship.step(1 / 120); t += 1 / 120; x += ship.speed / 120; maxF = Math.max(maxF, -sys.telemetry.oarThrust); for (const o of sys.oars) maxFh = Math.max(maxFh, o.Fh); if (ship.speed < 0.2) break; }
    out.stopping[mode] = { seconds: R(t, 1), metres: R(x, 1), lengths: R(x / 14.2, 2), peakBrakeN: Math.round(maxF), peakHandleN: Math.round(maxFh) };
  }
  save();
}
if (which === 'all' || which === 'turn') {
  out.turning = {};
  for (const alloc of [true, false]) for (const start of ['underway', 'rest']) {
    const { ship, crew, sys } = build({ allocation: alloc });
    crew.setOrder(4); let t = 0, h0 = ship.heading, hp = h0, turned = 0, t90 = null, t180 = null; const dt = 1 / 120;
    if (start === 'underway') for (let i = 0; i < 120 / dt; i++) ship.step(dt);
    const v0 = ship.speed; hp = ship.heading; ship.helm = 1; const rates = []; let h30 = 0, h60 = 0;
    for (let i = 0; i < 90 / dt; i++) { ship.step(dt); t += dt; turned += unwrap(ship.heading, hp); hp = ship.heading; if (t90 === null && Math.abs(turned) >= Math.PI / 2) t90 = t; if (t180 === null && Math.abs(turned) >= Math.PI) t180 = t; if (t > 60) rates.push(ship.angVel.y); if (Math.abs(t - 30) < dt / 2) h30 = turned; if (Math.abs(t - 60) < dt / 2) h60 = turned; }
    const yaw = -rates.reduce((a, b) => a + b, 0) / rates.length; // rad/s, + = to starboard
    out.turning[`${start}_${alloc ? 'crewAssist' : 'rudderOnly'}`] = { startKn: R(v0 * KN), hdg30Deg: Math.round(h30 * 57.3), hdg60Deg: Math.round(h60 * 57.3), yawRateDegS: R(yaw * 57.3), knInTurn: R(ship.speed * KN), diameterM: R(2 * Math.abs(ship.speed / yaw), 1), t90: t90 && R(t90, 1), t180: t180 && R(t180, 1),
      sides: sys.oars.map(o => `${o.slot.side < 0 ? 'P' : 'S'}${o.alloc.toFixed(2)}`).join(' ') };
  }
  save();
}
if (which === 'all' || which === 'rhythm') {
  out.rhythm = {};
  for (const [name, opts] of [['default', {}], ['noCoupling', { K: 0, Klead: 0 }], ['strong', { K: 0.9 }]]) {
    const r = trial({ order: 4, secs: 120, opts });
    const log = r.sys.catchLog, lead = log.filter(e => e.oar === 5);
    const strokes = [];
    for (let k = 0; k < lead.length; k++) {
      const tL = lead[k].t, Tn = (lead[k + 1]?.t ?? tL + 3.3) - tL;
      const offs = [];
      for (let oar = 0; oar < 5; oar++) { const c = log.filter(e => e.oar === oar).map(e => e.t - tL).filter(d => d > -Tn / 2 && d <= Tn / 2); if (c.length) offs.push(c[0]); }
      if (offs.length < 5) continue;
      const m = offs.reduce((a, b) => a + b, 0) / offs.length, sd = Math.sqrt(offs.reduce((a, b) => a + (b - m) ** 2, 0) / offs.length);
      // Kuramoto order parameter at the leader's catch (phases from each rower's own cycle)
      const ph = [0, ...offs.map(d => -2 * Math.PI * d / Tn)], Rk = Math.hypot(ph.reduce((a, b) => a + Math.cos(b), 0), ph.reduce((a, b) => a + Math.sin(b), 0)) / ph.length;
      strokes.push({ k, t: R(tL, 1), periodS: R(Tn), meanLagMs: Math.round(m * 1000), spreadMs: Math.round(sd * 1000), maxAbsMs: Math.round(Math.max(...offs.map(Math.abs)) * 1000), R: R(Rk, 3), offsetsMs: offs.map(d => Math.round(d * 1000)) });
    }
    out.rhythm[name] = strokes;
  }
  save();
}
if (which === 'all' || which === 'audit') {
  const r = trial({ order: 4, secs: 240 });
  out.audit = r.sys.oars.map(o => { const a = o.audit, KE = 0.5 * o.Ieff * o.omega ** 2;
    const oarRes = a.posWork - a.negWork + a.waterWork - KE - a.numLoss - a.shedKE - (a.pickupLoss ?? 0);
    const hullRes = a.hullWork + a.waterWork + a.dipWork + a.slipLoss;
    return { posJ: Math.round(a.posWork), negJ: Math.round(a.negWork), waterOnOarJ: Math.round(a.waterWork), hullJ: Math.round(a.hullWork), slipJ: Math.round(a.slipLoss), dipJ: Math.round(a.dipWork), numLossJ: R(a.numLoss, 1), shedKEJ: R(a.shedKE, 1), pickupJ: R(a.pickupLoss ?? 0, 1), oarResidualJ: R(oarRes, 1), oarResidualPct: R(100 * oarRes / a.posWork, 2), hullIdentityResidualJ: R(hullRes, 6) }; });
  // determinism
  const a = trial({ order: 4, secs: 60 }), b = trial({ order: 4, secs: 60 });
  out.determinism = { identical: a.ship.pos.equals(b.ship.pos) && a.ship.quat.equals(b.ship.quat) && a.sys.oars.every((o, i) => o.theta === b.sys.oars[i].theta), pos: a.ship.pos.toArray() };
  // payload effect
  const np = trial({ order: 4, secs: 240, payload: false });
  out.payload = { withCrewKn: R(r.knSteady, 3), withoutCrewKn: R(np.knSteady, 3) };
  save();
}
if (which === 'all' || which === 'startup') {
  const rows = []; let last = -1, peakF = 0;
  trial({ order: 4, secs: 60, hold: (t, ship) => { const o = ship.rowing.oars[5]; peakF = Math.max(peakF, o.Fh * (o.mode === 'drive' ? 1 : 0));
    if (o.strokes !== last && o.mode === 'catch') { if (last >= 0) rows.push({ stroke: last, t: R(t, 1), kn: R(ship.speed * KN), arcDeg: Math.round(o.plan.arc * 57.3), driveS: R(o.lastDrive), u: R(o.plan.u), peakHandleN: Math.round(peakF), cycleW: Math.round(o.lastCycleP) }); last = o.strokes; peakF = 0; } } });
  out.startup = rows; save();
}
if (which === 'all' || which === 'endurance') {
  out.endurance = {};
  for (const order of [3, 4]) for (const hands of [6, 7, 8]) {
    const { ship, crew, sys } = build({ hands }); crew.setOrder(order); const dt = 1 / 60, mins = 90; const rows = []; let acc = 0, n = 0, minW = 1e9;
    const sec = [];
    for (let i = 0; i < mins * 60 / dt; i++) {
      ship.step(dt); acc += ship.speed; n++;
      if (i % 3000 === 0) { ship.pos.x = 0; ship.pos.z = 0; ship.prevPos.copy(ship.pos); } // stay clear of the 5.6 km world boundary
      if ((i + 1) % 60 === 0) sec.push(ship.speed * KN);
      for (const h of sys.hands) if (h.state === 'rowing') minW = Math.min(minW, h.Wbal);
      if ((i + 1) % Math.round(300 / dt) === 0) { rows.push({ min: Math.round((i + 1) * dt / 60), kn: R(acc / n * KN), meanS: R(sys.hands.filter(h => h.state === 'rowing').reduce((a, h) => a + h.S(sys.p), 0) / 6), minWkJ: R(minW / 1000, 1), minR: R(Math.min(...sys.hands.map(h => h.R)), 2) }); acc = 0; n = 0; minW = 1e9; }
    }
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const dips = sys.swaps.filter(s => s.done).map(s => { const k = Math.round(s.done); const before = mean(sec.slice(k - 40, k - 10)); let lo = 9; for (let j = k; j < k + 20; j++) lo = Math.min(lo, mean(sec.slice(j - 3, j + 3))); return R(100 * (lo - before) / before, 2); });
    out.endurance[`${['', '', '', 'HALF', 'FULL'][order]}_${hands}hands`] = { every5min: rows, swaps: sys.swaps.length, swapSpeedDipPct: dips.length ? { worst: Math.min(...dips), mean: R(mean(dips), 2) } : null, swapLog: sys.swaps.slice(0, 6).map(s => ({ t: R(s.t / 60, 1), oar: s.oar, out: s.out, in: s.in, walkS: R(s.walk, 1), doneAfterS: s.done ? R(s.done - s.t, 1) : null })) };
    console.error('endurance', order, hands, rows.at(-1)); save();
  }
}
console.log(JSON.stringify(out, null, 1).slice(0, 200));
