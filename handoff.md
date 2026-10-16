# Production harbor integration — 2026-10-13

The toolkit is now integrated by default in the actual game, at starting port id 0 (Serrothos on seed 1729). `src/world/ormosLayout.ts` defines its local frame and a graded working court; the world generator reserves its footprint and grades it before AO / wave-shelter baking. `src/world/ormosHarbour.ts` loads the staged kit, batches stonework and fixtures, supplies building collision, and uses grove LODs with proper local origins. `Props` retains native art at the other ports and adds six restrained lamps and the actual trade figure at the authored market. The starting mole keeps its original width, berth positions, docking physics and stair geometry. Its physical shore landing now also supplies a ship collider.

The playable Kyrenia merchant installs `merchant-shell`, quiet linen and the rigid 3.1 m, 0.7 m gangplank. Its original dimensions, moving rig, crew, cargo, and walking systems remain authoritative. An existing missing crew material slot was fixed to preserve the Blender vertex colors. Interior gables were rebuilt as real wall volumes; the warehouse is walkable, while the houses retain closed door returns. Editable master Blender files and packed assets were refreshed.

Build / verify: `npm run assets:ormos`, `npm run typecheck`, `npm run test:ormos`, `npm run build`. Existing ports, hold, mooring and walker regressions pass. Detailed evidence and limitations are in `docs/environment-review/ormos-production/README.md`. Production preview: `http://127.0.0.1:5190/?ship=merchant&q=high&dev&ormosReview=overview&wind=3`. The dev review fixture leaves saved voyages untouched. It exposes real walking / helm controls and fixed views, rather than replacing the game simulation. Browser acceptance includes the live trade ledger, entering the loading hall, walking ship to quay and back, and inspection of nine compositions plus lighting variants. Normal game URL needs no review flag to load the assets.

Earlier entries below are historical and describe work before production integration.

---

# Latest pass: clarified landscape and compatible merchant

The user's latest instruction requires the boat to retain the proportions and function of the existing game boat, with the restrained toolkit style. The user-confirmed target is the Kyrenia merchant (13.7787 m hull, 4.216 m beam), not the separate 17 m scenic boat. See `harbor-kit/MERCHANT.md` from the repository root. A new Blender `merchant-shell` and `createMerchant(kit)` adapter are implemented. Default game appearance is unchanged; game physics definitions are untouched. The game model now exposes reversible static-shell and sail-surface hooks, and sail shadows follow the visible deformation. Geometry compatibility, typechecks, builds and the cargo/hold regression suite pass. Full game navigation/boarding acceptance remains outstanding.

The study landscape now uses 182 kit placements in 55 spatial batches. Repeated giant rocks were replaced by subordinate outcrop groups, continuous terrain shoulders and a quiet upper orchard path. Olive crowns are fuller. Water no longer exposes the underwater terrain patch as a bright triangle. The scenic gangplank preserves its upward direction and rigid length when reversed. The current study bundle is about 46.5 MB of referenced models and textures.

The 21-view desktop lighting audit is under `harbor-study/evidence/acceptance/`; late-light fill and canopy folds were subsequently refined. A 390 by 844 desktop viewport check found no horizontal page overflow and settings fit; this is not physical-phone performance evidence. Mobile hides the keyboard-only walk control and uses touch navigation hints. Walk geometry tests pass. Broad goal remains active until remaining visual and interaction acceptance is reconciled with the new merchant requirement.

Older entries below describe earlier states; their instance counts and statements of no game-source changes are historical.

---

# Current direction — clarified minimalism

The user explicitly likes the minimalism and wants less mess at close range, while retaining good textures. Read `harbor-kit/VISUAL-LANGUAGE.md` before further art edits. That pass is implemented and browser checked across all 29 kit assets: quieter material variation, consistent stone edges, properly separated roof overlaps, and correctly fitted inspection shadows. The kit remains the reusable deliverable.

The standalone harbor now actually reuses the toolkit's boat, gangplank and 423 landscape placements in spatial LOD batches. It shares the reviewed primitives/palette and compressed texture bundle. Read the newest section of `harbor-study/HANDOFF.md` for exact build order and current evidence. The broader production goal remains active; terrain composition and full interaction/performance acceptance are still incomplete. Do not substitute extra grime or random geometry for the clarified style.

---

# Latest handoff: reusable harbor asset toolkit — 2026-10-13

The user clarified that this work is **a reusable toolkit for agents to integrate into Boatsim**, not merely a finished study. They then explicitly requested an asset-by-asset visual audit, improvements, and rechecking. That pass is now implemented in **`harbor-kit/`**. Read [`harbor-kit/README.md`](harbor-kit/README.md), [`harbor-kit/INTEGRATION.md`](harbor-kit/INTEGRATION.md), and [`harbor-kit/ACCEPTANCE.md`](harbor-kit/ACCEPTANCE.md) first. The earlier study below is historical context.

The kit contains 29 assets, 13 shared materials, 40 compressed GLBs, a machine-readable manifest, editable Blender sources and a PBR-preserving Three.js adapter with cloning/instancing/LOD/snap helpers. The subsequent visual pass improved trees, shrubs, pottery, baskets, rocks, roof/building details, bench and mooring stone. The user likes the scenic boat; preserve its silhouette. It is separately authored and is not the game's playable merchant.

All 29 assets and seven distant variants were checked live from the production build; console clean. Offline validation, strict typecheck and build pass. Production inspector: `http://127.0.0.1:5188/`; development inspector: `http://127.0.0.1:5187/`. Visual review and evidence live in the kit. No game integration has occurred. Read the acceptance boundaries before claiming production/game readiness. Changes remain uncommitted.

---

# Latest handoff: standalone harbor study — 2026-10-13

**Continuation:** the harbor and separate scenic boat now have a substantial Blender detail pass, corrected runtime sky lighting, and a seventh Boat inspection camera. The user likes this boat and explicitly asked to refine it; preserve that direction. Live browser inspection succeeded after selecting the existing tab. Final build passes and final boat view has no console errors/warnings. See the newest section of `harbor-study/HANDOFF.md` for exact changes, screenshots, asset sizes and remaining limitations. This is still an isolated study, not game integration or final production acceptance.

The current environment-art task is isolated in **`harbor-study/`**. Read **[`harbor-study/HANDOFF.md`](harbor-study/HANDOFF.md)** before continuing. It records the user brief, Blender source, preview/build commands, browser authorization, verified behavior, visual shortcomings and next steps.

The user approved implementation of the shoreline/berth/warehouse/buildings/material proposal as a standalone HTML scene, **before integration into the game**. They explicitly authorized browser testing of this standalone study. They then asked to wrap up because they had to leave and requested both this update and the dedicated handoff.

Preview: `http://127.0.0.1:5186/`. Editable master: `harbor-study/blender/ormos-harbor.blend`. Production bundle: `harbor-study/dist/` (rebuildable, ignored). Build passes and scene renders; **the visual production-quality bar is not yet met**. The scene remains too pale/flat, and visual refinement plus systematic interaction checks are pending. Do not treat a passing build or the current screenshot as acceptance.

No existing game source or production assets were changed. Changes are uncommitted. The older material below is historical and its planning-only instructions do not supersede the user's authorization for this standalone harbor study.

---

# Handoff: merchant ship and sea realism (planning phase)

Last updated: 2026-10-09. Branch: `next-level`, with many uncommitted changes from earlier work (see
git status). Nothing in this handoff has been committed.

## Where we are

**Planning only. The user explicitly said "no code yet".** Do not implement anything until the
user says to start. The work so far is research plus a plan reviewed in several rounds by an
independent reviewer agent (Opus 5.5).

- The main plan is **`docs/merchant-ship-plan.md` (rev. 3)**. Rounds 3 and 4 below are now merged
  into it, so the plan file is the source of truth; §3–§5 here are kept as history.
- **Steffy lines arrived** (2026-10-09) and are in `tools/blender/ref/kyrenia_steffy_gltf/`
  (with `license.txt`; the duplicate GLB was deleted). Inspected and checked against Rudan A2: scale within 1%,
  displacement −3 to −4% at 0.8–1.6 m with a crude integration. Details in plan §4.1.
- No other repo files were changed. Everything else in `git status` predates this work.
- The reviewer agent was `ac2d0903079aae32c`. It may not survive into a new session. If it can't be
  resumed with SendMessage, spawn a fresh Opus reviewer, point it at the plan and this file, and
  continue the dialogue. The user wants review done as a real back-and-forth (author replies, argues,
  asks follow-ups).

## Milestone 1: drivable merchant (done 2026-10-09, uncommitted)

Built by Haiku subagents from exact specs, reviewed and integrated by Opus. Play it with `?ship=merchant`
or the ship selector on the title screen (it reloads the page; the live swap is still phase 4).

- **Hull:** `tools/blender/merchant_offsets.py` turns Steffy's lines into `src/ship/merchantOffsets.ts`
  (generated; rerun the script, don't edit). `TableHull` (`src/ship/tableHull.ts`) interpolates it.
  Rudan's drafts sit 4 cm above Steffy's keel bottom (false keel), so the design waterline is 1.285 m
  above the keel bottom and 18 t floats at y = 0. Columns are cosine-spaced with mean bottoms.
  `npm run test:merchant`: A2 within 1-3%, 22 t at 1.364 m, LWL/BWL within 2-3%.
- **Design object:** `src/ship/design.ts` (`TRIREME`, `MERCHANT`) threaded through physics, rowing,
  sailing, mooring, walker, controller, chase camera, foam, oar water, HUD, audio, builder, harbour rig.
  `npm run test:golden` proves the trireme is bit-for-bit unchanged.
- **Merchant physics:** resistance ITTC x 1.82 + wave term (Table A1 within 2%), wetted factor 1.256,
  lateral plane from the hull profile (merchant only), mast at s 0.44, roll zeta about 0.16, sweeps
  about 1.9 kn at Full after a few minutes, level trim (cgZ over the LCB).
- **Visual:** `src/ship/merchantModel.ts` (flush working deck for now; the open hold is phase 3).
- **Anchor (both ships):** animated drop to the seabed, haul in (pulls her up to it), breakout, lift,
  stow; refused deeper than the 14 m rode. HUD anchor badge next to the speed readout.
- **Off on the merchant for now:** deck building.

## Docking system (done 2026-10-09, uncommitted)

Plan §5.1–5.2, built for both ships. `src/ship/mooring.ts` now has two independent state machines:
`linePhase` (none → out → hauling → docked → casting) and `anchorPhase`; the old `state` enum is
gone, so the anchor can stay down while she warps in. Per-ship data is `ShipDesign.docking` (cleats,
plank, fender gap, capture window, crew × tackle, line strength, hold period); each ship docks off the
quay face by her own beam (`Berth.face`, `Mooring.berthPose`).
- Hauling: cleat servo + feed-forward of the filtered environmental load (`ShipPhysics.pendingForce`),
  capped at crew × 350 N × tackle; stall after 4 s at the cap without closing ("Wind too strong to
  haul in · lines holding"), lines then hold up to their strength; resumes when the load eases.
- Docked: critically damped PD hold at the CG (position + yaw, soft deadband 0.15 m / 3°, period
  1.75 s, uses her mass since the sim has no added mass), clamped at line strength; a filtered
  overload for 2 s eases the lines (back to hauling). Sail brailed, oars shipped, W/S and F refused.
- Cast off (user choice: shove only, no back-water): plank up (2 s), let go, shove. R while hauling
  lets go at once. Oars stay live while hauling and at anchor (user choice).
- Weighing while on the lines drags the anchor home instead of hanging forever.
- The dock panel plan view and the berth marker ghost now use the ship's own outline.
- The old "moored in waves within 0.6 m" failure is fixed (worst drift 0.30 m).
- Not done: voyage save on docking, anchor holding/dragging/seabed, auto-throw, tuning after W1.

Known issues and next steps:
- Sail aero still uses the trireme's boosted calibration: about 7.6 kn beam reach and 8.3 kn
  broad reach in 11 m/s, a bit high for calm water. Phase 5 power balance.
- Moderate lee helm close-hauled (about half helm). Phase 2 lateral plane and phase 5 tuning.
- No wave forces or added mass yet (phase 2). Roll period 2.3 s without added inertia.
- The pre-existing mooring failure ("moored in waves within 0.6 m") is unchanged.
- berthMarker and deckBuilder still use trireme geometry (inactive on the merchant).

## Phase 2 water response (done 2026-10-10, uncommitted)

Behind `design.hydro.response` (merchant only; the trireme's golden trace is bit-identical).
- **Wave excitation** per submerged column: horizontal Froude–Krylov ρV·a plus diffraction C_a·ρV·a along
  each hull axis; vertical C_a33·ρV·a_y only. Fluid acceleration from `WaveField.accelAtDepth`.
- **Implicit added mass**: per-column C_a [sway 0.7, heave 1.0, surge 0.06] of ρV, summed each step; added
  inertia from the lever arms. The integrator divides force per hull axis by its effective mass and uses
  I + I_A + payload inertia (rowers' hands etc.). Measured: sway 0.72, heave 1.03, surge 0.06 of her mass;
  added inertia pitch +56%, yaw +42%, roll +31%.
- **Kirchhoff/Munk** terms in the horizontal plane only (surge, sway, yaw), with velocity relative to
  the water. Full 3D terms left a spurious mean heel in waves.
- **Damping restructure**: column heave damping acts on the centre line (no roll moment); roll damping
  retuned to rollDampLin 12000 / quad 8000.
- **Docked hold** uses the effective mass per hull axis and the effective yaw inertia.
- `npm run test:seakeeping` (writes `docs/merchant-hull/seakeeping.json`): roll period 2.6 s (was 2.2),
  ζ 0.14 (10→5°) and 0.10 (3→1°), heave 2.1 s, pitch 2.3 s, beam-wave sway ratio 1.01 with no drift,
  stress run at 17 m/s finite. The plan's underway band (ζ 0.12–0.25 at 4 kn) is not physical for this
  hull (lift damping adds only about +0.01 at Fn 0.18); the test checks that ζ does not fall.
- Rowing at Full: 1 kn in 27.9 s (was 25.1), 1.76 kn at 60 s (was 1.82). Turning under oars at 2.3 kn
  with full helm: 85° in 60 s (was 81°); the Munk moment outweighs the added yaw inertia.
- Deferred from phase 2: `setPayload` with a composite-CG shift (only matters once cargo moves; payload
  inertia is in), girth-based wetted-area distribution (the total already matches), merchant sail aero
  (phase 5).

## Sea state (built 2026-10-10, uncommitted)

`docs/sea-state-spec.md` (§14 has the implementation notes and measurements). Wave size now varies by
place: fetch, wind shelter and swell exposure are baked per direction in the worldgen worker (world grid
94 m, harbour grid 4 m including the mole); the main thread composes an envelope for the current wind,
which the CPU waves, the ocean shader (exact parity, 5e-6) and the sail's wind all read. Wind and sea now
advance on simulation time. The FFT outputs were repacked to stay inside the ocean's 16 texture units.
Dev: `?debug=seastate` (blue calm, red exposed), `?windFrom=<deg>`. User decisions: calmer archipelago
accepted, no chart shading, shoreline visuals later.
## 1. What the user asked for (in order)

1. "Turn this app into a surprisingly deep antiquity trade simulator." This is the long-term
   direction. Today: ship simulation is deep; trade is nonexistent (one harbour, no goods, prices,
   money, saving or calendar).
2. Add a **merchant ship** as a second playable ship, chosen on the title screen. The scene behind
   the title must switch to the chosen ship.
3. Integrate it **fully**: physics, sailing, rowing, docking, walking, deck building. It must be as
   nice to play as the trireme, with realistic speeds and realistic response to the water.
4. Use Blender (installed at `/Applications/Blender.app`) and look online for good period models.
   Use the in-app browser if needed.
5. Have a reviewer subagent check the plan as a dialogue. The user wants to know whether it helped.
   My answer so far: yes, substantially; it caught real physics errors and design hazards.
6. "Can we address how wind affects the waves?" This is now part of the plan (§5 here).

## 2. User decisions (answered 2026-10-09)

1. **Open hold**, with cargo stowed low amidships.
2. **Steffy hull lines:** the user is willing to download them now. My answer to "is it necessary for
   now?": not required to start, but worth doing now, because the hull drives hydrostatics,
   resistance, lateral profile and visuals; fitting analytically, tuning, and swapping later would
   force a second tuning pass. **Give the user download instructions** when they're back:
   - Sketchfab model `kyrenia-ship-hull-lines-by-j-richard-steffy-407996fccafb4aacbec59c4a60f1c749`,
     CC BY 4.0, 60.5k triangles, needs a Sketchfab login (the user downloads it; we can't log in).
   - glTF format (or the original Rhino format if offered), saved to `tools/blender/ref/`.
   - Credit the author and the uploader (Digital in situ Preservation Archive) in the README and
     in-game credits.
3. **Docking:** row or sail close, then the crew pulls her in with lines. The user wants it
   "somewhat automated by the crew, with a slight animation/pull-in when one is close enough", and
   **'docked' must be a discrete state**. **The anchor needs work too.**
4. **Yes to the trireme realism pass.** The same wave-force, added-mass and damping fixes for the
   trireme, as a separate step after the merchant, with re-recorded rowing and sailing baselines.

Still to ask the user:

- Should "docked" be a save point (voyage save)? There is no voyage save today, only the deck layout
  and settings in localStorage.
- Is the optional meltemi daily wind cycle (W4 in §5) in scope now?
- Is it OK to allow time-skip ([ ] and T) only while docked or anchored? (Reviewer recommendation,
  §5 Q5.)
- Should the CPU FFT-bin buoyancy (phase 7) move earlier, so a ship in a sheltered bay feels the chop
  the player sees? (§5 Q4.)

## 3. Review round 3 (accepted, not yet in the plan file)

### Corrections to rev. 2

1. §4.3: yaw added inertia is Σ C_a·ρV·**z²** (z is longitudinal), not x².
2. §4.3: **vertical wave excitation is C_a33·ρV·a_fluid,y only.** Hydrostatic buoyancy from the
   surface height already is the vertical Froude–Krylov force. Horizontal stays ρV·(1 + C_a)·a_fluid.
3. §4.7: **headwind** windage of about 0.4–0.5 kN roughly equals four sweeps' thrust (can't row
   upwind); **beam** windage of about 1.4 kN gives about 0.4 m/s of leeway.
4. §7.4: a small hull **oscillates** with the orbital motion; there is no net drift. Test the sway
   amplitude ratio (about 1 for λ ≫ B).
5. §2: "15–20× resistance" is the **amplitude of an oscillating force**, not a mean push.

### Docking and anchor design

- **Two orthogonal state machines**, not one enum:
  - Lines: none → out (crew throws, about 1 s line-arc animation) → hauling → **docked** →
    casting off.
  - Anchor: stowed → letting go → holding / dragging → weighing.
  - Anchor plus lines must be able to coexist (anchoring off and warping in; Mediterranean stern-to
    later). Update `test-mooring` and the dock panel strings deliberately.
- **Capture:** HUD offers "R Moor" in the window. The merchant's window is wider: line's throw
  measured from the **hull side to the quay face** (about 7 m), heading 25°, speed 1 m/s, and the
  `along` range scaled by ship length. Auto-throw is a setting that defaults to off, or requires
  near-stop (under 0.3 m/s).
- **Hauling is force-based, not kinematic.** A kinematic blend fights the wave forces, penetrates
  the quay and hides the wind. Keep the current cleat-target haul control and add:
  - a critically damped haul profile toward the berth pose
  - feed-forward of the measured environmental load along the lines
  - a crew force cap = crew × about 350 N × tackle factor (about 3)
  - a stall timer that reports honestly ("Wind too strong to haul in · lines holding") and stays on
    the lines
  - 4 crew without tackle (about 1.4 kN) equals 12 m/s beam windage, so the tackle factor is needed.
    The lee side is the usual answer.
- **Docked = a PD force constraint at the CG** (horizontal plus yaw torque), not velocity
  projection:
  - k = (m + A)ω², c = 2(m + A)ω, period 1.5–2 s (stable at 120 Hz, ω·dt ≈ 0.03)
  - a soft deadband of ±0.15 m and a few degrees, so she still moves a little
  - clamped at line strength; exceeding it is an event (lines parting or crew easing)
  - heave, roll and pitch stay physical
  - **keep quay contacts**, but put the berth pose 0.15–0.25 m off contact (fenders implied)
  - while docked: auto-brail the sail, ship the oars, disable the order ladder, hint "Cast off: R"
  - this also fixes the currently failing "moored in waves within 0.6 m" test by construction
- **Cast-off automation:** raise the plank, single up the lines, shove (`SHOVE` exists), optional
  short automatic back-water.
- **Anchor:**
  - depth from terrain; rode = scope × depth, capped by the rode carried (merchant: 2 anchors, about
    60 m of rope)
  - refuse if depth exceeds rode / 3; **warn** if the swing circle covers water shallower than the
    draft
  - rode as an elastic straight line with slack, stiffening near taut (stiffness from a target
    period). No catenary for a rope rode: sag is negligible
  - effective holding H_eff = H·g(θ), where sin θ = depth / rode and g falls to 0 at about 30–40° of
    uplift. This gives scope its real meaning
  - holding is a principled estimate (no reliable ancient data): drag embedment about 5–10× anchor
    weight in sand, 2–3× in mud or weed; rock either skips or fouls; a stone anchor holds by
    friction only (0.6 × 0.62 × W). A 50–60 kg wood-and-lead merchant anchor gives about 3–6 kN in
    sand
  - **dragging is a creep law**, not a threshold: slip velocity ∝ max(0, F/H_eff − 1) on a filtered
    load, alarm on sustained slip. Wave-induced rode load oscillates by about 3 kN, which would make
    a hard threshold "drag" every wave
  - weighing at about 0.6 m/s, crew-force-limited, so it's slower in strong wind; breakout when the
    rode is short and steep; sweeps may help weigh
  - weathervaning emerges from the windage centre once wave forces and the damping fix are in
  - **seabed type:** the terrain shader already paints underwater sand, seagrass and rock
    (`terrain.ts`, around lines 250–300), but the CPU classifier is crude (`walkable.ts:194`,
    `defaultKind`: y < 0.4 means sand). Bake one seabed map in worldgen that both the shader and the
    anchor read. Seagrass (Posidonia) gives poor holding, which is historically right and adds
    meaning to choosing an anchorage
- **Commands:** at anchor, sail and steering are allowed (sailing off the anchor), and sweeps can
  help weigh. Docked disables everything except cast-off.
- **The existing auto-anchor** when the player leaves the ship (`game.ts` `updateMooring`, around
  line 460) can now be refused in deep water. It needs a fallback: the crew holds position with
  sweeps, or heaves to.
- **HUD and audio:** depth, rode out and scope, holding or dragging, line loads, the haul-stall
  reason; sounds for rode running out, dragging and line creak under haul.
- **Mediterranean stern-to mooring** (bow anchor plus stern lines; historically common) is a later
  item, but the state design must allow it.
- **Tests:**
  - haul convergence from 8 wind directions, with an honest stall when overpowered
  - docked excursion at Hs 1–2 m with wave forces on
  - dragging onset vs scope in 12 m/s wind, and no dragging at 5:1 scope in sand at default wind
  - weighing time
  - anchor and lines coexisting

### Steffy lines pitfalls (when the file arrives)

1. **Scale:** fit one scale factor to LOA 14.2, beam 4.24 and depth about 2.1 m together. A
   disagreement over 1–2% means distortion or a different reconstruction. If it conflicts with
   Rudan's Table A2, trust A2.
2. **Axes:** glTF is Y-up, Blender is Z-up; the model may be a mirrored half or have an off-centre
   keel plane.
3. **Molded surface:** Rudan's A2 has no planking thickness (about 4 cm, about 8% of displacement at
   22 t). Match A2 on the molded surface; thicken only the visuals.
4. **Keel:** the keel, false keel, stem and post may be missing or separate. Check the bottom 0.5 m
   against A2's 0.9 t.
5. **Datum:** fit the keel-bottom datum (a few cm) to A2; don't trust the model's waterline.
6. **Shape contract:** x(t) and y(t) must be monotone (`halfWidthAt` and `bottomAt` bisect).
   Smooth any tumblehome or hollows, keeping the deviation under 1 cm.
7. **Station curves:** if the coloured station curves are separate objects, read them directly
   instead of slicing triangles.
8. **Fallback:** keep the analytic fit as the fallback path.

## 4. Plan sequencing (merging rounds 2 and 3)

| Phase | Work |
|---|---|
| 0 | Hull: Steffy lines if downloaded, otherwise the analytic fit. Hydrostatics test against Rudan Table A2 (±6%, 0.8–1.7 m) |
| 1 | `ShipDesign` object threaded through constructors (no global `setShipKind`). Trireme identical, proven by a golden-trace test |
| 2 | Physics, headless, merchant flags only: mass properties via `setPayload`, girth wetted area, lateral profile, damping restructure, wave forces with implicit added mass and Munk terms, per-design aero, line and anchor stiffness from target periods |
| 2b | **Wind–wave exposure map (W1)** with 4 bands, effective fetch, the blurred depth term (W2) and an explicit harbour-basin attenuation; the **seabed map**; **wind/ship clock unification**; the FFT h0 crossfade. All before docking or anchoring tuning (reviewer agreed) |
| 3 | Procedural merchant hull, decks and open hold (`walkFloor(s,x)`, `gunwaleY`, `deckFittingY`) |
| 4 | Gameplay: stations, HUD, the new docking and anchor state machines, cameras, `ShipRig` plus `bindShip`, title selector and live swap |
| 5 | Tuning against the power balance, the voyage scenario, the manoeuvring and docking tests |
| 6 | Blender kit and figures (polish) |
| 7 | Short-wave CPU bins, only if roll response measures too tame |
| 8 | Trireme realism pass (user approved), with re-recorded baselines |
| later | Water in the hold, yard lowering, kedging, stern-to mooring, weather growth and clock (W3/W4 unless pulled forward), cargo manifest and trade |

## 5. Wind → waves (new, review round 4 in progress)

These findings are verified in code.

- **The sea is spatially homogeneous.** One Gerstner set (24 components, `waves.ts`) plus the FFT
  tiles (`oceanFFT.ts`) everywhere. Harbour, lee and open sea have the same Hs; the "sheltered"
  harbour from worldgen is cosmetic. (This is **not** related to the failing moored test:
  `test-mooring.mjs:142` uses its own synthetic single wave with no terrain.)
- **Wind has no terrain shelter.** It was explicitly deferred in `docs/sailing-spec.md`. The shader's
  cat's paws (`ocean.ts`, around line 303) are visual only.
- **Retargeting** (`waves.ts`, around line 115):
  - JONSWAP driven by `wind.meanSpeed` (0.35 amplitude, 600 s noise), a fixed fetch of 40 km, and
    cos^2s spreading on a direction fan fixed from the initial wind
  - amplitudes relax with **τ = 40 s for every component** (`update`, around line 160)
  - real growth takes minutes for chop and about 4.5 h for the peak at 12 m/s and 40 km, so there is
    no young steep chop on a rising wind and no lingering swell
- **Weather runs on real dt** (`wind.update(dt)` in `game.frame`), while `AstroClock` runs at
  timeScale up to 480×. Time-skip doesn't advance weather or sea.
- **No depth effects.** Swell is a fixed 0.35 m from WNW, unattenuated by islands.

Proposal sent to the reviewer in round 4 (answered; see below):

- **W1. Exposure map** baked in the worldgen worker:
  - about 16 directions on a coarse grid (about 128², ≈94 m cells, blurred about 300 m)
  - fetch to the upwind shore, and a wind-shelter factor (wake of about 10–20 hill heights)
  - at runtime, interpolate at the current bearing to get a local wind and fetch, which drive band
    multipliers for the Gerstner bands, the FFT scale, the whitecap threshold, swell exposure and
    the sail wind (via `wind.sampleAt`)
  - CPU and GPU use identical manual bilinear sampling (texelFetch) to keep the ship floating on
    what you see; global wave phases are kept, only the amplitude envelope varies
- **W2. Depth attenuation** by k·h from terrain depth, plus shoaling for visuals.
- **W3. Growth and decay** per component, with a period-dependent τ, growth faster than decay, on
  simulation time.
- **W4. Weather on the game clock**, optionally with a meltemi daily cycle and multi-day episodes.
  This sets up seasons for the trade game.

Questions sent to the reviewer:

- Q1: physical validity of an amplitude envelope (horizontal displacement, a local steepness budget,
  convergence of the inverse `heightAt`, flow and acceleration for the wave forces).
- Q2: swell in the lee (diffraction) as an exposure factor with a floor of about 0.25?
- Q3: shader cost (per-band RGBA envelope vs per component).
- Q4: can the FFT h0 follow a time-evolving spectrum, or should only the Gerstner band have growth?
- Q5: under W4, slow weather on clock time but gusts on real time?
- Q6: W1 before docking and anchoring tuning? (my view: yes)
- Q7: missing effects: cross-sea after wind shifts, wind against swell, fetch asymmetry at the world
  edge, the chart showing sheltered water.

### Reviewer's round-4 answers (received; accept them all into rev. 3)

Additional code findings:

- The FFT re-orients **instantly** to `wind.from`, while the Gerstner fan only reweights, so short
  and long waves already disagree after a veer.
- FFT h0 rebuilds only on a 3% speed or 0.03 rad direction change, so it steps in small amplitude
  **pops**. Fix: double-buffer h0 and crossfade over 2–3 s.
- `wind.t` (frame dt) and `ship.time` (sim steps, which drop time on hitches through the 12-step cap)
  **drift apart**. The sail samples wind at `ship.time`; the waves use `wind.t`. **Unify now** (small
  fix, pulled forward from W4).
- The ship sim never runs faster than real time; 480× is a sky-only fast-forward.

Answers:

- **Q1. The envelope is valid if e ≤ 1 everywhere.** Define the global amplitudes at the most exposed
  condition (open sea at the capped 40 km fetch, so open water is unchanged) and only attenuate.
  - Then the global steepness budget holds locally and the inverse `heightAt` keeps contracting.
  - Envelope gradient terms are 0.6–6% and can be dropped.
  - Sample e at the **undisplaced** point inside every CPU iteration, matching the shader.
  - If e > 1 is ever allowed (shoaling), compute a local q = min(q, 0.75/Σ k·A·e) identically on CPU
    and GPU.
  - Near beaches, depth varies over tens of metres, so drive the physics envelope from depth blurred
    at 300 m or more, and do shoreline steepening and foam as visual-only effects.
- **Q2. Swell floor 0.2–0.3,** blurred at 500–800 m (diffraction spread √(λd)).
  - **Most important:** a 94 m grid can't resolve the 6 m mole. Add an **explicit harbour-basin
    attenuation** in the lee of the mole, derived from the pier frame (like the dredge mask), or the
    berths see open-roadstead swell.
- **Q3. Four bands** (swell, long, mid, short) in one RGBA texel.
  - Short fetch moves the peak, which per-band multipliers capture.
  - Pack each component's band index into `packedB` so CPU and GPU agree.
  - Same bytes and manual bilinear on both sides.
  - Fetch must be an **effective fetch** (cos-weighted over ±45°, SPM method), not a single ray.
  - Cost is negligible: one fetch per vertex and fragment; on the CPU about 1.8e5 samples/s.
- **Q4. W3 growth on Gerstner only;** the FFT tracks local wind (it equilibrates in minutes).
  - Consequence: in a sheltered bay (fetch ≈ 0.5 km, 12 m/s) the local wind sea is Hs ≈ 0.14 m,
    λ ≈ 3 m. That is entirely FFT, so **invisible to buoyancy**: the ship floats on swell only while
    the player sees chop.
  - This strengthens phase 7 (CPU sums of FFT bins) as a sheltered-water feature. Decide whether to
    reprioritise.
- **Q5. Time-skip:** gusts on simulation time; slow weather on a weather clock.
  - Streaming the sea at 480× breaks the frozen-amplitude assumption in `sampleFlowAt` and makes the
    sea visibly breathe.
  - Recommendation: **allow time-skip only when docked or anchored.** Jump to the target time by
    computing the weather and sea state analytically (W3's relaxation has a closed form), crossfade
    over 2–3 s, and treat the T key's dawn/noon jumps the same way.
  - On boot, spin the sea up from recent wind history.
- **Q6. Agreed:** W1 (with W2's blurred depth term and the harbour basin) before docking and
  anchoring tuning; W3/W4 later.
  - The exposure map lives in `WorldGenResult`. A missing map means envelope = 1, so headless tests
    are unchanged.
  - Shelter changes sail forces near islands in live play only.
- **Q7. Additions:**
  - The fixed direction fan (±55–100° around NNE) **cannot follow a new wind direction**. Before any
    southerly or sirocco weather episodes, build a 360° fan or a second fan. W3 then gives real
    cross-seas.
  - **Lee of high islands is gusty, not just calm** (meltemi downslope gusts). Shelter lowers the mean
    wind but raises gust amplitude near the lee foot.
  - **HUD sea-state readout** (Beaufort, Hs, sheltered or exposed) and sheltered water shaded on the
    chart and minimap.
  - **Audio** (wave slap, wind, rigging) follows local exposure, so the harbour sounds quiet.
  - Wind against swell: low value (no currents).

**Done:** rev. 3 written, Steffy lines received and checked. User decisions since: docked is a
voyage save point; time-skip only while docked or anchored; the meltemi cycle is deferred but kept as
a planned item; short-wave CPU buoyancy moved up to phase 2c (before tuning), so the trireme realism
pass is now phase 7. No open questions remain. **Next step:** optionally a reviewer round on rev. 3,
then wait for "go".

## 6. Key references (numbers are already transcribed in the plan, §1)

- **Katzev 1987**, Kyrenia II voyage logs (primary performance data):
  https://www.ancientportsantiques.com/wp-content/uploads/Documents/ETUDESarchivees/Navires/Kyrenia/Kyrenia2-Katzev1987.pdf
- **Rudan et al. 2024**, Heritage 7(12), https://doi.org/10.3390/heritage7120310 (open access; the
  MDPI site returns 403 to fetchers, but the Semantic Scholar PDF works). Table A1 resistance and
  Table A2 draft vs displacement are acceptance data. Table A3 has no stated KG, so don't use it as a
  target.
- Text extraction tip: PDFs extract fine with a tiny Swift PDFKit script (`swift file.swift x.pdf`).
  There is no pdftotext or pypdf on this machine.
- **Reference photos:** "Kyrenia Olkas, 4th century BC (model)" and "Kyrenia Schiffswrackmuseum –
  Rekonstruktion Modell" on Wikimedia Commons. They show the open hold with amphorae, raised decks
  fore and aft, stanchion rails, brails, quarter rudders, a bow eye, a high curved stem and
  sternpost.
- **External models:** not used as the in-game ship. iMARECULTURE is CC BY-NC-ND; the paid models
  are visual only and wouldn't match the physics.

## 7. Project conventions to keep

- User text style (memory, and §0.5 of `docs/next-level-spec.md`): plain, modern, sentence-case UI
  text, no flowery phrasing.
- Keyboard-only camera by default (memory).
- `npx tsc --noEmit` must stay clean.
- Baseline tests: rowing, sailing, walker, build and camera pass. `test:mooring` has **one
  pre-existing failure** ("moored ship in waves stays within 0.6 m of her berth").
- The trireme's "what you see is what floats" rule: visual hulls are lofted from the same hull
  functions as the physics.
- Measured trireme facts (reviewer probes): 56.6 t, GM about 0.74 m, roll about 3.3 s undamped.
  ζ ≈ 0.5, caused by the per-column heave damper `1800·A·v` (`physics.ts:263`); with it removed,
  ζ ≈ 0.14. The integrator is stable with all damping off in calm water.

## Cargo and ports (built 2026-10-11, uncommitted)

Spec: `docs/cargo-trade-spec.md` (rev. 2, Opus consultant research + review). Built by four Haiku lanes
(Economy, Ship, World, Interface) in three waves; integration by the lead in `src/tradeLayer.ts` plus small
hooks in `game.ts` (harbourLayouts, placeDocked, startInHarbour, time-skip gating, trade hooks) and
`main.ts` (initTrade, Continue/New voyage, Esc). `Input.freeze` lets the ledger own the keyboard.
- Three harbours (seed 1729: Serrothos, Kormakos, Korkia) with villages, stalls and port profiles from terrain.
- Economy: 8 goods, per-port stock on game time, hashed shocks, harvest seasons, NPC shipments; prices move
  between ports only through shipments. Wages 1.5 dr per hand per day. Duty 2 %, porterage per kg.
- Cargo is physical: `ShipPhysics.setStaticLoad` folds the hold's stowage into mass, CG and inertia (no pose
  jump; `refPoint` keeps the mooring honest). Merchant trace bit-identical without cargo calls.
- Hatches with gratings, cargo visible in the hold, quay stack, loading at 10 units per game hour.
- Every ship starts docked at the main harbour (`?start=sea` for the old start). Docking saves the
  merchant's voyage (`trieres.voyage.v1.<seed>.<heightmapSize>`); the title offers Continue/New voyage.
- Tests: `npm run test:market|voyage|cargo|hold|ports|ledger`, `lint:ui-text`; all existing suites green.
- Open: T7 tuning in play; the sea-state bake is +1.2 s with three detail regions; no porter figures yet.
- Gangplank (2026-10-11, after the cargo commit): now a rigid board with two physical contacts
  (`Mooring.updatePlank`). Its foot is set on deck per berth, inboard far enough for a climb of 28 degrees
  or less, and rides with her. Each step the board lowers until it meets the quay: the top edge when her
  deck is below the quay (merchant, about 1.2 m lower), or its own end on the quay top when her deck is
  above it (trireme). It pivots and slides as she heaves and rolls; with under 0.15 m of bearing it isn't
  walkable. The walker stands on it in both frames. The merchant's plank moved to s 0.62, clear of the
  aft hatch. Before this, the merchant's plank ran through the stone and you couldn't walk off.
