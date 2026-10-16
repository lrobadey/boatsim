# Foreground shortcut: measured, then rolled back

October 15, 2026. Outcome: the candidate reduced final cloud-composite GPU work slightly but did not meet the proposed image-preservation contract. The production shortcut was removed. The earlier duplicate-sky-cloud fix remains in place.

## GPU cost

Local Chrome / ANGLE Metal / M4 Pro, Ultra, merchant starting harbor boat view at noon. GPU comparison viewport 1512 x 693. 160 adjacent old/candidate pairs per resolution, reversed pair order, frozen physics and cloud weather. Only the candidate early return differs between shaders; all uniforms and input textures are shared.

| Scale | Buffer | Old median GPU ms | Candidate median GPU ms | Reduction between medians | Median paired saving ms |
| --- | --- | ---: | ---: | ---: | ---: |
| 1.3 | 1965 x 900 | 0.3397 | 0.3131 | 7.8% | 0.0268 |
| 2 | 3024 x 1386 | 0.5300 | 0.4865 | 8.2% | 0.0437 |

Zero disjoint events and zero GPU samples exceeding completion wall time by more than 0.5 ms. These isolate the final composite, not all clouds or the whole frame.

An initial query placement timed a draw without first consuming the updated upstream cloud textures. That yielded implausibly large ~6–10 ms attributed costs and no reliable stage difference. The refined placement first renders an untimed composite and reads back its HDR target, ensuring the measured repetition's input dependencies have completed. The initial GPU figures are retained for audit and rejected.

## Normal frame pacing

Separate run, no GPU timing queries or readbacks. Live simulation, fixed review camera, scale 2, 3024 x 1498 buffer, 1512 x 749 viewport, adaptive resolution disabled, 60 FPS cap. Eight five-second blocks in old/candidate/candidate/old/old/candidate/candidate/old order, with 1.5 seconds warmup before each block.

- Old pooled FPS: 44.143.
- Candidate pooled FPS: 44.610.
- Observed FPS difference: 1.06%.

This short-run ~1% difference is not accepted as a strong whole-game gain. The isolated composite saves only about 0.04 ms at full Ultra; other frame work dominates. The pacing and GPU runs used different viewport sizes but each individual A/B comparison held its size fixed.

## Pixel preservation

For each resolution, render both shaders against the exact same composite inputs. Repeating the candidate draw gives zero changed pixels, confirming stable input during the comparison. Alpha is unchanged.

- 1965 x 900: 212,870 of 1,768,500 HDR pixels differ (12.04%). Only 16 changed pixels lie outside the shortcut eligibility mask. Maximum raw HDR channel difference 1.90234375; maximum half-float bit-pattern separation 476.
- 3024 x 1386: 513,085 of 4,191,264 HDR pixels differ (12.24%). Only 3 changed pixels lie outside the shortcut eligibility mask. Maximum raw HDR channel difference 2.046875; maximum half-float bit-pattern separation 524.

Most differences are very small in a simple Reinhard/gamma preview, but there are sparse larger outliers: up to 9 8-bit levels in that diagnostic preview. This preview is not the game's full final grade/bloom/ACES chain. The final composite is therefore not bit-identical, and no strict image-preservation claim is valid. The exact cause of all deviations has not been established; do not label them universally harmless rounding. Thumbnails alone do not certify the full image.

Given the modest measured benefit and failed exact-output contract, the candidate was rolled back rather than presented as a completed successful optimization.

## Files and reproduction

- measured-gpu-and-images.json: refined query pairs, HDR comparison counts and diagnostic thumbnails.
- initial-pacing-and-confounded-gpu.json: accepted normal-pacing blocks, plus the rejected initial GPU timing placement.
- candidate-fragment.glsl: exact archived candidate shader.
- src/foregroundPerformanceReview.ts: development-only replay of archived candidate versus production, enabled only by foregroundReview on the separate GPU review entry. It restores the production material afterward.

Open /gpu-review.html?dev&q=ultra&ship=merchant&ormosReview=boat&foregroundReview and click Measure foreground fix. Add &gpuOnly to omit pacing; &imageOnly records the first resolution's image comparison only.

After rollback, skylight tests, typecheck and production build passed. The production bundle hash returned to the pre-shortcut index-PnYuPuU1 build. No browser console errors were recorded in the refined measurement.

## Independent Astra follow-up

An Astra subagent independently reviewed shader equivalence, metadata/history contracts and measurements; see astra-review.md. The targeted reconstruction-diagnostic.json shows two different classes of change: eligible foreground examples have zero reconstructed radiance and a transmittance residual of 2^-24, while the eight largest changes are eight noneligible sky pixels using exact fallback. Identical final alpha does not establish identical cloud transmittance.

A dev-only diagnostic moved the view-ray cone derivative calculation before all per-pixel branches, passed the cone explicitly into the ray marcher, and applied the same change to control/candidate. The uniform-cone-negative-result.json capture still has seven noneligible sky changes and max HDR difference 1.84375. This **does not** establish ray-cone derivatives as the sole cause. No diagnostic shader change was applied to production.

### Explicit sampling diagnostic

`explicit-lod-result.json` records a further image-only comparison with uniform cone retained and weather/detail reads changed to explicit LOD0 in both control and candidate. In this frozen harbor fixture (1965 x 900), changed pixels outside shortcut eligibility fell to **zero**, maximum HDR difference to **0.00390625**, and maximum half-float separation to **one step**. Diagnostic display differences were at most one 8-bit level; repeating the candidate remained identical. No console shader errors were recorded. This supports remaining implicit sampling as a cause of the sparse large deviations. It does not certify LOD0 as a production sampling policy, establish equivalence to the original shader, or measure the performance of a corrected candidate. Production remains unchanged.

The follow-up `weather-only-result.json` retains uniform cone and explicit weather LOD0 but leaves detail sampling unchanged. It likewise reports **zero outside-eligibility differences**, maximum **one half-float step**, and maximum **one diagnostic display level**; repeat draw differences are zero. Therefore the detail replacement is unnecessary to eliminate the sparse errors in this fixture. Uniform cone plus explicit weather selection is sufficient here. A cone-free weather-only comparison was not run; necessity of the cone change and behavior across scenes remain unestablished.

Astra's source-grounded production proposal is to derive explicit weather LOD from the march's world-space integration footprint and view cone, using 42000/256 = 164.0625 m per weather texel, while preserving the existing far-light LOD policy. This is a separate proposed sampling correction, not an accepted implementation or benchmarked speedup. Given the shortcut's roughly 0.04 ms isolated saving and weak ~1% pacing result, keep it rolled back until a separately validated change is justified.
