# Expectations MVP — integration design

Status: design decisions settled with the user on October 16, 2026 (section 8). Pass 1a (lots, receipts,
save v2) implemented and gated on October 16, 2026 (docs/pass-1a-contract.md). Pass 1b (calendar, land
use, characters, celebration) implemented and gated the same day (docs/pass-1b-plan.md). Pass 1c (agreements,
settlement, records, news by ship) implemented and gated on October 17, 2026 (docs/pass-1c-plan.md). Pass 2
(conversation tools, cards, letter, promises) implemented, gated and run live against the model the same day
(docs/pass-2-plan.md). Pass 3 (playable opening, personal menu, pause, calendar HUD) implemented and checked
in the browser the same day (docs/pass-3-plan.md).
Known follow-up: receipts grow by about 110 bytes per handled unit, so saves need compaction or a size
policy before long play reaches the browser storage limit.

This specification records the user's decisions and the implementation contracts that follow from them.
The vision in `docs/vision.md` supplies direction; this document bounds the first integrated slice.
Browser testing requires an explicit user request.

## 1. Experience and approved scope

Begin aboard a small merchant ship moored at home. Damaris is visibly nearby and a conversation
is already open after entering a fresh game. She knows the player locally and knows they have a ship.
She owns wine and has a letter from her friend, an existing destination trader supplying a ruler's
celebration. The friend expressed interest in 40 amphorae before a precise date, roughly two weeks away
(the New Year feast, 17 days out; section 6);
this is neither a purchase order nor a guaranteed price.

The NPC receives these circumstances, personal traits, knowledge and objectives. It decides what
to discuss and when an offer makes sense. Do not implement an instruction to recite an opening quest.
The user can discuss the port, people, ambitions or other topics, decline, or leave immediately.

An interested player can receive a proposal. Explicit confirmation creates an agreement. Entrusted
wine loads physically, adds mass, travels aboard, and can be sold to the friend or elsewhere. Carry
the letter as a personal belonging and show it as an introduction. Return to account for the goods
and proceeds; retain 20% of positive profit after agreed cargo value and direct handling/sale costs.
Damaris bears honest commercial loss; the player bears wages and can spend money owed to her.

The world must make the trip worthwhile through simulation, not authored prices (decided October 16, 2026):
home has a wine surplus; Kormakos grows no wine; the ruler's celebration creates a real need there.
A fresh game starts with 300 dr and an empty hold apart from the consignment. See section 3.5.

Personal belongings and cargo are separate inventories with real identity/ownership/location.
No equipment slots, draggable grids, handheld models or per-amphora manual carrying are required.
Expectations have their own screen, accessible within one personal menu. Avoid new shortcut proliferation.
Conversation and personal menus pause the world. Save only while docked. Distinguish personal warmth
from commercial reliability and actual promises from other people's beliefs about those promises.

## 2. Verified current integration points

| Source | Current behavior | Required integration |
|---|---|---|
| `src/trade/trader.ts` | Three port-slot personas; facts include prices, news, ship presence, one short memory note; replies contain say/told/note; instructions forbid advice | Character IDs, local knowledge/context, objectives, relationship facts and action results; revise restrictive voice/context policy |
| `scripts/talk-proxy.mjs` | Vite development middleware calls Responses with gpt-6-luna, low reasoning, strict JSON text, 30 s timeout, 2,000 output tokens | Medium reasoning, bounded tool exchange, failures/retries, latency/token budget review; retain server-side API key |
| `src/tradeLayer.ts` | Owns session, talk, notes, save, cargo visuals and berth checks | Compose social/inventory/agreement services; avoid putting all new rules in this coordinator |
| `src/trade/voyage.ts` | One purse and product-count manifest; fresh voyage gives 70 wine and 300 dr | Owned cargo lots, personal items, accounts; fresh game: 300 dr, no own cargo (decided) |
| `src/trade/session.ts` | confirm changes money and market stock immediately; tick moves physical cargo later | Attributable sales, ownership-aware reservations, named counterparties, transaction receipts |
| `src/trade/job.ts` | One berth-bound handling job; separate incoming/outgoing/quay counts; mass-based work | Preserve lot identity, reservations and destinations through work and save/restore |
| `src/cargo/hold.ts` | Aggregate goods determine stowage, mass and load | Consume derived physical manifest; retain existing physics/visual interfaces |
| `src/trade/market.ts` | Port stock sets marginal bid/ask; 2% duty; sell adds to public stock | Separate price quoting from named buyer custody; avoid double stock and duty charges |
| `src/trade/economy.ts` | Regional stock flows, abstract NPC shipments, wages; no individual trader wallets; production floor of 0.25× even with no land | Land-use input; zero production at zero land share; celebration event; Philon's wallet, holdings and buying rule (3.5); no autonomous captain rewrite |
| `src/world/worldgen.worker.ts` | Terrain-derived `features` per harbour (overlapping crop suitability) | Land-use record per island; authored override for the default world's Kormakos |
| `src/trade/save.ts` | Version 1 world-keyed docked snapshot; optional talk news/notes | Explicit migration, strict new-record validation and cross-reference checks |
| `src/world/astro.ts` | Absolute hours, 365-day seasons, 29.53-day moon, 60 real seconds/game hour | Calendar conversion and deadline formatting over existing time |
| `src/game.ts` | ledgerOpen suppresses game input, not time; several presentation updates outside paused guard | Central modal/pause ownership and complete simulation freeze audit |
| `src/main.ts` | begin enters helm and pointer lock; title Continue/New; no opening NPC turn | One-time fresh opening, continue behavior, modal-safe focus/pointer handling |
| `src/ship/design.ts` | Unset ship choice defaults to trireme | Default merchant for new onboarding; preserve explicit ship selection |
| `src/trade/stall.ts` | Talk enabled on foot ashore within 3.5 m | Separate initial nearby encounter from ordinary on-foot stall interactions |
| `src/ui/talk.ts`, `src/ui/ledger.ts`, `src/ui/ledgerSource.ts` | E talk, Enter send, Tab ledger/notebook, Esc close, I hold; ledger has time-speed controls | One modal/navigation owner, agreement card, letter access, personal menu, stopped-clock state; ledger stays live |

Current character names: Damaris at home, Philon at port slot 1, Myrto at slot 2. Recommended opening
route: home to port 1 (Kormakos in the default world). Resolve ports through generated layouts,
not name-based IDs. Authored Kormakos scenery is world/quality-specific; do not assume it exists everywhere.

## 3. Authoritative data and commands — contracts

Keep pure state/rules modules testable without DOM, renderer or model calls. Suggested modules are
`src/social/{characters,knowledge,expectations,actions,opening}.ts`, `src/inventory/{items,cargo}.ts`,
`src/trade/{receipts,consignment}.ts`, `src/world/calendar.ts`, and UI adapters. Names may change;
single ownership of state and the contracts below must not.

### 3.1 People, knowledge and documents

- Character: stable ID, persona, port/location reference, wallet, owned inventory, objectives,
  authored local knowledge, relationships and bounded event memories. Port slot is not identity.
- Objective: desired outcome, real referenced resource/need, priority and expiry if applicable.
  This is character context, not a scripted dialogue step.
- Knowledge: fact/event reference, source, learned-at time, and confidence/claim status where needed.
  Do not feed distant present-day demand or player transactions to characters who have no source.
- Letter: stable item ID, sender, recipient, written-at time, immutable body and structured claims.
  Its request describes what was expressed at writing time, not guaranteed current demand.
- Personal item location: player possession or a character/container reference. Showing is not giving;
  showing records who learned what and leaves possession unchanged. No duplicate document creation.
- Relationship: warmth and commercial reliability, both worked out from that person's records (3.6),
  never stored as free-floating scores. Records are written once when knowledge is acquired, not each
  frame or every retelling. No automatic universal lie penalty.

### 3.2 Cargo and physical transfers

Cargo lot: stable ID, GoodId, owner ID, custody location, whole quantity and optional agreement ID.
Transfers reserve exact lot quantities; partial physical work retains lot and transfer identity.
For ordinary market trades, represent ownership transfer at sale confirmation separately from
physical custody until unloaded. Named-buyer sales use the same policy (3.4), with a confirm-time
check that the handover finishes before the buyer's cutoff.
The aggregate manifest is derived from lots physically aboard, never a second independently mutable
inventory. Hold/capacity forecasts also include committed incoming/outgoing quantities as today.

Conservation rules: a unit has one owner and one physical location; reservations cannot overlap;
opposing buy/sell transfers never cancel physical work or handling costs. A consignment entrustment
is not a purchase by the player. Owner stock must come from an explicit initialized holding or a real
market acquisition, never a second view of the same public stock.

### 3.3 Expectations and agreement lifecycle

Separate three dimensions rather than one overloaded status:

1. Objective proposal/agreement: proposed, accepted, declined, superseded or closed.
2. Fulfillment/accounting: entrusted, loading, aboard, partly sold, sale committed, delivered,
   unsettled, partly accounted for or settled. Derive progress from events; not a mandatory linear quest.
3. Individual belief: interested, thinks a promise exists, uncertain, satisfied or disappointed,
   supported by what that person heard/learned. Belief never creates a financial obligation.

An accepted agreement freezes parties, cargo allocation, starting value, direct-cost policy, share,
alternate-sale permission and opportunity deadline. Acceptance references a proposal ID and revision.
Changing terms invalidates the old confirmation. The buyer's deadline is not automatically the
deadline to return and settle. Outstanding money and unsold goods survive the opportunity expiring.

The general expectation envelope supports parties, subject, provenance, terms and evidence references.
Executable evaluators in this MVP are deliberately bounded to consignment/cargo/sale/payment and
document transfer. Unsupported promises can be remembered as conversation; never invent a completion
checker for an arbitrary sentence. Future rock delivery needs an item-transfer capability, not a new quest script.

### 3.4 Money, pricing and settlement

All balances are integer centidrachmas. Every financial mutation records counterparty, lot/transfer,
agreement, timestamp, gross, duty, net and expense category. Receipts are persistent facts.

Venture accounting (whole-venture rule decided October 16, 2026). The agreement fixes an integer
per-jar value v (centidrachmas) for the n allocated jars, so no returned-jar sum needs rounding. At
closure every jar is sold (s) or returned to the owner's custody at home (r), with s + r = n.
G = gross sale receipts. C = every direct venture cost, each recorded once with its actual payer:
loading, sale duty, away unloading and home unloading of returned jars.
Net venture return N = G - C. Returned jars count back at v, not at the home price on return.
profit = max(0, N - v * s); player share = floor(profit * 20 / 100). With r = 0 this is the
fully sold case. Carrying jars that did not sell lowers profit slightly; any commercial loss is the
owner's. A venture closes only when every jar is sold or returned. Jars still aboard keep it open as
goods in the player's custody, not as money owed. This slice has no way to lose cargo: no code path
jettisons, sinks or spoils it. Any future loss mechanic (for example water aboard) must add a recorded
"lost" disposition and a rule for who bears it before it can affect a venture.
Economic owner return = N + v * r - player share, but this is not necessarily the cash currently payable:
cash payable = venture receipts held by player minus expenses paid from those receipts, earned
commission and prior remittances. Owner-paid expenses reduce profit, not this payable a second time.
A cost shortfall does not automatically become a personal debt for lost capital. Record each expense
once with its actual payer; do not charge the same fees in purse and settlement twice.
Proposal UI must disclose the expense policy and the starting valuation, not just '20%'.

Home-port handling is owner-paid in both directions (decided October 16, 2026). Damaris pays
loading and the unloading of returned jars from her own wallet at her quay. This works when nothing
sold or the player has spent the payable, and the player never fronts money for her goods.
Away-port costs (decided October 16, 2026): sale duty and Kormakos unloading of her jars come out of the sale money and
are attributed to the venture, reducing the cash payable. Every sale pays at confirm, before its
unloading starts, and no sale can earn less than its fees: the price floor is 2.40 dr a jar, against
0.11 dr porterage plus 2% duty. So a shortfall cannot occur, and no credit or player advance exists.
Before her loading starts, check that her wallet covers the whole committed home handling, and reserve
that amount so another action cannot spend it. Charge once as work occurs, preserving the current
per-unit fee timing.
Ordinary wages remain player's expense. No negative NPC wallet or money spawned to honor a promise.

Worked example (all dr): cargo benchmark 100, loading paid by owner 5, gross sales 150, sale costs
10. Profit = 35; player commission = 7. Player receives 140 and remits 133. Owner's economic return
is 128 after the loading cost she already paid. Deducting that 5 again from 133 would be incorrect.

Partial-return example (all dr): 40 jars at v = 5.00. Damaris pays 4.40 to load. 25 sell to Philon
for 225.00 gross; duty and unloading there (7.25) come from receipts. 15 come back; Damaris pays 1.65
to unload them at home. N = 225 - 13.30 = 211.70. Profit = 211.70 - 125 = 86.70; commission = 17.34.
Player remits 225 - 7.25 - 17.34 = 200.41. Owner's economic return = 211.70 + 75 - 17.34 = 269.36,
which equals 200.41 cash + 75 of jars back - 6.05 she paid. Under a sold-jars-only rule the
commission would have been 18.00; the whole-venture rule was chosen for simplicity and incentives.

Keep the player's purse spendable. Track owner's allocation as a payable, not an inaccessible reserve.
Settlement transfers actual available funds, with explicit confirmation and an idempotency key.
Insufficient funds leave an unsettled balance; never mint the shortfall or close the agreement.
For the MVP defer commission until all goods are sold or remaining goods returned and expenses final;
partial sales are supported and remain visible. Partial payments reduce liabilities without duplicating rewards.

Named buyer: temporary demand up to 40 wine, actual funds, port, exact expiry and acquired inventory.
Price is the buyer's real alternative (section 3.5): Kormakos's buy quote for the same quantity at the
time of sale, capped by his wallet. Not the market bid, and not `Market.sell()` followed by another
transfer. Public stock is unchanged by direct purchase;
ordinary market sales still increase stock. Purchased celebration wine leaves the buyer's holdings
through an explicit consumption event at the celebration, not another public market injection.

Named-buyer timing (decided October 16, 2026): pay at confirm, the same policy as the public market.
Philon pays his quote and title transfers when the player confirms; custody transfers as each jar is
unloaded. Confirm is allowed only if the actual work queue lands his jars at or before his cutoff.
That is knowable exactly: casting off is refused while units are pending, and handling only runs at
the job's berth. Named-buyer jars unload first, and a later order that would push them past the cutoff
is refused. Revalidate at confirm; show the conditional completion time from the queue and berth.
Rare edge: if the ship leaves the berth mid-unload (lines parted), paid jars stay Philon's aboard and
the player owes delivery. That is an agreement obligation with a reliability record (3.6), not a refund.
Consumption at the celebration applies only to wine physically received. Large ticks process unloading,
fallback buying, cutoff and consumption in time order, so time acceleration cannot manufacture timely
deliveries. This removes the earlier proposed exception: there is one payment policy, not two.

### 3.5 Regional wine supply and the celebration

Decided October 16, 2026. Causes are world facts; prices, stocks, shipments and the buyer's need
come from the simulation. Nothing in this section sets a price.

Measured on the default world (seed 1729, medium heightmap) with the current code. Wine runs the wrong
way for the opening. Home (Serrothos) has 28% vine land and makes 0.90× its own consumption.
Kormakos has 34% and makes 1.21×. At the start, the wine bid/ask is 8.70/9.24 dr at home and
7.29/7.74 dr at Kormakos. Selling 40 jars nets 338 dr at home and 279 dr at Kormakos, so the
unchanged consignment would lose Damaris money.

**Land use.** Islands get a land-use record that the economy reads in place of raw terrain features.
Generated worlds derive it from terrain as `features` does today. The default world authors Kormakos
as a grain-and-fish island with no vineyards, the same way its quay is authored. Vineyards are not
rendered, so nothing visible contradicts this. `referenceFlows` currently gives every port at least
0.25× base production. It must give zero when the island's land share for that good is exactly zero.
No current port has a zero share, so existing worlds are unchanged.

Measured with only that change (scratch run, no prices touched):
- Home goes into surplus: stock about 150% of reference, bid 5.5–6.3 dr.
- Kormakos imports through the existing NPC fleet: 142-jar loads every few days to few weeks, ask 7.5–10.3 dr.
- This holds over 60 days.

**NPC fleet.** Unchanged. It already competes through prices: at each midnight it ships wherever the
margin after duty and freight is over 15%, seeing every port's prices at once. Measured: buying 200 jars
out of Kormakos pushes the ask to 16.8 dr, and ships arrive on days 2.2 and 3.2. Buying 400 jars hits
the 28.8 dr price cap, and Kormakos is back to about 8.5 dr by day 7. A visible shortage lasts only
2–3 days.

**Celebration.** A world event at Kormakos. It has a host (the ruler), an exact date, and a wine
requirement for the whole festival. Philon is the contracted supplier.
He is a character with a real wallet and holdings, and a deterministic buying rule with no model calls:
- His remaining need is the requirement minus all wine he owns, wherever it physically is. Title
  passes at confirm (3.4), so jars still being unloaded count, and he never buys the same shortfall twice.
- That need is private. While an arranged channel (Damaris) is expected, he does not buy from the
  public market, so the market and the fleet see nothing. The letter is genuine private knowledge.
- If the need is still unmet at a fallback time before the cutoff, he buys what his wallet allows on
  the Kormakos market. The resulting shortage and the fleet's reaction are the visible consequences of
  a late or missing delivery.
- At the celebration, the ruler's household consumes the wine Philon holds (the consumption event in 3.4).
- He pays up to his fallback cost (3.4). That gives a premium over the public bid without inventing one.

Philon's numbers (decided October 16, 2026). All are world facts; none is a price:
- Festival requirement: 14 days of Kormakos's normal wine consumption (14 × D_ref), about 202 jars
  on the default world. Derived from population, so it works on any world.
- The ruler pays Philon 1.5 × the wine reference price: 12 dr a jar.
- His local buying limit is 85% of that: 10.20 dr a jar.
- Wallet: requirement × limit, about 2,060 dr (the ruler's advance). It cannot cover a scarcity-price
  fallback in full, so a missed delivery can leave the feast short.
- Announced on day −20, the start of the economy's existing pre-run, so his earlier local buying is
  simulated, not authored stock.
- He earmarks exactly 40 jars for Damaris's channel and writes the letter for them. He buys the rest
  of the requirement locally at or under his limit. The earmark is his choice; the remainder is simulated.
- Fallback 3 days before the cutoff (day 13), so NPC ships have time to refill the market for him.

Measured opening economics (gate 1b, October 16, 2026; `node scripts/budget-opening.mjs`). These
replace the earlier estimates.
- **World at the fresh start:**
  - Home wine bid/ask 5.65/6.00 dr, stock 149% of reference, P/D 1.83.
  - Kormakos wine bid/ask 8.44/8.96 dr, P/D 0.
  - Over 60 days the Kormakos ask ranges 7.8–10.5 dr, and 142-jar NPC loads arrive every 4–17 days.
- **Crossing:** the merchant's physics speed under the default wind and waves is 4.05 m/s out and
  3.51 m/s back. Over the pier distance × 1.25, that's 14 h out and 16 h back.
- **Philon on his own:**
  - 66 jars in the pre-run and 96 on day 1, all at or under 10.20 dr.
  - 421.88 dr is left for the 40 earmarked jars.
  - With no delivery, his fallback buys 40 at 9.31 dr. He consumes 202 with no shortfall.
- **The plain round trip,** about 3.1 days:
  - At home: 42 own jars for 258.48 dr.
  - At Kormakos:
    - Philon pays 421.88 dr for the consignment. That's his market quote capped by his wallet,
      10.55 dr/jar.
    - The own wine sells for 403.42 dr.
    - 86 wheat are bought for 423.13 dr.
  - Back home, the wheat sells for 630.10 dr.
  - Wages are 36 dr. The commission is 37.72 dr on a 188.64 dr venture profit.
  - The player ends at 635.79 dr, up from 300. Damaris nets 366.92 dr, against 220.45 dr for selling
    at home.
- **Reading (accepted by the user on October 16, 2026):** the player's own wine and the return cargo are the main profit, and the commission
  roughly pays the wages, as intended. The cutoff (hour 408) is far off. The opening works without
  tuning.

Default-world authoring must not
assume Kormakos exists in other worlds. The opening chooses its destination from simulated land use,
not by name.

### 3.6 Records, relationships and consequences

Decided October 16, 2026.

**Records, not scores.** Each character keeps records of what they actually witnessed, were shown, or
learned as news by ship. Each record has an ID, a time, a source and the facts it rests on. Warmth,
reliability and belief state are worked out from these records on demand, so they cannot drift from
them, and a save stores records, not derived values. A record is written once (idempotent by ID).
Records replace today's model-written 300-character trader note as the authority. A rolling summary
may still feed the model's tone, but it never decides anything.

**Reliability (business trust): fixed rules over agreement facts the character knows.**
- Records: settled in full, settled late, partly settled, still owing past the expected return, unsold
  goods brought back, and sold well below known prices.
- "Below known prices" compares each receipt with the prices the character had heard for that port and
  time, using the existing news model (prices one voyage old). With no news of that port, there is no
  judgment. An honest loss with fair-looking receipts costs nothing.
- Effect: reliability sets a **trust limit**, the value of goods the character will entrust to the
  player. Trusted code rejects any proposal above it, whatever the model says. Rules (decided October 16, 2026):
  - It opens at the opening venture's value (she knows the player locally).
  - A full, on-time settlement raises it to twice the largest venture value settled on time.
  - A late settlement raises it only to the value settled.
  - Any overdue balance drops it to 0 until settled.
  - A "sold below known prices" record halves it.

**Warmth (personal feeling): fixed rules only.** Conversations do not move it; the model may still
react in tone. Warmth is a hidden integer from −2 to +2; Damaris starts at +1 because she knows the
player locally. Events, each one step (decided October 16, 2026):
- Up: she learns, through Philon's news, that the player showed him the letter; settling in person;
  telling her about a loss yourself before she hears it by ship.
- Down: a firm spoken promise that was let down (see belief below).
- Effect: warmth sets how much benefit of the doubt she gives. Overdue starts at her expected date
  plus one day per warmth step. Long overdue starts 14 days after that, plus three days per step.
  Negative warmth shortens both. Warmth never changes money or the trust limit.

**Belief (what she expects to happen next).** Each belief has a source:
- The agreement's terms (fact).
- Something the player said. In Pass 2 a model tool records it as three separate parts: the claim as
  spoken, with its hedges and conditions ("perhaps five days, if the wind holds"); her interpretation
  (firm, tentative or conditional), which is hers and can be mistaken; and a citation of the actual
  line in the transcript. The citation proves what was said, not that the player committed. The
  model records and classifies; the rules judge.
- Her own assumption. Default expected return: the festival cutoff plus the sail home plus a few days.

When the time passes, the rules mark each belief as met or let down. A let-down firm spoken promise
lowers warmth. A let-down tentative or conditional one costs little or nothing; exact steps are tuned
in 1c. A let-down agreement obligation is a reliability record.

**Never returning.**
1. Overdue (past her expected date, after the warmth grace): she grows uncertain and tells the people
   she talks to that the player has not come back.
2. Long overdue (14 days after overdue, adjusted by warmth as above): she assumes the worst. She
   refuses new dealings until the player settles, and says so to anyone who asks. This does not spread
   to other ports' traders beyond normal news channels.
3. Money owed never expires. "Owed" means the actual cash payable (3.4). Her jars still in the
   player's custody are an obligation to return goods, not drachmas. Her suspicion never turns the
   agreed per-jar value into a personal money debt. Settling later partly repairs reliability: the
   record becomes "settled late", not "never settled".
4. News travels by ship. If the player sold to Philon, his thanks can reach Damaris on the next NPC
   shipment from Kormakos, so she may know the player was paid before they arrive.

**Display.** The Expectations screen shows plain sentences built from the *player's* records, with
no meters, numbers or standing words. It shows only what the player witnessed, said, was told or was
shown; it never reveals another character's private knowledge. For example: "You told Damaris you'd
be back by 3 Hekatombaion." "Philon said he would send word to Damaris." It may say what Damaris
knows only after the player has evidence, such as her saying so. The judgment shows in what people do.

**Expected case: your own wine to Philon.** Nothing stops the player from selling their own wine to
Philon and selling Damaris's jars on the public market, or bringing them back. That is a legitimate
choice, not an exploit to block, and there is no special rule for it. Damaris judges it only from
what reaches her: the receipts she is shown, the prices she had heard (the "below known prices" rule),
and anything Philon writes. If his news by ship says he bought the player's wine, that becomes her
knowledge and her records follow from it.

Pass placement: records, the derived values, the trust limit, expected return and the overdue stages
are Pass 1 (pure, headless-testable). The spoken-promise tool is Pass 2.

## 4. NPC actions and conversational experience

GPT-6 Luna uses medium reasoning. Supply bounded context: identity and tone, local port facts,
known player facts (including whether actually acquainted), current objectives and resources,
relationships, relevant letters, known agreement state, and recent event memories. Port flavor can be
authored; changing economic facts come from simulation and information sources.

Tool purpose: 'Propose an expectation when a meaningful future action matters to you or the other
person and it is useful to make the understanding explicit.' It must not be consignment-specific.
Guidance: discuss relevance to this person, distinguish interest from assent, seek clarification,
avoid logging casual remarks, reuse an existing proposal, and respect declines. Do not force an offer
at a particular conversation turn or repeatedly push after the player changes subject.

Recommended command boundary:

- `propose_expectation`: references supported subject/terms and creates a validated proposal.
- `show_document`: references an actually possessed item and a present viewer.
- `request_transaction`: produces a current buyer/market quote and player confirmation card.
- `request_settlement`: produces a computed account and confirmation card.
- Player confirmation emits authoritative accept/commit commands; NPC cannot manufacture player assent.

Every mutation validates actor authority, ownership, presence, capacity, funds, deadline and proposal
revision. Commands have stable request IDs and replay returns the existing result. Execute one bounded
action exchange at a time; return success/failure to the model before it narrates the outcome.
Closing conversation or starting a new voyage invalidates stale async responses. Do not perform hidden
mutations after a dismissed confirmation. Tool definitions/execution policy belong to trusted code,
not a model-supplied schema or text from a document. Limit action rounds and surface a recoverable error.

Current development proxy is not a packaged production service. MVP runs on the existing local Vite
setup; a hosted or static-build NPC backend is separate work. No live API evaluation during preflight.

The model is the interface (decided October 16, 2026). Proposals, acceptance and settlement happen
only through conversation: the NPC raises them with its tools, and the player confirms on the cards
those tools produce. There is no rules-only menu path that bypasses the character, such as a "Settle"
button in Accounts. Accepted consequence: while the model is unavailable, a venture cannot be started
or settled. The conversation shows the error and a retry; the world and the player's other controls
keep working, and no state changes. Headless fixtures still drive the Pass 1 commands directly for
testing; that is a test harness, not a player path.

The existing one-to-three-sentence instruction, 600-character speech cap, 300-character saved note,
and last-sixteen-message context are not sufficient foundations for the requested substantial NPC
experience. Permit context-appropriate response lengths and a larger bounded input; preserve durable
knowledge/events separately from rolling dialogue. Keep concise replies when natural, without forcing
every explanation into three sentences. Persist a bounded recent transcript plus grounded summary;
neither summary nor transcript overrides structured records. Budget tool results and reasoning separately
from visible speech; review the existing 2,000-token output limit and timeout with measured calls later.

Acceptance conversations include port small talk, asking who the friend is, unrelated interests,
vague willingness, clear assent, changing terms, declining, returning late, explaining an honest loss,
and attempting unsupported actions. Use fixture tests for authority plus a later opt-in model evaluation
for conversational quality; successful schema parsing alone does not establish believable dialogue.

## 5. Presentation, controls and pause ownership

Introduce one modal coordinator: conversation, personal menu, agreement review, document reading,
trade ledger, map and settings declare input/pause ownership. Conversation/personal screens freeze
simulation without opening the settings sheet. Nested screens retain pause until the last owner closes.
Keep existing settings pause separate. Audit world clock, physics, wages, deadlines, cargo, weather,
player movement and time skips; UI rendering and asynchronous conversation may continue. Closing
screens must not catch up elapsed wall time or leave keys stuck.

Personal menu contains Belongings, Ship cargo, Expectations and Accounts; Expectations is its own
view, not a ledger tooltip. Controls (decided October 16, 2026): I keeps opening the live ledger hold
view, as today. The personal menu opens from the Esc pause menu and from a button in the ledger, with
no new key. Do not take J/L/K (sailing) or add new
letter shortcuts. E remains nearby interaction; Enter submits chat; Esc closes the topmost layer;
use semantic Tab focus rather than adding more implicit Tab navigation. Provide visible buttons to
Trade, Show letter and Review agreement. Text entry consumes gameplay shortcuts.

Trade ledger time (decided October 16, 2026): the ledger stays live, exactly as today. Cargo keeps
moving while it is open, and its time-speed keys keep working under the existing docked/anchored gate.
Only conversations (with their agreement cards and document reading) and the personal menu pause.
No 'Return to deck' guidance and no sentences explaining why something is not moving; both would break
the no-hints, no-causes UI rule. While time is stopped, the clock readout by the sky dial visibly stops
(for example, it dims and stops changing). That is a true instrument state, not a hint. Pause/menu
entry must preserve the previous time multiplier.

Journal prose can be generated on meaningful events and cached by state revision. Dates, quantities,
promise/belief distinction and accounts render directly from structured data. Failed generation uses
plain deterministic text; stale prose must never contradict current values. No inference per frame.
Opening model failure leaves normal controls/menu available and a retry; it must not trap the player.

Fresh opening runs once, after leaving title, on merchant onboarding only. Continue does not replay
the offer or duplicate goods/letter. Record opening progress in docked saves. Ensure Damaris's actual
rendered placement is visible from the opening camera and consistent with her interaction position;
reposition her presentation for the encounter if necessary, without a remote invisible conversation.

## 6. Calendar research and convention

The Athenian calendar supplies appropriate inspiration: lunar months of 29/30 days, a midsummer
year boundary and intercalary months. Month names and seasonal order are listed in the
[Bates classics calendar](https://abacus.bates.edu/~hwalker/00-01gk202-302/AthCal.html).
The scholarly edition of an actual inscribed calendar documents dated sacrifices and associated
expenditures: [Gawlinski, Hesperia 76 (2007)](https://www.ascsa.edu.gr/uploads/media/hesperia/25068011.pdf).
These sources inform atmosphere and design; neither prescribes our fictional calendar algorithm.

Recommendation: an explicitly fictional regional Attic-inspired calendar, not an assertion that all
ancient islands shared Athenian dates. Months: Hekatombaion, Metageitnion, Boedromion, Pyanepsion,
Maimakterion, Poseideon, Gamelion, Anthesterion, Elaphebolion, Mounychion, Thargelion, Skirophorion.

Implementation: retain existing 365-day seasonal clock and 29.53-day moon. Generate a
deterministic calendar table from a saved epoch: a year begins with the model new moon after the
summer-solstice anchor; successive model lunations form 29/30 civil-day months. A year requiring
13 months repeats Poseideon. This is a chosen approximation, not a reconstructed ancient civic calendar.
Use whole civil days and midnight boundaries for legibility and compatibility; align initial table
phase to existing moonPhase rather than resetting sky appearance. Save epoch/calendar version so
dates never change on reload or a future algorithm revision. Test month/year/intercalary rollover.

Decided October 16, 2026: keep the first-new-moon-after-solstice rule and make the ruler's celebration
the New Year feast. Measured from the real clock (start day 172, moon 0.43, wrap at each midnight):
- The previous new moon fell on day -12. The next ones are on days 17, 47, 76, 106, 135, 165, 195,
  224, 254, 283, 313, 342 and 372.
- A fresh game opens on 13 Skirophorion · Year 1. Skirophorion has 29 days and ends on day 16.
- 1 Hekatombaion · Year 2 is day 17. The celebration is on that day, and Philon's cutoff is the end of
  29 Skirophorion (day 16). That gives a 17-day window, slightly longer than "roughly two weeks".
- Year 2 runs from day 17 to day 371 with 12 months.

The calendar and the sky's moon phase are both computed in closed form from dayCount plus saved
start values (phase at dayCount 0, solstice anchor, calendar version). They cannot disagree, and
review tools that set the moon phase cannot shift dates. Continued old saves derive the start phase
from their saved dayCount and moonPhase once, at migration.

Display '13 Skirophorion · Year 1' near the existing upper-left sky dial; retain time of day. 'Year 1'
is a fictional local epoch. Show exact deadline plus remaining days in agreement/journal, computed
from absolute hours; never parse a localized month-name string to determine expiry. Pick an exact
numeric cutoff and label it consistently rather than recomputing variable sunset after acceptance.
The month names and the 29/30-day rule above are part of this decision.

## 7. Three implementation passes and gates

### Pass 1 — authoritative loop

Split into three steps (decided October 16, 2026). Each lands and passes its own gate before the next
starts. Freeze public interfaces before implementing UI consumers. A headless scenario must perform
the complete round trip without a model or renderer by the end of 1c.

**1a — Foundation, no behaviour change.**
- Cargo lots with owner and custody; all player-owned in 1a. The manifest is derived from lots aboard.
  The handling job carries lot IDs with identical per-unit timing.
- Receipts for every money movement: sales, purchases, duty, porterage and wages. Invariant: purse
  equals the carried-over balance plus the sum of receipts.
- Save v2 and v1 migration (below).
- The only intended behaviour change is save safety. Today a rejected save is deleted at boot,
  because `init()` falls back to `newVoyage()`, which calls `deleteSave`. In 1a a rejected save moves
  to a quarantine key, `trieres.voyage.rejected.{seed}.{size}.{savedAt or now}`, and the title screen
  says it could not be read. Nothing is deleted unless the player explicitly starts a new voyage.

Gate 1a: before any refactor, record a golden trace from today's code and commit it. It covers buys,
sells and mixed orders; save and restore mid-unload; wages over several days; one large time jump
against many small ticks; and cast-off refused while cargo is pending. It captures purse, manifest,
job and market stocks at every step. The new code must match it with ===, as `test:golden` does for
the trireme. All existing suites keep their expected values; only test setup may change, through a
helper, where tests currently build `voyage.manifest` directly (seven files today). v1 fixture saves,
including one mid-job, migrate and then replay identically to restoring them in today's code.

**1b — World simulation, with intended and measured changes.**
- Island land use, and zero production at zero land share (3.5).
- Character resource layer: wallets, and holdings as lots (Damaris's wine, Philon's stock).
- The celebration event and Philon's buying rule.
- The calendar and closed-form moon phase (section 6). These are independent of the rest of Pass 1
  and may be built in parallel at any point.

Gate 1b: an executable round-trip budget for the opening. A headless scenario drives the real
economy, real handling times and a measured merchant crossing time (no estimates), starting from the
fresh-game state: 300 dr, the 40 consigned jars and the celebration. It plays a plain strategy:
- Buy own wine at home with what is left after reserving wages.
- Sail to Kormakos and sell the consignment to Philon and the own wine on the market.
- Buy a return cargo and sail home.
- Unload, settle with Damaris and sell the return cargo.

It reports every receipt, the wages, the commission, timing against the cutoff and the final purse.
It is the source for the opening economics in 3.5. It checks honestly, not toward a target: report
the result, and tune only through world facts, never by authoring prices. A rough pre-check with
scratch code (an assumed 1.5-day crossing, ignoring incoming NPC wine) gave about 41 own jars for
252 dr, about 134 dr gained outbound and a profitable return leg. That is optimistic and unverified.
Re-run the section 3.5 price measurements on the default world and record them. Any golden
that changes is re-recorded deliberately, with the reason. Philon's private need stays invisible to
the market until his fallback buy. Month, year and intercalary rollover are tested. The calendar
matches the sky's moon phase on every day. Migrated saves restore under the new land use without
shape errors.

**1c — Agreements and consequences.**
- Records, reliability, warmth and trust limit (3.6).
- Proposals with revisions, and acceptance.
- Consignment allocation, the named-buyer sale with its confirm-time cutoff check, whole-venture
  settlement (3.4), and the overdue stages.
- Philon's thanks reaching Damaris by ship.

Gate 1c: conservation of goods and money; same result across fragmented ticks and reload; same
product with multiple owners; partial loading and sales; wrong berth; double confirm or settle; stale
terms and quotes; deadline equality and time jumps; alternate market sale; insufficient funds; unsold
goods returned; closure only when every jar is sold or returned; money owed separate from goods in
custody; honest loss; no early commission or duplicated expenses; records written once across
retellings and reloads; trust limit enforced; overdue stages at exact times under time jumps; news of
a sale reaching the owner only by ship.

**Save migration (decided).**
- Read order: the v2 key if present, otherwise the v1 key, migrated in memory.
- The first docked save writes v2. The build reads v2 back and parses it, and only then deletes the
  v1 key. There is no way back to v1 after that. Rolling back to older code means starting fresh.
- v1 to v2 mapping:
  - Each good aboard becomes a player-owned lot aboard.
  - Units sold but not yet unloaded become lots owned by the buyer with custody aboard (3.2).
  - Bought units on the quay become player-owned lots on the quay.
  - The purse carries over as one opening receipt.
  - Economy snapshot, news and notebook are kept.
  - Trader notes keyed by port index map to that port's trader character ID.
  - The opening is never injected into a continued old voyage.
- Malformed v2 records fail visibly and go to quarantine; they never overwrite or delete anything.

### Pass 2 — social interaction

Deliver generalized proposal tools, trusted execution, Luna medium, richer contextual chat, letter
introduction, grounded memories/knowledge and simple warmth/reliability. Mutations call Pass 1
commands. A subjective belief never authorizes asset transfers. Proposal spam and conversational
coherence are evaluated separately from deterministic financial correctness.

Gate: scripted tool transcripts cover assent ambiguity, repeated offers/retries, invalid actions,
late/stale responses, fabricated ownership, document prompt instructions, buyer identification,
decline/topic changes, information boundaries, and save/restore. Model outage does not corrupt state.
Live conversational quality remains unverified until separately exercised with a configured key.

### Pass 3 — playable opening

Deliver default merchant onboarding, visible Damaris encounter, contextual initial model turn,
personal menu, letter reading/showing, agreement card, expectations screen, accounts, calendar HUD,
modal pause and focus/pointer integration. Replace default 70-wine giveaway with the deliberate
opening holding/consignment setup. Preserve explicit ship choice and development review modes.

Gate: onboarding can be exited; no accidental promises; actual custody/progress visible; all screens
keyboard accessible; no shortcut leakage; no stuck pause; cargo resumes outside menus; saves work
while docked and continue does not replay initial events. Automated/headless checks establish rules;
visual and experiential acceptance must be labeled pending until the user authorizes browser testing.

## 8. Integration decisions (settled)

Approved product decisions are in section 1. All integration decisions below were settled with the
user on October 16, 2026:

- Away-port costs come from the sale money; home handling is owner-paid both ways; partial returns
  use the whole-venture rule (3.4).
- Named-buyer payment: at confirm like the market, with a confirm-time cutoff check (3.4).
- Wine supply, the celebration, Philon's numbers and the 40-jar earmark; the opening valuation is
  Damaris's home sale quote; the player starts with 300 dr and an empty hold (1, 3.5).
- Records, reliability, trust limit, warmth, belief and overdue stages (3.6).
- The model is the only interface for proposals, acceptance and settlement (4).
- Ledger stays live; I keeps the live hold view; the personal menu opens from Esc and the ledger (5).
- Calendar: first new moon after the solstice; the celebration is 1 Hekatombaion, day 17 (6).
- Pass 1 split into 1a/1b/1c with a golden-trace proof for 1a; save migration and quarantine (7).

Measured outcomes still to come are gates, not open decisions: the executable round-trip budget
(1b) and the tuning steps for tentative promises (1c).

Do not change island distance in this slice. Source clock: a normal day is 24 real minutes; fourteen
days is 336 minutes before acceleration. Current abstract shipment travel uses pier distance, a 1.25
route factor, 7.2 km/h and game-time conversion. Measure generated port separation and player-voyage
pacing before changing geometry or time ratio; no browser measurement was authorized for this preflight.

Source-derived opening budget: current wine is 42 kg and 0.075 cubic metres per jar, so 40 units
occupy 3 cubic metres and add 1,680 kg. At 400 kg/game hour, loading takes 4.2 game hours and
unloading another 4.2 (8.4 real minutes combined at normal speed, excluding cart/hatch delays).
Porterage rounds to 11 centidrachmas per unit crossing: 8.8 dr for both operations. Merchant crew
has 8 hands at 1.5 dr/day, so wages are 12 dr/day and 168 dr over fourteen days. Wine reference
value is 8 dr/unit, not a guaranteed acquisition or sale quote. Home pier to Kormakos pier is 2.68 km
straight-line on the default world. Section 3.5 gives the measured prices and the expected motive:
the commission roughly covers wages, and the player's own cargo is the profit. Do not silently
guarantee a profitable outcome or change the agreed share.
The party window is generous arrival time, not a recommendation to wait fourteen days.

Not included: autonomous captains, political simulation, negotiation, equipment/grid inventory,
modeled handheld letters, arbitrary generated executable promises, or saving at sea.

## 9. Preflight evidence

Run on October 16, 2026, before this documentation change:

- `npm run typecheck`: passed.
- `npm run build`: passed, 143 modules.
- `npm run lint:ui-text`: passed, 4 files.
- `npm run test:market`: 24 passed.
- `npm run test:voyage`: 20 passed.
- `npm run test:cargo-handling`: 14 passed.
- `npm run test:ledger`: 12 passed.
- `npm run test:talk`: 14 passed. Initial sandbox attempt failed to bind 127.0.0.1;
  rerun with loopback permission passed. The proxy tests use no live paid model inference.

These are baseline regression results, not evidence that the proposed features exist. No browser
tests or live NPC conversations ran. Existing README modification and untracked AGENTS.md/vision.md
were present before this work and left untouched.

## 10. Systems consultation

Consulted GPT-6 Astra at low reasoning (the available equivalent of the user's requested light
reasoning), read-only. Lead retained design ownership. Source inspection independently confirmed
aggregate cargo attribution, confirmation-before-handling, unsaved transcript/short memory, the
70-wine initial holding, input-only conversation freeze and unguarded asynchronous replies.

Integrated recommendations: distinguish transaction/acceptance facts from knowledge and summaries;
use lot allocations inside handling rather than a side contract alone; separate sale, physical
delivery and accounting; defer commission until consignment closure; proposals do not mutate assets;
validate session/revision and idempotency on tool actions. Keep original three-pass order because
the social command interface must exist before the final playable opening consumes it.

Second exchange challenged expense funding and the celebration cutoff. Adopted as clearly labeled
proposals: owner-funded loading and net sale expenses; distinguish economic return from actual cash
payable; buyer reservations with payment/title transfer per physical handover before expiry. These
resolve double deduction of owner-paid fees and consuming wine still aboard at the party. They remain
review points, not silently substituted approved requirements. On October 16, 2026 the user chose
pay-at-confirm with a confirm-time cutoff check instead of per-handover payment (3.4), because cast-off
is blocked while cargo is pending, so completion time is known at confirm.
