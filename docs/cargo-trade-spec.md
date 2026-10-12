# Cargo and ports: implementation spec (rev. 2)

Status: rev. 2, 2026-10-11. Written with an Opus consultant: research in §16, review round 2 folded in
(26 corrections, verified headless, including a simulated first hour on seed 1729). This is
the first real trade loop of the trade sandbox (see the vision: questless, emergent, slow and planned).
Build order and agent contracts are in §14. This file is the source of truth; when code and spec
disagree, raise it, don't guess.

## 0. How it plays

A new merchant voyage starts **docked at the main harbour** (Serrothos on seed 1729). The purse holds
300.0 dr. Seventy jars of common wine lie in the hold under the deck gratings: the 3 t of amphorae
she has always carried, now owned cargo.

The player crosses the plank and walks along the mole to a **trader's stall** (a figure under an
awning with a few jars). `E Trade` opens the **ledger**. It lists this port's goods with stock, the
price you'd pay and the price you'd get, what you have aboard, and an order column. The player sells
the 70 jars of wine (wine is cheap here, so maybe not all of it), then presses Enter. The money moves at
once. The cargo moves over game time. The hatch gratings come off, the stack on the quay at the plank
grows as jars are landed, and she rises a little as each one leaves. Casting off is refused while cargo
is still moving.

The player casts off, rows out, and sails about 3 km on a reach to Kormakos, a smaller island with a
smaller market. Out of sight, the world kept going: each port's stocks drift toward its own
production and consumption, harvests and shortages come and go, and other merchants' ships move goods
between ports. Kormakos grows grain, so wheat is cheap there, unless a shortage or a grain ship's
departure has moved it. The player buys about 90 sacks (the price rises with every sack; the ledger shows
the total as the amount grows), watches the stack shrink and the hold fill, sails home, and sells into the
dearer home market, part now and part later if the price sags. Every arrival at a berth saves the voyage. Wages, 1.5 dr per hand per day, come out of the purse at each midnight,
so waiting in port for a better price is allowed but not free.

What's new to feel: a loaded ship sits deep, accelerates slowly under oars, heels less under sail but
rolls slower and heavier. A light ship is lively. (The hold's centroid sits above her CG, so cargo lowers
GM; her much larger displacement still gives more righting moment. Measured: GM 1.53 m standard, 1.17 m
with 13 t in the hold.)

## 1. User decisions (2026-10-11)

1. **Hold:** flush deck with two hatches by the mast; the hold lies below. The open hold of the merchant
   plan (§7 there) is dropped for now: it collides with the aft rowers and the relief spots.
2. **Labour:** no porter figures in v1. The quay stack and the hold fill and empty over game time.
3. **Running cost:** wages of 1.5 dr per hand per game day. No food yet.
4. **Money** reads as decimal drachmas: `7.5 dr`.

5a. **Default start (user, 2026-10-11):** every ship spawns docked at the main harbour. The merchant's new
   voyage does this itself; the trireme is placed docked at berth 0 by `Game.startInHarbour()`. `?start=sea`
   keeps the old start outside the harbour mouth.

Defaults taken (announced to the user, no objection):

5. The merchant's physics trace stays bit-identical: `ShipPhysics` changes only when `setStaticLoad`
   is called (§5).
6. Three harbours: the main one plus the two largest other islands (§3).
7. Information: the ledger shows the current port only, plus the player's notebook of prices seen
   elsewhere with their age. No route hints, no "best" anything.
8. Clock stays at 60 real s per game hour. Time-skip (`[`, `]`, `T`) only while docked or anchored
   (plan §11.6, never enforced until now).
9. A world is (seed, heightmap size). Low quality is a different world with its own save.
10. Overloading is allowed up to the hold's volume. No water-in-the-hold model yet.
11. Trading is in person at a stall on the quay. Trade is merchant-only; the trireme sees the same
    ports and can dock but has no stall prompt, no purse and no wages.

## 2. Scope

In: three harbours with villages, per-port markets on game time with NPC shipments, eight goods, a
purse, wages, a hold with stowage and physical cargo mass, hatches with gratings, cargo visible below,
a quay stack, a timed loading job, the ledger and notebook, time-skip gating, a voyage save on docking,
"Continue voyage" on the title, a draft and freeboard readout in the full HUD.

Out (later): porter and crew carrying animation, food and water, spoilage, ballast as cargo, deck
cargo, long timber, water in the hold and swamping, contracts and NPC merchants with dialogue (phase 3
of the vision), weather on the game clock, quality-invariant worldgen, anchorage or beach trade, saving
at sea, money sinks (repairs, port fees beyond duty), credit.

## 3. World: three harbours

### 3.1 Worldgen (`src/world/worldgen.worker.ts`, `worldgenTypes.ts`)

**Invariant:** for every seed, everything the current code generates (heights for land above 0.5 m,
islands, `sites.harbour`, `shore`, `temple`, `houses`, `pier`, `start`, vegetation, AO away from new piers) is
**bit-identical** before and after this change, except vegetation entries removed by §3.1 step 5, seabed
heights changed by the new dredges, and the sea-state maps (step 6). Test it (§13, T3).

Insertion order (existing code is never reordered): new-harbour search, piers and dredges, new villages
and the vegetation filter all go **after vegetation** (around `worldgen.worker.ts:534`) and **before the AO
bake** (around :536). The sea-state bake (around :580) then takes all piers. Add a helper
`moistAt(x, z) = 0.5 + 0.5·n2a(x/700, z/700) + 0.2·n2c(x/150, z/150)` (the expression the vegetation uses,
around :499) and use it in §4.3; leave the vegetation's own inline expression as it is. `slopeAt(x, z)`
exists (around :224).

**Island identity:** the component label grid `lab` (256², about 47 m cells, built around :243–285) holds
component **ids**, not indices into the sorted `islands` list; compare `lab` values with `islands[i].id`.
Cells whose centre is at or below 0.5 m are −1; when a sample near the coast reads −1, use the first labelled
cell among its 8 neighbours.

Steps:

1. **Candidate islands:** `islands` (already sorted by area, `[0]` = main) with index ≥ 1, `name !== ''`
   and `area ≥ 1.0e6 m²`. Take up to `MAX_PORTS − 1 = 2` in area order. If fewer qualify, take what
   there is (a world may have 1 or 2 ports; everything downstream must handle `harbours.length` 1–3).
2. **Harbour search per candidate:** the existing scoring (wind exposure, enclosure, open run, gentle
   land, depth −18..−4) refactored into a function `scoreSite(x, z)` used by both the main search (same
   grid, same window, same result) and the new ones. Window for island i: centre (cx, cz),
   half-size `2.6·sqrt(area/π) + 600` m, step 45 m. Extra rule for new harbours: the point's nearest
   land along the 24 rays must belong to island i (`lab` id equal to `islands[i].id`, with the
   neighbour fallback above).
   Relaxed limits for islets: `bestOpenRun ≤ RAYS·0.75`, `minD ≤ 600`. If no point passes, take the
   best-scoring point ignoring the open-run and enclosure limits (an exposed harbour is content). Reject
   points within 1500 m of an existing harbour.
3. **Shore, pier and dredge:** the existing shore-point and mole code, refactored into
   `buildPier(harbour) → { shore, pier }`, unchanged for the main harbour. The dredge only lowers
   seabed below 0.5 m, so land and vegetation are unaffected.
4. **Village:** for each new harbour k (1-based), houses with their own RNG `mulberry(seed + 31 + 1000·k)`,
   the same placement rules as the main village, with `maxHouses = clamp(round(140·(area_k/area_0)^0.8), 12, 140)`
   and radius `650·(area_k/area_0)^0.4` m. No temple.
5. **Vegetation filter:** after the new villages exist, remove vegetation entries within 9 m of a new
   house centre (same rule as the main village) and within the new piers' dredge rectangles. Filter
   only; never draw from the vegetation RNG again.
6. **Sea state:** `bakeSeaState` detail regions: the main one unchanged and new harbours the same
   (`size 512, n 128`; `SeaStateField` requires every map to share one n, `seaState.ts:402`, and the
   ocean atlas assumes it, `ocean.ts:256`), centred on each pier's mid. Detail index order: main first.
   **Bake cost:** today world-grid rays march through every detail region at 4 m steps
   (`seaState.ts:297-303`), so three regions cost about 2.9 s against 0.75 s for one (measured at 2048).
   Change: rays for world-grid cells (cells outside every detail region) sample the world grid only;
   rays for detail-region cells keep using the finest grid, as now. Report the bake time; the gate is
   +1.8 s over today. Consequence: the main harbour's sea-state maps are no longer bit-identical (their
   rays crossed the world grid differently); `test:sea-state` is property-based and stays green.
7. **Port profiles:** `portProfile` for each harbour (§4.3), computed in the worker.

**Types** (`worldgenTypes.ts`):

```ts
export interface HarbourSite {
  /** 0 = the main harbour; stable for a world */
  id: number;
  /** island index into WorldGenResult.islands */
  island: number;
  /** "Serrothos": the island's name */
  name: string;
  harbour: { x: number; z: number; openAngle: number };
  shore: { x: number; z: number };
  pier: Sites['pier'];
  houses: House[];
  /** sea-state detail region index (1-based into the bake's maps) */
  detail: number;
  profile: PortProfile;
}
export interface PortProfile {
  /** village houses, the basis of population */
  houses: number;
  /** land area (m²) of the island: the 48 m grid's land cells × 48² */
  area: number;
  /** terrain feature areas per good (m², weighted), §4.3 */
  features: Record<GoodId, number>;
}
// Sites gains:
harbours: HarbourSite[]; // [0] mirrors harbour/shore/pier/houses exactly
```

`sites.harbour`, `shore`, `pier`, `houses` stay and equal `harbours[0]`'s fields, so existing code keeps
working. `GoodId` is imported from `src/trade/goods.ts` as a type only (the worker must not import
runtime trade code beyond `goods.ts`, which has no DOM or three.js imports).

### 3.2 Main thread (`harbour.ts`, `props.ts`, `game.ts`, `mooring.ts`, UI)

- `buildHarbour(gen, terrain)` becomes `buildHarbours(gen, terrain): HarbourLayout[]`, one per site. Each
  layout gains `id`, `name`. Houses and the temple solids belong to layout 0 (as now); each other layout
  adds its own village's house solids. Berth ids are global and unique (`layout k` berths
  `2k, 2k+1`); each `Berth` gains `port: number`.
- `Mooring.setHarbour(layout)` becomes `setHarbours(layouts)`: berths and ship colliders are concatenated.
  The approach search already picks the nearest berth.
- `Props`: pier, dock life, boats and rock faces per harbour (loop over sites; the existing per-harbour
  functions take a site). Village per harbour. Temple only at 0. Dock life's RNG seed becomes
  `41 + 7·k` for harbour k (k = 0 keeps 41). The trade stall's props are placed per harbour by their own
  function **before** dock life (§8), and dock life treats the stall footprint as pre-placed.
- `Game.harbourLayout` stays as a getter returning `layouts[0]` (`main.ts:132` and `lightingReview.ts:540`,
  another session's file, use it). Lead.
- `BerthMarker`, minimap and chart: all berths. The chart labels each port by name at its pier root, in
  the existing chart label style.
- `Birds`: one anchor per harbour plus the temple.
- Audio harbour proximity: the nearest harbour.
- Location title (`Game.nearestIsland`): "Harbour of {name}" within 450 m of any harbour.
- Dev `?start=berth&berth=N` indexes the global berth list.

## 4. Economy

All of it lives in `src/trade/` as **pure TypeScript** with no three.js, DOM or game imports, so the
worker (goods table only) and headless tests can use it.

### 4.1 Money

Money is an integer number of **centidrachmas** (1 dr = 100). Never store float drachmas. Display with
one decimal: `formatDr(c) = (c/100).toFixed(1) + ' dr'` with a thin no-break space as thousands separator
above 9 999 (`12 450.0 dr`). Rounding of any computed amount is in the port's favour (the player pays
`ceil`, receives `floor`).

### 4.2 Goods (`src/trade/goods.ts`)

```ts
export type GoodId = 'wine' | 'oil' | 'wheat' | 'almonds' | 'fish' | 'honey' | 'firewood' | 'pitch';
export interface Good {
  id: GoodId;
  /** ledger name, sentence case */ name: string;
  /** unit word, singular / plural */ unit: [string, string];
  /** full unit mass, kg */ mass: number;
  /** hold volume one unit takes including broken stowage, m³ */ stow: number;
  /** reference price, centidrachmas per unit */ pRef: number;
  /** price elasticity to stock */ eta: number;
  /** consumption per person per game day, units */ perCapita: number;
  /** stock buffer at reference: S_ref = D_ref · bufferDays */ bufferDays: number;
  /** archipelago self-sufficiency at reference */ base: number;
  /** shock epoch length, game days; shock chance per epoch; log-amplitude */ epochDays: number; shockChance: number; shockAmp: number;
  /** harvest: peak day of year, half-width days, amplitude (0 = no season) */ season: [number, number, number];
  /** visual kind for the hold and the quay */ look: 'amphora' | 'jar' | 'sack' | 'bundle';
  /** model tint (hex) */ tint: number;
}
```

| id | name | unit | mass kg | stow m³ | pRef dr | eta | perCapita | bufferDays | base | epoch d | chance | amp | season [doy, half, amp] | look |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| wine | Wine | jar / jars | 42 | 0.075 | 8.0 | 0.8 | 0.012 | 40 | 1.0 | 15 | 0.3 | 0.35 | [270, 25, 0.5] | amphora |
| oil | Olive oil | jar / jars | 40 | 0.075 | 24.0 | 0.7 | 0.0025 | 60 | 0.9 | 20 | 0.3 | 0.4 | [340, 40, 0.5] | amphora |
| wheat | Wheat | sack / sacks | 40 | 0.065 | 6.0 | 1.1 | 0.021 | 30 | 0.85 | 12 | 0.35 | 0.45 | [165, 25, 0.6] | sack |
| almonds | Almonds | jar / jars | 30 | 0.075 | 9.0 | 0.6 | 0.003 | 40 | 1.0 | 15 | 0.25 | 0.35 | [230, 20, 0.5] | amphora |
| fish | Salt fish | jar / jars | 40 | 0.075 | 10.0 | 0.7 | 0.004 | 20 | 1.0 | 8 | 0.35 | 0.4 | [100, 40, 0.4] | amphora |
| honey | Honey | jar / jars | 25 | 0.04 | 20.0 | 0.5 | 0.001 | 60 | 1.0 | 20 | 0.25 | 0.3 | [190, 30, 0.4] | jar |
| firewood | Firewood | bundle / bundles | 25 | 0.06 | 0.8 | 1.0 | 0.15 | 10 | 0.9 | 10 | 0.3 | 0.3 | [0, 0, 0] | bundle |
| pitch | Pitch | jar / jars | 35 | 0.06 | 8.0 | 0.6 | 0.001 | 60 | 1.0 | 20 | 0.25 | 0.35 | [0, 0, 0] | jar |

Tints: wine `0xa8603a` (the existing clay), oil `0xb8885a`, almonds `0xc49a6c`, fish `0x8f6a4e`,
honey `0xc9a066`, pitch `0x5a4636`, wheat sack `0xcdbb94`, firewood `0x7a5a3c`.

Season factor on production: `g(Δ) = ½·(1 + cos(π·Δ/half))` for `|Δ| < half`, else 0, where Δ is the
circular day-of-year distance to the peak; `season = 1 + amp·(g(Δ) − half/365)`. Continuous, year mean
exactly 1, minimum `1 − amp·half/365 > 0`. With `amp = 0` (firewood, pitch) it is 1.

All numbers are tunables in this one table. Phase T7 tunes them in the browser.

### 4.3 Port profile and reference flows

Computed in the worker on a fixed 48 m grid over island i's window, land cells only (`h > 0.5` and
`lab` = island i). `moist(x, z)` is the vegetation moisture expression, `sl` the existing `slopeAt`.
Each feature accumulates `48²` m² per qualifying cell, times the weight:

| good | qualifies | weight |
|---|---|---|
| wheat | `2 < h < 80`, `sl < 0.12` | 1 |
| wine | `10 < h < 300`, `0.10 < sl < 0.40` | `max(0, 1.2 − moist)` |
| oil | `2 < h < 160`, `sl < 0.30` | `moist` |
| almonds | `10 < h < 250`, `0.08 < sl < 0.35` | 1 |
| fish | land cell with a sea cell among its 4 neighbours | 1 (so it is coast length × 48) |
| honey | `sl > 0.30` or `h > 250` | 1 |
| firewood | `h < 220`, `sl < 0.70`, `moist > 0.35` | `moist − 0.35` |
| pitch | firewood's rule and `h > 60` | `moist − 0.35` |

Population `N_p = POP_PER_HOUSE · houses_p` with `POP_PER_HOUSE = 30`: the village is a token of the
island's people (140 houses: about 4 200).

Reference demand per day `D_p,g = N_p · perCapita_g`. Production ratio from **land use**, normalised
across the world's ports:
`share_p,g = features_p,g / area_p`, `r_p,g = base_g · clamp((share_p,g / mean_p(share_p,g))^1.5, 0.25, 3)`
(when `mean = 0`, `r = base`). Land use, not per-capita land, so island size doesn't make the big island
export everything; trade runs both ways (simulated on seed 1729: home imports wheat, oil and fish from the
islets and exports honey and pitch). Reference production `P_p,g = r_p,g · D_p,g`. Reference stock
`S_ref,p,g = D_p,g · bufferDays_g`. Equilibrium stock is `S_ref·r`, so the equilibrium price is
`pRef·r^(−eta)`: producers are cheap and consumers dear, from terrain alone. With one port, `r = base`.

### 4.4 Market state and the clock (`src/trade/market.ts`, `economy.ts`)

The economy runs on **absolute game hours** `T = clock.dayCount·24 + clock.hours` (add
`AstroClock.totalHours` as a getter, and `AstroClock.advanceHours(h)` which moves `hours` forward and
increments `dayCount`, `dayOfYear` and `moonPhase` exactly as `update()` does; the `T` key must use it,
because today it sets `hours` directly and time runs backwards past midnight, `game.ts:444-451`).

**Constructor** (pure; tests use synthetic ports):

```ts
new Economy({
  seed: number,
  ports: { id: number; profile: PortProfile; x: number; z: number }[],  // x, z = pier root, world m
  doyAt: (T: number) => number,     // day of year 0..364 at absolute hour T
  hands: number,                    // the player's crew, for wages (0 = no wages)
  startT: number,                   // absolute hour T0 of the start; see Start below
})
```

The lead passes `doyAt = (T) => (((doy0 + Math.floor(T / 24)) % 365) + 365) % 365` with
`doy0 = clock.dayOfYear − clock.dayCount`, so the economy never imports `astro.ts`.

State per port and good: stock `S` (float, units). Time advances in **integer-hour quanta** `[n, n + 1)`:
`advanceTo(T)` runs every quantum n with `n + 1 ≤ T` not yet run. It throws if T is below the last T
(time never runs backwards). Midnight is the end of a quantum with `(n + 1) % 24 === 0`; the midnight
hook runs NPC shipments and wages (§4.5) and returns events (`{ type: 'wages', days, amount }`,
`{ type: 'arrival', … }`) for the caller. Within quantum n, with `tm = n + 0.5`:

```
P = P_ref · season(g, dayOfYear(tm)) · shockP(p, g, tm)       (units / day)
D = D_ref · shockD(p, g, tm)
S_eq = S_ref · P / D ;  tau = S_ref / D  (days)
S ← S_eq + (S − S_eq) · exp(−(1/24) / tau)
```

Advancing 100 days in one call equals 2 400 one-hour calls **bit for bit** (test). Ports tick always,
wherever the player is; 3 ports × 8 goods per quantum is trivial even at 480×.

**Shocks** (`src/trade/shocks.ts`): with `tDays = T/24`, per (port p, good g index gi): offset
`off = hash01(seed, p, gi, 0x0ff) · epochDays`; epoch `k = floor((tDays + off) / epochDays)`; phase
`φ = (tDays + off)/epochDays − k` in [0, 1). `u = hash01(seed, p, gi, k, 0)`. If `u < shockChance` there is a
shock, on production when `hash01(seed, p, gi, k, 1) < 0.6`, on demand otherwise, with
`z = 2·(2·hash01(seed, p, gi, k, 2) − 1)` and multiplier `exp(shockAmp · z · w(φ))`, where
`w(φ) = smoothstep(0, 0.2, φ) · (1 − smoothstep(0.8, 1, φ))`. Hash: murmur3 `fmix32` over the integer
arguments combined with `h = fmix32(h ^ (x | 0) >>> 0)` in order (negative k is fine: fold with `| 0`
then `>>> 0`), `hash01 = h / 2^32`. Never `Math.random`, never a streamed RNG. A save never stores shocks:
they are a function of time.

**Price:** `price(S) = clamp(pRef · (S_ref / max(S, 0.05·S_ref))^eta, 0.3·pRef, 3.5·pRef)` in
centidrachmas (float). Spread `σ = 0.06`: ask (player buys) `= price·(1 + σ/2)`, bid (player sells)
`= price·(1 − σ/2)`.

**Trades** (`Market.quoteBuy(q)`, `quoteSell(q)`, `buy(q)`, `sell(q)`): per-unit stepping. Buying q
units sums `ask(S − i − 0.5)` for i = 0..q−1. Selling sums `bid(S + i + 0.5)`. Then duty: **2 %** on
both, so `pay = ceil(sum·1.02)` and `receive = floor(sum·0.98)`. Buying may not take S below
`0.05·S_ref` (`maxBuy`). A buy-then-sell round trip at one port visits the same unit points, so it loses
exactly `(σ + 0.04)·V` with `V` the sum of the mid prices, plus rounding in the port's favour. The fuzz
test asserts `loss ≥ (σ + 0.04)·V − 1e-9·V`. The quote returns `{ total, duty, unitFirst, unitLast }` in
centidrachmas (`total` includes duty).

**NPC shipments** (`economy.ts`): at each game midnight, for each ordered port pair (A, B) and good g:

```
freight = 10 + 3 · dist_km · (mass_g / 40)      (centidrachmas per unit)
S_B' = S_B + inflight(B, g)                   (units already sailing to B)
gap = bid_B(S_B') − ask_A(S_A)·1.02 − bid_B(S_B')·0.02 − freight
if gap / ask_A > 0.15 and A has an idle ship and hash01(seed, A, B, gi, day) < min(0.6, gap/ask_A − 0.15):
  q = floor(min(6000 / mass_g, 0.25 · max(0, S_A − 0.3·S_ref_A), 0.4 · S_ref_B))
  if q ≥ 10: S_A −= q now; arrival at T + routeHours(A, B); S_B += q then
```

`routeHours(A, B, T) = (pierDistance_km · 1.25) / (7.2 km/h) · 60` (a 2 m/s ship in real time is 60 game
hours per real hour). It is the hook weather will use later. Fleets: port 0 has 3 ships, others 1. A
ship is busy until arrival plus the same time back. At most one shipment per pair and day; candidates
are processed in a fixed order (A, B, g ascending) so the outcome is deterministic.

**Start:** stocks are set to `S_eq` at `T_start = floor(T0) − 480` (T may be negative there: hashes and
`doyAt` handle it), then `advanceTo(T0)` runs the 20 days with shipments, so the player arrives to a moving
market. A loaded voyage restores its saved state instead (`Economy.restore(snapshot)`, `snapshot()`).

### 4.5 The player's books (`src/trade/voyage.ts`)

```ts
interface VoyageState {
  purse: number;                                  // centidrachmas, may go negative (wages owed)
  manifest: Partial<Record<GoodId, number>>;      // whole units aboard
  notebook: { port: number; good: GoodId; ask: number; bid: number; T: number }[]; // latest per (port, good)
  job: CargoJob | null;                           // §6
}
```

- **Wages:** from the economy's midnight hook (not a separate `dayCount` watcher), `purse −= hands · 150`
  per midnight, `hands = design.oars.crew.hands` (8 on the merchant: 12.0 dr per day). The caller shows one
  toast per frame with the total of that frame's midnights: `Wages paid · 12.0 dr` (`· 36.0 dr` after a
  three-day skip). The economy's own pre-run charges no wages.
- **Notebook:** opening the ledger at a port writes that port's current ask and bid per good with T.
- **Start of a new voyage:** purse 30 000 (300.0 dr), manifest `{ wine: 70 }`.

## 5. Ship: cargo mass

### 5.1 `ShipPhysics.setStaticLoad(items)` (`src/ship/physics.ts`)

Static load is cargo (and later ballast) whose mass, CG and inertia are folded into the rigid body,
**not** per-step point weights. Crew stays on `payload` as now.

- Keep the constructed values as `readonly designMass`, `readonly designCg`, `readonly designInertia`.
  `mass` becomes a mutable public field (same name). `cg` and `inertia` stay the same `Vector3` objects,
  mutated in place (many modules hold `body.cg`).
- `setStaticLoad(items: { mass: number; local: THREE.Vector3 }[])`: items are **differences from the
  design load** and may be negative. Compute
  - `M = designMass + Σm`
  - `cg' = (designMass·designCg + Σ m·r) / M`
  - inertia about cg' on the hull axes, same convention as `payloadInertiaUpdate`
    (x: dy²+dz², y: dx²+dz², z: dx²+dy²): `I' = designInertia + designMass·shift(designCg) + Σ m·shift(r)`
    where `shift(r)` uses `d = r − cg'`.
  - Throw if `M < 0.4·designMass` or any `I'` component `< 0.3·designInertia` (a bad load table).
- **No pose jump:** with `Δ = cg' − cg` (local), `pos += R·Δ`, `prevPos += R_prev·Δ`,
  `vel += angVel × (R·Δ)`. Then write `mass`, `cg`, `inertia`, `displacement = M`. World positions of
  hull points are unchanged (test).
- `angularDamp` keeps using `designMass` (`physics.ts` ~line 325). Gravity, integrator, `effectiveMass`,
  grounding and the mooring (`ship.mass + ship.payloadMass`) use `mass`, which now includes cargo:
  correct, no double count, because cargo is never on `payload`.
- `place()` uses `cg.y` as now.
- **Trace:** nothing calls `setStaticLoad` in `ShipPhysics` itself, so `scripts/trace-merchant.mjs`,
  `test:golden` and every existing suite are unchanged. Only the game's cargo hold calls it. (Verified:
  `designMass` 17 739 kg, crew payload 585 kg; the design inertia already includes `inertiaScale`.)

### 5.2 Mooring with a moving CG

The docked hold and the haul servo compare `ship.pos` (the CoG) with the berthed pose. When cargo moves
the CG, that comparison must not move with it, or the hold drags her by the shift. Add
`ShipPhysics.refPoint(out) = toWorld(designCg, out)`: the world position of the design CG, a fixed hull
point. In the mooring, replace `ship.pos` with `ship.refPoint(…)` wherever it is **compared to a pose or
berth** (`mooring.ts` around lines 317, 398, 437, 546, 583, 609–610; check each), and keep forces applied at
`ship.pos`. With `cg === designCg` the difference is a zero vector, so it's bit-identical.

`setStaticLoad` is called only between frames' simulation steps, never inside `ShipPhysics.step`.

### 5.3 Design data (`design.ts`)

```ts
cargo?: {
  /** the 3 t of amphorae baked into the design load, removed as one block when the hold takes over */
  // 0.8 m above the keel bottom (keel datum 1.285 m below the waterline; keelDepth(0.5) = 1.283).
  // z = cgZ is a convention (the design only says the stowage is trimmed level), so the design CG is unchanged.
  reference: { mass: 3000; local: [0, -0.485, -0.205] };
  hold: { sFrom: 0.28; sTo: 0.72; floorAboveKeel: 0.40; ceilingBelowDeck: 0.10; cell: [0.25, 0.20, 0.5]; margin: 0.06; mastClear: 0.30 };
  hatches: [{ s0: 0.31; s1: 0.41 }, { s0: 0.47; s1: 0.555 }];   // half-width 0.70 m
  hatchHalfWidth: 0.70; lip: 0.03;
}
```

Only the merchant gets `cargo`. The trireme has none, so all trade UI is off for it.

## 6. Hold, stowage and the cargo job (`src/cargo/`)

### 6.1 Hold cells (`hold.ts`, pure)

Build once from the design. In ship-local coordinates (y = 0 at the design waterline, keel bottom at
`−hull.keelDepth(s)`): stations from `sFrom` to `sTo` in steps of `cell[2]` along z (use `hull.zOf` /
`sOf`), layers from `floorY(s) = −keelDepth(s) + floorAboveKeel` up to `deckY(s) − ceilingBelowDeck` in steps
of `cell[1]`, and across x in steps of `cell[0]`, symmetric about the centre line (cell edges at
x = 0, ±0.25, …). With `(s_c, y_c)` the cell centre and `hw = halfWidthAt(s_c, y_c) − margin`, keep a cell
when its inner edge `|x|_in < hw` and its centre is more than `mastClear` from the mast axis (x = 0,
z = zOf(mastStation)). Its volume is the **clipped** width `min(|x|_out, hw) − |x|_in` times
`cell[1]·cell[2]`, and its centre x for the static load is the middle of the clipped width. (Whole
rectangular cells with all corners inside keep only 11.6 m³; this rule keeps about 822 cells and
20.1 m³.)

**Fill order:** layer index above each station's own floor ascending (tier by tier, following the keel's
rise toward the ends), then `|x|` ascending, then `|z − designCg.z|` ascending with fore before aft at
equal distance (port before starboard at equal x). This keeps her trimmed (cargo CG z within 0.08 m of
the LCB up to 240 jars) and the cargo low. A full hold's cargo CG sits about 0.25 m aft of the LCB because
of the hold's own shape; that trim is physical.

**Stowage is a pure function of the manifest:** sort goods by density (`mass/stow`) descending, then
fill cells in fill order with each good's volume (`qty·stow`), spilling into the next cell. A cell may
hold parts of two goods. Output per cell: `{ mass, parts: { good, volume }[] }`. Overflow (volume above
capacity) is refused upstream; `stow()` throws on it.

**Static load:** `[{ mass: −reference.mass, local: reference.local }, …cells with mass > 0 as { mass, local: cell centre }]`.
When the manifest is empty this still removes the reference block: she floats light (about 14.7 t plus
crew), which is right.

Capacity checks (test): 267 ± 15 jars of wine fit; wheat fills about 12 t by volume. The hold's centroid
sits **above** her CG (y ≈ −0.09 to −0.14 against −0.36), so cargo raises KG and lowers GM (§0).

### 6.2 The cargo job (`src/trade/job.ts`, pure)

The `CargoJob` type is declared in `src/trade/voyage.ts`; the job's behaviour is in `src/trade/job.ts` and
is driven by `TradeSession` (§6.3). Both are Economy lane.

```ts
export interface CargoJob {
  port: number; berth: number;
  /** signed units still to move per good: + = coming aboard, − = going ashore */
  pending: Partial<Record<GoodId, number>>;
  /** units on the quay right now per good (the stack's contents) */
  quay: Partial<Record<GoodId, number>>;
  /** fractional progress toward the next unit */
  carry: number;
}
```

- A confirmed ledger order (both buys and sells) **settles money and port stock at once** and adds the
  units to `pending` and to `quay` (bought units start on the quay; sold units are added to the quay
  only as they land). The manifest changes only as units physically move.
- Rate: **10 units per game hour** (`LOAD_RATE`), shared by all pending goods. Order: unloading first
  (sold goods leave before bought goods come aboard), then goods in table order. Each unit moved:
  manifest ±1, quay ∓1 or ±1, and porterage `ceil(PORTER_FEE_PER_KG · mass)` centidrachmas from the
  purse, `PORTER_FEE_PER_KG = 0.25` (11 c for a 42 kg jar, 7 c for a bundle of firewood).
- The ledger shows the porterage of an order before you confirm it.
- The job runs on game time, so time-skip speeds it. The hold re-stows and `setStaticLoad` runs **per unit
  moved** (cheap: about 200 cells; at most a few per frame even at 480×; batch per frame).
- When `pending` is empty, sold units on the quay disappear one game hour later (carted off), then the job
  ends. Toasts: `Cargo stowed` (a load finished) or `Cargo landed` (an unload finished) — whichever
  happened last.
- While a job has pending units, `R` (cast off) is refused with `Cargo still moving · {n} left`.
- Hatch gratings lift off when a job starts and go back 1 game hour after it ends (§7.2). Casting off
  closes them at once.

### 6.3 Trade session (`src/trade/session.ts`, pure)

The glue between the economy, the purse, the manifest, the notebook and the job. No DOM, no three.js.

```ts
class TradeSession {
  constructor(o: { economy: Economy; voyage: VoyageState; holdCapacity: number /* m³, from hold.ts */ })
  readonly economy: Economy; readonly voyage: VoyageState;
  /** manifest + pending incoming − pending outgoing */
  aboard(good: GoodId): number;
  /** volume (m³) and mass (t) of what is aboard plus pending incoming */
  holdUse(): { volume: number; tonnes: number };
  /** the allowed range for one row's order given the other rows (§9 clamps), and what limits it */
  limits(port: number, orders: Orders, good: GoodId): { min: number; max: number; limitedBy: 'purse' | 'hold' | 'stock' | 'aboard' | null };
  /** signed centidrachmas (+ = money in): sells and buys quoted at current stock, plus duty and porterage */
  quote(port: number, orders: Orders): { total: number; duty: number; porters: number };
  /** settles money and stock now (sells first, then buys), extends the job; returns lines for the toasts */
  confirm(port: number, berth: number, orders: Orders): { sold: Line[]; bought: Line[] };
  /** writes the notebook for this port at T */
  noteOpened(port: number, T: number): void;
  /** advances the economy to T, pays wages, moves cargo at LOAD_RATE over the elapsed game hours */
  tick(T: number): SessionEvent[];
  get pendingUnits(): number;
  /** true while a job runs and for 1 game hour after it ends */
  hatchesOpen(T: number): boolean;
  /** called on cast off: closes the hatches at once (refused upstream while units are pending) */
  castOff(): void;
}
type Orders = Partial<Record<GoodId, number>>;            // + buy, − sell
type Line = { good: GoodId; qty: number; total: number };
type SessionEvent =
  | { type: 'wages'; days: number; amount: number }
  | { type: 'moved'; good: GoodId; delta: number }          // manifest changed by delta (re-stow now)
  | { type: 'job-done'; kind: 'stowed' | 'landed' }
  | { type: 'arrival'; port: number; good: GoodId; qty: number };
```

Porterage is charged per unit as it moves (§6.2); `quote` includes the porterage of the whole order so the
ledger can show it in advance. Purse limits count the quoted total including porterage.

## 7. Visuals

### 7.1 Deck with hatches (`merchantModel.ts`)

- **Deck openings:** the deck's x columns scale with width (`merchantModel.ts` around 431–460), so
  |x| = 0.70 never falls on a grid line. Build the deck in three bands per station row (−w..−0.70,
  −0.70..0.70, 0.70..w), insert station rows at each hatch's `s0` and `s1`, and skip the centre band
  inside the hatches.
- **Coamings:** a visual lip 0.03 m high and 0.06 m wide, **inside** the rectangle (the aft hatch's edge
  clears the handover rower's back foot by only about 5 cm), `woodDark`.
- **Gratings:** a lattice of 0.05 m bars at 0.16 m pitch both ways, top flush with the deck (the crew
  animator puts feet at `deckY`, and relief walks cross both hatches at sea: `crew/rotation.ts` around
  33–60). Two meshes (one per hatch) toggled by `MerchantModel.setHatchesOpen(open: boolean, t: number)`:
  when open, each grating is drawn standing against the outboard side of its coaming (rotated 80°) so
  the change reads physically.
- **Hold interior:** a ceiling-plank floor at `floorY(s)` across the hold's width (from `halfWidthAt`),
  using the deck's plank material darkened ×0.55. The hull mesh is already double-sided.
- Remove the six token amphorae by the mast (`merchantModel.ts`, "cargo" block). The cargo now lives
  in the hold.

### 7.2 Walking (`game.ts buildShipSolids`, the merchant branch)

- Gratings closed: each hatch is one box solid, top at deck level, `walkTop: true` (flush deck).
- Gratings open: the same box with `walkTop: false` and top at deck + 1.0, so nobody walks into the
  opening. Swap the solid when the hatch state changes.
- Crew paths: the crew does not row while docked. Check in the browser review that idle rowers don't
  stand in an open hatch. Report it; don't redesign the crew.

### 7.3 Cargo models (`src/cargo/cargoModels.ts`)

Procedural, no Blender, one `BufferGeometry` per look, merged and centred, feet at y = 0:

- **amphora:** the merchant model's existing lathe profile (move it into this module and import it in
  `merchantModel.ts`), 0.93 m tall, 0.40 m wide.
- **jar:** the same profile scaled to 0.55 m tall, 0.30 m wide.
- **sack:** a lathe through `(0,0) (0.20,0.02) (0.24,0.12) (0.22,0.30) (0.12,0.40) (0.05,0.44) (0,0.45)`,
  scaled x 1.15 (a squat sack), cloth roughness 0.95.
- **bundle:** five cylinders (r 0.05, length 0.9) side by side lying along z, plus two thin rope bands.

One `InstancedMesh` per look (max instances 400 each) with a per-instance colour from the good's tint.

### 7.4 Cargo in the hold (`src/cargo/cargoVisual.ts`)

Only what can be seen through the hatches is drawn. Per hatch, place a visual grid at the look's footprint
pitch (amphora 0.42, jar 0.32, sack 0.46 × 0.40, bundle 0.95 × 0.30 m) over the hatch rectangle plus
0.3 m around it. At each grid point, find the hold column below and its filled cells from the stowage
(§6.1). Stack that column's goods from the floor upward at each look's layer pitch (amphora 0.55,
nested; jar 0.50; sack 0.30; bundle 0.32) until its filled height, drawing the top two layers only.
Rebuild on each manifest change (at most a few per frame). Deterministic, with no RNG, except a fixed
per-instance yaw `hash01(i)·2π` for jars and sacks.

### 7.5 Quay stack (`src/cargo/quayStack.ts`)

For the docked berth: two halves on the quay top, each 1.5 m along the pier × 1.6 m across, spanning
1.0–2.5 m either side of the plank axis (the landing between them stays clear), near edge 0.9 m from the
face. Fill the seaward half first. Draw `job.quay` units with the same models, packed in rows, two layers
high for jars and sacks; past capacity, keep growing each half away from the plank in 0.5 m steps, but
never within 1.0 m of a dock-life figure (the sailor by the bollard stands at about `f.mid − 14` along the
pier, `props.ts` around 440). Add one blocking `Solid` (box, `walkTop: false`) per non-empty half to the
world walk geometry.

## 8. Trade stall (`src/trade/stall.ts` + `props.ts`)

**Props (World lane, `props.ts`):** at each harbour a merchant figure (`fig_sailor_idle`), an `awning`, a
`bench` and three `amphora` from the kit, on the shore half of the mole. Placed by its own function
**before** dock life, never inside `buildDockLife` (which returns early on short moles, `props.ts:409`)
and never drawing from dock life's RNG. Along-pier position `a = clamp(berthStart − 10, 6,
max(6, berthStart − 4))`, lateral `fs·(hw − 1.1)` where `fs` is the side dock life uses for its figures
(compute it the same way, from the same first RNG draw, without consuming dock life's stream: a separate
`rng(41 + 7k)` instance). The figure faces across the mole. Dock life treats the stall footprint (radius
1.0 m) as pre-placed. Solids for the bench and the awning posts. The World lane exports the stall's
interaction point per harbour (`HarbourLayout.stall: { x, y, z }`).

**Interaction (Interface lane, `stall.ts`):**

`Interactable`, frame `'world'`: `id 'trade-{port}'`, label `Trade`, position at the
figure's chest (top + 1.4), radius 3.5. Enabled when the design has `cargo` and the player is on foot in
the world frame (`walker.frame === 'world'`). The ledger opens in **trade mode** when the ship is docked at
**this** port (`mooring.linePhase === 'docked'` and `mooring.berth.port === port`); otherwise in
**read-only mode**: the Order column and order footer are hidden and the line `Your ship isn't at this
quay` shows. Either way the player reads prices and they enter the notebook (walking ashore at anchor is
allowed).

## 9. Ledger UI (`src/ui/ledger.ts`, `ledger.css`)

A centred panel in the existing glass style (`--glass-strong`, `--hair` lines, `--f-ui` for figures,
`--f-name` for the port title). Keyboard-first; the mouse also works (row click selects, wheel changes
the amount).

```
Kormakos                                              Day 3 · 14:20
Goods          Stock    Buy     Sell    Aboard    Order
Wine             412    9.1     8.6        30     −30
Olive oil         88   31.4    29.6         —       —
Wheat            140    7.9     7.4       120       —
…
Order total  +246.0 dr   Duty 5.0 dr   Porters 3.0 dr
Purse 312.5 dr      Hold 8.4 t · 14.2 of 21.8 m³
↑↓ Select   ←→ Amount   Shift ×10   Enter Confirm   Tab Notebook   Esc Close
```

- **Buy and Sell** are the current marginal unit prices (ask and bid at the current stock), one decimal,
  no unit. **Stock** is whole units in the port. **Aboard** is the manifest plus pending incoming minus
  pending outgoing (`—` for zero).
- **Order** per row: positive buys, negative sells. `→` +1, `←` −1, Shift ×10. Clamp silently to:
  `maxBuy`, the purse after the other rows' net (you can't confirm a negative total beyond the purse),
  hold volume (the sum of `Aboard + Order` volumes ≤ capacity), and `−Aboard` for sells. When a clamp
  stops the amount, the number doesn't move and the limiting footer figure (Purse or Hold) pulses once
  (the same pulse idiom as the dock gauges). No sentence explains it.
- **Order total** is the signed net (`+` = money in) including duty and porterage, recomputed on every
  change with `quoteBuy` and `quoteSell`, so the player sees the price walk as the amount grows. Duty and
  porterage are shown as figures: they are the rules, not the answer.
- Enter executes every non-zero row (sells first, then buys), shows `Sold 30 wine · 246.0 dr` and/or
  `Bought 120 wheat · 948.0 dr` as a toast, clears the orders and starts or extends the cargo job.
- **Tab Notebook:** a second view of the same panel, a table of ports (columns) × goods (rows), each cell
  `9.1 / 8.6` and its age on a second faint line (`now`, `5 h`, `3 d`), `—` if never seen. The current port's
  column is always `now`. No highlighting of the best cell.
- **Esc** closes the ledger without opening the pause menu (`main.ts` Esc handler checks
  `game.ledgerOpen` first). While the ledger is open, `Game.handleInput` is skipped and `player.update`
  gets a **frozen input**: no look, no movement, no interaction (`input.lookEnabled` is a dead flag today;
  arrow look is read unconditionally at `controller.ts:208`). The walker still steps its physics and the
  world keeps running (time, loading, wages). The ledger reads its own keys from `keydown` events on
  `window` while open.
- The **Hold book** (`I`, anywhere on the merchant): the same panel, read-only, with no Stock, Buy, Sell
  or Order columns. It shows Aboard per good with mass (`30 jars · 1.3 t`), purse, hold totals, wages per
  day (`Wages 12.0 dr a day`), any job progress (`Loading · 23 left`), and Tab to the notebook.
  Title: `Hold`.

All strings: sentence case, units, no exclamation marks, no em-dash constructions. The `·` separator is
the house style.

## 10. HUD, time-skip and events

- **Full HUD only:** add `Draft 1.42 m` and `Freeboard 0.71 m` beside the speed readout. Draft is the
  keel's depth below the mean local water at amidships. Freeboard is the lower side's sheer above the
  water amidships, so it falls with heel. Merchant only. Measured from the physics each frame and
  smoothed over 2 s.
- **Time-skip:** `[`, `]` and `T` work only when `linePhase === 'docked'` or `anchorPhase === 'holding'`.
  Otherwise toast `Speed up time when docked or at anchor`. `timeScale` resets to 1 the moment that stops
  being true (cast off, anchor weighed).
- **Toasts:** listed in §4.5 and §6.2, plus `Voyage saved` after a save on docking.

## 11. Voyage save (`src/trade/save.ts`)

- Key: `trieres.voyage.v1.{seed}.{heightmapSize}`. Merchant only.
- JSON:

```ts
{
  v: 1, seed, heightmapSize, savedAt: Date.now(),
  clock: { dayCount, hours, dayOfYear, moonPhase },
  windTime: number,
  berth: { id, bowOut: boolean },
  voyage: VoyageState,
  economy: { T: number, stocks: number[][], shipments: { from, to, good, qty, arriveT }[], fleetBusyUntil: number[][], frac: number },
}
```

- **When:** on the `docked` event, after every confirmed ledger order and at the end of each cargo job,
  while docked. Never at sea in v1.
- **Load:** the title shows `Continue voyage` (primary) and `New voyage` (ghost) when a save for this
  world exists and the ship is the merchant. `Set sail` stays for the trireme and for a merchant without a
  save. `New voyage` deletes the save.
- Restore order: clock, wind time (`wind.update(windTime − wind.time)` then the same sea retarget as the
  `?wind=` path in `main.ts`), economy, voyage, then `setStaticLoad` from the manifest (so she settles at
  her loaded draft), then `ship.place` at the berth pose and heading, then `Mooring.restoreDocked(berth,
  bowOut)` (new: sets the berth, lines attached at the berth's bollards with full tension, plank
  deployed, `linePhase = 'docked'`, no events), then the 240 settle steps, then the player on deck at the
  plank station.
- **New merchant voyage:** the same `restoreDocked` at berth 0 of harbour 0, bow out, with the start state
  of §4.5.
- Corrupt or mismatched saves (`seed`, `heightmapSize` or `v`) are ignored with a console warning, never
  thrown.

## 12. File map

New:
- `src/trade/goods.ts`, `hash.ts`, `shocks.ts`, `market.ts`, `economy.ts`, `voyage.ts`, `save.ts`,
  `money.ts`, `stall.ts`
- `src/cargo/hold.ts`, `job.ts`, `cargoModels.ts`, `cargoVisual.ts`, `quayStack.ts`
- `src/ui/ledger.ts`, `src/ui/ledger.css`
- `scripts/test-market.mjs`, `test-cargo-physics.mjs`, `test-hold.mjs`, `test-ports.mjs`,
  `test-voyage.mjs`; npm scripts `test:market`, `test:cargo`, `test:hold`, `test:ports`, `test:voyage`

Changed: `src/ship/physics.ts` (§5.1), `mooring.ts` (§5.2, `setHarbours`, `restoreDocked`), `design.ts`
(§5.3), `merchantModel.ts` (§7.1), `world/worldgen.worker.ts`, `worldgenTypes.ts`, `seaState.ts`
(early-out), `harbour.ts`, `props.ts`, `birds.ts`, `berthMarker.ts`, `ui/chart.ts`, `ui/minimap.ts`,
`ui/hud.ts` (draft and freeboard), `world/astro.ts` (`totalHours`, `advanceHours`), `game.ts` and `main.ts`
(integration, by the lead only).

## 13. Validation

Headless (each phase's test script, plus every existing suite green: `test:golden`, `test:merchant`,
`test:seakeeping`, `test:mooring`, `test:sea-state`, `test:crew-rowing`/`trace-merchant` where present):

- **T0 market:** determinism (two runs equal); quantum invariance (one 100-day advance = 2 400 one-hour
  advances, bit for bit); `advanceTo` throws when T decreases; fuzz round-trip loss ≥ (σ + 0.04)·V − 1e-9·V
  over 10 000 random (port, good, q); price
  always within the clamp over 10 simulated years with random player trades; with no shocks or
  shipments, stock converges to `S_eq` within 1 % after 5τ; a 0.6·S_ref dump depresses price and
  recovers half-way within about τ·ln2; shipments respond to an artificial gap within 3 days and never
  push a destination above `S_ref + 0.4·S_ref` by themselves; with synthetic profiles shaped like seed
  1729's (§16) a Kormakos-style wheat round trip from 300 dr is profitable after all costs; one game
  year for 3 ports takes under 50 ms; a save/restore at day 37 and both sides advanced to day 90 are
  equal.
- **T1 physics:** with no `setStaticLoad` call, `trace-merchant` and golden bit-identical. Static load
  of +4 t at the design CG: equilibrium draft deeper by the hydrostatic table amount (±3 %). A 0 → 8 t
  step causes no pose jump (hull points' world positions continuous within 1e-9). The static heel from a
  500 kg `setStaticLoad` item at x = +1.0 m equals the heel from the same mass on `payload` (an independent
  path) within 2 %. Full-order rowing speed after 60 s falls monotonically over loads of 0, 4, 8 and 12 t.
  Report KG, GM and the roll period at each (no target). `refPoint` equals `pos` with no static load.
- **T2 hold:** capacity numbers of §6.1; fill order is tier-first and trim-balanced (cargo CG z within 0.15 m of
  the design LCB for fills up to 85 % of capacity); stowage is a pure function; the start manifest's composite
  CG is within 0.05 m of the design CG.
- **T3 ports:** seed 1729 at 2048: `harbours.length === 3`, harbour 0 and every pre-existing site field
  bit-identical to a snapshot taken before the change (write the snapshot JSON to
  `scripts/golden/worldgen-1729.json` **before** editing the worker); every new berth zone is dredged to
  ≤ −3.8 m; worldgen and bake times are reported (gate: bake ≤ +1.8 s); seeds 1, 42 and 777 generate
  without error and give 1–3 harbours; on 1729 every good's r differs between ports (max r / min r ≥ 1.1;
  firewood is short everywhere by design, base 0.9) and no port has `S_eq < 10` units of any good.
- **T4 voyage:** wages over a 3-day skip (from the midnight hook; none during the pre-run); ledger clamps (purse, hold, stock); a confirmed order changes
  money and stock at once and the manifest only through the job; porterage per unit; notebook ages.
- **T6 save:** round trip equal; a mismatched seed is ignored.
- **UI text lint:** a script greps the new UI modules' string literals for `!`, `—` and title case
  ("Order Total").

Browser review (lead, with screenshots kept in `docs/cargo-trade/`): a new voyage starts docked at the
main harbour; the stall and its prompt; the ledger at 1280 × 800 and 1920 × 1080; a buy with the hatches
open, the quay stack and the hold visibly filling, and her settling; casting off refused, then allowed;
the passage to Kormakos and its stall, village and berth; selling; save, reload and "Continue voyage";
the trireme sees ports and has no stall prompt; frame time on medium unchanged within noise.

## 14. Build plan: four Haiku lanes, Opus lead

### 14.1 Four lanes

Four persistent Haiku 5.5 agents, one per lane. Each lane **owns its files outright**: no two lanes
edit the same file. A lane keeps its context across waves (the lead resumes the same agent).

| Lane | Owns | Phases |
|---|---|---|
| **Economy** | `src/trade/{goods,hash,shocks,market,economy,voyage,money,job,session,save}.ts`, `scripts/test-market.mjs`, `scripts/test-voyage.mjs` | T0 economy core → job, session (§6.2–6.3) and save |
| **Ship** | `src/ship/physics.ts`, `src/ship/mooring.ts` (all mooring changes: §5.2, `setHarbours`, `restoreDocked`), `src/ship/design.ts` (§5.3), `src/ship/merchantModel.ts`, `src/cargo/*`, `scripts/test-cargo-physics.mjs`, `scripts/test-hold.mjs` | T1 static load → T2a hold → T2b visuals |
| **World** | `src/world/{worldgen.worker,worldgenTypes,seaState,harbour,props,birds,berthMarker}.ts`, `src/ui/{chart,minimap}.ts`, `scripts/test-ports.mjs`, `scripts/golden/worldgen-1729.json` | T3a worldgen → T3b ports on the main thread |
| **Interface** | `src/ui/ledger.{ts,css}`, `src/ui/ledgerSource.ts`, `src/trade/stall.ts`, `src/ui/hud.ts` (§10 readout only), `src/world/astro.ts` (`totalHours`, `advanceHours`), `scripts/lint-ui-text.mjs` | T4 ledger, notebook, hold book, stall, HUD readout |
| Lead (Opus) | `src/game.ts`, `src/main.ts`, `package.json`, this spec | review, integration, browser review, T7 tuning |

Cross-lane interfaces are the ones written in this spec (`Good`, `Market`, `Economy`, `VoyageState`,
`CargoJob`, `HarbourSite`, `PortProfile`, `setStaticLoad`, `setHarbours`, `restoreDocked`). A lane that
needs another lane's module before it exists codes against the spec's interface and the lead reconciles at
the wave gate. The lead adds the npm scripts.

### 14.2 Waves and gates

| Wave | Economy | Ship | World | Interface |
|---|---|---|---|---|
| 1 | T0: goods, hash, shocks, market, economy, voyage, money + `test-market` | T1: `setStaticLoad`, §5.2, `test-cargo-physics` | T3a: snapshot **first**, then worldgen harbours, villages, profiles, sea-state early-out + `test-ports` | `astro.ts` getters; ledger panel and notebook against the §4 interfaces with a fake market; HUD draft and freeboard; UI text lint |
| 2 | job, session, save + `test-voyage` | T2a: design cargo data, `hold.ts` + `test-hold`; mooring `setHarbours`, `restoreDocked` | T3b: `buildHarbours`, props per harbour (pier, dock life with the stall slot reserved, village, boats), birds, berth marker, chart, minimap | stall module; `ledgerSource.ts` adapting `TradeSession` to `LedgerSource`; hold book |
| 3 | fixes from review | T2b: deck hatches, gratings, hold floor, cargo models, cargo visual, quay stack | fixes from review | fixes from review |

**Gate after each wave (lead):** read every diff, run all suites (§13 plus the existing ones), check the
§1 decisions and the UI rules, then resume each lane with corrections and its next wave. After wave 3:
integration in `game.ts` and `main.ts`, the browser review, then T7 tuning.

### 14.3 Instructions every lane gets

- Work only in your lane's files. Never edit `game.ts` or `main.ts`. Other sessions edit this tree: re-read
  a file right before editing it, and keep diffs small and targeted.
- No commits. No new dependencies.
- Implement the spec as written. If a rule seems wrong or ambiguous, implement the closest literal reading,
  flag it in your report, and don't redesign.
- Headless tests use `import './register-ts.mjs'` like the existing `scripts/test-*.mjs`; run with `node`.
- Before reporting, run your tests plus `test:golden`, `test:merchant`, `test:mooring`,
  `test:sea-state`, `test:seakeeping` and `node scripts/trace-merchant.mjs` where your files could affect
  them.
- Report: the files changed, what each change does, the test output (pass/fail counts and any failure
  text), and a list of spec problems.

## 15. Risks

- **Concurrent edits** to `physics.ts`, `mooring.ts`, `merchantModel.ts`, `props.ts` by other sessions:
  small, targeted diffs; re-read before editing.
- **Worldgen invariance** is fragile (one RNG stream for vegetation): the snapshot test is the guard; take
  it before any edit.
- **Slower, heavier roll when loaded** is real (the hold sits above her CG, so GM falls while inertia
  grows). Report KG, GM and periods; don't tune them away.
- **Thin island markets** may make the islets feel punishing. T7 adjusts `perCapita`, the population per
  house and `bufferDays`.
- **No money sink** beyond wages and porterage: fine for v1.

## 16. Research basis (consultant, round 1)

- Kyrenia (c. 294–280 BC): about 380–404 amphorae (mostly Rhodian, some Samian), 29 millstones over the
  keel, about 9 000 almonds, iron, about 4 crew. Estimated cargo 12–17 t. This hull's hold (s 0.30–0.72,
  floor 0.4 m above the keel) is about 21.8 m³: about 290 jars or 12 t. Volume and mass bind together
  near Rudan's 13 t "laden" mark.
- Rhodian jar: 22–25 L, 90 cm tall, 35 cm wide. About 42 kg full, about half of that tare (Roman analogues;
  medium-low confidence). Wheat: 1 medimnos ≈ 52 L ≈ 40 kg. Daily ration: a choinix (1/48).
- Prices (silver drachma): wheat 5–6 dr per medimnos normally, with a winter rise of about 60 % on Delos and
  crisis prices up to about 3×. Oil: 55 dr per metretes (39 L) c. 300 BC, falling to 16–18 later. Wine:
  3–16 dr per jar by origin. Wages: 1.5 dr per day unskilled (Eleusis 329 BC).
- Markets were not integrated between cities (Reger, von Reden): prices move between ports only through
  shipments. That is the model here.
- Harbour duty: the *pentekoste*, 2 % on imports and exports.
- Sources are listed in the consultant's report. The main ones: Penn Museum and INA on Kyrenia; Rudan et al.
  2024; von Reden, *Money in Classical Antiquity*; Reger, *Regionalism and Change*; ASCSA Hesperia on
  Rhodian capacities and Athenian harbour taxes; de Graauw on loading.

### 16.1 Simulated first hour (consultant, review round 2, seed 1729 at 2048)

With rev. 2's rules (30 people per house, land-use shares with exponent 1.5, NPC caps, porterage per kg,
firewood at 0.8 dr), the equilibrium prices in dr (home Serrothos / Kormakos / Korkia) are:

| Good | Home | Kormakos | Korkia |
|---|---|---|---|
| Wheat | 9.5 | 6.5 | 6.4 |
| Oil | 34 | 23 | 25 |
| Fish | 18 | 11 | 8 |

Honey and pitch are home exports. Trade runs both ways. The median spread between ports over 60 days is
1.2× (wine) to 1.8× (fish), with 35 NPC shipments in 60 days. First moves, net of duty, porterage and wages:

- sell the wine at home: 592 dr
- Kormakos wheat round trip: +128 dr in 4.1 days
- Korkia wheat round trip: +202 dr in 8.1 days

That is modest but real. Early on, money limits the player, not hold space: about 300 dr plus the wine fills
about a third of the hold. With rev. 1's rules every first move lost money: per-capita normalisation, thin
markets and uncapped NPC shipments. Phase T7 tunes from here.
