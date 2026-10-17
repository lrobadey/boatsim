# Ormos reusable harbor kit

This is the asset toolkit for future Boatsim implementation. The harbor study is its visual test scene; this directory is the reusable deliverable. The default game appearance remains unchanged; the compatible merchant assembly uses the original game model through reversible appearance hooks. See `MERCHANT.md`.

Read `VISUAL-LANGUAGE.md` for the current user-directed restrained art direction. The latest pass removes visual noise while preserving useful texture and construction detail.

## Start here

- `assets/manifest.json`: stable IDs, metre dimensions, origins, facing axes, attachment points, collision proxies, material names, LOD files, hashes.
- `assets/materials.json`: reusable PBR material definitions and shared texture paths.
- `runtime/kit.ts`: lazy Three.js loader, shared materials/textures, cloning, instancing, LODs and attachment helpers.
- `blender/build_kit.py`: deterministic recipe registry; `blender/authoring.py`: geometry and material primitives.
- `blender/harbor-kit.blend`: editable master collections. Unhide the desired collection's objects to inspect it.
- `blender/sources/*.blend`: one editable collection library per asset; append/link the named collection in Blender. These are collection libraries, not individually staged render scenes.
- `INTEGRATION.md`: game adapter and placement contract.
- `evidence/`: packing, validation and live browser inspection evidence.

## Inventory

| Family | Stable IDs |
| --- | --- |
| Quay | `quay-straight-a`, `quay-straight-b`, `quay-straight-c`, `quay-corner`, `sea-stairs` |
| Architecture | `warehouse`, `house-courtyard`, `house-workshop`, `house-tower`, `linen-canopy`, `retaining-wall`, `timber-beam` |
| Fixtures | `mooring-stone`, `rope-fender`, `gangplank`, `timber-bench` |
| Cargo | `amphora-large`, `amphora-small`, `wicker-basket`, `rope-coil`, `packing-rack` |
| Geology | `rock-ledge-a`, `rock-ledge-b`, `rock-boulder`, `rock-rubble` |
| Vegetation | `olive-a`, `olive-b`, `coastal-shrub` |
| Vessel | `cargo-boat`, `merchant-shell` |

The 29 assets produce 40 GLBs: 29 near meshes, seven distant meshes and four simplified rock collision meshes. Building and boat LODs are not yet authored. Use these large meshes deliberately; the warehouse includes modeled cargo and interior racks.

## Build and inspect

Run from the Boatsim repository root; dependencies come from its installed package set (Three.js, Vite, TypeScript, meshoptimizer).

```sh
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P harbor-kit/blender/build_kit.py
node harbor-kit/tools/pack.mjs
node harbor-kit/tools/validate.mjs
npm --prefix harbor-kit run typecheck
npm --prefix harbor-kit run build
npm --prefix harbor-kit run dev
```

Preview: `http://127.0.0.1:5187/`. Choose an asset, orbit/zoom, compare near/distant meshes, inspect anchors and collision proxies, or select the assembled berth. The viewer waits for geometry compilation and presented frames before reporting Ready.

For a single recipe, append `-- --only olive-a` to the Blender command, then pack and validate. `-- --list` prints IDs. A full build recreates all sources and the master. A partial build replaces only that asset's source library and manifest entry; it does not refresh the full master.

**Procedural recipes are authoritative.** Preserve manual Blender edits as a separate source before rebuilding, then migrate accepted edits into the recipe or introduce an explicit manual export path. Do not silently overwrite hand modeling. Raw embedded-texture GLBs in ignored `build/raw/` are reproducible intermediates; packed assets are the runtime output.

## Material and ownership rules

Preserve glTF PBR materials, vertex colors, UVs, normal strength, roughness, texture color spaces and sidedness. Most materials are opaque; cloth, leaves and roof tile shells are double-sided. Shared external textures must travel with their models. Geometry compression is lossless EXT_meshopt_compression; the loader includes Three's decoder.

`create()` clones scene nodes and shares resources. Do not dispose an individual instance's geometry/material. Remove instances, then `await kit.dispose()` when the whole library is no longer used. `batch()` accepts local matrices and creates an InstancedMesh per source primitive. LOD batching is caller-controlled; `createLOD()` creates a regular Three.LOD.

All geometry and textures were authored locally through these recipes. No downloaded model or texture packs were used. This provenance statement does not claim archaeological reconstruction accuracy.

## Acceptance boundaries

The toolkit can be loaded, assembled and inspected independently. Its collision data is a placement/physics integration contract, not an installed physics implementation. The scenic boat the user liked is a separately authored asset, not the game's existing playable merchant; its mesh has no buoyancy calibration or hull collision proxy. Do not replace the playable ship with it without a separate physics integration pass.

Validation checks decoded shipped geometry, finite attributes, index ranges, bounds, texture/source references, stable anchor positions, file hashes, LOD reduction and snapping across translated/rotated parent frames. Browser checks provide local visual/runtime evidence only. Full game lighting, traversal, collision behavior, streaming and target-device performance remain integration acceptance tasks.
