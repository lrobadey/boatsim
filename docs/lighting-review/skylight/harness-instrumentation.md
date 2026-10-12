# Skylight review harness instrumentation

The `skylight-baseline-01` working copy receives a development-only review entry and measurement hooks so the baseline and cache implementation can be captured through the same controls. The baseline's lighting, cloud, material, and renderer algorithms remain as frozen; instrumentation does not alter their outputs.

The copied `src/lightingReview.ts` and `src/gfx/lightingFixtures.ts` provide deterministic camera/ship fixtures, fixed review-time presentation, review controls, neutral references, and JSON export. Controls that require the newer cache API are feature-detected and disabled when the baseline does not expose them. The baseline's legacy cloud `step()` is wrapped to zero the public wind uniform for fixed-cloud captures.

`src/gfx/gpuProfiler.ts` adds opt-in asynchronous GPU stage queries. In the baseline, `SkySystem.environmentProfiler` wraps the existing `bakeEnvironment()` body as one `environment` stage; that stage includes the clear cube, cloudy cube, and PMREM work. The baseline's `Pipeline.beginGpuTimer()` skips whole-frame queries while the stage profiler is active, preventing nested elapsed-time queries. Whole-frame measurements remain the normal mode.

Raw whole-frame samples default to the latest 600 results. `resetGpuSamples(limit)` clears raw samples, the EMA, and pending query history before a new measurement mode. The timed review benchmark raises retention to 7,200 samples and keeps up to 7,200 presented-frame timestamps, then exports the full collected frame intervals and GPU samples (or environment-stage samples when profiling). Export and telemetry also include WebGL/device limits and timer-query capability, so measurements retain their runtime context. The UI keeps benchmark elapsed time and result counts visible after the run ends.

Build/typecheck validate source integration only. No browser capture or GPU timing is claimed by this instrumentation change; those are collected only by the subsequent paired local browser run. Stage-query results are GPU elapsed measurements when the extension is available, while `bakeEnvironment()` CPU duration remains separately visible in the review UI.
