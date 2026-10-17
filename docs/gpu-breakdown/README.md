# GPU stage investigation, October 15, 2026

Local Chrome / ANGLE Metal / Apple M4 Pro, Ultra, merchant starting harbor boat view at noon. Render scale 1.3, canvas 1965 x 900. Live simulation, fixed review camera, adaptive resolution disabled during capture and restored afterward.

## Controlled sample

One selected stage per frame, rotating through 12 stages over 180 presented frames (15 samples per stage). Read back a pixel from the current color render target before and after the selected stage; elapsed wall time includes CPU, driver, GPU work and synchronization overhead. GPU queries remain provisional; the controlled run passed the basic check that each stage mean is less than its readback wall time. This is a perturbed isolated-work estimate, not normal uninstrumented frame timing. No disjoint events or skipped queries.

| Stage | Mean GPU ms | Share of stage means | Mean readback wall ms |
| --- | ---: | ---: | ---: |
| main scene | 17.817 | 64.6% | 23.313 |
| volumetric clouds | 3.211 | 11.6% | 3.893 |
| reflection scene | 2.861 | 10.4% | 7.967 |
| refraction scene | 2.021 | 7.3% | 5.307 |
| bloom and grade | 0.618 | 2.2% | 1.160 |
| FFT waves | 0.581 | 2.1% | 0.740 |
| SMAA | 0.401 | 1.5% | 0.973 |
| oar water | 0.033 | 0.1% | 0.127 |
| foam | 0.029 | 0.1% | 0.200 |
| cloud shadows | 0.007 | 0.0% | 0.107 |
| sky environment | 0.001 | 0.0% | 0.120 |

Sum of disjoint stage means: 27.580 ms. Reflection includes directional shadows (separately sampled at 1.272 ms); do not add that shadow row again. These stages were sampled on different frames, so the sum is an estimate, not a whole-frame measurement. Sky environment updates are intermittent and the short rotating sample does not establish their long-run amortized cost. Main scene includes ocean surface, terrain, props and ship; it does not establish which object dominates.

## Rejected controls

- profiles/2026-10-16T03-02-51-046Z.json: multiple queries per frame yielded an impossible roughly 279 ms summed mean at 66.7 ms presentation intervals. Rejected.
- profiles/2026-10-16T03-04-10-221Z.json: rotating queries with gl.finish still exceeded completion wall times. Rejected.
- profiles/2026-10-16T03-05-21-821Z.json: reading the default framebuffer failed to constrain offscreen-pass times (main query about 16.7 ms vs 5.6 ms wall). Rejected as a validation control.

The final control reads the current target. This supports a provisional stage ranking, not a diagnosis of the browser/driver timestamp failure.

## Reproduction

Run Vite, open /gpu-review.html?dev&q=ultra&ship=merchant&ormosReview=boat&scale=1.3&cap=60&sync and click Capture GPU stages. Reports save in profiles/. The separate development entry is absent from the normal production game import graph. Typecheck and production build passed during investigation; browser reported no console errors in the final run.
