# Sky/cloud efficiency audit — October 15, 2026

Scope: source audit of the current checkout after disabling the screen-sky cloud march. No additional production changes and no new browser benchmark in this audit. Earlier measured millisecond costs belong to their saved fixtures. New opportunities below have not been assigned invented FPS gains.

## What is already doing useful work

- Screen clouds render at a fraction of the drawing-buffer dimensions (Ultra: 0.5 per axis, one quarter of the pixels), then use depth-aware reconstruction.
- The ray marcher skips empty coarse cells, stops at low transmittance, clips against scene depth, filters shape sampling using mip levels, and confines expensive erosion to cloud edges.
- Cloud sunlight integration has fixed near/far budgets and optical-depth early exits.
- Reflection/lighting captures use two retained bundles, frozen inputs for coherent cube faces, one raw face per staged update, mip generation only at the final face, and reuse existing PMREM targets. Do not misdiagnose these as six full cloudy cube captures every frame.
- Cloud shadows are throttled to about 15 updates/second unless camera/lighting invalidates them.

## Priorities

### 1. Exact foreground early-outs in cloud preparation and composition

Source: src/gfx/cloudPass.ts:55-99; src/gfx/clouds.ts:164-192; cloud shell bounds in src/gfx/cloudModel.ts.

The full-resolution composite reads the scene and its depth, then four cloud radiance taps and four cloud metadata taps. Only after validating the footprint does it return the normal composite or trace an exact fallback ray. The low-resolution preparation samples scene depth nine times before vcMarch can reject an Earth-occluded or otherwise empty cloud interval.

For a camera below the 1400 m cloud base, a visible foreground surface closer than (1400 - camera altitude) metres cannot have a cloud between it and the camera, regardless of view direction. The composite could return the original scene before cloud taps for that exact case. A directional shell-intersection test would cover more pixels, at greater arithmetic cost. In the preparation pass, rays that provably cannot reach the cloud layer can produce explicit clear metadata without the nine scene-depth samples.

This is exact work avoidance, not lower cloud quality. Care is needed to preserve metadata/history conventions for clear pixels, above-cloud and in-cloud cameras, reversed depth, the horizon and edge reconstruction.

At the previously tested full-Ultra buffer (3024 x 1386):
- 4,191,264 full-resolution pixels.
- Current composite has 10 explicit 2D texture-sampling calls per pixel before fallback (about 41.9 million shader-level calls). This is a source operation count, not physical DRAM transactions; caches/compiler/hardware matter.
- The low-resolution pass has 1,047,816 pixels and nine depth taps each (about 9.43 million shader-level depth calls).
- An early-return foreground pixel in the composite needs the scene/depth reads but avoids eight cloud/metadata taps.

The fraction of pixels eligible for these early-outs has not been measured. First instrument an eligibility/fallback mask.

### 2. Full-resolution fallback is an unbudgeted exception to the low-resolution design

Source: src/gfx/cloudPass.ts:66-97.

When every reconstructed tap is rejected, the full-resolution composite calls vcMarch with a 24-cell setting. This preserves coast, mast and rigging silhouettes and must not simply be deleted. However, there is no counter or visibility into how often it happens. Dense rigging, terrain silhouettes and conservative 3x3 low-resolution depth footprints can widen the rejected footprint. A 24-cell setting can evaluate up to 72 fine view samples plus empty-cell probes and per-sample sunlight integration; it is not a single cheap sample. Rays terminated before the cloud base exit cheaply, so fallback count alone is insufficient: distinguish entered-cloud fallbacks from cheap empty ones.

Measure its mask, entered-cloud fraction, and separate GPU cost before changing the reconstruction tolerance, adding a near/far representation, or caching edge corrections. The goal is to preserve silhouettes while keeping expensive work sparse.

### 3. Temporal history buys stability, not a reduction in fresh rays

Source: src/gfx/clouds.ts:183-192, 213-264, 537-548.

Every low-resolution pixel traces a fresh cloud ray every frame. A second pass then reprojects and blends last frame's result, including camera movement, wind shear, depth checks and neighborhood clamping. That is legitimate antialiasing, but the costly fresh ray is already complete before history is considered.

Potential larger improvement: interleave a subset of fresh rays and reconstruct the others from valid history; immediately refresh newly visible/rejected pixels. This requires a design change to resolve logic because its neighborhood bounds currently assume a fully freshly rendered current frame. Risks include ghosting, silhouette lag, cloud lighting changes, and horizon instability. Do not treat it as a one-line frame-skipping optimization or a guaranteed fraction of whole-frame savings.

### 4. Sunlight integration is repeated inside occupied view samples

Source: src/gfx/clouds.ts:108-127; src/gfx/cloudModel.ts:145-176.

Each occupied fine view sample can run another three nearby density samples plus four coarse far-density intervals to estimate sunlight attenuation. Adjacent camera rays repeatedly evaluate overlapping parts of the same slowly evolving cloud volume. This is a plausible major arithmetic/texture cost, but its share is not separately measured.

A lower-frequency lighting representation or cached light transmittance could reuse that work. This is a larger change with visible consequences for silver linings and internal shading. First profile a diagnostic with simplified light integration, then define a fidelity contract. Prioritize exact early-outs and fallback investigation before a new volume cache.

### 5. Environment filtering still lands on a single frame

Source: src/gfx/skyEnvironment.ts:323-339, 419-427, 517-533.

Raw cloudy cube faces are staged correctly, with mip generation only on face 5. The last face also immediately calls finishBundle, which runs PMREM filtering synchronously in that frame. Thus captures are spread out but the final filtering burst is not. Initial/forced captures also intentionally render a complete coherent generation immediately.

Potential benefit is fewer tail-latency spikes, rather than a large steady-state FPS gain. Time capture-face and filtering separately before introducing delayed filtering/publication. Continue serving the previous complete bundle until a candidate is finished; preserve the current atomic publication and age/deadline contracts.

### 6. The cheap sky background still shades pixels that opaque geometry overwrites

Source: src/world/sky.ts:168-170; stars already use far depth in the same file.

The visible sky renders first with depthTest=false. After the duplication fix this is analytic atmosphere/celestial work rather than a cloud ray march, so do not expect the previous 6 ms saving again. A sky rendered after opaque geometry at the far depth, without depth writes, could avoid many hidden background fragments. It needs correct reversed-Z coordinates and ordering relative to transparent stars and objects. Simply moving renderOrder while leaving depth testing off would cover foreground objects and be incorrect.

Do not replace the screen sky blindly with the existing 32 x 32 clear cube: that cube is a low-frequency haze input and its sun disc is deliberately disabled. Preserving celestial discs and horizon quality requires more than reusing that texture.

## Smaller concrete findings

### Invisible daytime stars are still submitted

src/world/sky.ts creates 6000 star points and makes their brightness zero through uNight. updateLighting never sets stars.visible=false at zero visibility. The draw, vertex work and covered point fragments still occur. Skip the object while visibility is exactly zero. This is a low-risk small cleanup; no measured millisecond saving is claimed.

### Shader warmup does not explicitly cover every cloud subpass

Game.prepareLightingShaders compiles main/refraction/reflection material variants and calls Clouds.compileEnvironmentVariant. The latter compiles only the ray-march scene, not resolveScene, shadowScene, or CloudPass's reconstruction/fallback material. The boot sequence runs the game behind the loading overlay for 250 ms, so some missing programs may compile there, but that is not explicit variant coverage. Extend targeted warmup if cold shader traces show relevant stalls; this addresses startup/transition smoothness, not a proven steady-state bottleneck.

### Confirmed fallback haze crossfade mismatch

src/gfx/cloudPass.ts includes CLOUD_GLSL but does not register its material with registerEnvironmentMaterial. CLOUD_GLSL defaults SKY_ENV_BLEND to 0, so that fallback shader samples only uCloudHazeSky during environment transitions. The normal low-resolution cloud material is registered and samples the blended pair. The already-bound shared uniforms alone cannot enable a branch that was compiled out.

A headless runtime check constructed the production CloudPass, enabled the environment transition globally, and confirmed its material did not register, its blend define remained absent, and its shader selected default blend mode 0. This is a source/contract-confirmed consistency bug in the exact fallback haze, not a measured large performance opportunity. Correct it while profiling fallback behavior and check sampler capacity and both compile variants.

## Recommended sequence

1. Instrument cloud subpasses and masks: low-resolution march, temporal resolve, composite, expensive fallback fraction, and environment filtering.
2. Add exact no-cloud early-outs and skip invisible stars; compare identical scenes.
3. Repair the fallback environment blend mismatch and verify transition edges.
4. Address whichever measured cost dominates: reconstruction exceptions, fresh ray rate, or repeated sunlight integration.
5. Investigate sky far-depth rendering and PMREM scheduling if their isolated cost or frame spikes justify the complexity.

No additional runtime changes were made for this audit.
