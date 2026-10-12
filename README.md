# Τριήρης — Trieres

A first-person trireme simulator in the browser. You command an Athenian trireme among a procedurally
generated Aegean archipelago: row, sail and steer her by hand through a full day/night cycle.

```bash
npm install
npm run dev        # http://localhost:5173
```

`?dev` skips the title screen (`?dev&hud=1` keeps the HUD); `window.game` is exposed for debugging.
Quality presets (low / medium / high / ultra) are on the title screen; render resolution adapts to
hold the display's refresh rate.

## Controls

| | |
|---|---|
| Mouse | look (click to capture; without capture, rest the cursor at a screen edge or use the arrow keys) |
| **W / S** | stroke order: back water · oars up · slow · half · full · ramming speed |
| **A / D** | steering oars · **X** centre them · **Space** hold water (brake) |
| **F** | raise / brail the sail |
| **G** | select full / half sail area |
| **J / L** | hold to trim the yard manually · **K** return to crew trim |
| **R** | near a berth: throw the lines and haul in · hauling: let go · docked: cast off |
| **Z** | drop / weigh the anchor (it can stay down while you warp in to a quay) |
| **E** | take / leave the helm; on deck **WASD** walk, **Shift** run |
| **C** | chase camera (wheel zooms) · **Q** Ikaros, the eagle |
| **RMB** | spyglass · **M** sea chart |
| **[ / ]** | pass of time · **T** skip to dawn / noon / dusk / night |
| **H** | hide interface · **N** mute · **?** controls · **Esc** pause |

## What's inside

- **Sea** — long waves are analytic Gerstner components drawn from a JONSWAP spectrum driven by the
  wind; the same code runs on the CPU for buoyancy, so the ship floats on the surface you see. Short
  waves (11 m down to 10 cm) are a Tessendorf FFT on the GPU in two incommensurate cascades. Filtered
  slope variance becomes microfacet roughness, which keeps the glitter correct at any distance. Whitecap
  coverage follows Monahan's empirical wind law, derived statistically from the spectrum. The wake is
  made of Kelvin arms, stern slick and oar puddles.
- **Ship** — a 6-DOF rigid body at 120 Hz. The hull is lofted from one set of functions that also gives
  its buoyancy columns, displacement and inertia. All 170 oars are rowed by an agent crew: each rower
  is a physical force balance on his own oar, with his own strength, fatigue and timing. He keeps time
  by the keleustes' call and the man ahead of him, reads the water at his blade, and shortens his stroke
  to catch up. The crew shares out the helm's turn between the sides, and holds water through the blades.
  Speed is not tuned to a target: it emerges from the rowers' power and the oars (docs/trireme-crew-plan.md).
  This is a reduced-order model, without shaft dynamics or unsteady blade vortices. It also has steering
  oars modelled as lifting plates, a square sail with apparent-wind crew trim and partial deployment,
  crew stamina, and grounding. Sailing couples distributed sail pressure, rigid-body apparent wind,
  and shallow-hull leeway. Its aerodynamic and hull coefficients are bounded engineering approximations,
  not CFD or a calibrated Olympias performance model; rig billow is a visual approximation, not a
  cloth simulation.
- **Sky & light** — astronomical sun and moon (latitude 37°N, midsummer). A Preetham sky with clouds is
  baked to the environment, alongside a moonlit night sky, stars and a phase-lit moon. Heightfield sun
  shadows are ray-marched over the terrain for every material, and aerial perspective uses the sky
  itself.
- **World** — generated in a worker: an island layout, cliffs where the wind hits and beaches in the
  lee, and droplet erosion. Harbours, temples, villages and piers are placed by terrain analysis, and
  vegetation by biome rules.

`PLAN.md` holds the original design and scope.

The trireme's crew rowing is described in [docs/trireme-crew-plan.md](docs/trireme-crew-plan.md); run
`npm run test:trireme-crew` for its timing, speed, sprint, hold, turning, shipping, sea and CPU checks, and
`node scripts/measure-trireme-rowing.mjs --sprint` for a calm-water trial. The older scripted rowing
(selectable as `oars.system: 'banks'`) has its contract in [docs/rowing-spec.md](docs/rowing-spec.md);
`npm run test:rowing` checks it.
Opt-in browser review scenes use `?dev&hud=1&rowingReview=forward` (or `back`, `hold`, `pivot`, `rest`, `transition`).

The coupled sailing contract, including its research basis and limits, is in
[docs/sailing-spec.md](docs/sailing-spec.md). Run `npm run test:sailing` for deterministic wind, rig,
force, hull-balance and propulsion-regime checks.
Run `npm run test:sailing-tuning` for the combined, favorable-wind 8 kn engineering target at uniform
14 m/s; this is a design target, not a historical trireme calibration. Normal play starts from a
fresh 12 m/s 10 m reference breeze, then the wind field varies it over time and location. In 8–18°
heel, crew trim chooses yard angles that reduce sail loading; manual yard control remains in the
player's hands, and half sail is useful when reducing load.

Opt-in sailing review scenes accept `?dev&hud=1&sailingReview=combined&sailingWind=14&sailingPrime=90`;
choose `wind`, `row`, `combined`, `beam`, `headwind`, or `calm`. The wind query is clamped to 0–20 m/s
and calm always uses zero. `sailingPrime` advances the same physics before showing the scene
(0–120 seconds); `#sailing-review-state` exposes wind base/current/mean speed, direction, wave height,
physics and rendered rig state. Older review records used the original 8 m/s scenario and are
historical. See [the browser verification record](docs/sailing-browser-validation.md) for captures
and limits.

## Credits

The merchant ship's hull (play it with `?ship=merchant` or the ship selector on the title screen) is
built from "[Kyrenia Ship Hull Lines by J. Richard Steffy](https://sketchfab.com/3d-models/kyrenia-ship-hull-lines-by-j-richard-steffy-407996fccafb4aacbec59c4a60f1c749)"
by [Digital in situ Preservation Archive](https://sketchfab.com/kotaro_yamafune), licensed under
[CC BY 4.0](http://creativecommons.org/licenses/by/4.0/). The source model is in
`tools/blender/ref/kyrenia_steffy_gltf/`; `tools/blender/merchant_offsets.py` turns it into
`src/ship/merchantOffsets.ts`.
