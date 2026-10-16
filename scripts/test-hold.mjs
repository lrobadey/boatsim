// Cargo hold on the merchant (cargo-trade spec §5.3, §6.1, §13 T2), and the docked restore (§11).
//   node scripts/test-hold.mjs
// Capacity, stowage (purity, fill order, trim), the start manifest's composite CG, KG/GM/roll period at
// 0, 4, 8 and 12 t of wine stowed by the hold, and restoreDocked with a 10 s hold in calm water.
import './register-ts.mjs';
import assert from 'node:assert/strict';
const THREE = await import('three');
const { Crew } = await import('../src/ship/crew.ts');
const { ShipPhysics } = await import('../src/ship/physics.ts');
const { Wind } = await import('../src/world/wind.ts');
const { WaveField } = await import('../src/world/waves.ts');
const { MERCHANT } = await import('../src/ship/design.ts');
const { Hold } = await import('../src/cargo/hold.ts');

const dt = 1 / 120;
const RHO = 1025;
const DEG = Math.PI / 180;
const terrain = { heightAt: () => -6, normalAt: (x, z, o) => o.set(0, 1, 0) };
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const flat = () => {
  const w = new WaveField(new Wind(0));
  w.waves.length = 0;
  return w;
};
const calmAir = () => ({ vx: 0, vz: 0 });
const designCg = () => new THREE.Vector3(0, MERCHANT.mass.cgY, MERCHANT.mass.cgZ);

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`);
  if (!ok) failures++;
}

const hold = new Hold(MERCHANT);
const FULL_JARS = Math.floor(hold.capacity / 0.075 + 1e-9);
const WINE = { wine: 0 };
const jarsOf = (n) => ({ wine: n });
const GOOD = { wine: { mass: 42, stow: 0.075 }, wheat: { mass: 40, stow: 0.065 } };

// design LCB (z) from the hull's displaced volume at the design waterline
const cols = MERCHANT.hull.buildColumns(MERCHANT.columns.stations, MERCHANT.columns.strips);
let vSum = 0, zSum = 0;
for (const c of cols) {
  const v = c.area * Math.max(0, -c.bottom);
  vSum += v;
  zSum += v * c.z;
}
const LCB = zSum / vSum;

/** mass-weighted centre of a stowage */
function compositeOf(stowed) {
  let m = 0;
  const p = new THREE.Vector3();
  for (const sc of stowed) {
    m += sc.mass;
    p.addScaledVector(new THREE.Vector3(sc.cell.x, sc.cell.y, sc.cell.z), sc.mass);
  }
  return m > 0 ? p.divideScalar(m) : null;
}

// ---- T2 capacity
{
  const wineFit = hold.capacity / GOOD.wine.stow;
  const wheatT = (hold.capacity / GOOD.wheat.stow * GOOD.wheat.mass) / 1000;
  console.log(`hold: ${hold.cells.length} cells, ${hold.capacity.toFixed(2)} m³; wine ${wineFit.toFixed(1)} jars; wheat ${wheatT.toFixed(2)} t by volume`);
  check('wine capacity 267 ± 15 jars', Math.abs(wineFit - 267) <= 15, `${wineFit.toFixed(1)} jars`);
  check('wheat by volume about 12 t (± 1 t)', Math.abs(wheatT - 12) <= 1, `${wheatT.toFixed(2)} t`);
  check('overflow throws', (() => { try { hold.stow({ wine: Math.ceil(wineFit) + 5 }); return false; } catch { return true; } })());
}

// ---- T2 stowage is pure, fills low first, and is trim-balanced
{
  const a = JSON.stringify(hold.stow({ wine: 70, wheat: 30 }).map((c) => [c.mass, c.parts]));
  const b = JSON.stringify(hold.stow({ wine: 70, wheat: 30 }).map((c) => [c.mass, c.parts]));
  check('stowage is a pure function of the manifest', a === b);

  // low first: the filled cells form a prefix of the fill order
  let prefixOk = true;
  for (const n of [20, 120, 200]) {
    const st = hold.stow(jarsOf(n));
    const filled = st.map((c) => c.mass > 0);
    const firstEmpty = filled.indexOf(false);
    if (firstEmpty >= 0 && filled.slice(firstEmpty).some(Boolean)) prefixOk = false;
  }
  check('fill order is low first (filled cells form a prefix)', prefixOk);

  // trim: CG z of fills up to 85 % of capacity within 0.15 m of the design LCB (§6.1, §13 T2)
  const cap85 = Math.floor(0.85 * hold.capacity / GOOD.wine.stow);
  const fills = [10, 40, 80, 120, 160, 200, cap85];
  const zs = fills.map((n) => compositeOf(hold.stow(jarsOf(n))).z);
  const worst = Math.max(...zs.map((z) => Math.abs(z - LCB)));
  check('fills up to 85 % of capacity: CG z within 0.15 m of the design LCB', worst <= 0.15,
    `LCB z ${LCB.toFixed(3)}, fills ${fills.map((n, i) => `${n}: ${zs[i].toFixed(3)}`).join(', ')}, worst ${worst.toFixed(3)} m`);
  const full = compositeOf(hold.stow(jarsOf(FULL_JARS))).z;
  console.log(`info: full hold (${FULL_JARS} jars) cargo CG z ${full.toFixed(3)}, ${(full - LCB).toFixed(3)} m from the LCB (not asserted, §6.1)`);
}

// ---- T2 start manifest: composite CG within 0.05 m of the design CG
{
  const ship = new ShipPhysics(flat(), calmAir(), terrain, new Crew(), MERCHANT);
  ship.setStaticLoad(hold.staticLoad(jarsOf(70)));
  const d = ship.cg.distanceTo(designCg());
  check('start manifest {wine: 70}: composite CG within 0.05 m of the design CG', d <= 0.05,
    `cg ${ship.cg.toArray().map((v) => v.toFixed(3)).join(' ')} vs design ${designCg().toArray().map((v) => v.toFixed(3)).join(' ')}, ${d.toFixed(3)} m, mass ${ship.mass.toFixed(0)} kg`);
}

// ---- stability of the stowed hold at 0, 4, 8, 12 t of wine
function waterlineFor(columns, vol) {
  const volAt = (h) => columns.reduce((v, c) => v + c.area * clamp(h - c.bottom, 0, c.top - c.bottom), 0);
  let lo = -5, hi = 5;
  for (let i = 0; i < 100; i++) {
    const m = (lo + hi) / 2;
    if (volAt(m) < vol) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}
function stability(ship) {
  const c = ship.columns;
  const keel = Math.min(...c.map((x) => x.bottom));
  const h = waterlineFor(c, ship.mass / RHO);
  let V = 0, mom = 0, IT = 0;
  for (const x of c) {
    if (x.bottom >= h) continue;
    const w = Math.min(h, x.top);
    V += x.area * (w - x.bottom);
    mom += (x.area * (w * w - x.bottom * x.bottom)) / 2;
    if (h < x.top) IT += x.area * x.x * x.x;
  }
  const KG = ship.cg.y - keel;
  return { KG, GM: mom / V - keel + IT / V - KG };
}
function rollPeriod(ship) {
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.quat);
  ship.quat.premultiply(new THREE.Quaternion().setFromAxisAngle(fwd, 3 * DEG));
  ship.prevQuat.copy(ship.quat);
  const xs = [];
  for (let i = 0; i < 30 / dt; i++) {
    ship.step(dt);
    xs.push(ship.heel);
  }
  const mean = xs.slice(-600).reduce((a, b) => a + b, 0) / 600;
  const ups = [];
  for (let i = 1; i < xs.length && ups.length < 5; i++) {
    const a = xs[i - 1] - mean, b = xs[i] - mean;
    if (a < 0 && b >= 0) ups.push(i - 1 + -a / (b - a));
  }
  return ups.length < 2 ? NaN : ((ups[ups.length - 1] - ups[0]) / (ups.length - 1)) * dt;
}
function loadedShip(items, seconds = 20) {
  const ship = new ShipPhysics(flat(), calmAir(), terrain, new Crew(), MERCHANT);
  ship.place(0, 0, 0);
  ship.setStaticLoad(items);
  for (let i = 0; i < seconds / dt; i++) ship.step(dt);
  ship.vel.set(0, 0, 0);
  ship.angVel.set(0, 0, 0);
  return ship;
}
// 12 t of wine (286 jars, 21.4 m³) is over the hold's volume, so the last row is the hold's full load
console.log('\nwine jars (t) | KG m  | GM formula m | GM from 500 kg heel m | roll period s | cargo CG z m');
for (const jars of [0, 95, 190, FULL_JARS]) {
  const t = (jars * GOOD.wine.mass) / 1000;
  const items = hold.staticLoad(jarsOf(jars));
  const ship = loadedShip(items);
  const { KG, GM } = stability(ship);
  const heelShip = loadedShip([...items, { mass: 500, local: new THREE.Vector3(1.0, MERCHANT.mass.cgY, MERCHANT.mass.cgZ) }], 60);
  const xs = [];
  for (let k = 0; k < 5 / dt; k++) {
    heelShip.step(dt);
    xs.push(heelShip.heel);
  }
  const phi = xs.slice(-600).reduce((a, b) => a + b, 0) / 600;
  const gmHeel = (500 / heelShip.mass) / Math.sin(Math.abs(phi));
  const T = rollPeriod(loadedShip(items));
  const cz = compositeOf(hold.stow(jarsOf(jars)))?.z ?? NaN;
  console.log(`${String(jars).padStart(4)} (${t.toFixed(1).padStart(4)}) | ${KG.toFixed(3)} | ${GM.toFixed(3).padStart(12)} | ${gmHeel.toFixed(3).padStart(21)} | ${T.toFixed(2).padStart(13)} | ${cz.toFixed(3)}`);
}

// ---- cargo visuals (geometry only, no renderer): instance counts, bounds and determinism
{
  const { CargoVisual } = await import('../src/cargo/cargoVisual.ts');
  const { QuayStack } = await import('../src/cargo/quayStack.ts');
  const visual = new CargoVisual(hold, MERCHANT);
  visual.update(hold.stow({ wine: 1 }), { wine: 1 });
  check('cargo visual: one physical wine package is exactly one visible amphora', visual.visibleCounts.wine === 1 && visual.placements.length === 1);
  visual.update(hold.stow({ honey: 1 }), { honey: 1 });
  check('cargo visual: one physical honey package is exactly one visible jar', visual.visibleCounts.honey === 1 && visual.placements.length === 1);
  // instance matrices of every look, as numbers: equal after a rebuild from the same stowage
  const snap = () => visual.group.children.filter((m) => m.isInstancedMesh).map((m) => Array.from(m.instanceMatrix.array.slice(0, m.count * 16)));
  const cases = [
    ['empty hold', hold.stow({})],
    ['70 wine', hold.stow({ wine: 70 })],
    ['full hold of wheat', hold.stow({ wheat: Math.floor(hold.capacity / 0.065) })],
  ];
  const seen = {};
  for (const [name, st] of cases) {
    visual.update(st);
    const c = { ...visual.instanceCounts };
    const first = JSON.stringify(snap());
    visual.update(st);
    const again = { ...visual.instanceCounts };
    const same = first === JSON.stringify(snap());
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    const bounded = Object.values(c).every((n) => n >= 0 && n <= 400);
    seen[name] = c;
    check(`cargo visual, ${name}: counts bounded and matrices deterministic`, bounded && same && JSON.stringify(c) === JSON.stringify(again),
      `amphora ${c.amphora}, jar ${c.jar}, sack ${c.sack}, bundle ${c.bundle}, total ${total}`);
  }
  check('cargo visual: empty hold has no package instances', Object.values(seen['empty hold']).every((n) => n === 0));
  check('cargo visual: 70 wine draws some amphorae, no sacks', seen['70 wine'].amphora > 0 && seen['70 wine'].sack === 0 && seen['70 wine'].bundle === 0);
  check('cargo visual: full hold of wheat draws sacks', seen['full hold of wheat'].sack > 0 && seen['full hold of wheat'].amphora === 0);

  // quay stack: two halves for 70 wine on a synthetic berth, cleared when empty
  const berth = { id: 0, name: 'b', cx: 36, cz: 6, ax: 1, az: 0, nx: 0, nz: 1, length: 48, top: 1.8, face: 3, bollards: [] };
  const qs = new QuayStack();
  const solids = qs.update(berth, { shoreWorld: new THREE.Vector3(36, 1.8, 3.5) }, { wine: 70 }, []);
  const qCount = qs.group.children.reduce((a, m) => a + (m.count ?? 0), 0);
  check('quay stack: 70 wine on the quay, one solid per non-empty half', qCount === 70 && solids.length === 2 && solids.every((b) => b.walkTop === false),
    `units ${qCount}, solids ${solids.length}`);
  const cleared = qs.update(null, null, {}, []);
  check('quay stack: cleared with no berth or an empty quay', cleared.length === 0 && qs.group.children.every((m) => (m.count ?? 0) === 0));
}

// ---- restoreDocked: a synthetic harbour, as test-mooring builds it
{
  const TOP = 1.8;
  const pierBox = { kind: 'box', cx: 30, cz: 0, hx: 30, hz: 3, rot: 0, y0: -8, y1: TOP, surface: 'stone', walkTop: true };
  const bollards = [21, 36, 51].map((x) => new THREE.Vector3(x, TOP, 2.3));
  const berth = { id: 0, name: 'Mole, south side', cx: 36, cz: 6, ax: 1, az: 0, nx: 0, nz: 1, length: 48, top: TOP, face: 3, bollards };
  const layout = {
    root: new THREE.Vector2(0, 0), dir: new THREE.Vector2(1, 0), length: 60, width: 6, top: TOP, berthStart: 12,
    berths: [berth], solids: [pierBox], shipColliders: [{ ...pierBox, walkTop: false }], steps: new THREE.Vector3(58, -0.9, 0),
  };
  const ship = new ShipPhysics(flat(), calmAir(), terrain, new Crew(), MERCHANT);
  ship.mooring.setHarbours([layout]);
  const pose = ship.mooring.berthPose(berth, { x: 0, z: 0 });
  const heading = Math.PI / 2; // bow seaward (+x)
  ship.place(pose.x, pose.z, heading);
  ship.mooring.restoreDocked(berth, true);
  const atRestore = ship.mooring.drain();
  const events = [];
  for (let i = 0; i < 10 / dt; i++) {
    ship.step(dt);
    events.push(...ship.mooring.drain());
  }
  const ref = ship.refPoint(new THREE.Vector3());
  const drift = Math.hypot(ref.x - pose.x, ref.z - pose.z);
  const m = ship.mooring;
  check('restoreDocked: stays docked for 10 s', m.linePhase === 'docked', m.linePhase);
  check('restoreDocked: drift under 0.3 m', drift < 0.3, `${drift.toFixed(3)} m`);
  check('restoreDocked: no events', atRestore.length === 0 && events.length === 0, JSON.stringify([...atRestore, ...events]));
  check('restoreDocked: four lines attached, plank fully out on the quay side',
    m.lines.length === 4 && m.plank && m.plank.deployed === 1 && m.approach && m.plank.side === m.approach.side,
    `lines ${m.lines.length}, plank ${m.plank?.deployed}, side ${m.plank?.side}`);
  const shimmed = new ShipPhysics(flat(), calmAir(), terrain, new Crew(), MERCHANT);
  shimmed.mooring.setHarbour(layout);
  check('setHarbour wrapper still sets one harbour', shimmed.mooring.shipColliders.length === 1);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall hold checks passed');
process.exitCode = failures ? 1 : 0;
