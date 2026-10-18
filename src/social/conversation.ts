// A conversation with a character (docs/pass-2-plan.md lane B): a bounded tool loop over a model client. The model
// may call tools (src/social/tools.ts) before it replies with the {say, told, note} JSON; each call runs once and its
// result goes back to the model. Card tools leave a pending card: only the player's confirmation runs the
// authoritative command. Pure: the client is injected, so tests script it.

import { runTool, toolDefs, type Card, type ToolContext, type ToolDef } from './tools';
import { parseReply, type TraderReply } from '../trade/trader';
import type { TalkLine } from '../ui/talk';

/** One item of model input (the OpenAI Responses API shapes the proxy forwards). */
export type InputItem =
  | { role: 'user' | 'assistant' | 'developer'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

/** One item of model output, as the proxy normalises it. */
export type OutputItem = { type: 'message'; text: string } | { type: 'function_call'; call_id: string; name: string; arguments: string };

export interface ModelRequest {
  instructions: string;
  input: InputItem[];
  tools: ToolDef[];
  /** the reply's strict JSON schema (replySchema) */
  schema: object;
}

export type ModelResponse = { ok: true; output: OutputItem[] } | { ok: false; error: string };

export interface ModelClient {
  respond(req: ModelRequest): Promise<ModelResponse>;
}

/** Model rounds per player line or card outcome. */
export const MAX_ROUNDS = 4;
/** Transcript lines kept (and sent) per character. */
export const KEEP_LINES = 40;
/** A reply's spoken text is capped at this many characters. */
export const SAY_CAP = 1500;

export interface ConversationOptions {
  /** unique per opening ('C{n}'); request ids are `${id}:${call_id}` */
  id: string;
  client: ModelClient;
  /** what tools act on; rebuilt by the caller, read at each round */
  tools: () => ToolContext;
  /** instructions and reply schema, rebuilt at each round so the facts are current */
  prompt: () => { instructions: string; schema: object };
  /** the saved transcript for this character (caller-owned; trimmed to KEEP_LINES) */
  lines: TalkLine[];
  /** port names for parseReply */
  portNames: Record<number, string>;
  /** the lines that show a document the character showed the player (not sent to the model, not saved) */
  shownLines?: (document: string, handedOver: boolean) => TalkLine[];
}

/** The line shown to the player for a failed turn. */
export function errorText(error: string): string {
  if (error === 'no-key') return 'Talking needs an OpenAI API key (OPENAI_API_KEY in .env.local).';
  if (error === 'timeout') return 'The model took too long to answer. Try again.';
  if (error === 'rounds') return 'No answer came back. Try again.';
  return 'The connection to the model failed. Try again.';
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export class Conversation {
  /** bumped by close(); a response for an older epoch is dropped before any tool runs */
  epoch = 0;
  /** the card waiting for the player, if any */
  card: Card | null = null;

  constructor(readonly o: ConversationOptions) {}

  /**
   * The player says text: appends it, runs the loop, appends the reply (or an 'info' error line) and returns the
   * parsed reply, or null on failure or when closed meanwhile. Pass 2 lane B.
   */
  async say(text: string): Promise<TraderReply | null> {
    this.add({ who: 'you', text });
    return this.loop([]);
  }

  /**
   * Something happened that the character sees (the opening scene, the player showing a letter): no line from the
   * player; the event goes to the model as a developer note and the loop runs once, so the character may speak first.
   */
  async notice(event: string): Promise<TraderReply | null> {
    return this.loop([{ role: 'developer', content: event }]);
  }

  /** The player confirms the card: runs its command, tells the model the outcome, and runs the loop once. */
  async confirm(): Promise<TraderReply | null> {
    const card = this.card;
    if (!card) return null;
    this.card = null;
    const r = card.confirm(`${card.id}:confirm`);
    const done = card.kind === 'proposal' ? 'You accepted.' : card.kind === 'transaction' ? 'Sold.' : 'Paid.';
    this.add({ who: 'info', text: r.ok ? done : 'It could not go ahead.' });
    return this.loop([{ role: 'developer', content: `The player confirmed the ${card.kind} card. Result: ${JSON.stringify(r)}` }]);
  }

  /** The player declines the card: runs its decline (if any), tells the model, and runs the loop once. */
  async decline(): Promise<TraderReply | null> {
    const card = this.card;
    if (!card) return null;
    this.card = null;
    const r = card.decline?.(`${card.id}:decline`);
    this.add({ who: 'info', text: 'You declined.' });
    return this.loop([
      { role: 'developer', content: `The player declined the ${card.kind} card.` + (r ? ` Result: ${JSON.stringify(r)}` : '') },
    ]);
  }

  /** Leaving: bumps the epoch and drops the card without running anything. */
  close(): void {
    this.epoch++;
    this.card = null;
  }

  private add(line: TalkLine): void {
    this.o.lines.push(line);
    const extra = this.o.lines.length - KEEP_LINES;
    if (extra > 0) this.o.lines.splice(0, extra);
  }

  /** The saved transcript as model input: the player's lines as user, the character's as assistant, no info lines. */
  private transcript(): InputItem[] {
    return this.o.lines
      .filter((l) => l.who === 'you' || l.who === 'them')
      .slice(-KEEP_LINES)
      .map((l): InputItem => ({ role: l.who === 'you' ? 'user' : 'assistant', content: l.text }));
  }

  /** Up to MAX_ROUNDS model calls: tool calls run and their results go back; a message is the reply. */
  private async loop(extra: InputItem[]): Promise<TraderReply | null> {
    const e = this.epoch;
    const turn: InputItem[] = [...extra];
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const { instructions, schema } = this.o.prompt();
      const res = await this.o.client.respond({
        instructions,
        input: [...this.transcript(), ...turn],
        tools: toolDefs(),
        schema,
      });
      if (this.epoch !== e) return null;
      if (!res.ok) {
        this.add({ who: 'info', text: errorText(res.error) });
        return null;
      }
      const calls = res.output.filter((x): x is Extract<OutputItem, { type: 'function_call' }> => x.type === 'function_call');
      if (calls.length) {
        for (const call of calls) {
          if (this.epoch !== e) return null;
          const out = runTool(this.o.tools(), call.name, call.arguments, `${this.o.id}:${call.call_id}`);
          if (out.card) this.card = out.card;
          if (out.shown) for (const l of this.o.shownLines?.(out.shown.document, out.shown.handedOver) ?? []) this.add(l);
          turn.push(call, { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(out.output) });
        }
        continue;
      }
      const msg = res.output.find((x): x is Extract<OutputItem, { type: 'message' }> => x.type === 'message');
      const reply = msg ? parseReply(parseJson(msg.text), this.o.portNames, SAY_CAP) : null;
      if (!reply) {
        this.add({ who: 'info', text: errorText('upstream') });
        return null;
      }
      this.add({ who: 'them', text: reply.say });
      return reply;
    }
    this.add({ who: 'info', text: errorText('rounds') });
    return null;
  }
}
