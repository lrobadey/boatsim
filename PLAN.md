# TRIERES — a trireme simulator (vertical slice)

Captain a 5th‑century BC Athenian trireme through a small Aegean archipelago, in first person,
from dawn to starlight.

## 1. Target machine & performance budget

| | |
|---|---|
| Machine | MacBook Pro, Apple M4 Pro (14 CPU / 20 GPU cores, Metal 4), 48 GB unified memory |
| Display | 3024×1964 Retina XDR, ProMotion (up to 120 Hz) |
| Runtime | Browser, WebGL2 (Chrome/Safari/Arc all run WebGL2 on Metal on macOS) |
| Frame target | **120 fps** (8.3 ms), hard floor 60 fps |
| Key cost | native Retina = 5.9 MP. We render the 3D scene at an **adaptive internal resolution** (starts at 1.5× CSS px ≈ 3.3 MP, auto‑scales 1.0×–2.0× by measured GPU frame time), then post‑process + FXAA and upscale. HUD is DOM, always native sharp. |
| Memory | Plenty; we can afford 2048² float heightmaps, large instance buffers, HalfFloat HDR targets. |
| Quality presets | Low / Medium / High / Ultra (shadow map size, render scale cap, ocean grid density, vegetation density, bloom). Default **High**, auto. |

## 2. Tech decisions

- **Three.js r186 + TypeScript + Vite.** No game engine; every system is ours. No external art assets —
  **everything is procedural** (geometry, textures, audio), so no downloads/licensing and one `npm run dev`.
- **Own render pipeline** (not EffectComposer) because the water needs refraction + depth of the scene below it:
  1. Opaque pass (terrain, ship, trees, buildings, sky) → HDR HalfFloat target with depth texture.
  2. "Grab" pass: copy scene color + linearized depth into a second target (water can't sample the buffer it draws into).
  3. Water pass into the HDR target (depth‑tested), sampling grab texture for refraction/absorption/shoreline foam.
  4. Post: dual‑filter bloom → ACES filmic tonemap → color grade (warm Aegean) → vignette → FXAA → dither → screen.
- **Fixed‑step simulation** at 120 Hz (accumulator) decoupled from render rate; render interpolates ship pose.
- Units: **1 unit = 1 metre**, Y up. World = 12 km × 12 km archipelago, open sea to the horizon beyond.

## 3. Systems

### 3.1 Ocean (the centrepiece)
- **Wave model:** sum of **12 Gerstner waves** (3 swell + 9 wind waves), directions spread around the wind,
  wavelengths 1.5 m → 120 m, steepness budgeted so crests sharpen but never loop. Parameters live in one
  `WaveSet` shared by GPU shader (uniform arrays) and CPU sampler — **the ship floats on exactly the
  surface you see**.
- **Detail:** two scrolling procedural normal maps (generated at load into a tiled 512² texture from FBM noise)
  for capillary ripples, blended by distance to kill tiling.
- **Mesh:** camera‑centred **clipmap** — nested square rings, each LOD doubling cell size, snapped to its cell
  size so vertices don't swim. ~0.35 m cells near camera → kilometres at horizon; outer skirt to the horizon.
  Wave amplitude fades with distance to avoid aliasing.
- **Shading:** Fresnel (Schlick, η=1.33) mix of refraction and reflection; reflection = analytic sky (same
  function as sky dome) + sun/moon glints with roughness from wave slope; **refraction** of the seabed with
  Beer‑Lambert absorption per channel (red dies first) → the famous Greek turquoise shallows over sand and
  deep cobalt offshore; subsurface scattering approximation on backlit wave crests; crest foam from Gerstner
  Jacobian (surface compression); shoreline foam bands from water depth; **wake foam** from the foam map (3.6).
- **CPU sampler:** `heightAt(x,z,t)` inverts horizontal Gerstner displacement with 3 fixed‑point iterations;
  also `normalAt` and surface velocity for drag.

### 3.2 Sky, atmosphere & day/night
- **Time of day** clock: default a full day = 24 real minutes; `[`/`]` to slow/speed time ×(1→240), `T` to
  jump to next dawn/noon/dusk/night. Start at ~ 07:30 golden morning. Date fixed near summer solstice at
  37.5°N (Cyclades) → correct sun path.
- **Sky dome:** analytic single‑scattering‑inspired model (Rayleigh + Mie with sun‑altitude‑dependent
  optical depth) giving blue noon, orange/pink horizon at dusk, deep blue twilight; sun disc with limb
  darkening; **moon** disc (phase from day count) + moonlight; **stars** (procedural hash field, twinkle,
  fade in with sun altitude, Milky‑Way band).
- **Lighting:** sun DirectionalLight (colour/intensity from same atmosphere model, turns into moon light at
  night), hemisphere ambient from sky; environment map re‑baked via PMREM every few game minutes for PBR
  reflections on ship/rocks. Aerial perspective fog = sky colour along view direction (so distant islands
  melt into haze correctly at any time of day).
- **Shadows:** one 2048/4096 shadow map, tight frustum that follows the ship (deck, oars, sail, mast crisp);
  terrain uses baked horizon/AO term for large‑scale self‑shadowing.
- **Night lights:** ship stern lantern (point light, flicker), village windows, beacon fire on the temple
  headland — all bloom.

### 3.3 Archipelago terrain
- **Heightmap:** 2048² Float32, 12 km (≈5.9 m/texel), generated at startup in a **Web Worker** from:
  hand‑placed island "seeds" (position, radius, peak height, shape) × domain‑warped ridged FBM, with
  underwater shelves (sandy shallows around each island), a sheltered **harbour bay** carved into the main
  island, cliffs on the windward side, sea stacks.
- Islands in the slice (names from the region's flavour):
  - **Nisos Megale** — main island (~3.5 km), 380 m peak, harbour village of whitewashed houses on a bay,
    a Doric **temple on the headland** above the harbour with a beacon fire. Player starts just outside.
  - **Leuke** — long low island with white beaches and shallows (turquoise showcase).
  - **Kyklops** — steep volcanic‑looking island with cliffs and a sea cave‑ish cove.
  - **The Teeth** — cluster of rocky islets and sea stacks (navigation challenge).
  - two small wooded islets with cypress groves.
- **Mesh:** 32×32 chunks of 64² cells with 3 LODs (distance‑chosen, skirts hide cracks), frustum culled.
  Chunks entirely deep underwater use coarsest LOD only.
- **Material:** custom shader, slope/height/noise blending of wet sand, dry sand, pale limestone rock
  (triplanar on cliffs), dry golden grass, dark maquis scrub; procedural detail noise normals; wet darkening
  and caustics below/near waterline (animated caustic pattern modulated by depth & sun).
- **CPU queries:** bilinear `heightAt(x,z)` + normal for ship grounding and object placement.

### 3.4 Props & life
- **Vegetation:** instanced cypress (tall flame shape), olive (gnarled, silver‑green), maquis bushes,
  scattered boulders — placed by rules (slope, altitude, noise) — ~20k instances, distance culled per chunk.
  Gentle wind sway in vertex shader.
- **Buildings:** procedural whitewashed cubic houses (village cluster on the harbour slopes), a small stone
  pier, the **Doric temple** (stylobate, 6×13 fluted columns, entablature, pediment, marble).
- **Birds:** a few flocks of gulls circling near islands (instanced, flapping in shader).
- **Other boats:** 2–3 small anchored fishing boats in the harbour (bob on the water with the same sampler).

### 3.5 The trireme
- **Model** (built in code, ~37 m LOA, 5.4 m beam, ~1.1 m draft, historical proportions after the
  Olympias reconstruction):
  - lofted hull from ~24 cross‑sections → smooth BufferGeometry, planking texture (procedural), black
    pitch below waterline, painted strake band;
  - bronze **ram** (three‑finned), **oculus** eyes on the bow, curved **aphlaston** stern ornament;
  - outrigger (parexeiresia) with **170 oars in 3 banks** (62 thranite, 54 zygite, 54 thalamite) as
    instanced meshes;
  - main deck (walkable), gangway, helmsman's platform at the stern with **two steering oars**;
  - mast + yard + **square linen sail** (cloth shader billowing with apparent wind, can be furled);
  - stern lantern, a few amphorae, shields along the rail.
- **Oar animation:** stroke cycle (catch → drive → release → recovery) per bank with slight per‑oar timing
  jitter, blades dip into and out of the *actual* water surface; stroke rate from the order.
- **Orders (the rowing master / keleustes):** Stop, Back Water, Slow (18 spm), Half (26), Full (34),
  **Ramming Speed (44, drains stamina)**. Crew stamina recovers when slow.

### 3.6 Ship physics
- 6‑DOF rigid body (mass ≈ 50 t with crew, inertia tensor of a box‑ish hull).
- **Buoyancy:** ~40 hull sample points distributed over the hull footprint & keel; each point computes
  submersion vs `ocean.heightAt` and applies an upward force (capped) → pitch/roll/heave on real waves.
- **Hydrodynamics:** anisotropic linear+quadratic drag in hull frame (low surge, very high sway —
  the long keel — high heave), angular damping, added‑mass smoothing; water relative velocity uses wave
  orbital velocity.
- **Propulsion:** oar thrust applied as pulses in the drive phase of each stroke (you *feel* the surge);
  realistic top speeds: cruise ~ 7 kn, full ~ 9 kn, ramming ~ 10–11 kn burst. Back water reverses.
- **Steering:** twin steering oars as foils: lift ∝ v²·sin(2α), plus low‑speed turning from differential
  rowing (hold helm hard over at stop → one side backs water, "pivot turn").
- **Sail:** thrust from apparent wind with a simple square‑rig polar (useless upwind, great downwind);
  heeling moment; sail auto‑trims to best yard angle.
- **Wind:** global slowly veering wind (default Meltemi from N‑NE, 12–18 kn), gusts; drives sea state.
- **Grounding & collisions:** hull points vs terrain heightmap → contact forces + heavy friction +
  scraping sound; can't drive onto land. Soft world boundary (currents push back beyond 11 km).
- **Foam/wake map:** 1024² world‑space RT (≈ 600 m) following the ship with texel‑snapped scrolling;
  each step stamps bow wave, hull sides and stern wash (intensity ∝ speed) + ring splashes at every oar
  catch; decays over ~40 s. Sampled by water shader → persistent visible wake and oar puddles.
- **Spray:** GPU particles at the bow when pitching into waves at speed.

### 3.7 Player / first person
- Pointer‑lock mouse look, **WASD walk on deck** in the ship's moving frame (capsule vs deck heightfield
  + rail bounds), Shift to run, head‑bob subtle. Camera inherits ship motion (you feel the roll).
- **E at the helm** → take the steering oars: camera locks to helmsman seat (free look retained),
  `A/D` helm (rudder angle, returns slowly), `W/S` raise/lower stroke order, `F` furl/unfurl sail,
  `Space` hold for "ship oars / drift"; `E` again to leave the helm. Can also walk to the bow and watch.
- **C** cycles cameras (first person ↔ chase cam ↔ cinematic free orbit) for admiring the ship.
- **M** chart: parchment map of the archipelago with ship position/heading.

### 3.8 Audio (procedural Web Audio)
- Sea ambience (filtered noise, intensity from wave height & speed), hull wash rising with speed,
  wind (in rigging, ∝ apparent wind), creaking timber (random filtered clicks on roll), **oar splashes**
  synced to stroke catch, the **keleustes' drum / aulos** beat at stroke tempo, gulls near islands,
  crackling beacon/lantern at night, grinding on grounding. Master volume + mute (`N`).

### 3.9 UI
- Title card ("ΤΡΙΗΡΗΣ") with controls, click‑to‑board (pointer lock), quality selector.
- Minimal diegetic‑styled HUD: heading compass strip, speed (knots), stroke order & crew stamina, helm
  angle, wind indicator, time of day; contextual prompt ("E — take the helm"). `H` hides HUD.
- Settings overlay (Esc): quality, render scale, time speed, volume, mouse sensitivity, invert Y.
- Debug overlay (`F3`): fps, GPU ms estimate, draw calls, render scale.

## 4. Scope

**In the slice:** everything in §3.

**Explicitly out:** combat/ramming damage model, AI enemy fleets, multiplayer, walking on islands (you can
beach nearby but not disembark), weather systems beyond wind/sea state (no storms/rain), underwater
camera, saving, crew as full characters (rowers are implied; a few static figures at most).

## 5. Build order (each step runnable)
1. Scaffold (Vite/TS/three), render pipeline + post, loop, input, adaptive resolution.
2. Sky + time of day + lighting.
3. Ocean: wave set, clipmap, shader, CPU sampler.
4. Terrain worker, chunks/LOD, material; refraction/shallows.
5. Trireme model + physics + buoyancy + helm controls + oars.
6. First‑person deck walking & cameras.
7. Foam/wake map, spray.
8. Vegetation, buildings, temple, harbour boats, birds, night lights.
9. Audio.
10. HUD, chart, menus, settings, quality presets.
11. Perf pass on the target machine, polish, README.

## 6. Systemic principles (not hard‑coded)
- **Sea state from wind:** wave components are sampled from a fetch‑limited **JONSWAP spectrum** driven by the
  live wind speed; directional spreading (cos²ˢ) weights a fixed fan of components, so when the wind veers or
  freshens the sea smoothly re‑weights — no popping, no hand‑tuned wave lists.
- **Hydrostatics from the hull loft:** the same section definitions that build the hull mesh produce the
  buoyancy/drag sample columns (local beam & depth per station). Displacement, trim, and roll stability emerge.
- **Oars as blades in water:** thrust = hydrodynamic drag of each blade moving relative to the water
  (stroke kinematics − ship velocity), so thrust falls off with speed, back‑water works, and ramming speed
  is limited by physics and crew stamina, not a max‑speed constant.
- **Sail from apparent wind:** yard is trimmed by the crew to maximise forward force given apparent wind;
  lift/drag coefficients vs angle of attack; heeling moment through the mast CE.
- **World generation from a seed:** islands are placed by a stochastic layout, shaped by noise + erosion‑ish
  ridging; **sites are chosen by scoring the terrain** (harbour = sheltered, shallow, flat‑shored bay facing away
  from the prevailing wind; temple = high prominence near the harbour with a sea view; village = gentle slopes
  close to the harbour; vegetation = biome rules on altitude/slope/exposure/moisture). Player start is derived
  from the harbour. Change the seed → a new, coherent archipelago.
- **Lighting from astronomy:** sun & moon positions from latitude/day/time; light colour and sky from
  atmospheric scattering; exposure from scene luminance (eye adaptation curve).

## 7. Inspiration: AC Black Flag & AC Odyssey
- **Look:** saturated‑but‑natural "postcard Aegean" grade — vivid turquoise shallows, cobalt deep water,
  golden‑hour warmth, strong sun bloom, hazy blue distant islands, whitewashed villages and painted temples.
- **Naval feel:** speed **tiers** mapped to stroke orders (W/S steps up/down: Back · Stop · Slow · Half · Full ·
  Ramming) with an Odyssey‑style **stamina bar** for ramming speed; momentum‑heavy steering; spray over the bow.
- **Crew life:** no chanting/voices (by request) — the rhythm is carried by the keleustes' drum, oar splashes,
  creaking timber and the hull wash.
- **Cameras:** first person (default, the brief) + AC‑style **chase cam** behind/above the stern (C).
- **Spyglass** (hold right mouse): zoom + vignette, for scouting islands.
- **Ikaros** (Q): Odyssey's eagle — detach into a soaring bird camera to scout the archipelago, return with Q.
- **HUD:** compass ribbon with wind indicator (Black Flag style), speed tier pips, stamina.
