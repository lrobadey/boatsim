import './register-ts.mjs';
// Walker collision with the agent crew (docs/merchant-crew-spec.md §9.8, E10).
// node scripts/test-crew-solids.mjs
import assert from 'node:assert/strict';
const { WalkGeometry } = await import('../src/world/walkable.ts');
const { Crew } = await import('../src/ship/crew.ts');
const { ShipPhysics } = await import('../src/ship/physics.ts');
const { Wind } = await import('../src/world/wind.ts');
const { WaveField } = await import('../src/world/waves.ts');
const { MERCHANT } = await import('../src/ship/design.ts');
const { CrewSolids } = await import('../src/crew/crewSolids.ts');

const dt = 1 / 120, FULL = 4, STOP = 1;
const RADIUS = 0.3, HEIGHT = 1.75, STEP_UP = 0.45; // walker.ts constants
const WALK_SPEED = 1.2; // m/s
const REPLAN = 0.25, LIMIT_S = 60, GRID = 0.05, XB = 1.3;
const hull = MERCHANT.hull;

const flat = () => { const w = new WaveField(new Wind(0)); w.waves.length = 0; return w; };
const terrain = { heightAt: () => -100, normalAt: (x, z, out) => out.set(0, 1, 0) };

/** ship-local deck height at z: the deck of the nearest hull station */
function deckAtZ(z) {
  let best = 0, bd = Infinity;
  for (let i = 0; i <= 400; i++) {
    const s = i / 400, d = Math.abs(hull.zOf(s) - z);
    if (d < bd) { bd = d; best = s; }
  }
  return MERCHANT.deck.deckY(best);
}

const sBow = 0.12, sStern = 0.84;
const zBow = hull.zOf(sBow), zStern = hull.zOf(sStern);
const crewP = MERCHANT.oars.crew;

/** a fresh merchant at rest with its own crew solids (loom boxes off by default), rowing at Full after 10 s */
function rig(opts) {
  const ship = new ShipPhysics(flat(), { vx: 0, vz: 0 }, terrain, new Crew(), MERCHANT);
  ship.place(0, 0, 0);
  for (let i = 0; i < 240; i++) ship.step(dt);
  ship.vel.set(0, 0, 0); ship.angVel.set(0, 0, 0);
  const geo = new WalkGeometry(null); // only the crew solids
  const solids = new CrewSolids(geo, MERCHANT, opts);
  const r = { ship, geo, solids, maxDyn: 0 };
  r.step = () => {
    ship.step(dt);
    solids.update(ship.rowing.crewView, ship.rowing);
    r.maxDyn = Math.max(r.maxDyn, geo.dynamic.length);
  };
  ship.crew.setOrder(FULL);
  for (let i = 0; i < Math.round(10 / dt); i++) r.step();
  return r;
}

/** the walker's feet level and clearance test at (x, z), for a walker of radius rad */
const scratch = { x: 0, z: 0 };
function overlaps(geo, x, z, rad) {
  const y = deckAtZ(z);
  return geo.collide(x, z, rad, y, y + HEIGHT, STEP_UP, scratch);
}

/** distance from (x, z) to a solid's surface (negative inside) */
function surfaceDist(s, x, z) {
  if (s.kind === 'cyl') return Math.hypot(x - s.cx, z - s.cz) - s.r;
  const c = Math.cos(s.rot), sn = Math.sin(s.rot);
  const dx = x - s.cx, dz = z - s.cz;
  const u = dx * c - dz * sn, v = dx * sn + dz * c;
  const qu = Math.max(Math.abs(u) - s.hx, 0), qv = Math.max(Math.abs(v) - s.hz, 0);
  return Math.hypot(qu, qv) || -Math.min(s.hx - Math.abs(u), s.hz - Math.abs(v));
}
/** clearance of a walker of radius RADIUS at (x, z) to the nearest solid, m (the gap) */
function gapAt(geo, x, z) {
  let g = Infinity;
  for (const s of geo.dynamic) g = Math.min(g, surfaceDist(s, x, z) - RADIUS);
  return g;
}

/**
 * Grid A* over the deck at the instant the solids are frozen. Cells are free when a walker of radius rad fits there.
 * Returns the path as points from the start cell to the first cell at or beyond zStern, or null.
 */
function plan(geo, x0, z0, rad) {
  const nx = Math.round((2 * XB) / GRID) + 1, zLo = zBow - 0.4, zHi = zStern + 0.4;
  const nz = Math.ceil((zHi - zLo) / GRID) + 1;
  const X = (i) => -XB + i * GRID, Z = (j) => zLo + j * GRID;
  const N = nx * nz, free = new Uint8Array(N);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) free[j * nx + i] = overlaps(geo, X(i), Z(j), rad) ? 0 : 1;
  const si = Math.min(nx - 1, Math.max(0, Math.round((x0 + XB) / GRID)));
  const sj = Math.min(nz - 1, Math.max(0, Math.round((z0 - zLo) / GRID)));
  const start = sj * nx + si;
  const g = new Float64Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const open = new Set([start]);
  g[start] = 0;
  const h = (c) => Math.max(0, zStern - (zLo + Math.floor(c / nx) * GRID));
  let goal = -1;
  while (open.size) {
    let c = -1, best = Infinity;
    for (const o of open) { const f = g[o] + h(o); if (f < best) { best = f; c = o; } }
    open.delete(c);
    if (closed[c]) continue;
    closed[c] = 1;
    if (zLo + Math.floor(c / nx) * GRID >= zStern) { goal = c; break; }
    const ci = c % nx, cj = Math.floor(c / nx);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
      const n = nj * nx + ni;
      if (closed[n] || !free[n]) continue;
      const ng = g[c] + Math.hypot(di, dj) * GRID;
      if (ng < g[n]) { g[n] = ng; came[n] = c; open.add(n); }
    }
  }
  if (goal < 0) return null;
  const path = [];
  for (let c = goal; c >= 0; c = came[c]) path.push({ x: X(c % nx), z: zLo + Math.floor(c / nx) * GRID });
  return path.reverse();
}

/** the widest walker radius (up to RADIUS) for which the frozen solids leave a path from (x0, z0) */
function widestPassage(geo, x0, z0) {
  let lo = 0, hi = RADIUS;
  if (!plan(geo, x0, z0, 0.02)) return 0;
  for (let k = 0; k < 9; k++) {
    const mid = (lo + hi) / 2;
    if (plan(geo, x0, z0, mid)) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * A walker agent goes bow to stern: replans every 0.25 s against the frozen solids, follows the path at
 * WALK_SPEED, waits in place when no path exists. Push-out keeps it out of the solids every frame.
 */
function walk(r) {
  const { geo } = r;
  const w = { x: 0, z: zBow };
  let waits = 0, tunnels = 0, arrived = null, replans = 0, noPath = 0, narrowest = Infinity, stuckAt = null;
  let path = null, pi = 0;
  const limit = Math.round(LIMIT_S / dt);
  for (let i = 0; i < limit && arrived === null; i++) {
    r.step();
    if (i % Math.round(REPLAN / dt) === 0) {
      replans++;
      path = plan(geo, w.x, w.z, RADIUS);
      pi = 1;
      if (!path) { noPath++; stuckAt = { z: w.z }; }
      else for (const p of path) narrowest = Math.min(narrowest, gapAt(geo, p.x, p.z));
    }
    let moved = false;
    if (path && pi < path.length) {
      const q = path[pi];
      const dx = q.x - w.x, dz = q.z - w.z, d = Math.hypot(dx, dz);
      const step = Math.min(WALK_SPEED * dt, d);
      if (d > 1e-9) { w.x += (dx / d) * step; w.z += (dz / d) * step; moved = true; }
      if (d < 0.02) pi++;
    }
    if (!moved) waits++;
    if (overlaps(geo, w.x, w.z, RADIUS)) { w.x = scratch.x; w.z = scratch.z; }
    for (const b of geo.dynamic) if (b.kind === 'box' && geo.inside(b, w.x, w.z, 0)) tunnels++;
    if (w.z >= zStern) arrived = i * dt;
  }
  return { arrived, waits, tunnels, replans, noPath, narrowest, z: w.z, x: w.x, stuckAt, geo };
}

const failures = [];
function check(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { failures.push(name); console.error('FAIL', name, '\n  ', e.message); }
}

// ----- (a) default (loom boxes off): an A* walker reaches the stern within 60 s, never inside a box
const def = rig();
const a = walk(def);
console.log('  (a) walker, looms off:', {
  arrivedAt: a.arrived === null ? null : +a.arrived.toFixed(1), waits: a.waits, replans: a.replans, noPathReplans: a.noPath,
  tunnels: a.tunnels, narrowestGapCm: Number.isFinite(a.narrowest) ? Math.round(a.narrowest * 100) : null, z: +a.z.toFixed(2),
});
check('(a) default: A* walker reaches the stern within 60 s while the crew rows Full (looms off)', () => {
  assert.ok(a.arrived !== null, `did not arrive; stopped at z=${a.z.toFixed(2)} (stern ${zStern.toFixed(2)})`);
});
check('(a) default: walker is never inside a box', () => {
  assert.equal(a.tunnels, 0, `${a.tunnels} frames inside a box`);
});
check('(a) default: no loom boxes are placed', () => {
  assert.equal(def.geo.dynamic.filter((s) => s.kind === 'box').length, 0);
});

// ----- (a2) loom boxes on: log arrival or the blocked station and widest gap; assert no tunnelling only
const loom = rig({ loomSolids: true });
const a2 = walk(loom);
console.log('  (a2) walker, looms on:', {
  arrivedAt: a2.arrived === null ? null : +a2.arrived.toFixed(1), waits: a2.waits, replans: a2.replans, noPathReplans: a2.noPath,
  tunnels: a2.tunnels, narrowestGapCm: Number.isFinite(a2.narrowest) ? Math.round(a2.narrowest * 100) : null, z: +a2.z.toFixed(2),
});
if (a2.arrived === null) {
  // the widest walker that could leave the stuck point, over 60 s of phases (frozen solids every 0.5 s)
  let best = 0, bestAt = 0;
  for (let i = 0; i < Math.round(LIMIT_S / dt); i++) {
    loom.step();
    if (i % Math.round(0.5 / dt) === 0) { const wp = widestPassage(loom.geo, a2.x, a2.stuckAt.z); if (wp > best) { best = wp; bestAt = i * dt; } }
  }
  let nearest = -1, bd = Infinity;
  crewP.stations.forEach((st, k) => { const z = hull.zOf(st.s) - 0.6, d = Math.abs(z - a2.stuckAt.z); if (d < bd) { bd = d; nearest = k; } });
  const st = crewP.stations[nearest];
  console.log(`  (a2) BLOCKED: stuck at z=${a2.stuckAt.z.toFixed(2)}; nearest station ${nearest} (side ${st.side}, s ${st.s}); widest gap ${Math.round(2 * best * 100)} cm at t=${bestAt.toFixed(1)} s vs 60 cm`);
}
check('(a2) looms on: walker is never inside a box', () => {
  assert.equal(a2.tunnels, 0, `${a2.tunnels} frames inside a box`);
});

// ----- (d) dynamic array bound, on the default crew
check('(d) dynamic array never exceeds 14 entries', () => {
  for (let i = 0; i < Math.round(5 / dt); i++) def.step();
  assert.ok(def.maxDyn <= 14, `max ${def.maxDyn}`);
  assert.ok(def.maxDyn >= 6, `expected the six rowing hands to register, max ${def.maxDyn}`);
});

// ----- (b) a point at the stance centre is pushed out to the cylinder radius
check('(b) looms off: a point at the stance centre is pushed out to at least the 0.35 m cylinder radius', () => {
  const views = def.ship.rowing.crewView;
  const hand = views.find((m) => (m.mode === 'row' || m.mode === 'hold') && m.oar >= 0);
  assert.ok(hand, 'a rowing hand');
  const k = hand.oar;
  const sx = MERCHANT.crewSpots[k][1], sz = hull.zOf(MERCHANT.crewSpots[k][2]);
  const out = { x: sx, z: sz };
  const y = MERCHANT.deck.deckY(MERCHANT.crewSpots[k][2]);
  const hit = def.geo.collide(sx, sz, RADIUS, y, y + HEIGHT, STEP_UP, out);
  assert.ok(hit, 'stance centre is blocked');
  const d = Math.hypot(out.x - sx, out.z - sz);
  assert.ok(d >= 0.35, `pushed to ${d.toFixed(3)} m, need >= 0.35`);
});

// ----- (c) after shipping the oars the boxes and stance cylinders are gone
check('(c) after shipping the oars the boxes and stance cylinders are gone', () => {
  def.ship.crew.setOrder(STOP);
  def.ship.rowing.setShipped(-1, true);
  def.ship.rowing.setShipped(1, true);
  for (let i = 0; i < Math.round(20 / dt); i++) def.step();
  const modes = def.ship.rowing.crewView.map((m) => m.mode);
  const boxes = def.geo.dynamic.filter((s) => s.kind === 'box').length;
  console.log('  modes after shipping:', modes.join(' '), '| boxes:', boxes);
  assert.equal(boxes, 0, `${boxes} boxes remain`);
  assert.ok(!def.geo.dynamic.some((s) => s.kind === 'cyl' && s.r === 0.35), 'stance cylinders remain');
});

if (failures.length) { console.error(`${failures.length} failed`); process.exit(1); }
console.log('all crew solids checks passed');
