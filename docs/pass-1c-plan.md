# Pass 1c plan: agreements and consequences

The lead's plan, written October 16, 2026, for [expectations-mvp-spec.md](expectations-mvp-spec.md) §3.2–3.4,
§3.6 and §7 Pass 1c. Agents' briefs are cut from this file. Nothing here sets a price, and nothing
here touches the model, the UI or the opening scene. Those are Passes 2 and 3.

## What 1c delivers

These are headless commands, which the Pass 2 tools will call:
- propose, revise and decline;
- accept;
- load the consignment;
- sell to a named buyer;
- sell consigned jars on the market;
- return unsold jars;
- show the account;
- settle.

Alongside them, 1c adds:
- records, plus warmth, the trust limit and overdue stages worked out from them;
- Philon's thanks reaching Damaris by ship.

By the end of the pass, a headless scenario plays the whole opening round trip through these commands.

## Team (composed for this pass)

| Piece | Who | Why this shape |
|---|---|---|
| Interface stubs (types, signatures) | Lead | Fixes the shared shapes so the lanes and the test author work in parallel. |
| A. Books: cargo across owners, wallets, tick order | Haiku, own worktree | Exact rules below. The trade golden proves A changes nothing for today's play. |
| B. Records and derived values | Haiku, own worktree, alongside A | Pure folds over records, in a new file. |
| C1. Dealings (the commands and settlement) | Haiku, after A merges | Calls A's functions, so it needs them for real. |
| C2. World actors, save, wiring | Haiku, after A merges, alongside C1 | Separate files from C1. |
| Gate tests | Opus, capped, alongside A and B | The gate list is long and the expected values need working out independently from the spec. It writes against the stubs and runs after the merge. |
| Round-trip scenario | Lead, after merge | Rewrite budget-opening to use the real commands. |
| Review | Opus, once | Conservation where cargo crosses between voyage and world, time order, idempotency, settlement maths, save restore. |
| Checkpoint | User | Round-trip numbers against 1b's, and the decisions below. |

Not used:
- **No baseline recorder.** The 1a trade golden already pins today's behaviour, and lane A must keep it identical (===).
- **No separate test file per lane** beyond B's short one.

## Shared model (lead's stubs)

**Two collections, one boundary.**
- `voyage.lots` holds every unit aboard or on the job's quay, whoever owns it.
- `world.lots` holds every unit in a store.
- Cargo crossing the boundary goes through one books.ts function that edits both collections. The moved
  units get a new id on the receiving side, with `origin` set to the old lot id.
- books.ts stays the only writer of lots, receipts and wallets.

**CargoLot** gains three optional fields:
- `agreement?: string` (`'A3'`): consigned units keep it through every move, including after they're sold.
- `moving?: 'load' | 'unload'`: units committed to the job.
- `due?: number`: the absolute hour by which a named buyer's units must land.

Old lots loaded from 1a/1b saves are normalised when parsed: market lots aboard get `'unload'`, player
lots on the quay get `'load'`.

**Receipt** (the player's) gains:
- `agreement?: string`;
- `party?: OwnerId`, the counterparty;
- a new kind, `'remit'` (a payment to the owner).

**WorldState → version 2.**
- **Characters** gain:
  - `reserved` (centidrachmas, held for committed handling);
  - `trustBase` (centidrachmas);
  - `warmth0` (integer −2..2; Damaris +1, the others 0).
- **New collections:**
  - `receipts: WorldReceipt[]`, one per wallet movement:
    `{ id: 'X{n}', T, who: CharacterId, kind: 'opening' | 'porterage' | 'purchase' | 'sale' | 'remit', amount, agreement?, port?, qty? }`.
    Invariant: wallet == the sum of that character's receipts. freshWorld writes the opening receipts.
  - `proposals`, `agreements`, `records`, `mail`;
  - `results: Record<string, unknown>` (command results by request id).
- **Id counter:** one counter, `world.nextId`, issues W, X, P, A and M ids.
- **Version 1 worlds** (from 1b saves) get empty collections and one opening receipt per wallet.

**Books invariants** (checkBooks, per good):
- the units of quay lots marked `'load'` == `job.incoming`;
- the units of quay lots with no `moving` == `job.quay − job.incoming` (market units waiting for the cart);
- the units of lots aboard marked `'unload'` == `job.outgoing`.

`checkWorld(world, voyage)` checks:
- wallets equal their receipt sums;
- `0 ≤ reserved ≤ wallet`;
- lot ids are unique across both collections;
- for each agreement: jars still in her store, plus jars aboard or on the quay, plus jars sold, plus jars
  returned, equals `terms.qty`.

## A. Books (Haiku)

Files: src/trade/books.ts, job.ts, session.ts. Nothing else.

1. **Owners and custody.** `isOwner` accepts `char:{damaris|philon|myrto}`. `isCustody` accepts `store`.
   The receipt checks accept the new kind and fields.
2. **Wallet moves.** `walletMove(world, who, amount, kind, T, extra)` writes a WorldReceipt and moves the
   wallet. It throws if `wallet − reserved` would go below 0, unless the payment comes out of the
   reservation: `fromReserved: true` lowers `reserved` by the same amount.
3. **Store to quay.** `loadFromStore(v, world, job, agreementId, T)` moves every store jar allocated to the
   agreement into one quay lot, owner unchanged, marked `'load'`. It adds them to `job.incoming` and
   `job.quay`.
4. **Stowing and landing, any owner.**
   - `stowUnit` takes the oldest quay lot marked `'load'`.
   - `landUnit` takes the oldest lot aboard marked `'unload'`, choosing lots with `due` first, earliest
     due first. It returns `{ lot, toQuay }`:
     - **market owner:** the unit goes to that market's quay lot (today's behaviour), and `toQuay` is true;
     - **character owner:** the unit goes straight into that character's store lot at the port (merged
       with an existing store lot that has the same owner, agreement and origin), and `toQuay` is false.
       The buyer carries it away, so `stepJob` doesn't add it to `job.quay`.
5. **Unloading order.** `nextUnit(job, voyage)` picks an unload of the good whose `due` lot is earliest
   while any due lot is marked `'unload'`. Otherwise the order is unchanged.
   `dueLandingT(voyage, T)` returns the hour the last due unit lands with uninterrupted handling:
   T + (the active unit's remaining kg if it isn't due + the mass of all due units − the active
   unit's work if it is due) / 400. With no due units it returns T.
6. **Who pays porterage.** Per lot moved:
   - a lot with an agreement, at the agreement's `homePort`: paid from the owner's wallet with
     `fromReserved: true` (a world receipt);
   - any other lot with an agreement: paid from the purse, with the agreement set on the receipt;
   - a lot without an agreement: paid from the purse, as today.
7. **New records.** Each of these takes the units from the right lots, writes the receipts and adds to
   the job:
   - `recordNamedSale(v, world, { buyer, port, berth, good, qty, total, duty, due, from: 'player' | agreementId, T })`.
     The units become the buyer's, marked `'unload'` with `due` set. Receipts: a sale (+total, party =
     buyer) and a duty (−duty). The buyer's wallet moves by −total.
   - `recordConsignedMarketSale(...)`: the same as recordSale, but takes the agreement's lots and tags the
     receipts.
   - `recordReturn(v, world, job, agreementId, qty)`: the jars stay hers and are marked `'unload'`.
   - `recordRemit(v, world, agreementId, amount, T)`: a purse receipt of −amount (kind `'remit'`), and +amount
     to the owner's wallet.
8. **Session.**
   - `TradeSession` takes an optional `world`.
   - `sellable(good)` counts only the player's lots aboard that aren't moving, so the ledger can never
     sell her jars.
   - **The tick runs everything in time order.** Inside the existing sub-step loop, each step `[t, next)`
     runs the cargo work first, then `economy.advanceTo(next)`, then drains that step's events and
     applies the wages at `next`. A midnight therefore always sees exactly the cargo landed before it.
     This is the fix for time jumps across the cutoff.
   - `releaseLanded` still clears market quay lots only.
9. **Checks:**
   - `npm run typecheck`;
   - `npm run test:trade`, with the golden unchanged. The economy is the same however it's stepped, and
     the golden doesn't compare receipt order. If the golden moves, stop and report.
   - No new test file.

## B. Records and derived values (Haiku)

Files: src/social/records.ts (new), scripts/test-records.mjs (new, at most 120 lines), and a
`test:records` entry in package.json.

**The record shape:** `SocialRecord { id, holder: CharacterId, T, source: 'witnessed' | 'shown' | 'news', kind, facts }`.
`addRecord(world, r)` does nothing if the id already exists. Ids are built from the facts, for example
`damaris:settled:A3:R57`, so retellings and reloads never write a record twice.

| Kind | Facts |
|---|---|
| `settled` | agreement, value (v·n), amount, full, onTime |
| `returned` | agreement, qty |
| `sold-below` | agreement, receipt, unit, heardBid |
| `heard-sale` | qty, unit, consignedQty, agreement? |
| `letter-shown` | (written by Pass 2) |
| `undelivered` | qty, `T` = the cutoff |

**Derived values.** These are pure functions of the records with `T ≤` the given time, computed on
demand and never stored.

- **`warmth(world, who, T)`:** start at `warmth0`, then apply one step for each of these, clamping to
  −2..2:
  - +1: `letter-shown` with source `news`;
  - +1: the first full settlement in person for each agreement;
  - −1: each let-down belief that was firm.
- **`trustLimit(world, who, T)`:** start at `trustBase`, then go through the records in time order:
  - a full, on-time settlement sets L = max(L, 2 × the largest value settled on time);
  - a full, late settlement sets L = max(L, value);
  - `sold-below` sets L = floor(L / 2).

  The limit is 0 while any agreement of theirs is overdue.
- **`stage(agreement, world, T)`:**
  - settled in full: `'none'`;
  - otherwise, with w = warmth at T, `overdueT = expectedT + 24·w` and `longT = overdueT + 24·(14 + 3·w)`.
    The stage is `'none'`, `'overdue'` or `'long-overdue'` depending on where T falls.
- **`Belief { holder, agreement, expectT, firmness: 'firm' | 'tentative' | 'conditional', source: 'terms' | 'said' | 'assumed' }`:**
  - It's let down at T if `T > expectT` and the holder has no `witnessed` record for the agreement at or
    before `expectT`.
  - The step it costs: firm −1, tentative 0, conditional 0.
  - 1c creates only the `'assumed'` return belief. Pass 2 adds `'said'`.

**Test:** one small fixture per rule above. Include an idempotent write, and a time jump that gives the
same stage as checking hour by hour.

## C1. Dealings (Haiku, after A)

Files: src/trade/consignment.ts (new). Nothing else.

**Shape.** `class Dealings { constructor({ world, session, heardBid(listener, about, T): number | null }) }`.
- Every command takes `req` (a request id) first.
- It returns `{ ok: true, ... } | { ok: false, reason, quote? }`.
- Its result is stored in `world.results[req]`, and replaying the same `req` returns the stored result
  without doing anything.
- A refusal changes nothing else.
- The reasons are: `unknown`, `stale`, `trust`, `stock`, `wallet`, `purse`, `berth`, `port`, `deadline`,
  `hold`, `closed`, `open` and `state`.

**Commands:**

- **`propose(req, owner, terms)` and `revise(req, proposalId, terms)`:**
  - Terms are `{ good, qty, perJar, share: 20, alternateSale, buyer, opportunityT, homePort }`.
  - `perJar` comes from `homeValue(economy, port, qty) = floor(quoteSell(qty).total / qty)`.
  - Revising raises the revision number and marks the old one superseded.
  - Refused (`trust`) if `perJar·qty > trustLimit`, or if any of the owner's agreements is long overdue.
  - Refused (`stock`) if the owner's unallocated store jars are fewer than qty.
- **`decline(req, proposalId, revision)`.**
- **`accept(req, proposalId, revision)`:**
  - Refused (`stale`) unless the revision is the current open one.
  - Rechecks trust and stock.
  - Splits the owner's store lot: an allocated store lot carrying the agreement id.
  - Creates the Agreement: `{ id, proposal, revision, owner, terms, acceptedT, expectedT, loaded: 0, sold: 0, returned: 0, closedT: null, settledT: null }`,
    with `expectedT = opportunityT + routeHours(buyerPort, homePort) + 72`.
- **`startLoading(req, agreementId, port, berth)`:**
  - Only at `homePort`, and only at the job's berth if there is a job.
  - The hold must fit the jars.
  - The owner's free wallet must cover `2 · qty · porterFeePerUnit(wine)`. That amount is reserved, and
    `loadFromStore` runs.
- **`buyerQuote(buyer, port, qty)`:** the buyer's real alternative. The sum of `ask(S − i − 0.5)` for
  i < qty, times (1 + DUTY), rounded up like `quoteBuy`, so it equals `quoteBuy` whenever qty ≤ maxBuy. It
  is then capped by the buyer's wallet. Philon's demand is `max(0, min(earmark, requirement − owned))`
  until the cutoff.
- **`sellToBuyer(req, { buyer, port, berth, from, qty, quoted })`.** Checks, in this order:
  1. port is the buyer's;
  2. berth;
  3. qty ≤ demand;
  4. the jars are aboard and free: the player's own, or the agreement's if `alternateSale` or the
     agreement's buyer is this buyer;
  5. `quoted` equals the current quote (else `stale` with the new quote);
  6. `dueLandingT` with these units added is at or before the cutoff (else `deadline`).

  Then `recordNamedSale`, with duty = total − floor(total × (1 − DUTY)). After that, mail
  `M{n}` from the buyer to the agreement's owner (or to Damaris if there's no agreement), with facts
  `{ qty, unit, consignedQty, agreement? }` and `writtenT = T`.
- **`sellToMarket(req, { agreement, port, berth, qty, quoted })`:** needs `alternateSale`, and quoted must
  equal `quoteSell(qty).total`.
- **`returnGoods(req, { agreement, port, berth, qty })`:** only at `homePort`; qty is at most her jars aboard
  that aren't moving.
- **`account(agreementId)`.** Every figure comes from receipts tagged with the agreement:
  - **G** is the gross sales.
  - **C** is the duty, the porterage on purse receipts, and her porterage world receipts.
  - **s** is the units sold and **r** the units returned once landed.
  - The venture is **closed** when s + r == qty.
  - N = G − C.
  - profit = max(0, N − v·s).
  - share = closed ? floor(profit·20/100) : 0.
  - **payable** = the sum of the player's receipts tagged with the agreement (remits included) − share.
  - **available** = min(payable, max(0, purse)).

  The account returns all of these. The test checks both worked examples in spec §3.4 to the cent.
- **`settle(req, { agreement, port, amount })`:**
  - Refused (`open`) until the venture is closed, and refused (`port`) away from `homePort`.
  - `amount` must equal the current `available` (else `stale`).
  - Effects:
    1. `recordRemit`.
    2. Record: `settled` (witnessed), with full = (payable after == 0) and onTime = T < overdueT.
    3. Record: `sold-below` for each sale receipt whose unit gross is below 90% of `heardBid(homePort, port, T)`.
    4. Record: `returned`, once per agreement, when r > 0.
    5. On closure, the unused reservation is released.
  - When full, `settledT` is set.

**No test file.** The gate author covers C1.

## C2. World actors, save, wiring (Haiku, after A, alongside C1)

Files: src/trade/world.ts, src/trade/save.ts, src/tradeLayer.ts.

1. **Version 2 world.** freshWorld builds it with opening wallet receipts and `warmth0`.
   `upgradeWorld(v1)` adds empty collections. `CelebrationActor` moves wallets only through `walletMove`.
2. **Philon's owned count.** It includes his lots in the voyage: the constructor takes `voyageLots: () => CargoLot[]`.
   At the cutoff:
   - he consumes from his store only;
   - if he still owns jars in the voyage, he writes an `undelivered` record (witnessed) for that
     quantity.
3. **`MailActor`** (an EconActor). At each midnight T:
   - Each piece of mail with no `deliverT` takes the earliest in-flight shipment from its port to the
     recipient's port whose `arriveT − routeHours(from, to) ≥ writtenT`, and sets `deliverT` to that
     shipment's `arriveT`.
   - Each piece of mail with `deliverT ≤ T` and not yet delivered writes a `heard-sale` record (news) for
     the recipient at `deliverT` and is marked delivered.

   News therefore moves only by NPC ship.
4. **Save.** `worldOk` accepts versions 1 and 2. Version 2 checks:
   - the new arrays and their ids;
   - wallets against their receipt sums;
   - agreements referencing proposals that exist.

   Lot normalisation (`moving`) happens on parse, and `checkWorld` runs on restore.
5. **tradeLayer:**
   - It passes `world` to TradeSession.
   - It builds `Dealings`, with `heardBid` taken from `this.news`.
   - It adds `MailActor` beside `CelebrationActor`. Philon's actor reads `session.voyage.lots`.
   - It sets Damaris's `trustBase` to `homeValue(economy, 0, 40) × 40` on a fresh voyage.
   - There's no UI. The game still starts with today's 70 jars until Pass 3.
6. **Checks:** typecheck, `test:trade`, `test:world`, `test:calendar` and `lint:ui-text`.

## Gate tests (Opus, capped)

File: scripts/test-consignment.mjs. At most 450 lines and one case per gate item. Black-box, through
`Dealings`, a `TradeSession` and a synthetic two-port economy (`noShocks`), written against the stubs.
Cases, from spec §7 gate 1c:
- conservation of jars and money (`checkBooks` and `checkWorld` after every step);
- fragmented ticks against one jump, and a save and reload mid-unload: identical state;
- the player's wine and her wine aboard together, where the ledger can only sell the player's;
- partial loading, across a save and reload mid-job;
- partial sales: some to Philon and some on the market;
- wrong berth;
- a double confirm or double settle with the same `req`;
- stale revision, and stale quote;
- landing exactly at the cutoff is allowed and one hour past is refused, with a jump across the cutoff
  consuming only landed jars;
- insufficient funds:
  - the owner's wallet short of the handling reservation;
  - Philon's wallet cap on the price;
  - a partial settlement with the purse spent, leaving a balance;
- unsold jars returned;
- closure only when every jar is sold or returned;
- money owed kept separate from jars in custody;
- an honest loss: no commission and no `sold-below`;
- no commission before closure, and no expense counted twice;
- a record written once across a repeated settle and a reload;
- the trust limit refusing a proposal;
- overdue and long overdue at exact hours under a jump;
- the `heard-sale` record arriving only after a shipment from Philon's port lands.

It checks spec §3.4's two worked examples through `account`.

## After merge

**Lead:**
- Merge A, then C1 and C2, then B. Run:
  - typecheck;
  - `test:trade` (golden unchanged), `test:world`, `test:calendar`, `test:records` and
    `test:consignment`;
  - the build.
- Rewrite `scripts/budget-opening.mjs` to go through `Dealings`: propose, accept, load, sell to Philon,
  settle. Report its numbers against 1b's: player 635.79 dr, Damaris 366.92 dr. They should match to
  within the handling-order differences.

**Opus review** of `git diff <base>..HEAD`:
- jars and money crossing the voyage/world boundary;
- the time order in `tick`;
- idempotency and refusals leaving no trace;
- the account and settlement against §3.4;
- save restore of 1b saves.

**Checkpoint** with you.

## Decisions taken in this plan (yours to overrule)

1. **Ship and quay versus stores.**
   - Cargo aboard or on the quay lives in the voyage's books; cargo in a store lives in the world's.
   - Moving between them gives the jars a new id that points back to the old one.
2. **The tick advances the economy hour by hour alongside the cargo work.** Today it jumps the economy
   first, so a big time skip could reach the cutoff before Philon's jars land. The golden proves nothing
   else changes.
3. **Named buyers and owners carry their jars away as each one lands.** They go straight into their store
   with no cart pile, matching the spec's "custody transfers as each jar is unloaded".
4. **Philon's jars unload before all other work.** That makes it impossible for a later order to push
   them past the cutoff. The confirm check is exact arithmetic over the queue.
5. **Philon's price and quantity:**
   - For more jars than the market could sell him, his alternative price keeps following the market's
     price curve past the stock floor. It is still capped by his wallet.
   - He'll take at most `min(earmark, requirement − owned)`.
6. **Settlement only once the venture is closed** (every jar sold or returned). Before that, what you owe
   is visible but not paid. This stops commission ever flowing back from Damaris.
7. **"Sold well below known prices"** means a unit price under 90% of the bid she had heard for that
   port.
8. **Return and grace:**
   - Expected return = the festival cutoff + the sail home + 3 days.
   - "On time" means settled in full before overdue starts.
   - Each warmth step shifts overdue by one day and long overdue by three days.
9. **Promise steps:** a firm promise let down costs 1 warmth; tentative and conditional promises cost 0.
   Settling in person gives +1 once per agreement.
10. **Damaris's reservation.** When loading starts, she reserves handling for loading plus returning
    every jar (2 × 40 × 0.11 = 8.80 dr). The unused part is released at closure.
11. **Philon's thanks.** Written when you confirm the sale, carried by the first NPC ship to leave his
    port for hers, and learned when it arrives. It says how many jars, the price, and how many were hers.
12. **Trust starts** at the value of Damaris's 40 jars at her home sale price on the fresh start.
13. **Command results are saved by request id,** so a repeated tool call after a reload does nothing new.

## Refinements made while writing the stubs (October 17, 2026)

The stubs (src/trade/books.ts, job.ts, session.ts, world.ts, consignment.ts, src/social/records.ts) are the
interface. Where they differ from the text above, they win:
1. **Returned jars land untagged.** A returned jar landing in the owner's store joins her ordinary stock (no
   `agreement`), so it can be consigned again and isn't counted twice. Agreement conservation is then:
   her store lots tagged + her voyage lots tagged and not marked `'unload'` + `sold` + `returned` == `qty`.
2. **Agreement counters.** books.ts maintains `loaded`, `sold`, `returned` and `reserved` on the agreement.
   `checkWorld` adds: each character's `reserved` == the sum of their agreements' `reserved`.
3. **Porterage payer by owner, not port.** Units owned by the agreement's owner are paid from her wallet
   (`fromReserved`); any other tagged units from the purse, tagged. An alternate market sale at home is
   therefore paid from the sale money.
4. **Closure** also needs no tagged voyage lot still `moving`, so expenses are final before any commission.
5. **"Sold below"** uses the bid she had heard for that port at the sale's time (spec: "that port and time").
6. **The assumed return belief is tentative**, so in 1c warmth only rises. Beliefs are derived, not stored.
7. **Trust limit:** a full on-time settlement sets L = max(L, 2 × that value), so a halving sticks until a
   bigger venture.
8. **Settling zero** is allowed when payable is 0 (an honest loss closed in person). With payable > 0 and an
   empty purse it's refused (`purse`). Every settlement writes a remit receipt, even of 0.
9. **The account** is a pure `ventureAccount`, so §3.4's examples are checked to the cent with plain receipts.
10. **Wages** are one receipt per midnight step, aggregated into one wages event per tick.
11. **Mail** departure test uses a 1e-6 tolerance (arriveT − routeHours isn't exact in floats).
12. **Results** are stored for refusals too: a request id is single-use.
13. **Opening trust (review fix).** A character who knows the player locally (warmth0 ≥ 1) and has no trust base
    yet entrusts the first venture whatever its value; accepting it sets `trustBase` to that value. This replaces
    setting the base from the price on the day the voyage started, which drifted, and lets 1b saves open too.

## Result (October 17, 2026)

All gates pass: typecheck, test:trade (golden unchanged), test:world, test:calendar, test:records (6),
test:consignment (22), lint:ui-text, build. The budget plays the round trip through Dealings: Philon pays 421.88 for
the 40 (10.55 a jar against a market bid of 10.16), commission 36.84, Damaris nets 367.80 (1b: 366.92). The player
ends at 745.29 dr against 1b's 635.79: the sale money is in the purse now, so the return cargo is larger (the spec's
"keep the player's purse spendable"). Philon's thanks reach Damaris by ship at T123.9.
