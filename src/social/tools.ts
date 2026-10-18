// The tools a character may call in conversation (expectations-mvp-spec §4, docs/pass-2-plan.md lane B). Their
// definitions and execution live here, in trusted code; every argument is validated and every effect goes through
// a 1c or Pass 2 command with a request id. A card tool only shows the player a card; the player's confirmation
// runs the command. Pure: no DOM.

import type { Dealings, Result, VentureAccount } from '../trade/consignment';
import type { SocialActions } from './actions';
import { GOOD_IDS, goodById, type GoodId } from '../trade/goods';
import type { CharacterId, WorldState } from '../trade/world';
import type { TalkLine } from '../ui/talk';
import { personaById } from '../trade/trader';

/** A function tool definition (OpenAI Responses API, strict). */
export interface ToolDef {
  type: 'function';
  name: string;
  description: string;
  strict: true;
  parameters: object;
}

/** A confirmation waiting for the player. */
export interface Card {
  /** `${request id}`: the confirm command runs with `${id}:confirm`, the decline with `${id}:decline` */
  id: string;
  kind: 'proposal' | 'transaction' | 'settlement';
  /** plain text for the card (no hints, causes or advice) */
  title: string;
  lines: string[];
  /** the authoritative command; its result is what the model hears */
  confirm(req: string): Result<object>;
  /** for a proposal: declines that revision */
  decline?(req: string): Result<object>;
}

export interface ToolContext {
  world: WorldState;
  dealings: Dealings;
  actions: SocialActions;
  /** who is talking (the tool's actor) */
  character: CharacterId;
  /** where the conversation happens */
  port: number;
  /** the player's berth at this port, or null when their ship isn't here */
  berth: number | null;
  /** the transcript, for citations */
  lines: readonly TalkLine[];
  now: number;
}

export interface ToolOutcome {
  /** what the model is told (JSON-serialisable): { ok: true, ... } or { ok: false, reason } */
  output: object;
  card?: Card;
}

const BUYERS = ['damaris', 'philon', 'myrto'] as const;
const money = (c: number) => (c / 100).toFixed(2) + ' dr';
const unsupported: ToolOutcome = { output: { ok: false, reason: 'unsupported' } };

const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isBool = (x: unknown): x is boolean => typeof x === 'boolean';
const oneOf = <T extends string>(x: unknown, xs: readonly T[]): x is T => typeof x === 'string' && (xs as readonly string[]).includes(x);

/** The five tool definitions, the same for every character. Pass 2 lane B. */
export function toolDefs(): ToolDef[] {
  return [
    {
      type: 'function',
      name: 'propose_expectation',
      description:
        'Propose an expectation when a meaningful future action matters to you or the other person and it is useful to make the understanding explicit. Only consignments of your own goods are supported; the player decides on a card.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['subject', 'good', 'jars', 'buyer', 'alternate_sale'],
        properties: {
          subject: { type: 'string', enum: ['consignment'] },
          good: { type: 'string', enum: [...GOOD_IDS] },
          jars: { type: 'integer', description: 'how many jars' },
          buyer: { type: 'string', enum: [...BUYERS] },
          alternate_sale: { type: 'boolean', description: 'may the player sell the jars elsewhere' },
        },
      },
    },
    {
      type: 'function',
      name: 'request_transaction',
      description: 'Offer to buy jars from the player yourself, at your real price. The player decides on a card.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['jars', 'whose'],
        properties: {
          jars: { type: 'integer', description: 'how many jars to buy' },
          whose: { type: 'string', enum: ['player', 'consignment'], description: "'consignment' for jars the player carries for someone else (such as Damaris's wine), 'player' for the player's own. Follow what they offered." },
        },
      },
    },
    {
      type: 'function',
      name: 'request_settlement',
      description: 'Work out the account for goods the player carried for you, when they are back to settle. The player decides on a card.',
      strict: true,
      parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
    },
    {
      type: 'function',
      name: 'show_document',
      description: 'Show the player a document you hold. Showing is not giving unless hand_over is true.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['document_id', 'hand_over'],
        properties: {
          document_id: { type: 'string' },
          hand_over: { type: 'boolean', description: 'true to give the document to the player' },
        },
      },
    },
    {
      type: 'function',
      name: 'record_promise',
      description:
        'Record something concrete the player said about the future that matters to you: their words, how you took it, and which of their lines said it.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'interpretation', 'line', 'agreement_id', 'expect_day'],
        properties: {
          claim: { type: 'string', description: 'what they said, in their words' },
          interpretation: { type: 'string', enum: ['firm', 'tentative', 'conditional'] },
          line: { type: 'integer', description: "1-based number of the player's line as listed in their_lines" },
          agreement_id: { type: 'string', description: "the agreement it concerns, or '' for none" },
          expect_day: { type: 'integer', description: 'the calendar day number it is expected by' },
        },
      },
    },
  ];
}

/** Runs one tool call. Unknown tools and malformed arguments give { ok: false, reason: 'unsupported' }. Pass 2 lane B. */
export function runTool(ctx: ToolContext, name: string, args: string, req: string): ToolOutcome {
  try {
    let a: unknown;
    try {
      a = JSON.parse(args);
    } catch {
      return unsupported;
    }
    if (typeof a !== 'object' || a === null) return unsupported;
    const p = a as Record<string, unknown>;
    switch (name) {
      case 'propose_expectation':
        return propose(ctx, p, req);
      case 'request_transaction':
        return transaction(ctx, p, req);
      case 'request_settlement':
        return settlement(ctx, req);
      case 'show_document':
        return showDocument(ctx, p, req);
      case 'record_promise':
        return recordPromise(ctx, p, req);
      default:
        return unsupported;
    }
  } catch {
    return unsupported;
  }
}

function propose(ctx: ToolContext, a: Record<string, unknown>, req: string): ToolOutcome {
  const { world, dealings, character } = ctx;
  if (
    a.subject !== 'consignment' ||
    !oneOf(a.good, GOOD_IDS) ||
    !isInt(a.jars) ||
    !oneOf(a.buyer, BUYERS) ||
    !isBool(a.alternate_sale)
  )
    return unsupported;
  if (a.buyer !== 'philon' || !world.celebration) return unsupported;
  const input = {
    good: a.good,
    qty: a.jars,
    alternateSale: a.alternate_sale,
    buyer: a.buyer,
    opportunityT: world.celebration.cutoffT,
  };
  const open = world.proposals.find(
    (p) => p.owner === character && p.revisions[p.revisions.length - 1].status === 'open',
  );
  const r = open ? dealings.revise(req, open.id, input) : dealings.propose(req, character, input);
  if (!r.ok) return { output: { ok: false, reason: r.reason } };
  const { proposal, revision, terms } = r;
  const per = money(terms.perJar);
  const value = money(terms.perJar * terms.qty);
  const Name = personaById(character).name;
  const BuyerName = personaById(terms.buyer).name;
  const card: Card = {
    id: req,
    kind: 'proposal',
    title: `${Name} proposes a consignment`,
    lines: [
      `${terms.qty} jars of ${goodById(terms.good).name.toLowerCase()}, valued at ${per} a jar (${value} in all).`,
      terms.alternateSale ? `You may sell them to ${BuyerName} or elsewhere.` : `They are for ${BuyerName}.`,
      `You keep ${terms.share}% of the profit after the agreed value and the handling and sale costs. ${Name} pays the handling at the home quay.`,
    ],
    // accepting at her quay with the ship there starts the loading at once; the result says if loading couldn't start
    confirm: (x) => {
      const r = dealings.accept(x, proposal, revision);
      if (!r.ok || ctx.berth === null || ctx.port !== terms.homePort) return r;
      const load = dealings.startLoading(`${x}:load`, r.agreement, ctx.port, ctx.berth);
      return { ...r, loading: load.ok ? 'started' : load.reason };
    },
    decline: (x) => dealings.decline(x, proposal, revision),
  };
  return {
    output: { ok: true, proposal, revision, per_jar: per, value, card: 'shown to the player' },
    card,
  };
}

function transaction(ctx: ToolContext, a: Record<string, unknown>, req: string): ToolOutcome {
  const { world, dealings, character, port } = ctx;
  if (!isInt(a.jars) || !oneOf(a.whose, ['player', 'consignment'] as const)) return unsupported;
  const berth = ctx.berth;
  if (berth === null) return { output: { ok: false, reason: 'port' } };
  const demand = dealings.buyerDemand(character);
  if (!(a.jars > 0) || a.jars > demand) return { output: { ok: false, reason: 'stock', most_you_will_take: demand } };
  const jars = a.jars;
  const whose = a.whose;
  const agreement =
    whose === 'player'
      ? undefined
      : world.agreements.find((x) => x.closedT === null && (x.terms.buyer === character || x.terms.alternateSale));
  if (whose === 'consignment' && !agreement) return { output: { ok: false, reason: 'unknown' } };
  const from = agreement ? agreement.id : 'player';
  // the jars must be aboard and free now: the player's own, or the agreement owner's under that agreement
  const owner = agreement ? `char:${agreement.owner}` : 'player';
  const free = dealings.o.session.voyage.lots
    .filter((l) => l.good === 'wine' && l.owner === owner && l.custody.at === 'aboard' && l.moving === undefined && l.agreement === agreement?.id)
    .reduce((n, l) => n + l.qty, 0);
  if (free < jars) return { output: { ok: false, reason: 'stock', jars_they_have_free: free } };
  const quote = dealings.buyerQuote(character, port, jars);
  const total = money(quote);
  const per = money(Math.floor(quote / jars));
  const OwnerName = agreement ? personaById(agreement.owner).name : '';
  const card: Card = {
    id: req,
    kind: 'transaction',
    title: `${personaById(character).name} offers to buy wine`,
    lines: [`${jars} jars of ${whose === 'player' ? 'your wine' : `${OwnerName}'s wine`} for ${total} (${per} a jar).`],
    confirm: (x) => dealings.sellToBuyer(x, { buyer: character, port, berth, from, qty: jars, quoted: quote }),
  };
  return { output: { ok: true, jars, whose: whose === 'player' ? 'their own wine' : `${OwnerName}'s wine`, total, per_jar: per, card: 'shown to the player' }, card };
}

function settlement(ctx: ToolContext, req: string): ToolOutcome {
  const { world, dealings, character, port } = ctx;
  const a = [...world.agreements].reverse().find((x) => x.owner === character && x.settledT === null);
  if (!a) return { output: { ok: false, reason: 'unknown' } };
  const acc: VentureAccount | null = dealings.account(a.id);
  if (!acc) return { output: { ok: false, reason: 'unknown' } };
  const figures = {
    gross: money(acc.G),
    costs: money(acc.C),
    profit: money(acc.profit),
    your_commission: money(acc.share),
    payable: money(acc.payable),
    available: money(acc.available),
    closed: acc.closed,
  };
  if (!acc.closed) return { output: { ok: false, reason: 'open', ...figures } };
  if (port !== a.terms.homePort) return { output: { ok: false, reason: 'port' } };
  const owed = acc.payable - acc.available;
  const card: Card = {
    id: req,
    kind: 'settlement',
    title: `Settle with ${personaById(character).name}`,
    lines: [
      `Sales ${figures.gross}, costs ${figures.costs}, profit ${figures.profit}.`,
      `Your commission ${figures.your_commission}.`,
      `You pay ${figures.available}.`,
      ...(owed > 0 ? [`Still owed after this: ${money(owed)}.`] : []),
    ],
    confirm: (x) => dealings.settle(x, { agreement: a.id, port, amount: acc.available }),
  };
  return { output: { ok: true, ...figures }, card };
}

function showDocument(ctx: ToolContext, a: Record<string, unknown>, req: string): ToolOutcome {
  if (!isStr(a.document_id) || !isBool(a.hand_over)) return unsupported;
  const result = ctx.actions.showDocument(req, {
    document: a.document_id,
    by: ctx.character,
    to: 'player',
    handOver: a.hand_over,
  });
  return { output: result };
}

function recordPromise(ctx: ToolContext, a: Record<string, unknown>, req: string): ToolOutcome {
  if (
    !isStr(a.claim) ||
    !oneOf(a.interpretation, ['firm', 'tentative', 'conditional'] as const) ||
    !isInt(a.line) ||
    !isStr(a.agreement_id) ||
    !isInt(a.expect_day)
  )
    return unsupported;
  const mine = ctx.lines.filter((l) => l.who === 'you');
  const cited = mine[a.line - 1];
  if (!cited) return { output: { ok: false, reason: 'citation' } };
  const result = ctx.actions.recordPromise(req, {
    holder: ctx.character,
    claim: a.claim,
    interpretation: a.interpretation,
    citation: cited.text,
    agreement: a.agreement_id || undefined,
    expectDay: a.expect_day,
  });
  return { output: result };
}
