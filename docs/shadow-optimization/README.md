# Directional shadow optimization — 2026-10-15

The objective is to remove repeated directional shadow work at Ultra without changing
gameplay, shadow resolution, the light frustum, or animation update cadence.

## Baseline, prediction and acceptance target

The initial live fixture is seed 1729, the merchant at its starting harbor, boat view,
12:30, Ultra, render scale 2, CSS viewport 1512 × 693 (drawing buffer 3024 × 1386).
Chrome 155 uses ANGLE Metal on the local Apple M4 Pro. These are local browser
measurements, not native WKWebView or hardware-independent performance claims.

Every one of 240 sampled frames produced two 4096 × 4096 shadow updates:

| Update | Draw calls | Submitted triangles | Median GPU ms |
| --- | ---: | ---: | ---: |
| Refraction | 91 | 1,047,302 | 2.030 |
| Main | 165 | 3,445,390 | 3.998 |
| Combined | 256 | 4,492,692 | 6.036 |

The combined GPU median is computed from paired per-frame query results, rather than
adding the two marginal medians. Triangles are submissions before clipping/culling
inside the GPU; instanced batches can submit geometry outside the light frustum.

Prediction, recorded before the implementation: one complete update should retain the
main pass's 165 draws and save approximately 2 ms of directional shadow GPU work.
The explicit acceptance targets are:

- Exactly one fresh directional update per presented frame.
- At least 35% fewer shadow draw calls on the initial fixture (256 → at most 166).
- At least 25% lower median directional shadow GPU time in a comparable sample.
- Keep Ultra's 4096 × 4096 map, bias, frustum and per-frame dynamic updates.
- Preserve the complete union of main and refraction casters; do not freeze the scene.
- Validate daytime, late-day and moonlit views, camera cuts and live simulation.

## Implementation and reproduction

`DirectionalShadowFrame` scopes Three's public shadow-map render hook to the scene
passes. The first pass generates a complete map using the main viewpoint's LODs and
the union of caster layers. Later passes reuse that map. Color rendering keeps its
own camera/layer filters. Hook and camera state are restored on failure. The shadow
map object is looked up again each frame because Three replaces it on context restore.

Run `npm run test:shadows`, `npm run test:skylight`, `npm run typecheck`, and
`npm run build`. Start the local server with `npm run dev -- --host 127.0.0.1`.
Open `/shadow-review.html?dev&q=ultra&ship=merchant&ormosReview=boat&scale=2`.

This development entry is absent from the normal game import graph. It disables
adaptive resolution, freezes the simulation/weather for matched captures, and offers
the original shadow policy as an A/B control. Both policies run the same current game,
assets and scene. It records actual shadow buffer draws and uses asynchronous GPU
queries. Whole-frame and shadow queries are measured separately, never nested.
Each measurement has 60 warmup frames, 240 sampled frames and a query-drain period.
The original production baseline is also retained in `baseline.json`.

Under a saturated GPU, moving a query across render passes can change how queued work
is attributed. The first attempt reduced calls and presentation intervals but reported
inconsistent stage/whole-frame elapsed times. Those results are retained in
`optimized-first-attempt.json`; they are not accepted as proof of a GPU speedup.
Paced A/B measurements check that attribution separately from normal presentation.
