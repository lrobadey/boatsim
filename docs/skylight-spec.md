# Skylight coherence and environment update specification

Status: implemented and visually reviewed; bounded acceptance evidence and remaining performance limits are recorded in `docs/lighting-review/skylight/acceptance.md`. Implementation and visual testing were explicitly authorized by the user. Lead: Codex; independent consultation: GPT-6.1-sol, high reasoning; bounded implementation by GPT-6 Luna workers. The targets below are design gates; the acceptance report distinguishes achieved measurements from remaining limits.

## 1. Outcome

Preserve the successful morning sunlight and wave glitter while improving the relationship between direct light, sky illumination, reflections, haze, and exposure. Reduce recurring environment-generation work and visible update steps without increasing total rendering cost or making the scene flatter.

The player should notice better depth in shaded cloth, wood, and terrain; a sky whose illumination agrees with its appearance; and a continuous progression from daylight through twilight into restrained moonlight. The system should spend work on meaningful changes in illumination and retain detail where it matters.

This is a refinement of the existing rasterized renderer. It does not add general bounced illumination, local reflection probes, screen-space GI, a new atmosphere model, or path tracing. It does not change wave geometry, direct ocean specular, sail physics, terrain shadows, cloud density/detail, bloom, or grading as a way to manufacture a performance gain. Stars and celestial-source occlusion remain a separate visibility acceptance check.

## 2. Current foundation and limits

| Component | Verified current behavior | Consequence for this design |
| --- | --- | --- |
| Visible sky | Preetham sky with authored lunar radiance and a separate volumetric cloud pass | Keep the model; centralize inputs before calibrating outputs |
| Direct light | One sun/moon directional light; atmosphere-dependent solar RGB and authored lunar RGB/intensity | Preserve the existing source model and daylight output during the structural refactor |
| Environment | 32-square clear-sky cube; 256-square cloudy sky/sea cube; PMREM filtered from the latter | A capture has multiple outputs and an explicit generation identity |
| Consumers | PMREM for standard-material diffuse/specular illumination; raw cube for ocean reflection and aerial haze; clear cube for cloud haze | Changes must reach compatible consumers together |
| Update trigger | Sun-direction squared difference greater than `2e-5` (about 0.26 degrees), or elapsed update time above three seconds | It does not explicitly track lunar phase, sky parameters, cloud displacement, or capture origin |
| Capture cost | Clear cube plus six cloudy environment faces, with a 28-step inline cloud march per environment ray, then PMREM | Recurring work is verified; its GPU cost and perceptibility are not established by source alone |
| Frame integration | Environment work runs before the `present` early return | Suppressed presentation during fast-forward can still rebuild the environment |
| Tone pipeline | Linear HDR render targets; exposure/grade and tone mapping downstream | Captures and interpolation must remain linear and unexposed |

Three already evaluates directional diffuse sky illumination from the PMREM using the surface normal. Adding a second ambient representation without replacing that contribution would double-count it. The shared material patch also dims indirect specular by `mix(0.35, 1.0, gTerrainShadow)`, coupling environment reflections to direct-light visibility. Audit that factor in isolated calibration comparisons: a terrain/cloud shadow does not automatically occlude the surrounding sky. Keep terrain sky-visibility AO as a separate quantity, and do not remove either attenuation as an unverified aesthetic fix. The global environment and heightfield AO cannot represent local sail/deck/building sky occlusion or bounced illumination.

Important source seams: `src/world/sky.ts` (lighting, captures, shared capture uniforms), `src/game.ts` (cloud input formulas and frame ordering), `src/gfx/shared.ts` (fog and material patches), `src/world/ocean.ts` (raw environment reflection), `src/gfx/clouds.ts` (haze and live cloud uniforms), `src/core/pipeline.ts` (timing), and `src/core/quality.ts` (quality policy).

The environment already uses the sky model. The problem is not a wholly unrelated lighting approximation. The opportunities are separately authored energy scales, incomplete invalidation, discrete publication, and recurring generation cost. Centralizing parameters alone will not make those scales physically consistent.

The existing environment excludes the sun disc to avoid adding it on top of direct solar specular. The moon disc remains in the capture, alongside directional lunar lighting. Preserve that asymmetry in the structural stage, explicitly measure its contribution in the calibration stage, and decide on one source-energy accounting policy before changing it. Never remove a source from a capture without considering both diffuse and specular effects.

The working tree includes earlier interrupted moonlight changes, a cloud filtering experiment, and a development review page. They are not an accepted visual baseline. Record their disposition before implementation acceptance; do not silently endorse, revert, or fold them into this work. Before implementation, save the exact working-tree content/diff and relevant asset hashes as named benchmark snapshot `skylight-baseline-01`, with its dirty-state manifest and configuration. Performance comparisons use that frozen snapshot even if its visual experiments remain unapproved. Any later baseline change requires rerunning both sides and renaming the reference; never change the 30% comparison denominator silently.

## 3. Visual contract

1. Preserve the direct solar light RGB/intensity, ocean highlight model, wave normals, and daylight exposure at the reference morning/noon/afternoon states during the structural stage.
2. Preserve readable, colored shadows. Do not lift all shadows uniformly or use exposure to hide insufficient sky illumination. Cloth, wood, and stone retain their distinct reflectance and roughness.
3. Match sky illumination to the visible atmospheric conditions. Calibration uses neutral reference materials and raw HDR measurements before final grading.
4. Moonlight remains substantially dimmer than daylight. A new moon retains restrained airglow; an elevated full moon provides directional structure without a broad silver wash. Exposure must not conceal excessive lunar radiance.
5. Environment changes should be imperceptible as cache events at the normal clock rate. Twilight may change rapidly because the atmosphere changes; it must not jump because a texture was replaced.
6. Local fire and lantern color remain distinct from sky illumination. This change does not simulate their bounced light.

Calibration anchors are the current latitude/date at 07:24, 09:00, 12:30, and 17:00, plus dawn/dusk sampled by actual solar altitude and night scenes with multiple lunar phases and altitudes. Solar-altitude fixtures are authoritative for transitions; wall-clock labels alone are insufficient across dates.

## 4. One live lighting state, explicit capture snapshots

Introduce a pure lighting-state evaluator and a separately owned environment cache. `SkySystem` can remain the facade. Suggested files are `src/world/lightingState.ts` and `src/gfx/skyEnvironment.ts`; exact placement is an implementation detail.

Frame order is explicit: advance astronomy and weather displacement; finalize the camera/cloud sampling origin and coverage; evaluate lighting once; apply it to live materials/clouds; then acquire any requested capture snapshot. Split the current cloud `step()` into weather integration and application of lighting inputs, since it currently combines both. Capture and rendering must never advance cloud displacement again. The live state contains:

- Revision/epoch, absolute game time, sun and moon directions/altitudes, lunar phase, active directional source, and linear direct RGB.
- Atmospheric parameters; daytime, twilight, and night weights; lunar sky and airglow parameters; visible celestial-disc parameters.
- Cloud coverage, density, erosion, wind displacement, relevant time/noise inputs, ambient top/bottom RGB, and spatial capture origin.
- A named, versioned calibration profile and exposure target. Exposure adaptation remains presentation state rather than baked illumination.

Move the existing cloud ambient formulas and lighting/exposure formulas into this evaluator without changing their numerical output first. Producers and consumers receive the same named state; avoid copying the formulas into separate shaders or subsystems. Display gains for sky illumination, water, and haze remain explicit, with the existing `environmentIntensity = 0.85` documented rather than assumed to be a physical ratio.

A capture owns an immutable deep snapshot of every shader input that can affect it, including vectors/colors, moon orientation, cloud origin/displacement, and its clear-sky haze source. Read-only noise textures may be shared. Mutable Three uniform objects must not be shared with live materials: the current clear-sky material aliases the sky uniforms, and the cloud sun direction aliases a shared live vector.

Capture coordinates distinguish the cube camera at the environment scene origin from the world position used to sample the cloud field. Keep the current spatial interpretation initially, then test movement explicitly. A yaw-only camera rotation is not an invalidation reason for a world-aligned environment.

The live sky and direct lights remain responsive every frame. The cached environment has bounded temporal/spatial error; it is not claimed to represent the exact current frame. All cached lighting consumers share the same published generation and transition weight.

## 5. Meaningful invalidation and bounded staleness

Replace the sun-only trigger with a scheduler that compares the live state against a named reference: the in-flight snapshot during capture/filtering, the completed destination during a blend, and the active snapshot when idle. Keep that reference fixed for the operation; never reset it to every frame's live input. Accumulated changes remain eligible for the newest pending request. Invalidation reasons are observable in development telemetry.

Track solar and lunar direction/altitude; phase and source handoff; radiance-scale changes; atmospheric parameters; cloud coverage/density/erosion; cloud displacement relative to the spatial origin; quality/model revisions; and explicit time or position discontinuities. Use both relative and absolute color tolerances so near-zero night values do not cause endless rebuilds. These are input-based error proxies, not a measurement of the full sky's radiance error.

Provisional high-quality starting values, to be revised from image comparisons:

| Situation | Starting trigger / limit |
| --- | --- |
| Stable daylight | Solar movement 1 degree; maximum published snapshot age 4 real seconds |
| Twilight (solar altitude roughly +6 to -12 degrees) | Solar movement 0.25 degrees; maximum age 1 real second |
| Established night | Lunar movement 0.5 degrees when lunar illumination matters; maximum age 4 real seconds; continue tracking residual solar twilight |
| Cloud/spatial changes | Coverage delta 0.02, density/erosion delta 0.05, relative cloud-field displacement 60 metres |
| Radiance proxy | Relative RGB change 5%, with a separately calibrated dark-scene absolute floor |
| Normal blend | 0.2 real seconds, shortened if needed to meet the age/error limit |

Age is measured from snapshot acquisition, not publication, and includes capture, filtering, and blending. Use a monotonic real timestamp for real-second deadlines rather than the game loop's clamped `dt`; track astronomical/world-state change separately. Time-scaling/fast-forward must not mistake a short real interval for a small astronomical change. Prioritize time-varying twilight brightness over unnecessary azimuth precision in a stable broad sky. Normal continuous sun/moon handoff uses normal invalidation, not an epoch snap simply because the active-source name changed.

Unchanged frozen lighting/weather/origin should perform zero rebuilds after initialization; reaching a timer limit alone does not invalidate an identical state. Coalesce normal requests into one newest pending state. Never accumulate a queue of old lighting snapshots or restart every face because the world moved slightly. Begin work before the age limit, reserving measured capture/filter/blend latency rather than treating expiry as the start signal. Report both endpoint ages, destination age, and blend alpha; the hard age bound applies to the oldest endpoint still sampled, with identical frozen states exempt. If normal scheduling cannot meet the bound, finish early or shorten the blend monotonically. As a last resort cancel/reconcile with the forced-refresh protocol and record a deadline violation; repeated use fails acceptance and requires a less costly policy. Lack of headroom cannot defer work indefinitely.

During `present=false`, evolve CPU lighting/weather state and mark the newest environment dirty; perform no environment GPU work. On the first subsequent presented frame, reconcile to the newest state. Keep this change confined to environment generation; other simulation/render caches have separate contracts.

Explicit clock jumps, large teleports, quality changes, or a change of lighting epoch cancel obsolete work. A discontinuity uses a coherent forced refresh before the next visible scene render, with no interpolation across unrelated times. This exceptional full refresh may cost a frame and must be measured. Context restoration recreates targets and performs the same initialization protocol.

## 6. Capture, filtering, and publication

Use a finite state machine: `idle -> capturing -> filtering -> ready -> blending -> idle`. Every completed bundle contains a snapshot ID, a clear-sky cube, a raw environment cube with valid mipmaps, and the matching PMREM texture.

Start with stock six-face capture and stock PMREM while instrumenting costs. If a capture causes frame spikes, stage the six cloudy faces across presented frames, initially one face per frame. Render all faces from one pinned snapshot. Finish clear-sky capture before cloudy-face work; capture clouds sample that snapshot's clear sky, never their own output. Generate raw-cube mipmaps only after all faces are complete.

Stock `PMREMGenerator.fromCubemap` remains one indivisible operation in this design. It synchronously submits its filtering work; this does not establish a CPU readback stall. Face staging distributes capture work but does not distribute PMREM. Schedule filtering using recent headroom, with a deadline to prevent starvation. If PMREM alone violates the spike budget, reduce environment resolution only after visual comparison or scope a separate incremental-filter proposal; do not claim that face staging solved it.

Publication is atomic: water/fog must not see a new raw cube while solid materials still see an old PMREM. No consumer can read partial cube faces or a texture currently being rendered into.

The selected smoothing design is a finite crossfade of two complete bundles in linear radiance, with one shared alpha:

- Standard-material diffuse and specular samples blend the two compatible PMREM maps.
- Ocean sky reflections, underwater sky-irradiance sampling, and aerial haze blend the two raw cubes at the same direction and LOD. Every `uFogEnv` use must route through the shared helper, including the upward LOD-5 sample used for water scattering.
- Cloud haze blends the paired clear-sky cubes. Captures themselves use their pinned clear source, not the presentation blend.
- Direct light, actual shadow maps, and the visible cloud simulation continue to use the live state; alpha applies only to cached environment illumination.

Do not crossfade final graded images or regenerate PMREM for every intermediate blend. Keep source strengths, rotations, PMREM layout/size, roughness interpretation, and color spaces compatible. Route all patched PBR materials through one helper; identify any explicit material `envMap`, unpatched materials, or special shader consumers before accepting coverage. Precompile supported shader variants and fail visibly in development if expected Three shader hooks are absent.

Two bundles are sufficient if capture pauses during a blend. Finish the blend before reusing the previous bundle; normal changes coalesce. A jump during a blend first cancels interpolation and rebinds presentation to one coherent completed bundle. That releases the other endpoint for the exceptional forced refresh. Build and publish the new bundle before scene rendering; never overwrite an endpoint still bound for sampling. This intentionally snaps to the new epoch; a two-bundle pool cannot preserve an arbitrary three-way mixture. Quality/layout changes dispose/recreate the whole pool after its consumers release it.

Alpha is finite and frame-rate independent: use clamped elapsed monotonic real time divided by the chosen duration, optionally with smoothstep easing, and explicitly publish the destination alone at the end. If duration shortens, alpha never decreases. Do not use exponential convergence that never reaches the destination exactly.

Interpolation adds texture reads and bindings. The implementation uses separate settled and transition shader variants, selected only at fade boundaries and precompiled under the actual HDR render-pass conditions. This replaces the proposed runtime uniform branch after its measured cost. The settled variant strips paired sampling; a zero-weight `mix` is insufficient. Validate fragment texture-unit limits and shader compilation before enabling extra bindings. Measure actual blend cost at full viewport; frequent blends could erase capture savings. A smooth crossfade is an acceptance requirement only if visible replacement steps exist. If atomic publication is already imperceptible, the measured simpler path may ship without crossfade, documented with transition evidence.

All render helpers restore target, active cube face/mip, viewport/scissor, XR, depth/clear state, and temporary material settings even on failure. Face orientation and reversed-depth handling must match the installed Three implementation. Disable unnecessary depth attachments on sky-only targets only after confirming sea-disc/depth ordering. Reuse targets and PMREM storage; no allocation/disposal in ordinary update or blend frames.

## 7. Quality policy and bounded resources

Keep the existing 256-square environment and 28-step capture march on high/ultra for the first reference-preserving implementation. Environment quality becomes explicit rather than following screen render scale automatically. Prototype 128-square medium and 64-square low only as separately evaluated quality choices; preserve each tier's existing cloud representation. Do not introduce volumetric captures on low when its live clouds are disabled.

At 256 square with RGBA16F, a raw cube with mipmaps is approximately 4 MiB and a 768-by-1024 PMREM atlas approximately 6 MiB. A second complete pair therefore adds about 10 MiB of color storage, plus small clear cubes, attachments and driver overhead. PMREM also owns reusable scratch storage. Verify actual allocation formats and count; this is an estimate, not GPU memory telemetry.

Provisional added environment color-storage ceiling: 12 MiB on high/ultra, 4 MiB on medium, 2 MiB on low. Account for unexpectedly larger PMREM layouts at small input sizes. Do not add a third permanent high-resolution bundle or increase capture resolution to compensate for poor scheduling.

Separate diffuse skylight coefficients could eventually allow cheaper broad illumination updates, but spherical harmonics, probe extraction, a second sky evaluator, and a custom filter are deferred. They are a measured fallback rather than prerequisites for this bounded refinement.

## 8. Instrumentation and performance gates

Report capture count/reason, snapshot age/error proxies, face work, PMREM updates, blend duty cycle, state cancellations, allocations, and environment bytes. Track CPU submission time, GPU execution time, and presented intervals separately. Existing GPU EMA is useful for adaptation but cannot establish a pass cost or reveal every spike.

Use asynchronous disjoint timer queries where supported. WebGL elapsed-time queries cannot nest: sample environment stages on dedicated profiling frames without an overlapping whole-frame query, and collect whole-frame timings separately. Discard disjoint/invalid results; never block for query results or read textures back in the production scheduler. Without GPU queries, report CPU/presentation evidence and leave GPU cost unverified.

At fixed viewport, render scale, quality, weather trajectory, and camera trajectory, the acceptance targets are:

- Stable-day environment generation GPU cost per second reduced by at least 30% versus the recorded baseline. Also report total whole-frame cost including blend samples; a lower bake count alone does not pass.
- Whole-frame median and p95 GPU times do not regress beyond measurement noise (provisional upper tolerance 3%); report p99/max and capture/filter-associated spikes rather than hiding them in an average.
- Routine environment work averages at most 10% of the configured frame budget. Target no routine update stage above 15% of that budget; unresolved PMREM spikes explicitly block the spike claim.
- Frozen-state rebuild count is zero after warmup; fast-forward performs zero suppressed-frame environment captures and one newest-state reconciliation when presentation resumes.
- No progressive resource growth across repeated time/quality/context cycles; no shader errors, invalid texture feedback, or persistent stale generations.

Use at least three matched 60-second live runs after warmup, including stable day, twilight, and night. Keep adaptive scale fixed for cost attribution, then repeat the accepted design with normal adaptation to check gameplay behavior. Record hardware/browser, actual drawing-buffer dimensions, quality, frame cap, clock/time scale, cloud state and allocations. Targets are design gates, not a claim that this checkout or every device can meet them.

## 9. Acceptance evidence

Offline tests exercise production state/scheduler contracts, not only copies of their formulas: daylight regression outputs; dawn/dusk continuity; lunar phase/altitude invalidation; frozen-state reuse; all-face snapshot immutability; request coalescing; age deadlines; generation pairing; mid-blend jumps; resource ownership; and suppressed-presentation behavior. Run typecheck/build and relevant existing lighting tests. These checks do not establish shader appearance or GPU performance.

Browser evaluation was explicitly authorized for integration acceptance. Use the opt-in development review tooling, with the actual state recorded next to each capture.

| Evaluation | Required evidence |
| --- | --- |
| Daylight preservation | Matched 07:24/09:00/12:30/17:00 captures; direct-light/exposure telemetry and unchanged glitter model; inspect sun-facing water and shaded deck/sail |
| Calibration | Neutral gray/white rough surfaces, a roughness sweep and reference ship materials; direct-only, environment-only and combined HDR samples; fixed exposure first, normal adaptation second |
| Continuity | Live dusk/dawn clips across normal cache updates and source handoff; inspect reflectors, rough surfaces, water and haze together; no cube-face seams or cache flashes |
| Night | New/quarter/near-full/full moon fixtures including moon below horizon; inspect broad sea sheen, sail readability and practical-light color |
| Movement | Deck, shore, eagle/camera movement and spatial teleport; no rebake for yaw alone; large cloud-field changes eventually represented |
| Lifecycle | Pause/resume, long fast-forward, abrupt time/phase/weather changes, mid-blend jump, quality rebuild and context restoration |
| Visibility guard | Moon and stars behind terrain and raised sail; this verifies a separate occlusion contract and is not evidence of skylight-cache correctness |
| Performance | Matched full-frame runs and isolated stage timings, including blend overhead, allocations and exceptional jump cost |

For stationary neutral references, adjacent normal cache publications should produce less than a provisional 2% discontinuity in measured linear luminance above a dark-scene floor; dark values use an absolute tolerance established from the recorded baseline. Separately compare cached and forced-current lighting at identical world state and fixed exposure on shaded reference surfaces, water reflections, underwater scattering and haze. Start with a 5% relative luminance-error target above the dark floor, report RGB/color differences and temporal lag, and tighten or revise tolerances from the approved references. Spatial cloud detail needs matched images in addition to aggregate statistics. Smooth publication alone does not pass an accuracy check. Tune input thresholds from these comparisons; do not treat an input proxy as proof of perceptual equivalence.

## 10. Implementation sequence and stop conditions

1. Record the working-tree baseline and interrupted experiment disposition; add instrumentation and a forced-current reference mode. Measure recurring capture/filter cost and whether publication pops are actually visible. Define neutral fixtures and identify radiance/shadow coupling problems before changing cadence.
2. Centralize live inputs and isolate capture snapshots. Preserve output, add complete-bundle publication and invalidation, and skip suppressed-frame GPU work. Keep stock capture/PMREM as the simplest verified reference.
3. Tune semantic thresholds within age/error bounds. Add face staging for measured spikes and matched crossfade for demonstrated temporal steps. Re-measure total cost before retaining either feature.
4. Calibrate source/sky/material relationships using neutral HDR fixtures, then approve the art direction with the morning-water references. Change radiance scales before exposure/grade; every changed coefficient has a stated reason and evidence.
5. Complete explicitly requested visual/performance acceptance and document the selected policy, measurements and remaining limits.

Stop expanding scope if extra sampling consumes the savings, the required PMREM spike cannot meet budget, or high-quality daylight degrades. Retain the simpler validated design, revise its budgets or propose a separate rendering change with evidence. Do not silently move to general GI or rewrite the ocean/cloud model.

## References

Installed Three source is authoritative for this checkout: `node_modules/three/src/extras/PMREMGenerator.js`, `src/cameras/CubeCamera.js`, and `src/renderers/shaders/ShaderChunk/envmap_physical_pars_fragment.glsl.js` under that package. PMREM filtering and roughness use are described in the [official PMREM documentation](https://threejs.org/docs/pages/PMREMGenerator.html). Renderer state, color space and statistics APIs are described in the [official WebGLRenderer documentation](https://threejs.org/docs/pages/WebGLRenderer.html). External docs explain APIs; they do not establish this app's measured performance.
