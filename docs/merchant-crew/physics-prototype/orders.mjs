import { trial } from './run1.mjs';
const opts = JSON.parse(process.argv[2] ?? '{}'), secs = +(process.argv[3] ?? 240), dt = 1 / (+(process.argv[4] ?? 120));
const rows = [];
for (const order of [2, 3, 4, 0]) {
  const r = trial({ order, secs, dt, opts });
  const o = r.sys.oars;
  rows.push({ order: ['BACK', 'STOP', 'SLOW', 'HALF', 'FULL'][order], kn30: +r.t30.toFixed(2), kn60: +r.t60.toFixed(2), to1kn: r.to1 && +r.to1.toFixed(1), knSteady: +r.knSteady.toFixed(2),
    thrustN: Math.round(r.thrust), W_per_rower: Math.round(r.crewW / 6), eff: +r.eff.toFixed(3), spm: +r.crew.rate.toFixed(1),
    arcDeg: Math.round(o.reduce((a, b) => a + b.plan.arc, 0) / 6 * 57.3), u: +(o.reduce((a, b) => a + b.plan.u, 0) / 6).toFixed(2), driveS: +(o.reduce((a, b) => a + b.lastDrive, 0) / 6).toFixed(2) });
}
console.table(rows);
