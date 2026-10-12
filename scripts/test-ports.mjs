// Ports: worldgen harbours (docs/cargo-trade-spec.md §3.1, §4.3, §13 T3).
//   node scripts/test-ports.mjs --record   write scripts/golden/worldgen-1729.json from the current worldgen
//   node scripts/test-ports.mjs            check the current worldgen against that file and the T3 rules
import './register-ts.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { Wind } = await import('../src/world/wind.ts');

const RECORD = process.argv.includes('--record');
const GOLDEN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden', 'worldgen-1729.json');
const WORLD = 12000;
const VEG_DENSITY = 0.7; // quality.ts medium
const SIZE = 2048; // quality.ts medium

// the worker is a module that talks through the global self; one holder serves every call
const holder = { postMessage() {}, onmessage: null };
globalThis.self = holder;
await import('../src/world/worldgen.worker.ts');

/** run the worldgen worker in this process; returns the result and the wall time (ms) */
function generateWorld(seed, size = SIZE, vegetationDensity = VEG_DENSITY) {
  let result = null;
  holder.postMessage = (m) => { if (m.type === 'done') result = m.result; };
  const windFrom = new Wind(3).baseFrom;
  const t0 = performance.now();
  holder.onmessage({ data: { seed, size, worldSize: WORLD, windFrom, vegetationDensity } });
  const ms = performance.now() - t0;
  assert.ok(result, `worldgen produced no result for seed ${seed}`);
  return { gen: result, ms };
}

const hashBytes = (view) => crypto.createHash('sha256').update(Buffer.from(view.buffer, view.byteOffset, view.byteLength)).digest('hex');

/** sha256 of the heights above 0.5 m: index (u32) and value (f32) per cell, in index order */
function hashLandHeights(H) {
  let count = 0;
  for (let k = 0; k < H.length; k++) if (H[k] > 0.5) count++;
  const buf = Buffer.alloc(count * 8);
  let o = 0;
  for (let k = 0; k < H.length; k++) {
    if (!(H[k] > 0.5)) continue;
    buf.writeUInt32LE(k, o);
    buf.writeFloatLE(H[k], o + 4);
    o += 8;
  }
  return { count, hash: crypto.createHash('sha256').update(buf).digest('hex') };
}

/** the pre-existing, non-harbour-specific fields of a world (what must not change for harbour 0) */
function snapshotOf(gen) {
  const s = gen.sites;
  return {
    islands: gen.islands.map((I) => ({ id: I.id, name: I.name, cx: I.cx, cz: I.cz, area: I.area, peak: I.peak, peakX: I.peakX, peakZ: I.peakZ })),
    sites: { harbour: s.harbour, shore: s.shore, temple: s.temple, houses: s.houses, pier: s.pier, start: s.start },
  };
}

function hashesOf(gen) {
  const land = hashLandHeights(gen.heights);
  return {
    landCells: land.count,
    heightsLand: land.hash,
    vegCount: gen.vegetation.length / 6,
    vegetation: hashBytes(gen.vegetation),
    ao: hashBytes(gen.ao),
    aoSize: gen.aoSize,
  };
}

if (RECORD) {
  const { gen, ms } = generateWorld(1729);
  const golden = {
    note: 'Worldgen snapshot for seed 1729 at heightmap 2048, worldSize 12000, default wind, vegetation 0.7. Written by test-ports.mjs --record BEFORE the harbour change. Compared by scripts/test-ports.mjs. Timings are wall times on the recording machine.',
    request: { seed: 1729, size: SIZE, worldSize: WORLD, windFrom: new Wind(3).baseFrom, vegetationDensity: VEG_DENSITY },
    timings: { worldgenMs: Math.round(ms), bakeMs: Math.round(gen.seaState.ms) },
    ...snapshotOf(gen),
    hashes: hashesOf(gen),
  };
  fs.writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 1) + '\n');
  console.log(`wrote ${GOLDEN_PATH}`);
  console.log(JSON.stringify({ timings: golden.timings, hashes: golden.hashes, islands: golden.islands.slice(0, 4).map((I) => [I.id, I.name, Math.round(I.area)]), harbour: golden.sites.harbour, houses: golden.sites.houses.length }, null, 2));
}

// ---------------------------------------------------------------- checks against the recorded baseline
if (!RECORD) {
  const { GOODS } = await import('../src/trade/goods.ts');
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  let failures = 0;
  const report = {};
  const test = (name, fn) => {
    try { fn(); console.log('PASS', name); }
    catch (e) { failures++; console.error('FAIL', name, '\n  ', e.message.split('\n').slice(0, 6).join('\n   ')); }
  };
  const roundTrip = (v) => JSON.parse(JSON.stringify(v));

  const { gen, ms } = generateWorld(1729);
  const cur = snapshotOf(gen);
  const sites = gen.sites;
  const harbours = sites.harbours;
  const N = gen.size, S = gen.worldSize;
  const cell = S / N, half = S / 2;
  const heightAt = (x, z) => {
    const fx = (x + half) / cell - 0.5, fz = (z + half) / cell - 0.5;
    const i = Math.max(0, Math.min(N - 2, Math.floor(fx))), j = Math.max(0, Math.min(N - 2, Math.floor(fz)));
    const tx = Math.min(1, Math.max(0, fx - i)), tz = Math.min(1, Math.max(0, fz - j));
    const H = gen.heights, k = j * N + i;
    return (H[k] * (1 - tx) + H[k + 1] * tx) * (1 - tz) + (H[k + N] * (1 - tx) + H[k + N + 1] * tx) * tz;
  };

  report.worldgen = { ms: Math.round(ms), golden: golden.timings.worldgenMs, bakeMs: Math.round(gen.seaState.ms), goldenBakeMs: golden.timings.bakeMs };
  report.harbours = harbours.map((h) => ({ id: h.id, island: h.island, name: h.name, x: Math.round(h.harbour.x), z: Math.round(h.harbour.z), houses: h.houses.length, detail: h.detail, profile: { houses: h.profile.houses, area: Math.round(h.profile.area) } }));

  test('T3 snapshot: islands identical to the recorded worldgen', () => {
    assert.deepStrictEqual(roundTrip(cur.islands), golden.islands);
  });
  test('T3 snapshot: harbour 0 and every pre-existing site field identical', () => {
    for (const k of Object.keys(golden.sites)) assert.deepStrictEqual(roundTrip(cur.sites[k]), golden.sites[k], `sites.${k}`);
  });
  test('T3 snapshot: heights above 0.5 m identical', () => {
    assert.equal(hashLandHeights(gen.heights).hash, golden.hashes.heightsLand);
  });
  test('T3 harbours: 3 on seed 1729, mirrored into the flat site fields', () => {
    assert.equal(harbours.length, 3, `got ${harbours.length}`);
    const h0 = harbours[0];
    assert.equal(h0.id, 0);
    assert.deepStrictEqual(h0.harbour, sites.harbour);
    assert.deepStrictEqual(h0.shore, sites.shore);
    assert.deepStrictEqual(h0.pier, sites.pier);
    assert.deepStrictEqual(h0.houses, sites.houses);
    assert.deepStrictEqual(harbours.map((h) => h.detail), [1, 2, 3]);
  });
  test('T3 new berth zones dredged to <= -3.8 m (berth centre and both sides)', () => {
    for (const h of harbours) {
      const p = h.pier, ux = Math.cos(p.angle), uz = Math.sin(p.angle);
      for (let d = p.berthStart; d <= p.length; d += 4)
        for (const lat of [-6, 0, 6]) {
          const x = p.x + ux * d - uz * lat, z = p.z + uz * d + ux * lat;
          assert.ok(heightAt(x, z) <= -3.8 + 1e-3, `harbour ${h.id} berth at d=${d.toFixed(0)} lat=${lat}: ${heightAt(x, z).toFixed(2)} m`);
        }
    }
  });
  test('T3 vegetation: no plant on a new house footprint or inside a new dredge rectangle', () => {
    const V = gen.vegetation;
    for (const h of harbours.slice(1)) {
      for (const hs of h.houses)
        for (let v = 0; v < V.length; v += 6)
          assert.ok(!(Math.abs(V[v] - hs.x) < 9 && Math.abs(V[v + 2] - hs.z) < 9), `plant at ${V[v]},${V[v + 2]} on a house of harbour ${h.id}`);
      const p = h.pier, ux = Math.cos(p.angle), uz = Math.sin(p.angle), lx = -uz, lz = ux;
      for (let v = 0; v < V.length; v += 6) {
        const dx = V[v] - p.x, dz = V[v + 2] - p.z;
        const along = dx * ux + dz * uz, lat = dx * lx + dz * lz;
        assert.ok(!(along >= p.berthStart - 6 && along <= p.length + 14 && Math.abs(lat) <= 18), `plant in the dredge of harbour ${h.id}`);
      }
    }
    report.vegetation = { count: V.length / 6, goldenCount: golden.hashes.vegCount, removed: golden.hashes.vegCount - V.length / 6 };
    assert.ok(V.length / 6 <= golden.hashes.vegCount, 'vegetation grew');
  });
  test('T3 AO: recorded hash (informational: the new dredges change AO near new piers, §3.1)', () => {
    report.aoHashChanged = hashBytes(gen.ao) !== golden.hashes.ao;
  });
  test('T3 timing: bake within the +1.8 s gate over today', () => {
    assert.ok(gen.seaState.ms <= golden.timings.bakeMs + 1800, `bake ${gen.seaState.ms.toFixed(0)} ms vs ${golden.timings.bakeMs} ms`);
  });

  // port profiles (§4.3): r per good and port, with POP_PER_HOUSE = 30 and S_eq = D·bufferDays·r
  const POP_PER_HOUSE = 30;
  const rTable = (hs) => {
    const table = {};
    for (const g of GOODS) {
      const shares = hs.map((h) => h.profile.features[g.id] / h.profile.area);
      const mean = shares.reduce((a, b) => a + b, 0) / shares.length;
      table[g.id] = shares.map((s) => (mean > 0 ? g.base * Math.min(3, Math.max(0.25, Math.pow(s / mean, 1.5))) : g.base));
    }
    return table;
  };
  const rt = rTable(harbours);
  const sEq = {};
  for (const g of GOODS) sEq[g.id] = harbours.map((h, k) => (POP_PER_HOUSE * h.profile.houses) * g.perCapita * g.bufferDays * rt[g.id][k]);
  report.profiles = { houses: harbours.map((h) => h.profile.houses), rTable: Object.fromEntries(Object.entries(rt).map(([k, v]) => [k, v.map((x) => +x.toFixed(2))])), sEqMin: Object.fromEntries(Object.entries(sEq).map(([k, v]) => [k, +Math.min(...v).toFixed(1)])) };
  test('T3 profiles on 1729: every good differs between ports, max r / min r >= 1.1', () => {
    for (const g of GOODS) {
      const max = Math.max(...rt[g.id]), min = Math.min(...rt[g.id]);
      assert.ok(max / min >= 1.1, `${g.id}: r ${rt[g.id].map((r) => r.toFixed(2))}`);
    }
  });
  test('T3 profiles on 1729: no port with S_eq < 10 units of any good', () => {
    for (const g of GOODS) for (const [k, v] of sEq[g.id].entries()) assert.ok(v >= 10, `${g.id} at harbour ${harbours[k].id}: S_eq ${v.toFixed(1)}`);
  });

  test('T3 timing: worldgen without the bake within +0.6 s of the golden', () => {
    const excl = ms - gen.seaState.ms, goldenExcl = golden.timings.worldgenMs - golden.timings.bakeMs;
    report.worldgenExclBake = { ms: Math.round(excl), golden: goldenExcl };
    assert.ok(excl <= goldenExcl + 600, `${excl.toFixed(0)} ms vs golden ${goldenExcl} ms`);
  });

  // ------------------------------------------------ wave 2: stalls and layouts (§8, headless: no WebGL)
  const H = await import('../src/world/harbour.ts');
  const ports = H.portSites(gen);
  test('T3 stalls: one per harbour; each stays on the mole and clears the bollards and dock-life figures', () => {
    assert.equal(ports.length, 3);
    for (const p of ports) {
      const f = H.pierFrame(p.pier), g = H.stallGeometry(f, p.id), hw = f.width / 2;
      const ux = f.ux, uz = f.uz, lx = f.lx, lz = f.lz;
      const sideOf = (x, z) => ((x - f.x0) * lx + (z - f.z0) * lz); // lateral from the axis
      const alongOf = (x, z) => ((x - f.x0) * ux + (z - f.z0) * uz);
      // circles for everything the stall puts on the quay: [x, z, radius]
      const parts = [
        [g.site.x, g.site.z, 0.3, 'figure'],
        ...g.amphorae.map((a, i) => [a.x, a.z, 0.25, 'amphora' + i]),
        ...g.posts.map((a, i) => [a.x, a.z, 0.045, 'post' + i]),
      ];
      for (const [x, z, r, name] of parts) {
        assert.ok(Math.abs(sideOf(x, z)) + r <= hw, `${name} of harbour ${p.id} off the mole (lateral ${sideOf(x, z).toFixed(2)})`);
        assert.ok(alongOf(x, z) >= 4 && alongOf(x, z) <= f.berthStart - 2, `${name} of harbour ${p.id} not on the shore half of the berth (along ${alongOf(x, z).toFixed(1)})`);
      }
      // bench box: 0.8 along the pier and 0.2 across
      assert.ok(Math.abs(sideOf(g.bench.x, g.bench.z)) + 0.2 <= hw, `bench of harbour ${p.id} off the mole`);
      // quay clearances: bollards on both sides, and the dock-life figures at their fixed places
      const fs = g.site.side;
      const at = (a, lat) => ({ x: f.x0 + ux * a + lx * lat, z: f.z0 + uz * a + lz * lat });
      const fixed = [
        [...Object.values(at(7, fs * (hw - 0.6))), 0.6, 'fisher'],
        [...Object.values(at(f.berthStart - 4, fs * 1.8)), 0.3, 'porter'],
        [...Object.values(at(f.mid - 14, fs * (hw - 0.7))), 0.3, 'sailor'],
        ...[-1, 1].flatMap((side) => H.berthBollards(f, side).map((v) => [v.x, v.z, 0.3, 'bollard'])),
      ];
      for (const [x, z, r, name] of fixed) {
        for (const [px, pz, pr, pname] of parts.concat([[g.bench.x, g.bench.z, 0.8, 'bench']])) {
          const d = Math.hypot(x - px, z - pz);
          assert.ok(d >= r + pr, `${pname} of harbour ${p.id} overlaps ${name} (${d.toFixed(2)} m)`);
        }
      }
    }
  });
  test('T3 layouts: buildHarbours gives 3 layouts with global berth ids and port fields; stall solids present', () => {
    const L = H.buildHarbours(gen, null);
    assert.equal(L.length, 3);
    assert.deepEqual(L.map((l) => l.id), [0, 1, 2]);
    const berthIds = L.flatMap((l) => l.berths.map((b) => b.id));
    assert.deepEqual(berthIds, [0, 1, 2, 3, 4, 5]);
    for (const l of L) {
      assert.ok(l.berths.every((b) => b.port === l.id));
      assert.equal(l.stall.side === 1 || l.stall.side === -1, true);
      const posts = l.solids.filter((s) => s.kind === 'cyl' && s.r === H.STALL_POST_R);
      assert.equal(posts.length, 4, `layout ${l.id} posts`);
    }
    assert.equal(H.buildHarbour(gen, null).berths.length, 2);
    report.stalls = L.map((l) => ({ id: l.id, name: l.name, stall: [Math.round(l.stall.x), Math.round(l.stall.z)], side: l.stall.side }));
  });

  // other seeds: 1-3 harbours each, no error
  for (const seed of [1, 42, 777]) {
    test(`T3 seed ${seed}: generates, 1-3 harbours`, () => {
      const { gen: g2, ms: ms2 } = generateWorld(seed);
      const n = g2.sites.harbours.length;
      report[`seed${seed}`] = { harbours: n, names: g2.sites.harbours.map((h) => h.name), worldgenMs: Math.round(ms2), bakeMs: Math.round(g2.seaState.ms) };
      assert.ok(n >= 1 && n <= 3, `harbours ${n}`);
    });
  }

  console.log(JSON.stringify(report, null, 2));
  if (failures) { console.error(`${failures} port test(s) failed`); process.exitCode = 1; }
  else console.log('all port tests passed');
}
