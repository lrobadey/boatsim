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
  its buoyancy columns, displacement and inertia. It has 170 simulated oars with a stroke cycle, steering
  oars modelled as lifting plates, a square sail trimmed to the apparent wind, crew stamina, and
  grounding.
- **Sky & light** — astronomical sun and moon (latitude 37°N, midsummer). A Preetham sky with clouds is
  baked to the environment, alongside a moonlit night sky, stars and a phase-lit moon. Heightfield sun
  shadows are ray-marched over the terrain for every material, and aerial perspective uses the sky
  itself.
- **World** — generated in a worker: an island layout, cliffs where the wind hits and beaches in the
  lee, and droplet erosion. Harbours, temples, villages and piers are placed by terrain analysis, and
  vegetation by biome rules.

`PLAN.md` holds the original design and scope.
