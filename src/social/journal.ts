// What the personal menu shows (expectations-mvp-spec §5, Pass 3): belongings, ship cargo, expectations and
// accounts, rendered as plain lines straight from the structured books and records. Pure: no DOM, no game.
// Dates, quantities and money come from data; a character's private numbers (warmth, trust limit) never appear.

import type { CargoLot, Receipt } from '../trade/books';
import { goodById } from '../trade/goods';
import { formatDr } from '../trade/money';
import type { VentureAccount } from '../trade/consignment';
import type { Agreement, CharacterId, Holder, WorldState } from '../trade/world';
import type { SocialRecord } from './records';

export interface JournalItem {
  title: string;
  lines: string[];
}

export interface Belonging extends JournalItem {
  /** the document id */
  id: string;
  /** the letter as written */
  body: string;
}

export interface JournalView {
  belongings: Belonging[];
  /** one line per lot group: aboard first, then on the quay */
  cargo: string[];
  expectations: JournalItem[];
  accounts: { purse: string; ventures: JournalItem[]; recent: string[] };
}

export interface JournalOptions {
  world: WorldState;
  voyage: { purse: number; lots: readonly CargoLot[]; receipts: readonly Receipt[] };
  now: number;
  names: (who: CharacterId) => string;
  portNames: Record<number, string>;
  /** "13 Skirophorion · Year 1" for an absolute hour */
  dateWords: (T: number) => string;
  account: (agreement: string) => VentureAccount | null;
}

/** agreement figures to the centidrachma, as the cards show them */
const dr2 = (c: number) => `${c < 0 ? '−' : ''}${(Math.abs(c) / 100).toFixed(2)} dr`;
const goodName = (good: CargoLot['good']) => goodById(good).name.toLowerCase();
const jars = (n: number) => `${n} ${n === 1 ? 'jar' : 'jars'}`;

/**
 * A deadline at absolute hour T (the start of a day, as cutoffs are) and the whole days left before it:
 * "the end of 29 Skirophorion · Year 1 (16 days left)". Shared with the conversation cards.
 */
export function deadlineWords(dateWords: (T: number) => string, T: number, now: number): string {
  const h = T - now;
  const left = h <= 0 ? 'passed' : h < 24 ? 'less than a day left' : `${Math.floor(h / 24)} ${Math.floor(h / 24) === 1 ? 'day' : 'days'} left`;
  return `the end of ${dateWords(T - 1)} (${left})`;
}

/** "11:52 on 13 Skirophorion · Year 1" for an absolute hour */
export function whenWords(dateWords: (T: number) => string, T: number): string {
  const hours = T - 24 * Math.floor(T / 24);
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} on ${dateWords(T)}`;
}

function ownerWords(o: JournalOptions, owner: string): string {
  if (owner === 'player') return 'yours';
  const id = owner.startsWith('char:') ? (owner.slice(5) as CharacterId) : null;
  return id ? `${o.names(id)}'s` : owner;
}

function cargoLines(o: JournalOptions): string[] {
  const groups = new Map<string, number>();
  const order: string[] = [];
  for (const l of o.voyage.lots) {
    let where: string;
    if (l.custody.at === 'aboard') where = l.moving === 'unload' ? 'aboard, going ashore' : 'aboard';
    else if (l.custody.at === 'quay') where = `on the quay at ${o.portNames[l.custody.port] ?? ''}${l.moving === 'load' ? ', waiting to load' : ''}`;
    else continue;
    const key = `${l.good}|${l.owner}|${where}`;
    if (!groups.has(key)) order.push(key);
    groups.set(key, (groups.get(key) ?? 0) + l.qty);
  }
  const rank = (k: string) => (k.endsWith('|aboard') ? 0 : k.includes('|aboard') ? 1 : 2);
  return order
    .sort((a, b) => rank(a) - rank(b))
    .map((k) => {
      const [good, owner, where] = k.split('|');
      return `${jars(groups.get(k)!)} of ${goodName(good as CargoLot['good'])} · ${ownerWords(o, owner)} · ${where}`;
    });
}

function status(o: JournalOptions, a: Agreement, acc: VentureAccount | null): string {
  if (a.settledT !== null) return `Settled on ${o.dateWords(a.settledT)}.`;
  if (acc?.closed) return 'All sold or returned. Not settled yet.';
  return 'Open.';
}

function agreementItem(o: JournalOptions, a: Agreement): JournalItem {
  const owner = o.names(a.owner);
  const t = a.terms;
  const acc = o.account(a.id);
  const lines = [
    `${jars(t.qty)} of ${goodName(t.good)}, valued at ${dr2(t.perJar)} a jar (${dr2(t.perJar * t.qty)} in all).`,
    `For ${o.names(t.buyer)} by ${deadlineWords(o.dateWords, t.opportunityT, o.now)}${t.alternateSale ? ', or sold elsewhere' : ''}. You keep ${t.share}% of the profit after the agreed value and the handling and sale costs.`,
    `Agreed on ${o.dateWords(a.acceptedT)}. By the terms, ${owner} expects you back by ${o.dateWords(a.expectedT)}.`,
    `Loaded ${a.loaded} · sold ${a.sold} · returned ${a.returned}.`,
  ];
  for (const r of o.world.records) if (r.kind === 'promise' && r.facts.agreement === a.id) lines.push(...promiseLines(o, r));
  lines.push(status(o, a, acc));
  return { title: `${owner}'s ${goodName(t.good)} for ${o.names(t.buyer)}`, lines };
}

function promiseLines(o: JournalOptions, r: Extract<SocialRecord, { kind: 'promise' }>): string[] {
  const who = o.names(r.holder as CharacterId);
  return [
    `You said: “${r.facts.citation}”`,
    `${who} took it as ${r.facts.interpretation === 'firm' ? 'a firm promise' : r.facts.interpretation === 'conditional' ? 'a conditional promise' : 'a tentative promise'}, by ${o.dateWords(r.facts.expectT - 1)}.`,
  ];
}

function ventureItem(o: JournalOptions, a: Agreement): JournalItem | null {
  const acc = o.account(a.id);
  if (!acc) return null;
  const owner = o.names(a.owner);
  const lines = [
    `Sales ${dr2(acc.G)} · costs ${dr2(acc.C)} · ${acc.s} sold, ${acc.r} returned.`,
    acc.closed
      ? `Profit ${dr2(acc.profit)} · your share ${dr2(acc.share)}.`
      : 'Your share is worked out once every jar is sold or returned.',
    a.settledT !== null ? `Settled on ${o.dateWords(a.settledT)}.` : `Owed to ${owner}: ${dr2(Math.max(0, acc.payable))}.`,
  ];
  return { title: `${owner}'s ${goodName(a.terms.good)} (${jars(a.terms.qty)})`, lines };
}

const RECEIPT_WORDS: Record<Receipt['kind'], string> = {
  opening: 'Opening purse',
  sale: 'Sale',
  purchase: 'Purchase',
  duty: 'Duty',
  porterage: 'Porterage',
  wages: 'Wages',
  remit: 'Paid over',
};

export function journalView(o: JournalOptions): JournalView {
  const mine = (h: Holder) => h === 'player';
  const belongings = o.world.documents
    .filter((d) => mine(d.holder))
    .map((d) => ({
      id: d.id,
      title: `Letter from ${o.names(d.from)} to ${o.names(d.to)}`,
      lines: [`Written on ${o.dateWords(d.writtenT)}.`],
      body: d.body,
    }));
  const agreements = [...o.world.agreements].sort((x, y) => Number(x.settledT !== null) - Number(y.settledT !== null) || y.acceptedT - x.acceptedT);
  const expectations = agreements.map((a) => agreementItem(o, a));
  // spoken promises tied to no agreement are listed on their own
  for (const r of o.world.records) {
    if (r.kind === 'promise' && !r.facts.agreement) expectations.push({ title: `Said to ${o.names(r.holder as CharacterId)}`, lines: promiseLines(o, r) });
  }
  const recent = o.voyage.receipts
    .slice(-8)
    .reverse()
    .map((r) => `${o.dateWords(r.T)} · ${RECEIPT_WORDS[r.kind]}${r.qty ? ` · ${jars(r.qty)}` : ''} · ${formatDr(r.amount)}`);
  return {
    belongings,
    cargo: cargoLines(o),
    expectations,
    accounts: {
      purse: formatDr(o.voyage.purse),
      ventures: agreements.map((a) => ventureItem(o, a)).filter((x): x is JournalItem => x !== null),
      recent,
    },
  };
}
