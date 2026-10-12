// The economy (cargo-trade-spec §4.3 and §4.4). Pure TypeScript: no three.js, DOM or game imports.
//
// Time is absolute game hours T. State advances in integer-hour quanta [n, n+1); midnight is the end
// of a quantum with (n+1) % 24 === 0, where NPC shipments run and wages are charged.

import { GOODS, goodIndex, season, type Good, type GoodId } from './goods';
import { hash01 } from './hash';
import { DUTY, Market } from './market';
import { ShockTrack, type ShockMultipliers } from './shocks';

/** Terrain and settlement of a port's island (the world lane mirrors this type). */
export interface PortProfile {
  /** village houses, the basis of population */
  houses: number;
  /** land area (m²) of the island */
  area: number;
  /** terrain feature areas per good (m², weighted), §4.3 */
  features: Record<GoodId, number>;
}

export interface EconPort {
  /** stable harbour id (0 = the main harbour; it also has three ships) */
  id: number;
  profile: PortProfile;
  /** pier root, world metres */
  x: number;
  z: number;
}

export interface EconomyOptions {
  seed: number;
  ports: EconPort[];
  /** day of year 0..364 at absolute hour T */
  doyAt: (T: number) => number;
  /** the player's crew, for wages (0 = no wages) */
  hands: number;
  /** absolute hour T0 of the start */
  startT: number;
  /** test hooks: no shocks, or no NPC shipments (both default to false) */
  noShocks?: boolean;
  noShipments?: boolean;
}

export type EconEvent =
  | { type: 'wages'; days: number; amount: number }
  | { type: 'arrival'; port: number; good: GoodId; qty: number; T: number };

/** An NPC shipment on the water. from/to are port ids. */
export interface Shipment {
  from: number;
  to: number;
  good: GoodId;
  qty: number;
  arriveT: number;
}

export interface EconomySnapshot {
  /** the time the economy has advanced to */
  T: number;
  /** [port index][good index], units */
  stocks: number[][];
  shipments: Shipment[];
  /** [port index][ship], absolute hour the ship is next free */
  fleetBusyUntil: number[][];
  /** T − floor(T) */
  frac: number;
}

/** People per house (§4.3). */
export const POP_PER_HOUSE = 30;
/** Wages per hand per game day, centidrachmas (1.5 dr). */
export const WAGE_PER_HAND_DAY = 150;
/** Shipment limits (§4.4). */
export const SHIP_MAX_KG = 6000;
export const SHIP_MIN_UNITS = 10;

/** Fleet size: the main harbour (id 0) has three ships, the others one. */
function fleetSize(id: number): number {
  return id === 0 ? 3 : 1;
}

/** Busy-until value for an idle ship. Finite on purpose: JSON cannot carry Infinity. */
const IDLE = -1e15;

const ONE: ShockMultipliers = { p: 1, d: 1 };

/**
 * Reference production and demand per port and good (§4.3 rev. 2), indexed [port][good] in the same
 * order as the profiles and GOODS. Demand is N·perCapita with N = 30·houses. Production is
 * r·D with r = base·clamp((share/mean)^1.5, 0.25, 3), share = features/area, mean over the ports.
 */
export function referenceFlows(profiles: readonly PortProfile[]): { P_ref: number; D_ref: number }[][] {
  const n = profiles.length;
  const demand = profiles.map((pr) => GOODS.map((g) => POP_PER_HOUSE * pr.houses * g.perCapita));
  const share = profiles.map((pr) =>
    GOODS.map((g) => {
      const f = pr.features[g.id] ?? 0;
      return pr.area > 0 ? f / pr.area : 0;
    }),
  );
  return profiles.map((_, pi) =>
    GOODS.map((g: Good, gi) => {
      let sum = 0;
      for (let q = 0; q < n; q++) sum += share[q][gi];
      const mean = sum / n;
      const ratio = mean > 0 ? Math.pow(share[pi][gi] / mean, 1.5) : 1;
      const r = mean > 0 ? g.base * Math.min(3, Math.max(0.25, ratio)) : g.base;
      const D = demand[pi][gi];
      return { P_ref: r * D, D_ref: D };
    }),
  );
}

export class Economy {
  readonly seed: number;
  private readonly portList: readonly EconPort[];
  private readonly portIndex = new Map<number, number>();
  /** [port index][good index] */
  private readonly markets: Market[][];
  private readonly tracks: ShockTrack[][];
  /** [from index][to index], km */
  private readonly distKm: number[][];
  private readonly doyAt: (T: number) => number;
  private readonly hands: number;
  private readonly noShocks: boolean;
  private readonly noShipments: boolean;
  /** [port index][ship] busy-until hour */
  private fleetBusy: number[][];
  private inflight: Shipment[] = [];
  private eventList: EconEvent[] = [];
  /** time the economy has advanced to */
  private T: number;
  /** next quantum to run: always floor(T) once advanced */
  private nextN: number;
  private prerun = false;

  constructor(o: EconomyOptions) {
    this.seed = o.seed;
    this.portList = o.ports;
    this.doyAt = o.doyAt;
    this.hands = o.hands;
    this.noShocks = o.noShocks ?? false;
    this.noShipments = o.noShipments ?? false;
    o.ports.forEach((p, i) => {
      if (this.portIndex.has(p.id)) throw new RangeError(`duplicate port id ${p.id}`);
      this.portIndex.set(p.id, i);
    });

    const flows = referenceFlows(o.ports.map((p) => p.profile));
    this.markets = o.ports.map((p, pi) => GOODS.map((g, gi) => new Market(g, flows[pi][gi].P_ref, flows[pi][gi].D_ref)));
    this.tracks = o.ports.map((p, pi) => GOODS.map((g, gi) => new ShockTrack(o.seed, p.id, gi, g)));
    this.distKm = o.ports.map((a) => o.ports.map((b) => Math.hypot(a.x - b.x, a.z - b.z) / 1000));
    this.fleetBusy = o.ports.map((p) => new Array<number>(fleetSize(p.id)).fill(IDLE));

    // Start: stocks at equilibrium 480 hours (20 days) before T0, then the pre-run to T0. The pre-run
    // moves the market with its shipments but pays no wages and reports no events.
    const T0 = Math.floor(o.startT) - 480;
    this.T = T0;
    this.nextN = T0;
    const tm = T0 + 0.5;
    const doy = this.doyAt(tm);
    for (let pi = 0; pi < o.ports.length; pi++) {
      for (let gi = 0; gi < GOODS.length; gi++) {
        const m = this.markets[pi][gi];
        const sh = this.shock(pi, gi, tm);
        const P = m.P_ref * season(m.good, doy) * sh.p;
        const D = m.D_ref * sh.d;
        m.S = m.D_ref > 0 ? (m.S_ref * P) / D : 0;
      }
    }
    this.prerun = true;
    this.advanceTo(o.startT);
    this.prerun = false;
    this.eventList = [];
  }

  /** Time the economy has advanced to (absolute game hours). */
  get now(): number {
    return this.T;
  }

  get ports(): readonly EconPort[] {
    return this.portList;
  }

  /** The market for a port id and good. */
  market(port: number, good: GoodId): Market {
    return this.markets[this.indexOf(port)][goodIndex(good)];
  }

  /** Units of a good on the water to a port. */
  inflightTo(port: number, good: GoodId): number {
    let sum = 0;
    for (const s of this.inflight) if (s.to === port && s.good === good) sum += s.qty;
    return sum;
  }

  /** NPC shipments on the water. Read only. */
  get shipments(): readonly Shipment[] {
    return this.inflight;
  }

  /**
   * Hours a shipment takes between two ports: pier distance × 1.25 at 7.2 km/h real time, times 60
   * game hours per real hour. The time argument is reserved for weather and is unused.
   */
  routeHours(from: number, to: number, _T?: number): number {
    return this.routeHoursIdx(this.indexOf(from), this.indexOf(to));
  }

  /** Returns the events since the last call, and clears them. */
  drainEvents(): EconEvent[] {
    const e = this.eventList;
    this.eventList = [];
    return e;
  }

  /**
   * Runs every whole-hour quantum n with n + 1 ≤ T not yet run. Throws if T is below the last T
   * (time never runs backwards). Advancing 100 days in one call equals 2 400 one-hour calls, bit for bit.
   */
  advanceTo(T: number): void {
    if (!(T >= this.T)) throw new RangeError(`economy time cannot run backwards: ${T} < ${this.T}`);
    while (this.nextN + 1 <= T) {
      this.quantum(this.nextN);
      this.nextN += 1;
    }
    this.T = T;
  }

  snapshot(): EconomySnapshot {
    return {
      T: this.T,
      stocks: this.markets.map((row) => row.map((m) => m.S)),
      shipments: this.inflight.map((s) => ({ ...s })),
      fleetBusyUntil: this.fleetBusy.map((row) => row.slice()),
      frac: this.T - Math.floor(this.T),
    };
  }

  /**
   * Restores a snapshot into an economy built with the same seed, ports, doyAt and hands. Events are
   * cleared. Afterwards advancing matches the economy that took the snapshot, bit for bit.
   */
  restore(s: EconomySnapshot): void {
    const n = this.portList.length;
    const shapeOk =
      s.stocks.length === n &&
      s.stocks.every((row) => row.length === GOODS.length) &&
      s.fleetBusyUntil.length === n &&
      s.fleetBusyUntil.every((row, i) => row.length === fleetSize(this.portList[i].id));
    if (!shapeOk) throw new RangeError('economy snapshot does not match the ports');
    for (let pi = 0; pi < n; pi++) {
      for (let gi = 0; gi < GOODS.length; gi++) this.markets[pi][gi].S = s.stocks[pi][gi];
    }
    this.inflight = s.shipments.map((x) => ({ ...x }));
    this.fleetBusy = s.fleetBusyUntil.map((row) => row.slice());
    this.T = s.T;
    this.nextN = Math.floor(s.T);
    this.eventList = [];
  }

  private indexOf(port: number): number {
    const i = this.portIndex.get(port);
    if (i === undefined) throw new RangeError(`unknown port id ${port}`);
    return i;
  }

  private shock(pi: number, gi: number, T: number): ShockMultipliers {
    return this.noShocks ? ONE : this.tracks[pi][gi].at(T);
  }

  private routeHoursIdx(a: number, b: number): number {
    return ((this.distKm[a][b] * 1.25) / 7.2) * 60;
  }

  /** One quantum [n, n+1): arrivals, then the hourly relaxation, then midnight if it ends a day. */
  private quantum(n: number): void {
    this.applyArrivals(n);
    const tm = n + 0.5;
    const doy = this.doyAt(tm);
    for (let pi = 0; pi < this.markets.length; pi++) {
      for (let gi = 0; gi < GOODS.length; gi++) {
        const m = this.markets[pi][gi];
        if (!(m.D_ref > 0)) continue; // no demand: no stock dynamics
        const sh = this.shock(pi, gi, tm);
        const P = m.P_ref * season(m.good, doy) * sh.p;
        const D = m.D_ref * sh.d;
        m.relax(P, D);
      }
    }
    if ((n + 1) % 24 === 0) this.midnight(n + 1);
  }

  private midnight(T: number): void {
    if (!this.noShipments) this.npcShipments(T, T / 24);
    if (!this.prerun && this.hands > 0) {
      this.eventList.push({ type: 'wages', days: 1, amount: this.hands * WAGE_PER_HAND_DAY });
    }
  }

  /** Cargo that has reached its port by the start of quantum n. */
  private applyArrivals(n: number): void {
    if (this.inflight.length === 0) return;
    const keep: Shipment[] = [];
    for (const s of this.inflight) {
      if (s.arriveT <= n) {
        this.markets[this.indexOf(s.to)][goodIndex(s.good)].S += s.qty;
        if (!this.prerun) {
          this.eventList.push({ type: 'arrival', port: s.to, good: s.good, qty: s.qty, T: s.arriveT });
        }
      } else {
        keep.push(s);
      }
    }
    this.inflight = keep;
  }

  private idleShip(pi: number, T: number): number {
    const row = this.fleetBusy[pi];
    for (let k = 0; k < row.length; k++) if (row[k] <= T) return k;
    return -1;
  }

  /** NPC shipments at a midnight (§4.4): ordered pairs, then goods, in fixed order; one per pair and day. */
  private npcShipments(T: number, day: number): void {
    const N = this.portList.length;
    for (let a = 0; a < N; a++) {
      const A = this.portList[a];
      for (let b = 0; b < N; b++) {
        if (b === a) continue;
        const B = this.portList[b];
        const distKm = this.distKm[a][b];
        for (let gi = 0; gi < GOODS.length; gi++) {
          const g = GOODS[gi];
          const k = this.idleShip(a, T);
          if (k < 0) break;
          const mA = this.markets[a][gi];
          const mB = this.markets[b][gi];
          const freight = 10 + 3 * distKm * (g.mass / 40);
          const SBp = mB.S + this.inflightTo(B.id, g.id);
          const bidB = mB.bid(SBp);
          const askA = mA.ask(mA.S);
          const gap = bidB - askA * (1 + DUTY) - bidB * DUTY - freight;
          const ratio = gap / askA;
          if (!(ratio > 0.15)) continue;
          if (!(hash01(this.seed, A.id, B.id, gi, day) < Math.min(0.6, ratio - 0.15))) continue;
          const q = Math.floor(
            Math.min(SHIP_MAX_KG / g.mass, 0.25 * Math.max(0, mA.S - 0.3 * mA.S_ref), 0.4 * mB.S_ref),
          );
          if (!(q >= SHIP_MIN_UNITS)) continue;
          mA.S -= q;
          const h = this.routeHoursIdx(a, b);
          this.inflight.push({ from: A.id, to: B.id, good: g.id, qty: q, arriveT: T + h });
          this.fleetBusy[a][k] = T + 2 * h;
          break; // at most one shipment per pair and day
        }
      }
    }
  }
}
