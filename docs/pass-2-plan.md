# Pass 2 plan: social interaction

The lead's plan, written October 17, 2026, for [expectations-mvp-spec.md](expectations-mvp-spec.md) §3.1, §3.6
(spoken promises), §4 and §7 Pass 2. Kept short on purpose: the stubs are the interface.

## What Pass 2 delivers

- **Characters talk through a bounded tool loop** (`src/social/conversation.ts`). The model replies with the
  existing `{say, told, note}` JSON and may call tools first. At most 4 model rounds per player line. Each tool
  call runs once (request id = conversation id + call id) and its result goes back to the model before it speaks.
- **Tools** (defined in trusted code, `src/social/tools.ts`), the same set for every character; the commands
  decide what is allowed:
  - `propose_expectation`: a consignment proposal (reuses or revises an open one). It shows the player a card.
  - `request_transaction`: the talking character buys jars from the player at its real quote. It shows a card.
  - `request_settlement`: the venture's computed account. It shows a card.
  - `show_document`: shows a document the character holds, optionally handing it over.
  - `record_promise`: records something the player said as a claim, her reading of it and the cited line.
- **Cards.** One pending card per conversation. The player confirms (Enter) or declines (Backspace). Only a
  confirmation runs the authoritative 1c command (accept, sell to buyer, settle). The result goes back to the
  model, which then reacts. Leaving the conversation drops the card with no change.
- **Documents** (`world.documents`). Damaris holds Philon's letter on a fresh voyage. Showing records who learned
  what and leaves possession unchanged; handing over moves it. When the player shows Philon his own letter, he
  writes to Damaris, and by ship she learns it (`letter-shown`, news: warmth +1).
- **Grounded context.** Each character's instructions add: their objectives, what they hold, their dealings
  with the player, and plain sentences built from their own records only. Warmth becomes a plain word and the
  trust limit a figure; neither ever leaves trusted code as an authority. Replies may run longer when that's
  natural (cap 1,500 characters).
- **Persistence.** The last 40 lines per character are saved; tool exchanges are not. Notes stay as tone only.
- **Proxy.** It forwards `{instructions, input, tools, schema}` to the Responses API with gpt-6-luna on **medium**
  reasoning, 4,000 output tokens and a 60 s timeout, and returns the output items. The key stays server side.
- **Stale and failed responses.** Closing the panel or a new voyage bumps the conversation's epoch; a response
  for an old epoch is dropped before any tool runs. An outage shows the existing error line; nothing changes.

The player showing their own documents (Pass 3 personal menu) uses the same `showDocument` command; Pass 2
adds no UI for it.

## Lanes (all in parallel after the stubs)

| Lane | Who | Files |
|---|---|---|
| Stubs | Lead | types and signatures in world.ts, records.ts, actions.ts, conversation.ts, tools.ts |
| A. Actions and world | Haiku | src/social/actions.ts, src/trade/world.ts, src/social/records.ts, src/trade/save.ts |
| B. Conversation and tools | Haiku | src/social/conversation.ts, src/social/tools.ts, src/trade/trader.ts |
| C. Proxy, card UI, wiring | Haiku | scripts/talk-proxy.mjs, src/ui/talk.ts, src/ui/talk.css, src/tradeLayer.ts |
| Gate tests | Opus, ≤ 400 lines | scripts/test-conversation.mjs (scripted model, no network) |
| Review | Opus, once | authority, idempotency, stale responses, information boundaries, save |

## Decisions (yours to overrule)

1. Tools use function calling alongside the structured `{say, told, note}` reply, so price news still reaches
   the notebook.
2. Cards: Ctrl+Enter confirms, Ctrl+Backspace declines, Esc leaves (and drops the card). The text line stays
   usable while a card is shown (changed after the live run: a card must not block questions).
3. Damaris hands the letter over only through `show_document` with `hand_over`. The model decides when.
4. A spoken promise's expected date is a calendar day the model names; trusted code turns it into the end of that
   day. Only `settled` and `returned` records count as keeping a promise or an expectation.
5. Philon knows his own remaining need as a number but is told to keep it private.
6. Accepting a consignment at the owner's quay with the ship there starts the loading at once (added during
   testing: nothing else started it).

## Result (October 17, 2026)

All gates pass: typecheck, test:trade (golden unchanged), world, calendar, records, consignment (22),
conversation (14, scripted model), talk (14), lint, build. One Opus review found four issues (1c mail turning into
"letter shown" news, live sale counts in Damaris's prompt, promises on other people's agreements, a promise date a
day late); all fixed.

Live run against gpt-6-luna (medium), headless through the real dev proxy and in the game: Damaris proposes,
explains the value as a starting value, hands over the letter and records a conditional promise; the card loads
the jars; Philon prices through his tool (9.43 a jar against a stall bid of 8.40) and buys her forty; Damaris
works out the account and is paid in full, and her warmth rises. Fixes from the live run: buyers price through the
tool and refusals say what they can take; cards keep the text line; declined proposals, the cost policy and whose
jars are offered are in the character's knowledge or tool descriptions. Still to judge by playing: how eager she
is to propose, and long-run conversational quality.
