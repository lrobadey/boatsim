# Skylight integration acceptance

The skylight implementation is integrated in the shared checkout. Visual checks use a frozen lighting-only overlay so concurrent crew and physics edits cannot change the scene or comparison. This report distinguishes implemented behavior, observed rendering, and unproven performance targets.

## What changed

- One evaluated lighting state drives the visible atmosphere, cloud lighting, and immutable capture snapshots.
- Two reusable clear/raw/PMREM bundles publish together and crossfade for 0.2 seconds. Ordinary settled frames use a single-source shader; both variants are precompiled for the actual HDR main, refraction, reflection-clipping and cloud passes.
- Captures track meaningful solar, lunar, atmospheric, weather, origin, and profile changes. Higher quality captures spread cube faces across frames; filtering remains indivisible.
- Suppressed presentation retains invalidation without issuing environment GPU work. Resuming reconciles to a complete generation.
- A restrained blue-hour contribution bridges the previous near-black horizon just after sunset. It is zero in daylight and deep night. Daylight direct lighting, exposure anchors, wave geometry and solar water highlights retain their formulas.
- Indirect sky specular retains terrain ambient occlusion but no longer inherits direct-light shadow visibility. That decision is the named `aegean-skylight` profile, version 2.
- A packed transition-only water texture keeps both shader variants within the combined 16-texture-unit budget. It is uploaded before gameplay.

## Evidence

`npm run test:skylight`, `npm run typecheck`, `npm run build`, and `git diff --check` pass. Source tests cover daylight anchors, lunar gating and handoff, twilight continuity, cache publication/snapshots/invalidation/lifecycle, material shader hooks, registry disposal, exact texture packing and both shader variants' sampler budgets.

Live browser checks render the final paired shader design without GLSL or texture-unit errors on the local M4 Pro/ANGLE Metal browser. The full-moon source behind an opaque raised sail is hidden; stars do not appear across that sail. Context loss/restoration returns a complete, rendered scene. This is an observed view, not an exhaustive visibility proof for every geometry type.

The repaired development fast-forward control advances 40 game hours through `Game.fastForward(5, 1/60)`. Environment capture/generation counts remain 19 during all suppressed frames and reconcile once to generation 20 on presentation. See `lifecycle.json`.

Seven neutral fixture center pixels at 09:00, fixed exposure 1, fixed weather, environment-only PBR lighting have identical binary16 scene HDR RGB values between cached and forced-current captures. See `hdr-static-comparison.json` and the two `hdr-environment-*-final.json` files. This establishes static agreement at those samples; it does not establish dynamic cache error, local occlusion, surface averages, or a physical radiance calibration. The ocean is not fully isolated by the PBR fixture lighting controls.

Matched captures and their telemetry are in `comparison.html`. The baseline already contains earlier moon/occlusion edits and a cloud filtering experiment; those are retained, not attributed to this integration. `baseline-manifest.json`, `baseline.patch`, `integrated-manifest.json`, and `fixture.json` identify the exact reference, overlay and camera/ship fixture. Daytime changes are restrained; the strongest visible change is twilight.

## Performance evidence and limits

Performance is local evidence, not a hardware-independent guarantee. Fixed rendering is 801 by 775 pixels, high quality, render scale 1, seeded world 1729, held camera. Live 60-second runs advance the simulation and weather; frozen captures are used only for appearance.

An earlier valid baseline day run rebuilt the environment 53 times versus 17 in the integrated run, a 68 percent reduction. That establishes reduced generation frequency, not a net frame-time gain. The former integrated uniform-branch shader measured 18.97 ms median GPU versus a 13.50 ms baseline median, while p95 improved from 34.14 to 22.80 ms. Those runs informed the settled/transition shader split and are not acceptance measurements of the final shader implementation.

The first final-build run was rejected as an acceptance run: only 52.36 seconds of simulation elapsed in 60.19 seconds of wall time, and program count rose from 235 to 331. Actual program cache keys exposed three missing startup conditions: the offscreen HDR working color space, the water-refraction light set, and the reflection pass's global clipping plane. Startup now compiles both environment variants with those actual target/layer/clipping conditions and restores renderer state. The rejected run remains `after-day-final.json` for diagnosis.

The HDR-corrected day run advanced 59.85 simulation seconds in 60.20 wall seconds. Median/p95/p99 GPU times were 19.04/33.62/58.11 ms, compared with 33.88/54.47/100.50 ms in the latest reference run. Captures fell from 53 to 17. See `day-timing-summary.json`. That run preceded the final reflection warmup coverage; it still created 39 reflection programs. A subsequent live check of the final coverage reached generation 41 through repeated live updates while program count stayed 438 to 439 and texture count stayed 94; the one added program is the ordinary temporal-cloud pass. See `final-warmup-reuse.json`. This check establishes program reuse, not a new timed benchmark.

Large variability across earlier baseline medians (13.50 and 33.88 ms under the same rendering dimensions) prevents a blanket speedup claim from these runs. The original 30 percent environment GPU-work target, 3 percent whole-frame non-regression gate, staged GPU budget and three-regime timing matrix are not considered passed without supporting measurements. Dynamic HDR error and long-duration resource stability remain unmeasured.

Environment color storage is estimated from source dimensions/formats/mips: 10,684,384 bytes per bundle, 21,368,768 bytes for the pair at high quality. The second bundle adds about 10.19 MiB; the transition-only packed array adds about 2.67 MiB because the original textures remain available to the settled path. PMREM scratch/depth storage and driver/program overhead are separate. Context restoration clears GPU program caches and can incur warmup again. No hardware memory-meter measurement or exhaustive resource-growth endurance claim is made.

## Concurrent edits

The shared checkout failed startup in crew stance code before lighting initialization during one smoke test. The lighting-only snapshot starts and renders; crew/physics work was not reverted or modified to obtain that result. Final application-wide startup acceptance must include those concurrent changes once their owners finish them.
