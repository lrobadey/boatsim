# Main scene cost split — October 15, 2026

## Result

The two large main-view costs in the starting harbor boat fixture are the sky cloud march (~6.1 ms removable in a diagnostic) and vegetation (~5.5 ms removable by hiding all vegetation). The ocean surface is a substantially smaller marginal cost here (~0.7 ms), separate from its reflection, refraction and FFT costs.

Apple M4 Pro, Chrome / ANGLE Metal, Ultra, scale 1.3, 1512 x 693 CSS, 1965 x 900 drawing buffer, merchant at starting harbor, boat review view, noon. Physics paused during measurement, fixed review camera; weather/render systems still execute. Original pause, scale, cap, adaptation and timing hooks are restored afterward.

## Method

The profiler alternates adjacent baseline/variant main scene renders and reverses order each round. A variant hides a category only while the main camera renders; reflection, refraction and shadow generation keep their complete objects. A current-color-target synchronous pixel readback before and after the main pass constrains GPU queries against completion wall time. Draws are classified by object ancestry during renderBufferDirect; triangles include all instances submitted, including ones clipped or hidden inside the GPU. Non-mesh primitive counts are not reported as triangles.

The broad run uses 24 pairs per category (384 sampled main renders). The targeted run uses 32 pairs per diagnostic (320 sampled main renders). Both runs report zero disjoint events and zero samples exceeding their completion wall time by more than 0.5 ms. Baseline main GPU medians: 15.99 ms broad, 15.87 ms targeted. Some wall times in the first run have large stalls; paired medians are used instead of wall-time means. These are isolated, instrumented costs, not normal gameplay FPS or hardware-independent timings.

## Category ablations

Values are medians of paired GPU-time differences, not subtraction of marginal medians. Category removals change occlusion; these savings cannot be added into a literal budget. Differences below roughly 1 ms are noisy and should be treated as a smaller-cost group rather than a precise ranking.

| Hidden from main view | Paired GPU saving, ms | Baseline calls | Baseline triangle submissions |
| --- | ---: | ---: | ---: |
| sky | 6.23 | 2 | 12 |
| vegetation | 5.51 | 263 | 6,684,364 |
| terrain | 0.35 | 206 | 120,192 |
| Ormos harbor | 0.89 | 83 | 933,198 |
| ocean surface | 0.73 | 13 | 519,584 |
| other world props | 0.84 | 25 | 195,824 |
| ship and crew | 0.32 | 57 | 107,238 |
| rigging and local effects | 0.18 | 7 | 1,802 |

The baseline additionally contains 4 draws from uncategorized points/lines/effects (zero mesh triangles in this counter).

## Targeted controls

| Diagnostic | Paired GPU saving, ms | Paired completion-wall saving, ms | Remaining vegetation calls | Remaining vegetation triangles |
| --- | ---: | ---: | ---: | ---: |
| sky cloud march disabled | 6.07 | 6.00 | 263 | 6,684,364 |
| vegetation | 5.49 | 6.70 | 0 | 0 |
| vegetation beyond 500m | 4.88 | 5.70 | 14 | 697,740 |
| vegetation beyond 1000m | 4.16 | 5.00 | 34 | 1,476,148 |
| vegetation beyond 2000m | 2.15 | 2.70 | 109 | 3,794,624 |

Distance diagnostics hide whole vegetation tiles by bounding-sphere center distance in the horizontal plane, not individual plants or exact visibility. They are cost probes, not proposed shipping cutoffs.

## Source explanation and proposed optimization order

1. src/world/sky.ts attaches uCloudOn=1 to the screen sky shader and inserts vcMarch(direction,28,0.5). That sky is drawn first with depthTest=false and renderOrder=-1000, so the shader runs even behind foreground geometry that overwrites it. The later CloudPass separately computes and composites volumetric clouds. The targeted diagnostic sets only the screen sky uCloudOn to zero during the main draw, then restores it; the environment cache, reflection lighting and later CloudPass remain enabled. This identifies an extra screen-space cloud calculation as the dominant sky cost. A production fix should preserve cloudy environment captures and check resulting cloud opacity, color, silhouettes and water reflections. No such production change or visual acceptance was performed in this task.
2. src/world/props.ts batches vegetation into instanced tiles, with distance visibility thresholds but a single geometry detail per species. The view submits ~6.68 million vegetation triangles. Instancing reduces calls but does not remove per-instance geometry processing; most measured savings survive while preserving the nearby tiles. Investigate distance-dependent simpler meshes/impostors and terrain occlusion before imposing a hard vegetation cutoff.
3. Terrain, harbor, ship and ocean surface are smaller marginal main-view costs in this fixture. Their other render passes are outside these measurements. Do not infer open-sea, night, other camera, native launcher or other-machine performance from this fixture.

## Reproduction and artifacts

Start Vite, open /gpu-review.html?dev&q=ultra&ship=merchant&ormosReview=boat&scale=1.3&cap=60 and click Split main scene for the broad run. Add &focus&pairs=32 for the targeted run. Reports save in profiles/.

- main-scene-categories.json: broad raw queries, paired statistics, and draw counts.
- main-scene-targeted.json: sky uniform and vegetation-distance diagnostics.
- src/mainSceneProfile.ts: development-only instrumentation, imported only by the GPU review entry.

Typecheck and production build passed. Final browser inspection showed the saved targeted report and no console errors.
