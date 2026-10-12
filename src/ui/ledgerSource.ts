// The ledger's view of a trade session (cargo-trade-spec §6.3, §9). An adapter: it reads the session and the
// economy and writes orders back through the session. No DOM, no three.js, no Game import, so the headless
// test can run it.

import { GOODS, goodById, type GoodId } from '../trade/goods';
import { formatDr } from '../trade/money';
import type { Economy } from '../trade/economy';
import type { VoyageState } from '../trade/voyage';
import type { LedgerMode, LedgerRow, LedgerSource } from './ledger';

type Orders = Partial<Record<GoodId, number>>;
type Line = { good: GoodId; qty: number; total: number };

/**
 * The parts of TradeSession (spec §6.3) the ledger reads and writes. The real class satisfies it; the
 * adapter is typed against this so it compiles before session.ts lands.
 */
export interface TradeSessionLike {
  readonly economy: Economy;
  readonly voyage: VoyageState;
  /** units still to move by the cargo job (both directions) */
  readonly pendingUnits: number;
  /** manifest + pending incoming − pending outgoing */
  aboard(good: GoodId): number;
  limits(port: number, orders: Orders, good: GoodId): { min: number; max: number; limitedBy: 'purse' | 'hold' | 'stock' | 'aboard' | null };
  quote(port: number, orders: Orders): { total: number; duty: number; porters: number };
  confirm(port: number, berth: number, orders: Orders): { sold: Line[]; bought: Line[] };
  noteOpened(port: number, T: number): void;
}

export interface TradeLedgerOptions {
  session: TradeSessionLike;
  /** the port id the ledger is open at */
  port: number;
  /** the port's name, the panel title (sentence case) */
  portName: string;
  /** the berth the ship is moored at, passed to confirm (the job's berth) */
  berth: number;
  /** trade (moored here), read (not moored here) or hold (the Hold book) */
  mode: LedgerMode;
  /** the game clock: dayCount (0-based, shown as day + 1) and hours (0..24) */
  clock: () => { dayCount: number; hours: number };
  /** absolute game hours, the economy's T */
  T: () => number;
  /** wages in centidrachmas per game day */
  wagesPerDay: number;
  /** hold volume, m³ */
  holdCapacity: number;
  /** names of every port in the notebook, by port id */
  portNames: Record<number, string>;
}

/** The ledger's LedgerSource for one port over a trade session. */
export function tradeLedgerSource(o: TradeLedgerOptions): LedgerSource {
  const s = o.session;

  const allRows = (): LedgerRow[] =>
    GOODS.map((g) => {
      const m = s.economy.market(o.port, g.id);
      return {
        id: g.id,
        name: g.name,
        unit: g.unit,
        stock: Math.floor(m.S),
        buy: m.ask(),
        sell: m.bid(),
        aboard: s.aboard(g.id),
        massKg: g.mass,
        stowM3: g.stow,
      };
    });

  const asOrders = (orders: Record<string, number>): Orders => orders as Orders;

  return {
    mode: o.mode,
    portName: o.portName,
    get timeLabel() {
      const c = o.clock();
      const minutes = Math.floor(c.hours * 60 + 1e-9);
      const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
      const mm = String(minutes % 60).padStart(2, '0');
      return `Day ${c.dayCount + 1} · ${hh}:${mm}`;
    },
    // hold mode lists only the goods aboard
    rows: () => (o.mode === 'hold' ? allRows().filter((r) => r.aboard > 0) : allRows()),
    quote: (orders) => s.quote(o.port, asOrders(orders)),
    limits(orders, id) {
      // the row's own entry is left out, so only the other rows limit it
      const others: Record<string, number> = { ...orders };
      delete others[id];
      const r = s.limits(o.port, asOrders(others), id as GoodId);
      // a sell limit (−aboard) is silent; only the buy side names a limiting figure
      return { min: r.min, max: r.max, limitedBy: r.limitedBy === 'aboard' ? null : r.limitedBy };
    },
    get purse() {
      return s.voyage.purse;
    },
    get hold() {
      let used = 0;
      let tonnes = 0;
      for (const g of GOODS) {
        const a = s.aboard(g.id);
        used += a * g.stow;
        tonnes += (a * g.mass) / 1000;
      }
      return { tonnes, used, capacity: o.holdCapacity };
    },
    wagesPerDay: o.wagesPerDay,
    get jobLine() {
      const job = s.voyage.job;
      const n = s.pendingUnits;
      if (!job || n <= 0) return null;
      // unloading goes first, so any outgoing pending unit means the job is unloading now
      const unloading = Object.values(job.pending).some((v) => (v ?? 0) < 0);
      return `${unloading ? 'Unloading' : 'Loading'} · ${n} left`;
    },
    notebook() {
      const ports = Object.keys(o.portNames)
        .map(Number)
        .sort((a, b) => a - b);
      const now = o.T();
      const entries = s.voyage.notebook;
      return {
        ports: ports.map((p) => o.portNames[p] ?? String(p)),
        current: ports.indexOf(o.port),
        rows: GOODS.map((g) => ({
          name: g.name,
          cells: ports.map((p) => {
            const e = entries.find((x) => x.port === p && x.good === g.id);
            return e ? { ask: e.ask, bid: e.bid, ageHours: Math.max(0, now - e.T) } : null;
          }),
        })),
      };
    },
    confirm(orders) {
      const res = s.confirm(o.port, o.berth, asOrders(orders));
      const line = (verb: string, l: Line) =>
        `${verb} ${Math.abs(l.qty)} ${goodById(l.good).name.toLowerCase()} · ${formatDr(Math.abs(l.total))}`;
      return [...res.sold.map((l) => line('Sold', l)), ...res.bought.map((l) => line('Bought', l))];
    },
    opened() {
      s.noteOpened(o.port, o.T());
    },
  };
}
