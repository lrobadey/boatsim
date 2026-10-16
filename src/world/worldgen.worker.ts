/// <reference lib="webworker" />
import {prepareHarborGround,inHarborCourt,PLANS,PLAN_FOR_HARBOUR,PLAN_BERTH_CLEARANCE,planPier} from './ormosLayout';
import { createNoise2D } from 'simplex-noise';
import type { WorldGenRequest, WorldGenResult, IslandInfo, Sites, House, HarbourSite, PortProfile } from './worldgenTypes';
import { bakeSeaState, pierMole, seaStateBuffers } from './seaState';

/**
 * Seeded archipelago generator.
 * 1. stochastic island layout (sizes from a power law, rejection-spaced)
 * 2. per-island shape: warped distance field, coast profile that turns to cliffs on coasts facing the
 *    prevailing wind (wave-cut) and to beaches in the lee; ridged mountains; underwater shelves
 * 3. droplet hydraulic erosion on land (gullies, alluvial fans)
 * 4. terrain analysis: islands (connected components + generated names), harbour, temple, village,
 *    pier, vegetation — all chosen by scoring the generated terrain.
 */

function mulberry(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Island {
  x: number;
  z: number;
  r: number;
  rot: number;
  elong: number;
  peak: number;
  sharp: number; // ridge sharpness
  kind: 'main' | 'medium' | 'small' | 'stack';
}

const post = (msg: any, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<WorldGenRequest>) => {
  const req = e.data;
  const res = generate(req, (p, label) => post({ type: 'progress', p, label }));
  post({ type: 'done', result: res }, [res.heights.buffer, res.vegetation.buffer, res.ao.buffer, ...(res.seaState ? seaStateBuffers(res.seaState) : [])]);
};

function generate(req: WorldGenRequest, progress: (p: number, label: string) => void): WorldGenResult {
  const { size: N, worldSize: S, seed } = req;
  const rand = mulberry(seed);
  const n2a = createNoise2D(mulberry(seed * 7 + 1));
  const n2b = createNoise2D(mulberry(seed * 13 + 2));
  const n2c = createNoise2D(mulberry(seed * 17 + 3));
  const half = S / 2;
  const cell = S / N;
  const windFrom = req.windFrom;
  // unit vector pointing toward where the wind comes FROM (world xz)
  const wfx = Math.sin(windFrom);
  const wfz = -Math.cos(windFrom);

  const fbm = (x: number, z: number, oct: number, noise = n2a) => {
    let a = 0,
      amp = 0.5,
      f = 1;
    for (let i = 0; i < oct; i++) {
      a += amp * noise(x * f, z * f);
      f *= 2.03;
      amp *= 0.5;
    }
    return a;
  };
  const ridged = (x: number, z: number, oct: number) => {
    let a = 0,
      amp = 0.5,
      f = 1,
      w = 1;
    for (let i = 0; i < oct; i++) {
      let n = 1 - Math.abs(n2b(x * f, z * f));
      n *= n;
      a += n * amp * w;
      w = Math.min(1, n * 2);
      f *= 2.1;
      amp *= 0.5;
    }
    return a;
  };

  /** vegetation moisture (the expression the planting uses), for the port profiles (§3.1, §4.3) */
  const moistAt = (x: number, z: number) => 0.5 + 0.5 * n2a(x / 700, z / 700) + 0.2 * n2c(x / 150, z / 150);

  // ---------- 1. island layout ----------
  progress(0.02, 'Placing islands');
  const islands: Island[] = [];
  const bound = half * 0.78;
  const tryPlace = (r: number, kind: Island['kind'], minGap: number, tries = 400) => {
    for (let t = 0; t < tries; t++) {
      const x = (rand() * 2 - 1) * (bound - r * 0.6);
      const z = (rand() * 2 - 1) * (bound - r * 0.6);
      let ok = true;
      for (const o of islands) {
        const d = Math.hypot(o.x - x, o.z - z);
        if (d < (o.r + r) * minGap) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const peak =
        kind === 'stack' ? 18 + rand() * 45 : kind === 'small' ? r * (0.12 + rand() * 0.18) : r * (0.11 + rand() * 0.1);
      const isl: Island = {
        x,
        z,
        r,
        rot: rand() * Math.PI,
        elong: kind === 'stack' ? 1 : 1 + rand() * (kind === 'main' ? 0.6 : 1.2),
        peak: Math.min(peak, 460),
        sharp: 0.5 + rand() * 0.5,
        kind,
      };
      islands.push(isl);
      return isl;
    }
    return null;
  };
  // main island near-ish the centre so the player starts somewhere interesting
  const main = tryPlace(1700 + rand() * 400, 'main', 1.2, 1)!;
  main.x = (rand() - 0.5) * 1200;
  main.z = (rand() - 0.5) * 1200 - 900;
  const nMedium = 2 + Math.floor(rand() * 2);
  for (let i = 0; i < nMedium; i++) tryPlace(650 + rand() * 450, 'medium', 1.35);
  const nSmall = 4 + Math.floor(rand() * 3);
  for (let i = 0; i < nSmall; i++) tryPlace(170 + rand() * 280, 'small', 1.6);
  // clusters of sea stacks ("teeth")
  const nClusters = 2;
  for (let c = 0; c < nClusters; c++) {
    const anchor = tryPlace(90, 'stack', 3);
    if (!anchor) continue;
    for (let i = 0; i < 5 + Math.floor(rand() * 4); i++) {
      const a = rand() * Math.PI * 2;
      const d = 80 + rand() * 260;
      islands.push({ x: anchor.x + Math.cos(a) * d, z: anchor.z + Math.sin(a) * d, r: 25 + rand() * 60, rot: rand() * 3, elong: 1 + rand(), peak: 10 + rand() * 40, sharp: 1, kind: 'stack' });
    }
  }

  // ---------- 2. height field ----------
  progress(0.05, 'Building terrain');
  const H = new Float32Array(N * N);
  const isl = islands.map((i) => ({ ...i, cr: Math.cos(-i.rot), sr: Math.sin(-i.rot), reach: i.r * i.elong * 2.6 }));

  const heightAt = (x: number, z: number): number => {
    // sea floor
    let h = -58 + 14 * fbm(x / 5200, z / 5200, 3, n2c);
    for (const I of isl) {
      const dx = x - I.x,
        dz = z - I.z;
      if (Math.abs(dx) > I.reach || Math.abs(dz) > I.reach) continue;
      const lx = dx * I.cr - dz * I.sr;
      const lz = dx * I.sr + dz * I.cr;
      const u = lx / (I.r * I.elong);
      const v = (lz * I.elong) / I.r;
      let d = Math.sqrt(u * u + v * v);
      if (d > 2.6) continue;
      // coastline warp: bays & headlands at several scales
      const ws = I.r * 0.55;
      d += 0.3 * fbm(x / ws + I.x, z / ws, 4, n2a) + 0.08 * n2c(x / (ws * 0.25), z / (ws * 0.25));
      // wind exposure of this part of the coast: 1 = faces the wind (cliffs), -1 = lee (beaches)
      const len = Math.hypot(dx, dz) + 1e-3;
      const expo = (dx * wfx + dz * wfz) / len;
      const cliff = Math.min(1, Math.max(0, 0.5 + 0.6 * expo + 0.35 * n2b(x / 900, z / 900)));
      let hi: number;
      if (d < 1) {
        const t = 1 - d; // 0 at coast -> 1 at centre
        // coast profile: concave (gentle, beaches) in the lee, straighter where exposed
        const p = 1.55 - 0.55 * cliff;
        const base = Math.pow(t, p);
        // ridged mountains with valleys; ridge strength grows inland
        // one or two main ridgelines per island (low frequency), with secondary spurs
        const rid = ridged(x / (I.r * 1.35) + I.x * 0.001, z / (I.r * 1.35), 5);
        const spur = ridged(x / (I.r * 0.45), z / (I.r * 0.45), 3);
        const valleys = 0.6 + 0.4 * fbm(x / (I.r * 0.6), z / (I.r * 0.6), 3, n2c);
        const detail = 0.05 * fbm(x / 90, z / 90, 4, n2c);
        const mount = base * (0.28 + 0.8 * rid * I.sharp * valleys + 0.18 * spur * t) + detail * Math.min(1, t * 5);
        hi = I.peak * mount;
        // wave-cut cliff on exposed coasts: a steep face whose height varies along the coast
        const cliffH = Math.min(I.peak * 0.22, 14 + 30 * (0.5 + 0.5 * n2a(x / 350, z / 350))) * cliff * cliff;
        hi += cliffH * smoothstep(0.0, 0.012 + 0.01 * (1 - cliff), t);
        // beaches: flatten the first metres in the lee
        hi = Math.max(hi, 0.4 + 2.2 * smoothstep(0, 0.05, t) * (1 - cliff));
      } else {
        const t = d - 1;
        // shelf: shallow sandy apron wider in the lee; drops faster below cliffs
        const shelfW = 0.18 + 0.35 * (1 - cliff);
        hi = -0.3 - 9 * smoothstep(0, shelfW, t) - 55 * smoothstep(shelfW * 0.8, shelfW + 1.2, t);
        hi += 1.5 * n2c(x / 60, z / 60) * Math.max(0, 1 - t * 2);
      }
      if (hi > h) h = hi;
    }
    return h;
  };

  for (let j = 0; j < N; j++) {
    const z = -half + (j + 0.5) * cell;
    for (let i = 0; i < N; i++) {
      H[j * N + i] = heightAt(-half + (i + 0.5) * cell, z);
    }
    if ((j & 63) === 0) progress(0.05 + 0.45 * (j / N), 'Building terrain');
  }

  // ---------- 3. hydraulic erosion (droplets) ----------
  progress(0.5, 'Eroding terrain');
  erode(H, N, cell, mulberry(seed + 99), Math.floor(N * N * 0.03),(p) => progress(0.5 + 0.25 * p, 'Eroding terrain'));

  // ---------- 4. analysis ----------
  progress(0.76, 'Finding the harbour');
  const sample = (x: number, z: number) => {
    const fx = (x + half) / cell - 0.5;
    const fz = (z + half) / cell - 0.5;
    const i = Math.max(0, Math.min(N - 2, Math.floor(fx)));
    const j = Math.max(0, Math.min(N - 2, Math.floor(fz)));
    const tx = Math.min(1, Math.max(0, fx - i));
    const tz = Math.min(1, Math.max(0, fz - j));
    const a = H[j * N + i],
      b = H[j * N + i + 1],
      c = H[(j + 1) * N + i],
      d = H[(j + 1) * N + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  };
  const slopeAt = (x: number, z: number) => {
    const e = cell;
    const gx = (sample(x + e, z) - sample(x - e, z)) / (2 * e);
    const gz = (sample(x, z + e) - sample(x, z - e)) / (2 * e);
    return Math.hypot(gx, gz);
  };

  // islands via connected components on a coarse grid
  const G = 256;
  const gc = S / G;
  const lab = new Int32Array(G * G).fill(-1);
  const infos: IslandInfo[] = [];
  const names = makeNames(mulberry(seed + 5));
  for (let j = 0; j < G; j++)
    for (let i = 0; i < G; i++) {
      const idx = j * G + i;
      if (lab[idx] !== -1) continue;
      const x = -half + (i + 0.5) * gc,
        z = -half + (j + 0.5) * gc;
      if (sample(x, z) <= 0.5) continue;
      const id = infos.length;
      const stack = [idx];
      lab[idx] = id;
      let cnt = 0,
        sx = 0,
        sz = 0,
        maxH = 0,
        px = 0,
        pz = 0;
      while (stack.length) {
        const k = stack.pop()!;
        const ki = k % G,
          kj = (k / G) | 0;
        const kx = -half + (ki + 0.5) * gc,
          kz = -half + (kj + 0.5) * gc;
        const hh = sample(kx, kz);
        cnt++;
        sx += kx;
        sz += kz;
        if (hh > maxH) {
          maxH = hh;
          px = kx;
          pz = kz;
        }
        for (const [di, dj] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const ni = ki + di,
            nj = kj + dj;
          if (ni < 0 || nj < 0 || ni >= G || nj >= G) continue;
          const nk = nj * G + ni;
          if (lab[nk] !== -1) continue;
          if (sample(-half + (ni + 0.5) * gc, -half + (nj + 0.5) * gc) <= 0.5) continue;
          lab[nk] = id;
          stack.push(nk);
        }
      }
      infos.push({ id, name: '', cx: sx / cnt, cz: sz / cnt, area: cnt * gc * gc, peak: maxH, peakX: px, peakZ: pz });
    }
  infos.sort((a, b) => b.area - a.area);
  infos.forEach((I, k) => (I.name = I.area > 40000 ? names[k % names.length] : ''));
  const mainIsland = infos[0];

  // --- harbour: sheltered, navigable water next to gentle land, on the main island, away from the wind ---
  const RAYS = 24;
  const rayLand = (x: number, z: number, a: number, maxD: number) => {
    const dx = Math.cos(a),
      dz = Math.sin(a);
    for (let d = 30; d < maxD; d += 30) if (sample(x + dx * d, z + dz * d) > 0) return d;
    return -1;
  };
  /** lim.open: the open-run and nearest-land limits apply (off for the fallback). island: the nearest land must
   *  belong to that island (a `lab` id, §3.1 step 2); null = no island rule (the main harbour). */
  const scoreSite = (x: number, z: number, lim: { open: boolean; maxRun: number; maxD: number }, island: number | null): { score: number; openA: number } | null => {
    const h = sample(x, z);
    if (h > -4 || h < -18) return null;
    let enclosed = 0,
      windExposed = 0,
      bestOpenRun = 0,
      run = 0,
      runStart = 0,
      openCenter = 0,
      minD = 1e9,
      nearA = -1;
    const hits: number[] = [];
    for (let k = 0; k < RAYS; k++) {
      const a = (k / RAYS) * Math.PI * 2;
      const d = rayLand(x, z, a, 1400);
      hits.push(d);
      if (d > 0) {
        enclosed += 1 - d / 1400;
        if (d < minD) {
          minD = d;
          nearA = a;
        }
      } else {
        // open to the sea in this direction: bad if that is where the wind/waves come from
        const ex = Math.cos(a) * wfx + Math.sin(a) * wfz;
        windExposed += Math.max(0, ex);
      }
    }
    // navigable entrance: longest run of open rays
    for (let k = 0; k < RAYS * 2; k++) {
      if (hits[k % RAYS] < 0) {
        if (run === 0) runStart = k;
        run++;
        if (run > bestOpenRun) {
          bestOpenRun = run;
          openCenter = runStart + run / 2;
        }
      } else run = 0;
    }
    if (!(minD < 1400)) return null; // no land along any ray
    if (island !== null && islandAt(x + Math.cos(nearA) * minD, z + Math.sin(nearA) * minD) !== island) return null;
    if (lim.open && (bestOpenRun < 2 || bestOpenRun > lim.maxRun || minD > lim.maxD || minD < 60)) return null;
    // gentle land to build on nearby
    let gentle = 0;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const lx = x + Math.cos(a) * (minD + 120),
        lz = z + Math.sin(a) * (minD + 120);
      const lh = sample(lx, lz);
      if (lh > 1 && lh < 60 && slopeAt(lx, lz) < 0.3) gentle++;
    }
    const score = enclosed * 1.0 - windExposed * 1.6 + gentle * 0.6 - Math.abs(h + 9) * 0.05;
    return { score, openA: (openCenter / RAYS) * Math.PI * 2 };
  };
  /** the `lab` id of the land at (x, z): the cell's own label, else the first labelled 8-neighbour; -1 = none (§3.1) */
  const islandAt = (x: number, z: number): number => {
    const ci = Math.floor((x + half) / gc), cj = Math.floor((z + half) / gc);
    if (ci < 0 || cj < 0 || ci >= G || cj >= G) return -1;
    if (lab[cj * G + ci] !== -1) return lab[cj * G + ci];
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        const i = ci + di, j = cj + dj;
        if ((di === 0 && dj === 0) || i < 0 || j < 0 || i >= G || j >= G) continue;
        if (lab[j * G + i] !== -1) return lab[j * G + i];
      }
    return -1;
  };
  let best = { score: -1e9, x: 0, z: 0, openA: 0 };
  const hstep = 45;
  const mainLim = { open: true, maxRun: RAYS * 0.6, maxD: 450 };
  for (let z = mainIsland.cz - 3200; z < mainIsland.cz + 3200; z += hstep)
    for (let x = mainIsland.cx - 3200; x < mainIsland.cx + 3200; x += hstep) {
      const r = scoreSite(x, z, mainLim, null);
      if (r && r.score > best.score) best = { score: r.score, x, z, openA: r.openA };
    }
  const harbour = { x: best.x, z: best.z, openAngle: best.openA };

  /** shore point and mole of a harbour, and the dredge of its berth zone (§3.1 step 3) */
  const buildPier = (hb: { x: number; z: number; openAngle: number }) => {
    // shore point: nearest land toward the inside of the bay (opposite of the opening)
    let shore = { x: hb.x, z: hb.z };
    {
      let bd = 1e9;
      for (let k = 0; k < 72; k++) {
        const a = (k / 72) * Math.PI * 2;
        const d = rayLand(hb.x, hb.z, a, 900);
        if (d > 0 && d < bd) {
          bd = d;
          shore = { x: hb.x + Math.cos(a) * d, z: hb.z + Math.sin(a) * d };
        }
      }
    }
    // mole axis from the shore to the harbour; the berth zone is dredged (see the dredge below)
    const pdx = hb.x - shore.x,
      pdz = hb.z - shore.z;
    const plen = Math.hypot(pdx, pdz);
    const ux = pdx / plen,
      uz = pdz / plen; // shore -> sea
    const lx = -uz,
      lz = ux; // lateral
    const at = (d: number, lat: number) => sample(shore.x + ux * d + lx * lat, shore.z + uz * d + lz * lat);
    // d0: first point along the axis where the seabed is 3 m deep on the centre line and 9 m either side
    let d0 = plen;
    for (let d = 0; d <= plen; d += 1)
      if (at(d, 0) <= -3 && at(d, 9) <= -3 && at(d, -9) <= -3) {
        d0 = d;
        break;
      }
    // berth zone [d0, d0 + 48], pier max 170 m; land beyond shortens the mole but keeps 40 m of berth
    let L = Math.min(d0 + 48, 170);
    if (L < d0 + 40) L = d0 + 40;
    for (let d = d0; d <= L; d += 2)
      if (at(d, 0) > -1.5) {
        L = Math.max(d0 + 40, d);
        break;
      }
    // dredge: H = min(H, -3.8) over [d0 - 6, L + 14] x ±18 m, smooth falloff over the next 14 m. Never raises.
    const DREDGE = -3.8;
    const a0 = d0 - 6,
      a1 = L + 14;
    for (let j = 0; j < N; j++) {
      const z = -half + (j + 0.5) * cell;
      for (let i = 0; i < N; i++) {
        const x = -half + (i + 0.5) * cell;
        const dx = x - shore.x,
          dz = z - shore.z;
        const along = dx * ux + dz * uz,
          lat = dx * lx + dz * lz;
        const out = Math.hypot(Math.max(0, a0 - along, along - a1), Math.max(0, Math.abs(lat) - 18));
        const w = 1 - smoothstep(0, 14, out);
        if (w <= 0) continue;
        const k = j * N + i;
        // only the seabed is dug out: beaches and cliffs beside the mole keep their shape
        H[k] += (Math.min(H[k], DREDGE) - H[k]) * w * (1 - smoothstep(-1.5, 0.5, H[k]));
      }
    }
    const pier = { x: shore.x, z: shore.z, angle: Math.atan2(uz, ux), length: L, width: 6, top: 1.8, berthStart: d0 };
    // the dredge rectangle in the mole's frame (§3.1 step 5 filters vegetation out of it)
    return { shore, pier, rect: { sx: shore.x, sz: shore.z, ux, uz, lx, lz, a0, a1 } };
  };

  // --- temple: prominent, near the harbour, with a sea view, reasonably flat ---
  progress(0.82, 'Placing the temple');
  let tb = { score: -1e9, x: 0, z: 0, h: 0 };
  for (let z = harbour.z - 1800; z < harbour.z + 1800; z += 24)
    for (let x = harbour.x - 1800; x < harbour.x + 1800; x += 24) {
      const h = sample(x, z);
      if (h < 25 || h > 220) continue;
      const sl = slopeAt(x, z);
      if (sl > 0.45) continue;
      let ring = 0;
      let seaView = 0;
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        ring += sample(x + Math.cos(a) * 220, z + Math.sin(a) * 220);
        if (sample(x + Math.cos(a) * 500, z + Math.sin(a) * 500) < 0) seaView++;
      }
      const prominence = h - ring / 12;
      const dH = Math.hypot(x - harbour.x, z - harbour.z);
      const score = prominence * 0.9 + seaView * 6 - sl * 60 - dH * 0.02 + Math.min(h, 90) * 0.15;
      if (score > tb.score) tb = { score, x, z, h };
    }
  // flatten the temple platform into the heightmap (it is part of the physical world)
  flatten(H, N, cell, half, tb.x, tb.z, 34, 58, tb.h);

  // --- pier: a mole from the shore into the harbour, its berth zone dredged to working depth.
  // Runs before the village, the start and vegetation so they all sample the dredged heights.
  const { shore, pier } = buildPier(harbour);
  if(req.authoredHarbour)prepareHarborGround(H,N,S,pier);

  // --- village: houses on gentle slopes around the harbour shore, density falling off with distance ---
  progress(0.86, 'Building the village');
  const houses: House[] = [];
  const vr = mulberry(seed + 31);
  for (let t = 0; t < 9000 && houses.length < 140; t++) {
    const a = vr() * Math.PI * 2;
    const d = Math.pow(vr(), 0.7) * 650;
    const x = shore.x + Math.cos(a) * d,
      z = shore.z + Math.sin(a) * d;
    if (req.authoredHarbour && inHarborCourt(pier,x,z,15)) continue;
    const h = sample(x, z);
    if (h < 2.2 || h > 70) continue;
    const sl = slopeAt(x, z);
    if (sl > 0.42) continue;
    if (Math.hypot(x - tb.x, z - tb.z) < 60) continue;
    if (vr() > Math.exp(-d / 320)) continue;
    const w = 4 + vr() * 5,
      l = 5 + vr() * 6;
    let clash = false;
    for (const o of houses) if (Math.hypot(o.x - x, o.z - z) < (Math.max(w, l) + Math.max(o.w, o.l)) * 0.62) { clash = true; break; }
    if (clash) continue;
    // face downhill (toward the sea)
    const gx = sample(x + 3, z) - sample(x - 3, z);
    const gz = sample(x, z + 3) - sample(x, z - 3);
    const rot = Math.atan2(-gx, -gz);
    // base = lowest ground under the footprint so the house never floats
    let minH = h;
    for (const [ox, oz] of [[-w / 2, -l / 2], [w / 2, -l / 2], [-w / 2, l / 2], [w / 2, l / 2]]) minH = Math.min(minH, sample(x + ox, z + oz));
    houses.push({ x, z, y: minH, w, l, hgt: 3 + vr() * 2.5 + (vr() < 0.25 ? 3 : 0), rot, maxY: Math.max(h, minH) });
  }

  // --- player start: out through the harbour mouth, facing in ---
  const oa = harbour.openAngle;
  let sd = 700;
  for (; sd < 1600; sd += 50) {
    const sx = harbour.x + Math.cos(oa) * sd,
      sz = harbour.z + Math.sin(oa) * sd;
    let clear = true;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      if (sample(sx + Math.cos(a) * 90, sz + Math.sin(a) * 90) > -3) clear = false;
    }
    if (clear) break;
  }
  const start = {
    x: harbour.x + Math.cos(oa) * sd,
    z: harbour.z + Math.sin(oa) * sd,
    // heading = compass bearing toward the harbour
    heading: Math.atan2(harbour.x - (harbour.x + Math.cos(oa) * sd), -(harbour.z - (harbour.z + Math.sin(oa) * sd))),
  };

  // --- vegetation by biome rules ---
  progress(0.9, 'Planting vegetation');
  const veg: number[] = []; // x, y, z, scale, rot, type
  const pr = mulberry(seed + 77);
  const dens = req.vegetationDensity;
  const vstep = 9 / Math.sqrt(dens);
  for (let z = -half; z < half; z += vstep)
    for (let x = -half; x < half; x += vstep) {
      const jx = x + (pr() - 0.5) * vstep,
        jz = z + (pr() - 0.5) * vstep;
      if(req.authoredHarbour && inHarborCourt(pier,jx,jz,8))continue;
      const h = sample(jx, jz);
      if (h < 2.5) continue;
      const sl = slopeAt(jx, jz);
      const moist = 0.5 + 0.5 * n2a(jx / 700, jz / 700) + 0.2 * n2c(jx / 150, jz / 150);
      // wind exposure: ground whose slope faces the prevailing wind is drier/more barren
      const gx = sample(jx + cell, jz) - sample(jx - cell, jz);
      const gz = sample(jx, jz + cell) - sample(jx, jz - cell);
      const gl = Math.hypot(gx, gz) + 1e-4;
      const faceWind = -(gx * wfx + gz * wfz) / gl; // slope faces toward the wind
      const shelter = 1 - Math.max(0, faceWind) * Math.min(1, sl * 3);
      const dVill = Math.hypot(jx - shore.x, jz - shore.z);
      const nearVillage = Math.exp(-dVill / 500);
      const nearTemple = Math.exp(-Math.hypot(jx - tb.x, jz - tb.z) / 120);
      if (Math.hypot(jx - tb.x, jz - tb.z) < 34) continue;
      let onHouse = false;
      if (dVill < 800) for (const o of houses) if (Math.abs(o.x - jx) < 9 && Math.abs(o.z - jz) < 9) { onHouse = true; break; }
      if (onHouse) continue;
      const r = pr();
      const altF = Math.max(0, 1 - h / 380);
      // olive groves: gentle, low, near the village, moist-ish
      const pOlive = (sl < 0.28 ? 1 : 0) * (h < 160 ? 1 : 0) * (0.03 + 0.5 * nearVillage) * (0.4 + moist) * shelter;
      // cypress: moist sheltered pockets, clusters, and planted around the temple/village
      const pCyp = (sl < 0.5 ? 1 : 0) * (0.02 + 0.2 * Math.max(0, moist - 0.55) + 0.35 * nearTemple + 0.05 * nearVillage) * shelter * altF;
      // aleppo pine: coastal slopes up to mid altitude
      const pPine = (sl < 0.7 ? 1 : 0) * (h < 220 ? 1 : 0) * 0.06 * Math.max(0, moist - 0.35) * shelter;
      // maquis scrub everywhere reasonable
      const pBush = (sl < 0.85 ? 1 : 0) * (0.14 + 0.2 * moist) * (0.4 + 0.6 * shelter) * (0.3 + 0.7 * altF);
      // boulders on steep or high ground
      const pRock = Math.min(0.5, Math.max(0, sl - 0.35) * 0.9 + (h > 250 ? 0.08 : 0) + 0.01);
      const total = pOlive + pCyp + pPine + pBush + pRock;
      if (r > Math.min(0.95, total)) continue;
      let pick = pr() * total;
      let type = 3;
      if ((pick -= pOlive) < 0) type = 1;
      else if ((pick -= pCyp) < 0) type = 0;
      else if ((pick -= pPine) < 0) type = 4;
      else if ((pick -= pBush) < 0) type = 2;
      else type = 3;
      const sc = type === 0 ? 0.7 + pr() * 0.6 : type === 3 ? 0.4 + pr() * 1.8 : 0.6 + pr() * 0.8;
      veg.push(jx, sample(jx, jz), jz, sc, pr() * Math.PI * 2, type);
    }

  // --- other harbours (§3.1 steps 1-5): after vegetation, before the AO bake. Searches first, then piers,
  // villages and the vegetation filter; no draws from the existing RNG streams.
  progress(0.93, 'Finding the other harbours');
  const cands: number[] = []; // island indices, area order
  for (let i = 1; i < infos.length && cands.length < 2; i++) if (infos[i].name !== '' && infos[i].area >= 1.0e6) cands.push(i);
  const placed: { x: number; z: number }[] = [harbour];
  const found: { island: number; harbour: { x: number; z: number; openAngle: number } }[] = [];
  for (const i of cands) {
    const I = infos[i];
    const hw = 2.6 * Math.sqrt(I.area / Math.PI) + 600;
    // strict limits first; if no point passes, the fallback drops the open-run and nearest-land limits
    for (const strict of [true, false]) {
      const lim = { open: strict, maxRun: RAYS * 0.75, maxD: 600 };
      let pick: { score: number; x: number; z: number; openA: number } | null = null;
      for (let z = I.cz - hw; z < I.cz + hw; z += 45)
        for (let x = I.cx - hw; x < I.cx + hw; x += 45) {
          if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < 1500)) continue;
          const r = scoreSite(x, z, lim, I.id);
          if (r && (!pick || r.score > pick.score)) pick = { score: r.score, x, z, openA: r.openA };
        }
      if (pick) {
        found.push({ island: i, harbour: { x: pick.x, z: pick.z, openAngle: pick.openA } });
        placed.push(pick);
        break;
      }
    }
  }
  const piers = found.map((f) => buildPier(f.harbour));
  // authored courts of the other harbours (harbour id k + 1), graded before their villages sample the ground
  // a plan fitted to one world applies only there, and only if its quay face leaves the berths clear
  const courts = piers.map((pr, k) => {
    const name = PLAN_FOR_HARBOUR[k + 1];
    const plan = req.authoredHarbour && name ? PLANS[name] : undefined;
    if (!plan || (plan.world && (plan.world.seed !== seed || plan.world.size !== N))) return null;
    if (pr.pier.berthStart < (plan.origin ?? 0) + PLAN_BERTH_CLEARANCE) return null;
    return { name, pier: planPier(pr.pier, plan), court: plan.court };
  });
  for (const c of courts) if (c) prepareHarborGround(H, N, S, c.pier, c.court);

  // village of a new harbour (§3.1 step 4): the main village's placement rules, no temple
  const villageAt = (rng: () => number, c: { x: number; z: number }, radius: number, maxHouses: number, keepOut: ((x: number, z: number) => boolean) | null = null) => {
    const out: House[] = [];
    for (let t = 0; t < 9000 && out.length < maxHouses; t++) {
      const a = rng() * Math.PI * 2;
      const d = Math.pow(rng(), 0.7) * radius;
      const x = c.x + Math.cos(a) * d,
        z = c.z + Math.sin(a) * d;
      const h = sample(x, z);
      if (h < 2.2 || h > 70) continue;
      if (keepOut?.(x, z)) continue;
      const sl = slopeAt(x, z);
      if (sl > 0.42) continue;
      if (rng() > Math.exp(-d / 320)) continue;
      const w = 4 + rng() * 5,
        l = 5 + rng() * 6;
      let clash = false;
      for (const o of out) if (Math.hypot(o.x - x, o.z - z) < (Math.max(w, l) + Math.max(o.w, o.l)) * 0.62) { clash = true; break; }
      if (clash) continue;
      // face downhill (toward the sea)
      const gx = sample(x + 3, z) - sample(x - 3, z);
      const gz = sample(x, z + 3) - sample(x, z - 3);
      const rot = Math.atan2(-gx, -gz);
      // base = lowest ground under the footprint so the house never floats
      let minH = h;
      for (const [ox, oz] of [[-w / 2, -l / 2], [w / 2, -l / 2], [-w / 2, l / 2], [w / 2, l / 2]]) minH = Math.min(minH, sample(x + ox, z + oz));
      out.push({ x, z, y: minH, w, l, hgt: 3 + rng() * 2.5 + (rng() < 0.25 ? 3 : 0), rot, maxY: Math.max(h, minH) });
    }
    return out;
  };
  const villages = found.map((f, k) => {
    const ar = infos[f.island].area / mainIsland.area;
    const maxHouses = Math.min(140, Math.max(12, Math.round(140 * Math.pow(ar, 0.8))));
    const c = courts[k];
    return villageAt(mulberry(seed + 31 + 1000 * (k + 1)), piers[k].shore, 650 * Math.pow(ar, 0.4), maxHouses, c ? (x, z) => inHarborCourt(c.pier, x, z, 15, c.court) : null);
  });

  // vegetation filter (§3.1 step 5): drop plants on the new house footprints (same rule as the main village)
  // and inside the new dredge rectangles. Filter only: no draws from the vegetation RNG.
  {
    const newHouses = villages.flat();
    if (newHouses.length || piers.length || courts.some(Boolean)) {
      let o = 0;
      for (let v = 0; v < veg.length; v += 6) {
        const vx = veg[v],
          vz = veg[v + 2];
        let drop = newHouses.some((hs) => Math.abs(hs.x - vx) < 9 && Math.abs(hs.z - vz) < 9);
        for (const c of courts) if (!drop && c && inHarborCourt(c.pier, vx, vz, 8, c.court)) drop = true;
        for (const p of piers) {
          if (drop) break;
          const r = p.rect;
          const dx = vx - r.sx,
            dz = vz - r.sz;
          const along = dx * r.ux + dz * r.uz,
            lat = dx * r.lx + dz * r.lz;
          if (along >= r.a0 && along <= r.a1 && Math.abs(lat) <= 18) drop = true;
        }
        if (drop) continue;
        // plants were placed before the other harbours' dredges and courts changed the ground: put them back on it
        for (let q = 0; q < 6; q++) veg[o++] = veg[v + q];
        if (courts.some(Boolean)) veg[o - 5] = sample(vx, vz);
      }
      veg.length = o;
    }
  }

  // port profiles (§4.3): a fixed 48 m grid over the island's window, land cells of that island only
  const PCELL = 48;
  const profileOf = (I: IslandInfo, houseCount: number): PortProfile => {
    const hw = 2.6 * Math.sqrt(I.area / Math.PI) + 600;
    const nI = Math.ceil((2 * hw) / PCELL);
    const pt = (i: number, j: number): [number, number] => [I.cx - hw + (i + 0.5) * PCELL, I.cz - hw + (j + 0.5) * PCELL];
    const land = new Uint8Array(nI * nI);
    let landCells = 0;
    for (let j = 0; j < nI; j++)
      for (let i = 0; i < nI; i++) {
        const [x, z] = pt(i, j);
        if (sample(x, z) > 0.5 && islandAt(x, z) === I.id) {
          land[j * nI + i] = 1;
          landCells++;
        }
      }
    const features: PortProfile['features'] = { wine: 0, oil: 0, wheat: 0, almonds: 0, fish: 0, honey: 0, firewood: 0, pitch: 0 };
    const A = PCELL * PCELL;
    for (let j = 0; j < nI; j++)
      for (let i = 0; i < nI; i++) {
        if (!land[j * nI + i]) continue;
        const [x, z] = pt(i, j);
        const h = sample(x, z),
          sl = slopeAt(x, z),
          m = moistAt(x, z);
        if (h > 2 && h < 80 && sl < 0.12) features.wheat += A;
        if (h > 10 && h < 300 && sl > 0.1 && sl < 0.4) features.wine += A * Math.max(0, 1.2 - m);
        if (h > 2 && h < 160 && sl < 0.3) features.oil += A * m;
        if (h > 10 && h < 250 && sl > 0.08 && sl < 0.35) features.almonds += A;
        if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([di, dj]) => sample(x + di * PCELL, z + dj * PCELL) <= 0.5)) features.fish += A;
        if (sl > 0.3 || h > 250) features.honey += A;
        if (h < 220 && sl < 0.7 && m > 0.35) {
          features.firewood += A * (m - 0.35);
          if (h > 60) features.pitch += A * (m - 0.35);
        }
      }
    return { houses: houseCount, area: landCells * A, features };
  };
  const harbourSites: HarbourSite[] = [
    { id: 0, island: 0, name: mainIsland.name, harbour, shore, pier, houses, detail: 1, profile: profileOf(mainIsland, houses.length), ...(req.authoredHarbour ? { plan: 'ormos' as const } : {}) },
    ...found.map((f, k): HarbourSite => ({
      id: k + 1,
      island: f.island,
      name: infos[f.island].name,
      harbour: f.harbour,
      shore: piers[k].shore,
      pier: piers[k].pier,
      houses: villages[k],
      detail: k + 2,
      profile: profileOf(infos[f.island], villages[k].length),
      ...(courts[k] ? { plan: courts[k]!.name } : {}),
    })),
  ];

  // --- ambient occlusion: horizon-based sky visibility on a coarser grid ---
  progress(0.95, 'Baking ambient occlusion');
  const AO = 512;
  const ao = new Uint8Array(AO * AO);
  const ac = S / AO;
  const dirs = 10;
  const dx8: number[] = [],
    dz8: number[] = [];
  for (let k = 0; k < dirs; k++) {
    dx8.push(Math.cos((k / dirs) * Math.PI * 2));
    dz8.push(Math.sin((k / dirs) * Math.PI * 2));
  }
  for (let j = 0; j < AO; j++)
    for (let i = 0; i < AO; i++) {
      const x = -half + (i + 0.5) * ac,
        z = -half + (j + 0.5) * ac;
      const h0 = sample(x, z);
      if (h0 < -25) {
        ao[j * AO + i] = 255;
        continue;
      }
      let vis = 0;
      for (let k = 0; k < dirs; k++) {
        let maxSlope = 0;
        let d = ac * 0.7;
        for (let st = 0; st < 9; st++) {
          const hh = sample(x + dx8[k] * d, z + dz8[k] * d);
          maxSlope = Math.max(maxSlope, (hh - h0) / d);
          d *= 1.7;
        }
        // cosine-weighted visible sky above the horizon elevation
        const elev = Math.atan(maxSlope);
        vis += 1 - Math.sin(elev);
      }
      ao[j * AO + i] = Math.round(Math.max(0, Math.min(1, vis / dirs)) * 255);
    }

  // sea state (docs/sea-state-spec.md §3): fetch, wind shelter and swell exposure per direction, on the
  // world grid and a 4 m grid over 512 m around the harbour that includes the mole
  progress(0.97, 'Mapping sea shelter');
  // one detail region per harbour, main first (spec §3.1 step 6)
  const seaState = bakeSeaState({
    heights: H,
    N,
    worldSize: S,
    detail: harbourSites.map((hs) => {
      const p = hs.pier;
      const mid = { x: p.x + Math.cos(p.angle) * p.length * 0.5, z: p.z + Math.sin(p.angle) * p.length * 0.5 };
      return { cx: mid.x, cz: mid.z, size: 512, n: 128, moles: [pierMole(p)] };
    }),
  });

  progress(0.98, 'Placing the ship');
  const sites: Sites = { harbour, shore, temple: { x: tb.x, z: tb.z, y: tb.h }, houses, pier, start, harbours: harbourSites };
  return { heights: H, size: N, worldSize: S, islands: infos, sites, vegetation: new Float32Array(veg), ao, aoSize: AO, seaState };
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function flatten(H: Float32Array, N: number, cell: number, half: number, cx: number, cz: number, r0: number, r1: number, h: number) {
  const i0 = Math.floor((cx - r1 + half) / cell),
    i1 = Math.ceil((cx + r1 + half) / cell);
  const j0 = Math.floor((cz - r1 + half) / cell),
    j1 = Math.ceil((cz + r1 + half) / cell);
  for (let j = Math.max(0, j0); j <= Math.min(N - 1, j1); j++)
    for (let i = Math.max(0, i0); i <= Math.min(N - 1, i1); i++) {
      const x = -half + (i + 0.5) * cell,
        z = -half + (j + 0.5) * cell;
      const d = Math.hypot(x - cx, z - cz);
      const w = 1 - smoothstep(r0, r1, d);
      const k = j * N + i;
      H[k] = H[k] * (1 - w) + h * w;
    }
}

/** Droplet-based hydraulic erosion, restricted to land (h > 0). */
function erode(H: Float32Array, N: number, cell: number, rand: () => number, drops: number, progress: (p: number) => void) {
  const inertia = 0.06,
    capacityK = 5,
    minSlope = 0.01,
    depositK = 0.3,
    erodeK = 0.35,
    evap = 0.02,
    gravity = 4,
    maxLife = 48;
  const scale = 1 / cell; // heights are metres, positions in cells
  const grad = (px: number, pz: number) => {
    const i = px | 0,
      j = pz | 0;
    const u = px - i,
      v = pz - j;
    const k = j * N + i;
    const a = H[k],
      b = H[k + 1],
      c = H[k + N],
      d = H[k + N + 1];
    return {
      h: a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v,
      gx: ((b - a) * (1 - v) + (d - c) * v) * scale,
      gz: ((c - a) * (1 - u) + (d - b) * u) * scale,
    };
  };
  for (let n = 0; n < drops; n++) {
    let px = 1 + rand() * (N - 3),
      pz = 1 + rand() * (N - 3);
    // rain only matters on land: resample until the droplet starts above the shore
    for (let tries = 0; tries < 30 && H[(pz | 0) * N + (px | 0)] < 3; tries++) {
      px = 1 + rand() * (N - 3);
      pz = 1 + rand() * (N - 3);
    }
    if (H[(pz | 0) * N + (px | 0)] < 3) continue;
    let dx = 0,
      dz = 0,
      speed = 1,
      water = 1,
      sediment = 0;
    for (let life = 0; life < maxLife; life++) {
      const i = px | 0,
        j = pz | 0;
      const u = px - i,
        v = pz - j;
      const g = grad(px, pz);
      dx = dx * inertia - g.gx * (1 - inertia);
      dz = dz * inertia - g.gz * (1 - inertia);
      const len = Math.hypot(dx, dz);
      if (len < 1e-8) break;
      dx /= len;
      dz /= len;
      const nx = px + dx,
        nz = pz + dz;
      if (nx < 1 || nz < 1 || nx > N - 2 || nz > N - 2) break;
      const nh = grad(nx, nz).h;
      const dh = nh - g.h;
      const cap = Math.max(-dh * scale, minSlope) * speed * water * capacityK;
      const k = j * N + i;
      if (sediment > cap || dh > 0) {
        const amt = dh > 0 ? Math.min(dh, sediment) : (sediment - cap) * depositK;
        sediment -= amt;
        H[k] += amt * (1 - u) * (1 - v);
        H[k + 1] += amt * u * (1 - v);
        H[k + N] += amt * (1 - u) * v;
        H[k + N + 1] += amt * u * v;
      } else {
        const amt = Math.min((cap - sediment) * erodeK, -dh) * (g.h > 0.5 ? 1 : 0.2);
        // spread erosion over a small footprint to avoid pits
        for (let oj = -1; oj <= 1; oj++)
          for (let oi = -1; oi <= 1; oi++) {
            const w = oi === 0 && oj === 0 ? 0.36 : oi === 0 || oj === 0 ? 0.1 : 0.06;
            H[k + oj * N + oi] -= amt * w;
          }
        sediment += amt;
      }
      speed = Math.sqrt(Math.max(0, speed * speed + -dh * scale * gravity));
      water *= 1 - evap;
      px = nx;
      pz = nz;
      if (H[(pz | 0) * N + (px | 0)] < -2) break;
    }
    if ((n & 32767) === 0) progress(n / drops);
  }
}

function makeNames(rand: () => number) {
  const pre = ['Ne', 'Ka', 'Ly', 'Me', 'Ser', 'Thy', 'Ari', 'Pha', 'Del', 'Kor', 'Ios', 'Ana', 'Hy', 'Syr', 'Pa', 'Ky', 'Mi', 'Ze', 'Ter', 'Ol'];
  const mid = ['ro', 'ki', 'da', 'phi', 'lo', 'ne', 'the', 'ma', 'so', 'ly', 'ra', ''];
  const suf = ['s', 'os', 'a', 'e', 'on', 'ia', 'nos', 'thos', 'ssa', 'kos'];
  const out: string[] = [];
  while (out.length < 20) {
    const n = pre[Math.floor(rand() * pre.length)] + mid[Math.floor(rand() * mid.length)] + suf[Math.floor(rand() * suf.length)];
    if (!out.includes(n) && n.length > 3) out.push(n);
  }
  return out;
}
