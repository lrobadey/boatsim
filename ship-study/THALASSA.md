# Thalassa — five exterior refinement passes

October 22, 2026. The user selected the twin-hull court ship and authorized five
further refinement passes. Exterior only; original variants remain preserved.

The overall visual dimensions remain an 82 m hull length and 23.6 m hull beam,
with two 6.6 m hulls on 17 m centres. Oars and steering sweeps extend beyond this.
These scenes are visual concepts without naval-architecture validation. A later,
separate [browser sea-trial fixture](browser/README.md) explores this geometry with
the existing ship solver; it does not register Thalassa in the main game.

## Passes and review decisions

1. **Massing and structure.** Fitted, chamfered terraces replace rectangular slabs.
   Developed cross-hull beams, crutches for the steering sweeps, smoothly curled
   prows, sculpted bronze forefeet and a compact fanned stern ornament establish a
   coherent timber-built exterior. Hero, stern and close court renders reviewed.
   Review: the long lines worked, but the canopy hid the court and the materials
   needed more depth.
2. **Surfaces and canopy.** Opened the central linen canopy with an oval skylight;
   added eased joinery, construction-oriented grain, waterline staining, mottled
   bronze, jade paint, restrained Greek keys and deeper edge moldings. Hero and
   close court renders reviewed. Review: the court opening needed visible support
   and the rig and deck fittings still read as an early concept.
3. **Rig and marine equipment.** Fuller paneled square sails, bolt ropes, reef points,
   pulley blocks, deadeyes, ratlines, lashings and stays terminating at the hulls.
   Added bow capstans and stocked anchors. Moved the floating tender into a sheltered
   stern channel beneath a hoist. Cleared the oars around the port boarding landing.
   The canopy oculus has a timber rim and visible posts. Packed local PBR timber
   images into the Blender scenes. Hero, stern and court renders reviewed.
4. **An inhabited exterior.** Potted olive beneath the oculus; smaller planted tubs
   on the aft terraces; shaded seating, soft cushions, woven runners, court dining,
   pottery, caged oil lanterns and boarding fenders. Repositioned the aft staircases
   beside the galleries. Hero, terrace and an eye-level garden view reviewed.
   Review: the garden gave the strongest sense of a home; final work concentrated
   on circulation openings, exposed finish details and lighting.
5. **Craft and photography.** Connected the forward gallery roofs to the bridge,
   opened rails at stair and promenade joins, added drawn curtains, palmette quarter
   medallions, spar lashings, rope coils and native bronze Greek name lettering.
   Packed woven linen surfaces. Lanterns are real lights in the Blender scene,
   supporting a separate dusk lighting setup. Daylight and evening views reviewed;
   the evening exposure and light placement were corrected after the first preview.

## Delivered and verified

- Five cumulative Blender scenes are preserved, alongside the original chosen concept.
- Eight final images: six daylight viewpoints and two evening viewpoints, all
  2600 × 1700 at 128 Cycles samples. Every PNG was decoded and visually reviewed.
- Final daylight and evening `.blend` documents were reopened independently. Each
  includes all five referenced timber/cloth image maps packed into the file, nine
  named cameras, lighting, native mesh geometry and editable materials.
- `renders/thalassa/final-audit.json` records the packaging check; individual pass
  manifests record the actual resolution, sample count and source scene.
- `renders/thalassa/five-passes.png` compares the original and five refinements
  using the same elevated camera. `renders/thalassa/final-gallery.png` collects the
  eight delivered photographs. Both boards only arrange the unretouched renders.

## Build and render

```sh
/Applications/Blender.app/Contents/MacOS/Blender \
  --background --factory-startup --python-exit-code 1 \
  -P ship-study/blender/build_thalassa.py -- \
  --refine 5 --final --views hero stern bow terrace garden waterline
```

Use `--refine 1` through `--refine 5` for each cumulative version, `--save-only`
to build without rendering, or `--dusk` for the evening setup. The builder reuses
the original study's hull and geometry toolkit, without overwriting the originals.
It also uses the existing local wood/cloth PBR images under
`harbor-study/blender/textures`; all referenced images are packed into the resulting
Blender documents, which are independently viewable without these source paths.

Scenes: `blender/thalassa-pass-01.blend` through `blender/thalassa-pass-05.blend`.
The dusk scene is `blender/thalassa-pass-05-dusk.blend`.
Render evidence and exact manifests are under `renders/thalassa/pass-01/` through
`renders/thalassa/pass-05/`, with evening images under the latter's `dusk/` folder.

## Workflow learnings

- An elevated silhouette view can hide stair collisions, closed rail openings,
  ineffective fixtures and unsupported deck edges. Inspect a stern angle and at
  least one eye-level exterior space before accepting a refinement.
- Preserve one matching hero camera for before/after comparison; use close cameras
  to evaluate the changes that cannot read at whole-ship scale.
- Tensioned fabric needs a readable support system. The central oculus uses a timber
  rim and four slender posts; its opening provides daylight for the planted court.
- Keep an unobstructed boarding bay by omitting the oars that would intersect it.
- Apply UVs in physical units along each construction face's longest axis before
  using timber PBR maps. Pack all image dependencies into each delivered `.blend`.
- Consolidated procedural box faces need welded vertices before bevel modifiers
  can round their actual edges. Keep cloth, foliage, rope and hull skin separate.
- Run sequential render jobs on the Metal device. Inspect images after Blender
  finishes writing them; a path can exist while its PNG is still incomplete.
