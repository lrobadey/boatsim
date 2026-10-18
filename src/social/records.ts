// What characters know and what follows from it (expectations-mvp-spec §3.6, docs/pass-1c-plan.md B). Records are
// facts a character witnessed, was shown or heard as news; warmth, the trust limit, beliefs and overdue stages are
// worked out from them on demand and never stored. Pure: plain data, no game imports.

import type { Agreement, CharacterId, WorldState } from '../trade/world';

export type RecordSource = 'witnessed' | 'shown' | 'news';

interface RecordOf<K extends string, F> {
  /** built from the facts, e.g. 'damaris:settled:A3:R57', so a retelling or reload never writes it twice */
  id: string;
  holder: CharacterId;
  /** absolute game hour */
  T: number;
  source: RecordSource;
  kind: K;
  facts: F;
}

export type SocialRecord =
  /** value = perJar · qty; amount = what was paid; full = nothing left payable; onTime = before overdue */
  | RecordOf<'settled', { agreement: string; value: number; amount: number; full: boolean; onTime: boolean }>
  | RecordOf<'returned', { agreement: string; qty: number }>
  /** unit = the sale receipt's gross per unit; heardBid = the bid she had heard for that port at the sale */
  | RecordOf<'sold-below', { agreement: string; receipt: string; unit: number; heardBid: number }>
  | RecordOf<'heard-sale', { qty: number; unit: number; consignedQty: number; agreement?: string }>
  /** written by Pass 2 */
  | RecordOf<'letter-shown', Record<string, unknown>>
  /** T is the cutoff */
  | RecordOf<'undelivered', { qty: number }>;

export interface Belief {
  holder: CharacterId;
  agreement: string;
  expectT: number;
  firmness: 'firm' | 'tentative' | 'conditional';
  source: 'terms' | 'said' | 'assumed';
}

export type Stage = 'none' | 'overdue' | 'long-overdue';

/** Adds the record unless one with its id exists. Returns true when added. */
export function addRecord(_world: WorldState, _r: SocialRecord): boolean {
  throw new Error('not implemented: Pass 1c B');
}

/** The holder's records with T ≤ the given time, in time order (ties keep the order they were added). */
export function recordsOf(_world: WorldState, _who: CharacterId, _T: number): SocialRecord[] {
  throw new Error('not implemented: Pass 1c B');
}

/** 1c: one assumed, tentative return belief per agreement the holder owns (expectT = expectedT). */
export function beliefsOf(_world: WorldState, _who: CharacterId): Belief[] {
  throw new Error('not implemented: Pass 1c B');
}

/** Let down at T: T > expectT and the holder has no witnessed record of the agreement at or before expectT. */
export function letDown(_world: WorldState, _b: Belief, _T: number): boolean {
  throw new Error('not implemented: Pass 1c B');
}

/** warmth0, +1 per letter-shown news, +1 per agreement first settled in full in person, −1 per let-down firm belief; clamped −2..2. */
export function warmth(_world: WorldState, _who: CharacterId, _T: number): number {
  throw new Error('not implemented: Pass 1c B');
}

/** overdueT = expectedT + 24·w, longT = overdueT + 24·(14 + 3·w), with w = warmth of the owner at T. */
export function overdueTimes(_world: WorldState, _a: Agreement, _T: number): { overdueT: number; longT: number } {
  throw new Error('not implemented: Pass 1c B');
}

/** 'none' once the owner holds a full settled record at or before T; else by overdueTimes (boundaries count as reached). */
export function stage(_world: WorldState, _a: Agreement, _T: number): Stage {
  throw new Error('not implemented: Pass 1c B');
}

/** trustBase, then the records in time order; 0 while any of their agreements is overdue or long overdue. */
export function trustLimit(_world: WorldState, _who: CharacterId, _T: number): number {
  throw new Error('not implemented: Pass 1c B');
}
