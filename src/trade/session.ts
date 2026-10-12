// The trade session (cargo-trade-spec §6.3): the glue between the economy, the purse, the manifest,
// the notebook and the cargo job. Pure: no DOM, no three.js.

import type { Economy } from './economy';
import { GOOD_IDS, goodById, type GoodId } from './goods';
import { applyWages, noteOpened as writeNotebook, porterFeePerUnit, type VoyageState } from './voyage';
import { addOrder, newJob, pendingUnits as countPending, stepJob, type Units } from './job';

/** Signed units per good: + buy, − sell. */
export type Orders = Partial<Record<GoodId, number>>;
export type Line = { good: GoodId; qty: number; total: number };
export type SessionEvent =
  | { type: 'wages'; days: number; amount: number }
  | { type: 'moved'; good: GoodId; delta: number }
  | { type: 'job-done'; kind: 'stowed' | 'landed' }
  | { type: 'arrival'; port: number; good: GoodId; qty: number };
export type LimitedBy = 'purse' | 'hold' | 'stock' | 'aboard' | null;
export interface Limit {
  min: number;
  max: number;
  /** the binding constraint on the side of the row's current sign (lower side: 'aboard') */
  limitedBy: LimitedBy;
}

/** Hours the hatches stay open after a job ends (§6.2). */
const HATCH_AFTER_JOB = 1;
/** Hours from the last unit landing or stowing to the quay being cleared (§6.2). */
const CART_AFTER_JOB = 1;

export class TradeSession {
  readonly economy: Economy;
  readonly voyage: VoyageState;
  readonly holdCapacity: number;
  /** session clock: the economy's time at the last tick, or its start */
  private lastT: number;
  /** when the quay is cleared and the job ends, if pending is empty; null otherwise */
  private cartAt: number | null = null;
  /** hatches are open while a job exists, and until this hour after one ends */
  private hatchUntil = -Infinity;

  constructor(o: { economy: Economy; voyage: VoyageState; holdCapacity: number }) {
    this.economy = o.economy;
    this.voyage = o.voyage;
    this.holdCapacity = o.holdCapacity;
    this.lastT = o.economy.now;
    // A restored job whose units are all moved still has to be cleared (the save holds no timer).
    const j = o.voyage.job;
    if (j && countPending(j) === 0) this.cartAt = this.lastT + CART_AFTER_JOB;
  }

  /** manifest + pending incoming − pending outgoing (units) */
  aboard(good: GoodId): number {
    return (this.voyage.manifest[good] ?? 0) + (this.voyage.job?.pending[good] ?? 0);
  }

  /**
   * Volume (m³) and mass (t) of what is aboard, counted as aboard(good) per good (the same net figure
   * the ledger shows as Aboard).
   */
  holdUse(): { volume: number; tonnes: number } {
    let volume = 0;
    let kg = 0;
    for (const id of GOOD_IDS) {
      const n = this.aboard(id);
      if (n === 0) continue;
      const g = goodById(id);
      volume += n * g.stow;
      kg += n * g.mass;
    }
    return { volume, tonnes: kg / 1000 };
  }

  /** The ledger's limits for one row, given the other rows (§9). */
  limits(port: number, orders: Orders, good: GoodId): Limit {
    const m = this.economy.market(port, good);
    const cur = orders[good] ?? 0;
    const others: Orders = { ...orders };
    delete others[good];
    const otherNet = this.netOf(port, others);
    const budget = this.voyage.purse + otherNet; // need budget + netRow(v) ≥ 0

    const minV = -this.sellable(good);
    const stockMax = m.maxBuy();
    const feasible = (v: number) => budget + this.netRow(port, good, v) >= 0;
    let purseMax: number;
    if (!feasible(minV)) {
      purseMax = minV; // the other rows already break the purse: only the sell side can help
    } else if (feasible(stockMax)) {
      purseMax = stockMax;
    } else {
      // feasibility is downward closed in v: lo is feasible, hi is not
      let lo = minV;
      let hi = stockMax;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (feasible(mid)) lo = mid;
        else hi = mid;
      }
      purseMax = lo;
    }

    let rest = 0;
    for (const id of GOOD_IDS) {
      if (id === good) continue;
      rest += (this.aboard(id) + (orders[id] ?? 0)) * this.economy.market(port, id).good.stow;
    }
    const holdMax = Math.floor((this.holdCapacity - rest) / m.good.stow - this.aboard(good) + 1e-9);

    const candidates: [LimitedBy, number][] = [
      ['stock', stockMax],
      ['purse', purseMax],
      ['hold', holdMax],
    ];
    let upper: LimitedBy = 'stock';
    let max = stockMax;
    for (const [name, v] of candidates) {
      if (v < max) {
        max = v;
        upper = name;
      }
    }
    if (max < minV) {
      max = minV; // the other rows already break a limit: the row cannot go above the sell floor
    }
    return { min: minV, max, limitedBy: cur < 0 ? 'aboard' : upper };
  }

  /** Signed net money (+ in) of the order, with duty and porterage, plus the duty and porterage parts. */
  quote(port: number, orders: Orders): { total: number; duty: number; porters: number } {
    let total = 0;
    let duty = 0;
    let porters = 0;
    for (const id of GOOD_IDS) {
      const v = orders[id] ?? 0;
      if (v === 0) continue;
      this.checkInt(v);
      const m = this.economy.market(port, id);
      const q = v > 0 ? m.quoteBuy(v) : m.quoteSell(-v);
      total += this.netRow(port, id, v);
      duty += q.duty;
      porters += porterFeePerUnit(m.good) * Math.abs(v);
    }
    return { total, duty, porters };
  }

  /**
   * Settles the order now: sells first, then buys, at current stock; the purse moves by the quoted
   * totals. Units enter the job (created if needed). The manifest changes only as units move, in tick().
   * Throws if the order breaks a limit (the caller clamps first).
   */
  confirm(port: number, berth: number, orders: Orders): { sold: Line[]; bought: Line[] } {
    const job = this.voyage.job;
    if (job && job.port !== port) throw new Error(`cargo job is at port ${job.port}, not ${port}`);
    let before = 0;
    let after = 0;
    for (const id of GOOD_IDS) {
      const v = orders[id] ?? 0;
      this.checkInt(v);
      const m = this.economy.market(port, id);
      if (v > 0 && v > m.maxBuy()) throw new RangeError(`buy of ${v} ${id} breaks the stock floor`);
      if (v < 0 && -v > this.sellable(id)) throw new RangeError(`sell of ${-v} ${id} exceeds what is aboard`);
      before += this.aboard(id) * m.good.stow;
      after += (this.aboard(id) + v) * m.good.stow;
    }
    if (this.voyage.purse + this.netOf(port, orders) < 0) throw new RangeError('order exceeds the purse');
    if (after > this.holdCapacity + 1e-9 && after > before + 1e-9) throw new RangeError('order exceeds the hold');

    const sold: Line[] = [];
    const bought: Line[] = [];
    const soldUnits: Units = {};
    const boughtUnits: Units = {};
    for (const id of GOOD_IDS) {
      const v = orders[id] ?? 0;
      if (v >= 0) continue;
      const q = this.economy.market(port, id).sell(-v);
      this.voyage.purse += q.total;
      sold.push({ good: id, qty: -v, total: q.total });
      soldUnits[id] = -v;
    }
    for (const id of GOOD_IDS) {
      const v = orders[id] ?? 0;
      if (v <= 0) continue;
      const q = this.economy.market(port, id).buy(v);
      this.voyage.purse -= q.total;
      bought.push({ good: id, qty: v, total: q.total });
      boughtUnits[id] = v;
    }
    if (sold.length > 0 || bought.length > 0) {
      let j = this.voyage.job;
      if (!j) {
        j = newJob(port, berth);
        this.voyage.job = j;
      }
      addOrder(j, soldUnits, boughtUnits);
      this.cartAt = countPending(j) === 0 ? this.lastT + CART_AFTER_JOB : null;
    }
    return { sold, bought };
  }

  /** Writes the notebook for this port at T: current ask and bid per good. */
  noteOpened(port: number, T: number): void {
    writeNotebook(this.voyage, this.economy, port, T);
  }

  /**
   * Advances the economy to T, pays wages, moves cargo at LOAD_RATE over the elapsed game hours and
   * ends the job when the quay is cleared. Returns the events for the caller.
   */
  tick(T: number): SessionEvent[] {
    const events: SessionEvent[] = [];
    this.economy.advanceTo(T);
    const raw = this.economy.drainEvents();
    let days = 0;
    for (const e of raw) if (e.type === 'wages') days += e.days;
    const amount = applyWages(this.voyage, raw);
    if (days > 0) events.push({ type: 'wages', days, amount });
    for (const e of raw) {
      if (e.type === 'arrival') events.push({ type: 'arrival', port: e.port, good: e.good, qty: e.qty });
    }

    const delta: Partial<Record<GoodId, number>> = {};
    let t = this.lastT;
    for (;;) {
      const job = this.voyage.job;
      if (job && this.cartAt !== null && t >= this.cartAt && countPending(job) === 0) this.endJob(t);
      if (t >= T) break;
      // sub-steps end at whole game hours, the session's end, and the cart time
      let next = Math.min(T, Math.floor(t) + 1);
      if (this.cartAt !== null && this.cartAt > t && this.cartAt < next) next = this.cartAt;
      const j = this.voyage.job;
      if (j && countPending(j) > 0) {
        const r = stepJob(j, this.voyage, next - t);
        for (const m of r.moved) delta[m.good] = (delta[m.good] ?? 0) + m.delta;
        if (r.done) {
          events.push({ type: 'job-done', kind: r.done });
          this.cartAt = t + r.usedHours + CART_AFTER_JOB;
        }
      }
      t = next;
    }
    for (const id of GOOD_IDS) {
      if (delta[id]) events.push({ type: 'moved', good: id, delta: delta[id]! });
    }
    this.lastT = T;
    return events;
  }

  /** Units still to move, both directions. */
  get pendingUnits(): number {
    const j = this.voyage.job;
    return j ? countPending(j) : 0;
  }

  /** True while a job runs and for 1 game hour after it ends. */
  hatchesOpen(T: number): boolean {
    return this.voyage.job !== null || T < this.hatchUntil;
  }

  /** Cast off: closes the hatches at once. Refused (throws) while units are pending. */
  castOff(): void {
    if (this.pendingUnits > 0) throw new Error(`cargo still moving: ${this.pendingUnits} left`);
    this.voyage.job = null;
    this.cartAt = null;
    this.hatchUntil = -Infinity;
  }

  private endJob(t: number): void {
    this.voyage.job = null;
    this.cartAt = null;
    this.hatchUntil = t + HATCH_AFTER_JOB;
  }

  private sellable(good: GoodId): number {
    const pendingOut = Math.max(0, -(this.voyage.job?.pending[good] ?? 0));
    return Math.max(0, (this.voyage.manifest[good] ?? 0) - pendingOut);
  }

  /** Net money of one row (+ in), duty and porterage included. Zero for v = 0. */
  private netRow(port: number, good: GoodId, v: number): number {
    if (v === 0) return 0;
    const m = this.economy.market(port, good);
    const fee = porterFeePerUnit(m.good);
    if (v > 0) return -(m.quoteBuy(v).total + fee * v);
    return m.quoteSell(-v).total - fee * (-v);
  }

  private netOf(port: number, orders: Orders): number {
    let net = 0;
    for (const id of GOOD_IDS) {
      const v = orders[id] ?? 0;
      if (v !== 0) net += this.netRow(port, id, v);
    }
    return net;
  }

  private checkInt(v: number): void {
    if (!Number.isInteger(v)) throw new RangeError(`order must be whole units: ${v}`);
  }
}
