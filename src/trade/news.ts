// Price news (docs/kormakos-and-traders-spec.md, part B): what a port has heard about the others. Ships carry
// prices, so a trader at port P knows port A's prices as they were one voyage ago: the latest daily record at or
// before now − routeHours(A, P). Pure: no DOM, no three.js.

import { GOOD_IDS, type GoodId } from './goods';

/** The part of the economy the news reads. */
export interface NewsEconomy {
  readonly ports: readonly { id: number }[];
  market(port: number, good: GoodId): { ask(): number; bid(): number };
  routeHours(from: number, to: number): number;
}

/** Ask and bid per good (GOOD_IDS order, centidrachmas) of every port at one game hour. */
export interface PriceRecord {
  T: number;
  ports: { port: number; ask: number[]; bid: number[] }[];
}

/** What a trader heard about one port: its prices at T. */
export interface Heard {
  port: number;
  T: number;
  ask: Record<GoodId, number>;
  bid: Record<GoodId, number>;
}

/** Records older than this are dropped (game hours). */
export const NEWS_KEEP_HOURS = 30 * 24;

export function recordOf(econ: NewsEconomy, T: number): PriceRecord {
  return {
    T,
    ports: econ.ports.map((p) => ({
      port: p.id,
      ask: GOOD_IDS.map((g) => Math.round(econ.market(p.id, g).ask())),
      bid: GOOD_IDS.map((g) => Math.round(econ.market(p.id, g).bid())),
    })),
  };
}

export class PriceNews {
  /** oldest first */
  readonly records: PriceRecord[];

  constructor(records: PriceRecord[] = []) {
    this.records = records.slice().sort((a, b) => a.T - b.T);
  }

  /** Records the prices once per game day (the first observation of each day), and drops old records. */
  observe(econ: NewsEconomy, T: number): void {
    const last = this.records[this.records.length - 1];
    if (!last || Math.floor(T / 24) > Math.floor(last.T / 24)) this.add(recordOf(econ, T));
  }

  /** Adds a record in time order (used to seed a new voyage with a plausible past). */
  add(r: PriceRecord): void {
    let i = this.records.length;
    while (i > 0 && this.records[i - 1].T > r.T) i--;
    this.records.splice(i, 0, r);
    const cut = this.records[this.records.length - 1].T - NEWS_KEEP_HOURS;
    while (this.records.length && this.records[0].T < cut) this.records.shift();
  }

  /** What `listener` has heard about `about` at `now`: the latest record a ship could have carried, or null. */
  heard(listener: number, about: number, now: number, routeHours: (from: number, to: number) => number): Heard | null {
    if (listener === about) return null;
    const latest = now - routeHours(about, listener);
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i];
      if (r.T > latest) continue;
      const p = r.ports.find((x) => x.port === about);
      if (!p) return null;
      const ask = {} as Record<GoodId, number>;
      const bid = {} as Record<GoodId, number>;
      GOOD_IDS.forEach((g, k) => {
        ask[g] = p.ask[k];
        bid[g] = p.bid[k];
      });
      return { port: about, T: r.T, ask, bid };
    }
    return null;
  }

  snapshot(): PriceRecord[] {
    return this.records.map((r) => ({ T: r.T, ports: r.ports.map((p) => ({ port: p.port, ask: p.ask.slice(), bid: p.bid.slice() })) }));
  }

  /** Restores saved records; malformed records are dropped, never fabricated. */
  static restore(raw: unknown): PriceNews {
    const out: PriceRecord[] = [];
    if (Array.isArray(raw)) {
      for (const r of raw) {
        if (typeof r !== 'object' || r === null || !Number.isFinite((r as PriceRecord).T) || !Array.isArray((r as PriceRecord).ports)) continue;
        const ports = (r as PriceRecord).ports.filter(
          (p) =>
            p && Number.isInteger(p.port) && Array.isArray(p.ask) && Array.isArray(p.bid) &&
            p.ask.length === GOOD_IDS.length && p.bid.length === GOOD_IDS.length &&
            [...p.ask, ...p.bid].every((v) => Number.isFinite(v) && v >= 0),
        );
        if (ports.length) out.push({ T: (r as PriceRecord).T, ports });
      }
    }
    return new PriceNews(out);
  }
}
