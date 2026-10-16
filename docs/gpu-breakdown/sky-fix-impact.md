# Sky cloud duplication fix: measured impact

October 15, 2026. Local Chrome / ANGLE Metal / Apple M4 Pro. Ultra, merchant starting harbor, boat review camera at noon. Matched viewport 1512 x 693, adaptive resolution disabled, 60 FPS cap.

## Normal presentation

Live simulation, no stage GPU queries or synchronous pixel readbacks. For each resolution, four 5-second recordings in old/fixed/fixed/old order, each preceded by 1.5 seconds settling time. Pooled FPS below uses interval count divided by total interval duration; it is not the arithmetic mean of instantaneous FPS. Only the live sky uCloudOn switch changes; environment capture clouds remain enabled. Original game settings and switch are restored after the run.

| Render scale | Drawing buffer | Old FPS | Fixed FPS | Gain | Old median frame ms | Fixed median frame ms | Old p95 frame ms | Fixed p95 frame ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1.3 | 1965 x 900 | 45.9 | 59.7 | 30.0% | 21.8 | 16.7 | 23.7 | 18.1 |
| 2 | 3024 x 1386 | 31.1 | 45.7 | 46.9% | 31.9 | 21.9 | 35.6 | 23.2 |

The scale 1.3 fixed result is constrained by the 60 FPS cap. It does not establish the uncapped throughput. Weather continues to evolve through the test; the reversed A/B sequence reduces ordering bias but does not establish every weather/camera condition.

## Controlled GPU comparison

80 adjacent old/fixed main-view pairs at scale 1.3, same drawing buffer 1965 x 900. Physics paused, current-color-target readbacks bracket each main scene render. This perturbation is separate from the normal-pacing run above.

- Old main GPU median: 16.681 ms.
- Fixed main GPU median: 9.817 ms.
- Reduction between marginal medians: 41.1%.
- Median paired GPU saving: 6.565 ms.
- Median paired completion-wall saving: 6.600 ms.
- Disjoint events: 0; GPU samples exceeding completion wall time by more than 0.5 ms: 0.

The roughly 6.6 ms paired saving agrees with the earlier diagnostic estimate. It is a main-scene GPU reduction, not a 41% reduction in the entire frame.

## Evidence and limits

- sky-fix-pacing.json: warmed normal-pacing run with all frame samples.
- sky-fix-gpu.json: matched GPU query pairs and readback controls.
- profiles/2026-10-16T03-25-34-141Z.json: initial pacing run at a taller 1512 x 949 viewport. Its first old sample had severe main-thread stalls; it is excluded from the headline result rather than treated as the fix's benefit. Subsequent full-resolution blocks showed the same direction of improvement.
- Final browser capture reported no console errors. Typecheck and production build passed for the instrumentation.

These are short local browser samples, not launcher/WKWebView benchmarks or an all-scene visual acceptance result. The production fix remains the single screen-sky cloud-switch change in src/world/sky.ts.
