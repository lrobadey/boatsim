import * as THREE from 'three';
import { clamp } from '../../core/util';
import type { HullShape } from '../hullShape';
import type { CrewIntent } from './intent';
import type { Oar } from './oar';
import type { CrewRowingParams } from './params';
import { WALK_WAYPOINTS, type Hand, type HandWalk } from './physiology';
import { stanceXZ } from './stance';

export interface SwapRecord { t: number; oar: number; out: number; in: number; walk: number; done?: number }

/** where a walker is on the deck and which way he faces (filled in place by sampleWalk) */
export interface WalkSample { x: number; z: number; dx: number; dz: number }

const WALK_SPEED = 0.8; // m/s
const PATH_FACTOR = 1.3; // slalom through the alternating free halves of the deck
const WALK_POWER = 40; // W, light work for fatigue
/** walk clearance from a manned stance centre (m): stance cylinder 0.35 + walker 0.28 (body contact), rounded up */
export const WALK_CLEAR = 0.65;
/** deck bound on |x| for a walker's centre (m): the narrowest deck less the walker's radius, and the handover spot */
const DECK_X = 1.0;
/** route grid (m) */
const GRID = 0.05;

interface Pt { x: number; z: number }
const clearAt = (c: Pt, obs: readonly Pt[]) => obs.every((o) => Math.hypot(c.x - o.x, c.z - o.z) >= WALK_CLEAR);

/**
 * Shortest walk from `from` to `to` on the deck that keeps WALK_CLEAR from every obstacle centre (grid A*, 8-way,
 * then line-of-sight simplification). Returns the interior waypoints, or null when no route exists on the grid.
 * Planning runs at a handover decision, not per frame.
 */
export function planWalk(from: Pt, to: Pt, obs: readonly Pt[]): Pt[] | null {
  const zLo = Math.min(from.z, to.z) - 1, zHi = Math.max(from.z, to.z) + 1;
  const nx = Math.round((2 * DECK_X) / GRID) + 1, nz = Math.ceil((zHi - zLo) / GRID) + 1;
  const X = (i: number) => -DECK_X + i * GRID, Z = (j: number) => zLo + j * GRID;
  const clearOf = (x: number, z: number) => {
    for (const o of obs) if (Math.hypot(x - o.x, z - o.z) < WALK_CLEAR) return false;
    return true;
  };
  const free = (i: number, j: number) => clearOf(X(i), Z(j));
  const idx = (i: number, j: number) => j * nx + i;
  const si = clamp(Math.round((from.x + DECK_X) / GRID), 0, nx - 1), sj = clamp(Math.round((from.z - zLo) / GRID), 0, nz - 1);
  const gi = clamp(Math.round((to.x + DECK_X) / GRID), 0, nx - 1), gj = clamp(Math.round((to.z - zLo) / GRID), 0, nz - 1);
  const N = nx * nz, g = new Float64Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const start = idx(si, sj), goal = idx(gi, gj);
  // binary heap of (f, cell)
  const hf: number[] = [], hc: number[] = [];
  const push = (f: number, c: number) => {
    hf.push(f); hc.push(c);
    for (let k = hf.length - 1; k > 0;) { const q = (k - 1) >> 1; if (hf[q] <= hf[k]) break; [hf[q], hf[k]] = [hf[k], hf[q]]; [hc[q], hc[k]] = [hc[k], hc[q]]; k = q; }
  };
  const pop = (): number => {
    const top = hc[0], lf = hf.pop() as number, lc = hc.pop() as number;
    if (hf.length) {
      hf[0] = lf; hc[0] = lc;
      for (let k = 0;;) {
        const l = 2 * k + 1, r = l + 1; let m = k;
        if (l < hf.length && hf[l] < hf[m]) m = l;
        if (r < hf.length && hf[r] < hf[m]) m = r;
        if (m === k) break;
        [hf[m], hf[k]] = [hf[k], hf[m]]; [hc[m], hc[k]] = [hc[k], hc[m]]; k = m;
      }
    }
    return top;
  };
  g[start] = 0; push(0, start);
  const h = (c: number) => Math.hypot(c % nx - gi, Math.floor(c / nx) - gj) * GRID;
  while (hf.length) {
    const c = pop();
    if (closed[c]) continue;
    closed[c] = 1;
    if (c === goal) break;
    const ci = c % nx, cj = Math.floor(c / nx);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
      const n = idx(ni, nj);
      if (closed[n] || (n !== goal && !free(ni, nj))) continue;
      const ng = g[c] + Math.hypot(di, dj) * GRID;
      if (ng < g[n]) { g[n] = ng; came[n] = c; push(ng + h(n), n); }
    }
  }
  if (came[goal] < 0 && goal !== start) return null;
  const cells: Pt[] = [];
  for (let c = goal; c !== start && c >= 0; c = came[c]) cells.push({ x: X(c % nx), z: Z(Math.floor(c / nx)) });
  cells.reverse();
  // line-of-sight simplification
  const pts: Pt[] = [{ x: from.x, z: from.z }, ...cells, { x: to.x, z: to.z }];
  const seeOk = (a: Pt, b: Pt) => {
    for (let k = 1; k < 40; k++) {
      const t = k / 40, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      if (Math.abs(x) > DECK_X || !clearOf(x, z)) return false;
    }
    return true;
  };
  const out: Pt[] = [pts[0]];
  for (let i = 0, last = pts.length - 1; i < last;) {
    let j = last;
    while (j > i + 1 && !seeOk(pts[i], pts[j])) j--;
    out.push(pts[j]);
    i = j;
  }
  return out.slice(1, -1);
}

/** length of a walk's path (m); a walk without waypoints is the straight line from `from` to `to` */
export function walkLength(w: HandWalk): number {
  return w.n >= 2 ? w.len : w.from.distanceTo(w.to);
}

/** arc length along the walk's path at this time (walks run from 0 to the length) */
export function walkArc(w: HandWalk): number {
  return walkLength(w) * (w.T > 0 ? 1 - clamp(w.t / w.T, 0, 1) : 1);
}

/** the point on a walk's path at arc length s, and its direction of travel, written into out */
export function sampleWalk(w: HandWalk, s: number, out: WalkSample): WalkSample {
  if (!(w.n >= 2)) {
    const L = w.from.distanceTo(w.to), f = L > 0 ? clamp(s / L, 0, 1) : 1, dx = w.to.x - w.from.x, dz = w.to.z - w.from.z, D = Math.hypot(dx, dz) || 1;
    out.x = w.from.x + dx * f; out.z = w.from.z + dz * f; out.dx = dx / D; out.dz = dz / D;
    return out;
  }
  const n = w.n, last = w.wp[n - 1];
  if (!(w.len > 0)) { out.x = last.x; out.z = last.z; out.dx = 0; out.dz = -1; return out; }
  const ss = clamp(s, 0, w.len);
  let k = 0;
  while (k < n - 2 && w.cum[k + 1] < ss) k++;
  const a = w.wp[k], b = w.wp[k + 1];
  const seg = w.cum[k + 1] - w.cum[k], f = seg > 0 ? clamp((ss - w.cum[k]) / seg, 0, 1) : 0;
  out.x = a.x + (b.x - a.x) * f;
  out.z = a.z + (b.z - a.z) * f;
  const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
  out.dx = dx / L; out.dz = dz / L;
  return out;
}

/**
 * Reliefs (spec §6): at 1 Hz the crew decides whether a fresh man should take over from the most
 * tired rower. The relief walks to the station, puts his hands on the loom inboard of the rower's,
 * drives from the next catch; the outgoing man lets go at that stroke's finish and walks to the
 * waiting spot. Never during hold water, Oars Up or a turn; one handover at a time.
 */
export class Rotation {
  readonly swaps: SwapRecord[] = [];
  /** waiting spots per group (ship local, y = 0) */
  readonly spots: THREE.Vector3[];
  private sample: WalkSample = { x: 0, z: 0, dx: 0, dz: 0 };
  /** stance centre per station (x lateral, z fore-aft), ship-local */
  private readonly stanceX: number[] = [];
  private readonly stanceZ: number[] = [];

  constructor(private p: CrewRowingParams, hull: HullShape) {
    this.spots = p.reliefSpots.map(([x, s]) => new THREE.Vector3(x, 0, hull.zOf(s)));
    const xz = { x: 0, z: 0 };
    p.stations.forEach((_, k) => { stanceXZ(k, hull, p, xz); this.stanceX.push(xz.x); this.stanceZ.push(xz.z); });
  }

  /** walks whose planned route needed more waypoints than the walk has (fell back to the straight line) */
  routeFallbacks = 0;

  /** place the reliefs at their waiting spots, one per group */
  placeReliefs(hands: Hand[], nOars: number) {
    for (let i = nOars; i < hands.length; i++) {
      const h = hands[i], g = (i - nOars) % this.spots.length;
      h.home = g; h.state = 'waiting'; h.pos.copy(this.spots[g]);
    }
  }

  /**
   * where a relief stands to take an oar: the free side (opposite his oar), 0.9 m aft of the pin. The stances now
   * sit on the oar's side, so this spot is 1.0 m out (the neighbour's stance on that side is at least 0.4 m off).
   */
  private handoverSpot(o: Oar, oars: Oar[], out = new THREE.Vector3()) {
    const nominal = { x: -o.slot.side * 1.0, z: o.slot.z + 0.9 };
    const obs: Pt[] = [];
    for (const q of oars) if (q.hand && q.hand.state === 'rowing' && !q.shipped) obs.push({ x: this.stanceX[q.slot.id], z: this.stanceZ[q.slot.id] });
    // the nominal spot, moved to the nearest point that keeps WALK_CLEAR from every manned stance (the next station's stance can sit on it)
    let best = nominal;
    if (!clearAt(nominal, obs)) {
      let bd = Infinity;
      for (let r = GRID; r <= 0.8; r += GRID) for (let a = 0; a < 24; a++) {
        const c = { x: nominal.x + r * Math.cos((a * Math.PI) / 12), z: nominal.z + r * Math.sin((a * Math.PI) / 12) };
        if (Math.abs(c.x) <= DECK_X && r < bd && clearAt(c, obs)) { bd = r; best = c; }
      }
      if (bd === Infinity) best = nominal;
    }
    return out.set(best.x, 0, best.z);
  }

  /**
   * A walk from `from` to `to` in the time the straight line takes at the walking pace (spec §6.2). The route keeps
   * WALK_CLEAR from every manned stance (planWalk); the polyline is walked over the same time.
   */
  private route(from: THREE.Vector3, to: THREE.Vector3, oar: number, T: number, oars: Oar[]): HandWalk {
    const obs: Pt[] = [];
    for (const o of oars) if (o.hand && o.hand.state === 'rowing' && !o.shipped) obs.push({ x: this.stanceX[o.slot.id], z: this.stanceZ[o.slot.id] });
    let via = planWalk(from, to, obs);
    if (!via || via.length > WALK_WAYPOINTS - 2) { this.routeFallbacks++; via = []; }
    const wp = Array.from({ length: WALK_WAYPOINTS }, () => ({ x: 0, z: 0 }));
    const cum = new Float64Array(WALK_WAYPOINTS);
    let n = 0;
    const put = (x: number, z: number) => { wp[n].x = x; wp[n].z = z; n++; };
    put(from.x, from.z);
    for (const q of via) put(q.x, q.z);
    put(to.x, to.z);
    for (let k = 1; k < n; k++) cum[k] = cum[k - 1] + Math.hypot(wp[k].x - wp[k - 1].x, wp[k].z - wp[k - 1].z);
    return { from, to, t: T, T, oar, wp, n, cum, len: cum[n - 1] };
  }

  decide(time: number, oars: Oar[], hands: Hand[], it: CrewIntent) {
    const p = this.p;
    if (it.hold || Math.abs(it.N) > 0.3 || it.dir === 0) return;
    const last = this.swaps[this.swaps.length - 1];
    if (last && (time - last.t < p.swapGap || last.done === undefined)) return;
    let worst: Oar | null = null, score = 0;
    for (const o of oars) {
      const h = o.hand;
      if (!h || h.state !== 'rowing' || o.shipped) continue;
      const sc = 1 - h.Wbal / p.Wp + 0.5 * (1 - h.R);
      if (sc > score) { score = sc; worst = o; }
    }
    if (!worst || !worst.hand) return;
    // each group uses its own relief first
    let fresh: Hand | null = null;
    for (const h of hands) {
      if (h.state !== 'waiting' || h.Wbal < 0.8 * p.Wp) continue;
      const better = !fresh || (h.home === worst.group && fresh.home !== worst.group) ||
        ((h.home === worst.group) === (fresh.home === worst.group) && h.Wbal + h.R * p.Wp > fresh.Wbal + fresh.R * p.Wp);
      if (better) fresh = h;
    }
    if (!fresh) return;
    const h = worst.hand;
    const need = h.Wbal < p.swapW * p.Wp || (fresh.R - h.R > p.swapR && h.rowTime > p.swapMinOn);
    if (!need) return;
    const target = oars.indexOf(worst), dest = this.handoverSpot(worst, oars);
    const T = (fresh.pos.distanceTo(dest) * PATH_FACTOR) / WALK_SPEED;
    fresh.state = 'walking';
    fresh.walk = this.route(fresh.pos.clone(), dest, target, T, oars);
    this.swaps.push({ t: time, oar: target, out: h.id, in: fresh.id, walk: T });
  }

  /** walking, handover and waiting, every physics step */
  update(dt: number, time: number, oars: Oar[], hands: Hand[]) {
    const p = this.p;
    for (const h of hands) {
      if ((h.state === 'walking' || h.state === 'leaving') && h.walk) {
        h.walk.t -= dt;
        sampleWalk(h.walk, walkArc(h.walk), this.sample);
        h.pos.x = this.sample.x; h.pos.z = this.sample.z;
        h.load(p, WALK_POWER, dt);
        if (h.walk.t <= 0) h.state = h.state === 'walking' ? 'ready' : 'waiting';
        continue;
      }
      if (h.state === 'ready' && h.walk) {
        // hands on the loom inboard of the outgoing man's; he drives from the next catch
        const o = oars[h.walk.oar], old = o.hand;
        if (old && (o.mode === 'catch' || o.mode === 'rest' || o.mode === 'ready' || o.mode === 'shipped')) {
          old.state = 'handover';
          h.state = 'rowing'; h.oar = h.walk.oar; h.rowTime = 0; h.home = o.group;
          o.hand = h; o.second = old;
          const sw = this.swaps[this.swaps.length - 1];
          if (sw && sw.in === h.id) sw.done = time;
        }
        h.load(p, 0, dt);
        continue;
      }
      if (h.state === 'handover') {
        // lets go at the finish and steps out during the recovery
        const o = oars.find((q) => q.second === h);
        if (!o || o.mode === 'recover' || o.mode === 'rest' || o.mode === 'shipped') {
          const from = o ? this.handoverSpot(o, oars) : h.pos.clone();
          if (o) o.second = null;
          const g = o ? o.group : h.home;
          h.state = 'leaving'; h.oar = -1; h.home = g; h.pos.copy(from);
          const T = (from.distanceTo(this.spots[g]) * PATH_FACTOR) / WALK_SPEED;
          h.walk = this.route(from, this.spots[g].clone(), -1, T, oars);
        }
        continue; // his work while still on the loom is counted with the oar
      }
      if (h.state === 'waiting') h.load(p, 0, dt);
    }
  }
}
