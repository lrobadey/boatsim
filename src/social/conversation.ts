// A conversation with a character (docs/pass-2-plan.md lane B): a bounded tool loop over a model client. The model
// may call tools (src/social/tools.ts) before it replies with the {say, told, note} JSON; each call runs once and its
// result goes back to the model. Card tools leave a pending card: only the player's confirmation runs the
// authoritative command. Pure: the client is injected, so tests script it.

import type { Card, ToolContext, ToolDef } from './tools';
import type { TraderReply } from '../trade/trader';
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
}

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
  say(_text: string): Promise<TraderReply | null> {
    throw new Error('not implemented: Pass 2 B');
  }

  /** The player confirms the card: runs its command, tells the model the outcome, and runs the loop once. */
  confirm(): Promise<TraderReply | null> {
    throw new Error('not implemented: Pass 2 B');
  }

  /** The player declines the card: runs its decline (if any), tells the model, and runs the loop once. */
  decline(): Promise<TraderReply | null> {
    throw new Error('not implemented: Pass 2 B');
  }

  /** Leaving: bumps the epoch and drops the card without running anything. */
  close(): void {
    throw new Error('not implemented: Pass 2 B');
  }
}
