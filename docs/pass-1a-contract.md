# Pass 1a contract — lots, receipts, save v2

Fixed by the lead on October 16, 2026 for [expectations-mvp-spec.md](expectations-mvp-spec.md) §7 Pass 1a.
The implementer builds to this; the gate-test author tests against it without reading the
implementation; the auditor checks the result against it. A change to anything here goes through the
lead.

The only intended behaviour change in 1a is save safety. Every number the game produces today
(purse, manifest, job, market stocks, timing) stays identical; `npm run test:trade-golden` proves it
with ===.

## 1. Data (src/trade/books.ts)

```ts
export type OwnerId = 'player' | `market:${number}`;
export type Custody = { at: 'aboard' } | { at: 'quay'; port: number; berth: number };

export interface CargoLot {
  id: string;        // 'L1', 'L2', … from voyage.nextId; never reused
  good: GoodId;
  qty: number;       // safe integer > 0; a lot that reaches 0 is removed
  owner: OwnerId;
  custody: Custody;
  origin: string;    // 'opening', 'migrated', or the id of the receipt that created it
}

export type ReceiptKind = 'opening' | 'sale' | 'purchase' | 'duty' | 'porterage' | 'wages';

export interface Receipt {
  id: string;        // 'R1', 'R2', … from voyage.nextId (one counter for lots and receipts)
  T: number;         // absolute game hour
  kind: ReceiptKind;
  amount: number;    // signed integer centidrachmas, + into the purse
  port?: number;
  good?: GoodId;
  qty?: number;
  lot?: string;
}
```

`VoyageState` gains `lots: CargoLot[]`, `receipts: Receipt[]` and `nextId: number`. It keeps
`purse` and `manifest`, but they are maintained views, written only by src/trade/books.ts:

- `purse === sum of receipts[].amount` (the opening receipt is the carried-over balance).
- `manifest` = per good, the sum of `qty` over lots with custody aboard, any owner. Keys with 0 are
  absent, as today. Readers of `voyage.manifest` and `voyage.purse` keep working unchanged.

No code outside books.ts assigns `voyage.purse`, `voyage.manifest`, `lots` or `receipts`.

## 2. What each money and cargo movement does

| Event | Receipts | Lots |
|---|---|---|
| New voyage | `opening` +30000 at T | player, aboard, wine 70, origin `opening` |
| Confirm, sell n of g | `sale` +(q.total + q.duty), `duty` −q.duty | n units move from player aboard lots (lowest id first) to a lot owned `market:{port}`, aboard, origin = the sale receipt id |
| Confirm, buy n of g | `purchase` −(q.total − q.duty), `duty` −q.duty | new player lot, custody quay {port, berth}, origin = the purchase receipt id |
| One unit lands | `porterage` −fee (may be summed per lot per tick sub-step) | −1 from the oldest `market:*` aboard lot of g; +1 to a `market:{port}` lot with custody quay {port, berth} and the same origin |
| The job ends (the cart clears, or cast-off with nothing pending) | — | `market:*` quay lots are removed: the buyer has taken them |
| One unit stowed | `porterage` −fee (same) | −1 from the oldest player quay lot of g; +1 to the player aboard lot with the same origin (created if absent) |
| Wages at midnight | `wages` −amount, one per tick that pays | — |

Receipt T: confirm uses `economy.now`; porterage uses the sub-step start time in `tick`; wages use
the tick's T. Purse arithmetic stays integer and identical to today: the receipts for one confirm
sum to exactly today's purse change.

The handling job keeps its v2 count fields and per-unit timing exactly. It may also carry lot ids;
`job.incoming/outgoing/quay` must always agree with the lots.

## 3. Functions (all exported from src/trade/books.ts)

- `checkBooks(v: VoyageState): void` — throws `RangeError` naming the first broken invariant:
  purse equals the receipt sum; manifest equals aboard lots; per good, player quay lots equal
  `job.incoming`, `market:*` quay lots equal `job.quay − job.incoming` (landed units waiting for the
  cart), and `market:*` aboard lots equal `job.outgoing` (all 0 with no job); every qty a
  positive safe integer; ids unique; `nextId` greater than every numeric id suffix.
- `resetBooks(v: VoyageState, o: { purse: number; cargo: Units; T?: number }): void` — clears lots,
  receipts and the job; one `opening` receipt for `purse`; one player aboard lot per good in `cargo`,
  origin `opening`. Used by test setup and the dev review modes in place of assigning
  `voyage.purse` / `voyage.manifest`.
- `rebuildBooks(v: VoyageState, T = 0): void` — replaces lots, receipts and `nextId` from the
  legacy fields as they stand (`purse`, `manifest`, `job`), using the v1 mapping in §4 with origin
  `migrated`. Never throws and never validates: player aboard per good = max(0, manifest − outgoing),
  `market:{job.port}` aboard = min(outgoing, manifest), player quay = min(job.incoming, job.quay),
  `market:{job.port}` quay = job.quay − that. `migrateV1` uses it.
  Existing tests that build `manifest`, `purse` or a job by hand call it once after doing so. That
  is the only change allowed to existing tests.
- `newVoyage()` (voyage.ts) returns books equal to `resetBooks(…, { purse: 30000, cargo: { wine: 70 }, T: 0 })`.
- The `TradeSession` constructor keeps today's checks first, in today's order, with today's messages
  (restoreJob, active-load hold check, hatchUntil), and only then runs `checkBooks`.

## 4. Save v2 (src/trade/save.ts)

- `SAVE_VERSION = 2`. `saveKey(seed, size)` → `trieres.voyage.v2.{seed}.{size}`.
  `legacySaveKey(seed, size)` → `trieres.voyage.v1.{seed}.{size}`.
  `rejectedSaveKey(seed, size, stamp)` → `trieres.voyage.rejected.{seed}.{size}.{stamp}`, stamp =
  the save's numeric `savedAt` when readable, else `Date.now()`.
- `buildSave(…)` keeps its signature and writes v2 (voyage includes lots, receipts, nextId).
  Talk notes are saved keyed by character id `trader:{port}`; the trade layer maps to and from its
  port-keyed map.
- `parseSave(json, seed, size): SaveData | null` keeps its signature; v2 only; runs `checkBooks`
  on the parsed voyage and rejects on failure.
- `migrateV1(d: unknown): SaveData` — throws on a malformed v1. Mapping (spec §7):
  player aboard lot per good = manifest − job.outgoing; `market:{job.port}` aboard lot = job.outgoing;
  player quay lot = job.incoming (bought units waiting) and `market:{job.port}` quay lot =
  job.quay − job.incoming (landed units waiting for the cart), both at the job's port and berth; one `opening` receipt = purse at
  `economy.T`; origin `migrated`; notebook, economy, news kept; notes re-keyed to `trader:{port}`.
  The opening (Damaris, consignment) is never injected.
- `parseAnySave(json, seed, size): SaveData | null` — v2 via parseSave, else v1 via migrateV1.
- `loadSave(seed, size): { status: 'none' } | { status: 'ok'; data: SaveData; from: 'v2' | 'v1' } | { status: 'rejected'; key: string }`
  — reads v2, else v1. A present but unreadable save (either key) is copied to its rejected key and
  removed from its original key; nothing else is deleted. Never throws.
- `readSave(seed, size)` stays read-only (no quarantine); `hasSave` uses it.
- `writeSave(seed, size, data): boolean` writes v2, reads it back, parses it, and only then removes
  the v1 key. If the read-back fails it leaves v1 in place and returns false.
- `deleteSave(seed, size)` removes the v2 and v1 keys (explicit New voyage only). Rejected keys
  are never deleted by code.

## 5. Trade layer and title screen

- `TradeLayer.init()` returns `'continue' | 'new' | 'rejected'` and uses `loadSave`. On
  `'rejected'` it starts a fresh voyage without calling `deleteSave`.
- The title screen, on `'rejected'`, shows one plain line above the buttons:
  "Your saved voyage could not be read. It has been kept aside." (see the plain UI text rule).
- `newVoyage()` from the title screen's New voyage button still deletes the v2 and v1 saves.

## 6. File ownership

- Implementer: src/trade/books.ts (new), voyage.ts, job.ts, session.ts, save.ts, src/tradeLayer.ts,
  src/main.ts (rejected line only), src/cargoReview.ts, src/cargoGameReview.ts (use `resetBooks`).
- Gate-test author: scripts/test-books.mjs and scripts/test-save-v2.mjs (new).
- Gate runner: the `rebuildBooks` insertions in existing scripts/test-*.mjs, and the `test:trade`
  script in package.json.
- Recorder (done first): scripts/test-trade-golden.mjs, scripts/golden/trade*.

## 7. Out of scope for 1a

Characters, wallets, consignments, agreements, the calendar, land use. No owner other than
`player` and `market:{port}`. No new UI beyond the rejected-save line.
