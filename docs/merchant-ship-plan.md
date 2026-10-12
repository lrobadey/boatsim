# Merchant ship and sea realism: integration plan (rev. 3)

Status: plan only, no code yet. Rev. 3 merges review rounds 3 and 4 (physics corrections, the
docking and anchor redesign, wind–wave coupling) and the user's decisions of 2026-10-09. See §13.

Goal: a second playable ship, a late-Classical Greek merchant ship (holkas) after the Kyrenia wreck
(c. 300 BC), with the same depth as the trireme. It uses the same 6-DOF physics, sailing, rowing,
mooring, walking and deck building, and is tuned against measured data. The player picks the ship on
the title screen, and the scene behind the title switches without regenerating the world.

Along the way the plan makes the sea itself less uniform (shelter, fetch, depth), makes docking and
anchoring real seamanship, and then applies the same physics fixes to the trireme. These are steps
toward the long-term direction: a deep antiquity trade simulator.

## 1. Reference ship and data

The Kyrenia ship is the best-documented Greek merchant hull. It has a measured wreck, Steffy's hull
lines, three sailing replicas, logged voyages (Kyrenia II, 1986–87) and a 2024 hydrostatics study
with Holtrop and CFD resistance.

| Quantity | Value | Source |
|---|---|---|
| Length overall | 14.2 m (13.4 m on the waterline at 1.36 m draft) | Rudan et al. 2024, Table 2 |
| Beam | 4.24 m (3.87 m on the waterline) | Rudan 2024 |
| Depth amidships | about 2.1 m | Steffy 1985/1994 |
| Light ship | about 9 t | Rudan 2024 |
| Laden, 0.8 m freeboard | 22 t at 1.36 m draft (13 t cargo) | Rudan 2024 |
| Overloaded | 25 t at 1.7 m, 30 t at 1.8 m (0.4 / 0.3 m freeboard) | Rudan 2024 |
| Draft vs displacement | 0.5 m 0.9 t · 0.8 m 5.4 t · 1.0 m 10.4 t · 1.2 m 16.6 t · 1.4 m 23.5 t · 1.6 m 30.9 t | Rudan 2024, Table A2 (KG-free, used as acceptance) |
| Calm-water resistance at 22 t | 1 kn 35 N · 2 kn 125 N · 3 kn 263 N · 4 kn 446 N · 4.5 kn 562 N (CFD 591 N) | Rudan 2024, Table A1 (acceptance) |
| Righting lever | 42 mm/deg near upright | Rudan 2024, Table A3: KG not stated, so **not** used as acceptance |
| Crew | 4 (ancient ship); 4–8 on Kyrenia II | Katzev 1987 |
| Sail | one square sail, brailed, about 65 m² | secondary sources |
| Steering | two quarter rudders with tillers | Katzev 1987 |
| Voyage load | 7.8–8.5 t gravel ballast plus 2 t stores | Katzev 1987 |
| Ground tackle | 2 anchors (wood and lead, about 50–60 kg), about 60 m of rope rode | estimate from finds |

Kyrenia II logs (Katzev 1987) were taken at about one third of capacity, in real gusts, seas and
trim. They are **voyage averages, not calm-water steady states**:

| Conditions | Speed |
|---|---|
| Bf 2→5, run then broad reach, 57 nmi | average 4.6 kn |
| Bf 3–6, beam reach | 5–6 kn |
| Bf 4→6, beam reach, sail about half, 2–3 m seas | average 4.1 kn |
| Bf 3–4, quarter reach | 3–4 kn |
| Bf 2, close-hauled 50–60° off the wind | over 2 kn |
| Bf 8, quarter or broad reach | at least 12 kn "downhill", 5.75 kn over 24 h |
| Bf 8, close-hauled | over 7 kn for 3 h, bursts of 10–12 kn |
| Under oars | 0.7–2.0 kn, typically about 1.8 kn |

Later analysis gives about 60° to the apparent wind, 10–20° of leeway close-hauled, and about 80°
to the true wind made good. Tacking was done only below about 16 kn of wind; above that the crew
wore ship.

## 2. Current code facts that shape the plan

### 2.1 Ship

- **Trireme as built:** 56.6 t, GM about 0.74 m. Measured roll period about 3.3 s undamped,
  ζ ≈ 0.5 (reviewer probe). That is heavily overdamped. The cause is the per-column heave damper
  `1800·A·v` (`physics.ts:263`), which also acts as a roll damper with coefficient 1800·ΣA·x². With
  it removed, ζ ≈ 0.14. With all damping removed, the integrator stays stable and keeps oscillating,
  so the damping isn't hiding numerical problems in calm water.
- **No horizontal wave forces.** Buoyancy is purely vertical (`physics.ts:239`). Horizontal wave
  coupling is only drag on orbital velocity. The real Froude–Krylov surge and sway force is about
  ρ∇·a_fluid. In a moderate sea its **amplitude** is 15–20× the calm-water resistance at 6 kn. It
  is an oscillating force, not a mean push, but without it surfing, wave-driven surge and broaching
  cannot emerge.
- **No added mass** in any axis.
- **Payload:** already in the integrator's mass (`physics.ts:189`, `mooring.ts:171`, `:379`), and
  its point weights are statically exact. What's missing is its inertia and off-CG coupling.
  `DeckBuilder` mutates `payload` directly (`deckBuilder.ts:583`, `:636`). `mass` and `cg` are
  `readonly`.
- **Global hull state:** `hull.ts` functions are evaluated live in hot paths: rudders
  (`physics.ts:286`), foam (`foam.ts:122`, `:161`), yard height (`sailGeometry.ts:35`), plank
  (`mooring.ts:289`). A global `setShipKind()` would make any object outliving a switch compute
  against the wrong hull.
- **Trireme-specific constants, beyond hull.ts:**
  - `outrigger`/`deckHalfWidth` from `trireme.ts`, imported by deckBuilder, walker, controller and
    berthMarker. `outriggerOf` is duplicated in mooring.
  - `PAYLOAD_LIMIT = 2500` (`pieces.ts:43`).
  - `ORDERS`/`ORDER_STOP` (crew.ts, also used by hud.ts and game.ts).
  - In `rowing.ts`: `MEAN_POWER` indexed by order, `orderIndex === 5` (ramming speed), rate clamp
    18–46 spm, sweep arc `A`/`Z`, 640 J energy per slot.
  - Blade size 0.66 × 0.17 m (`oarLayout.ts:56`).
  - `QUAY.shipOffset = 6.0`, which includes the outrigger and is baked into berth centres
    (`harbour.ts:64`, `:178`).
  - In mooring: `CAPTURE`, `LINE.k`, `ANCHOR.k`, `SHOVE`, cleat/plank/anchor stations, `BOW_LOCAL`.
  - harbourRig `BOW`/`ANCHOR_LOCAL`; controller `HELM_S`; builder `S_MIN`/`S_MAX`/`PLANK_S`;
    ship solids in `game.ts:261–268`.
  - Cameras: chase `PIVOT_UP = 4`, docking view 48 m, boarding distance 42 m.
  - The ocean's `uHullDeck = 2.0` is never set; it hides water above 2 m inside the hull.
  - Foam: bow point at the ram, absolute sprite sizes, and a `bowSlam` threshold on a column sum.
  - Ground stiffness is per column, so it scales with column count.
  - Lantern position.
- **Mooring is one enum** (`free`, `warping`, `moored`, anchored). Lines and anchor can't coexist.
  The warp is kinematic-ish and the moored state holds by line springs, which is why the trireme's
  "moored ship in waves stays within 0.6 m" check fails today (`test-mooring.mjs:142`, which uses
  its own synthetic wave and no terrain).
- **Auto-anchor:** when the player leaves the ship, `game.ts` `updateMooring` (around line 460)
  stops the oars and drops the anchor below 1.2 m/s, regardless of depth.
- **Shader cache:** `customProgramCacheKey = 'aerial2' + key` (`shared.ts:140`). The sail GLSL bakes
  `SAIL_RIG` width and height under key `'sail'`, so a second rig would silently reuse the wrong
  program.
- **Kit clones share GPU resources:** `models.get()` returns `clone(true)` (`models.ts:143`), so
  geometry and materials are shared with the kit and must not be disposed with a ship.
- **Baseline:** `tsc` is clean and the rowing, sailing, walker, build and camera tests pass.
  `test:mooring` already fails one check (above).

### 2.2 Sea and wind

- **The sea is spatially homogeneous.** One Gerstner set (24 components, `waves.ts`) plus the FFT
  tiles (`oceanFFT.ts`) everywhere. Harbour, lee and open sea have the same Hs. The "sheltered"
  harbour from worldgen is cosmetic.
- **Wind has no terrain shelter.** This was explicitly deferred in `docs/sailing-spec.md`. The
  shader's cat's paws (`ocean.ts`, around line 303) are visual only.
- **Retargeting** (`waves.ts`, around line 115): JONSWAP driven by `wind.meanSpeed` (0.35 amplitude,
  600 s noise), a fixed fetch of 40 km, and cos^2s spreading on a direction fan fixed from the
  initial wind (±55–100° around NNE). Amplitudes relax with **τ = 40 s for every component**
  (`update`, around line 161). Real growth takes minutes for chop and about 4.5 h for the peak at
  12 m/s and 40 km, so there is no young steep chop on a rising wind and no lingering swell.
- **The two wave systems disagree after a veer.** The FFT re-orients instantly to `wind.from`, while
  the Gerstner fan only reweights.
- **FFT pops.** h0 rebuilds only on a 3% speed or 0.03 rad direction change, so it steps in small
  amplitude jumps.
- **Two clocks drift.** `wind.t` advances by frame dt; `ship.time` advances by sim steps, which drop
  time on hitches through the 12-step cap. The sail samples wind at `ship.time`; the waves use
  `wind.t`.
- **Time-skip doesn't advance weather or sea.** `AstroClock` runs at up to 480×, but the ship sim
  never runs faster than real time. 480× is a sky-only fast-forward.
- **No depth effects.** Swell is a fixed 0.35 m from WNW, unattenuated by islands.
- **Short waves:** CPU buoyancy sees Gerstner waves down to 11 m. The FFT band starts exactly there
  (`oceanFFT.ts:184`). The fragment shader also runs the full Gerstner loop.
- **Seabed type** is painted by the terrain shader (underwater sand, seagrass and rock, `terrain.ts`
  around lines 250–300), but the CPU classifier is crude (`walkable.ts:194`, `defaultKind`:
  y < 0.4 means sand).

## 3. Architecture

### 3.1 A design object, passed explicitly

`src/ship/design.ts` defines `ShipDesign`, pure data plus hull functions:

- **Hull:** `halfBeam`, `keelDepth`, `sheer`, `section` (with a stated contract: x(t) and y(t)
  monotone, `halfBeam` is the maximum, so the bisections in `halfWidthAt`/`bottomAt` stay valid),
  length, beam, ram, outrigger.
- **Deck surfaces,** split by purpose (this replaces the single `deckY(s)`):
  - `gunwaleY(s)`: the sheer and rail line, for rigging, cleats and rails.
  - `deckFittingY(s)`: the deck at fittings (mast partner, helm, lantern, anchor, plank).
  - `walkFloor(s, x) → y | null` and `walkHalfWidth(s, y)`: walkable surfaces including the hold
    floor and side decks, with the width taken from the hull at that height.
  - The trireme maps all three onto today's `deckY`/`deckHalfWidth`, so nothing changes for it.
- **Mass:** design-waterline mode (trireme, unchanged) or explicit light-ship parts (mass, position,
  gyradius each), plus fixed ballast, plus `payloadLimit`.
- **Hydrodynamics:** friction and form factor, a wave-resistance curve, astern factor, column heave
  damping coefficients and where they act, angular damping, lateral aspect ratio and lift slope,
  windage areas and centre, wave-force and added-mass enable flag with C_a per axis.
- **Rudders, rig and aero:** rudder geometry; the `SAIL_RIG` fields; the `SAIL_AERO` coefficients
  (each ship gets its own calibration); the crew-trim heel band.
- **Oars:** banks (geometry, blade size, arc), orders, power per order, rate limits, the ramming
  order index (or none), per-slot energy.
- **Mooring and ground tackle:** cleat, plank and anchor stations; capture window; berth offset
  (half mole + max half beam + fender standoff); hauling crew count and tackle factor; line strength;
  docked constraint period; anchors carried (count, mass, type), rode length; line and rode natural
  periods.
- **Stations, cameras and presentation:** helm, mast, lantern, crew figures, ship solids; chase pivot
  and distance, docking view and title orbit; subtitle, emblem and deck-save key.

`ShipPhysics`, `ShipModel`, `Mooring`, `RowingSystem`, `SailingSystem`, `DeckBuilder`, `Walker`,
`PlayerController`, `FoamSystem` and `BerthMarker` take the design in their constructors. Hot paths
read only their own design. `hull.ts` keeps its exports as trireme shims, so existing tests and
untouched code keep working. Berth centres become functions of the design's berth offset.

### 3.2 Visual model

`Trireme` splits into a generic `ShipModel` (hull lofting, decks, sail and yard, steering oars, oar
instancing for any banks, update/oar-wet/stow API, `sailingVisualState`) plus `TriremeDressing`
(ram, eyes, outrigger and screens, shields, ornaments, marines; a pure move) and `MerchantDressing`.
Sail dimensions move from baked GLSL constants into uniforms (or the ship kind goes into the program
key). The lantern becomes one `PointLight` owned by `Game` and positioned per design, so a swap never
changes the scene's light count. `ShipModel.dispose()` frees only what the model created (lofted
geometry, sail texture, cloned plank maps), never kit clones.

### 3.3 ShipRig and the live swap

`ShipRig` owns everything ship-dependent: `{design, ShipPhysics, ShipModel, DeckBuilder + UI root,
ship WalkGeometry, BerthMarker}`, with one `dispose()`. Long-lived consumers implement
`bindShip(rig)`: foam, oarWater, audio, the player controller (helm interactable, walker re-place),
the chase camera (snap its smoothed distance), the HUD (`setOrders(design)`, cargo readout),
HarbourRig, the dock panel, and the ocean hull uniforms (`uHullW`, `uHullLen`, `uHullDeck`).
Row-event cursors are keyed by ring identity, not by epoch.

Swap mechanics (title screen only):

1. A title button posts a swap request. A token makes the buttons inert until the swap finishes.
2. An opaque fade rises.
3. At the top of the next `frame()`, build the new rig, place it, and solve static equilibrium
   (draft and trim) directly instead of settling for 240 steps. Then `bindShip` everything, and add
   the new model and remove and dispose the old one in the same frame.
4. Render 1–2 real frames under the fade so the shadow-depth and reflection variants compile, then
   fade out.
5. Apply the design's title orbit (merchant about 26 m distance and 7 m lift, against 58 m and 13 m).

Boot constructs `Game` with the stored choice (`localStorage trieres.ship`, or `?ship=`), so a
remembered choice never triggers a swap at load. The quality and "New archipelago" links keep
`ship=`. A guard test fails if `new ShipPhysics`/`ShipModel`/`DeckBuilder` appears outside
`ShipRig`, or if a module-level constant is computed from a design.

Rejected alternative: rebuilding the whole `Game` with cached worldgen. `Game` has no dispose path
(listeners, postprocessing targets, FFT, clouds, bakes, AudioContext), it would reset visible world
state (time, gusts, cloud history, sea smoothing), and it takes 1–3 s.

Title: a segmented control (Trireme · Merchant ship) above "Set sail". The wordmark stays as the game
title. The subtitle and emblem follow the ship. `merchant_kit.glb` loads lazily on the first merchant
selection.

### 3.4 World data added by worldgen

`WorldGenResult` gains two baked maps, both computed in the worldgen worker:

- `exposure`: the wind–wave exposure map (§6.1).
- `seabed`: a seabed-type map (sand, mud, seagrass, rock) that both the terrain shader and the
  anchor read (§5.3), replacing the shader's own classification and `walkable.ts` `defaultKind`.

A missing map means "open sea, sand", so headless tests that build no world are unchanged.

## 4. Physics plan

### 4.1 Hull

The hull drives hydrostatics, resistance, lateral profile and visuals, so fitting analytically,
tuning, and swapping later would force a second tuning pass. Steffy's lines (CC BY 4.0) arrived on
2026-10-09 and are in `tools/blender/ref/kyrenia_steffy_gltf/` (with `license.txt`).

**What the file is** (inspected in headless Blender):

- A lines "cage", not a surface. Every line is its own 2 cm-thick tube object, in centimetres.
- 13 stations at 1 m spacing (x = −596…+597 cm), 6 waterlines, 8 buttocks per side, the centreline
  profile (keel, stem and post), the sheer, and two diagonals. Both sides are present.
- Datum: centre plane at y = −98.7 cm, keel bottom at z = −122.3 cm, midship station at x ≈ 0.
- Three reference planes carry scans of Steffy's original drawing (profile, body plan, half-breadth
  plan), mapped upside down. Useful for checking slices by eye.
- The high end is +x (profile top 4.14 m above the keel bottom, about 2.9 m above the start
  waterline), which matches the curling sternpost. The scans show broken ends on both posts, so the
  stem-head and sternpost-top heights are reconstruction, not wreck data.

**Pitfall checks already done** (scratch script, trapezoid integration over the stations, ends
tapered to the profile, a 10 cm keel assumed):

| Check | Lines | Reference | Result |
|---|---|---|---|
| Scale (1 unit = 1 cm) | LOA 14.27 m, beam 4.20–4.22 m, depth 2.14 m | 14.2 m, 4.24 m, about 2.1 m | all within 1% |
| Displacement 0.5 m | 0.98 t | 0.9 t | +9% (keel width guess) |
| Displacement 0.8 / 1.0 / 1.2 m | 5.24 / 10.05 / 15.92 t | 5.4 / 10.4 / 16.6 t | −3 to −4% |
| Displacement 1.4 / 1.6 m | 22.5 / 29.6 t | 23.5 / 30.9 t | −4% |

So these are the lines Rudan used, at the right scale, and they already pass the ±6% acceptance with
a crude integration. The steady −4% is likely the end taper and planking thickness; the real slicer
should close most of it.

1. **Steffy lines become the hull.** A headless Blender script reads the station curves directly (no
   triangle slicing): the tube centre gives the half-breadth at each height. The result is a table of
   offsets (stations × heights), checked in, which the design's hull functions interpolate. The
   waterlines and buttocks are a cross-check on the interpolation between stations.
2. **Remaining pitfalls to handle in the import:**
   - **Axes:** the file is in Blender's Z-up after import (glTF is Y-up), with the centre plane at
     y = −98.7 cm. Re-centre and convert to game axes in the script, not by hand.
   - **Molded surface:** Rudan's A2 has no planking thickness (about 4 cm, about 8% of displacement
     at 22 t). Match A2 on the molded surface; thicken only the visuals.
   - **Keel:** the stations stop at the rabbet. The keel exists only in the centreline profile
     (its bottom is about 23 cm below the station bottoms amidships), with no sided width. Take the
     width from Steffy's publication (the check above assumed 10 cm) and fit it against A2's 0.9 t
     at 0.5 m.
   - **Datum:** fit the keel-bottom datum (a few cm) to A2; don't trust the model's waterline. If
     scale and A2 ever conflict, trust A2.
   - **Shape contract:** x(t) and y(t) must be monotone. Smooth any tumblehome or hollows, keeping
     the deviation under 1 cm.
3. **Fallback:** the analytic fit to the published dimensions, photos and Table A2, with the keel and
   deadwood explicit. It stays as a code path even when the lines are used.
4. **Acceptance:** draft vs displacement within ±6% of Table A2 from 0.8 to 1.7 m.
5. **Reference frame:** y = 0 is the waterline at the standard start load, about 1.24 m above the
   keel bottom. Freeboard there is about 0.9 m amidships, the stem head about +2.3 m, and the
   sternpost curls to about +3 m.

### 4.2 Mass properties

- **Light ship (about 9 t),** built up from parts with stated heights:
  - hull shell at 0.6–0.7 D, about 1.3–1.5 m above the keel
  - mast and yard at about 0.5 t, high
  - crew and gear
- **Standard start load:** 6 t of fixed gravel ballast plus about 3 t of amphorae pre-placed in the
  hold as builder pieces, about 18 t in total (Kyrenia II's voyage condition). The merchant's payload
  limit is 13 t, so one cargo number comes from one source.
- **`ShipPhysics.setPayload()`** replaces direct array edits and recomputes mass, composite CG and
  inertia (parallel-axis theorem). It shifts `pos` and `prevPos` by `R·(cg_new − cg_old)` so
  rendering doesn't jump. It must not count payload twice (the integrator and mooring already add
  `payloadMass`).
- **GM and periods are outputs.** They are reported from the KG build-up, not targeted. My estimate
  is GM about 1.6–2.0 m at 18 t and roll period about 2.4–2.8 s with added inertia. Deck cargo
  measurably reduces GM: that is the stowage lesson.

### 4.3 Response to the water

This is merchant first, behind design flags. The trireme gets the same treatment in a separate,
explicit realism pass (phase 7), so baseline changes can be attributed.

- **Wave excitation** per submerged column, in the body frame, at the column centroid at depth:
  - **Horizontal:** ρV·(1 + C_a)·a_fluid (Froude–Krylov plus diffraction via added mass).
  - **Vertical:** C_a33·ρV·a_fluid,y **only**. Hydrostatic buoyancy from the instantaneous surface
    height already is the vertical Froude–Krylov force, so adding ρV·a_y again would count it twice.
  - The fluid acceleration is analytic from the cached sin/cos, with the same Gerstner q and e^(kz)
    kinematics as the flow sample, and the same exposure envelope (§6.1).
  - A Smith-effect pressure correction (attenuating hydrostatic pressure with depth in short waves)
    is an optional later refinement.
- **Added mass, implicit.** M_A is the sum of the same per-column C_a·ρV. Roll and pitch come from
  the usual lever arms; **yaw is Σ C_a·ρV·z²**, where z is the longitudinal coordinate. It goes into
  the effective mass matrix: translations divided per body axis, rotations in the body frame. An
  explicit previous-step formulation is the classic instability and is not used. Kirchhoff/Munk terms
  from the diagonal M_A use velocity relative to the water. The Munk yaw moment matters for a short,
  beamy hull's turning and directional stability.
- **Damping:**
  - Column heave damping moves into the design and acts at the waterplane centroid, so it stops
    doubling as a roll damper.
  - The roll damping ratio ζ is measured, never added as a term.
  - Merchant at rest: 0.08–0.15, quoted separately for the 10°→5° and 3°→1° cycles, since the
    quadratic term makes it amplitude-dependent.
  - Underway at 4 kn, ζ must rise (keel lift). The check is the rise; a band of about 0.12–0.25.
  - Periods are taken from the undamped natural frequency.
- **Wetted area** from the real section girth per strip. Total must match Denny–Mumford (about 42 m²
  at 18 t) within 10%.
- **Resistance:** ITTC-57 friction × (1 + k ≈ 1.2) plus a wave-resistance curve fitted so a
  constant-speed tow at 22 t matches Table A1 within ±12%. It climbs steeply toward hull speed
  (about 8.9 kn), with no clamps. Astern factor about 1.4.
- **Lateral plane:** area per section = dz × profile depth, split across strips. The design sets
  aspect ratio and lift slope (currently hard-coded in `hullLateral.ts`). There is no separate keel
  strip on top. Expect about 13 m². A static test checks that ΣAlat equals the profile area.
- **Columns:** about 22 stations × 6 strips. Grounding stiffness and the `bowSlam` threshold are
  normalised per area, so they don't scale with column count.
- **Short waves (phase 2c, decided §11):** add CPU sums of the strongest FFT cascade-A bins in the
  5–11 m annulus, so the ship feels the chop the player sees.
  - Same h0, dispersion and loop quantisation as the GPU, re-selected on retarget, and following the
    2–3 s h0 crossfade (§6.3) and the local FFT multiplier from the exposure map (§6.1). That keeps
    CPU and GPU identical, with no visual change and no GPU cost.
  - The bins feed buoyancy, the flow sample and the wave forces (§4.3 excitation).
  - Why now: with shelter and fetch, a strait or lee a few km across has a 5–11 m wind sea of
    Hs 0.3–0.5 m at 12 m/s, all in the FFT band (§6.4). Without the bins the ship sits as if on a
    pond there. That band is about the merchant's beam, so it mainly excites roll; on a 13 m
    waterline it largely cancels in heave and pitch.
  - Done before tuning (phase 5), so damping, docking and anchoring are tuned once, against the
    final sea.
  - Behind a per-design flag: on for the merchant, off for the trireme until its realism pass, so the
    trireme golden trace stays unchanged.
  - CPU budget: roughly twice the wave terms per sample. Estimated +0.5–1 ms per frame for the
    merchant, to be measured. If too costly, evaluate the bins on a subset of columns.
- **Water on deck:** deferred. Phase 1 sets `uHullDeck` per design and shows a gunwale-immersion
  warning.

### 4.4 Rig, aero and the power balance

- Sail 9.5 × 7 m (66 m²), mast about 9.5 m above the deck, stepped on the keelson at s ≈ 0.40.
  The partner is at deck level. The rig keys off `deckFittingY`/`gunwaleY`, not the hold floor.
  Yard 11 m.
- The merchant gets its own `SAIL_AERO` calibration. The current values are a gameplay calibration
  boosted for the trireme (`pressureDrag` 1.7).
- **Before any speed band is fixed,** do a power balance: sail force at a given true wind and point
  of sail, through the apparent-wind model, against the fitted resistance curve plus induced drag from
  leeway and rudder. The calm-water bands in §9 come out of that balance.
- **Voyage scenario:** the Katzev comparisons are checked in a scenario with gusts, waves and the
  crew-trim model, with wide bands.
- Crew-trim heel band 10–20°. Partial deployment (G) covers the logged "bra" brail configuration.
  Lowering the yard is later.

### 4.5 Windage

Hull and rig windage come from the design (areas and centre). At the default 12 m/s:

- **Headwind** windage is about 0.4–0.5 kN, roughly the thrust of four sweeps. She can't row
  upwind in a strong breeze, which is historically right.
- **Beam** windage is about 1.4 kN, which gives about 0.4 m/s of leeway with no way on.
- The windage centre against the lateral centre is what makes her weathervane at anchor (§5.3).

### 4.6 Steering and manoeuvring

- Quarter rudders 2 × 0.45 m², blades about 0.6 m below the waterline.
- Mast at about 0.40 L from the bow for slight weather helm.
- Targets, measured not scripted:
  - Under sail at 4 kn: tactical diameter 3–4 lengths, 90° in 20–30 s.
  - Tacking succeeds below about 8 m/s of wind and tends to stall in irons above it, so she wears.
  - Leeway close-hauled 10–15° at 2–3 kn; under 5° on a beam reach at 5 kn. These bands are used
    consistently everywhere.

### 4.7 Sweeps

- Four sweeps: one per side on the foredeck (s ≈ 0.2) and one per side on the afterdeck (s ≈ 0.78),
  worked standing. About 5.6 m long, with a design-set blade size (larger than the trireme's).
- Orders: Back water, Oars up, Slow, Half, Full (no ramming order). Power per order, rate limits,
  sweep arc and slot energy come from the design.
- Targets in calm water: Full 1.5–2.5 kn, Slow about 1 kn.
- Hold water from 2 kn: target "stopped (under 0.2 m/s) within 5 lengths". That is physically what
  four blades give. Back water stops her faster.

## 5. Docking and anchoring

### 5.1 Two state machines

Mooring becomes two orthogonal state machines instead of one enum:

- **Lines:** none → out (the crew throws, with a line arc of about 1 s) → hauling → **docked** →
  casting off → none.
- **Anchor:** stowed → letting go → holding ⇄ dragging → weighing → stowed.

Anchor and lines can coexist: anchoring off and warping in now, and Mediterranean stern-to mooring
(bow anchor plus stern lines, historically common) later. The `Mooring` event stream keeps its
shape, with new events for line states, dragging and stalls. `test-mooring` and the dock panel
strings are updated deliberately, not left to break.

Commands per state:

| State | Allowed |
|---|---|
| Lines out or hauling | Helm and sweeps (to help), sail brailed automatically on "Lines out" |
| Docked | Cast off only. Sail brailed, oars shipped, order ladder disabled, hint "Cast off: R" |
| At anchor | Sail and steering (sailing off the anchor), sweeps to help weigh |

### 5.2 Docking

- **Capture.** The HUD offers "R Moor" while the ship is inside the capture window. The window comes
  from the design. For the merchant: a line's throw of about 7 m, measured from the **hull side to
  the quay face**; heading within 25° of the quay; speed under 1 m/s; and the along-quay range scaled
  by ship length. An auto-throw setting exists, off by default; when on, it only throws below
  0.3 m/s.
- **Hauling is force-based, not kinematic.** A kinematic blend fights the wave forces, pushes the hull
  into the quay and hides the wind. The current cleat-target haul control stays, with:
  - a critically damped haul profile toward the berth pose
  - feed-forward of the measured environmental load (wind, waves) along the lines
  - a crew force cap of crew × about 350 N × tackle factor (about 3). Four crew without tackle give
    about 1.4 kN, which only equals the beam windage at 12 m/s, so the tackle factor is needed.
    Picking the lee side of the mole is the usual seamanlike answer.
  - a stall timer that reports honestly ("Wind too strong to haul in · lines holding") and stays on
    the lines
- **Docked is a PD force constraint at the CG**, acting on the horizontal position and yaw, not a
  velocity projection:
  - stiffness k = (m + A)ω² and damping c = 2(m + A)ω, with a period of 1.5–2 s. That is stable at
    120 Hz (ω·dt ≈ 0.03).
  - a soft deadband of ±0.15 m and about ±3°, so she still moves a little
  - the force is clamped at line strength. Exceeding it is an event: the lines part, or the crew eases
    them.
  - heave, roll and pitch stay physical
  - quay contacts stay on, but the berth pose sits 0.15–0.25 m off contact (fenders implied)
  - this fixes the currently failing "moored in waves within 0.6 m" check by construction
- **Line and rode stiffness** outside the docked state (lines out, hauling, anchor rode) come from a
  target natural period: k = (m + A)·(2π/T)²/n, with T ≈ 8–15 s and damping from ζ ≈ 0.3–0.5,
  using mass including added mass.
- **Cast off** is automated: raise the plank, single up the lines, shove (`SHOVE` exists), and an
  optional short automatic back-water.
- **Ratings** score approach accuracy and capture speed, since hauling makes the final contact gentle.

### 5.3 Anchoring

- **Depth** comes from terrain. Rode out = scope × depth, capped by the rode carried (merchant: 2
  anchors, about 60 m of rope).
  - Refuse to anchor if depth exceeds rode / 3.
  - **Warn** if the swing circle covers water shallower than the draft.
- **Rode model:** an elastic straight line with slack, stiffening near taut, with stiffness from a
  target period (§5.2). No catenary: a rope rode's sag is negligible.
- **Holding** is a principled estimate (there is no reliable ancient data):
  - drag embedment of about 5–10× anchor weight in sand, 2–3× in mud or seagrass; on rock the anchor
    either skips or fouls
  - a stone anchor holds by friction only (0.6 × 0.62 × W)
  - a 50–60 kg wood-and-lead merchant anchor gives about 3–6 kN in sand
  - effective holding H_eff = H·g(θ), where sin θ = depth / rode, and g falls to 0 at about 30–40° of
    uplift. This gives scope its real meaning.
- **Dragging is a creep law**, not a threshold: slip speed ∝ max(0, F/H_eff − 1) on a filtered load,
  with an alarm on sustained slip. Wave-induced rode load oscillates by about 3 kN, so a hard
  threshold would "drag" on every wave.
- **Weighing** at about 0.6 m/s, limited by crew force, so it is slower in strong wind. Breakout
  happens when the rode is short and steep. Sweeps can help.
- **Weathervaning** emerges from the windage centre (§4.5) once wave forces and the damping fix are
  in. It isn't scripted.
- **Seabed type** comes from the baked `seabed` map (§3.4). Seagrass (Posidonia) gives poor holding,
  which is historically right and makes choosing an anchorage matter.
- **Auto-anchor when the player leaves the ship** can now be refused in deep water. The fallback is
  the crew holding position with sweeps, or heaving to.

### 5.4 HUD and audio

- HUD: depth, rode out and scope, holding or dragging, line loads, and the haul-stall reason.
- Audio: rode running out, dragging, and line creak under haul.

## 6. Wind and waves

The sea today is the same everywhere (§2.2). The goal is a sea that reflects shelter, fetch and depth,
so a harbour is calm, a lee is flatter, and open water is rough, with the ship floating on what the
player sees.

### 6.1 W1: exposure map (phase 2b)

Baked in the worldgen worker:

- About 16 wind directions on a coarse grid (about 128², about 94 m cells).
- Per direction and cell:
  - an **effective fetch**: cos-weighted over ±45° around the upwind direction (SPM method), not a
    single ray, capped at the open-sea 40 km
  - a **wind-shelter factor** from upwind terrain, with a wake of about 10–20 hill heights
- At runtime, interpolate at the current wind bearing to get a local wind speed and fetch. These
  drive:
  - multipliers for **four bands** (swell, long, mid, short), packed in one RGBA texel. A short fetch
    moves the spectral peak to shorter waves, which per-band multipliers capture. Each component's
    band index is packed into `packedB` so CPU and GPU agree.
  - the FFT scale, the whitecap threshold and swell exposure
  - the sail wind, through `wind.sampleAt`. Shelter changes sail forces near islands in live play
    only.
- **Validity rule: the envelope e is at most 1 everywhere.** Global amplitudes are defined at the
  most exposed condition (open sea at the capped 40 km fetch), so open water is unchanged and shelter
  only attenuates. Then:
  - the global steepness budget holds locally, and the inverse `heightAt` keeps contracting
  - envelope gradient terms are 0.6–6% and are dropped
  - e is sampled at the **undisplaced** point inside every CPU iteration, matching the shader
  - global wave phases are kept; only the amplitude envelope varies
  - if e > 1 is ever allowed (shoaling), a local q = min(q, 0.75/Σ k·A·e) is computed identically on
    CPU and GPU
- **CPU and GPU sample identically:** same bytes, manual bilinear filtering (texelFetch) on both
  sides. Cost is negligible: one fetch per vertex and fragment, and about 1.8e5 samples/s on the CPU.
- **Swell in the lee:** an exposure factor with a floor of 0.2–0.3 (diffraction), blurred over
  500–800 m (diffraction spreads over about √(λd)).
- **Harbour basin:** a 94 m grid can't resolve the 6 m mole, so the lee of the mole gets an
  **explicit attenuation** derived from the pier frame, like the dredge mask. Without it the berths
  would see open-roadstead swell.
- **Gusts in the lee:** shelter lowers the mean wind but raises gust amplitude near the lee foot of
  high islands (meltemi downslope gusts).

### 6.2 W2: depth (with W1)

- Attenuation by k·h from terrain depth, for the physics envelope, driven by depth blurred over at
  least 300 m. Near beaches depth changes over tens of metres, which the envelope can't follow.
- Shoreline steepening, shoaling and surf foam are visual-only effects.

### 6.3 Pulled forward: clocks and FFT smoothing (with W1)

- **One clock.** Wind and waves advance on simulation time, the same clock the ship uses. This stops
  `wind.t` and `ship.time` drifting apart.
- **FFT crossfade.** h0 is double-buffered and crossfaded over 2–3 s on a rebuild, so the FFT stops
  popping.

### 6.4 W3: growth and decay (later)

- Per-component relaxation with a period-dependent τ, growth faster than decay, on simulation time.
  Young steep chop on a rising wind; swell that lingers after it drops.
- **Gerstner only.** The FFT keeps tracking the local wind, since it equilibrates within minutes.
- Consequence: in a sheltered bay (fetch about 0.5 km, 12 m/s) the local wind sea is Hs about
  0.14 m, λ about 3 m. That is entirely in the FFT band, so it is **invisible to buoyancy**: the ship
  floats on swell only while the player sees chop. The short-wave bins (phase 2c, §4.3) fix this.
- The fixed direction fan can't follow a new wind direction. Before any southerly or sirocco weather,
  build a 360° fan (or a second fan). W3 then gives real cross-seas after a wind shift.

### 6.5 W4: weather on the game clock (later)

- Slow weather (mean wind, direction, episodes over days) runs on a weather clock that time-skip can
  advance. Gusts stay on simulation time.
- Streaming the sea at 480× would break the frozen-amplitude assumption in `sampleFlowAt` and make
  the sea visibly breathe. So (decided, §11): **time-skip only when docked or anchored.** Jump to the target time by computing the weather and sea state analytically (W3's
  relaxation has a closed form), crossfade over 2–3 s, and treat the T key's dawn and noon jumps the
  same way.
- On boot, spin the sea up from recent wind history.
- **Meltemi (deferred, decided §11):** a daily cycle (light at dawn, strongest mid-afternoon, easing
  at night) and multi-day spells with calmer days between. It gives the trade game a "when to sail"
  decision and sets up seasons. It needs the weather clock above; it blows from a steady northerly
  direction, so it doesn't need the 360° fan.

### 6.6 Presentation

- HUD sea-state readout: Beaufort, Hs, and "sheltered" or "exposed".
- Sheltered water shaded on the chart and minimap.
- Audio (wave slap, wind, rigging) follows local exposure, so the harbour sounds quiet.
- Wind against swell is low value without currents and is not planned.

## 7. Visuals

The trireme's rule still applies: what you see is what floats. The hull shell, decks, side decks,
hold, wales, rails, stem and sternpost are lofted procedurally from the design. Layout follows the
Kyrenia museum models:

- foredeck s 0.05–0.28 with the cuddy beneath it
- afterdeck s 0.74–0.95 with the helm and the plank station
- open hold s 0.30–0.72, floor about 0.4 m above the keel over the ballast, with 0.35 m side decks
  along the gunwale
- open stanchion rails, wale, painted bow eye, a tall stem, and a sternpost curving up and aft

The playable ship is procedural first. Blender comes afterwards as polish
(`tools/blender/merchant.py` → `merchant_kit.glb`):

- quarter rudders with tillers and their crossbeam
- cuddy front, ladders, stanchions, thole pins
- gravel sacks and stone ballast, a water pithos, brail-ring rows, a sternpost finial
- two anchors with stocks, and coiled rode

Crew uses the existing idle and carry figures. The line throw is a short arc animation. New hauling
and sweep poses are optional polish.

External models are not used as the in-game ship. The free full Kyrenia model (iMARECULTURE) is
CC BY-NC-ND. The good paid models are visual only and would not match the physics hull. Steffy's
CC-BY lines are only a shape source.

## 8. Gameplay integration

- **Walking and building:** `walkFloor(s, x)` gives the foredeck, afterdeck, side decks and the hold
  floor with true width at each height. Ladders between levels are walkable ship solids (the step is
  about 1.1 m; the walker steps 0.45 m). The builder ray-marches the same surfaces and uses a
  per-ship save key and payload limit. Cargo in the hold lowers CG; cargo on deck raises it.
- **Helm and cameras:** afterdeck s ≈ 0.86. Chase pivot, distance, docking view, boarding distance
  and title orbit come from the design.
- **HUD and help:** the order ladder comes from the design. The full HUD adds draft, freeboard and
  cargo (from the builder), a gunwale warning, the mooring readouts (§5.4) and the sea state (§6.6).
  Key hints and help text describe sweeps.
- **Audio:** no keleustes drum on the merchant. Creak and slap scale with the hull. Sweep splashes use
  the existing events.
- **Foam:** bow point, sprite sizes and Kelvin offsets come from the design. Check the bow wave of a
  full bow at 4–6 kn.
- **Voyage save** (decided, §11): docking saves the voyage. A small first version stores the ship
  kind, the berth, the cargo and deck layout, the game time and the weather state, in localStorage
  under a versioned key. Loading puts her back in the docked state at that berth. Saving at anchor or
  at sea is later.

## 9. Validation (`scripts/test-merchant.mjs` plus browser review)

1. **Hydrostatics:** Table A2 within ±6% (0.8–1.7 m). Equilibrium draft at 9, 18 and 22 t.
2. **Stability:** report GM, KM, BM and GZ at 5° and 10° for the stated KG build-up. Report only;
   no external target.
3. **Resistance:** tow at 22 t against Table A1 (±12%). Wetted area against Denny–Mumford (±10%).
   Lateral area against the profile.
4. **Seakeeping:**
   - release tests for roll, heave and pitch, giving undamped periods and amplitude-banded ζ at rest
     and at 4 kn
   - wave-force sanity: in a regular beam wave with λ ≫ B, the hull **oscillates** with the orbital
     motion (sway amplitude ratio about 1) with no net drift
   - a finite-state stress test at Hs 2 m with grounding and quay contact
5. **Power balance** table, then calm-water speed bands derived from it, with heel and leeway.
6. **Voyage scenario** with gusts and seas against the Katzev comparisons (wide bands), plus a heavy
   weather run with fetch and swell overridden to reach Hs 3–4 m. Peaks of at least 9 kn on a
   quartering run with half sail, no capsize.
7. **Sweeps and hold water** targets (§4.7).
8. **Manoeuvring** (§4.6).
9. **Docking:**
   - haul convergence from 8 wind directions at 12 m/s, with an honest stall when overpowered
   - docked excursion at Hs 1–2 m with wave forces on, within the deadband plus a small margin
   - cast-off clears the quay without contact
10. **Anchoring:**
    - no dragging at 5:1 scope in sand at the default wind
    - dragging onset vs scope in 12 m/s wind
    - weighing time, and that it grows with wind
    - anchor and lines coexisting
    - refusal in deep water, and the swing-circle warning
11. **Wind and waves:**
    - e ≤ 1 everywhere in the baked map; open sea gives exactly 1
    - CPU and GPU envelope agree at sample points (same bytes, same bilinear)
    - inverse `heightAt` converges with the envelope on
    - berth Hs well below open-sea Hs (harbour basin term)
    - no exposure map gives envelope 1, so the existing headless tests are unchanged
    - one clock: wind time equals ship time after forced frame hitches
    - FFT rebuild produces no step in rendered height
    - short-wave bins: CPU height matches the GPU's FFT bins at sample points, through a crossfade
    - in a lee with about 5 km of fetch, the merchant's roll responds to the local chop; with the
      flag off, the trireme golden trace is unchanged
12. **Trireme invariance:**
    - a golden-trace test (exact position and orientation after N steps in several scenarios)
      before and after the design threading
    - all existing tests green, except mooring checks deliberately rewritten for the new state
      machines (§5.1)
    - trireme checks re-run after constructing a merchant in the same process
13. **Swap:**
    - toggling back and forth leaves state finite and leaks nothing (`renderer.info.memory`, scene
      children)
    - no global recompile during the swap
    - the source-scan guard test passes

Browser checks:

- `?ship=merchant` with the sailing and rowing review scenes
- the title swap in both directions
- walking into the hold and placing cargo there
- a docking run and an anchoring run in default wind
- the harbour visibly calmer than the open sea, with the ship moving accordingly
- frame time on medium quality

## 10. Order of work

| Phase | Work |
|---|---|
| 0 | Hull from the Steffy lines (offsets table from a headless Blender script; analytic fit kept as fallback). Hydrostatics test against Table A2 (±6%, 0.8–1.7 m) |
| 1 | `ShipDesign` threaded through constructors (no global `setShipKind`). Trireme identical, proven by a golden-trace test |
| 2 | **Done 2026-10-10** (see handoff.md: excitation, added mass, planar Munk, damping restructure; setPayload CG shift and girth wetted area deferred). Physics, headless, merchant flags only: mass properties via `setPayload`, girth wetted area, lateral profile, damping restructure, wave forces with implicit added mass and Munk terms, per-design aero and windage, line and rode stiffness from target periods |
| 2b | Wind–wave exposure map (W1) with 4 bands, effective fetch, the blurred depth term (W2) and the harbour-basin attenuation; the seabed map; clock unification; the FFT h0 crossfade. All before docking and anchoring tuning |
| 2c | Short-wave CPU bins (FFT, 5–11 m), merchant flag only: CPU/GPU agreement tests, CPU cost measured |
| 3 | Procedural merchant hull, decks and open hold (`walkFloor(s, x)`, `gunwaleY`, `deckFittingY`) |
| 4 | Gameplay: stations, HUD, the docking and anchor state machines, voyage save on docking, cameras, `ShipRig` and `bindShip`, title selector and live swap. The swap can be built earlier against two trireme variants |
| 5 | Tuning against the power balance, the voyage scenario, and the manoeuvring, docking and anchoring tests |
| 6 | Blender kit and figures (polish) |
| 7 | Trireme realism pass: the same wave-force, added-mass and damping fixes, with re-recorded rowing and sailing baselines |
| later | Water in the hold, yard lowering, kedging, stern-to mooring, weather growth and clock (W3/W4), meltemi daily cycle and spells, 360° wave fan, cargo manifest and trade |

Getting a playable procedural merchant before any Blender work is the main way to reduce risk.

## 11. Decisions made (2026-10-09)

1. **Open hold**, with cargo stowed low amidships and side decks.
2. **Steffy hull lines:** downloaded and checked (§4.1). They are the hull; the analytic fit stays
   as a fallback.
3. **Docking:** row or sail close, then the crew pulls her in with lines, partly automated with a
   short pull-in animation. **Docked is a discrete state.** The anchor gets a proper model too (§5).
4. **Trireme realism pass:** yes, as phase 7, after the merchant. It also turns on the short-wave
   bins for the trireme.
5. **Voyage save:** docked is a save point (§8).
6. **Time-skip** (`[`, `]` and T) only while docked or anchored (§6.5).
7. **Meltemi daily cycle:** deferred, but kept as a planned item after the weather clock (§6.5).
8. **Short-wave buoyancy** moves up to phase 2c, before tuning (§4.3).

## 12. Open questions

None at the moment. The plan waits for "go".

## 13. Review log

An independent reviewer (Opus 5.5) checked the plan against the code in four rounds and ran scratch
probes on a copy of the physics.

Rounds 1–2 (rev. 1 → rev. 2):

- Payload was already in the integrator's mass, so the plan would have double-counted it.
- GM and roll period targets contradicted the cited source. Table A3 has no stated KG, so it was
  dropped as an acceptance test.
- The girth factor would have overstated friction by about 60%.
- The lateral plane can't be produced by a lift factor alone.
- Speed bands confused voyage averages with calm-water steady states. A power balance now comes
  first, with a separate aero calibration.
- There are no horizontal wave forces, so surfing couldn't emerge. Wave forces are added.
- The added-mass plan was unstable and inconsistent. It is now implicit, with matching excitation
  and Munk terms.
- The trireme's roll is overdamped (ζ ≈ 0.5) by the column heave damper. It is measured and
  restructured.
- The open hold breaks every `deckY` consumer, so deck surfaces are split by purpose.
- Sweeps had been placed over the hold. They are moved to the decks.
- A global `setShipKind` was unsafe; a design object is passed explicitly.
- Live-swap hazards: light count, shared kit disposal, program-cache keys, async lifecycle. These led
  to the `ShipRig`.
- The short-wave band was moved behind measurement, with a CPU-only FFT-bin method.
- Many missed trireme constants were added (§2.1).

Round 3 (physics corrections, docking and anchor):

- Yaw added inertia uses the longitudinal coordinate (z²), not x².
- Vertical wave excitation is the added-mass part only; hydrostatics already supplies the vertical
  Froude–Krylov force.
- Headwind and beam windage quantified; the beam case explains why ships were warped in.
- The wave-force sanity test was wrong: a small hull oscillates with the orbit, it doesn't drift.
- The "15–20×" figure is an oscillating amplitude, not a mean push.
- Docking redesigned: two state machines, force-based hauling with a crew force cap and an honest
  stall, docked as a PD constraint, which fixes the failing moored-in-waves check by construction.
- Anchoring designed: scope-dependent holding, a creep law for dragging, a seabed map, weighing
  limited by crew force, deep-water refusal for the auto-anchor.
- Steffy-lines import pitfalls listed.

Round 4 (wind and waves):

- Found in code: the FFT and Gerstner systems disagree after a veer, the FFT pops on rebuild, and
  the wind and ship clocks drift. Clock unification and an FFT crossfade are pulled forward.
- The amplitude envelope is valid if e ≤ 1 everywhere, with open sea defined as the maximum.
- Swell in the lee gets a diffraction floor; the harbour needs an explicit basin term because the
  exposure grid can't resolve the mole.
- Four bands in one texel, an effective (SPM) fetch, and identical CPU/GPU sampling.
- Growth and decay on Gerstner only; this exposes that sheltered chop is invisible to buoyancy,
  which led to moving the short-wave bins up to phase 2c.
- Time-skip only while docked or anchored, with an analytic jump.
- Added: a 360° wave fan before southerly weather, gusty lees, sea-state readouts on the HUD and
  chart, exposure-aware audio.

## Sources

- Katzev, M. L. (1987), *An analysis of the experimental voyages of Kyrenia II* —
  https://www.ancientportsantiques.com/wp-content/uploads/Documents/ETUDESarchivees/Navires/Kyrenia/Kyrenia2-Katzev1987.pdf
- Rudan, S. et al. (2024), *The Effect of Changing the Beam of an Ancient Ship's Hull on Its Capacity,
  Stability, and Performance*, Heritage 7(12) — https://doi.org/10.3390/heritage7120310
- "Kyrenia Ship Hull Lines by J. Richard Steffy" by Digital in situ Preservation Archive, CC BY 4.0
  (credit required in the README and in-game credits) —
  https://sketchfab.com/3d-models/kyrenia-ship-hull-lines-by-j-richard-steffy-407996fccafb4aacbec59c4a60f1c749
- The Kyrenia Ship — https://en.wikipedia.org/wiki/The_Kyrenia_Ship
- Windward sailing in antiquity — https://www.tandfonline.com/doi/full/10.1080/10572414.2023.2186688
- Reference photos: "Kyrenia Olkas, 4th century BC (model)" and "Kyrenia Schiffswrackmuseum –
  Rekonstruktion Modell", Wikimedia Commons
