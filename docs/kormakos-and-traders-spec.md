# Kormakos harbour and talking to traders

2026-10-16. Two pieces, kept tight on purpose. Anything not listed under "In" is out.

## User decisions

- Build Kormakos (harbour id 1 on seed 1729) from the Ormos harbour kit.
- Talk to traders by free typing. Speech is plain and modern.
- The trader's voice is OpenAI `gpt-6-luna` on the Responses API with `reasoning.effort: "low"`.
- Keep it tight: no scope creep, and do fewer things well.

## Part A: an authored Kormakos harbour

### How it plays
You sail into Kormakos and find a small, working grain harbour instead of a bare pier. A stone quay runs along the mole. At its root is a paved court with a granary and two houses. Grain sacks are stacked under canopies, there's a threshing floor, and the trader stands at the market corner. You walk off the plank and up into the court the same way you do at Serrothos.

### In
1. **Plans instead of one hard-wired harbour.** `ormosLayout.ts` gains a `HarborPlan` holding:
   - the court: `top`, `halfWidth`, `inland`, `blend`;
   - buildings, cargo, trees and shore placements;
   - the paved floors, the landing slab and the market point;
   - lamps;
   - sack stacks and an optional threshing floor.

   `ORMOS_PLAN` is built from today's constants, so port 0 stays bit-identical. `KORMAKOS_PLAN` is new. `AUTHORED_PLANS = {0: ORMOS_PLAN, 1: KORMAKOS_PLAN}`.
2. **Worldgen** (only when `authoredHarbour`):
   - after the other harbours' piers are built, grade the court of each planned harbour (`prepareHarborGround(..., plan)`);
   - keep that harbour's village houses out of its court (15 m margin);
   - drop vegetation in it (8 m margin).

   This is filter only, with no new RNG draws. The main harbour's code path is unchanged.
3. **`loadOrmosHarbour(gen)`** builds every planned harbour that exists in the world, using one shared `buildAuthoredPort(kit, gen, site, plan)`.
   - It returns `ports: {id, group, solids}[]`.
   - `group` and `solids` stay as port 0's, so the review and profile tools keep working, and the port 0 group keeps its name.
4. **`harbour.ts` and `props.ts`** use the plan instead of `k === 0`:
   - the landing collider, the stall point from `harborMarket(pier, plan)`, and no generic stall bench or posts;
   - no generic pier, stall, dock life, rock faces or boats at a planned port;
   - the trader figure and lamps placed from the plan.

   Ports other than 0 are distance-culled through the existing `blocks` mechanism.
5. **Kormakos composition** in the court's local frame (X across the quay, Z inland), smaller than Ormos (half-width 24 m, 34 m inland):
   - a warehouse used as the granary;
   - house-workshop and house-courtyard;
   - two canopies over sack stacks, built from the game's own sack geometry (`lookGeometry('sack')`, one instanced mesh);
   - a paved threshing floor;
   - packing racks, baskets, rope coils, a few olives, coastal shrubs and rock shoulders.

   The court is checked in the browser and adjusted until it looks right.

### Decisions after the Opus review
- **Kormakos is fitted to one world.** The layout was measured on seed 1729 at 2048, so the worker grades it only there, and only when the quay face leaves at least 10 m before the berths. The worker publishes its choice as `HarbourSite.plan`, and every other file reads that. Low quality (1024) is a different world (cargo spec, decision 9) and keeps the native Kormakos pier. So do other seeds.
- **What stays identical at port 0.** Heights, houses, vegetation, AO and the scenery are all unchanged at port 0. The sea-state bake is not: about 0.1 % of port 0's fetch map changes, because rays from Serrothos now meet Kormakos's new fill 2.7 km away. That is the physical result, and it is accepted.
- **Vegetation.** Every kept plant is set back onto the final ground after the other harbours' dredges and courts.
- **Kormakos's trader and lamps** are culled by distance along with its scenery.

### Out
Any new Blender asset, porters, changes to Korkia, and any change to economy numbers. Grading the court shifts Kormakos's terrain profile a little, which is accepted.

### Acceptance
- Typecheck, build, `test:ormos`, harbour, mooring, walker and cargo suites all pass.
- Port 0 is unchanged.
- In the browser at Kormakos:
  - you can dock;
  - the plank lands on the quay;
  - you can walk into the court;
  - the trader prompt appears;
  - nothing floats or clips at noon and dusk;
  - the console is clean.

## Part B: talking to traders

### How it plays
On foot at a stall, `E Talk` opens a conversation panel. You type. The trader answers in a sentence or three, in plain modern speech.

The trader knows:
- their own port's prices and whether stock is low or high;
- prices at other ports, as heard from arriving ships, which are as old as the voyage that brought them;
- a short note about you from earlier visits.

When the trader tells you another port's price, it goes into your notebook with its age, marked as heard. `Tab` opens the ledger and `Esc` leaves. Haggling is not part of this pass.

### In
1. **`src/trade/news.ts`** (pure). This is the price history.
   - At each new game day, and at the start of a session, it records ask and bid for every port and good. It keeps 30 days.
   - `heard(listener, about, now, routeHours)` returns the latest record at or before `now − routeHours(about, listener)`, or nothing.
   - It is saved as an optional field of the save, so old saves stay valid.
2. **`src/trade/trader.ts`** (pure).
   - A persona per port, seeded from the world seed and port id: a name and a temperament.
   - `traderFacts(...)` builds the facts JSON: the trader's market in dr, stock words, heard news with source port and age in days, time of day, the memory note, and how much the player has traded at this port.
   - The system instructions, and the response JSON schema:
     - `say`: string;
     - `told`: a list of `{port, good}`;
     - `note`: string of at most 300 characters.
3. **Proxy.** A Vite plugin middleware `POST /__trieres_talk__` in `scripts/talk-proxy.mjs`, used by both the dev server and the macOS launcher, which already loads the Vite config.
   - It reads `OPENAI_API_KEY` from the environment or from `.env.local` through Vite's `loadEnv`. The key never reaches the client.
   - It calls `https://api.openai.com/v1/responses` with:
     - `model: "gpt-6-luna"`, `reasoning: {effort: "low"}`;
     - `text.format` set to a strict JSON schema;
     - `store: false`.
   - It has a 30 s timeout.
   - It returns `{ok, reply}` or `{ok: false, error: 'no-key' | 'upstream' | 'timeout'}`.
4. **`src/ui/talk.ts` and `talk.css`.** The panel matches the ledger's look.
   - Header: the trader's name and the port. Below it, the transcript and a text field.
   - Hint line: `Enter Say · Tab Ledger · Esc Leave`.
   - While the panel is open, game input is frozen, the same way the ledger does it.
   - While waiting for a reply, the trader's line shows `…`.
   - Errors are plain text. With no key the line reads `Talking needs an OpenAI API key (OPENAI_API_KEY in .env.local).` The ledger still opens with Tab.
5. **Wiring in `tradeLayer.ts`.**
   - The stall interaction's label becomes `Talk` and opens the panel.
   - `Tab` closes the panel and opens the ledger in the usual mode for that port. (A reply never opens the ledger by itself: it would hide what the trader just said.)
   - Each entry in `told` that matches a heard record is written to the notebook, but only when it is newer than the existing entry.
   - The note is kept per port and saved.
   - `ledgerOpen` counts the talk panel as open, so the game's input and Escape handling stay gated.
6. **Notebook entries** gain an optional `heard: true`. The notebook's age cell reads `heard 3 d`.

### Rules for the trader's speech (in the instructions)
- Plain, modern, conversational English, 1–3 sentences.
- No archaic phrasing, no exclamation marks, no emoji.
- Never invent a number. Only state prices that appear in the facts, and list every other-port price you state in `told`.
- Never advise the best trade or explain why a price moved. You can say what you heard and from whom.
- If asked about things you don't know, say so briefly.

### Out
Haggling, contracts, credit, voice audio, per-NPC ships and talking to anyone other than the stall traders.

### Acceptance
- Unit tests for `news.ts` (record, lag, cap, save round trip) and `trader.ts` (facts contain only real numbers, schema shape).
- With a key, in the browser: a conversation at Serrothos and at Kormakos; asking about another port's wheat puts a heard entry in the notebook; Tab opens the ledger; the note survives a save and reload.
- Without a key: the plain error appears and Tab still opens the ledger.
- Console clean.
