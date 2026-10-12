import { trial } from './run1.mjs';
const order = +(process.argv[2] ?? 4), opts = JSON.parse(process.argv[3] ?? '{}');
const r = trial({ order, secs: 100, opts, hold: (t, ship) => { if (Math.abs(t - 60) < 1e-6) ship.rowing.byMode = {}; } });
const bm = r.sys.byMode; const tot = Object.values(bm).reduce((a, b) => a + b.pos, 0);
for (const [k, v] of Object.entries(bm)) console.log(k.padEnd(9), Object.fromEntries(Object.entries(v).map(([a, b]) => [a, Math.round(b / 40)])));
console.log({ kn: r.knSteady.toFixed(2), crewW: r.crewW.toFixed(0), thrust: r.thrust.toFixed(0), eff: r.eff.toFixed(3), rate: r.crew.rate.toFixed(1), t30: r.t30.toFixed(2), t60: r.t60.toFixed(2), to1: r.to1 });
const o = r.sys.oars[5]; console.log('stroke oar', { arc: o.plan.arc, u: o.plan.u, lastDrive: o.lastDrive, period: o.period, cycP: o.lastCycleP });
console.log(r.sys.oars.map(o => ({ arc: +o.plan.arc.toFixed(2), u: +o.plan.u.toFixed(2), Td: +o.lastDrive.toFixed(2), P: Math.round(o.lastCycleP), T: +o.period.toFixed(2), S: +o.hand.S(r.sys.p).toFixed(2), W: Math.round(o.hand.Wbal) })));
