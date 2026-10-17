# Ormos production integration

The actual game now loads the Ormos assets at starting port id 0, called **Serrothos** on seed 1729. This is an authored working waterfront within the generated archipelago, using its existing mole, berths and merchant simulation.

The visual direction is clean plaster, quiet timber, modeled limestone courses and paving joints, sparse cargo groups, linen canopies and grouped olive trees. Broad limestone shoulders and low shrubs soften the court edges without filling the walking route. A wide landing connects the long mole to a warehouse, market, workshop and village lane. Shore rocks use conservative blocking solids because the game walker supports primitive collision; their irregular tops are not offered as flat walk surfaces. The warehouse loading hall is accessible; the houses have closed door returns. Six oil lamps provide local night light.

The Kyrenia merchant uses the game-derived shell, quiet linen and a rigid 3.1 m × 0.7 m boarding plank. Her original hull offsets, deck levels, hatches, rig joints, moving sweeps, steering oars, cargo, crew and physics remain authoritative. An existing crew material slot was corrected to use its authored vertex colors. The new warehouse gables have thickness, closing the interior under backface culling.

## Open

- Normal production game: `http://127.0.0.1:5190/?ship=merchant&q=high&wind=3`
- Production inspection: `http://127.0.0.1:5190/?ship=merchant&q=high&dev&ormosReview=overview&wind=3`
- Toolkit inspector: `http://127.0.0.1:5188/#game-merchant`

The inspection URL exposes fixed camera views, time controls and starting points for the real walker and helm. Its trade layer neither reads nor deletes nor writes saved voyages. It does not substitute a separate renderer or physics fixture for the game. While docked, it holds astronomical time at the selected lighting preset and forces a coherent environment recapture; boat physics, waves, crew and walking continue to run.

## Verified

- Production build and TypeScript checks.
- Mesh decoder, finite geometry, indices, bounds, texture paths, anchors, LODs, rigid-span placement and source paths for the 31-asset toolkit and 32-entry study.
- Merchant exported hull vertices and deck heights match the live game functions to sub-millimetre precision; hatches remain open in the shell.
- Authored harbor terrain at seeds 1729 and 1730 / resolution 2048, plus seed 1 / resolution 1024: foundation support, berth dredging, native house / vegetation exclusion, physical AO and shelter bakes.
- Correct trade interaction point, original berth count / width, physical shore landing collider, and a clear central route between olive trunks / shore rocks.
- Existing ports, merchant hydrostatics, hold / cargo, mooring and walker regression suites.
- Browser inspection of nine production views: overview, approach, berth, quay, court, workshop, village, warehouse and boat.
- Real production interaction: trade ledger opened from the relocated merchant figure; warehouse entered through its doorway; walker crossed from the ship to the quay and back aboard while grounded; normal R / F controls cast off and deployed the sail fully.
- Night lamps and late / dawn lighting checked separately. Captures and DOM telemetry are stored beside this file.

Local browser evidence establishes the observed rendering and interactions. It does not establish performance on other hardware, a historical calibration, or an exhaustive voyage across every port. GPU timings depend on view, adaptive resolution, shader warm-up and browser scheduling; they are recorded as local observations.

## Ownership and rebuilding

`src/world/ormosLayout.ts` is the pure worker / visual / interaction frame. Terrain grading precedes AO and wave-shelter bakes, with a cell-size guard for low-resolution foundations. `src/world/ormosHarbour.ts` preserves glTF PBR, batches repeated pieces, centers grove LOD origins, supplies authored collision and the merchant materials. `Props` installs the real trader and night lamps. `HarbourRig` keeps the authored merchant plank rigid through interpolated body poses.

Editable authoring lives in `harbor-kit/blender/sources/`, with `harbor-kit/blender/harbor-kit.blend` as the refreshed master. The standalone study master is `harbor-study/blender/ormos-harbor.blend`. Its geometry is a presentation fixture; production port geometry is derived from the actual generated pier.

```sh
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P harbor-kit/blender/build_kit.py
node harbor-kit/tools/pack.mjs
npm run assets:ormos
npm run typecheck
npm run test:ormos
npm run build
npm run preview -- --host 127.0.0.1 --port 5190
```

The runtime lazily requests the referenced toolkit files. Staging copies the complete reusable distribution into `public/assets/ormos/`; authoring sources and evidence are not copied into the game distribution.
