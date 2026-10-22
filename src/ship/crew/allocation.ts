import { clamp, smoothstep } from '../../core/util';
import type { CrewIntent } from './intent';
import type { Oar } from './oar';
import type { CrewRowingParams } from './params';

const UNAVAILABLE = 1e3;
/** yaw demand at which a watch calls all hands for the turn, and the band below it before they stand down */
const ALL_HANDS_N = 0.3;
const ALL_HANDS_BAND = 0.05;

/**
 * Who pulls, who backs and who rests, and how hard (spec §5.3): the crew's common knowledge of what
 * the others are doing. Minimises
 *   J = wx (sum a/n - X)^2 + wn (sum -side a/n - N)^2 + sum c_i a_i^2
 * over shares a_i in [-1, 1] by projected gradient (fixed iteration count: deterministic). Tired men
 * cost more; an oar without a rowing hand, or shipped, is unavailable.
 */
export class Allocator {
  private a: Float64Array;
  private cost: Float64Array;
  private onWatch: number[] = [];
  private offWatch: number[] = [];
  private allHands = false;
  constructor(n: number) { this.a = new Float64Array(n); this.cost = new Float64Array(n); }

  allocate(oars: Oar[], it: CrewIntent, p: CrewRowingParams) {
    const n = oars.length, a = this.a, cost = this.cost;
    // Oars Up: no rowing whatever the helm (a pivot is a manoeuvre intent, not Oars Up)
    if (it.dir === 0) { for (const o of oars) { o.alloc = 0; o.bias = 0; o.watch = false; } this.allHands = false; return; }
    for (let i = 0; i < n; i++) {
      const o = oars[i], h = o.hand;
      const available = !!h && h.state === 'rowing' && !o.shipped;
      // a fresh man at full demand carries his full share (no base cost; audit §6.8: 104 W against 115 W ordered)
      cost[i] = available ? 0.25 * (1 - clamp(h.Wbal / p.Wp, 0, 1)) + 0.2 * (1 - h.R) : UNAVAILABLE;
    }
    // the watch is chosen before the shares, so the yaw split lands on the men who row; a hard turn calls all
    // hands (with a band, so a helm near the threshold does not toggle it)
    const absN = Math.abs(it.N);
    this.allHands = absN >= ALL_HANDS_N || (this.allHands && absN > ALL_HANDS_N - ALL_HANDS_BAND);
    if (it.manned < n && !this.allHands) {
      this.watches(oars, it, cost);
      for (let i = 0; i < n; i++) if (!oars[i].watch) cost[i] = UNAVAILABLE;
    } else for (const o of oars) o.watch = false;
    // demands are fractions of the oars that can row, so a watch of two meets them as six would
    let cmax = 0, m = 0;
    for (let i = 0; i < n; i++) {
      const available = cost[i] < UNAVAILABLE;
      a[i] = available ? oars[i].alloc : 0;
      if (available) { cmax = Math.max(cmax, cost[i]); m++; }
    }
    m = Math.max(1, m);
    const X = it.X, N = it.N, wn = 3 * it.yawPriority, wx = 1;
    const step = 0.9 / ((2 * (wx + wn)) / m + (2 * cmax) / m);
    for (let iter = 0; iter < 80; iter++) {
      let sx = 0, sn = 0;
      for (let i = 0; i < n; i++) { sx += a[i] / m; sn += (-oars[i].slot.side * a[i]) / m; }
      const ex = sx - X, en = sn - N;
      for (let i = 0; i < n; i++) {
        if (cost[i] >= UNAVAILABLE) continue;
        const g = (2 * wx * ex) / m + (2 * wn * en * -oars[i].slot.side) / m + (2 * cost[i] * a[i]) / m;
        a[i] = clamp(a[i] - g * step, -1, 1);
      }
    }
    for (let i = 0; i < n; i++) {
      const o = oars[i];
      o.alloc = a[i];
      // arc bias adds yaw: fore oars reach forward, aft oars finish long when their side must turn harder
      const fore = o.slot.z < 0 ? 1 : -1, want = -o.slot.side * Math.sign(a[i]) * N;
      o.bias = clamp(fore * want, -1, 1) * smoothstep(0.2, 0.8, Math.abs(N));
    }
  }

  /** rowing in watches: the same men stay at the oars; a side's man is swapped only when clearly more tired */
  private watches(oars: Oar[], it: CrewIntent, cost: Float64Array) {
    const want = it.manned / 2;
    for (const side of [-1, 1]) {
      const on = this.onWatch, off = this.offWatch;
      on.length = off.length = 0;
      for (let i = 0; i < oars.length; i++) if (oars[i].slot.side === side && oars[i].watch) on.push(i);
      if (on.length !== want) {
        on.length = 0;
        const idx: number[] = [];
        for (let i = 0; i < oars.length; i++) if (oars[i].slot.side === side) idx.push(i);
        // nearest amidships first
        idx.sort((i, j) => Math.abs(oars[i].slot.z) - Math.abs(oars[j].slot.z) || i - j);
        for (let k = 0; k < want && k < idx.length; k++) on.push(idx[k]);
      }
      for (let i = 0; i < oars.length; i++) if (oars[i].slot.side === side && !on.includes(i)) off.push(i);
      for (let k = 0; k < on.length; k++) {
        const i = on[k];
        for (const j of off) if (cost[i] - cost[j] > 0.15 && cost[j] < 1) { on[k] = j; break; }
      }
      for (let i = 0; i < oars.length; i++) {
        if (oars[i].slot.side !== side) continue;
        oars[i].watch = on.includes(i);
        if (!oars[i].watch) oars[i].alloc = 0;
      }
    }
  }
}
