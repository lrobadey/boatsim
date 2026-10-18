// The world's people and their money (expectations-mvp-spec §3.5, §6; pass-1b plan B): the three characters
// and where they stand, the cargo they hold in stores, and the midwinter-style celebration Philon buys wine
// for. Pure: plain data, no game imports. Money is integer centidrachmas.

import { referenceFlows, type EconActor, type EconPort, type Economy } from './economy';
import { goodById, goodIndex, type GoodId } from './goods';
import { walletMove, type CargoLot } from './books';
import { addRecord, type SocialRecord } from '../social/records';

export type CharacterId = 'damaris' | 'philon' | 'myrto';
/** who can hold a document or a record: a character or the player */
export type Holder = CharacterId | 'player';

export interface Character {
  id: CharacterId;
  /** the harbour whose stall this character keeps (−1: none) */
  port: number;
  /** centidrachmas; always the sum of this character's world receipts */
  wallet: number;
  /** centidrachmas of the wallet held for committed home handling (the sum of their agreements' reserved) */
  reserved: number;
  /** centidrachmas: the goods value they entrust before any record (spec §3.6) */
  trustBase: number;
  /** warmth before any record, −2..2 */
  warmth0: number;
}

/** One movement of a character's wallet (books.ts writes these). amount is signed, + into the wallet. */
export interface WorldReceipt {
  /** 'X{n}' from world.nextId */
  id: string;
  T: number;
  who: CharacterId;
  kind: 'opening' | 'porterage' | 'purchase' | 'sale' | 'remit';
  amount: number;
  agreement?: string;
  port?: number;
  qty?: number;
}

/** What a consignment agreement fixes (spec §3.3). perJar and homePort are set by trusted code. */
export interface Terms {
  good: GoodId;
  qty: number;
  /** centidrachmas per jar: homeValue at the owner's port when proposed */
  perJar: number;
  /** player's commission, percent of profit */
  share: 20;
  /** may the player sell the jars on the market or to another buyer */
  alternateSale: boolean;
  /** the named buyer the jars are meant for */
  buyer: CharacterId;
  /** the buyer's deadline (absolute hour) */
  opportunityT: number;
  /** the owner's port, where loading, return and settlement happen */
  homePort: number;
}

export interface ProposalRevision {
  revision: number;
  terms: Terms;
  T: number;
  status: 'open' | 'superseded' | 'accepted' | 'declined';
}

export interface Proposal {
  /** 'P{n}' */
  id: string;
  owner: CharacterId;
  /** oldest first; the last one is the current revision */
  revisions: ProposalRevision[];
}

export interface Agreement {
  /** 'A{n}' */
  id: string;
  proposal: string;
  revision: number;
  owner: CharacterId;
  terms: Terms;
  acceptedT: number;
  /** opportunityT + routeHours(buyer's port, homePort) + 72 */
  expectedT: number;
  /** units moved from her store to the quay (books.ts) */
  loaded: number;
  /** units sold, counted at confirm (books.ts) */
  sold: number;
  /** units committed to go back to her store (books.ts) */
  returned: number;
  /** centidrachmas of the owner's wallet still held for this agreement's home handling (books.ts) */
  reserved: number;
  closedT: number | null;
  /** set when settled in full */
  settledT: number | null;
}

/** A letter carried by NPC ship (MailActor): a sale's thanks, or word that the player showed a letter. */
export type Mail = {
  /** 'M{n}' */
  id: string;
  from: CharacterId;
  to: CharacterId;
  fromPort: number;
  toPort: number;
  writtenT: number;
  /** arrival of the ship carrying it, once one is found */
  deliverT: number | null;
  delivered: boolean;
} & (
  | { kind: 'heard-sale'; facts: { qty: number; unit: number; consignedQty: number; agreement?: string } }
  | { kind: 'letter-shown'; facts: { document: string; by: 'player' } }
);

/** A personal document (spec §3.1): an immutable body, structured claims, and who holds it now. */
export interface WorldDocument {
  /** 'D{n}' */
  id: string;
  kind: 'letter';
  from: CharacterId;
  to: CharacterId;
  writtenT: number;
  /** the text as written; shown to the model as a quotation, never as instructions */
  body: string;
  /** what the letter expressed when written, not a current order */
  claims: { good: GoodId; qty: number; byT: number; buyer: CharacterId };
  holder: Holder;
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
  version: 2;
  characters: Character[];
  /** every unit in a store; ids 'W{n}' */
  lots: CargoLot[];
  /** one counter for W, X, P, A, M, D and C (conversation) ids */
  nextId: number;
  celebration: Celebration | null;
  receipts: WorldReceipt[];
  proposals: Proposal[];
  agreements: Agreement[];
  records: SocialRecord[];
  mail: Mail[];
  documents: WorldDocument[];
  /** command results by request id (Dealings) */
  results: Record<string, unknown>;
}

/** A 1b save's world: upgradeWorld turns it into version 2. */
export interface WorldStateV1 {
  version: 1;
  characters: { id: CharacterId; port: number; wallet: number }[];
  lots: CargoLot[];
  nextId: number;
  celebration: Celebration | null;
}

/** Takes the next world id with this prefix. */
export function takeWorldId(world: WorldState, prefix: 'W' | 'X' | 'P' | 'A' | 'M' | 'D' | 'C'): string {
  return `${prefix}${world.nextId++}`;
}

/** A version 1 world with empty collections and one opening receipt per non-zero wallet. Pass 1c lane C2. */
export function upgradeWorld(w: WorldStateV1): WorldState {
  const world: WorldState = {
    version: 2,
    characters: w.characters.map((c) => ({ ...c, reserved: 0, trustBase: 0, warmth0: c.id === 'damaris' ? 1 : 0 })),
    lots: w.lots,
    nextId: w.nextId,
    celebration: w.celebration,
    ...emptyCollections(),
  };
  return withOpenings(world);
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
    { id: 'damaris', port: HOME, wallet: 0, reserved: 0, trustBase: 0, warmth0: 1 },
    { id: 'philon', port: philonPort, wallet: 0, reserved: 0, trustBase: 0, warmth0: 0 },
    { id: 'myrto', port: myrtoPort, wallet: 0, reserved: 0, trustBase: 0, warmth0: 0 },
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
    version: 2,
    characters,
    lots: [{ id: 'W1', good: WINE, qty: 40, owner: 'char:damaris', custody: { at: 'store', port: HOME }, origin: 'opening' }],
    nextId: 2,
    celebration: null,
    ...emptyCollections(),
  };
  characters.find((c) => c.id === 'damaris')!.wallet = 15000;
  if (celebPort === null) return withOpenings(world);

  const wineIdx = goodIndex(WINE);
  const portIdx = o.ports.findIndex((p) => p.id === celebPort);
  const D = referenceFlows(o.ports.map((p) => p.profile))[portIdx][wineIdx].D_ref;
  const requirement = Math.round(14 * D);
  const rulerPrice = Math.round(1.5 * goodById(WINE).pRef);
  const limit = Math.floor(0.85 * rulerPrice);
  characters.find((c) => c.id === 'philon')!.wallet = requirement * limit;
  const celebration: Celebration = {
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
  world.celebration = celebration;
  world.documents.push({
    id: takeWorldId(world, 'D'),
    kind: 'letter',
    from: 'philon',
    to: 'damaris',
    writtenT: Math.max(0, celebration.cutoffT - 20 * 24),
    body: PHILON_LETTER,
    claims: { good: WINE, qty: celebration.earmark, byT: celebration.cutoffT, buyer: 'philon' },
    holder: 'damaris',
  });
  return withOpenings(world);
}

/** Philon's letter to Damaris about the feast wine: written on a fresh voyage when there is a celebration. */
const PHILON_LETTER =
  "Damaris, the archon is holding the New Year feast on 1 Hekatombaion and I'm short of wine for it. If you can get forty jars to me before then, I'll take them. We'd settle the price when they're here, at what wine is fetching on the island. My regards to your boys. Philon";

/** One opening receipt per non-zero wallet, so each wallet equals its receipt sum. */
function withOpenings(world: WorldState): WorldState {
  for (const c of world.characters) {
    if (c.wallet !== 0) world.receipts.push({ id: takeWorldId(world, 'X'), T: 0, who: c.id, kind: 'opening', amount: c.wallet });
  }
  return world;
}

/** The people of an old save with no world: the cast, no money, no lots, no celebration. */
export function oldSaveWorld(ports: readonly EconPort[]): WorldState {
  return { version: 2, characters: castFor(ports, celebrationPort(ports)), lots: [], nextId: 1, celebration: null, ...emptyCollections() };
}

function emptyCollections() {
  return { receipts: [], proposals: [], agreements: [], records: [], mail: [], documents: [], results: {} };
}

/** Philon's wine jars in a list of lots. */
const philonWine = (lots: readonly CargoLot[]): number =>
  lots.filter((l) => l.good === WINE && l.owner === 'char:philon').reduce((a, l) => a + l.qty, 0);

/**
 * Philon's buying for the celebration, at each midnight. Before the fallback he buys wine at the celebration
 * port while his average price stays at or below the limit, keeping the earmark back; at the fallback he buys
 * the rest at any price the wallet allows, once; at the cutoff he takes up to the requirement from his store.
 * voyageLots gives the lots aboard and on the quay: jars he holds there count as his, and at the cutoff they are
 * written down as undelivered.
 */
export class CelebrationActor implements EconActor {
  constructor(
    private world: WorldState,
    private voyageLots: () => CargoLot[] = () => [],
  ) {}

  onMidnight(T: number, econ: Economy): void {
    const c = this.world.celebration;
    if (!c || c.done) return;
    const philon = this.world.characters.find((ch) => ch.id === 'philon')!;
    const owned = () => philonWine(this.world.lots) + philonWine(this.voyageLots());

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
      const n = philonWine(this.voyageLots());
      if (n > 0) addRecord(this.world, { id: `philon:undelivered:${c.cutoffT}`, holder: 'philon', T: c.cutoffT, source: 'witnessed', kind: 'undelivered', facts: { qty: n } });
      c.done = true;
      return;
    }
    if (T >= c.fallbackT && !c.fallbackDone) {
      c.fallbackDone = true;
      this.buy(econ, c, philon, c.requirement - owned(), false, T);
      return;
    }
    if (T < c.fallbackT) this.buy(econ, c, philon, c.requirement - c.earmark - owned(), true, T);
  }

  /** Buys the largest number of jars up to need that the free wallet covers (and, when priced, the limit). */
  private buy(econ: Economy, c: Celebration, philon: Character, need: number, priced: boolean, T: number): void {
    if (need <= 0) return;
    const m = econ.market(c.port, WINE);
    const cap = Math.min(need, Math.floor(m.maxBuy()));
    const ok = (n: number): boolean => {
      if (n === 0) return true;
      const q = m.quoteBuy(n);
      return q.total <= philon.wallet - philon.reserved && (!priced || q.total <= n * c.limit);
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
    walletMove(this.world, 'philon', -q.total, 'purchase', T, { port: c.port, qty: lo });
    this.world.lots.push({
      id: takeWorldId(this.world, 'W'),
      good: WINE,
      qty: lo,
      owner: 'char:philon',
      custody: { at: 'store', port: c.port },
      origin: 'purchase',
    });
  }
}

/**
 * Letters carried by NPC ships (expectations-mvp-spec §3.6, docs/pass-1c-plan.md C2): a letter is delivered on
 * the earliest shipment from its port to the recipient's port that left after it was written. The recipient
 * hears of the sale at that arrival, as news.
 */
export class MailActor implements EconActor {
  constructor(private world: WorldState) {}

  onMidnight(T: number, econ: Economy): void {
    for (const m of this.world.mail) {
      if (m.deliverT !== null) continue;
      let best: number | null = null;
      for (const s of econ.shipments) {
        if (s.from !== m.fromPort || s.to !== m.toPort) continue;
        if (s.arriveT - econ.routeHours(s.from, s.to) < m.writtenT - 1e-6) continue;
        if (best === null || s.arriveT < best) best = s.arriveT;
      }
      if (best !== null) m.deliverT = best;
    }
    for (const m of this.world.mail) {
      if (m.delivered || m.deliverT === null || m.deliverT > T) continue;
      // 1c mail has no kind: it is always a sale's thanks
      if (m.kind === 'letter-shown') addRecord(this.world, { id: `${m.to}:letter-shown:${m.id}`, holder: m.to, T: m.deliverT, source: 'news', kind: 'letter-shown', facts: { ...m.facts } });
      else addRecord(this.world, { id: `${m.to}:heard-sale:${m.id}`, holder: m.to, T: m.deliverT, source: 'news', kind: 'heard-sale', facts: { ...(m.facts as Extract<Mail, { kind: 'heard-sale' }>['facts']) } });
      m.delivered = true;
    }
  }
}
