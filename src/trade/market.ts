// One market: a (port, good) pair (cargo-trade-spec §4.4). Pure. The stock S is a float in units.
//
// Naming: P_ref and D_ref are reference flows in units per day (production and consumption, §4.3).
// The price reference is good.pRef (centidrachmas per unit), not a market field.

import type { Good } from './goods';
import { payCeil, receiveFloor } from './money';

/** Bid-ask spread: ask = price·(1 + σ/2), bid = price·(1 − σ/2). */
export const SPREAD = 0.06;
/** Harbour duty on both buys and sells. */
export const DUTY = 0.02;
/** A buy may not take the stock below this share of S_ref. */
export const STOCK_FLOOR = 0.05;
/** Price clamp, as multiples of good.pRef. */
export const PRICE_MIN = 0.3;
export const PRICE_MAX = 3.5;

export interface Quote {
  /** centidrachmas: what the player pays (buy) or receives (sell), duty included */
  total: number;
  /** centidrachmas of duty inside total */
  duty: number;
  /** centidrachmas: the price of the first unit (mid-stock ask or bid); 0 when q = 0 */
  unitFirst: number;
  /** centidrachmas: the price of the last unit; 0 when q = 0 */
  unitLast: number;
}

function checkQty(q: number): void {
  if (!Number.isInteger(q) || q < 0) throw new RangeError(`quantity must be a non-negative integer: ${q}`);
}

export class Market {
  readonly good: Good;
  /** stock, units (float) */
  S: number;
  /** reference stock, units: D_ref · bufferDays */
  readonly S_ref: number;
  /** reference production, units per day */
  readonly P_ref: number;
  /** reference consumption, units per day */
  readonly D_ref: number;

  constructor(good: Good, P_ref: number, D_ref: number, S0?: number) {
    this.good = good;
    this.P_ref = P_ref;
    this.D_ref = D_ref;
    this.S_ref = D_ref * good.bufferDays;
    this.S = S0 ?? this.S_ref;
  }

  /** Mid price, centidrachmas per unit, at stock S (default: the current stock). */
  price(S: number = this.S): number {
    const pRef = this.good.pRef;
    const base = Math.max(S, STOCK_FLOOR * this.S_ref);
    // With S_ref = 0 (no demand) the ratio is 0 for any stock, so the price sits on the floor.
    const ratio = base > 0 ? this.S_ref / base : 1;
    const raw = pRef * Math.pow(ratio, this.good.eta);
    return Math.min(PRICE_MAX * pRef, Math.max(PRICE_MIN * pRef, raw));
  }

  /** What the player pays per unit at stock S (before duty). */
  ask(S: number = this.S): number {
    return this.price(S) * (1 + SPREAD / 2);
  }

  /** What the player receives per unit at stock S (before duty). */
  bid(S: number = this.S): number {
    return this.price(S) * (1 - SPREAD / 2);
  }

  /** Largest whole number of units that can be bought without taking S below the stock floor. */
  maxBuy(): number {
    return Math.max(0, Math.floor(this.S - STOCK_FLOOR * this.S_ref));
  }

  /**
   * Quote for buying q units: per-unit stepping, unit i priced at ask(S − i − 0.5). Throws when q is
   * above maxBuy() (the stock floor).
   */
  quoteBuy(q: number): Quote {
    checkQty(q);
    if (q > this.maxBuy()) throw new RangeError(`cannot buy ${q}: stock floor allows ${this.maxBuy()}`);
    let sum = 0;
    let unitFirst = 0;
    let unitLast = 0;
    for (let i = 0; i < q; i++) {
      const p = this.ask(this.S - i - 0.5);
      if (i === 0) unitFirst = p;
      unitLast = p;
      sum += p;
    }
    const gross = payCeil(sum);
    const total = payCeil(sum * (1 + DUTY));
    return { total, duty: total - gross, unitFirst, unitLast };
  }

  /** Quote for selling q units: unit i priced at bid(S + i + 0.5). */
  quoteSell(q: number): Quote {
    checkQty(q);
    let sum = 0;
    let unitFirst = 0;
    let unitLast = 0;
    for (let i = 0; i < q; i++) {
      const p = this.bid(this.S + i + 0.5);
      if (i === 0) unitFirst = p;
      unitLast = p;
      sum += p;
    }
    const gross = receiveFloor(sum);
    const total = receiveFloor(sum * (1 - DUTY));
    return { total, duty: gross - total, unitFirst, unitLast };
  }

  /** Buys q units: stock falls by q now; returns the quote (the caller takes quote.total from the purse). */
  buy(q: number): Quote {
    const quote = this.quoteBuy(q);
    this.S -= q;
    return quote;
  }

  /** Sells q units: stock rises by q now; returns the quote (the caller adds quote.total to the purse). */
  sell(q: number): Quote {
    const quote = this.quoteSell(q);
    this.S += q;
    return quote;
  }

  /**
   * Hourly relaxation toward equilibrium (§4.4), given this quantum's production and demand in units
   * per day. Requires D > 0 (the economy skips markets without demand).
   */
  relax(P: number, D: number): void {
    const S_eq = (this.S_ref * P) / D;
    const tau = this.S_ref / D; // days
    this.S = S_eq + (this.S - S_eq) * Math.exp(-(1 / 24) / tau);
  }
}
