// The stall traders' voice (docs/kormakos-and-traders-spec.md, part B). Pure: builds the persona, the facts,
// the instructions and the reply schema the model is held to, and reads the reply back. The economy is the
// only source of numbers; the model chooses words, never prices.

import { GOODS, GOOD_IDS, type GoodId } from './goods';
import { hash01 } from './hash';
import type { Heard } from './news';

export interface Persona {
  name: string;
  manner: string;
}

const NAMES = ['Nikias', 'Damaris', 'Theron', 'Agathe', 'Philon', 'Myrto', 'Menon', 'Eudora', 'Lykon', 'Phila', 'Kallias', 'Straton'];
const MANNERS = [
  'brisk and practical; short answers; a little warmer with people who come back',
  'talkative; likes passing on what the sailors say, and remembers faces',
  'careful and dry; says less than they know until they trust you',
  'friendly but tired; grumbles about the porters and the wind',
  'proud of the island and its harvest; quick to correct a wrong price',
  'quiet and exact; answers the question asked and no more',
];

/** One persona per port and world, stable across sessions. */
export function personaFor(seed: number, port: number): Persona {
  return {
    name: NAMES[Math.floor(hash01(seed, port, 7101) * NAMES.length)],
    manner: MANNERS[Math.floor(hash01(seed, port, 7102) * MANNERS.length)],
  };
}

/** The part of a market the facts read. */
export interface FactsMarket {
  ask(): number;
  bid(): number;
  S: number;
  S_ref: number;
}

export interface FactsInput {
  persona: Persona;
  port: number;
  portName: string;
  portNames: Record<number, string>;
  /** absolute game hours */
  now: number;
  market: (good: GoodId) => FactsMarket;
  /** what this port has heard about each other port, or null when no ship has brought news */
  heard: { port: number; news: Heard | null }[];
  /** the trader's saved note about this customer ('' the first time) */
  memory: string;
  shipHere: boolean;
}

const dr = (c: number) => (c / 100).toFixed(1) + ' dr';

function stockWord(S: number, ref: number): string {
  const r = ref > 0 ? S / ref : 1;
  return r < 0.5 ? 'very short' : r < 0.8 ? 'short' : r < 1.25 ? 'normal' : r < 2 ? 'plenty' : 'more than we can sell';
}

function clockWords(T: number): string {
  const h = ((T % 24) + 24) % 24;
  const part = h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
  return `day ${Math.floor(T / 24) + 1}, ${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')} (${part})`;
}

/** The facts block: everything the trader may say, with every number already formatted. */
export function traderFacts(o: FactsInput): string {
  const unit = (id: GoodId) => GOODS.find((g) => g.id === id)!.unit[0];
  const name = (id: GoodId) => GOODS.find((g) => g.id === id)!.name;
  const facts = {
    time: clockWords(o.now),
    your_stall: GOOD_IDS.map((id) => {
      const m = o.market(id);
      return { good: name(id), per: unit(id), you_sell_at: dr(m.ask()), you_buy_at: dr(m.bid()), your_stock: stockWord(m.S, m.S_ref) };
    }),
    news_from_ships: o.heard.map(({ port, news }) =>
      news
        ? {
            port: o.portNames[port],
            days_old: Math.max(0, Math.round(((o.now - news.T) / 24) * 2) / 2),
            prices_there: GOOD_IDS.map((id) => ({ good: name(id), they_sell_at: dr(news.ask[id]), they_buy_at: dr(news.bid[id]) })),
          }
        : { port: o.portNames[port], days_old: null, prices_there: 'no ship from there lately' },
    ),
    this_customer: {
      your_note: o.memory || 'first time you have spoken',
      their_ship: o.shipHere ? 'tied up at your quay' : 'not at your quay',
    },
  };
  return JSON.stringify(facts);
}

/** The system instructions. Kept short: who they are, how they talk, what they know, what they never do. */
export function traderInstructions(p: Persona, portName: string, facts: string): string {
  return `You are ${p.name}, who runs the trading stall on the quay at ${portName}, a small island harbour in the ancient Aegean. You buy and sell wine, olive oil, wheat, almonds, salt fish, honey, firewood and pitch. You're talking with the master of a merchant ship who trades between the islands.

How you talk
- Plain, modern, everyday English, as a real person at work. One to three short sentences.
- Your manner: ${p.manner}.
- No old-fashioned or mock-ancient wording, no exclamation marks, no emoji, no stage directions.

What you know
- Only what is in FACTS below. Never invent a price, a ship, a person or an event.
- Your own prices and stock. You don't bargain: today's prices are the prices.
- Other ports only through news_from_ships. When you pass on a price, say how old the news is.
- If you don't know something, say so plainly.

What you never do
- Advise what to buy or where to sell, predict prices, or explain why a price moved.
- Mention facts, data, games or AI.

Reply fields
- say: what you say.
- told: every price from another port that you stated in say, as {port, good}. Empty if none.
- note: your private note on this customer for next time, under 300 characters. Their name if given, what they trade, how they deal with you. Keep what still matters from your_note.

FACTS
${facts}`;
}

/** The strict JSON schema the reply must follow (OpenAI Structured Outputs). */
export function replySchema(otherPorts: string[]): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['say', 'told', 'note'],
    properties: {
      say: { type: 'string' },
      told: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['port', 'good'],
          properties: {
            port: { type: 'string', enum: otherPorts.length ? otherPorts : ['none'] },
            good: { type: 'string', enum: GOODS.map((g) => g.name) },
          },
        },
      },
      note: { type: 'string' },
    },
  };
}

export interface TraderReply {
  say: string;
  told: { port: number; good: GoodId }[];
  note: string;
}

/** Reads a reply back. Unknown ports or goods in `told` are dropped; text is trimmed and capped. */
export function parseReply(raw: unknown, portNames: Record<number, string>): TraderReply | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.say !== 'string' || !r.say.trim()) return null;
  const byName = new Map(Object.entries(portNames).map(([id, n]) => [n, Number(id)]));
  const told: TraderReply['told'] = [];
  if (Array.isArray(r.told))
    for (const t of r.told) {
      const port = byName.get((t as { port?: string })?.port ?? '');
      const good = GOODS.find((g) => g.name === (t as { good?: string })?.good)?.id;
      if (port !== undefined && good && !told.some((x) => x.port === port && x.good === good)) told.push({ port, good });
    }
  return {
    say: r.say.trim().slice(0, 600),
    told,
    note: typeof r.note === 'string' ? r.note.trim().slice(0, 300) : '',
  };
}
