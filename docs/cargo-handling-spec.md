# Cargo handling: physical work and commitments

2026-10-15. Lead design with GPT-6 Astra (low). Execution is assigned to GPT-6 Luna (high); workers implement these decisions and escalate ambiguities without redesigning them.

## Choice

We compared anchor seamanship, cargo handling, and voyage accounts. Cargo handling wins because the existing signed pending quantity can erase real work: sell ten wine jars, then buy ten before transfer, and pending becomes zero. It also treats every package as the same workload. Anchor holding needs a separate physical calibration pass; voyage accounts should follow reliable cargo movements.

The player should feel the cost of handling a heavy cargo through berth time, wages, visible cargo movement, and changing physical load. This extends the current trade loop; no new currencies, NPCs, controls, markets, cargo damage, or handling skill system.

## Frozen model

- Handling rate is **400 kg per game hour**, an explicit gameplay choice. Wheat remains ten sacks/hour; ten 42 kg wine jars take 1.05 hours; ten 25 kg honey jars take 0.625 hours. Porter fees, prices, wages, and duties keep their current rules.
- Confirmed purchases and sales remain separate physical obligations. They never cancel. Payment/stock still settle at confirmation. Each actual crossing changes the manifest and quay and charges exactly one existing porter fee.
- New `CargoJob` schema in `voyage.ts`: `version: 2`, `port`, `berth`, `incoming` and `outgoing` (nonnegative integer per-good maps), `quay`, `active: { good: GoodId; direction: 'load' | 'unload'; workKg: number } | null`, and `cartAt: number | null` (absolute game hour).
- Counts include the active unit. Select outgoing in GOODS order, then incoming in GOODS order. Once work on a unit starts, finish that unit before selecting again, even if a new unloading order arrives. Never discard or transfer partial effort. An active loading unit retains the slot admitted under the previous order.
- Apply 400 × elapsed hours to work. A package crosses only when its full mass of work completes; physical mass never moves fractionally. Loading: manifest +1, quay −1, incoming −1. Unloading: manifest −1, quay +1, outgoing −1. Delete zero map entries. Quay can contain both incoming purchases and landed sales.
- Physical aboard is `manifest`. Committed aboard is `manifest + incoming − outgoing`. Capacity acceptance uses committed aboard; sellability is `max(0, manifest − outgoing)`, so an incoming purchase cannot be resold before it physically arrives. Both separate obligations must complete before cast-off.
- Remaining work is sum of all incoming/outgoing quantities × good mass minus active.workKg. ETA divides by 400. Preserve effort across added orders, ticks, and saves. Completion offset is the exact elapsed work/rate, not the enclosing tick endpoint.
- Preserve the existing one-hour cart delay after final crossing and one additional hour of open hatches. Persist `job.cartAt` and `voyage.hatchUntil?: number | null` as absolute times. Cast-off clears them. Adding work clears cartAt. A legacy empty job gets cartAt = restore hour + 1.
- Export from `job.ts`: `CARGO_WORK_KG_PER_HOUR = 400`, `newJob`, `addOrder`, `pendingUnits`, `stepJob` (existing result fields), `jobSummary(job)` returning `{ phase: 'load' | 'unload' | null, units: number, remainingKg: number, hours: number }`, and `restoreJob(raw: unknown, now: number): CargoJob`. Retire LOAD_RATE and update its consumers/tests.
- `TradeSession.aboard` retains committed semantics for capacity callers. Add `physicalHoldUse()` alongside existing committed `holdUse()`. `pendingUnits` counts both directions. Retain current session events and downstream game/physics integration.

## Saves

Keep the v1 save envelope/key. `parseSave` migrates/validates cargo jobs through `restoreJob`; the session constructor also normalizes jobs for direct restored state. New v2 counts must be finite nonnegative safe integers for known goods; work must be finite and in [0, package mass), refer to a corresponding pending unit, and timers must be null or finite. Reject malformed jobs with the existing ignored-save warning behavior. Validate incoming <= quay and outgoing <= physical manifest when restoring a voyage. Optional hatchUntil must be null or finite.

Astra's design review confirmed the active-slot invariant for valid runtime orders. On session restore, also reject an active load if physical hold volume plus that unit exceeds capacity (1e-9 tolerance); outgoing reservations cannot justify a fabricated active slot. Reject unknown job versions and inconsistent v2 cart timers (pending work with a timer, or no work without a timer).

Legacy signed `pending`: positive becomes incoming, negative becomes outgoing; keep quay. Convert carry (fraction in [0,1)) into work on the next legacy-priority unit using that package's mass. Missing/zero carry means no started effort. Do not infer erased historical movements from quay contents; their ownership cannot be recovered. Reject malformed fields rather than fabricating cargo. No background changes to user saves; normal next authorized in-game save writes upgraded data.

## Existing ledger

- Aboard rows and the main Hold footer show physical cargo. Add optional `LedgerRow.committed` and optional `LedgerSource.committedHold` with the existing hold shape. Adapter supplies them from session. Hold mode includes physically aboard or committed goods so an incoming purchase is visible with zero aboard.
- When a row's committed count differs, add a small muted second line `20 after handling` under its physical Aboard figure; retain the existing columns.
- When committed totals differ, show a restrained second figure `After handling … t · … of … m³`. With unconfirmed orders, show `After orders …` including existing commitments and proposed rows. Capacity refusal pulses this forecast figure when visible. Physical footer never pretends an order has already moved cargo.
- `jobLine` uses real active/next phase and total remaining work: e.g. `Unloading · 20 left · 0.8 t to handle · 2 h 6 min`. Duration rounds remaining time upward to whole game minutes (minimum 1 while work remains). Show this in the existing trade/Hold job area, preserving notebook and Esc behavior.
- Final precision refinement: show work below 1000 kg as whole kg, rounded upward, so a final 25 kg jar never reads `0.0 t to handle`; use one decimal tonnes at 1000 kg and above.
- Add optional `LedgerQuote.handlingHours` and show `Handling …` with each proposed order's absolute mass/400. This is proposed work only. Do not add a separate screen. Existing fake sources may omit the new optional fields.
- Preserve current fonts, panel, keyboard commands, and sentence-case house text. No general visual redesign.

## Acceptance

1. Sell10/buy10 wine before movement: 20 crossings, 840 kg, 2.1 game hours, 20 porter fees, unchanged final manifest, cast-off blocked until completion; no negative manifest/quay.
2. Buy then attempt to sell unlanded goods is refused; repeat sells cannot reserve the same physical packages. Mixed loads stay within capacity at every physical transfer, including an active load followed by a new unloading order.
3. Wheat/wine/honey timing matches 400 kg/h. Mixed goods preserve effort and unloading priority; active incoming unit finishes before newly requested unloading. Count and mass conservation hold over repeated opposite orders.
4. One long step vs irregular small steps vs save/restore mid-unit produce equal integer states/purse and near-equal work/timers within 1e-8. Completion, cart, hatch boundaries have explicit tests; no duplicate completion/porterage on zero-time ticks.
5. Legacy migration preserves pending signs/quay and fractional effort; malformed v2/legacy jobs are rejected. Mid-work and cart-delay save restores preserve remaining duration and release times.
6. Adapter/UI show physical vs committed cargo, correct full-job ETA and proposed handling time. Trade limits and notebook remain functional. Existing voyage/ledger tests updated only where timing/physical display semantics intentionally changed.
7. Typecheck/build; voyage, ledger, new cargo-handling, market, hold, cargo physics and UI text suites. Browser: actual merchant Hold book opens/closes; focused review uses real Economy/TradeSession/Ledger/Hold to exercise opposing orders, advance, restore and cast-off via ordinary controls. Inspect console and panel fit at 1280×800 and a narrow viewport. This test fixture never writes localStorage.

## Execution ownership

- Core Luna: `src/trade/{voyage,job,session,save}.ts`, `scripts/test-voyage.mjs`, `scripts/test-cargo-handling.mjs`.
- UI Luna: `src/ui/ledger{,Source}.ts`, `src/ui/ledger.css`, `scripts/test-ledger-source.mjs`.
- Review fixture Luna: new `cargo-review.html`, `src/cargoReview.ts`; use frozen public APIs, no production entrypoint changes, no fake simulation.
- Lead: design, dispatch, integration review, acceptance, README/spec and package command wiring via directed execution. Preserve all pre-existing dirty files and harbor assets. No commits, dependencies, or decisions delegated to execution workers.
