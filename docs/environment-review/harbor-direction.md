# Harbor and environment direction — 13 October 2026

Assessment and proposal only. No game source or production assets changed. No browser testing performed.

## Evidence

Visually reviewed fresh Blender Workbench renders imported from the eight current production GLBs in `current-assets/`, plus saved in-game images `docs/ui-redesign/berth-trireme.jpg`, `docs/cargo-trade/{start-docked,kormakos,stall-serrothos}.jpg`, and `docs/lighting-review/after-deck-1230.jpg`. Also inspected existing prop previews and the actual stone and wood albedo images. Saved game views are historical evidence, not verification of the current running game. Workbench renders assess geometry and slot colors, not final PBR appearance. Triangle counts and material slots are recorded in `current-assets/inventory.json`.

## Diagnosis

The arrival lacks a composed destination. The saved views show a long, uniform mole leading toward scattered houses and steep, noisy terrain. Buildings, quay and land read as separate layers. There is little waterfront frontage or visible route from the berth into the village.

The geometry already has useful foundations: modeled quay courses and coping, recessed house openings, roof tiles, steps and mooring fixtures. However, regular silhouettes and extremely simple near-field objects remain conspicuous. Current GLBs contain 1,748 triangles per quay segment, 2,540 per head, 194 per bollard and 188 per gangplank. Increasing triangle counts indiscriminately is not the answer; prioritize visible edges, construction and contact points.

The quay's modeled large rectangular masonry conflicts with the small irregular stones in the shared `stone_wall` material. That same material covers paving, foundations and bollards. The shared plank texture likewise describes multiple boards even where a mesh represents one beam. Plain plaster, rope, cloth, clay and roof materials lack distinct close-range surfaces. These are material-assignment and scale problems as well as asset-quality problems.

Terrain is a 12 km heightfield with 2,048 samples per side at high/ultra (approximately 5.86 m spacing). Its large-scale generator already considers wind exposure, erosion and sheltered harbor sites. However, meter-scale shoreline ledges, undercuts and fitted building foundations need an additional local solution. Village placement samples scattered plots near shore and faces them downhill; it does not generate streets, courts or a coherent waterfront.

## Proposed direction

A warm, working Aegean harbor: pale limestone, weathered timber, muted plaster and terracotta, shaded storage fronts, restrained cloth accents, clear water against dark wet stone. Treat this as an art direction; choose precise period and regional references before claiming archaeological fidelity.

### 1. Compose arrival around one excellent berth

Keep a clear straight working face long enough for the ship. Build a broader shore landing behind it with a small warehouse, shaded loading area and two or three connected building fronts. Let a lane lead uphill between retaining walls toward the settlement. Frame this with a rocky shoulder, trees and a modest landmark visible from the approach.

A bent outer mole or protected basin is a later layout option. It must update navigation depth, wave sheltering, ship colliders and mooring layout together; decorative shelter geometry alone would be misleading. The initial berth slice can retain the existing functional docking face while improving its shoreward composition.

### 2. Model the surfaces the player actually approaches

In Blender, build three compatible 6 m quay-body variants, an end/steps module and a shore transition. Preserve docking dimensions initially. Give coping stones substantial bevels, selective chips, gently varied joints and worn upper edges. Keep the working edge readable and unobstructed.

Add two mooring-stone variants, timber rubbing pieces, a convincing rope fender and a rebuilt gangplank. Use actual plank thickness, end grain, joints, restrained sag in unloaded ropes and attachment details. Place wear where hulls, ropes, feet and cargo act on surfaces. Keep dock props in useful groups with a clear landing route.

Do not blanket the harbor in damage. The intended place is maintained and actively used.

### 3. Establish a coordinated material family

| Surface | Treatment |
| --- | --- |
| Quay face | Large limestone courses; geometry owns the joints; texture adds stone grain and tool marks, not a second masonry pattern. |
| Coping and paving | Separate cut-stone treatment, broad readable slabs, smoother worn edges, subtle dirt in recesses. |
| Waterline | Graded wetness, mineral staining and restrained algae; varied height and intensity; retain plausible roughness. |
| Structural timber | Grain aligned with each beam, end grain at cuts, bleached upper surfaces, darker sheltered/wet faces. |
| Rope | Twisted fiber normal detail at appropriate scale; modeled silhouette and wraps near the player. |
| Plaster and roof tile | Warm mineral variation, localized repairs and lower-wall wear; thickness and overlap in roof geometry. |
| Clay and cloth | Unglazed grain and firing variation; coarse woven cloth, seams and weighted folds. |

Separate broad color variation, medium-scale wear and fine surface grain. Judge all materials in sunlight, shade and grazing light. Use shared atlases/trim sheets and restrained per-instance variation to control repetition without creating a material per object.

### 4. Make docking feedback agree with the new harbor

The source already has quay spring/damper contact, mooring lines, settling, bump events and a moving gangplank. Start by integrating the new models with those systems. Ensure the visual fender face agrees with the hull contact boundary, ropes meet real fixtures, and the gangplank visibly bears on the landing. Any fender deformation or contact sound should follow the actual contact event; avoid independent decorative motion that contradicts the hull.

Source inspection does not establish whether current docking feels good. Later acceptance needs actual approach, contact, settling and walking checks when browser testing is explicitly requested.

### 5. Rebuild the immediate shore, then expand

Use a small Blender rock kit with consistent bedding, broken ledges and rubble wedges to give the harbor coastline structure. Blend it into terrain with compatible color, roughness and ground cover. Keep visible ground and physical collision surfaces aligned; pure decorative cliffs cannot replace walkable terrain without collision work.

Build a warehouse, courtyard dwelling, narrow two-storey frontage, stair and retaining-wall kit. Arrange them around routes and work areas before adding distant houses. Replace the most visible geometric tree canopies with branching silhouettes and clustered foliage. Reserve the highest detail for the dock-to-village walk; retain procedural distant terrain and instancing.

## Blender production and integration

Save editable `.blend` masters, baked textures, GLB exports, simplified collision meshes and explicit mooring/landing sockets. Review geometry, PBR materials and assembled scene separately. Use fixed boat-eye and walking-eye cameras plus a neutral material setup. Re-import the exported GLBs for inspection.

Critical source constraint: `src/gfx/models.ts` currently discards imported materials and replaces them by slot name. Preserve approved glTF PBR materials through the game's lighting patches, or extend the slot system with dedicated materials and masks. Merely exporting attractive Blender materials will not change the runtime finish. Bake procedural detail to supported texture channels; glTF supports base color, roughness, normal and occlusion textures, not arbitrary Blender shader graphs. Reference: https://docs.blender.org/manual/en/5.1/addons/import_export/scene_gltf2.html

Existing conventions in `tools/blender/kit.py`: meters; glTF +Y up, forward -Z; geometry authored at object origin. `KitBatch` uses mesh geometry for instances, so transforms and hierarchy require deliberate handling. Keep shared geometry/materials and prepare reduced-detail versions. Performance budgets need measurement before promising a frame rate.

## First deliverable

One approximately 40–60 m working berth plus its shore landing, tested in Blender as a complete scene: three quay variants, steps, mooring stones, fenders, gangplank, limestone/timber/rope material family, one warehouse and a small rock/retaining-wall transition. Render approach, alongside and ashore views in neutral daytime and late sun. Show a close material comparison. Integrate this slice before multiplying it across ports.

Completion criteria: recognizable destination from sea; coherent stone scale without competing seams; convincing surfaces at 1–3 m; natural transition from boat to quay to village; fixture/contact alignment; clear cargo and walking space. Runtime appearance, docking feel and performance remain separate acceptance gates.

## Source entry points

- `src/gfx/models.ts`: material replacement and imported object handling.
- `src/gfx/assets.ts`: current shared PBR texture sets.
- `src/world/props.ts`: instancing, village, quay assembly, vegetation and rock placement.
- `src/world/worldgen.worker.ts`: island/shore geometry, pier generation, scattered house placement.
- `src/world/terrain.ts`: terrain LOD and procedural surface treatment.
- `src/world/harbour.ts`: shared dimensions, berths, fixtures and collision.
- `src/world/harbourRig.ts`, `src/ship/mooring.ts`, `src/ship/physics.ts`: plank, ropes, settling and contact.
- `tools/blender/{kit,harbour,houses,props}.py`: existing asset generation and export conventions.
