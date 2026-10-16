# Three experiential refinement passes

2026-10-15. User requests three implemented passes, each reviewed afterward by Astra. Astra remains GPT-6 Astra low; execution workers remain GPT-6 Luna high and implement lead decisions. Preserve prior changes and avoid additional simulation subsystems.

## Pass 1: understand the work and wait for it

Problem: closing the ledger removes all handling information; the book freezes the existing time keys. A player cannot tell what is moving or when departure becomes possible without trying R.

Decisions:

- One compact cargo status in the existing HUD, shown only while docked with pending handling or its completed quay/hatch aftermath, hidden while the ledger is open and with the HUD off. It names the active/next good and phase, total remaining packages/time, current time speed, and existing I/[ ] keys. Completion clearly says ready to cast off even while the cart delay remains.
- Shared pure formatting in `src/trade/handlingStatus.ts`: game durations, current good/phase, ready/idle state. Extend `jobSummary` with `good` to expose the scheduler's active/next good rather than reimplement priority in UI. Preserve all existing simulation rules.
- The book forwards only [ and ] through the same `Game.changeTimeSpeed(factor)` gate/clamp used by normal play. It shows the actual multiplier and existing key hints. T stays outside the book. No new wait command and no automatic change to user-selected speed in this pass.
- Ledger job line names current cargo; physical/committed semantics remain. Cast-off refusal includes useful remaining duration. Avoid duplicate HUD/book status.
- A dev-only integrated review scene uses the real Game/TradeLayer, actual berth, clock and cargo. It provides ordinary buttons for ordering, stepping the clock, views, book, and cast-off; it suppresses voyage storage just like other review scenes. This makes later visual acceptance reproducible in the actual harbor rather than only a table fixture.

Acceptance: normal and book time keys use one gate and show the correct speed; status names the actual active item despite a later priority change; ready-to-depart differs from cart clearance; no status on the trireme or after cast-off; headless checks plus actual-game browser inspection. Astra reviews implementation and evidence after the pass.

## Pass 2: see work in the scene

Source measurement: physical wine counts 1/2/10 produce 5/8/16 visible amphorae; physical honey 1/4 produces 4/12 jars. The current column-sampling renderer multiplies packages. Quay collision centers also subtract the plank offset twice. Astra confirms these are the right experiential corrections before animation.

Frozen decisions:

- Replace fractional-column visual synthesis with deterministic whole-package placement from the actual manifest. Add `src/cargo/cargoPacking.ts`, exporting `packVisibleCargo(manifest, design)` and placements with stable `good:ordinal` IDs, actual model AABBs and local pose. Use real mesh bounding boxes, never LOOK_LAYER height approximations. No shrinking or overlapping jars.
- Visible packages occupy a supported single layer within the two actual hatch projections, inset 0.075 m from the opening. This is an explicitly bounded visible subset; other cargo remains under the deck. Count per good never exceeds inventory. No artificial upper layer balanced on amphora necks. Require actual hull/mast/ceiling clearance and no intersection with prior package AABBs (0.015 m separation). Full inventories can omit units when the visible opening is full.
- Process goods in the same density-descending order as Hold.stow, breaking ties by GOODS order. A new denser good may re-stow this visual subset, as the current underlying pure stowage does; do not claim independently persistent package positions. Same-good additions/removals preserve the existing prefix. IDs and positions are deterministic for a manifest. No active overlay, floating cargo or animation queue.
- Geometry correction from the first fit check: use actual transformed mesh vertices for hull clearance, since an amphora's wide AABB corners at its narrow foot are not real material. Keep AABBs for opening clearance and package separation. Use aligned yaw=0 for hold models, avoiding arbitrary rotations and per-package geometry caches.
- The first floor-only plan was **rejected**, despite green tests: it drew only two wine jars and six honey jars at large counts. The original floor is a very narrow strip at the bilge, and greedy centre-first placement wasted even-row capacity. Astra advised fixed supported dunnage and centered footprint-spaced rows. Implement low wooden platforms beneath each hatch, sharing one geometry-derived support profile between packer and visible planks/cross-bearers. Their top is the lowest height that permits the opening's footprint inside the curved hull; full amphora height must still clear the deck. They remain visible when empty, never rise with inventory, and do not alter physics/capacity/CG rules. Use centered nx×nz rows from actual model footprint plus separation, with near-first selection only after defining that full layout. No supporting surfaces inferred from fractional volume cells.
- CargoVisual keeps its instancing/materials, but consumes the package plan and colors each actual good once. `update(stowed, manifest?)` retains old call compatibility by globally summing each good's volume/stow when manifest is absent; production passes actual manifest. Export read-only per-good counts/placement readback for tests and review.
- QuayStack uses actual mesh height for stacked layers and actual minima for base placement, with 0.015 m between layers. Fix the double-subtracted along-plank collision offset. Rendered piles and blocking solids must agree for nonzero plank offsets and rotated berths.
- The actual-game review's hold camera becomes near overhead (local x=0.15, y=deck+3.2, z=hatch midpoint+0.5, target deck−0.5) so the openings can be judged. Add per-good visible inventory/placements and quay counts/solids to dev DOM telemetry through a read-only TradeLayer visualState accessor. Add exact one-unit order and manual time-step controls to inspect individual crossings. No normal-player controls added.

Acceptance: one physical wine/honey produces exactly one visible model where there is room; 1–10 packages visibly accumulate without duplication; mixed-good counts never exceed inventory, no model overlap/deck/hull/mast clipping or unsupported placement; deterministic same-good prefix; rotated/nonzero-offset quay collision coverage; real harbor screenshots before/after crossings and actual ship-mass increase. No simulation force/rate changes. Astra reviews this pass afterward.

## Pass 3: refine the complete departure experience

Frozen with Astra's design advice: make the complete loop trustworthy, without adding forces, workers or a new waiting system.

- Work crosses only while docked at the job's exact port and berth. A paused session still advances economy, wages and its last tick; no handling credit accumulates away. Preserve active partial work and quay inventory. Orders at another berth are rejected before mutation. Completed cart/hatch timers may expire normally.
- Share a paused status between book and HUD: `Handling paused`, return to the named port berth, packages left. Keep that guidance visible away from the dock; hide the duplicate while the book is open. Hatches close when disconnected. The quay remains at the job berth, using a cloned original shore anchor while the job exists; restore without an anchor falls back to the berth's face origin. It never follows a departing ship.
- An open trade book becomes read-only when the exact berth is lost. Confirm rechecks connection before mutation. A pending job elsewhere does not prevent leaving a different berth, and leaving must preserve that job.
- Keep a rejected order draft intact. Catch expected RangeError failures, show a concise inline review message, and require another explicit confirmation after editing. Invalid quotes show unknown amounts rather than fabricated zero prices. Unexpected errors stay observable. Rename proposed duration `Added handling`; show completed handling/readiness in the book as well as outside it.
- Dev-only controls exercise forced disconnection/reconnection, one day of real economy time, and a 100-sack wheat load; expose actual keel depth for inspection. Runtime acceptance checks partial work pause/resume, quay persistence, stale draft recovery, completion and immediate departure, plus physical load/waterline response. No voyage storage writes in review mode.

## Review records

Each pass needs a dated implementation/evidence record and Astra's afterward verdict. Completion requires all three, plus a final actual-scene inspection with visible cargo consequences.

### Pass 1 implementation and review

Implemented named cargo/ETA HUD, book time keys through the shared gate, multiplier display, departure readiness, and an actual-game dev review. Tests: status 4, ledger 10, voyage 20 and handling 12 pass, plus typecheck/lint. Browser evidence is in `cargo-handling-review/three-passes/pass1-*`.

Astra's afterward review accepted the core behavior and required a more readable HUD hint plus a context-correct cast-off action. Both corrections are implemented: 13px high-contrast hint and `R Cast off` only in commanding views, otherwise return-to-helm guidance. The revised pending/ready/on-foot screenshots were inspected afterward. Astra's final verdict: **Pass 1 accepted**, no remaining blocker.

### Pass 2 implementation and review

Implemented actual-manifest whole-package placement, fixed wooden dunnage and geometry-derived row spacing, and aligned quay collision. The first floor-only result was rejected and replaced before acceptance. Tests: 126 visual checks plus handling, hold, typecheck and build pass. Actual-game evidence records an empty hold, one honey jar (25 kg entering the rigid body), ten wine amphorae across both hatches, and mixed cargo with four honey aboard/six waiting. A fresh final document has no warning/error console messages; an intermediate hot-reload MARGIN error is retained as invalidated development evidence.

Astra inspected the source and before/after artifacts afterward: **Pass 2 accepted**, meaningful visible improvement. Accepted boundary: the hatches show a supported single layer, with remaining cargo below deck; mixed goods can rearrange that subset. Astra also approved the frozen Pass 3 scope above.

### Pass 3 implementation and review

Implemented berth-bound work, persistent anchored quay cargo, shared paused guidance, dynamic read-only trading, retained stale drafts, unknown invalid quotes, and completion readiness in the book. Browser inspection found that read-only mode hid the paused line while the outside HUD was hidden; the stylesheet was corrected and the actual wrong-berth book rechecked.

Actual-game evidence (`cargo-handling-review/three-passes/pass3-evidence.json` and `pass3-*.jpg`):

- Honey's active 6.6667 kg of work and the quay geometry remained unchanged through a day disconnected; purse fell 84720 to 83520 centidrachmas from wages. Handling resumed after returning. The ordinary game resets accelerated/frozen review time to ×1 when disconnected, so resumed snapshots include actual elapsed running time; exact no-catch-up and save/restore equivalence are checked headlessly.
- A different berth's book became read-only and displayed where to return. Leaving that berth retained the original job.
- A +10 wheat draft stayed intact after 25 days of wages exhausted the purse. Enter displayed the inline review error without confirming cargo; reducing the draft cleared it. The market-stock-invalid quote branch was inspected in source, not separately forced in the browser.
- One completed honey jar showed ready-to-cast-off inside the book; immediate departure cleared the job despite its remaining cart delay.
- Buying and handling 100 wheat sacks increased live ship mass by 4000 kg. With the same fixed camera and the same clock hour next day, raw draft rose from 1.21499 to 1.32543 m (about 11 cm). Waves kept running: these are runtime snapshots, not calm-water calibration. Existing independent cargo physics checks gave 115.5 mm for a 4 t load and slower rowing speeds as load increased.

Final checks: cargo handling 14, ledger adapter 12, handling status 5, voyage 20, market 24, visual geometry 126, hold and cargo-physics checks pass; typecheck, UI text lint, whitespace and production build pass. Final browser document console had no warnings/errors. Pre-existing unrelated diffs match the saved pre-pass baseline. No dependencies or commits added.

Astra's afterward verdict: **Pass 3 accepted**, no blocking corrections; **all three passes accepted** within the stated scope. The supervision skill was updated and validated with the observed whole-package, visible-support and visual-acceptance lessons.
