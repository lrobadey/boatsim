# Production acceptance update

The 31-asset kit is now integrated into the starting harbor of the actual game. The Kyrenia merchant uses the authored shell and linen, retaining game proportions and movement. `../docs/environment-review/ormos-production/README.md` records production builds, geometry / terrain / docking regressions, live trading, warehouse walking, boarding in both directions, cast-off / sail deployment, and the browser views. Master Blender sources and compressed assets were refreshed; runtime geometry validation passes for 42 files.

The earlier audit below documents prior asset counts and inspection-only stages.

---

# Latest visual direction: restrained material clarity

The user asked to retain the minimalism while making close views less messy. The implemented direction is recorded in `VISUAL-LANGUAGE.md`: clear forms and construction, quieter color and micro-normal variation, consistent masonry edges, and selective functional details. Roof overlaps now have real separation rather than coplanar strips; inspection shadows fit individual asset bounds, eliminating the coarse triangular self-shadow artifacts on pottery.

All 29 assets were reloaded from the packaged build without recorded browser errors; screenshots in `evidence/browser/` now show the clarified version. Matched selected references are in `evidence/clarity-before/` and `evidence/clarity-after/`. Export validation, typecheck and production build pass. Earlier file sizes and visual-pass notes below describe the previous build; current sizes are authoritative in `evidence/packing.json`.

---

# Toolkit acceptance — 2026-10-13

The user's current deliverable is a reusable asset toolkit for future game implementation. This pass implements that toolkit and a subsequent visual improvement/recheck pass. The prior standalone harbor study remains separate.

## Verified

- 29 stable asset IDs; 40 packed GLBs; 13 semantic PBR materials.
- Editable full Blender master and 29 per-asset collection libraries, deterministic recipes and texture masters.
- Packed geometry decoded with the same Three.js meshopt decoder used at runtime. Finite attributes, index ranges, actual bounds, source/image references, file hashes, anchor node names/positions, and LOD reduction pass.
- Snap position and opposing normals pass under translated/rotated parent frames with uniform scale.
- All 29 assets load and render from the production build at localhost:5188; zero recorded console errors or warnings. All seven distant variants load successfully.
- Live mesh collision overlay and placement-anchor overlay inspected. Assembled berth uses three snapped quay sections, separate fixtures/building/boat, rigid gangplank placement and instanced amphora cargo.
- Strict TypeScript check and Vite production build pass. Browser screenshots in `evidence/browser/`; one-by-one assessments in `VISUAL-REVIEW.md`.
- Referenced runtime model bytes: 12,788,800; shared texture bytes: 15,497,636. These are transfer sizes, not GPU memory measurements.

## Visual improvement pass

Rebuilt both olive trees and shrubs; opened the basket and added weaving/handles; repaired curved amphora handles and body UVs; improved roof relief, plinth returns and tower proportions; refined the mooring stone and joined bench; corrected rock proportions, shading and shared-edge tessellation. The boat retains the liked silhouette and detailed construction, and benefits from the repaired rope/pottery primitives.

## Integration boundaries

No game source or production game asset was replaced. The boat is scenic, not a calibrated playable hull. Collision shapes are metadata/meshes, not registered physics bodies. Buildings and boat have no distant mesh yet. Target-device performance, game shader compatibility, walking/collision behavior and full game lighting remain integration checks. The kit is usable for implementation; these checks are not claimed complete.

Current inspector: http://127.0.0.1:5188/ (production build). Development inspector: http://127.0.0.1:5187/. Servers must be restarted if the process ends.
