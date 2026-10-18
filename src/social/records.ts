// What characters know and what follows from it (expectations-mvp-spec §3.6, docs/pass-1c-plan.md B). Records are
// facts a character witnessed, was shown or heard as news; warmth, the trust limit, beliefs and overdue stages are
// worked out from them on demand and never stored. Pure: plain data, no game imports.

import type { Agreement, CharacterId, Holder, WorldState } from '../trade/world';

export type RecordSource = 'witnessed' | 'shown' | 'news';

interface RecordOf<K extends string, F> {
  /** built from the facts, e.g. 'damaris:settled:A3:R57', so a retelling or reload never writes it twice */
  id: string;
  holder: Holder;
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
  /** the letter's author tells its recipient by ship that the player showed it to him */
  | RecordOf<'letter-shown', { document: string; by: 'player' }>
  /** someone was shown a document (source 'shown'); possession unchanged */
  | RecordOf<'document-shown', { document: string; by: Holder }>
  /** something the player said: the claim as spoken, her reading of it, and the cited line */
  | RecordOf<'promise', { claim: string; interpretation: 'firm' | 'tentative' | 'conditional'; citation: string; agreement?: string; expectT: number }>
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

function agreementOf(r: SocialRecord): string | undefined {
  return 'agreement' in r.facts ? (r.facts.agreement as string) : undefined;
}

/** Adds the record unless one with its id exists. Returns true when added. */
export function addRecord(world: WorldState, r: SocialRecord): boolean {
  if (world.records.some((x) => x.id === r.id)) return false;
  world.records.push({ ...r, facts: { ...r.facts } } as SocialRecord);
  return true;
}

/** The holder's records with T ≤ the given time, in time order (ties keep the order they were added). */
export function recordsOf(world: WorldState, who: Holder, T: number): SocialRecord[] {
  return world.records
    .filter((r) => r.holder === who && r.T <= T)
    .sort((x, y) => x.T - y.T);
}

/** 1c: one assumed, tentative return belief per agreement the holder owns (expectT = expectedT). */
export function beliefsOf(world: WorldState, who: CharacterId): Belief[] {
  return world.agreements
    .filter((a) => a.owner === who)
    .map((a) => ({ holder: who, agreement: a.id, expectT: a.expectedT, firmness: 'tentative', source: 'assumed' }));
}

/** Let down at T: T > expectT and the holder has no witnessed record of the agreement at or before expectT. */
export function letDown(world: WorldState, b: Belief, T: number): boolean {
  if (T <= b.expectT) return false;
  return !recordsOf(world, b.holder, b.expectT).some(
    (r) => r.source === 'witnessed' && agreementOf(r) === b.agreement,
  );
}

/** warmth0, +1 per letter-shown news, +1 per agreement first settled in full in person, −1 per let-down firm belief; clamped −2..2. */
export function warmth(world: WorldState, who: CharacterId, T: number): number {
  const clamp = (x: number) => Math.min(2, Math.max(-2, x));
  let w = world.characters.find((c) => c.id === who)?.warmth0 ?? 0;
  const settledInPerson = new Set<string>();
  for (const r of recordsOf(world, who, T)) {
    if (r.kind === 'letter-shown' && r.source === 'news') {
      w = clamp(w + 1);
    } else if (r.kind === 'settled' && r.facts.full && r.source === 'witnessed' && !settledInPerson.has(r.facts.agreement)) {
      settledInPerson.add(r.facts.agreement);
      w = clamp(w + 1);
    }
  }
  for (const b of beliefsOf(world, who)) {
    if (b.firmness === 'firm' && letDown(world, b, T)) w = clamp(w - 1);
  }
  return w;
}

/** overdueT = expectedT + 24·w, longT = overdueT + 24·(14 + 3·w), with w = warmth of the owner at T. */
export function overdueTimes(world: WorldState, a: Agreement, T: number): { overdueT: number; longT: number } {
  const w = warmth(world, a.owner, T);
  const overdueT = a.expectedT + 24 * w;
  return { overdueT, longT: overdueT + 24 * (14 + 3 * w) };
}

/** 'none' once the owner holds a full settled record at or before T; else by overdueTimes (boundaries count as reached). */
export function stage(world: WorldState, a: Agreement, T: number): Stage {
  const settledInFull = recordsOf(world, a.owner, T).some(
    (r) => r.kind === 'settled' && r.facts.full && r.facts.agreement === a.id,
  );
  if (settledInFull) return 'none';
  const { overdueT, longT } = overdueTimes(world, a, T);
  if (T < overdueT) return 'none';
  return T < longT ? 'overdue' : 'long-overdue';
}

/** trustBase, then the records in time order; 0 while any of their agreements is overdue or long overdue. */
export function trustLimit(world: WorldState, who: CharacterId, T: number): number {
  let L = world.characters.find((c) => c.id === who)?.trustBase ?? 0;
  for (const r of recordsOf(world, who, T)) {
    if (r.kind === 'settled' && r.facts.full) {
      L = Math.max(L, r.facts.onTime ? 2 * r.facts.value : r.facts.value);
    } else if (r.kind === 'sold-below') {
      L = Math.floor(L / 2);
    }
  }
  for (const a of world.agreements) {
    if (a.owner === who && stage(world, a, T) !== 'none') return 0;
  }
  return L;
}
