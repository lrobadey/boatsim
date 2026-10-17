# Pass 1b plan — world simulation and calendar

Lead's plan, October 16, 2026, for [expectations-mvp-spec.md](expectations-mvp-spec.md) §3.5, §6 and
§7 Pass 1b. The agents' briefs are cut from this file. Nothing here sets a price.

## Team (composed for this pass)

| Piece | Who | Why this shape |
|---|---|---|
| Interface stubs (calendar signatures, clock fields) | Lead | ~20 lines. Lets lanes A and B run in parallel without sharing files. |
| A. Calendar and closed-form moon | Haiku, own worktree | Fully specified pure algorithm. The check is one short test plus the existing sky tests. |
| B. Land use, characters, celebration, Philon, save | Haiku, own worktree | Designed below step by step. One agent, because the steps share economy.ts and save.ts. |
| Wiring and merge | Lead | A few lines in tradeLayer once both lanes are in. |
| Review | Opus, once | Philon's rule, time ordering and save restore are where a quiet bug would cost the most. |
| Budget scenario and §3.5 re-measure | Sonnet, after merge | Needs judgment: a real crossing time, a plain strategy, an honest report. |
| Checkpoint | User | The budget result is economics. You decide before anything is tuned. |

Not used: no baseline recorder (behaviour changes on purpose here, and the trade golden uses synthetic
ports that 1b doesn't touch, so it must stay green unchanged). No separate test author (each lane writes
one short test file).

## A. Calendar and closed-form moon

Files: src/world/calendar.ts (fill in the stub), src/world/astro.ts, scripts/test-calendar.mjs (new),
plus a `test:calendar` script in package.json.

- Epoch `{ moonPhase0: number; doy0: number; version: 1 }`. The default is `{ 0.43, 172, 1 }`, today's
  start values. Lunation `L = 29.53`, solstice day of year `172`.
- `moonPhaseOn(epoch, d)` = frac(moonPhase0 + d / L) for whole day d (dayCount).
- Day d is a new-moon day when floor(moonPhase0 + d/L) > floor(moonPhase0 + (d−1)/L).
- The solstice days are `172 − doy0 + 365k`. Year k starts on the first new-moon day on or after
  solstice k.
- A day belongs to the latest year start at or before it. Year numbers count so that the year holding
  day 0 is Year 1.
- The months are the runs between consecutive new-moon days inside a year, giving 29 or 30 days. A
  13-month year inserts "Poseideon II" after Poseideon. The names are those in spec §6, starting with
  Hekatombaion.
- `dateOn(epoch, d)` returns `{ year, month, monthName, day, monthLength, intercalary }`.
  `formatDate` returns `"13 Skirophorion · Year 1"`. `nextNewYearDay(epoch, d)` returns the first year
  start strictly after d.
- **AstroClock:** `moonPhase` is no longer accumulated. After every midnight in `update` and
  `advanceHours`, and in `compute`, it is set to `moonPhaseOn(epoch, dayCount)`. `clock.epoch` holds the
  epoch. `resetToStart()` sets dayCount 0, hours 7.4, dayOfYear 172 and the default epoch. Review tools
  that set `moonPhase` directly still change the sky until the next midnight, and never move dates.
- **Test (short):**
  - Day 0 is 13 Skirophorion · Year 1, Skirophorion has 29 days, and day 17 is 1 Hekatombaion · Year 2.
  - The new moons fall on the spec's list (−12, 17, 47, …, 372).
  - At least one 13-month year appears within 20 years, with Poseideon II.
  - Every day d has `dateOn(d+1)` one day later, or a rollover.
  - The calendar's new-moon days are exactly the days `moonPhaseOn` wraps.
- **Checks:** typecheck, `npm run test:skylight`, `npm run test:lighting`. A float-level change in the
  moon phase may move a sky golden. If one fails, stop and report; don't re-record.

## B. World lane (in order, one agent)

Files: src/trade/economy.ts, src/trade/landUse.ts (new), src/world/ormosLayout.ts (one field),
src/trade/world.ts (new: characters, world lots, celebration), src/trade/save.ts, src/tradeLayer.ts,
src/trade/trader.ts (persona lookup by id), scripts/test-world.mjs (new, short).

1. **Zero production.** In `referenceFlows`, a port whose share for a good is exactly 0 gets
   `P_ref = 0`. Otherwise the formula is unchanged. No existing port has a zero share, so the trade
   golden must stay green.
2. **Land use.**
   - `HarborPlan` gains `landUse?: Partial<Record<GoodId, number>>`, with scale factors per good.
     `KORMAKOS_PLAN.landUse = { wine: 0 }`.
   - `landUseProfile(site)` returns the site's profile with features scaled by `planOf(site)?.landUse`.
     The plan only applies on its own world (seed 1729, size 2048, authored harbours), as the quay does.
   - `TradeLayer.buildEconomy` uses it for every port. The worldgen worker and its cache are untouched.
3. **Characters and world lots** (src/trade/world.ts).
   - `WorldState { version: 1; characters: Character[]; lots: CargoLot[]; nextId: number; celebration: Celebration | null }`.
     `Character { id: 'damaris' | 'philon' | 'myrto'; port: number; wallet: number }`, with the wallet
     in centidrachmas.
   - Lots owned `char:{id}` with custody `{ at: 'store', port }` and ids `W1, W2, …`. `OwnerId` and
     `Custody` in books.ts widen to allow these. Voyage `checkBooks` is unchanged.
   - **Cast:** Damaris at port 0, Philon at the celebration port, Myrto at the remaining ports.
     `personaFor` looks characters up by id through the cast, so port slot is not identity. On the
     default world this matches today exactly (Philon is at harbour 1).
   - **Fresh voyage:** Damaris holds 40 wine (origin `opening`) and a wallet of 150 dr. Philon's wallet
     comes from the celebration (step 4).
4. **Celebration and Philon.**
   - The celebration port is the non-home port with the lowest wine `P_ref / D_ref`, lowest id on a tie.
     That is Kormakos on the default world. It is never chosen by name.
   - The celebration day is `nextNewYearDay(epoch, startDay)`, which is day 17 on a fresh game.
     `cutoffT = day × 24` and `fallbackT = cutoffT − 72`.
   - **Philon's numbers:**
     - requirement = round(14 × D_ref) (about 202);
     - rulerPrice = 1.5 × wine pRef (12 dr);
     - limit = floor(0.85 × rulerPrice) (10.20 dr);
     - wallet = requirement × limit;
     - earmark = 40.
   - **Economy hook:** `EconomyOptions.actors?: EconActor[]`, where `EconActor` has
     `onMidnight(T, economy)`. It's called at every midnight after NPC shipments, during the pre-run too,
     so Philon's buying from day −20 is simulated. Actors are attached at construction.
   - **Philon at each midnight T, until the celebration is done.** "Owned" means his wine lots wherever
     they are. In 1c that will include his lots in custody aboard the player's ship.
     - **Before `fallbackT`:** local need = requirement − earmark − owned. If it's positive, buy the
       largest n where n ≤ need, n ≤ `maxBuy()`, `quoteBuy(n).total ≤ n × limit` and
       `quoteBuy(n).total ≤ wallet`. Find n by binary search, since the average price rises with n. The
       market `buy(n)` moves the stock, the wallet pays the total, and a store lot is added.
     - **At the first midnight at or after `fallbackT`, once:** need = requirement − owned. Buy the
       largest n where the total fits the wallet, with no price limit.
     - **At the first midnight at or after `cutoffT`:** consume min(store wine, requirement) and remove
       those lots. Record `consumed` and `shortfall` on the celebration. It's done.
   - Because all of this happens inside the economy's hour loop, a big time jump processes buying,
     fallback and consumption in time order, exactly as small ticks would.
   - The earmark stays private: nothing about it reaches the market until his fallback buy.
5. **Save.**
   - v2 gains `world: WorldState` and `clock.epoch`. Philon's actor state is in `world.celebration`,
     and the economy snapshot is unchanged.
   - **Old saves** (v1 migrated, or a v2 with no `world`) restore with `world = { characters: cast with
     wallets 0, lots: [], celebration: null }`, so the opening is never injected. Their epoch is derived
     once as `moonPhase0 = frac(moonPhase − dayCount / L)`, with `doy0 = dayOfYear − dayCount` mod 365.
   - The trade golden's v1 replays must still match.
6. **New voyage** calls `clock.resetToStart()` before building the economy, so every new voyage opens on
   13 Skirophorion with the celebration 17 days out.
7. **Test (short, scripts/test-world.mjs):**
   - Synthetic ports where one has zero wine share: P_ref is 0 there and unchanged elsewhere.
   - Philon over a fresh 20-day run: his wallet never goes negative, owned never exceeds the
     requirement, there's no buying above the limit before the fallback, the fallback runs once, and
     consumption runs once.
   - One big tick and many small ticks give identical world state and market stocks.
   - Save and restore mid-window continues identically.
   - An old save gets no celebration.

**Checks (lane B):** typecheck, `npm run test:trade` (golden unchanged), `node scripts/test-world.mjs`,
`npm run lint:ui-text`.

## After merge

- **Lead:** wire the pieces together, then run typecheck, `test:trade`, `test:calendar`, `test:world`,
  the sky tests and the build.
- **Opus review:** steps B3–B5 and the clock change. The risk areas are time ordering under jumps, wallet
  and stock conservation, save restore and old saves, and the earmark leaking into the market.
- **Sonnet budget run** (spec §7 gate 1b):
  - Use the default world, generated headless with authored harbours, and a fresh game: 300 dr, the 40
    consigned jars, and the celebration.
  - Measure the crossing time with real ship physics, not estimates.
  - Play the plain strategy in the spec. The Philon sale uses the spec's price rule (Kormakos buy quote
    for the quantity, capped by his wallet) as a scripted transfer until 1c builds it.
  - Report every receipt, the wages, the commission, timing against the cutoff and the final purse.
  - Re-measure the §3.5 numbers.
  - Then stop for you.

## Decisions taken in this plan (yours to overrule)

1. **Damaris starts with 40 jars and a 150 dr wallet.** The spec doesn't set these. 150 dr covers her
   home handling both ways (about 9 dr) with room left over.
2. **New voyage resets the clock to the fresh-game start.** Today it keeps the old voyage's clock, which
   would put the celebration at an arbitrary distance.
3. **"Fallback day 13" means exactly 72 hours before the cutoff,** which is the midnight ending day 13.
4. **Characters are cast by role (home, celebration port, other), not by harbour slot.** That matches
   today on the default world.
5. **Kormakos's land use is authored on its harbour plan,** gated to its world like its quay, and
   applied when the economy is built rather than inside the worldgen worker. This leaves the worldgen
   cache and golden untouched.
