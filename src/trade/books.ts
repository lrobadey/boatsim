// The player's books (expectations-mvp-spec §3.2 and §3.4, docs/pass-1a-contract.md): cargo lots with an
// owner and a custody, and a receipt for every money movement. This module is the only writer of
// voyage.purse, voyage.manifest, voyage.lots, voyage.receipts and voyage.nextId; purse and manifest are
// maintained views that always equal the receipt sum and the lots aboard. Pure: plain data, no game imports.

import { GOOD_IDS, type GoodId } from './goods';
import type { Units } from './job';
import type { CargoJob, VoyageState } from './voyage';
import type { CharacterId, WorldReceipt, WorldState } from './world';

export type OwnerId = 'player' | `market:${number}` | `char:${string}`;
export type Custody = { at: 'aboard' } | { at: 'quay'; port: number; berth: number } | { at: 'store'; port: number };

export interface CargoLot {
  /** 'L1', 'L2', … from voyage.nextId; never reused */
  id: string;
  good: GoodId;
  /** safe integer > 0; a lot that reaches 0 is removed */
  qty: number;
  owner: OwnerId;
  custody: Custody;
  /** 'opening', 'migrated', the id of the receipt that created it, or the lot it moved from */
  origin: string;
  /** a consigned unit's agreement ('A3'): kept through every move, also after a sale, until it lands back in the owner's store */
  agreement?: string;
  /** committed to the job: 'load' waits on the quay to come aboard, 'unload' is aboard and goes ashore */
  moving?: 'load' | 'unload';
  /** absolute hour by which a named buyer's units must land */
  due?: number;
}

export type ReceiptKind = 'opening' | 'sale' | 'purchase' | 'duty' | 'porterage' | 'wages' | 'remit';
const RECEIPT_KINDS: readonly ReceiptKind[] = ['opening', 'sale', 'purchase', 'duty', 'porterage', 'wages'];

export interface Receipt {
  /** 'R1', 'R2', … from voyage.nextId (one counter for lots and receipts) */
  id: string;
  /** absolute game hour */
  T: number;
  kind: ReceiptKind;
  /** signed integer centidrachmas, + into the purse */
  amount: number;
  port?: number;
  good?: GoodId;
  qty?: number;
  lot?: string;
  agreement?: string;
  /** the counterparty */
  party?: OwnerId;
}

const PLAYER: OwnerId = 'player';
const ABOARD: Custody = { at: 'aboard' };
const marketOwner = (port: number): OwnerId => `market:${port}`;
const isMarket = (owner: OwnerId): boolean => owner !== PLAYER;
const idNumber = (id: string): number => Number(id.slice(1));

function takeId(v: VoyageState, prefix: 'L' | 'R'): string {
  const id = `${prefix}${v.nextId}`;
  v.nextId++;
  return id;
}

/** Records a receipt and moves the purse by its amount. */
function post(v: VoyageState, r: Omit<Receipt, 'id'>, id = takeId(v, 'R')): Receipt {
  const receipt: Receipt = { id, ...r };
  v.receipts.push(receipt);
  v.purse += r.amount;
  return receipt;
}

/** Units aboard (any owner) change by n; the manifest drops keys that reach 0, as it always has. */
function addAboard(v: VoyageState, good: GoodId, n: number): void {
  v.manifest[good] = (v.manifest[good] ?? 0) + n;
  if ((v.manifest[good] ?? 0) === 0) delete v.manifest[good];
}

function addLot(v: VoyageState, good: GoodId, qty: number, owner: OwnerId, custody: Custody, origin: string): CargoLot {
  const lot: CargoLot = { id: takeId(v, 'L'), good, qty, owner, custody: { ...custody }, origin };
  v.lots.push(lot);
  return lot;
}

function takeFrom(v: VoyageState, lot: CargoLot, n: number): void {
  lot.qty -= n;
  if (lot.qty === 0) v.lots.splice(v.lots.indexOf(lot), 1);
}

const sameCustody = (a: Custody, b: Custody): boolean =>
  a.at === 'aboard' ? b.at === 'aboard' : a.at === 'quay' && b.at === 'quay' && a.port === b.port && a.berth === b.berth;

/** The lot with the lowest id among those that match. */
function oldest(v: VoyageState, match: (l: CargoLot) => boolean): CargoLot | undefined {
  let best: CargoLot | undefined;
  for (const l of v.lots) if (match(l) && (!best || idNumber(l.id) < idNumber(best.id))) best = l;
  return best;
}

/** Adds one unit to the lot of this owner, custody and origin, created if absent. */
function addUnit(v: VoyageState, good: GoodId, owner: OwnerId, custody: Custody, origin: string): void {
  const lot = v.lots.find((l) => l.good === good && l.owner === owner && l.origin === origin && sameCustody(l.custody, custody));
  if (lot) lot.qty++;
  else addLot(v, good, 1, owner, custody, origin);
}

/**
 * Clears lots, receipts and the job: one opening receipt for `purse` and one player lot aboard per good
 * in `cargo`. Test setup and the dev review modes use it in place of assigning purse or manifest.
 */
export function resetBooks(v: VoyageState, o: { purse: number; cargo: Units; T?: number }): void {
  const T = o.T ?? 0;
  v.lots = [];
  v.receipts = [];
  v.nextId = 1;
  v.job = null;
  v.purse = 0;
  v.manifest = {};
  post(v, { T, kind: 'opening', amount: o.purse });
  for (const good of GOOD_IDS) {
    const n = o.cargo[good] ?? 0;
    if (n <= 0) continue;
    addLot(v, good, n, PLAYER, ABOARD, 'opening');
    v.manifest[good] = n;
  }
}

/**
 * Replaces lots, receipts and nextId from the legacy fields as they stand (purse, manifest, job), with
 * origin 'migrated': the purse becomes one opening receipt; per good, the player owns what is aboard less
 * the units sold but not yet landed, which belong to the market of the job's port; on the quay, bought
 * units still to load are the player's and the rest are landed units waiting for the cart. Never throws
 * and never validates; purse and manifest are left as they are.
 */
export function rebuildBooks(v: VoyageState, T = 0): void {
  const purse = v.purse;
  v.lots = [];
  v.receipts = [];
  v.nextId = 1;
  v.purse = 0;
  post(v, { T, kind: 'opening', amount: purse });
  const job = v.job as Partial<CargoJob> | null;
  const manifest = v.manifest ?? {};
  const count = (rec: Units | undefined, good: GoodId) => rec?.[good] ?? 0;
  const market = job && typeof job.port === 'number' ? marketOwner(job.port) : null;
  const quay: Custody | null = market ? { at: 'quay', port: job!.port!, berth: job!.berth! } : null;
  const outgoing = (good: GoodId) => (market ? count(job!.outgoing, good) : 0);
  for (const good of GOOD_IDS) {
    const n = Math.max(0, count(manifest, good) - outgoing(good));
    if (n > 0) addLot(v, good, n, PLAYER, ABOARD, 'migrated');
  }
  if (!market || !quay) return;
  for (const good of GOOD_IDS) {
    const n = Math.min(outgoing(good), count(manifest, good));
    if (n > 0) addLot(v, good, n, market, ABOARD, 'migrated');
  }
  for (const good of GOOD_IDS) {
    const n = Math.min(count(job!.incoming, good), count(job!.quay, good));
    if (n > 0) addLot(v, good, n, PLAYER, quay, 'migrated');
  }
  for (const good of GOOD_IDS) {
    const n = count(job!.quay, good) - Math.min(count(job!.incoming, good), count(job!.quay, good));
    if (n > 0) addLot(v, good, n, market, quay, 'migrated');
  }
}

/**
 * A confirmed sale of qty units of good at port: the receipts for the sale (gross, duty included) and the
 * duty, and the units move from the player's lots aboard (lowest id first) to one market lot aboard.
 * q is the market's quote; the receipts sum to q.total.
 */
export function recordSale(v: VoyageState, o: { port: number; good: GoodId; qty: number; total: number; duty: number; T: number }): void {
  let left = o.qty;
  while (left > 0) {
    const from = oldest(v, (l) => l.good === o.good && l.owner === PLAYER && l.custody.at === 'aboard');
    if (!from) throw new RangeError(`sale of ${o.qty} ${o.good} exceeds the player's cargo aboard`);
    const n = Math.min(left, from.qty);
    takeFrom(v, from, n);
    left -= n;
  }
  const saleId = takeId(v, 'R');
  const lot = addLot(v, o.good, o.qty, marketOwner(o.port), ABOARD, saleId);
  const line = { port: o.port, good: o.good, qty: o.qty, lot: lot.id };
  post(v, { T: o.T, kind: 'sale', amount: o.total + o.duty, ...line }, saleId);
  post(v, { T: o.T, kind: 'duty', amount: -o.duty, ...line });
}

/**
 * A confirmed purchase of qty units of good at port: the receipts for the purchase (before duty) and the
 * duty, and a new player lot waiting on the quay at the berth. The receipts sum to −q.total.
 */
export function recordPurchase(v: VoyageState, o: { port: number; berth: number; good: GoodId; qty: number; total: number; duty: number; T: number }): void {
  const purchaseId = takeId(v, 'R');
  const lot = addLot(v, o.good, o.qty, PLAYER, { at: 'quay', port: o.port, berth: o.berth }, purchaseId);
  const line = { port: o.port, good: o.good, qty: o.qty, lot: lot.id };
  post(v, { T: o.T, kind: 'purchase', amount: -(o.total - o.duty), ...line }, purchaseId);
  post(v, { T: o.T, kind: 'duty', amount: -o.duty, ...line });
}

/**
 * One sold unit lands: it leaves the oldest market lot aboard for that market's lot on the quay at the
 * job's berth (same origin), where it waits for the cart. Returns the id of the lot it left.
 */
export function landUnit(v: VoyageState, job: CargoJob, good: GoodId): string {
  const from = oldest(v, (l) => l.good === good && isMarket(l.owner) && l.custody.at === 'aboard');
  if (!from) throw new RangeError(`no sold ${good} aboard to land`);
  takeFrom(v, from, 1);
  addUnit(v, good, from.owner, { at: 'quay', port: job.port, berth: job.berth }, from.origin);
  addAboard(v, good, -1);
  return from.id;
}

/** One bought unit is stowed: it leaves the oldest player lot on the quay for the player lot aboard with the same origin. Returns the id of the lot it left. */
export function stowUnit(v: VoyageState, good: GoodId): string {
  const from = oldest(v, (l) => l.good === good && l.owner === PLAYER && l.custody.at === 'quay');
  if (!from) throw new RangeError(`no bought ${good} on the quay to stow`);
  takeFrom(v, from, 1);
  addUnit(v, good, PLAYER, ABOARD, from.origin);
  addAboard(v, good, 1);
  return from.id;
}

/** Porterage receipts: one per lot, for the units moved from it (fee is per unit, centidrachmas). */
export function recordPorterage(v: VoyageState, port: number, T: number, moves: Iterable<{ lot: string; good: GoodId; qty: number; fee: number }>): void {
  for (const m of moves) post(v, { T, kind: 'porterage', amount: -(m.fee * m.qty), port, good: m.good, qty: m.qty, lot: m.lot });
}

/** The wages paid in one tick (centidrachmas, > 0 to record). */
export function recordWages(v: VoyageState, amount: number, T: number): void {
  if (amount !== 0) post(v, { T, kind: 'wages', amount: -amount });
}

/** The job ended (the cart cleared, or cast-off with nothing pending): the buyers take their landed units. */
export function releaseLanded(v: VoyageState): void {
  for (let i = v.lots.length - 1; i >= 0; i--) {
    const l = v.lots[i];
    if (isMarket(l.owner) && l.custody.at === 'quay') v.lots.splice(i, 1);
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const knownGood = (x: unknown): x is GoodId => typeof x === 'string' && (GOOD_IDS as readonly string[]).includes(x);
const isOwner = (x: unknown): x is OwnerId => x === PLAYER || (typeof x === 'string' && /^market:(0|[1-9]\d*)$/.test(x));
function isCustody(x: unknown): x is Custody {
  if (!isObj(x)) return false;
  if (x.at === 'aboard') return true;
  return x.at === 'quay' && Number.isSafeInteger(x.port) && Number.isSafeInteger(x.berth);
}

/** Throws a RangeError naming the first broken invariant of the books (docs/pass-1a-contract.md §3). */
export function checkBooks(v: VoyageState): void {
  if (!Array.isArray(v.lots) || !Array.isArray(v.receipts)) throw new RangeError('books: lots and receipts must be lists');
  if (!Number.isSafeInteger(v.nextId)) throw new RangeError(`books: nextId ${String(v.nextId)} is not a safe integer`);
  const ids = new Set<string>();
  const checkId = (id: unknown, prefix: 'L' | 'R') => {
    if (typeof id !== 'string' || !new RegExp(`^${prefix}\\d+$`).test(id)) throw new RangeError(`books: malformed id ${String(id)}`);
    if (ids.has(id)) throw new RangeError(`books: duplicate id ${id}`);
    ids.add(id);
    if (idNumber(id) >= v.nextId) throw new RangeError(`books: nextId ${v.nextId} is not above id ${id}`);
  };
  for (const l of v.lots as unknown[]) {
    if (!isObj(l)) throw new RangeError('books: malformed lot');
    checkId(l.id, 'L');
    if (!knownGood(l.good)) throw new RangeError(`books: lot ${String(l.id)} has unknown good ${String(l.good)}`);
    if (!Number.isSafeInteger(l.qty) || (l.qty as number) <= 0) throw new RangeError(`books: lot ${String(l.id)} qty ${String(l.qty)} is not a positive safe integer`);
    if (!isOwner(l.owner)) throw new RangeError(`books: lot ${String(l.id)} has unknown owner ${String(l.owner)}`);
    if (!isCustody(l.custody)) throw new RangeError(`books: lot ${String(l.id)} has malformed custody`);
    if (typeof l.origin !== 'string') throw new RangeError(`books: lot ${String(l.id)} has no origin`);
  }
  let sum = 0;
  for (const r of v.receipts as unknown[]) {
    if (!isObj(r)) throw new RangeError('books: malformed receipt');
    checkId(r.id, 'R');
    if (!RECEIPT_KINDS.includes(r.kind as ReceiptKind)) throw new RangeError(`books: receipt ${String(r.id)} has unknown kind ${String(r.kind)}`);
    if (typeof r.amount !== 'number' || !Number.isFinite(r.amount)) throw new RangeError(`books: receipt ${String(r.id)} amount ${String(r.amount)} is not finite`);
    if (typeof r.T !== 'number' || !Number.isFinite(r.T)) throw new RangeError(`books: receipt ${String(r.id)} time is not finite`);
    sum += r.amount;
  }
  if (sum !== v.purse) throw new RangeError(`books: purse ${v.purse} differs from the receipt sum ${sum}`);

  if (!isObj(v.manifest)) throw new RangeError('books: malformed manifest');
  for (const [key, n] of Object.entries(v.manifest)) {
    if (!knownGood(key) || !Number.isSafeInteger(n) || (n as number) <= 0) throw new RangeError(`books: manifest ${key} ${String(n)} is not a positive count of a known good`);
  }
  const job = v.job;
  for (const good of GOOD_IDS) {
    let aboard = 0;
    let playerQuay = 0;
    let marketQuay = 0;
    let marketAboard = 0;
    for (const l of v.lots) {
      if (l.good !== good) continue;
      if (l.custody.at === 'aboard') {
        aboard += l.qty;
        if (isMarket(l.owner)) marketAboard += l.qty;
      } else if (isMarket(l.owner)) marketQuay += l.qty;
      else playerQuay += l.qty;
    }
    const m = v.manifest[good] ?? 0;
    if (m !== aboard) throw new RangeError(`books: manifest ${good} ${m} differs from the lots aboard ${aboard}`);
    const incoming = job?.incoming[good] ?? 0;
    const landed = (job?.quay[good] ?? 0) - incoming;
    const outgoing = job?.outgoing[good] ?? 0;
    if (playerQuay !== incoming) throw new RangeError(`books: player quay lots of ${good} (${playerQuay}) differ from job.incoming (${incoming})`);
    if (marketQuay !== landed) throw new RangeError(`books: market quay lots of ${good} (${marketQuay}) differ from job.quay − job.incoming (${landed})`);
    if (marketAboard !== outgoing) throw new RangeError(`books: market lots aboard of ${good} (${marketAboard}) differ from job.outgoing (${outgoing})`);
  }
}

// ---------- Pass 1c (docs/pass-1c-plan.md A): stubs, implemented by lane A ----------

const todo = (): never => {
  throw new Error('not implemented: Pass 1c A');
};

/**
 * Moves a character's wallet by amount (+ in) and writes a world receipt. Throws if wallet − reserved would go
 * below 0, unless fromReserved: then amount must be ≤ 0, −amount ≤ reserved, and reserved (and the agreement's
 * reserved, when extra.agreement is set) fall by −amount.
 */
export function walletMove(
  _world: WorldState,
  _who: CharacterId,
  _amount: number,
  _kind: WorldReceipt['kind'],
  _T: number,
  _extra?: { agreement?: string; port?: number; qty?: number; fromReserved?: boolean },
): WorldReceipt {
  return todo();
}

/** Holds amount of the owner's free wallet for the agreement (character and agreement reserved both rise). Throws if wallet − reserved < amount. */
export function reserveFor(_world: WorldState, _agreementId: string, _amount: number): void {
  todo();
}

/** Releases what is still reserved for the agreement. */
export function releaseReserve(_world: WorldState, _agreementId: string): void {
  todo();
}

/** Splits qty of the owner's unallocated store wine at port into a store lot carrying the agreement. Throws if short. */
export function allocateStore(_world: WorldState, _agreementId: string): void {
  todo();
}

/** Moves every store unit allocated to the agreement into one quay lot at the job's berth, marked 'load'; adds them to job.incoming and job.quay. */
export function loadFromStore(_v: VoyageState, _world: WorldState, _job: CargoJob, _agreementId: string, _T: number): void {
  todo();
}

/** A sale to a named buyer: the units become the buyer's aboard, marked 'unload' with due; receipts sale (+total, party) and duty (−duty); the buyer's wallet −total. */
export function recordNamedSale(
  _v: VoyageState,
  _world: WorldState,
  _job: CargoJob,
  _o: { buyer: CharacterId; port: number; good: GoodId; qty: number; total: number; duty: number; due: number; from: 'player' | string; T: number },
): void {
  todo();
}

/** recordSale for the agreement's jars aboard: total is net of duty, as in recordSale; receipts and the market lot carry the agreement. */
export function recordConsignedMarketSale(
  _v: VoyageState,
  _world: WorldState,
  _job: CargoJob,
  _o: { agreement: string; port: number; good: GoodId; qty: number; total: number; duty: number; T: number },
): void {
  todo();
}

/** qty of the agreement's jars aboard (hers, not moving) are marked 'unload' to go back to her store. */
export function recordReturn(_v: VoyageState, _world: WorldState, _job: CargoJob, _agreementId: string, _qty: number): void {
  todo();
}

/** A payment to the owner: purse receipt −amount (kind 'remit', agreement, party), and +amount into her wallet. */
export function recordRemit(_v: VoyageState, _world: WorldState, _agreementId: string, _amount: number, _T: number): void {
  todo();
}

/** Lots from 1a/1b saves: market lots aboard without moving get 'unload', player lots on the quay get 'load'. */
export function normalizeLots(_v: VoyageState): void {
  todo();
}

/** Throws a RangeError naming the first broken world invariant (docs/pass-1c-plan.md, checkWorld). */
export function checkWorld(_world: WorldState, _v: VoyageState): void {
  todo();
}
