# Production integration is now implemented

The actual game now uses the new assets at starting harbor id 0 and installs the compatible merchant shell and linen. See `../docs/environment-review/ormos-production/README.md` and the newest root `handoff.md` section. The standalone study remains the authoring / presentation fixture. Its Blender master and distributable kit references were refreshed after solid gables and merchant inner lining were added.

Older statements below about default game appearance remaining unchanged are historical.

---

# Latest pass: clarified landscape and compatible merchant

The user's latest instruction requires the boat to retain the proportions and function of the existing game boat, with the restrained toolkit style. The user-confirmed target is the Kyrenia merchant (13.7787 m hull, 4.216 m beam), not the separate 17 m scenic boat. See `harbor-kit/MERCHANT.md` from the repository root. A new Blender `merchant-shell` and `createMerchant(kit)` adapter are implemented. Default game appearance is unchanged; game physics definitions are untouched. The game model now exposes reversible static-shell and sail-surface hooks, and sail shadows follow the visible deformation. Geometry compatibility, typechecks, builds and the cargo/hold regression suite pass. Full game navigation/boarding acceptance remains outstanding.

The study landscape now uses 182 kit placements in 55 spatial batches. Repeated giant rocks were replaced by subordinate outcrop groups, continuous terrain shoulders and a quiet upper orchard path. Olive crowns are fuller. Water no longer exposes the underwater terrain patch as a bright triangle. The scenic gangplank preserves its upward direction and rigid length when reversed. The current study bundle is about 46.5 MB of referenced models and textures.

The 21-view desktop lighting audit is under `harbor-study/evidence/acceptance/`; late-light fill and canopy folds were subsequently refined. A 390 by 844 desktop viewport check found no horizontal page overflow and settings fit; this is not physical-phone performance evidence. Mobile hides the keyboard-only walk control and uses touch navigation hints. Walk geometry tests pass. Broad goal remains active until remaining visual and interaction acceptance is reconciled with the new merchant requirement.

Older entries below describe earlier states; their instance counts and statements of no game-source changes are historical.

---

# Latest: toolkit-backed study and restrained visual language

The user's latest direction is to preserve the appealing minimalism and clarify close-up forms/materials. Read `../harbor-kit/VISUAL-LANGUAGE.md`. This supersedes the earlier emphasis on adding more wear/noise/detail.

The study now uses the verified toolkit for the scenic boat, gangplank, 423 rock/tree/shrub placements in 71 spatial batches, and shared geometry/material primitives. Each spatial group uses near/distant meshes. `tools/sync_authoring.py` synchronizes reviewed primitives and palette from the kit without replacing the study layout. The study Blender master includes collection instances for the planted/rock assets. Boat silhouette remains preserved; no game integration or sailing physics changes.

Build order from repo root:
1. Rebuild and pack `harbor-kit` first after authoring edits.
2. `python3 harbor-study/tools/sync_authoring.py`
3. `/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P harbor-study/blender/build_harbor.py`
4. `node harbor-kit/tools/pack.mjs harbor-study`
5. `node harbor-kit/tools/validate.mjs harbor-study`
6. `npm --prefix harbor-study run build`

Assets are now served as a relocatable public manifest/models/textures bundle, with lossless meshopt geometry and deduplicated textures. The old embedded GLBs and texture masters are preserved in `archive/pre-toolkit/`. The current bundle is about 45.1 MB of referenced models/textures; exact bytes are in `evidence/packing.json`. The rigid 3.6 m gangplank now retains unit scale and slides its landing contact slightly with scenic boat motion. Instanced wetness shaders account for instance transforms.

Browser rechecked court, boat and overview at afternoon, with no logged errors/warnings. Evidence: `evidence/kit-clarity/`. Local overview at the current small viewport reported about 118 fps, 448 draws and 6.69 million triangles across passes, 36 textures. This is local cadence, not target-device/GPU performance proof. Reuse reduced stored duplication; it did not establish a lower draw budget.

The full production goal remains open: the broad inland terrain and shoreline arrangement need a deliberate compositional pass; mobile/control gates and full time-of-day/performance acceptance are still outstanding. Basic ashore walking now follows the exported terrain triangles and wall/fixture proxies; `node harbor-study/tests/walk.mjs` verifies the open warehouse doorway, facade obstruction, stairs in both directions, cargo obstruction, and quay drop boundary. Live browser checks confirmed Shift+W sprint, rightward drag direction, and Escape return. This is bounded scene inspection, not game physics or boat boarding. Do not claim the whole harbor production-ready from the narrower kit/style checks. Preserve the restrained language while addressing those gaps.

---

# Current direction: reusable toolkit

The user clarified that the deliverable is a reusable asset library for future game implementation, then requested a visual audit/improve/recheck pass. The result is now in `../harbor-kit/`; start with its README, INTEGRATION and ACCEPTANCE documents. Its sources are independent of this study. Edits to the kit do not automatically rebuild this older assembled scene. The scenic boat silhouette remains the user-approved direction, but is not the playable merchant. Production toolkit inspector: http://127.0.0.1:5188/.

---

# Ormos harbor study — handoff

## Latest continuation: harbor and boat refinement — 2026-10-13

This section supersedes the older implementation/verification status below. The user authorized an ambitious Blender refinement, explicitly requested browser inspection, then asked to include the boat and do another clear pass. **They said they like the separate scenic boat. Preserve its silhouette and keep it available; do not silently substitute the game's merchant or claim this is the playable ship.** No game integration was requested.

Implemented and regenerated the Blender master and all three GLBs:

- Irregular masonry edges and damp lower courses; twisted rope fenders; richer directional wood grain; smoother amphora bodies/handles; proper recessed window openings and a corrected front gable winding.
- Warehouse doorway now exposes a modeled interior with jar racks, floor and framing. Canopy has folds, seams and a hanging hem. Pegs, stone post shoes, woven baskets, a packing rack, linen rolls and coils enrich the loading court. A timber trellis connects two waterfront buildings.
- Partly buried rock ledges have subdivided fracture relief with angle-separated normals. Added rooted tree forms and coastal shrubs. Continuous ground tint and larger earth UV scale remove the old per-grid-cell checkerboard.
- Boat preserves the original 17 m scenic hull/sheer. Added solid inner/outer plank surfaces, narrow caulking seams, frames, curved stem/stern, mast partners, pins, rigging blocks, tied furled cloth, cargo retainers and a quarter steering oar. Fixed outward hull winding and deck boards protruding through the hull: widths now derive from hull width at the deck's actual height. Analytic check found at least 0.130 m outer-hull clearance for the 31 deck boards at sampled corners/centres.
- Runtime mooring lines now have mesh thickness. Added a seventh **Boat** camera (`#boat`), corrected Shoreline framing, and scrollable narrow-screen camera navigation. Replaced distant half-sphere islands with irregular radial ridges.
- Lighting fix verified live: exclude `showSunDisc` during sky PMREM generation and reduce sky environment intensity from .45 to .065. The sun-disc change alone was insufficient; reducing HDR sky illumination produced the major improvement in surface/shadow separation. Hemisphere reduced to .24 at afternoon, fog density .0018. These values are study-specific, not a calibrated recipe for the game.

Browser inspection initially failed on URL selection. After the user explicitly requested inspection again with the tab open, normal inventory and selection of the existing tab succeeded. This is no longer a blocker. Current session binding was IAB browser `2`, tab `1`; rediscover if stale. No alternate browser or CDP workaround was used.

Verification:

- Visually inspected live berth, court, shore, overview, approach and boat, and overview at noon/afternoon/late sun. Final boat screenshot confirms fitted deck and new detail. Camera/settings controls were exercised; exhaustive walk/collision/mobile tests were not done.
- Final browser log had no warnings/errors; canvas `data-errors=[]`. Boat view reported approximately 120 displayed fps, 169 draws and 4.55 million triangles across passes, 54 textures at the current small viewport. This is not GPU timing or a portable performance guarantee.
- Final Vite production build passes. Export header/accessor sanity checks saved in `evidence/refinement-v2/asset-check.json` (finite position/normal data).
- Final live captures: `evidence/refinement-v2/browser-boat-final.jpg`, `browser-court.jpg`, `browser-shore.jpg`. Court/shore captures precede the last ground/boat refinements. Neutral Blender images in this folder are intermediate v2 evidence, not final runtime captures. Original review images remain in `evidence/asset-review/`.
- Original master/script/runtime preserved in `archive/first-study/`; the liked boat before this detail pass is `archive/first-study/boat-before-detail.glb`.

Remaining: harbor GLB about 92.4 MB, boat 6.04 MB; no compression/LODs yet. Terrain transitions, distant vegetation density and overall settlement richness remain below the ambitious final quality bar. New trellis, props and shrubs are visual details without new fine-grained walking colliders. Boat remains scenic, with no sailing physics. Do not claim production acceptance or main-game integration. Work is uncommitted.

Updated 2026-10-13, America/Los_Angeles. The user asked to wrap up because they had to leave. **This is a working first scene, not an accepted production-quality result. Continue refining this study before integrating anything into the game.**

## User intent and authorization

The user dislikes the game's land/harbor/houses, especially the harbor. They want docking to look and feel good, with nice materials throughout. They approved the complete proposal in `../docs/environment-review/harbor-direction.md`: shoreline, a substantial working berth, warehouse/loading court, connected waterfront buildings, materials and a natural route inland. They explicitly requested Blender authoring and a standalone HTML study to work through the result before game integration.

The user explicitly answered **"Yes, browser-test the standalone scene"** in this chat. This is an exception to the project's general instruction to browser-test only when asked. Do not infer authorization to test or modify the main game from this. No game source or existing production assets were modified. Do not integrate this study without a later user instruction.

Latest user request: wrap up; update root handoff and add a new specific handoff here. This file is that handoff. No commit was requested or made.

## Start here

### Asset review continuation — 2026-10-13

The user requested reopening the preview, showing the new assets/materials individually, and a much more ambitious high-fidelity Blender direction. The preview server was restarted at port 5186. The app opener returned queued, but CUA inspection was rejected by its URL policy; live opening/rendering was not verified during this continuation. Do not route around that restriction.

Fresh offline Blender review images are in `evidence/asset-review/01-quay.png` through `04-shore.png`, generated by `blender/render_review.py`. These are CPU Cycles renders of the existing master under neutral lighting, with vertex Tint multiplied in the temporary material graph to match export intent. They omit runtime water, wetness, fog and boat placement. The script does not save changes to the master or regenerate assets. All four final images were visually inspected; the shoreline camera was corrected after an obstructed first render.

Review: the neutral renders improve tonal depth but expose uniform rounded masonry, shallow/repeated facade construction, coarse amphora silhouettes, sparse angular foliage and disconnected faceted boulders. Prioritize a hero berth with individually authored wear and joinery, a deeply modeled warehouse/loading interior, coherent bedrock outcrops and closer connected building fronts. Material detail must represent actual construction and weather exposure, rather than adding uniform noise. No visual upgrade or game integration was implemented during this review.

- Working preview: `http://127.0.0.1:5186/` (Vite process was left running for the user; do not assume it survives).
- Entry: `index.html`, `main.js`, `style.css`.
- Separate config: `vite.config.mjs`, local package scripts in `package.json`. Resolves Three/Vite from parent repo's installed dependencies.
- Build: from repo root, `node node_modules/vite/bin/vite.js build --config harbor-study/vite.config.mjs`.
- Dev: from repo root, `node node_modules/vite/bin/vite.js --config harbor-study/vite.config.mjs`.
- Portable static output: `dist/index.html` plus `dist/assets/`. Serve the whole `dist` folder over HTTP; it needs no CDN, game server or game source at runtime. It is not a single embedded HTML file and is not intended for file:// loading.
- Static alternative: `python3 -m http.server 5186 --bind 127.0.0.1 --directory harbor-study/dist` after stopping the existing server on that port.
- Editable Blender master: `blender/ormos-harbor.blend`.
- Deterministic authoring script: `blender/build_harbor.py`.
- Rebuild assets: `/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P harbor-study/blender/build_harbor.py`.
- Latest build log: `/tmp/ormos-blender-build.log` (temporary, may disappear).
- Screenshot of the handoff state: `evidence/overview-2026-10-13.png`.

## Implemented

Blender: broad 58 m stone waterfront, a return mole, individual paving/coping/course stones with bevels, ten sea steps, mooring stones, timber wale/rubbing strips, rope bundle fenders, warehouse and timber porch with linen canopy, cargo jars/racks/bench, six village buildings plus distant small shrine, roofs with individual curved overlapping tiles, parapets/shutters/doorframes, terrace retaining walls, inland steps and lane, shore outcrops/rubble, branching olive trees and scrub. Cargo boat and gangplank export separately for gentle motion.

Nine generated seamless texture families: limestone, paving, plaster, wood, terracotta, rope, cloth, earth, rock. Color, tangent normal, roughness. Construction joints come from geometry rather than competing texture masonry patterns. Everything is generated locally; no new third-party asset downloads.

Viewer: full-screen scene; six view buttons with eased transitions; orbit/pan/zoom; walking mode with WASD, drag-look, coarse building bounds and authored floor heights; sunlight slider and presets; water strength; motion pause; quality selector; material notes; screenshot download; hidden-UI mode; responsive CSS; loading/error UI. Water has planar reflection, screen-space refraction, depth absorption and ripples. Materials are kept from GLB (not replaced by the game's slot system); selected surfaces gain world-space wetness/salt shading. Boat motion is a scenic inspection aid, **not** the game's docking or sailing simulation.

## Verified vs not verified

- Latest Blender generation completed and saved the `.blend`; exports exist.
- Latest production Vite build passes. No main-game build or gameplay tests were necessary or run.
- Browser visually reviewed approach, alongside and overview. Scene loads and animated rendering runs. Latest screenshot is overview.
- No JavaScript or shader error was returned in the inspected browser log. One earlier warning about `PCFSoftShadowMap` was fixed by switching to `PCFShadowMap`; the tab's log still retains that old warning, timestamp 19:54:11 UTC. Do not report that retained entry as a new failure without checking timestamp.
- Latest visible overview telemetry at the small in-app viewport: about 120 fps, 205 render calls and 1.67 million rendered triangles across passes, 54 textures. This is local displayed cadence, **not GPU timing or cross-device acceptance**.
- All viewpoints, settings, screenshot download, walking route/collisions, narrow/mobile layout and reduced-motion behavior have NOT been systematically exercised. The user ended the work before acceptance. Do not claim them tested merely because they are implemented.
- Exposed inspection: canvas `#scene` has `data-ready`, `data-view`, `data-walk`, `data-camera`, `data-metrics`, `data-errors`; readable via browser DOM tools. A `window.harborStudy` object also exists but the browser's read-only evaluation sandbox did not expose it. Prefer DOM telemetry for checks.

## Visual acceptance remains the main work

The scene is coherent enough to navigate and critique, but **it still looks washed out and too much like a clean model**. The user asked for production quality; that bar has not been met. Do not settle for this screenshot or try to solve everything by adding more random geometry.

Priorities:

1. Diagnose lighting/material exposure under neutral light. The screenshot has very pale foliage, stones, plaster and land, weak contact depth and inadequate dark/light separation. Initial true bugs were fixed (double sRGB encoding and omitted plain material colors), but the final visual remains too bright/flat. Isolate sky PMREM intensity, hemisphere light, direct sun, fog and tone mapping; inspect shadows. Use a neutral gray sphere/material board and close-ups before tuning globally.
2. Improve compositional and architectural richness around the berth. Current buildings are still basic volumes, the quay is a very large bare paved rectangle, and the village has too much empty space. Strengthen the loading court, narrow routes, connecting walls and sensible purposeful clutter. Window recesses currently use shallow dark inset-looking surfaces/frame assemblies; front doors are actual wall openings, but don't assume full interiors. The user wants a believable place, not a collection of asset samples.
3. The rocks still read as faceted boulders. Rework larger coherent fractured ledges, selective smooth normals, coherent bedding and better terrain blending. Background land has visible repetitive surface texture and abrupt local terrace transitions. Some trees are sparse/bright; improve foliage silhouette, color and contact shadows.
4. Verify boat/quay/fender contact and plank endpoints closely. The boat is scenic, not controllable; do not claim actual docking mechanics were implemented. Rendered mooring lines are thin Three.Line objects; upgrade to proper rope geometry near the eye if needed. Check boat hull sidedness, strake gaps and rail joins.
5. Walk mode is preliminary: coarse building AABBs, floor patches, no prop-specific collisions, no robust walkable boat/gangplank route. Test route from quay up steps, shoreline edges and building blocking. Check drag-look signs. Currently no touch walking controls; mobile can orbit.
6. Optimize asset size and draw budget after visual decisions. `assets/harbor.glb` is about 51.1 MB, boat 2.35 MB, plank 0.56 MB. The harbor mesh has roughly 0.54 million authored triangles after increasing foliage. It is material/group-batched, but large raw geometry dominates the GLB. Use shared instanced trees/tiles, distance detail, fewer duplicated vertices and a suitable compression pipeline rather than simply destroying silhouettes. Textures are duplicated across separate GLBs. No LODs yet.
7. Compare all six cameras at noon/afternoon/late sun, close materials and waterline, wide and narrow viewports; save evidence and only then call it visually accepted.

## Technical traps / useful facts

- Blender 5.2.2 LTS is installed at `/Applications/Blender.app/Contents/MacOS/Blender`.
- Blender crashed in sandbox at Metal device detection, before script execution. Approved unsandboxed `exec_command` launches worked. This is not a Python/model error; inspect crash trace if it recurs.
- Native Blender coordinates: Z up, +Y inland. Exported glTF: Y up, -Z inland. Model units are metres.
- GLB material export initially lost plain material colors through an unsupported Multiply/vertex-color node path. Current materials connect direct Principled inputs; export explicitly uses `export_vertex_color='NAME'`, `export_vertex_color_name='Tint'`, `export_all_vertex_colors=False`. Mesh tint exports in COLOR_0. Blender's master material preview does not itself multiply the stored tint currently; account for that when comparing Blender renders with glTF.
- Initial image creation via bpy float pixels and save double-encoded intended sRGB values. `save_img` now writes literal PNG bytes with Python zlib/struct and loads the image into Blender with the appropriate color space. Color is sRGB; normals/roughness Non-Color. Do not regress this.
- Export JPEG quality 92 reduced texture payloads. Original PNG masters remain in `assets/textures/`. GLBs embed their runtime textures. The study does not fetch original PNGs at runtime.
- Blender is saved with scenic boat/plank objects hidden, plus a composed camera and sun; the exported boat and plank are positioned/animated by JS. Master has no ocean (ocean belongs to runtime).
- Procedural terrain height is duplicated in Python `hterrain` and JS `terrainHeight`; keep them synchronized. `assets/manifest.json` carries floor rectangles, building bounds, sockets and boat position.
- THREE r186 removed PCFSoftShadowMap. Use PCFShadowMap.
- Water's reflection and refraction draw the scene multiple times. Shadows are static except when light changes. Renderer stats deliberately include all passes.
- Current source requests JPEG export for all supported textures; normal compression needs close-range visual review.
- `dist/` is ignored by repo `.gitignore`; retain source/assets and rebuild when needed. The portable build was regenerated at wrap-up.

## Files changed in this effort

New `harbor-study/` folder, root handoff preface, and earlier `docs/environment-review/` assessment/render artifacts. No game `src/`, existing `public/assets/`, root package configuration or existing game Blender tools changed. Git changes are uncommitted. Some `.blend1` backup files may be present; preserve the main `.blend` and do not mistake backups for separate deliverables.
