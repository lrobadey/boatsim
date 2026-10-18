// Consignment dealings (expectations-mvp-spec §3.3–3.4, docs/pass-1c-plan.md C1): the headless commands the Pass 2
// tools call. Every command takes a request id first; its result is kept in world.results, so replaying the same
// request returns that result and does nothing. A refusal changes nothing but that stored result. Pure: no DOM.

import type { Economy } from './economy';
import type { GoodId } from './goods';
import type { Receipt } from './books';
import type { TradeSession } from './session';
import type { CharacterId, Terms, WorldReceipt, WorldState } from './world';

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

/**
 * The venture's account from its receipts (spec §3.4): N = G − C, profit = max(0, N − perJar·s),
 * share = closed ? floor(profit·share/100) : 0. Pure, so the spec's worked examples check to the cent.
 */
export function ventureAccount(_o: {
  agreement: string;
  terms: Pick<Terms, 'qty' | 'perJar' | 'share'>;
  s: number;
  r: number;
  closed: boolean;
  purse: number;
  receipts: readonly Receipt[];
  worldReceipts: readonly WorldReceipt[];
}): VentureAccount {
  throw new Error('not implemented: Pass 1c C1');
}

const todo = (): never => {
  throw new Error('not implemented: Pass 1c C1');
};

export class Dealings {
  constructor(readonly o: DealingsOptions) {}

  propose(_req: string, _owner: CharacterId, _input: ProposalInput): Result<{ proposal: string; revision: number; terms: Terms }> {
    return todo();
  }

  revise(_req: string, _proposalId: string, _input: ProposalInput): Result<{ proposal: string; revision: number; terms: Terms }> {
    return todo();
  }

  decline(_req: string, _proposalId: string, _revision: number): Result {
    return todo();
  }

  accept(_req: string, _proposalId: string, _revision: number): Result<{ agreement: string }> {
    return todo();
  }

  startLoading(_req: string, _agreementId: string, _port: number, _berth: number): Result<{ reserved: number }> {
    return todo();
  }

  /** Jars the buyer will take now (Philon: max(0, min(earmark, requirement − owned)) before the cutoff; others 0). */
  buyerDemand(_buyer: CharacterId): number {
    return todo();
  }

  /** The buyer's real alternative for qty at port, capped by his free wallet (spec §3.4). */
  buyerQuote(_buyer: CharacterId, _port: number, _qty: number): number {
    return todo();
  }

  sellToBuyer(
    _req: string,
    _o: { buyer: CharacterId; port: number; berth: number; from: 'player' | string; qty: number; quoted: number },
  ): Result<{ total: number; duty: number; landT: number }> {
    return todo();
  }

  sellToMarket(_req: string, _o: { agreement: string; port: number; berth: number; qty: number; quoted: number }): Result<{ total: number; duty: number }> {
    return todo();
  }

  returnGoods(_req: string, _o: { agreement: string; port: number; berth: number; qty: number }): Result {
    return todo();
  }

  account(_agreementId: string): VentureAccount | null {
    return todo();
  }

  settle(_req: string, _o: { agreement: string; port: number; amount: number }): Result<{ paid: number; payable: number; full: boolean }> {
    return todo();
  }
}
