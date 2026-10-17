// The world's people and their money (expectations-mvp-spec §3.5, §6; pass-1b plan B): the three characters
// and where they stand, the cargo they hold in stores, and the midwinter-style celebration Philon buys wine
// for. Pure: plain data, no game imports. Money is integer centidrachmas.

import { referenceFlows, type EconActor, type EconPort, type Economy } from './economy';
import { goodById, goodIndex } from './goods';
import type { CargoLot } from './books';

export type CharacterId = 'damaris' | 'philon' | 'myrto';

export interface Character {
  id: CharacterId;
  /** the harbour whose stall this character keeps (−1: none) */
  port: number;
  /** centidrachmas */
  wallet: number;
}

/** The celebration Philon buys wine for, at one port, on one day. Hours are absolute game hours. */
export interface Celebration {
  port: number;
  /** whole day (dayCount) of the celebration */
  day: number;
  /** the wine is consumed at this hour */
  cutoffT: number;
  /** from this hour Philon may buy at any price, once */
  fallbackT: number;
  /** jars of wine needed */
  requirement: number;
  /** centidrachmas: the ruler's reference price per jar */
  rulerPrice: number;
  /** centidrachmas per jar: the most Philon pays before the fallback */
  limit: number;
  /** jars held back from buying before the fallback, for the day's own needs */
  earmark: number;
  fallbackDone: boolean;
  done: boolean;
  /** jars taken from Philon's store at the cutoff */
  consumed: number;
  /** jars still missing at the cutoff */
  shortfall: number;
}

export interface WorldState {
  version: 1;
  characters: Character[];
  lots: CargoLot[];
  nextId: number;
  celebration: Celebration | null;
}

const WINE = 'wine' as const;
const HOME = 0;
const FALLBACK_HOURS = 72;

const idNumber = (id: string): number => Number(id.slice(1));

/**
 * The port that holds the celebration: among the ports other than the home harbour, the one where wine is
 * cheapest against its demand (lowest P_ref / D_ref); ties go to the lowest id. Null when none has wine demand.
 */
export function celebrationPort(ports: readonly EconPort[]): number | null {
  const flows = referenceFlows(ports.map((p) => p.profile));
  const wi = goodIndex(WINE);
  let best: { id: number; ratio: number } | null = null;
  for (let i = 0; i < ports.length; i++) {
    const p = ports[i];
    const f = flows[i][wi];
    if (p.id === HOME || !(f.D_ref > 0)) continue;
    const ratio = f.P_ref / f.D_ref;
    if (best === null || ratio < best.ratio || (ratio === best.ratio && p.id < best.id)) best = { id: p.id, ratio };
  }
  return best?.id ?? null;
}

/**
 * The cast: Damaris keeps the home stall; Philon keeps the celebration port (or the lowest other port when
 * there is none); Myrto keeps the lowest port that is neither (−1 when there is none). Wallets start at 0.
 */
export function castFor(ports: readonly EconPort[], celebration: number | null): Character[] {
  const ids = ports.map((p) => p.id);
  const others = ids.filter((id) => id !== HOME);
  const philonPort = celebration ?? (others.length > 0 ? Math.min(...others) : -1);
  const rest = ids.filter((id) => id !== HOME && id !== philonPort);
  const myrtoPort = rest.length > 0 ? Math.min(...rest) : -1;
  return [
    { id: 'damaris', port: HOME, wallet: 0 },
    { id: 'philon', port: philonPort, wallet: 0 },
    { id: 'myrto', port: myrtoPort, wallet: 0 },
  ];
}

/** The character who keeps a port's stall; Myrto when no one does. */
export function characterAt(world: WorldState, port: number): CharacterId {
  return world.characters.find((c) => c.port === port)?.id ?? 'myrto';
}

/**
 * A new voyage's people and money: Damaris starts with 150 dr and 40 jars of wine in her store at the home
 * harbour. When there is a celebration port, Philon's wallet covers the requirement at the limit price, and the
 * celebration is set for celebrationDay (whole day), its cutoff at the start of that day's hour 0 and its
 * fallback 72 hours earlier.
 */
export function freshWorld(o: { ports: readonly EconPort[]; celebrationDay: number }): WorldState {
  const celebPort = celebrationPort(o.ports);
  const characters = castFor(o.ports, celebPort);
  const world: WorldState = {
    version: 1,
    characters,
    lots: [{ id: 'W1', good: WINE, qty: 40, owner: 'char:damaris', custody: { at: 'store', port: HOME }, origin: 'opening' }],
    nextId: 2,
    celebration: null,
  };
  characters.find((c) => c.id === 'damaris')!.wallet = 15000;
  if (celebPort === null) return world;

  const wineIdx = goodIndex(WINE);
  const portIdx = o.ports.findIndex((p) => p.id === celebPort);
  const D = referenceFlows(o.ports.map((p) => p.profile))[portIdx][wineIdx].D_ref;
  const requirement = Math.round(14 * D);
  const rulerPrice = Math.round(1.5 * goodById(WINE).pRef);
  const limit = Math.floor(0.85 * rulerPrice);
  characters.find((c) => c.id === 'philon')!.wallet = requirement * limit;
  world.celebration = {
    port: celebPort,
    day: o.celebrationDay,
    cutoffT: o.celebrationDay * 24,
    fallbackT: o.celebrationDay * 24 - FALLBACK_HOURS,
    requirement,
    rulerPrice,
    limit,
    earmark: 40,
    fallbackDone: false,
    done: false,
    consumed: 0,
    shortfall: 0,
  };
  return world;
}

/** The people of an old save with no world: the cast, no money, no lots, no celebration. */
export function oldSaveWorld(ports: readonly EconPort[]): WorldState {
  return { version: 1, characters: castFor(ports, celebrationPort(ports)), lots: [], nextId: 1, celebration: null };
}

/**
 * Philon's buying for the celebration, at each midnight. Before the fallback he buys wine at the celebration
 * port while his average price stays at or below the limit, keeping the earmark back; at the fallback he buys
 * the rest at any price the wallet allows, once; at the cutoff he takes up to the requirement from his store.
 * ownedElsewhere counts jars he holds outside the world's lots (none by default).
 */
export class CelebrationActor implements EconActor {
  constructor(
    private world: WorldState,
    private ownedElsewhere: () => number = () => 0,
  ) {}

  onMidnight(T: number, econ: Economy): void {
    const c = this.world.celebration;
    if (!c || c.done) return;
    const philon = this.world.characters.find((ch) => ch.id === 'philon')!;
    const owned = () =>
      this.world.lots
        .filter((l) => l.good === WINE && l.owner === 'char:philon')
        .reduce((a, l) => a + l.qty, 0) + this.ownedElsewhere();

    if (T >= c.cutoffT) {
      const mine = this.world.lots
        .filter((l) => l.good === WINE && l.owner === 'char:philon' && l.custody.at === 'store')
        .sort((a, b) => idNumber(a.id) - idNumber(b.id));
      let left = c.requirement;
      for (const l of mine) {
        if (left <= 0) break;
        const t = Math.min(l.qty, left);
        l.qty -= t;
        left -= t;
      }
      this.world.lots = this.world.lots.filter((l) => l.qty > 0);
      c.consumed = c.requirement - left;
      c.shortfall = left;
      c.done = true;
      return;
    }
    if (T >= c.fallbackT && !c.fallbackDone) {
      c.fallbackDone = true;
      this.buy(econ, c, philon, c.requirement - owned(), false);
      return;
    }
    if (T < c.fallbackT) this.buy(econ, c, philon, c.requirement - c.earmark - owned(), true);
  }

  /** Buys the largest number of jars up to need that the wallet covers (and, when priced, the limit). */
  private buy(econ: Economy, c: Celebration, philon: Character, need: number, priced: boolean): void {
    if (need <= 0) return;
    const m = econ.market(c.port, WINE);
    const cap = Math.min(need, Math.floor(m.maxBuy()));
    const ok = (n: number): boolean => {
      if (n === 0) return true;
      const q = m.quoteBuy(n);
      return q.total <= philon.wallet && (!priced || q.total <= n * c.limit);
    };
    let lo = 0;
    let hi = cap;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (ok(mid)) lo = mid;
      else hi = mid - 1;
    }
    if (lo === 0) return;
    const q = m.buy(lo);
    philon.wallet -= q.total;
    this.world.lots.push({
      id: `W${this.world.nextId++}`,
      good: WINE,
      qty: lo,
      owner: 'char:philon',
      custody: { at: 'store', port: c.port },
      origin: 'purchase',
    });
  }
}
