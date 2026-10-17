# Cloud opportunities after the foreground rollback

October 15, 2026. Investigation only: production shaders unchanged; no new browser run or speedup measurement. Findings below are checked against current source and prior local captures. Astra independently reviewed the density and lighting marcher; its detailed notes are in cloud-next-opportunities-astra.md.

## Recommended first experiment: improve sunlight sampling at the same ray budget

Each contributing view sample integrates sunlight through three nearby intervals, then four broader far intervals (`src/gfx/cloudModel.ts:143–177`). The nearby intervals are [4,20], [20,84], [84,300] metres. Their midpoint densities call vcDensity, which forces shape LOD0 (`:109,162`). The view marcher already filters its shape samples according to integration length and pixel footprint (`src/gfx/clouds.ts:93,108`); the near-light path does not.

The third sunlight sample represents 216 metres but reads the finest 56.25-metre base shape voxels. A half-interval footprint would select shape LOD about 0.94 instead of zero. This is a concrete sampling inconsistency. It may cause unstable or unrepresentative internal shading; the actual visible severity has not been observed in this pass.

Proposal: derive an explicit footprint for near-light integration, filter shape/weather appropriately, and avoid detail finer than that footprint. Retain all three near and four far intervals, the local-density segment, and the existing distant-light policy. This adds no rays or texture lookup instructions in principle; actual filtering cost and shader execution still require measurement. LOD0 is not the proposed general production policy.

Acceptance: compare cloud depth and silhouettes, internal shading and silver linings at noon, dawn and near-horizon light; include wind and camera motion. Use a denser offline/temporary reference to check extinction rather than assuming smoother shading is more correct. Separately measure cloud-stage GPU cost and normal frame pacing. The earlier implicit-weather diagnostic supports explicit footprint control, but does not validate this new design.

## Best bounded performance hypothesis: reuse only broad sunlight estimates

For every occupied fine view sample, the marcher repeats four far-light density estimates. A cell has two or three fine samples in Ultra, so a fully traversed occupied cell may repeat the far calculation two or three times (`clouds.ts:99–116`). Those four intervals are intentionally broad and filtered, making them a better reuse target than the local light calculation responsible for sharp cloud shading.

Proposal: separate local/near optical depth from far optical depth and investigate limited reuse of the far term between nearby view samples. Keep view density, transmittance and local/near lighting fresh. This is an approximation, not exact redundant work removal: the far light paths originate at different positions, can meet different cloud structures and can leave the shell at different distances.

Do not equate one cell with a safe reuse distance. Near the horizon, the capped 26 km traversal over 72 cells produces cells about 361 m long; lower quality and exact fallback can have still larger cells. Gate reuse by spatial separation, light-path changes, and geometry rather than merely cell identity. Preserve the existing optical-depth early termination.

First measure a dev-only far-light ablation to establish its cost ceiling. Only implement reuse if that ceiling is meaningful. Require matched motion comparisons at cloud boundaries, low sun, dense clouds and in-cloud eagle views, plus integrated GPU and uninstrumented pacing measurements. No saving percentage is established.

## Small confirmed quality defect: fallback haze skips environment blending

The normal cloud march registers with environmentMaterials (`clouds.ts:378`); CloudPass does not. Its embedded CLOUD_GLSL therefore defaults SKY_ENV_BLEND to zero, even while the normal marcher uses both environment endpoints (`clouds.ts:24–47`). The exact fallback near a mast/coast silhouette can use different haze during transitions.

A fresh headless construction of production Clouds and CloudPass confirmed: one registered material; after enabling blending the march define is 1 while the composite define is absent. This establishes the missing shader variant contract, not the visual prominence of a seam. Fixing it would use an additional cubemap sample on affected fallback pixels during transitions; exact performance neutrality is not promised. Verify both variants, sampler capacity, and transitions before acceptance.

## Smaller cleanup and larger future work

- Resolve computes its 3x3 neighborhood bounds before loading history radiance and rejecting it on opacity/luminance disagreement (`clouds.ts:243–260`). Moving that rejection before the neighborhood can avoid up to nine source texture calls for those rejected pixels. This is bounded, probably small, and should not distract from lighting cost; hardware savings depend on shader execution and rejection frequency.
- Temporal history currently stabilizes a fresh ray at every low-resolution pixel every frame (`clouds.ts:543–546`). Interleaving fresh rays could be a larger architectural opportunity, but needs confidence/disocclusion/lighting refresh and different neighborhood reconstruction. Do not simply skip alternate frames.
- Full-resolution fallback remains worth measuring separately. Prior foreground work proved that source operation counts alone overstate some opportunities and that early exits can affect neighboring sampling. Retain that lesson.

Recommendation: try the near-light footprint experiment first if the goal is better clouds at a similar budget. Measure broad sunlight cost next if the goal is a substantial speedup. Keep the rejected foreground shortcut rolled back.
