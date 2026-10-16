## Compatible merchant addition

Read [MERCHANT.md](MERCHANT.md) for the game-proportioned shell and `createMerchant(kit)` adapter. Its axes and origin match the game directly; do not apply the scenic boat rotation or scaling to it. Moving joints and physics remain game-owned.

# Agent integration guide

Read `assets/manifest.json` before placing assets. IDs and coordinate contracts are authoritative; screenshots are not measurements. Keep the kit independent of the assembled study.

## Load without losing materials

The existing `src/gfx/models.ts` loader maps imported materials into game slots. Do not route the kit through that replacement path: it discards the authored material distinctions. Copy the contents of `assets/` together to a game-served asset directory, and use the dedicated adapter:

```ts
import { HarborKit, snapAnchor } from './path/to/harbor-kit/runtime/kit';
import { patchMaterial } from './gfx/shared';

const kit = await HarborKit.open('/assets/ormos/manifest.json', {
  anisotropy: 8,
  patchMaterial: (material, name) => patchMaterial(material, undefined, `ormos:${name}`),
});
const first = await kit.create('quay-straight-a');
const second = await kit.create('quay-straight-b');
scene.add(first, second);
first.position.set(0, 2, 0);
snapAnchor(second, kit.asset('quay-straight-b'), 'join-left',
           first, kit.asset('quay-straight-a'), 'join-right');
```

The callback signature matches the current game's shader hook, but the hook has not been exercised in the game with these assets. Validate the full material/shadow/aerial-lighting pipeline there before shipping. Clamp anisotropy to renderer capability.

## Coordinate rules

- Metres; Y up. Architecture faces -Z. Quay land extends +Z from the front edge, top at local Y=0. Straight connectors are 6 m apart. Small masonry irregularities extend slightly beyond the nominal footprint.
- Boat forward is -X, local Y=0 is its scenic waterline. Its visual bounds include steering oar, rigging and endposts. Bounds are not hydrodynamic hull dimensions.
- Ground objects use ground-centre origins; fender uses its suspension point, gangplank its walking-surface midpoint. Read each origin instead of blindly translating `bounds.min.y` to zero.
- Anchor coordinates are asset-local; GLBs carry `anchor_<name>` nodes and `anchorName` extras. `anchorWorld()` converts the manifest point through the instance transform.
- `snapAnchor()` aligns opposing normals and positions. It resolves one direction, not arbitrary roll; intended for upright modules under yaw and uniform scale. Do not use nonuniformly scaled parents or assume it solves free-form six-axis docking.
- `footprint` is nominal planning clearance. Use actual `bounds` for rendering/culling. Use the named proxy shapes for collision, with each proxy transformed through the instance matrix.

## Placement and physics

The game's `src/world/harbour.ts` berth geometry and walkable solids remain authoritative until an integration explicitly replaces them. Make visual dimensions, player walk heights, ship contact surfaces and gangplank endpoints agree. Do not merely overlay a new mesh and call collision integrated.

Box sizes and cylinder dimensions are metres. `walkableTop` and `surface` are semantic hints; the adapter does not register physics bodies. Rock collision files are simplified renderable triangle meshes. Convert them to the engine's supported static shape representation and validate contact/walkability. Decorative ropes and shrubs have no collider. Open building doors are preserved in the wall proxies, but roof/window traversal is not implemented.

A rigid gangplank is 3.6 m between contact anchors. Solve placement between actual support points or choose another authored length; don't stretch along one axis and distort the railing. Mooring anchors identify attachment positions, not force laws. The current boat is scenery; sailing rig animation, deck traversal and displacement remain separate work.

## Reuse and budgets

Prefer `batch(id, matrices)` for repeated jars, plants and quay runs; use `create()` for individually interactive items. Multiple instances share geometry and materials. Distant rock/vegetation meshes are explicitly authored LOD1 with manifest distances as starting values; tune distances against actual camera FOV and game view distance.

Avoid loading the whole library at startup. `HarborKit.open()` fetches the catalog only; files load on first use. Deploy the complete referenced texture set or generate a subset from manifest dependencies. Preserve relative `models/` and `textures/` paths. Do not flatten GLBs into the game's model folder without their shared textures and decoder.

For final game acceptance: inspect daylight and dusk, berth contact and traversal, texture memory and draw calls, LOD transitions, loading/disposal behavior and target-device frame time. Local studio rendering alone does not establish these results.
