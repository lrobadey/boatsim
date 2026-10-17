# Game-compatible merchant

The latest boat work targets the game's **Kyrenia merchant**. The user explicitly confirmed this target; the game also contains a 34 m trireme. The earlier `cargo-boat` is preserved as a separate scenic asset.

The shell is authored from the live `MERCHANT` offsets, not rescaled from the scenic boat. It uses the same 13.7787 m hull length, approximately 4.216 m beam, waterline origin, forward -Z and Y-up axes. Deck heights and both cargo openings match the game. Timber variation is restrained, with a continuous underwater skin, clean bulwarks and sparse structural frames. The compatible assembly retains the original 9.5 m mast, 11 m yard, six sweeps, steering oars, cargo gratings and animation code. Its sail uses the kit's quiet linen material.

- Inspect `http://127.0.0.1:5188/#game-merchant`: deploy the sail, open hatches, or compare the original game shell.
- `blender/sources/merchant-shell.blend`: editable source collection; append/link it from Blender.
- `blender/recipes/merchant_shell.py`: deterministic shell recipe.
- `contracts/game-merchant.json`: source hashes, original offsets, rig, docking, cargo and crew coordinates.
- `runtime/merchant.ts`: `createMerchant(kit)` builds the actual `MerchantModel` with the new shell and linen maps. The caller supplies normal game physics and crew updates.
- `src/ship/merchantModel.ts`: reversible `setAuthoredShell()` and `setSailSurface()` hooks. The production merchant now installs these assets at boot. Shadow depth and point-light distance passes now share the visible sail's deformation.

Rebuild from repository root:

```sh
node harbor-kit/tools/export-game-contract.mjs
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P harbor-kit/blender/build_kit.py -- --only merchant-shell
node harbor-kit/tools/pack.mjs
node harbor-kit/tools/validate.mjs
node harbor-kit/tools/validate-merchant.mjs
npm --prefix harbor-kit run typecheck
npm --prefix harbor-kit run build
```

The compatibility audit reads exported GLB vertices, checks the source hashes, compares hull and deck coordinates to the actual game functions, rejects inverted/degenerate deck triangles, and checks that no deck triangle fills a hatch. Current maximum hull discrepancy is below 0.001 mm. `npm run test:hold` also passes, including cargo capacity, cargo visual placement and docked gangplank restoration.

The production game now uses the authored shell and linen while retaining its existing simulation, cargo and crew. Production browser checks cover walking off and back onto the boat, a grounded warehouse entry, the live trade ledger, and nine harbor views. Target-device performance beyond the local browser remains unmeasured. Do not describe the scenic `cargo-boat` as the playable merchant or treat the separate inspection stand as a full game playtest.
