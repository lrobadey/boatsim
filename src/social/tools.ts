// The tools a character may call in conversation (expectations-mvp-spec §4, docs/pass-2-plan.md lane B). Their
// definitions and execution live here, in trusted code; every argument is validated and every effect goes through
// a 1c or Pass 2 command with a request id. A card tool only shows the player a card; the player's confirmation
// runs the command. Pure: no DOM.

import type { Dealings, Result } from '../trade/consignment';
import type { SocialActions } from './actions';
import type { CharacterId, WorldState } from '../trade/world';
import type { TalkLine } from '../ui/talk';

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

/** The five tool definitions, the same for every character. Pass 2 lane B. */
export function toolDefs(): ToolDef[] {
  throw new Error('not implemented: Pass 2 B');
}

/** Runs one tool call. Unknown tools and malformed arguments give { ok: false, reason: 'unsupported' }. Pass 2 lane B. */
export function runTool(_ctx: ToolContext, _name: string, _args: string, _req: string): ToolOutcome {
  throw new Error('not implemented: Pass 2 B');
}
