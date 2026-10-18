// Consignment dealings (expectations-mvp-spec §3.3–3.4, docs/pass-1c-plan.md C1): the headless commands the Pass 2
// tools call. Every command takes a request id first; its result is kept in world.results, so replaying the same
// request returns that result and does nothing. A refusal changes nothing but that stored result. Pure: no DOM.

import type { Economy } from './economy';
import { goodById, type GoodId } from './goods';
import { allocateStore, loadFromStore, recordConsignedMarketSale, recordNamedSale, recordRemit, recordReturn, releaseReserve, reserveFor, type OwnerId, type Receipt } from './books';
import type { TradeSession } from './session';
import { dueLandingT } from './job';
import { DUTY } from './market';
import { payCeil } from './money';
import { porterFeePerUnit, type CargoJob, type VoyageState } from './voyage';
import { addRecord, overdueTimes, stage, trustLimit } from '../social/records';
import { takeWorldId, type Agreement, type Character, type CharacterId, type Mail, type Proposal, type Terms, type WorldReceipt, type WorldState } from './world';

export type Reason = 'unknown' | 'stale' | 'trust' | 'stock' | 'wallet' | 'purse' | 'berth' | 'port' | 'deadline' | 'hold' | 'closed' | 'open' | 'state';
export type Refusal = { ok: false; reason: Reason; quote?: number };
export type Result<T extends object = object> = ({ ok: true } & T) | Refusal;

/** What a proposal asks; trusted code fills perJar, share and homePort. */
export type ProposalInput = Pick<Terms, 'good' | 'qty' | 'alternateSale' | 'buyer' | 'opportunityT'>;

export interface VentureAccount {
  /** gross sales (sale receipts tagged with the agreement) */
  G: number;
  /** duty and porterage on purse receipts, plus the owner's porterage world receipts */
  C: number;
  /** units sold */
  s: number;
  /** units returned and landed */
  r: number;
  closed: boolean;
  N: number;
  profit: number;
  share: number;
  /** the player's receipts tagged with the agreement (remits included) − share */
  payable: number;
  /** min(payable, max(0, purse)), never below 0 */
  available: number;
}

export interface DealingsOptions {
  world: WorldState;
  session: TradeSession;
  /** the bid (centidrachmas per unit) a trader at `listener` has heard for `about`, or null */
  heardBid(listener: number, about: number, good: GoodId, T: number): number | null;
}

/** The per-jar value of qty at a port: floor(quoteSell(qty).total / qty). */
export function homeValue(economy: Economy, port: number, qty: number, good: GoodId = 'wine'): number {
  return Math.floor(economy.market(port, good).quoteSell(qty).total / qty);
}

const sum = (xs: readonly number[]): number => xs.reduce((n, x) => n + x, 0);
const isCount = (n: number): boolean => Number.isSafeInteger(n) && n > 0;
const ownerOf = (who: CharacterId): OwnerId => `char:${who}`;
const refuse = (reason: Reason, quote?: number): Refusal => (quote === undefined ? { ok: false, reason } : { ok: false, reason, quote });

/**
 * The venture's account from its receipts (spec §3.4): N = G − C, profit = max(0, N − perJar·s),
 * share = closed ? floor(profit·share/100) : 0. Pure, so the spec's worked examples check to the cent.
 */
export function ventureAccount(o: {
  agreement: string;
  terms: Pick<Terms, 'qty' | 'perJar' | 'share'>;
  s: number;
  r: number;
  closed: boolean;
  purse: number;
  receipts: readonly Receipt[];
  worldReceipts: readonly WorldReceipt[];
}): VentureAccount {
  const tagged = o.receipts.filter((r) => r.agreement === o.agreement);
  const G = sum(tagged.filter((r) => r.kind === 'sale').map((r) => r.amount));
  const C = 0 - sum(tagged.filter((r) => r.kind === 'duty' || r.kind === 'porterage').map((r) => r.amount))
    - sum(o.worldReceipts.filter((w) => w.agreement === o.agreement && w.kind === 'porterage').map((w) => w.amount));
  const N = G - C;
  const profit = Math.max(0, N - o.terms.perJar * o.s);
  const share = o.closed ? Math.floor((profit * o.terms.share) / 100) : 0;
  const payable = sum(tagged.map((r) => r.amount)) - share;
  const available = Math.max(0, Math.min(payable, Math.max(0, o.purse)));
  return { G, C, s: o.s, r: o.r, closed: o.closed, N, profit, share, payable, available };
}

const findProposal = (world: WorldState, id: string): Proposal | undefined => world.proposals.find((p) => p.id === id);
const findAgreement = (world: WorldState, id: string): Agreement | undefined => world.agreements.find((a) => a.id === id);
const findCharacter = (world: WorldState, id: CharacterId): Character | undefined => world.characters.find((c) => c.id === id);

/** Unallocated store wine (any good, at the port) the owner holds: store lots with no agreement. */
function unallocated(world: WorldState, owner: CharacterId, port: number, good: GoodId): number {
  return sum(
    world.lots
      .filter((l) => l.owner === ownerOf(owner) && l.custody.at === 'store' && l.custody.port === port && l.good === good && l.agreement === undefined)
      .map((l) => l.qty),
  );
}

/** Free jars aboard: voyage lots aboard with this owner, good and agreement (undefined for the player's own), not moving. */
function freeAboard(v: VoyageState, owner: OwnerId, good: GoodId, agreement?: string): number {
  return sum(
    v.lots
      .filter((l) => l.owner === owner && l.good === good && l.agreement === agreement && l.custody.at === 'aboard' && l.moving === undefined)
      .map((l) => l.qty),
  );
}

/** A job at another port or berth than the one asked for. */
const atOtherBerth = (job: CargoJob | null, port: number, berth: number): boolean => job !== null && (job.port !== port || job.berth !== berth);

/** Trust and stock for an offer of qty jars at perJar: the reason it is refused, or null. */
function blocked(world: WorldState, owner: CharacterId, port: number, good: GoodId, qty: number, perJar: number, T: number): Reason | null {
  if (perJar * qty > trustLimit(world, owner, T) || world.agreements.some((a) => a.owner === owner && stage(world, a, T) === 'long-overdue')) return 'trust';
  if (unallocated(world, owner, port, good) < qty) return 'stock';
  return null;
}

export class Dealings {
  constructor(readonly o: DealingsOptions) {}

  private run<R>(req: string, fn: () => R): R {
    const { results } = this.o.world;
    if (Object.prototype.hasOwnProperty.call(results, req)) return results[req] as R;
    const r = fn();
    results[req] = r;
    return r;
  }

  private accountOf(a: Agreement): VentureAccount {
    const { world, session } = this.o;
    const v = session.voyage;
    const owner = ownerOf(a.owner);
    const inFlight = sum(v.lots.filter((l) => l.owner === owner && l.agreement === a.id && l.moving === 'unload').map((l) => l.qty));
    const closed = a.sold + a.returned === a.terms.qty && !v.lots.some((l) => l.agreement === a.id && l.moving !== undefined);
    return ventureAccount({
      agreement: a.id,
      terms: a.terms,
      s: a.sold,
      r: a.returned - inFlight,
      closed,
      purse: v.purse,
      receipts: v.receipts,
      worldReceipts: world.receipts,
    });
  }

  /** The terms an offer by this character would make, or the reason it is refused. */
  private termsFor(c: Character, input: ProposalInput, T: number): Terms | Reason {
    if (!isCount(input.qty)) return 'state';
    const terms: Terms = { ...input, share: 20, homePort: c.port, perJar: homeValue(this.o.session.economy, c.port, input.qty, input.good) };
    return blocked(this.o.world, c.id, c.port, terms.good, terms.qty, terms.perJar, T) ?? terms;
  }

  propose(req: string, owner: CharacterId, input: ProposalInput): Result<{ proposal: string; revision: number; terms: Terms }> {
    return this.run(req, (): Result<{ proposal: string; revision: number; terms: Terms }> => {
      const { world, session } = this.o;
      const c = findCharacter(world, owner);
      if (!c) return refuse('unknown');
      const terms = this.termsFor(c, input, session.economy.now);
      if (typeof terms === 'string') return refuse(terms);
      const proposal: Proposal = { id: takeWorldId(world, 'P'), owner, revisions: [{ revision: 1, terms, T: session.economy.now, status: 'open' }] };
      world.proposals.push(proposal);
      return { ok: true, proposal: proposal.id, revision: 1, terms };
    });
  }

  revise(req: string, proposalId: string, input: ProposalInput): Result<{ proposal: string; revision: number; terms: Terms }> {
    return this.run(req, (): Result<{ proposal: string; revision: number; terms: Terms }> => {
      const { world, session } = this.o;
      const p = findProposal(world, proposalId);
      if (!p) return refuse('unknown');
      const current = p.revisions[p.revisions.length - 1];
      if (current.status !== 'open') return refuse('state');
      const c = findCharacter(world, p.owner);
      if (!c) return refuse('unknown');
      const T = session.economy.now;
      const terms = this.termsFor(c, input, T);
      if (typeof terms === 'string') return refuse(terms);
      current.status = 'superseded';
      const revision = current.revision + 1;
      p.revisions.push({ revision, terms, T, status: 'open' });
      return { ok: true, proposal: p.id, revision, terms };
    });
  }

  decline(req: string, proposalId: string, revision: number): Result {
    return this.run(req, (): Result => {
      const p = findProposal(this.o.world, proposalId);
      if (!p) return refuse('unknown');
      const current = p.revisions[p.revisions.length - 1];
      if (current.revision !== revision || current.status !== 'open') return refuse('stale');
      current.status = 'declined';
      return { ok: true };
    });
  }

  accept(req: string, proposalId: string, revision: number): Result<{ agreement: string }> {
    return this.run(req, (): Result<{ agreement: string }> => {
      const { world, session } = this.o;
      const p = findProposal(world, proposalId);
      if (!p) return refuse('unknown');
      const current = p.revisions[p.revisions.length - 1];
      if (current.revision !== revision || current.status !== 'open') return refuse('stale');
      const { terms } = current;
      const T = session.economy.now;
      const block = blocked(world, p.owner, terms.homePort, terms.good, terms.qty, terms.perJar, T);
      if (block) return refuse(block);
      const buyer = findCharacter(world, terms.buyer);
      if (!buyer) return refuse('unknown');
      const a: Agreement = {
        id: takeWorldId(world, 'A'),
        proposal: p.id,
        revision,
        owner: p.owner,
        terms,
        acceptedT: T,
        expectedT: terms.opportunityT + session.economy.routeHours(buyer.port, terms.homePort) + 72,
        loaded: 0,
        sold: 0,
        returned: 0,
        reserved: 0,
        closedT: null,
        settledT: null,
      };
      world.agreements.push(a);
      allocateStore(world, a.id);
      current.status = 'accepted';
      return { ok: true, agreement: a.id };
    });
  }

  startLoading(req: string, agreementId: string, port: number, berth: number): Result<{ reserved: number }> {
    return this.run(req, (): Result<{ reserved: number }> => {
      const { world, session } = this.o;
      const a = findAgreement(world, agreementId);
      if (!a) return refuse('unknown');
      const { terms } = a;
      if (a.loaded > 0 || a.closedT !== null) return refuse('state');
      if (port !== terms.homePort) return refuse('port');
      const v = session.voyage;
      if (atOtherBerth(v.job, port, berth)) return refuse('berth');
      const good = goodById(terms.good);
      if (session.holdUse().volume + terms.qty * good.stow > session.holdCapacity + 1e-9) return refuse('hold');
      const owner = findCharacter(world, a.owner);
      if (!owner) return refuse('unknown');
      const need = 2 * terms.qty * porterFeePerUnit(good);
      if (owner.wallet - owner.reserved < need) return refuse('wallet');
      reserveFor(world, agreementId, need);
      loadFromStore(v, world, session.ensureJob(port, berth), agreementId, session.economy.now);
      return { ok: true, reserved: need };
    });
  }

  /** Jars the buyer will take now (Philon: max(0, min(earmark, requirement − owned)) before the cutoff; others 0). */
  buyerDemand(buyer: CharacterId): number {
    const { world, session } = this.o;
    const c = world.celebration;
    if (buyer !== 'philon' || !c || c.done || session.economy.now >= c.cutoffT) return 0;
    const owner = ownerOf('philon');
    const owned = sum([...world.lots, ...session.voyage.lots].filter((l) => l.owner === owner && l.good === 'wine').map((l) => l.qty));
    return Math.max(0, Math.min(c.earmark, c.requirement - owned));
  }

  /** The buyer's real alternative for qty at port, capped by his free wallet (spec §3.4). */
  buyerQuote(buyer: CharacterId, port: number, qty: number): number {
    const { world, session } = this.o;
    const m = session.economy.market(port, 'wine');
    let total = 0;
    for (let i = 0; i < qty; i++) total += m.ask(m.S - i - 0.5);
    const c = findCharacter(world, buyer);
    if (!c) throw new RangeError(`unknown character ${buyer}`);
    return Math.min(payCeil(total * (1 + DUTY)), c.wallet - c.reserved);
  }

  sellToBuyer(
    req: string,
    o: { buyer: CharacterId; port: number; berth: number; from: 'player' | string; qty: number; quoted: number },
  ): Result<{ total: number; duty: number; landT: number }> {
    return this.run(req, (): Result<{ total: number; duty: number; landT: number }> => {
      const { world, session } = this.o;
      const T = session.economy.now;
      const buyer = findCharacter(world, o.buyer);
      if (!buyer) return refuse('unknown');
      if (o.port !== buyer.port) return refuse('port');
      const v = session.voyage;
      if (atOtherBerth(v.job, o.port, o.berth)) return refuse('berth');
      if (!isCount(o.qty) || o.qty > this.buyerDemand(o.buyer)) return refuse('stock');
      let agreement: Agreement | undefined;
      if (o.from === 'player') {
        if (freeAboard(v, 'player', 'wine') < o.qty) return refuse('stock');
      } else {
        agreement = findAgreement(world, o.from);
        if (!agreement) return refuse('unknown');
        if (!agreement.terms.alternateSale && agreement.terms.buyer !== o.buyer) return refuse('state');
        if (freeAboard(v, ownerOf(agreement.owner), 'wine', agreement.id) < o.qty) return refuse('stock');
      }
      const quote = this.buyerQuote(o.buyer, o.port, o.qty);
      if (quote !== o.quoted) return refuse('stale', quote);
      const cel = world.celebration;
      if (!cel || dueLandingT(v, T, { wine: o.qty }) > cel.cutoffT) return refuse('deadline');
      const to: CharacterId = agreement ? agreement.owner : 'damaris';
      const recipient = findCharacter(world, to);
      if (!recipient) return refuse('unknown');

      const duty = quote - Math.floor(quote * (1 - DUTY));
      recordNamedSale(v, world, session.ensureJob(o.port, o.berth), {
        buyer: o.buyer,
        port: o.port,
        good: 'wine',
        qty: o.qty,
        total: quote,
        duty,
        due: cel.cutoffT,
        from: o.from,
        T,
      });
      const mail: Mail = {
        id: takeWorldId(world, 'M'),
        from: o.buyer,
        to,
        fromPort: buyer.port,
        toPort: recipient.port,
        writtenT: T,
        facts: {
          qty: o.qty,
          unit: Math.floor(quote / o.qty),
          consignedQty: agreement ? o.qty : 0,
          ...(agreement ? { agreement: agreement.id } : {}),
        },
        deliverT: null,
        delivered: false,
      };
      world.mail.push(mail);
      return { ok: true, total: quote, duty, landT: dueLandingT(v, T) };
    });
  }

  sellToMarket(req: string, o: { agreement: string; port: number; berth: number; qty: number; quoted: number }): Result<{ total: number; duty: number }> {
    return this.run(req, (): Result<{ total: number; duty: number }> => {
      const { world, session } = this.o;
      const a = findAgreement(world, o.agreement);
      if (!a) return refuse('unknown');
      if (!a.terms.alternateSale) return refuse('state');
      const v = session.voyage;
      if (atOtherBerth(v.job, o.port, o.berth)) return refuse('berth');
      if (!isCount(o.qty) || freeAboard(v, ownerOf(a.owner), a.terms.good, a.id) < o.qty) return refuse('stock');
      const market = session.economy.market(o.port, a.terms.good);
      const q = market.quoteSell(o.qty);
      if (q.total !== o.quoted) return refuse('stale', q.total);
      market.sell(o.qty);
      recordConsignedMarketSale(v, world, session.ensureJob(o.port, o.berth), {
        agreement: a.id,
        port: o.port,
        good: a.terms.good,
        qty: o.qty,
        total: q.total,
        duty: q.duty,
        T: session.economy.now,
      });
      return { ok: true, total: q.total, duty: q.duty };
    });
  }

  returnGoods(req: string, o: { agreement: string; port: number; berth: number; qty: number }): Result {
    return this.run(req, (): Result => {
      const { world, session } = this.o;
      const a = findAgreement(world, o.agreement);
      if (!a) return refuse('unknown');
      if (o.port !== a.terms.homePort) return refuse('port');
      const v = session.voyage;
      if (atOtherBerth(v.job, o.port, o.berth)) return refuse('berth');
      if (!isCount(o.qty) || freeAboard(v, ownerOf(a.owner), a.terms.good, a.id) < o.qty) return refuse('stock');
      recordReturn(v, world, session.ensureJob(o.port, o.berth), a.id, o.qty);
      return { ok: true };
    });
  }

  account(agreementId: string): VentureAccount | null {
    const a = findAgreement(this.o.world, agreementId);
    return a ? this.accountOf(a) : null;
  }

  settle(req: string, o: { agreement: string; port: number; amount: number }): Result<{ paid: number; payable: number; full: boolean }> {
    return this.run(req, (): Result<{ paid: number; payable: number; full: boolean }> => {
      const { world, session } = this.o;
      const T = session.economy.now;
      const a = findAgreement(world, o.agreement);
      if (!a) return refuse('unknown');
      if (a.settledT !== null) return refuse('state');
      if (o.port !== a.terms.homePort) return refuse('port');
      const acc = this.accountOf(a);
      if (!acc.closed) return refuse('open');
      if (acc.payable > 0 && acc.available === 0) return refuse('purse');
      if (o.amount !== acc.available) return refuse('stale', acc.available);

      const v = session.voyage;
      const owner = a.owner;
      const { overdueT } = overdueTimes(world, a, T);
      if (a.closedT === null) a.closedT = T;
      recordRemit(v, world, a.id, o.amount, T);
      const remitId = v.receipts[v.receipts.length - 1].id;
      const after = this.accountOf(a);
      const full = after.payable <= 0;
      addRecord(world, {
        id: `${owner}:settled:${a.id}:${remitId}`,
        holder: owner,
        T,
        source: 'witnessed',
        kind: 'settled',
        facts: { agreement: a.id, value: a.terms.perJar * a.terms.qty, amount: o.amount, full, onTime: T < overdueT },
      });
      for (const r of v.receipts) {
        if (r.kind !== 'sale' || r.agreement !== a.id || r.qty === undefined || r.port === undefined) continue;
        const unit = r.amount / r.qty;
        const hb = this.o.heardBid(a.terms.homePort, r.port, a.terms.good, r.T);
        if (hb !== null && unit < 0.9 * hb) {
          addRecord(world, {
            id: `${owner}:sold-below:${a.id}:${r.id}`,
            holder: owner,
            T,
            source: 'witnessed',
            kind: 'sold-below',
            facts: { agreement: a.id, receipt: r.id, unit, heardBid: hb },
          });
        }
      }
      if (a.returned > 0) {
        addRecord(world, { id: `${owner}:returned:${a.id}`, holder: owner, T, source: 'witnessed', kind: 'returned', facts: { agreement: a.id, qty: a.returned } });
      }
      if (a.reserved > 0) releaseReserve(world, a.id);
      if (full) a.settledT = T;
      return { ok: true, paid: o.amount, payable: after.payable, full };
    });
  }
}
