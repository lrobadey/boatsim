# Trireme descendants — exterior design study

October 22, 2026. An isolated Blender exploration for a massive inhabitable ship.
Original scope: exterior appearance only. Saved Blender concepts remain separate from the game.

The subsequently requested [Thalassa browser sea trial](browser/README.md) uses the current
game physics in a separate calm-water dev fixture at http://127.0.0.1:5174/.
It includes working crew rowing, sails, instrumentation and preliminary propulsion/turning tests.
It is not registered in the main game and adds no interior design.

The later playable main-game dev entry is now `npm run dev:thalassa` at
http://127.0.0.1:5175/. See the repository README. This opt-in entry reuses this
exterior and hull study with normal game controls, linked sails, waves and an
offshore spawn; the engineering fixture on port 5174 stays separate.

The subsequent [mechanical-propulsion exploration](propulsion/README.md) compares
human/animal-powered paddles, twin screws and a wind-driven screw concept. It includes
a reproducible power-budget calculation; these are design proposals, not implemented drives.

## Chosen direction: Thalassa

The user chose the twin-hull Thalassa; five further exterior refinement passes
are complete. See [THALASSA.md](THALASSA.md) for the pass-by-pass visual review,
source files and rebuild commands. The refined scenes are
`blender/thalassa-pass-05.blend` and `blender/thalassa-pass-05-dusk.blend`;
renders are under `renders/thalassa/pass-05/`. The three initial variants below
remain preserved.

## Original comparison: three terraced flagships

The user first narrowed the brief to three versions of the terraced flagship,
with further design passes deferred until after choosing a direction. This
comparison is the preserved starting point. No interior design or production
integration was requested.

| Variant | Hull length | Hull beam | Exterior character |
| --- | ---: | ---: | --- |
| A · Asterion | 90 m | 12.6 m | Sleeker war flagship; dark hull, vermilion wales, bronze shields, low terraces |
| B · Nereid | 84 m | 19.2 m | Broad residence; wide promenades, open galleries, stepped aft pavilion |
| C · Thalassa | 82 m | 23.6 m overall | Twin-hull court; two slender galley hulls, linked terraces and a central canvas court |

The twin-hull version has two 6.6 m hulls on 17 m centres. It is the deliberately
more speculative third alternative. These are exterior visual studies, with no
claim that stability, hull structure, rigging loads or rowing feasibility have
been engineered.

Open `blender/a-terraced.blend`, `blender/b-terraced.blend` or
`blender/c-terraced.blend`. Each contains the complete scene, procedural materials,
lighting and six named cameras. `renders/selection/` contains the delivered
2000 × 1300 Cycles renders and manifests. Images have no generative retouching.

## Preliminary directions

| Study | Hull length | Hull beam | Exterior idea |
| --- | ---: | ---: | --- |
| A · Dory | 88 m | 11.8 m | Long ceremonial galley; low accommodation, three masts |
| B · Nereid | 84 m | 16 m | Terraced flagship; sheltered court, aft residence, working foredeck |
| C · Hestia | 78 m | 18.4 m | Broad floating residence; long sheltered wings and heavier roof |

These are visual design dimensions, not an engineered vessel specification. Beam excludes oars.

The existing game trireme (`src/ship/hull.ts` and `src/ship/trireme.ts`) supplies the initial
design vocabulary: upswept stern, continuous sheer, projecting rowing gallery, bow eyes,
bronze forefoot, red painted strakes, square yards, and natural timber. Its hull length is
34 m. The study interprets that vocabulary at a much larger scale.

Historical visual reference: [Hellenic Navy — Olympias](https://averof.hellenicnavy.gr/en/trireme-olympias/).
The proposed residences are speculative game designs; Olympias is a reference for the galley language.

## Rebuild

Run from the repository root:

```sh
/Applications/Blender.app/Contents/MacOS/Blender \
  --background --factory-startup --python-exit-code 1 \
  -P ship-study/blender/build_ship.py -- \
  --concept B --pass 2 --view hero
```

`--concept A|B|C`, `--pass 1|2`, `--view hero|stern|profile|deck|bow`,
`--quality draft|final`, `--samples N`, and `--save-only` are supported.
Here `pass 1` reproduces the initial, superseded directions; `pass 2` builds the
three current terraced variants. These are internal build-stage names, not five
completed design passes. The earlier preliminary scene `b-p02.blend` is also kept.
Each build render has a JSON sidecar recording its scene, camera and dimensions.

To render the selected variants from their saved Blender files:

```sh
/Applications/Blender.app/Contents/MacOS/Blender \
  --background --factory-startup --python-exit-code 1 \
  -P ship-study/blender/render_variants.py
```

The scenes use native geometry, procedural materials, Cycles, and Metal on this Mac.
They require no external texture downloads or image generation.

## Authoring notes

- The scene coordinate frame is +X toward the bow, +Y across the hull, +Z up, in metres.
- Large semantic meshes group hull strakes, planks, structural timber, canvas, rigging,
  fittings and exterior panels. These remain editable in the saved `.blend` files.
- Blender 5.2 renamed the Nishita sky enum to `MULTIPLE_SCATTERING` and its dust control
  to `aerosol_density`; the generator supports both the new and previous spellings.
- Use `--python-exit-code 1`; background Blender can otherwise return success after a
  Python exception. Check that the output image exists and inspect it visually.
- In the restricted execution environment, Blender needs graphics-device access even
  for background startup. The initial Metal compile may take several minutes.
- The comparison sheet only arranges and labels original Blender renders. It does not
  paint over or replace any geometry in the images.

## Visual review record

- Initial A/B/C renders were inspected individually. The first lighting was too
  pale, the broad house was too continuous, and the narrow galley did not carry
  enough sense of habitation. These preliminary images remain in `01-directions/`.
- The next B massing check replaced long repetitive side walls with open timber
  galleries and stepped aft accommodation. Exposure and material reflectance were
  corrected so dark timber, paint and bronze can be distinguished.
- The user then requested three variations on that terraced language, and clarified
  that five further passes should wait. The current A/B/C set responds to that brief.
- Current variants were inspected from a shared elevated camera before rendering
  the higher-resolution hero, stern and waterline views. The wider residence has a
  higher aft profile; the war flagship remains lower and longer; the twin hulls are
  visible as separate volumes rather than an extra-wide monohull.
- The stern and waterline views revealed open seams at the tapered deck ends and
  the finite sea plane's edge at the horizon. A continuous deck substrate, dark
  inner hull skin, welded smooth meshes and extended water geometry corrected
  those defects in all three scenes. A misplaced scale figure on the twin-hull
  model was moved onto its aft bridge.
- All nine delivered images were visually reviewed in `renders/selection/all-views.png`;
  the individual hero images and critical alternate views were also inspected at
  full display size. Every PNG decoded successfully at 2000 × 1300, and all three
  saved `.blend` scenes were reopened to produce the final images.

Delivered boards: `renders/selection/comparison.png` (three hero views) and
`renders/selection/all-views.png` (all nine original images). Thalassa was selected.
