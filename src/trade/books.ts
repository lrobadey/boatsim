// The player's books (expectations-mvp-spec §3.2 and §3.4, docs/pass-1a-contract.md): cargo lots with an
// owner and a custody, and a receipt for every money movement. This module is the only writer of
// voyage.purse, voyage.manifest, voyage.lots, voyage.receipts and voyage.nextId; purse and manifest are
// maintained views that always equal the receipt sum and the lots aboard. Pure: plain data, no game imports.

import { GOOD_IDS, type GoodId } from './goods';
import type { Units } from './job';
import type { CargoJob, VoyageState } from './voyage';
import { takeWorldId, type Agreement, type Character, type CharacterId, type WorldReceipt, type WorldState } from './world';

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
const RECEIPT_KINDS: readonly ReceiptKind[] = ['opening', 'sale', 'purchase', 'duty', 'porterage', 'wages', 'remit'];

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

/** The tags a lot can carry beyond its identity; unset tags are left off the lot. */
interface Tags {
  agreement?: string;
  moving?: 'load' | 'unload';
  due?: number;
}

const PLAYER: OwnerId = 'player';
const ABOARD: Custody = { at: 'aboard' };
const marketOwner = (port: number): OwnerId => `market:${port}`;
const ownerOf = (who: CharacterId): OwnerId => `char:${who}`;
const isMarket = (owner: OwnerId): boolean => owner.startsWith('market:');
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

function addLot(v: VoyageState, good: GoodId, qty: number, owner: OwnerId, custody: Custody, origin: string, tags: Tags = {}): CargoLot {
  const lot: CargoLot = { id: takeId(v, 'L'), good, qty, owner, custody: { ...custody }, origin };
  if (tags.agreement !== undefined) lot.agreement = tags.agreement;
  if (tags.moving !== undefined) lot.moving = tags.moving;
  if (tags.due !== undefined) lot.due = tags.due;
  v.lots.push(lot);
  return lot;
}

function takeFrom(v: VoyageState, lot: CargoLot, n: number): void {
  lot.qty -= n;
  if (lot.qty === 0) v.lots.splice(v.lots.indexOf(lot), 1);
}

const sameCustody = (a: Custody, b: Custody): boolean => {
  if (a.at === 'aboard') return b.at === 'aboard';
  if (a.at === 'store') return b.at === 'store' && a.port === b.port;
  return b.at === 'quay' && a.port === b.port && a.berth === b.berth;
};

const sameTags = (l: CargoLot, t: Tags): boolean => l.agreement === t.agreement && l.moving === t.moving && l.due === t.due;

/** The lot with the lowest id among those that match. */
function oldest(v: VoyageState, match: (l: CargoLot) => boolean): CargoLot | undefined {
  let best: CargoLot | undefined;
  for (const l of v.lots) if (match(l) && (!best || idNumber(l.id) < idNumber(best.id))) best = l;
  return best;
}

/** The units of the lots that match. */
function available(v: VoyageState, match: (l: CargoLot) => boolean): number {
  let n = 0;
  for (const l of v.lots) if (match(l)) n += l.qty;
  return n;
}

/** Takes n units from the matching lots, lowest id first. Returns the id of the first lot taken from. Throws if short. */
function takeOldest(v: VoyageState, match: (l: CargoLot) => boolean, n: number): string {
  if (available(v, match) < n) throw new RangeError(`books: ${n} units to take are not all there`);
  let left = n;
  let first: string | undefined;
  while (left > 0) {
    const from = oldest(v, match);
    if (!from) throw new RangeError(`books: ${n} units to take are not all there`);
    first ??= from.id;
    const k = Math.min(left, from.qty);
    takeFrom(v, from, k);
    left -= k;
  }
  return first!;
}

/** Adds one unit to the lot of this owner, custody, origin and tags, created if absent. */
function addUnit(v: VoyageState, good: GoodId, owner: OwnerId, custody: Custody, origin: string, tags: Tags = {}): void {
  const lot = v.lots.find((l) => l.good === good && l.owner === owner && l.origin === origin && sameCustody(l.custody, custody) && sameTags(l, tags));
  if (lot) lot.qty++;
  else addLot(v, good, 1, owner, custody, origin, tags);
}

function agreementOf(world: WorldState, id: string): Agreement {
  const a = world.agreements.find((x) => x.id === id);
  if (!a) throw new RangeError(`unknown agreement ${id}`);
  return a;
}

function characterOf(world: WorldState, id: CharacterId): Character {
  const c = world.characters.find((x) => x.id === id);
  if (!c) throw new RangeError(`unknown character ${id}`);
  return c;
}

function needWorld(world: WorldState | null): WorldState {
  if (!world) throw new RangeError('this movement needs the world');
  return world;
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
    if (n > 0) addLot(v, good, n, market, ABOARD, 'migrated', { moving: 'unload' });
  }
  for (const good of GOOD_IDS) {
    const n = Math.min(count(job!.incoming, good), count(job!.quay, good));
    if (n > 0) addLot(v, good, n, PLAYER, quay, 'migrated', { moving: 'load' });
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
    const from = oldest(v, (l) => l.good === o.good && l.owner === PLAYER && l.custody.at === 'aboard' && l.moving === undefined);
    if (!from) throw new RangeError(`sale of ${o.qty} ${o.good} exceeds the player's cargo aboard`);
    const n = Math.min(left, from.qty);
    takeFrom(v, from, n);
    left -= n;
  }
  const saleId = takeId(v, 'R');
  const lot = addLot(v, o.good, o.qty, marketOwner(o.port), ABOARD, saleId, { moving: 'unload' });
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
  const lot = addLot(v, o.good, o.qty, PLAYER, { at: 'quay', port: o.port, berth: o.berth }, purchaseId, { moving: 'load' });
  const line = { port: o.port, good: o.good, qty: o.qty, lot: lot.id };
  post(v, { T: o.T, kind: 'purchase', amount: -(o.total - o.duty), ...line }, purchaseId);
  post(v, { T: o.T, kind: 'duty', amount: -o.duty, ...line });
}

/** The lot aboard marked 'unload' that lands next: with a due date first (earliest, then lowest id), else lowest id. */
function nextToLand(v: VoyageState, good: GoodId): CargoLot | undefined {
  let best: CargoLot | undefined;
  for (const l of v.lots) {
    if (l.good !== good || l.custody.at !== 'aboard' || l.moving !== 'unload') continue;
    if (!best || landsBefore(l, best)) best = l;
  }
  return best;
}

function landsBefore(a: CargoLot, b: CargoLot): boolean {
  if ((a.due === undefined) !== (b.due === undefined)) return a.due !== undefined;
  if (a.due !== undefined && b.due !== undefined && a.due !== b.due) return a.due < b.due;
  return idNumber(a.id) < idNumber(b.id);
}

/** A unit in a store at the port, with its origin and agreement: merged into a store lot that matches, else a new one. */
function storeUnit(world: WorldState, good: GoodId, owner: OwnerId, port: number, origin: string, agreement: string | undefined): void {
  const found = world.lots.find((l) => l.good === good && l.owner === owner && l.custody.at === 'store' && l.custody.port === port && l.agreement === agreement && l.origin === origin);
  if (found) {
    found.qty++;
    return;
  }
  const lot: CargoLot = { id: takeWorldId(world, 'W'), good, qty: 1, owner, custody: { at: 'store', port }, origin };
  if (agreement !== undefined) lot.agreement = agreement;
  world.lots.push(lot);
}

/**
 * One sold unit lands: it leaves the oldest lot aboard marked 'unload' (a due one first). A market unit goes to
 * that market's lot on the quay at the job's berth (same origin and agreement), where it waits for the cart
 * (toQuay). A character's unit goes into her store at the job's port: origin is the lot it left; a returned
 * jar (her own agreement) lands untagged. Returns the id of the lot it left, its owner and agreement.
 */
export function landUnit(
  v: VoyageState,
  world: WorldState | null,
  job: CargoJob,
  good: GoodId,
): { lot: string; owner: OwnerId; agreement?: string; toQuay: boolean } {
  const from = nextToLand(v, good);
  if (!from) throw new RangeError(`no sold ${good} aboard to land`);
  let toQuay = false;
  if (isMarket(from.owner)) {
    takeFrom(v, from, 1);
    addUnit(v, good, from.owner, { at: 'quay', port: job.port, berth: job.berth }, from.origin, { agreement: from.agreement });
    toQuay = true;
  } else {
    const w = needWorld(world);
    let agreement = from.agreement;
    if (agreement !== undefined && from.owner === ownerOf(agreementOf(w, agreement).owner)) agreement = undefined;
    takeFrom(v, from, 1);
    storeUnit(w, good, from.owner, job.port, from.id, agreement);
  }
  addAboard(v, good, -1);
  return { lot: from.id, owner: from.owner, agreement: from.agreement, toQuay };
}

/** One bought unit is stowed: it leaves the oldest lot on the quay marked 'load' (any owner) for the lot aboard with the same owner, origin and agreement. Returns the id of the lot it left, its owner and agreement. */
export function stowUnit(v: VoyageState, good: GoodId): { lot: string; owner: OwnerId; agreement?: string } {
  const from = oldest(v, (l) => l.good === good && l.custody.at === 'quay' && l.moving === 'load');
  if (!from) throw new RangeError(`no bought ${good} on the quay to stow`);
  const { owner, agreement, origin, id } = from;
  takeFrom(v, from, 1);
  addUnit(v, good, owner, ABOARD, origin, { agreement });
  addAboard(v, good, 1);
  return { lot: id, owner, agreement };
}

/**
 * Porterage receipts: one per move, for the units moved from the lot (fee is per unit, centidrachmas). Units
 * owned by the agreement's owner are paid from her wallet from her reserve; other units with an agreement are
 * paid from the purse with the agreement on the receipt; the rest are paid from the purse as they always were.
 */
export function recordPorterage(
  v: VoyageState,
  world: WorldState | null,
  port: number,
  T: number,
  moves: Iterable<{ lot: string; good: GoodId; qty: number; fee: number; owner: OwnerId; agreement?: string }>,
): void {
  for (const m of moves) {
    const amount = -(m.fee * m.qty);
    const a = m.agreement === undefined ? undefined : agreementOf(needWorld(world), m.agreement);
    if (a && world && m.owner === ownerOf(a.owner)) {
      walletMove(world, a.owner, amount, 'porterage', T, { agreement: a.id, port, qty: m.qty, fromReserved: true });
    } else {
      post(v, { T, kind: 'porterage', amount, port, good: m.good, qty: m.qty, lot: m.lot, ...(a ? { agreement: a.id } : {}) });
    }
  }
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
const isOwner = (x: unknown): x is OwnerId =>
  x === PLAYER || (typeof x === 'string' && (/^market:(0|[1-9]\d*)$/.test(x) || /^char:(damaris|philon|myrto)$/.test(x)));
function isCustody(x: unknown): x is Custody {
  if (!isObj(x)) return false;
  if (x.at === 'aboard') return true;
  if (x.at === 'store') return Number.isSafeInteger(x.port);
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
    if ((l.custody as Custody).at === 'store') throw new RangeError(`books: lot ${String(l.id)} is in a store, not in the voyage`);
    if (typeof l.origin !== 'string') throw new RangeError(`books: lot ${String(l.id)} has no origin`);
    if (l.moving !== undefined && l.moving !== 'load' && l.moving !== 'unload') throw new RangeError(`books: lot ${String(l.id)} has unknown moving ${String(l.moving)}`);
    if (l.due !== undefined && (typeof l.due !== 'number' || !Number.isFinite(l.due))) throw new RangeError(`books: lot ${String(l.id)} due ${String(l.due)} is not finite`);
    if (l.agreement !== undefined && typeof l.agreement !== 'string') throw new RangeError(`books: lot ${String(l.id)} has malformed agreement`);
  }
  let sum = 0;
  for (const r of v.receipts as unknown[]) {
    if (!isObj(r)) throw new RangeError('books: malformed receipt');
    checkId(r.id, 'R');
    if (!RECEIPT_KINDS.includes(r.kind as ReceiptKind)) throw new RangeError(`books: receipt ${String(r.id)} has unknown kind ${String(r.kind)}`);
    if (typeof r.amount !== 'number' || !Number.isFinite(r.amount)) throw new RangeError(`books: receipt ${String(r.id)} amount ${String(r.amount)} is not finite`);
    if (typeof r.T !== 'number' || !Number.isFinite(r.T)) throw new RangeError(`books: receipt ${String(r.id)} time is not finite`);
    if (r.agreement !== undefined && typeof r.agreement !== 'string') throw new RangeError(`books: receipt ${String(r.id)} has malformed agreement`);
    if (r.party !== undefined && !isOwner(r.party)) throw new RangeError(`books: receipt ${String(r.id)} has unknown party ${String(r.party)}`);
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
    let loading = 0;
    let landed = 0;
    let unloading = 0;
    for (const l of v.lots) {
      if (l.good !== good) continue;
      if (l.custody.at === 'aboard') {
        aboard += l.qty;
        if (l.moving === 'unload') unloading += l.qty;
      } else if (l.moving === 'load') loading += l.qty;
      else landed += l.qty;
    }
    const m = v.manifest[good] ?? 0;
    if (m !== aboard) throw new RangeError(`books: manifest ${good} ${m} differs from the lots aboard ${aboard}`);
    const incoming = job?.incoming[good] ?? 0;
    const quay = job?.quay[good] ?? 0;
    const outgoing = job?.outgoing[good] ?? 0;
    if (loading !== incoming) throw new RangeError(`books: quay lots of ${good} marked load (${loading}) differ from job.incoming (${incoming})`);
    if (landed !== quay - incoming) throw new RangeError(`books: quay lots of ${good} not marked load (${landed}) differ from job.quay − job.incoming (${quay - incoming})`);
    if (unloading !== outgoing) throw new RangeError(`books: lots aboard of ${good} marked unload (${unloading}) differ from job.outgoing (${outgoing})`);
  }
}

// ---------- Pass 1c (docs/pass-1c-plan.md A): books for the characters, their stores and agreements ----------

/**
 * Moves a character's wallet by amount (+ in) and writes a world receipt. Throws if wallet − reserved would go
 * below 0, unless fromReserved: then amount must be ≤ 0, −amount ≤ reserved, and reserved (and the agreement's
 * reserved, when extra.agreement is set) fall by −amount.
 */
export function walletMove(
  world: WorldState,
  who: CharacterId,
  amount: number,
  kind: WorldReceipt['kind'],
  T: number,
  extra: { agreement?: string; port?: number; qty?: number; fromReserved?: boolean } = {},
): WorldReceipt {
  const c = characterOf(world, who);
  const a = extra.agreement === undefined ? undefined : agreementOf(world, extra.agreement);
  if (extra.fromReserved) {
    if (amount > 0 || -amount > c.reserved || (a !== undefined && -amount > a.reserved)) throw new RangeError(`${who} cannot pay ${-amount} from the reserve`);
    c.reserved += amount;
    if (a) a.reserved += amount;
  } else if (c.wallet + amount - c.reserved < 0) {
    throw new RangeError(`${who} cannot pay ${-amount} from the free wallet`);
  }
  c.wallet += amount;
  const receipt: WorldReceipt = { id: takeWorldId(world, 'X'), T, who, kind, amount };
  if (a) receipt.agreement = a.id;
  if (extra.port !== undefined) receipt.port = extra.port;
  if (extra.qty !== undefined) receipt.qty = extra.qty;
  world.receipts.push(receipt);
  return receipt;
}

/** Holds amount of the owner's free wallet for the agreement (character and agreement reserved both rise). Throws if wallet − reserved < amount. */
export function reserveFor(world: WorldState, agreementId: string, amount: number): void {
  const a = agreementOf(world, agreementId);
  const c = characterOf(world, a.owner);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError(`reserve must be a whole number of centidrachmas: ${amount}`);
  if (c.wallet - c.reserved < amount) throw new RangeError(`${a.owner} has ${c.wallet - c.reserved} free, not ${amount}`);
  c.reserved += amount;
  a.reserved += amount;
}

/** Releases what is still reserved for the agreement. */
export function releaseReserve(world: WorldState, agreementId: string): void {
  const a = agreementOf(world, agreementId);
  characterOf(world, a.owner).reserved -= a.reserved;
  a.reserved = 0;
}

/** Splits qty of the owner's unallocated store wine at port into a store lot carrying the agreement. Throws if short. */
export function allocateStore(world: WorldState, agreementId: string): void {
  const a = agreementOf(world, agreementId);
  const { good, qty, homePort } = a.terms;
  const owner = ownerOf(a.owner);
  const match = (l: CargoLot) => l.good === good && l.owner === owner && l.custody.at === 'store' && l.custody.port === homePort && l.agreement === undefined;
  const lots = world.lots.filter(match).sort((x, y) => idNumber(x.id) - idNumber(y.id));
  const held = lots.reduce((n, l) => n + l.qty, 0);
  if (held < qty) throw new RangeError(`store holds ${held} ${good} unallocated, not ${qty} for ${a.id}`);
  let left = qty;
  for (const l of lots) {
    if (left === 0) break;
    const k = Math.min(left, l.qty);
    l.qty -= k;
    left -= k;
    if (l.qty === 0) world.lots.splice(world.lots.indexOf(l), 1);
  }
  const lot: CargoLot = { id: takeWorldId(world, 'W'), good, qty, owner, custody: { at: 'store', port: homePort }, origin: 'allocated', agreement: a.id };
  world.lots.push(lot);
}

/** Moves every store unit allocated to the agreement into one quay lot at the job's berth, marked 'load'; adds them to job.incoming and job.quay. */
export function loadFromStore(v: VoyageState, world: WorldState, job: CargoJob, agreementId: string, _T: number): void {
  const a = agreementOf(world, agreementId);
  const owner = ownerOf(a.owner);
  const match = (l: CargoLot) => l.agreement === a.id && l.owner === owner;
  const first = world.lots.find(match);
  if (!first) return;
  const n = world.lots.filter(match).reduce((sum, l) => sum + l.qty, 0);
  for (let i = world.lots.length - 1; i >= 0; i--) if (match(world.lots[i])) world.lots.splice(i, 1);
  addLot(v, a.terms.good, n, owner, { at: 'quay', port: job.port, berth: job.berth }, first.id, { agreement: a.id, moving: 'load' });
  job.incoming[a.terms.good] = (job.incoming[a.terms.good] ?? 0) + n;
  job.quay[a.terms.good] = (job.quay[a.terms.good] ?? 0) + n;
  job.cartAt = null;
  a.loaded += n;
}

/**
 * A sale to a named buyer: the units become the buyer's aboard, marked 'unload' with due; receipts sale (+total, party) and
 * duty (−duty); the buyer's wallet −total. The units come from the player's lots, or from the agreement's owner's lots
 * with that agreement (the agreement then follows them to the buyer and counts as sold).
 */
export function recordNamedSale(
  v: VoyageState,
  world: WorldState,
  job: CargoJob,
  o: { buyer: CharacterId; port: number; good: GoodId; qty: number; total: number; duty: number; due: number; from: 'player' | string; T: number },
): void {
  const a = o.from === 'player' ? undefined : agreementOf(world, o.from);
  const owner: OwnerId = a ? ownerOf(a.owner) : PLAYER;
  const match = (l: CargoLot) => l.good === o.good && l.owner === owner && l.custody.at === 'aboard' && l.moving === undefined && l.agreement === a?.id;
  if (available(v, match) < o.qty) throw new RangeError(`sale of ${o.qty} ${o.good} exceeds what is aboard for ${o.from}`);
  walletMove(world, o.buyer, -o.total, 'purchase', o.T, { port: o.port, qty: o.qty, agreement: a?.id });
  const saleId = takeId(v, 'R');
  takeOldest(v, match, o.qty);
  const lot = addLot(v, o.good, o.qty, ownerOf(o.buyer), ABOARD, saleId, { moving: 'unload', due: o.due, agreement: a?.id });
  const line = { port: o.port, good: o.good, qty: o.qty, lot: lot.id, party: ownerOf(o.buyer), ...(a ? { agreement: a.id } : {}) };
  post(v, { T: o.T, kind: 'sale', amount: o.total, ...line }, saleId);
  post(v, { T: o.T, kind: 'duty', amount: -o.duty, ...line });
  job.outgoing[o.good] = (job.outgoing[o.good] ?? 0) + o.qty;
  job.cartAt = null;
  if (a) a.sold += o.qty;
}

/** recordSale for the agreement's jars aboard: total is net of duty, as in recordSale; receipts and the market lot carry the agreement. */
export function recordConsignedMarketSale(
  v: VoyageState,
  world: WorldState,
  job: CargoJob,
  o: { agreement: string; port: number; good: GoodId; qty: number; total: number; duty: number; T: number },
): void {
  const a = agreementOf(world, o.agreement);
  const match = (l: CargoLot) => l.good === o.good && l.owner === ownerOf(a.owner) && l.custody.at === 'aboard' && l.moving === undefined && l.agreement === a.id;
  if (available(v, match) < o.qty) throw new RangeError(`sale of ${o.qty} ${o.good} exceeds the jars of ${a.id} aboard`);
  const saleId = takeId(v, 'R');
  takeOldest(v, match, o.qty);
  const lot = addLot(v, o.good, o.qty, marketOwner(o.port), ABOARD, saleId, { agreement: a.id, moving: 'unload' });
  const line = { port: o.port, good: o.good, qty: o.qty, lot: lot.id, agreement: a.id };
  post(v, { T: o.T, kind: 'sale', amount: o.total + o.duty, ...line }, saleId);
  post(v, { T: o.T, kind: 'duty', amount: -o.duty, ...line });
  job.outgoing[o.good] = (job.outgoing[o.good] ?? 0) + o.qty;
  job.cartAt = null;
  a.sold += o.qty;
}

/** qty of the agreement's jars aboard (hers, not moving) are marked 'unload' to go back to her store. */
export function recordReturn(v: VoyageState, world: WorldState, job: CargoJob, agreementId: string, qty: number): void {
  const a = agreementOf(world, agreementId);
  if (!Number.isSafeInteger(qty) || qty <= 0) throw new RangeError(`return must be a positive whole number of jars: ${qty}`);
  const match = (l: CargoLot) => l.good === a.terms.good && l.owner === ownerOf(a.owner) && l.custody.at === 'aboard' && l.moving === undefined && l.agreement === a.id;
  if (available(v, match) < qty) throw new RangeError(`return of ${qty} jars exceeds the jars of ${a.id} aboard`);
  const origin = takeOldest(v, match, qty);
  addLot(v, a.terms.good, qty, ownerOf(a.owner), ABOARD, origin, { agreement: a.id, moving: 'unload' });
  job.outgoing[a.terms.good] = (job.outgoing[a.terms.good] ?? 0) + qty;
  job.cartAt = null;
  a.returned += qty;
}

/** A payment to the owner: purse receipt −amount (kind 'remit', agreement, party), and +amount into her wallet. */
export function recordRemit(v: VoyageState, world: WorldState, agreementId: string, amount: number, T: number): void {
  const a = agreementOf(world, agreementId);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError(`remit must be a whole number of centidrachmas: ${amount}`);
  post(v, { T, kind: 'remit', amount: -amount, agreement: a.id, party: ownerOf(a.owner) });
  walletMove(world, a.owner, amount, 'remit', T, { agreement: a.id });
}

/** Lots from 1a/1b saves: market lots aboard without moving get 'unload', player lots on the quay get 'load'. */
export function normalizeLots(v: VoyageState): void {
  for (const l of v.lots) {
    if (l.moving !== undefined) continue;
    if (l.custody.at === 'aboard' && isMarket(l.owner)) l.moving = 'unload';
    else if (l.custody.at === 'quay' && l.owner === PLAYER) l.moving = 'load';
  }
}

/** Throws a RangeError naming the first broken world invariant (docs/pass-1c-plan.md, checkWorld). */
export function checkWorld(world: WorldState, v: VoyageState): void {
  checkBooks(v);
  for (const c of world.characters) {
    const receipts = world.receipts.filter((r) => r.who === c.id).reduce((n, r) => n + r.amount, 0);
    if (c.wallet !== receipts) throw new RangeError(`world: wallet of ${c.id} ${c.wallet} differs from its receipts ${receipts}`);
    if (c.reserved < 0 || c.reserved > c.wallet) throw new RangeError(`world: reserved of ${c.id} ${c.reserved} is outside 0..${c.wallet}`);
    const held = world.agreements.filter((a) => a.owner === c.id).reduce((n, a) => n + a.reserved, 0);
    if (c.reserved !== held) throw new RangeError(`world: reserved of ${c.id} ${c.reserved} differs from its agreements ${held}`);
  }
  const ids = new Set<string>();
  for (const l of world.lots) {
    if (typeof l.id !== 'string' || !/^W\d+$/.test(l.id)) throw new RangeError(`world: malformed store lot id ${String(l.id)}`);
    if (ids.has(l.id)) throw new RangeError(`world: duplicate store lot ${l.id}`);
    ids.add(l.id);
    if (idNumber(l.id) >= world.nextId) throw new RangeError(`world: nextId ${world.nextId} is not above ${l.id}`);
    if (l.custody.at !== 'store') throw new RangeError(`world: store lot ${l.id} is not in a store`);
    if (!Number.isSafeInteger(l.qty) || l.qty <= 0) throw new RangeError(`world: store lot ${l.id} qty ${String(l.qty)} is not a positive safe integer`);
  }
  for (const a of world.agreements) {
    const owner = ownerOf(a.owner);
    let jars = 0;
    for (const l of world.lots) if (l.agreement === a.id && l.owner === owner) jars += l.qty;
    for (const l of v.lots) if (l.agreement === a.id && l.owner === owner && l.moving !== 'unload') jars += l.qty;
    const total = jars + a.sold + a.returned;
    if (total !== a.terms.qty) throw new RangeError(`world: agreement ${a.id} accounts for ${total} jars, not ${a.terms.qty}`);
  }
}
