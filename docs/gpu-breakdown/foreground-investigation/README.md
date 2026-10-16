> **Current status:** the foreground shortcut was benchmarked and rolled back after a small saving and failed exact image comparison. See [measured-impact.md](measured-impact.md). The proposal and initial implementation notes below are historical.

# Proposed foreground cloud early-out — investigation only

October 15, 2026. No renderer or gameplay change was made for this investigation.

## Concrete proposed change

Insert an early return in CloudPass's final composite after it reads the scene color and reconstructs scene distance, but before the four-tap cloud/depth loop:

- Require an actual positive foreground distance; sky sentinel -1 must never qualify.
- Require the camera to be below the cloud base.
- Require that foreground distance in metres is strictly less than cloud-base altitude minus camera altitude minus a conservative numerical guard.
- Return the original scene color for qualifying pixels, without reading cloud radiance/metadata or invoking the fallback ray march.
- Keep all existing reconstruction and fallback paths for every nonqualifying pixel.

The candidate guard examined here is 8 m. It is a numerical cushion, not a new visibility cutoff or artistic cloud parameter. A production implementation should use the shader's existing C_BOTTOM constant and uCloudOrigin altitude, not duplicate the cloud-base value in TypeScript.

Start with only this final composite change. Do not simultaneously skip the low-resolution preparation, alter its metadata/history, change clouds themselves, or rewrite silhouettes; those are separate opportunities with more interactions.

## Why the geometric rule is safe

The cloud layer is a spherical shell. At the camera's horizontal origin, the radial distance to its bottom is C_BOTTOM - camera altitude. Any route to that shell is at least that long: the triangle inequality bounds radial increase by travelled distance. A nearer opaque surface ends the visible route before any actual cloud can occur. No ray direction or camera pitch is needed for this conservative first rule.

The rule is sufficient, not necessary: many more distant objects also lie before the cloud layer along their particular view directions. They stay on the original path to keep the first change small.

Current constants from src/gfx/cloudModel.ts are Earth radius 6,360,000 m and cloud base 1,400 m. At a 7 m camera altitude, the candidate rule accepts positive foreground depths strictly below 1,385 m (1400 - 7 - 8). The guard deliberately leaves an unoptimized strip near the boundary.

## Why a numerical guard matters

The full-resolution destination distance is reconstructed from scene depth, while cloud metadata stores the source clip distance in half-float kilometres. The composite accepts source distances up to the destination distance plus max(1 m, 0.1% of destination distance). Half-float packing can also round a source distance down. A completely unguarded ideal geometric test would not explicitly account for these existing reconstruction tolerances.

For the current camera range below the cloud base, relevant destination distances are at most roughly 1.4 km. The tolerance is therefore about 1.4 m or less, and binary16 spacing near that range is about 0.98 m. The 8 m candidate margin comfortably exceeds their combination and leaves room for other floating-point effects. It has not been certified by executing the actual shader across GPU implementations.

The temporal resolve copies current depth metadata. When the fresh current ray is clear, it returns that clear value before history blending, so genuinely cloud-free source samples do not retain an older cloudy color. Accepted neighboring samples still need to be examined during browser comparison, especially at silhouettes.

## Systems affected and preserved

- Nearby water, ship, quay and land can qualify.
- Reflected clouds, cloud shadows and atmospheric lighting already present in the original scene color are preserved; this shortcut changes only the later cloud overlay calculation.
- Sky and all uncertain pixels keep the original path.
- Eagle mode reaches 1600 m, inside the cloud layer. The early-out is disabled there so local clouds remain visible.
- Cameras below sea level and just below the cloud base are covered by the predicate; the numerical guard conservatively disables it near the base.
- The two scene-depth conventions already handled by sceneDistance (ordinary and reversed depth) share the same final world-distance predicate.
- Transparent objects generally do not own the opaque depth used here. The decision follows the scene depth the existing cloud composite already uses; it must not be replaced with a new approximate object-distance test.

## Offline probe and evidence limits

Run `node docs/gpu-breakdown/foreground-investigation/probe.mjs` from the checkout. It reads the production shell constants, uses deterministic synthetic camera heights, foreground distances and ray directions, and packs neighboring source distances through Three's actual half-float conversion.

Result: 168,000 constructed geometric cases, with 40,703 eligible for the candidate shortcut, plus 814,060 neighboring depth-packing checks. No admitted route reached the cloud shell before the foreground surface; no admitted neighboring source tap reached the cloud base under the modeled acceptance rule. Explicit cases cover the sky sentinel, strict guard boundary, near mast/water and cameras inside or above clouds.

This checks a geometric reference and metadata precision, not compiled GLSL execution, image equality, real screen coverage or GPU speed. Synthetic eligible fractions must not be interpreted as percentages of game pixels.

## Expected work reduction and acceptance plan

A qualifying composite pixel keeps two sampling calls (scene color and scene depth), avoids the four cloud-radiance and four metadata sampling calls, and avoids the exact fallback ray when it would otherwise be taken. It does not save the upstream low-resolution ray march or environment work. Thus eight avoided sampling calls per qualified pixel does not mean an 80% reduction in game rendering cost.

Before accepting an eventual implementation:

1. Instrument a read-only eligibility mask to measure qualified screen coverage in boat, shore and eagle views.
2. Compare candidate/original pixel output and silhouette crops at fixed weather/camera, including ordinary/reversed depth, waves, fog, glass/transparent objects, the horizon and a camera crossing the cloud base.
3. Confirm no skips occur for sky or in-cloud cameras.
4. Time the composite in isolation and run the same normal-pacing A/B method used for the duplication fix. Evaluate GPU branch coherence too; fewer source operations are not by themselves a measured speedup.

The candidate is ready to implement as a small local shader change when authorized. No performance number or visual acceptance is claimed yet.

## Implementation follow-up — October 15, 2026

Implemented the final-composite-only shortcut in src/gfx/cloudPass.ts after user authorization. It uses the existing C_BOTTOM/uCloudOrigin inputs, requires positive foreground distance and a below-base camera, and retains the 8 m guard. It returns the existing RGBA scene value before cloud taps. Upstream cloud preparation, history, reflections, lighting and fallback behavior for all other pixels are unchanged.

The skylight suite now includes scripts/test-cloud-foreground.mjs, which exercises the production shader's scalar predicate, its early-return placement, boundary cases, both depth conventions, spherical-shell geometry and half-float neighboring-depth acceptance. Skylight tests, typecheck, production build and diff whitespace checks passed. No post-change browser visual comparison or GPU/FPS benchmark was run in this implementation step.
