// Static load on the merchant (cargo-trade spec §5.1, §5.2, §13 T1).
//   node scripts/test-cargo-physics.mjs
// Checks the setStaticLoad fold (draft, no pose jump, heel against the payload path, rowing speed at
// loads of 0, 4, 8 and 12 t), refPoint, and the bad-table throws. Prints KG, GM and roll period per load.
import './register-ts.mjs';
const THREE = await import('three');
const { Crew } = await import('../src/ship/crew.ts');
const { ShipPhysics } = await import('../src/ship/physics.ts');
const { Wind } = await import('../src/world/wind.ts');
const { WaveField } = await import('../src/world/waves.ts');
const { MERCHANT } = await import('../src/ship/design.ts');

const dt = 1 / 120;
const RHO = 1025;
const DEG = Math.PI / 180;
const KN = 1.943844;
const LOADS_T = [0, 4, 8, 12];
const terrain = { heightAt: () => -100, normalAt: (x, z, o) => o.set(0, 1, 0) };
const calmAir = () => ({ vx: 0, vz: 0 });
const calmSea = () => {
  const w = new WaveField(new Wind(0));
  w.waves.length = 0;
  return w;
};
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const designCgVec = () => new THREE.Vector3(0, MERCHANT.mass.cgY, MERCHANT.mass.cgZ);
/** `tonnes` of cargo at the design CG (none for 0) */
const cargoAtCg = (tonnes) => (tonnes > 0 ? [{ mass: tonnes * 1000, local: designCgVec() }] : []);

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`);
  if (!ok) failures++;
}

/** merchant at rest in calm water; `static` and `payload` items go on before she settles */
function newShip({ static: st = [], payload = [] } = {}, seconds = 20) {
  const ship = new ShipPhysics(calmSea(), calmAir(), terrain, new Crew(), MERCHANT);
  ship.place(0, 0, 0);
  if (st.length) ship.setStaticLoad(st);
  for (const p of payload) ship.payload.push(p);
  for (let i = 0; i < seconds / dt; i++) ship.step(dt);
  ship.vel.set(0, 0, 0);
  ship.angVel.set(0, 0, 0);
  return ship;
}

/** mean of a sampled series over its last `secs` seconds */
function meanOver(xs, secs) {
  const n = Math.round(secs / dt);
  return xs.slice(-n).reduce((a, b) => a + b, 0) / n;
}

// Upright hydrostatics of the columns: submerged volume with the water at local height h.
function volumeAt(cols, h) {
  let v = 0;
  for (const c of cols) v += c.area * clamp(h - c.bottom, 0, c.top - c.bottom);
  return v;
}
function waterlineFor(cols, vol) {
  let lo = -5, hi = 5;
  for (let i = 0; i < 100; i++) {
    const m = (lo + hi) / 2;
    if (volumeAt(cols, m) < vol) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

/** KG and GM from column hydrostatics (upright, approximate: column areas stand in for the waterplane) */
function stability(ship) {
  const cols = ship.columns;
  const keel = Math.min(...cols.map((c) => c.bottom));
  const h = waterlineFor(cols, ship.mass / RHO);
  let V = 0, mom = 0, IT = 0;
  for (const c of cols) {
    if (c.bottom >= h) continue;
    const w = Math.min(h, c.top);
    V += c.area * (w - c.bottom);
    mom += (c.area * (w * w - c.bottom * c.bottom)) / 2;
    if (h < c.top) IT += c.area * c.x * c.x;
  }
  const KB = mom / V - keel;
  const BM = IT / V;
  const KG = ship.cg.y - keel;
  return { KG, GM: KB + BM - KG };
}

/** roll period: 3 deg release about the fore-and-aft axis, mean spacing of the first upward crossings of the mean */
function rollPeriod(ship) {
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.quat);
  ship.quat.premultiply(new THREE.Quaternion().setFromAxisAngle(fwd, 3 * DEG));
  ship.prevQuat.copy(ship.quat);
  const xs = [];
  for (let i = 0; i < 30 / dt; i++) {
    ship.step(dt);
    xs.push(ship.heel);
  }
  const mean = meanOver(xs, 5);
  const ups = [];
  for (let i = 1; i < xs.length && ups.length < 5; i++) {
    const a = xs[i - 1] - mean, b = xs[i] - mean;
    if (a < 0 && b >= 0) ups.push(i - 1 + -a / (b - a));
  }
  if (ups.length < 2) return NaN;
  return ((ups[ups.length - 1] - ups[0]) / (ups.length - 1)) * dt;
}

/** full-order rowing speed (m/s) in calm water: mean over the 5 s ending at 60 s of rowing */
function rowSpeedAt60(tonnes) {
  const ship = newShip({ static: cargoAtCg(tonnes) });
  ship.crew.setOrder(4); // Full
  const speeds = [];
  for (let i = 0; i < 60 / dt; i++) {
    ship.step(dt);
    speeds.push(ship.speed);
  }
  return meanOver(speeds, 5);
}

// ---- 0. no static load: refPoint is pos, and the design values are the live ones
{
  const ship = newShip();
  const r = ship.refPoint(new THREE.Vector3());
  check('refPoint equals pos with no static load', r.x === ship.pos.x && r.y === ship.pos.y && r.z === ship.pos.z,
    `pos ${ship.pos.toArray().map((v) => v.toFixed(6)).join(' ')}`);
  check('design values are the live ones with no static load',
    ship.mass === ship.designMass && ship.cg.equals(ship.designCg) && ship.inertia.equals(ship.designInertia));
}

// ---- 1. draft: +4 t at the design CG against the hydrostatic table
{
  const ship = newShip();
  const dm = 4000;
  const hPred = waterlineFor(ship.columns, (ship.designMass + dm) / RHO);
  const y0 = ship.pos.y;
  ship.setStaticLoad([{ mass: dm, local: ship.designCg.clone() }]);
  const ys = [];
  for (let i = 0; i < 40 / dt; i++) {
    ship.step(dt);
    ys.push(ship.pos.y);
  }
  const sinkage = y0 - meanOver(ys, 5);
  const err = Math.abs(sinkage - hPred) / hPred;
  check('+4 t at design CG: draft deepens by the hydrostatic table amount (within 3 %)', err <= 0.03,
    `table ${(hPred * 1000).toFixed(1)} mm, simulated ${(sinkage * 1000).toFixed(1)} mm, error ${(err * 100).toFixed(2)} %`);
}

// ---- 2. no pose jump: 0 -> 8 t step, on a heeled, turning hull
{
  const ship = newShip();
  ship.quat.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, -1).applyQuaternion(ship.quat), 4 * DEG));
  ship.prevQuat.copy(ship.quat);
  ship.angVel.set(0.05, 0.12, -0.08);
  ship.vel.set(0.3, 0, -1.2);
  const cols = ship.columns;
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const c = cols[Math.floor((i * cols.length) / 6)];
    pts.push(new THREE.Vector3(c.x, c.bottom, c.z), new THREE.Vector3(c.x, c.top, c.z));
  }
  const world = (p, pos, quat, cg) => p.clone().sub(cg).applyQuaternion(quat).add(pos);
  const cg0 = ship.cg.clone();
  const before = pts.map((p) => world(p, ship.pos, ship.quat, ship.cg));
  const beforePrev = pts.map((p) => world(p, ship.prevPos, ship.prevQuat, ship.cg));
  ship.setStaticLoad([{ mass: 8000, local: new THREE.Vector3(0.4, 1.0, -2.0) }]);
  const after = pts.map((p) => world(p, ship.pos, ship.quat, ship.cg));
  const afterPrev = pts.map((p) => world(p, ship.prevPos, ship.prevQuat, ship.cg));
  let worst = 0;
  for (let i = 0; i < pts.length; i++) worst = Math.max(worst, before[i].distanceTo(after[i]), beforePrev[i].distanceTo(afterPrev[i]));
  const moved = ship.cg.distanceTo(cg0);
  check('0 -> 8 t step: hull points keep their world positions (1e-9)', worst <= 1e-9 && moved > 1e-3,
    `worst ${worst.toExponential(2)} m, CG moved ${moved.toFixed(4)} m`);
}

// ---- 3. static heel from 500 kg at x = +1 m equals the same mass on payload
{
  const P = new THREE.Vector3(1.0, MERCHANT.mass.cgY, MERCHANT.mass.cgZ);
  const A = newShip({ static: [{ mass: 500, local: P.clone() }] }, 60);
  const B = newShip({ payload: [{ mass: 500, local: P.clone() }] }, 60);
  const xa = [], xb = [];
  for (let i = 0; i < 5 / dt; i++) {
    A.step(dt);
    xa.push(A.heel);
    B.step(dt);
    xb.push(B.heel);
  }
  const ha = meanOver(xa, 5), hb = meanOver(xb, 5);
  const err = Math.abs(ha - hb) / Math.abs(hb);
  check('500 kg at x = +1: static heel equals the payload heel (within 2 %)', err <= 0.02 && Math.abs(hb) > 1e-4,
    `static ${(ha / DEG).toFixed(4)} deg, payload ${(hb / DEG).toFixed(4)} deg, error ${(err * 100).toFixed(2)} %`);
}

// ---- 4. bad load tables throw and change nothing
{
  const ship = newShip();
  const before = { mass: ship.mass, cg: ship.cg.clone(), inertia: ship.inertia.clone(), pos: ship.pos.clone() };
  let threw = false;
  try {
    ship.setStaticLoad([{ mass: -0.7 * ship.designMass, local: ship.designCg.clone() }]);
  } catch {
    threw = true;
  }
  check('mass under 0.4 of design throws, state unchanged',
    threw && ship.mass === before.mass && ship.cg.equals(before.cg) && ship.pos.equals(before.pos));
  threw = false;
  try {
    ship.setStaticLoad([{ mass: -0.55 * ship.designMass, local: new THREE.Vector3(0, ship.designCg.y, -14) }]);
  } catch {
    threw = true;
  }
  check('inertia under 0.3 of design throws, state unchanged',
    threw && ship.mass === before.mass && ship.inertia.equals(before.inertia));
}

// ---- 5. full-order rowing speed after 60 s, loads 0, 4, 8, 12 t
const speeds = LOADS_T.map((t) => rowSpeedAt60(t));
check('full-order rowing speed after 60 s falls with load (0, 4, 8, 12 t)',
  speeds.every((v, i) => i === 0 || v < speeds[i - 1]),
  speeds.map((v) => `${(v * KN).toFixed(3)} kn`).join(', '));

// ---- report: KG, GM and roll period per load (no target)
console.log('\nload t | KG m  | GM formula m | GM from 500 kg heel m | roll period s | speed at 60 s kn');
LOADS_T.forEach((t, i) => {
  const ship = newShip({ static: cargoAtCg(t) });
  const { KG, GM } = stability(ship);
  const heelShip = newShip({
    static: [...cargoAtCg(t), { mass: 500, local: new THREE.Vector3(1.0, MERCHANT.mass.cgY, MERCHANT.mass.cgZ) }],
  }, 60);
  const xs = [];
  for (let k = 0; k < 5 / dt; k++) {
    heelShip.step(dt);
    xs.push(heelShip.heel);
  }
  // sin(heel) = (500 kg / M) / GM for a 1 m lateral offset of the mass
  const gmHeel = (500 / heelShip.mass) / Math.sin(Math.abs(meanOver(xs, 5)));
  const T = rollPeriod(newShip({ static: cargoAtCg(t) }));
  console.log(`${String(t).padStart(6)} | ${KG.toFixed(3)} | ${GM.toFixed(3).padStart(12)} | ${gmHeel.toFixed(3).padStart(21)} | ${T.toFixed(2).padStart(13)} | ${(speeds[i] * KN).toFixed(3)}`);
});

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall cargo physics checks passed');
process.exitCode = failures ? 1 : 0;
