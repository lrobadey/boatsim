# Cargo handling verification

Verified 2026-10-15 against the shared working tree. Design: GPT-6 Astra, low; implementation: directed GPT-6 Luna, high; integration and acceptance: lead.

## Automated

- TypeScript typecheck and production Vite build pass.
- Cargo handling: 12 tests pass, including independent opposite obligations, exact porterage, mixed-good priority, active-unit preservation, physical capacity, fragmented time, mid-unit restore, migration, and cart/hatch boundaries.
- Existing voyage suite: 20 tests pass; timing expectations changed for wine's 42 kg packages. Wheat's previous ten-sack/hour behavior is retained.
- Ledger adapter: 9 tests pass, including physical versus committed quantities, incoming-only rows, proposed duration, and small remaining masses.
- Market: 24 tests pass. Hold and cargo-physics suites pass, including draft, load continuity, and propulsion response to added cargo.
- UI text lint and git diff whitespace checks pass.

## Browser

The real Economy, TradeSession, Ledger, and merchant Hold run in `cargo-review.html` with in-memory controls; this fixture never writes localStorage. Desktop (1280×800) and narrow (390×844) Hold and Trade layouts were inspected. A fixture-only positioning overlap was corrected and rechecked.

- Sell ten wine jars, then rebuy ten: incoming 10, outgoing 10, 840 kg work, 2.1 game hours. Cast-off refuses while work remains. After completion the manifest again holds 70 wine and exactly 220 centidrachmas of porterage have been paid (20 crossings × 11). Cast-off then succeeds.
- At 15 minutes, wine unload work was 16 kg into the active jar. JSON save/restore retained it, the 68 physical/70 committed jars, and 1.85 remaining hours.
- The production ledger's mouse selection and Shift+Right/Enter ordered ten honey jars. Its proposed handling time was 38 minutes; the physical manifest remained unchanged at confirmation.
- Tab toggles Notebook/Hold. After 15 minutes of honey handling, four jars are physically aboard, ten are committed, and 150 kg/23 minutes remain. Restore retains this state.
- The running merchant game loaded at low quality. I opened its actual Hold book and Escape closed it without opening pause. Both final browser consoles had no warnings or errors.

Evidence: `browser-evidence.json`, `game-hold.jpg`, `hold-desktop.jpg`, `hold-narrow.jpg`, and `trade-narrow.jpg`.

## Boundaries

400 kg/game hour is a gameplay parameter, not a historical labor estimate. No full sailing trade route or frame-time benchmark was performed. Existing physical cargo integration is retained and covered by the hold/cargo tests; the live game check covered its Hold UI, while controlled transactions used the shared real modules in the fixture.

Legacy saves retain the signed obligations still recorded and convert fractional progress into mass work. Movements erased by earlier order cancellation cannot be reconstructed from old quay contents. New jobs retain both obligations and absolute clearance timers.

All 13 pre-existing modified file diffs other than package.json were preserved byte-for-byte. Package.json retains the existing harbor commands and adds only the cargo-handling test command. No commits or new dependencies were introduced. The supervision skill received one validated paragraph on physical contents, commitments, transfer work, and restore verification.
