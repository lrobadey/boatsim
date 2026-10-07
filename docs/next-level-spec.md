# Trieres — "Next Level" design spec

Owner/lead: Claude (Opus). Implementers: Haiku agents, one workstream each. The lead makes design
decisions; implementers execute this spec exactly and ask (in their final report) rather than invent
when something is ambiguous.

## 0. Goals (what "feels really good" means here)

1. **You are a person, not a camera.** Walk the deck of a moving, rolling ship; step down a gangplank
   onto a stone quay; walk the harbour, the beach, the hills; jump off the side and swim; climb back up.
   No invisible walls without a reason, no snapping, no stuck states.
2. **Docking is a skill with tight, honest feedback.** A clear berth target, live approach numbers,
   a capture window you can learn, lines that visibly warp her in, a rating on how well you did.
3. **The ship is yours.** A base-building mode on deck: place cargo, awnings, lanterns, an altar…
   Each piece has mass the physics feels (trim and heel), collides, and persists.
4. **Graphics:** real modelled harbour kit, figures and deck pieces from Blender; ambient life on the quay.

Non-goals: combat, NPC AI beyond idle figures, multiplayer, skeletal animation.

## 0.5 Text style (user requirement)

All visible text is clear, modern and real. Short functional labels in sentence case
("Moor", "Cast off", "Raise anchor", "62 m to berth"). No flowery or faux-ancient phrasing, no
exclamation marks, no puns, no "X — Y" em-dash constructions (use a new line or " · "). Numbers
always carry units. Proper nautical terms are fine where they are the real term (Back water, Hold
water). Item names are plain nouns; item descriptions, if any, state what the item does.

## 1. Conventions (existing — do not change)

- 1 unit = 1 m, Y up. Fixed sim step `SIM_DT = 1/120` in `ShipPhysics.step`.
- **Ship local frame** (= `Trireme.group` local, = hull functions in `src/ship/hull.ts`):
  x = starboard, y = up (0 = design waterline), z = aft; bow at z = −17 (+ ram). Station
  `s ∈ [0,1]` bow→stern, `zOf(s)`, `sOf(z)`. Deck top `deckY(s)` (≈2.69 amidships, 3.2 aft),
  walkable deck `DECK_S0..DECK_S1` = 0.07..0.93, walkable half-width `deckHalfWidth(s)`
  (`src/ship/trireme.ts`). Outrigger outer edge: `halfBeam(s) + outrigger(s)`.
- `game.model.group.position/quaternion` = render-interpolated ship-local→world transform.
  `ship.pos` is the CoG (local `ship.cg`), `ship.vel`, `ship.angVel` world. Point velocity:
  `ship.pointVel(worldPoint, out)`.
- Compass heading: `ship.heading = atan2(fwd.x, -fwd.z)`; `ship.place(x,z,heading)` uses
  `quat = axisAngle(Y, -heading)`.
- Water height `waves.heightAt(x,z,t)`; terrain `terrain.heightAt(x,z)`, `terrain.normalAt`.
- Materials go through `patchMaterial(mat, undefined, key)` (`src/gfx/shared.ts`) so they get the
  game's fog/aerial perspective/sun-shadow treatment. Never use a raw material in the scene.
- Code style: match the surrounding files (terse comments explaining *why*, no JSDoc boilerplate).
  `npx tsc --noEmit` must stay clean. `npm run test:rowing` must keep passing.

## 2. Architecture

```
game.ts ── owns everything, fixed-step loop
 ├─ ShipPhysics ── + Mooring (src/ship/mooring.ts)      [WS-B]
 │                 + harbour colliders, payload masses
 ├─ HarbourLayout (src/world/harbour.ts)                 [WS-B]  berths, quay solids
 ├─ WorldWalk (src/world/walkable.ts)                    [lead]  static walk/collide geometry
 ├─ PlayerController (src/player/controller.ts)          [WS-A]
 │    └─ Walker (src/player/walker.ts)  frame-aware character controller, swim
 │    └─ CameraFeel (src/player/cameraFeel.ts)  bob, sway, landing, FOV kick
 │    └─ Interactions (src/player/interact.ts)  "look at + E" prompts
 ├─ DeckBuilder (src/build/*)                            [WS-F]  base building
 ├─ Models (src/gfx/models.ts + public/assets/models)    [WS-C]  Blender kit
 ├─ AudioEngine additions                                [WS-E]
 └─ Dock UI (src/ui/dock.ts, berth marker)               [WS-D]
```

Contracts that cross workstreams live in code, written by the lead, and must not change shape
without the lead: `src/world/walkable.ts`, `src/world/harbour.ts` (types), `src/ship/mooring.ts`
(public API), `src/player/walker.ts` (public API), `src/build/pieces.ts` (catalogue types).

## 3. WS-A — Walking, swimming, camera feel, interactions

Files owned: `src/player/*`. Do not edit `game.ts`, `physics.ts`, `hud.ts` (the lead wires those).

### 3.1 Two frames
The walker is either in the **ship frame** (state = ship-local foot position + velocity, carried
along by the ship for free) or the **world frame** (world foot position + velocity).

- ship → world when the foot leaves the deck footprint (vault over the rail, walk out through the
  plank opening, fall). Convert: `world = shipXform · local`, `worldVel = ship point velocity +
  R·localVel`. Yaw: `worldYaw = yaw + shipYaw` (so the view direction is continuous).
- world → ship when the foot is over the deck footprint in ship-local coords
  (`|x| < deckHalfWidth(s) − 0.05`, s in deck range) and `localFootY ≥ deckY(s) − 0.25` and the walker
  is descending or grounded. Hysteresis 0.05 m to prevent flicker.
- Horizon: on the ship the camera inherits ship roll/pitch partially (`levelFactor`, existing). In
  the world frame the camera is level. Blend the effective level factor to 1 over 0.6 s after a
  frame switch so there is never a snap.

### 3.2 Ground & collision
- Capsule radius 0.3 m, height 1.75 m, eye 1.66 m (existing `EYE`).
- Ship frame support: `deckY(s)` inside `deckHalfWidth(s)`; deck edge = rail (blocks) except at the
  plank opening (`mooring.plank`, ±0.45 m around the plank station, on the pier side, only when
  `plank.deployed > 0.95`). Ship-local solids (mast r=0.25 at s=0.42, helm bench, placed build pieces)
  come from `ShipSolids` (same `Solid` type as `WorldWalk`, coordinates ship-local); walkable tops
  (crates) can be stood on.
- World frame support: `WorldWalk.support()` (terrain + quay + steps + plank + build tops) and
  `WorldWalk.collide()`. Plus the **ship hull as an obstacle**: transform to ship local; if
  `|x| < halfBeam(s)+outrigger(s)+0.3` and `y < deckY(s)` and s in [0,1] → push out sideways.
- Step-up 0.45 m (stairs, quay steps); slopes steeper than 42° are not walkable (slide).
- Gravity 9.81 rising, 1.6× when falling (snappier arcs). Jump initial 3.5 m/s → 0.62 m apex.
  Coyote time 0.12 s, jump buffer 0.12 s.

### 3.3 Movement feel
- Walk 2.1 m/s, run (Shift) 4.6 m/s, swim 1.2 m/s (Shift 1.8). Ground accel 14 m/s², decel
  (no input) 18 m/s², air control 25% of ground accel. Shallow water (water deeper than 0.4 m at the
  feet, feet on ground) slows to 60%.
- **Vault:** pushing outward against the rail + Space → scripted 0.45 s arc up 0.8 m and 1.3 m
  outward, then free fall in the world frame. Prompt while touching the rail: `Space jump over the side`.
- **Sea legs:** in the ship frame, add the deck's tangential acceleration as a small lagged sway of
  the eye (spring k=40, ζ=0.7, clamp 0.12 m) so rolls are felt, but never move the foot.
- **Swim:** in world frame when water depth at feet > 1.3 m. Eye bobs at the wave surface + 0.12 m;
  W/S/A/D swim in look direction (horizontal), Space bobs up. Climb out by walking onto support
  within step height (beach, quay steps). Near the ship hull (< 2.2 m from the hull side at the
  waterline): interaction `E Climb aboard` → 0.8 s scripted climb to the nearest deck point inside
  the rail, ship frame.

### 3.4 Camera feel (`cameraFeel.ts`)
Stride-driven, not time-driven: phase advances by `distance / strideLength` (stride 1.45 m walk,
2.1 m run). Vertical bob = `|sin|`-shaped (two dips per stride), amplitude 0.035 walk / 0.06 run;
lateral sway 0.02 at stride frequency; tiny roll 0.6°. Strafe roll 1.2° toward the strafe direction.
Landing dip: spring impulse proportional to fall speed (clamp 0.18 m), recover 0.25 s. Run FOV +6°,
damped. Emit footstep events at each bob trough: `{kind: SurfaceKind, intensity}`; landing events;
splash events (enter water, swim strokes every 1.1 s while moving).

### 3.5 Interactions (`interact.ts`)
`Interactable { id, label, frame:'ship'|'world', pos (local or world), radius, enabled(): boolean,
act(): void }`. Each frame pick the enabled one with the smallest view angle within 2.2 m of the
eye and within 30° of the view centre (helm: 2.5 m). `player.prompt` = `"<kbd>E</kbd> label"` or a
contextual hint (rail vault) or null. The lead renders it.

Initial interactables: helm (ship, stern, `Take the helm`), climb aboard (swimming).

### 3.6 Public API the lead depends on
See `src/player/walker.ts` header. `PlayerController` modes become `'foot' | 'helm' | 'chase' |
'eagle' | 'build'`. `'foot'` replaces `'deck'`. Mode `'build'` = on foot with the build cursor
(WS-F drives the cursor, walker still walks).

Acceptance: `scripts/test-walker.mjs` (headless, node + register-ts, mocked ship pose & flat world)
covering: frame round trip keeps world position continuous (< 1 mm) and view direction continuous;
rail blocks without Space; vault lands in world frame; walking down a ramp from the deck reaches
the quay; swim → beach exits to walking; hull pushes a swimmer out. Typecheck clean.

## 4. WS-B — Harbour, quay, collisions, mooring, anchor

Files owned: `src/world/harbour.ts`, `src/ship/mooring.ts`, the pier section of
`src/world/worldgen.worker.ts` + `worldgenTypes.ts`, `buildPier`/`buildBoats` in
`src/world/props.ts`, and `src/ship/physics.ts` (hooks only: mooring forces, harbour contacts,
payload). Do not touch rowing.ts.

### 4.1 Worldgen: a real mole into dredged water
Current pier: 33 m long ending in 1.3 m of water — unusable for a 37 m ship drawing 1.05 m.
- March from `shore` along the pier direction; `d0` = first distance where the seabed is ≤ −3.0 m
  at the centre line and at ±9 m. Pier length `L = d0 + 48` (berth zone `[d0, L]`), max 170 m;
  if land is hit beyond, shorten but keep the berth zone ≥ 40 m.
- **Dredge**: within the rectangle along `[d0 − 6, L + 14]` and laterally `±18 m` from the pier
  centre line, `H = min(H, −3.8)`, with a smoothstep falloff over a further 14 m. Do this before AO,
  vegetation and anything sampling heights. Never raise terrain.
- `Sites.pier` gains `width` (6.0), `top` (1.8 above MSL), `berthStart` (d0), and stays
  `{x,z,angle,length}` otherwise.

### 4.2 HarbourLayout (main thread, `buildHarbour(gen, terrain)`)
- Two berths, one each side of the pier, centred at `(d0+L)/2` along it. Ship centre line sits
  `pierHalfWidth + 2.65 (outrigger) + 0.35 (fenders)` = 6.0/2 + 3.0 = **6.0 m** from the pier axis.
- Bollards: 3 per berth on the pier top, 0.7 m in from the face, at −15, 0, +15 m along.
- Quay steps: at the pier head, on the end face, a flight from top (1.8) to −1.0 m, 1.6 m wide,
  0.3 m risers (walkable solids). This is the swimmer's way out.
- Solids (`Solid[]`): pier body (walkable top), steps, bollards (blocking cylinders), houses
  (blocking boxes from `gen.sites.houses`), temple stylobate (walkable top, 3 steps) and its columns.
- Ship colliders: pier body box (the hull must not pass through the quay).

### 4.3 Ship ↔ quay contact
In `ShipPhysics.ground()` add contact against harbour boxes. Add contact points on the outrigger
outer edge (`x = ±(halfBeam+outrigger)`, `y = sheer(s)`, s = 0.2..0.8 step 0.1) used **only** for
harbour boxes. Contact = spring 3e5 N/m (fendered) + damper 8e4 N·s/m along the face normal,
friction μ=0.25. Emit `bump` events with normal speed (≥ 0.25 m/s), via `mooring.events`.

### 4.4 Mooring (`src/ship/mooring.ts`)
State machine `free → warping → moored → (castOff) free`, and `free ↔ anchored`.
- `approach`: nearest berth within 220 m (null otherwise), recomputed every sim step. Fields in
  the contract file. Capture window (`canMakeFast`): `|along| ≤ 8 m`, `−0.8 ≤ lateral ≤ 4.0 m`,
  `headingErr ≤ 15°`, `sog ≤ 1.3 m/s`, state `free`. Either heading (bow toward shore or seaward)
  and the pier on either side of the ship are valid. `reason` = the single most important failure,
  in plain words: "Too fast — slow to under 2.5 kn", "Bring her alongside", "Straighten up — 22° off",
  "Too far along the quay".
- `quality ∈ [0,1]` = product of soft scores (speed, lateral, heading) for the UI colour.
- `makeFast()`: state → `warping`, 4 lines (bow, stern, two springs) from ship-local cleats to
  bollards. Each line: horizontal spring pulling the cleat toward its target (the cleat position in
  the berth pose), slack 0.1 m, k ramps 0→40 kN/m over 1.5 s, damping 25 kN·s/m, force clamp 30 kN
  (crew hauling). Forces horizontal only (heave/pitch/roll stay free). `warping → moored` when pose
  error < 0.35 m and < 3° and sog < 0.15 m/s (or after 12 s). Record `rating` from the max contact
  speed during approach+warp and the capture speed: "Smartly done" / "Well enough" / "Rough".
- `castOff()`: only when the player is aboard (lead enforces). Lines released, plank raised, crew
  shoves off: 0.35 m/s impulse away from the quay applied over 1 s.
- `plank`: `{ station: 0.62, side: ±1, deployed: 0..1 (2 s animation while moored),
  deckLocal: Vector3, shoreWorld: Vector3, width: 0.7 }`. `shoreWorld` = the deck-edge point
  projected horizontally 1.6 m onto the quay top, recomputed every step (the ship bobs).
- **Anchor:** `dropAnchor()` stores the bow's world xz + rode 14 m. Beyond the rode: horizontal
  spring 18 kN/m + damping 12 kN·s/m at the bow cleat, clamp 60 kN. `weighAnchor()` → free.
  Allowed only when sog < 1.5 m/s.
- `events: MooringEvent[]` (drained by game each frame) for audio/UI.

Acceptance: `scripts/test-mooring.mjs` headless: a ship placed 3 m off the berth, 8° off, 0.5 m/s
→ `canMakeFast` true; after `makeFast` reaches `moored` within 12 s with pose error < 0.4 m, and a
moored ship in waves stays within 0.6 m; hitting the quay at 2 m/s does not penetrate (> 0.2 m) and
emits a bump; an anchored ship under 15 kn of wind stays within rode + 3 m; existing rowing test
still passes.

## 5. WS-C — Blender asset kit

Files owned: `tools/blender/*`, `public/assets/models/*`, `src/gfx/models.ts`.
Blender: `/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P <script>`.
One Python script per asset family, deterministic, re-runnable, exporting `.glb` (Y-up, +Y up,
−Z forward in glTF = game convention; apply transforms; no cameras/lights).

Materials are **named slots**, not final looks; `src/gfx/models.ts` maps them to game materials:
`stone`, `stone_dark`, `wood`, `wood_dark`, `bronze`, `iron`, `rope`, `clay`, `plaster`,
`roof_tile`, `cloth`, `cloth_red`, `cloth_blue`, `skin`, `hair`, `leather`, `fire`. Each mesh gets
UVs by world-scale box projection, 1 UV unit = 2 m (stone/wood textures are 2 m scans).
Bevel hard edges (2–4 cm) so the sun catches them. Budgets in triangles.

Harbour kit (origin conventions matter — the game places these by numbers):
| file | spec | tris |
|---|---|---|
| `quay_segment.glb` | mole section 6.0 m long (z) × 6.0 m wide (x), top at y=0, sides down to y=−7. Ashlar block courses (0.5 m high, staggered joints, slight random inset/bevel), coping stones on top edges, top paving slabs. Timber fender posts every 1.5 m on both long faces from y=−0.2 to y=−1.9 plus a horizontal wale at y=−0.4. Seamless when tiled along z. | ≤ 3000 |
| `quay_head.glb` | end of the mole, 6 × 6 m, same courses; steps on the end face (+z side) 1.6 m wide from y=0 to y=−2.8 in 0.3 m risers / 0.35 m treads, cut into the mole; a bronze ring. | ≤ 3500 |
| `bollard.glb` | stone mooring post, base at y=0, 0.8 m tall, r 0.22 with a mushroom cap r 0.3. | ≤ 300 |
| `gangplank.glb` | 3.0 m long along −z from origin (origin = ship end, top surface at y=0), 0.7 m wide, 6 cm thick, cross cleats every 0.35 m, two rope hand-lines on short stanchions. | ≤ 800 |
| `anchor.glb` | wooden-stock anchor with lead stock, 1.6 m, ring at top at origin. | ≤ 600 |
| `fender.glb` | rope-bound bundle, 0.8 m long, r 0.15. | ≤ 300 |
| `dock_props.glb` | separate named meshes: `crate`, `amphora`, `amphora_rack` (6 amphorae in a timber rack), `pithos` (big storage jar), `rope_coil`, `net_pile`, `basket`, `brazier`, `lamp_post` (with `fire` slot), `bench`, `awning` (4 posts + cloth canopy 3×2.4 m, 2.3 m high), `altar` (small stone altar 0.9 m), `shield_rack`, `banner` (pole + cloth). Each base at y=0, centred. | ≤ 900 each |
| `house_a/b/c.glb` | Aegean houses, whitewashed rubble walls (`plaster`), stone footing (`stone`), wooden door/lintel/shutters (`wood_dark`): a = 5×6 m flat roof with parapet + roof terrace; b = 6×8 m low-pitch tile roof; c = 4×4 m two-storey tower house with exterior stair. Origin at footprint centre, ground at y=0, footing extends to y=−1.5. Windows are separate mesh named `windows` with slot `fire` (glows at night). | ≤ 2000 |
| `figures.glb` | humans built from a skin-modifier skeleton + subsurf 1 + decimate, chiton (`cloth`), skin, hair; meshes named `fig_marine` (bronze helmet with crest, shield on arm, spear), `fig_archer`, `fig_keleustes` (arms raised calling the stroke), `fig_sailor_idle`, `fig_dockworker_carry` (amphora on shoulder), `fig_fisher_sit` (seated on y=0.45). 1.72 m tall, feet at y=0, facing −z. | ≤ 2500 each |

Every script also renders a preview PNG (Workbench, studio light, 3/4 view) to
`tools/blender/previews/<name>.png`; inspect them and iterate until they look good. Report final
tri counts. `src/gfx/models.ts`: `loadModels(): Promise<ModelKit>` loading all glb files, mapping
material slots to game materials (polyhaven stone/planks maps for stone/wood with world-scale UVs,
plaster = warm white roughness 0.92, etc.), enabling shadows, returning named geometries/objects.

## 6. WS-D — Docking & interaction UI (phase 2)

Files: `src/ui/dock.ts`, `src/world/berthMarker.ts`, additions to `src/ui/style.css` (append a
clearly delimited section). Driven by `mooring.approach` and `mooring.state`.

- **Berth marker (3D):** when approach is non-null and state free: the berth's ship outline
  (waterline polygon from `halfWidthAt(s,0.4)` + outrigger, at water level + 0.05 following the
  wave height at the berth centre) drawn as a glowing dashed line (no depth test against water,
  depth-tested against terrain/quay), colour = quality (red #c4492f → amber #d9b56a → green
  #7fc48a). Plus 3 chevrons on the water from the ship to the berth when > 40 m away. Fades out
  beyond 180 m. Hidden when moored. Bollards of the target berth get a soft glow ring.
- **Docking panel** (bottom centre, above the helm bar, only at the helm/chase within 120 m):
  title "Berth — <name>", a mini top-down diagram (ship rectangle vs berth slot, live, rotated so the
  pier is up), three gauges with target bands: speed (kn, band < 2.5), lateral (m, band −0.8..4),
  angle (°, band ±15), and the reason line. When `canMakeFast`: a pulsing
  `<kbd>R</kbd> Make fast` call-to-action. While warping: "Hauling in…" + progress. Moored:
  `Moored · <kbd>R</kbd> cast off · <kbd>E</kbd> leave the helm`.
- **Rating toast** after moored: "Smartly done" / "Well enough" / "Rough landing" with contact speed.
- **Bump feedback:** camera shake impulse (lead wires) + red flash edge vignette at > 1 m/s.
- **Crosshair:** 4 px dot, 40% opacity, only in foot/build modes; grows to a ring when an
  interactable is targeted.
- Minimap/chart: berth icon (small anchor glyph) at each berth.

## 7. WS-E — Audio additions

File: `src/audio/audio.ts` only. Procedural WebAudio in the style of the file. Add methods:
`footstep(kind: SurfaceKind, intensity)` (wood: hollow knock 90–160 Hz body + click; stone: short
bright tap; sand/grass: filtered noise crunch; shallows: splashy), `land(kind, speed)`,
`splash(size)`, `swimStroke()`, `ropeThrow()`, `lineCreak(tension 0..1)` (continuous bed while
moored, creak bursts on tension changes), `hullBump(intensity)` (low thud + wood crunch at high
intensity), `anchorDrop()`, `anchorWeigh(seconds)`, `plank(down: boolean)`, `buildPlace()`,
`buildRemove()`, `buildDeny()`, and a harbour ambience bed (distant voices murmur as band-passed
noise + occasional hammering) driven by `setHarbourProximity(0..1)`. All respect mute/volume.
Vary pitch/gain ±8% per call. Acceptance: a dev-only `window.audioTest()` that plays each once.

## 8. WS-F — Ship base building (phase 2)

Files: `src/build/pieces.ts` (catalogue — contract), `src/build/deckBuilder.ts`, `src/build/buildUi.ts`,
CSS section. Uses ModelKit (WS-C), `ShipSolids` (lead/WS-A), `ship.payload` (WS-B).

- **Enter:** `B` while on foot aboard → mode `build`. `B`/`Esc`-less exit: `B` again. Walking still
  works; the palette is a bottom bar of piece cards (icon, name, mass), `1–9` or wheel to select.
- **Cursor:** ray from the eye into ship-local space, hits the deck plane `y = deckY(s)` or the top
  of a stackable piece (crates/pithoi stack two high). Snap to a 0.25 m grid in ship-local x/z,
  `R` rotates 90° (Shift+R 15°). Ghost = the piece mesh with a translucent green/red material.
- **Valid** iff: footprint inside `deckHalfWidth` with 0.1 m margin and within s 0.1..0.86, no
  overlap with other pieces / mast / helm area (s > 0.86) / crew spots / plank opening, reach ≤ 4 m,
  and total payload ≤ 2.5 t. Red ghost + reason ("Too heavy for the deck", "Blocked", "Out of reach").
- **Place:** LMB. **Remove:** look at a piece + `X` (refund). Small scale-in pop animation (0.15 s).
- **Physics:** every piece adds `{mass, local position}` to `ship.payload` → gravity at that point
  (trim/heel). The palette shows live load `1.2 / 2.5 t` and the predicted heel/trim.
- **Function:** lanterns/brazier light at night (max 3 real PointLights, nearest to camera; others
  emissive only); awning gives shade; altar: once per day, +stamina for the crew ("Poseidon is
  pleased"); amphora racks/pithoi are cargo (mass); shield rack/banner decorative.
- **Collision:** each piece registers a ship-local `Solid` (walkable top for crates/pithos).
- **Persistence:** `localStorage['trieres.deck.v1']` JSON list `{id, x, z, rot, level}`; restored on load.

## 9. WS-G — Camera system (user request: "a better system for camera movement")

Files: `src/player/cameraRig.ts` (new), `src/player/controller.ts`, `src/core/input.ts`, `src/main.ts`
(pause menu + pointer-lock fallback only). One rig owns the final camera pose; each mode only
produces a *target pose* `{ position, quaternion, fov }`.

1. **Transitions, never cuts.** Changing mode snapshots the current camera pose and blends to
   the new mode's live target with smootherstep: foot↔helm 0.45 s, any ↔ chase 0.7 s, eagle in/out
   0.6 s. Position lerp, quaternion slerp, fov lerp. Re-toggling mid-blend restarts from the current
   blended pose (no jumps). Frame switches inside foot mode are already continuous (WS-A).
2. **Mouse.** Pointer-lock deltas → angle by sensitivity (rad/px), no acceleration, no smoothing.
   Without pointer lock: **drag to look** (hold LMB and move) plus arrow keys; remove edge-hover
   turning. A click shorter than 4 px of movement still counts as a click (build placement).
   Pitch limits ±85° on foot/helm.
3. **Chase camera** (third person around the ship):
   - Pivot = ship CoG + 4 m up. Horizontal follow is tight (critically damped spring ω = 8);
     vertical follow is soft (ω = 2.5) so heave doesn't bounce the view.
   - Look-ahead: pivot shifted along the ship's horizontal velocity × 0.6 s, clamped to 6 m.
   - Orbit yaw/pitch relative to the smoothed ship heading (keep the existing lag), wheel zoom
     14–160 m smoothed, auto-recentre behind the stern after 3 s without look input when speed
     > 1.2 m/s (rate 0.6/s).
   - Spring arm: sample terrain and water at 10 points along pivot→camera; if any is closer than
     1.5 m to the arm, pull the camera in to that distance immediately; let it back out over 1.2 s.
   - FOV + up to 5° with speed (linear to 5 m/s).
4. **First person.** Default horizon levelling 0.75. Spyglass reduces head bob and shake to 30%.
5. **Shake (trauma model).** `rig.addTrauma(x)`, trauma ∈ [0,1] decays 1.4/s, shake = trauma².
   Rotation offsets yaw 2.5°, pitch 2°, roll 3° and position 0.06 m, all × shake, driven by smooth
   noise (sum of incommensurate sines around 9–17 Hz), applied after blending. Sources (lead wires):
   quay bump (speed/2.5), grounding (`ship.grounding`), bow slam (`ship.bowSlam`, small).
6. Public API on PlayerController: `rig: CameraRig`; `addTrauma(x)` passthrough.

Acceptance: `scripts/test-camera.mjs` — blend continuity (no frame-to-frame jump > the larger of
the two modes' own motion), re-toggle mid-blend continuity, spring arm never ends below terrain +
1.4 m on a synthetic hill, trauma decays to 0 within 0.8 s from 1.

## 10. UI system — "Wine-dark instrument" (lead-owned design; see docs/ui-explore/index.html)

Decisions (user, 2026-10-07):
- HUD density: minimal by default; steady readouts (time, wind, order ladder, stamina at 100%)
  fade out after a few seconds and return on change. **H cycles full → minimal → none.**
- Astrolabe: **kept in the HUD, restyled** to the new system (night glass, bone linework,
  terracotta/bronze accents, no parchment or skeuomorphic bronze).
- Accent: **terracotta #D0693E** = active / selected / brand. Bronze #D2A65E = helm and progress.
  Fair #8FCB9B, caution #E8A25A, danger #E36A4B for state only.
- Greek lettering: **wordmark only** (title, loading, pause).

Type: Marcellus (wordmark), Cormorant Garamond 500 (places, panel titles, moments), Inter Tight
(all numbers with tabular figures, labels, body). Panels: one night-glass surface
(rgba(10,16,24,.46), blur 14px, 10 px radius, 11% bone hairline). Layout, motion and presence
rules as in the exploration page's "Rules" table.
