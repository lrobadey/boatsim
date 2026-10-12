# Animated standing rowers for the merchant ship: technical proposal

Author: technical-animation consult. Status: design backed by a working proof of concept (PoC).
Everything lives in `crew-anim/`; nothing in the repo was changed.

Labels used below: **[V]** = verified in the PoC (numbers measured), **[A]** = assumption or judgement, not tested.

---

## 0. Verdict up front

1. **Rig:** use a hand-built armature from the figures.py joint map, not `skin_armature_create`. Weight the manifold Skin body with Blender's heat (automatic) weights. Weight the rigid parts by rule. Transfer weights onto the chiton from the body, then reshape them. **[V]** Heat weighting succeeded headless with 0 unweighted vertices, and the result loads in three.js GLTFLoader with sane skins.
2. **Runtime:** your working assumption is right, with one sharpening. The stroke pose should be **a function of the drawn oar's grip positions plus a few smoothed scalars, never of stroke phase**. Phase, effort and gaze only modulate style. That is why varying stroke length, rate and timing cannot break it: there is no clip to fall out of sync with. **[V]** Over 40 s of randomised strokes (length 55-100 %, 14-30 spm, random drive ratio and effort, a hold-water spell, ship roll and pitch), hand-to-grip error was 0.0 cm at p95. Planted toes slid 0.06 cm at most, and nothing popped beyond what the input itself did.
3. **The real problem is the oar geometry, not the animation.** With 1.5 m inboard and the current arc (sweepFwd 0.72 / sweepBack -0.58), the handle travels about 1.2 m along the rower's facing direction (about 1.7 m in ship z). A standing 1.72 m figure with planted feet can just follow that, but only in a deep fencing lunge (front knee at 43°). A 0.83 rad arc (+0.45/-0.38) or a narrower stance looks much better (§2.6). Decide this with the physics specialist.
4. **Cost:** about 13-20 µs median per rower per frame in Node for solve + matrixWorld + `skeleton.update()` (p99 60-90 µs) **[V]**. Eight rowers cost about 0.15 ms. The PoC allocates freely, so an allocation-free TypeScript port will be faster **[A]**. LOD is not needed for the CPU. The GPU side is about draw calls, not skinning.

---

## 1. Rig

### 1.1 What was built [V]
`crew-anim/rig_rower.py` (Blender 5.2.2 LTS, headless, imports `kit.py` and `figures.py` with `kit.PREVIEW_DIR` and `kit.MODELS_DIR` redirected to the scratchpad) produces `crew-anim/fig_rower.glb`:

| item | value |
|---|---|
| bones | 22: `root` (non-deforming) `pelvis spine chest neck head`, and per side `clavicle_* upperarm_* forearm_* forearmTwist_* hand_* thigh_* shin_* foot_*` |
| tris / GPU verts | 1954 / 1603 (body decimated to 1500 before weighting; parts unchanged) |
| primitives | 4 (`skin`, `hair`, `cloth`, `leather`), one shared skeleton, the existing slot names, so `models.ts` re-materials them as-is |
| weights | at most 4 influences, every weight sum is 1, 0 unweighted vertices |
| bind | `max|boneWorld·inverseBind − I|` = 3e-7 in the bind pose |
| file | 108 KB, including one test clip |
| clip | `idle_breath` (4 s): `AnimationMixer` drives `chest` correctly on a `SkeletonUtils.clone` |

Load check: `crew-anim/node/load_check.mjs` (three r186 GLTFLoader.parse in Node 25).

### 1.2 Why a hand-built armature rather than Skin "Create Armature"
- `skin_armature_create` produces one bone per skin edge with generic names (`Bone.003`) and arbitrary rolls. It also gives you nothing for the head, hands or feet, which are separate parts. You would rename and re-parent it all anyway.
- The joint map `P` already *is* the skeleton. Building bones from `P` means every figure variant (pose_std-based) gets identical names, lengths and a bind pose for free. That keeps the runtime solver figure-agnostic.
- Heat weighting works well on exactly the mesh the Skin modifier gives you: one closed, manifold tube body. It fails on the joined multi-part object, which has disconnected shells and an open chiton. So weight the body alone, then join. **[V]**

### 1.3 Weights per part [V]
- **Body (Skin tubes):** `parent_set(type='ARMATURE_AUTO')` on the body only.
- **Head and hair:** 100 % `head`. **Hands:** 100 % `hand_*`. **Feet:** 100 % `foot_*`. These are rigid shells, so rule weights are exact and free.
- **Chiton and belt:** a Data Transfer modifier (`POLYINTERP_NEAREST`, vertex groups by name) from the weighted body, then reshaped in Python:
  - arm influence on the yoke is folded into the clavicles (a sleeveless chiton must not follow the upper arm);
  - below the belt, leg influence fades from 0 at the waist to at most 60 % at the hem;
  - shin and foot influence is folded into the thigh of that side;
  - 3 smoothing passes, limit 4, normalise.

  Result: the bell spans between the legs in a lunge instead of tearing, and the front follows the forward thigh. That is visible in the snapshots.
- **Belt:** goes with the chiton, because it sits on it. Rule-weighting it 50/50 pelvis/spine sheared it visibly (first preview), so I dropped that.

### 1.4 Naming and conventions (please adopt)
- **Anatomical L/R.** The figures face −z, so **+x is the figure's anatomical right**. figures.py's comment ("x>0 is the figure's left") is backwards; the `L`-suffixed joints in `P` are on the right. The rig fixes this in the bone names.
- **No dots in bone names** (`upperarm_L`, not `upperarm.L`). three's `PropertyBinding.sanitizeNodeName` strips `.`, so clip tracks would bind to `upperarmL`.
- **Bone local +Y points at the child** (Blender convention, preserved by the exporter) **[V]**. The solver does not depend on rolls (§2.2).

### 1.5 Recommendation for the production rig: 20 bones, drop `forearmTwist_*`
In the PoC the hand frame either follows the loom axis or uses parallel transport from the elbow hinge. In both modes the measured twist of hand relative to forearm stayed under 0.5°, because a two-hand overhand grip on a loom running across the body is close to the forearm's natural roll. The arms are also near-circular Skin tubes, so twist would be nearly invisible anyway, and the hands are ellipsoid blobs. A twist bone buys nothing here. Keep the "minimal-twist hands" option in the solver as insurance. **[V]** for the measurement; **[A]** that you won't add articulated hands later. If you do, bring the twist bones back: the code path exists.

### 1.6 Budget and materials
- About 2000 tris per rower, the same class as the existing 2500-tri figures. Eight rowers add 16 k tris. Irrelevant.
- **Draw calls are the real GPU cost:** 4 primitives × 8 figures × (main + shadow + planar reflection if the ship is in it) ≈ 96 draws. Options:
  - (a) accept it;
  - (b) **[recommended]** bake the slot colours into vertex colours and export one primitive with a `crew` material: 8 draws per pass. This needs one new slot in `makeSlots` with `vertexColors: true`.

---

## 2. Runtime animation

### 2.1 Architecture
Per figure, per render frame (render rate, after physics interpolation):

```
mixer.update(dt)                    // clip layer: idle / walk / rest (pose written into bones)
copy clip locals -> bufferA
RowerRig.solve(inputs, dt) -> bufferB    // procedural layer, ship-local space
per chain: local = slerp(bufferA, bufferB, w_chain)   // w for body, armL, armR, legs, head
```

Everything is solved in **ship-local space**, the frame `OarKinematics` uses. The figure is a child of the ship group, so ship motion is free and the solver never sees world coordinates except for one "world up" vector.

### 2.2 Frame-rule bone writing (robust to any exporter roll) [V]
For each bone define a *rule frame* F from two directions: y = segment direction, x = a reference axis. At rest compute `O = F0⁻¹·R0`. At runtime set `R = F·O` and `local = parentWorld⁻¹·R`. This reproduces the bind pose exactly and makes skinning see `F·F0⁻¹`. Bone rolls and exporter axis conventions are irrelevant.

The x reference per bone:
- spine and head: body right;
- limbs: the IK hinge axis (rest elbow hinge +x, knee hinge −x, both derived);
- hands: loom axis or hinge;
- feet: stance right;
- clavicle: body forward.

Pitfall I hit and fixed: every bone's rest y must be taken from the bone's own +Y. When I used a parent-to-child direction, the hand and clavicle disagreed with it.

### 2.3 The stroke solve (implemented in `crew-anim/node/rowerIK.mjs`)
Inputs come from the **drawn** oar (see §5.3): two grip points on the loom, the loom axis and the feather angle.

1. **Grips.** End hand 8 cm from the handle end; second hand 45 cm further outboard **[V]**. A 54 cm spacing caused consistent outboard-hand misses with this short-armed figure. The figure's right hand is whichever grip lies further along body-right; for a starboard sweep facing aft that is the end hand.
2. **Trunk yaw.** Square the shoulders to the loom: yaw = 0.55 × the angle of (gripR − gripL) in the horizontal plane, plus 0.25 × handle lateral offset, clamped ±0.6 rad. Spring ω = 8. Distributed 25/35/40 % over pelvis, spine and chest.
3. **Reach model.** A closed-form forward-kinematics (FK) model of the *same* curved spine (cumulative pitch 0.3/0.7/1.0, yaw 0.25/0.6/1.0) gives both shoulder positions for a trunk pitch θ. The model **must match the real FK exactly**: an early rigid-trunk version was off by 8 cm and that showed up one-for-one as hand error **[V]**. Two scalar functions:
   - `demand(P,θ)` = how far the farther arm is beyond 0.90 of arm length;
   - `fold(P,θ)` = how far the nearer arm is folded inside 0.50.
4. **Pelvis.**
   - Preferred position along the stance: `0.6·(d − d0)` through an asymmetric tanh, limited to 0.8 × each foot's split. Here d is the handle's reach along the facing direction. Lateral 0.3 × the handle's lateral offset.
   - Height: hip height minus a drop of 0.035·effort + 0.10·spread², plus heave flex.
   - Smoothed with a critically damped spring (ω 14 in the drive, 10 in the recovery). This is the "legs lead" feel.
   - Then **constraints are applied after smoothing and are themselves unsmoothed:**
     - if `demand(P, 0.62 rad) > 0`, push the hips toward the handle (the catch);
     - if `fold(P, −0.15) < 0`, push them away (the finish);
     - cap the height so both legs are reachable.

   This ordering was the single most important fix. When the constraints sat before the spring, the body lagged the handle and the arms ran out: 30 % of frames had hand error above 3 cm **[V]**. The constraints are continuous in the handle position, so applying them instantly cannot pop.
5. **Trunk pitch.**
   - Preferred: `θpref = −0.22 + 0.72·catchness − 0.12·effort (drive) / +0.05 (recovery)`, spring ω 10. Body over at the catch, laid back at the finish, thrown back under load.
   - Then bounded by reach: if `demand > 0`, bisect up toward 0.9 rad; else if `fold < 0`, bisect down toward −0.42 rad. 12 iterations each, about 50 cheap evaluations in all.
   - Note: driving pitch purely from a "desired arm extension" law (my first attempt) made the rower lean *forward* at the finish, because the handle is at hip height. Preferred posture plus reach bounds is the right formulation.
6. **Clavicle.** Protract and elevate up to 25 % of the way toward the wrist target when the straight-arm reach ratio exceeds 0.85.
7. **Arms.**
   - Analytic two-bone IK with soft extension: compression starts at 97 % of length, exponential approach.
   - **Pole = 0.5·out − 0.2·up − 0.85·back.** The first pole (out and down) lined up with the end hand's reach direction mid-drive, and the elbow swung through 63° in one frame **[V]**. The rule: the pole must point where hands never go. For a loom puller that is behind the body.
   - Hand: y points from over the loom, perpendicular to it and 35 % toward down, then rolled about the loom by the feather. Wrist = grip − 9.4 cm along y.
8. **Legs.** Planted ankle targets, two-bone IK with soft extension at 98.5 %, pole = foot forward + 0.15 out. Heel lift: if the hip-to-ankle distance exceeds 99 % of leg length, rotate the ankle about the toe (closed form, 2 iterations). Foot frame y = ankle→toe, x = stance right.
9. **Head.** Look-at within ±1.2 rad yaw and −0.6/+0.5 rad pitch relative to the chest, split 35 % neck / 65 % head, springs ω 6. It drops 0.12·effort in the drive and is counter-pitched by 0.6·θ, so the eyes stay level-ish while leaning.
10. **Secondary.** Breath (chest pitch 0.03 rad at 0.35 Hz, exhale in the drive) and per-rower seeded two-sine noise on head pitch. **[A]** Add later: a pelvis vertical bob from footfall impulse and a chiton hem lag bone (§6).

### 2.4 Why it stays robust when strokes change [V]
- No phase-indexed data. Every pose is a pure function of the current grip positions plus springs. A short stroke simply produces less body motion. A rate change only changes how fast the inputs move.
- Constraints are continuous functions of the inputs and are applied post-smoothing, so they cannot pop and cannot lag.
- Measured: per-bone rotation per 60 Hz frame peaks at 11-16°. The peaks sit at the synthetic generator's own discontinuities (the feather jumps to 0 at the hold-water switch). Within strokes, motion is smooth. Rule: **feather and grips must be continuous inputs.** `RowingSystem.renderPose` already interpolates them. On a teleport (respawn, reset) call `rig.reset()` to re-seed the springs instead of blending.

### 2.5 State blending
| state | layer | how it enters and leaves |
|---|---|---|
| `row` | IK all chains (w = 1) | inputs from the drawn oar |
| `hold` | same solver | `driving = true`, effort high, gaze to the helm; no special code. Hold was the cleanest case: 0.0 cm error |
| `shipped` | IK arms follow the loom while `oarStow` draws it inboard and it stays within reach; then `handsOn` → 0 over 0.3 s | arms and body blend to the `idle_stand` clip; legs stay planted until the crew system issues `walk` |
| `stepIn` | clip walk to the approach point (stance centre − 0.6 m along facing) | turn in place to face aft (procedural root yaw, 0.6 s); two procedural foot placements (0.35 s arcs, 6 cm lift) onto the stance targets; hands reach to the grips with `handsOn` 0 → 1 over 0.4 s along an arc above the loom |
| `stepOut` | reverse of stepIn | the relief takes the grips only after the leaver's `handsOn` < 0.5 (the crew system sequences this) |
| `walk` | `walk` clip | phase advanced by distance travelled / stride length, so the feet don't skate; root from the crew system's position and heading; turns under 90° via root yaw; larger turns via a turn-in-place clip or a procedural 2-step |
| `idle` / `rest` | `idle_stand` / `rest_sit` clips | head look-at layer always on (w = 0.7) |

Clips needed from Blender: `walk`, `idle_stand`, `rest_sit` (on a hatch or deck), optionally `turn_90`. That's all. Step-in and step-out are procedural because the stance targets depend on the oar.

### 2.6 Stance and the arc question (needs a decision) [V numbers, A recommendation]
The stance is auto-placed from the oar geometry:
- centre = mid-stroke grip midpoint − 0.60 m along facing, + 0.15 m laterally;
- left foot forward (+0.40 or +0.32), right foot back (−0.30 or −0.25), each 0.16 m off centre.

Starboard fore sweep (slot 1), 40 s randomised run:

| arc | stance (fwd/back) | hand error p95 / max | frames > 3 cm | min knee angle | look |
|---|---|---|---|---|---|
| full +0.72/−0.58 | 0.40/0.30 | 0.0 / 2.6 cm | 0 % | 43° (deep lunge) | dramatic lunge at the catch, sumo crouch in between |
| full | 0.32/0.25 | 1.3 / 7.9 cm | 3.5 % | 75° | natural, but hands slip off at the longest catches |
| reduced +0.45/−0.38 | 0.32/0.25 | 0.0 / 0.0 cm | 0 % | 77° | the most natural (see `snaps_reduced_sheet.png`) |

My recommendation:
- Ask physics for an arc of about 0.85 rad on the merchant sweeps, or let the agent's "long stroke" use the full arc only rarely.
- Implement **stance re-planting**: a smoothed estimate of the recent catch and finish handle positions sets the ideal feet. When a planted foot is more than 10 cm from its ideal, step it in the phase where it is unloaded (front foot late in the drive, back foot in the recovery). Not implemented in the PoC.
- Optionally raise the tholes about 0.15 m. With wetDepth 0.23 the drive handle sits about 1.0 m above deck, which is hip height for this figure, so the trunk never comes fully upright (pitch stays ≥ 18° forward on the reduced arc). **[A]** My sim used wetDepth 0.12 by mistake; the real 0.23 puts the drive handle about 5 cm higher, which helps slightly.

---

## 3. Ship motion (counter-balance) [V cost, A look]
Yes, counter-balance. A sailor's trunk staying near world-vertical while the deck rolls is one of the cheapest "alive" cues available.

Implementation (in the PoC):
- `worldUp_local = shipQuat⁻¹·(0,1,0)`, once per ship per frame.
- Per rower: `upB = lerp(deckUp, worldUp_local, 0.7)` through a 3-axis spring with ω = 4. That gives a visible reaction lag, not gyro-perfect stabilisation.
- The trunk's sagittal frame uses `upB`, and the pelvis shifts by `0.45·(upB − deckUp)`.
- Feet stay on the deck; leg IK absorbs the rest.
- Heave: deck vertical acceleration × 0.01 m per m/s², clamped, sprung into knee flex.

Cost: a few vector operations, already included in the 13-20 µs. What it looks like in motion is unverified; I only saw stills at whatever roll the snapshot frame had. Use the interpolated render quaternion for worldUp, not the physics state, or the trunk will jitter at 120 Hz → 60 Hz aliasing. **[A]**

---

## 4. Performance
- **CPU [V]:** 13-20 µs median per rower in Node 25 (V8, same engine as Chrome) for solve + `updateMatrixWorld` + `skeleton.update`; p99 60-90 µs (GC from the PoC's allocations). Eight rowers ≈ 0.15 ms median at 60 fps. Port allocation-free: preallocated scratch vectors, no `clone()`, no closures in the bisection.
- **Mixer:** with the exporter defaults the test clip baked **66 tracks** (every bone × T/R/S). `export_force_sampling=False, export_optimize_animation_size=True, export_optimize_animation_keep_anim_armature=False` cut it to **3** **[V]**. Use these in rowers.py, or the mixer cost will exceed the IK.
- **GPU:** skinning about 1600 verts × 8 is nothing. Draw calls dominate (§1.6). Shadows: three's built-in depth material handles skinning. The repo's `patchMaterial` reads `transformed` after `project_vertex`, which is post-skinning in three's chunk order, so aerial fog and terrain shadow are correct on skinned meshes. **[V]** by reading the code, not by rendering.
- **Culling:** a SkinnedMesh's bounds come from the bind pose, so a lunging rower can be culled at the screen edge. Set `frustumCulled = false` on the crew (8 figures), or enlarge the bounding sphere by 1 m.
- **LOD:** not needed for CPU at 8 rowers. If you want it: skip `solve` (keep the last pose) when the figure is off-screen and not in the reflection; drop to 30 Hz solves beyond 80 m. Nothing here threatens the 60 fps lock. The only things to watch are GC spikes from a non-allocation-free port and the draw-call count.

---

## 5. Integration plan

### 5.1 New files
- `tools/blender/rowers.py` builds `public/assets/models/crew.glb`:
  - `fig_rower_a/b/c`: pose_std bodies with seeded proportion jitter (±4 % limb length, radii), hair and cloth variants, a shared bone naming;
  - clips `walk`, `idle_stand`, `rest_sit` (and `turn_90`), exported with the optimise flags above;
  - previews into `tools/blender/previews/`: rest pose, a weight overlay per chain (vertex colours from weights), and a pose-check sheet that imports posed OBJs from the test harness, like `crew-anim/render_snaps.py`.
- `src/crew/rowerRig.ts`: the solver (port of `rowerIK.mjs`), one per figure. `reset()`, `setStance()`, `solve(input, dt)`, writing into a pose buffer.
- `src/crew/crewAnimator.ts`: owns the figures (SkeletonUtils clones), mixers, the per-member state machine of §2.5, stance planning, step planning, per-chain blend weights and the dynamic walk solids.
- `scripts/test-rowers.mjs`: the headless harness (from `crew-anim/node/sim.mjs`): metrics plus optional OBJ snapshots.

### 5.2 Loader changes (`src/gfx/models.ts`)
- `get()` uses `Object3D.clone(true)`, which **shares the source skeleton** **[V]**. Every rower would move together. Use `SkeletonUtils.clone` for any object containing a SkinnedMesh.
- The figure's named root must be the **armature node**. In my glb the mesh object `fig_rower` loads as a group of 4 SkinnedMesh *under* `rower_rig`, so `get('fig_rower')` would return meshes without bones. In rowers.py, name the armature `fig_rower_a` and the mesh `fig_rower_a_mesh`.

### 5.3 Hook points
- `MerchantModel` builds a `CrewAnimator` in place of the static crew loop (merchantModel.ts "crew" section), parented to the ship group.
- `MerchantModel.update(physics, crew, night, time, alpha)` calls `crewAnimator.update(dt, oarVisual, crewViews, shipMotion)` **after** it computes each oar's drawn transform. The rowers must grip the **drawn** oar, which includes `oarStow` boating and any visual offsets, not raw `renderPose`, or the hands detach while shipping oars. Expose `oarVisual(i): { handle: Vector3, axis: Vector3, feather: number }` from the same matrices used for the oar instances.
- `shipMotion = { worldUpLocal: Vector3, heaveAcc: number }` from the interpolated render pose (game.ts has it at the `model.update` call).

### 5.4 Data contract from the crew system (per member, per frame)
```ts
interface CrewMemberView {
  id: number;
  figure: 'fig_rower_a' | 'fig_rower_b' | 'fig_rower_c';
  seed: number;                       // noise and variation
  mode: 'row' | 'hold' | 'shipped' | 'walk' | 'stepIn' | 'stepOut' | 'idle' | 'rest';
  oar: number;                        // slot index, -1 if none (row/hold/shipped/stepIn/stepOut need it)
  handsOn: number;                    // 0..1 target grip; the animator ramps it, the crew system sequences hand-overs
  effort: number;                     // 0..1 = handleForce / handleLimit (or the agent's effort), smoothed by the crew side
  driving: boolean;                   // blade loaded (drive) vs recovery; from the oar contact or agent phase
  strokePhase: number;                // 0..1, catch = 0; style only (breath timing, glance timing)
  fatigue: number;                    // 0..1; increases slump, lowers the head, slows the gaze springs
  gaze: { kind: 'member'; id: number } | { kind: 'helm' } | { kind: 'point'; p: Vector3 } | null; // ship-local
  walkTarget?: { x: number; z: number; yaw: number }; // walk/stepIn: where the crew system wants them
  pos?: { x: number; z: number; yaw: number; speed: number }; // authoritative position if the crew system moves them
}
```
The animator owns stance placement, grip ramps, foot locking and stepping, clip phase, smoothing and the head look-at. The crew system owns who is where, which oar, effort, the gaze choice and hand-over timing. Gaze by member id lets the animator aim at that member's live head bone, so "glancing at the stroke leader" tracks the leader's actual lean.

### 5.5 Walker collision
The current static cylinders (game.ts:291) assume fixed crew spots. `WalkGeometry` uses a static spatial grid and `remove()` scans every grid list, so it is not suited to per-frame updates. Proposal:
- add `WalkGeometry.dynamic: CylSolid[]`, checked brute-force in `near()` and `collide()` (8 entries);
- the animator owns one cylinder per member: r 0.28 m, deck to deck + 1.75 m;
- while rowing, centre it on the stance centre with r 0.35 m (static during the stroke; the pelvis moves ±0.4 m inside it);
- while walking, it follows the pelvis.
- The sweep loom sweeping through the walker is a separate question (§7).

---

## 6. Risks and verification

| risk | status | mitigation | test |
|---|---|---|---|
| elbow or knee swing (pole aligned with the reach direction) | **hit in the PoC, fixed** | pole behind the body; detect `|pole·dir| > 0.8` and blend to a fallback pole | max per-frame bone rotation (< 12° at 60 Hz outside input discontinuities) |
| hands lagging off the loom | **hit, fixed** | constraints after smoothing; reach model = exact FK | hand-to-grip p95 < 1 cm, max < 3 cm |
| IK pop at the catch (straightening snap) | mitigated | soft IK (97 % arms, 98.5 % legs) | max error 2.6 cm only at the longest catches |
| feet sliding | none with planted IK: 0.06 cm toe drift (heel lift allowed) | the step planner must lock toes during a step's contact phase | toe-on-deck drift metric, per plant |
| candy-wrapper wrists | not an issue for this asset (twist < 0.5°, round tubes, blob hands) | minimal-twist hand frames; twist bones only if hands get fingers | twist angle metric; forearm cross-section radius on skinned verts (not built) |
| chiton clipping through the thighs in a deep lunge | looks acceptable in 15 rendered poses; front hem follows the thigh | hem leg share ≤ 60 %; optionally one hem lag bone (spring) for life | only visual so far; add a metric: thigh skin verts outside the skinned chiton hull per height band |
| deep crouch / sumo look with a wide stance | **visible in the full-arc sheet** | narrower stance plus re-planting, or a shorter arc (§2.6); reduce the knee pole's outward component | min knee angle metric, a human eye |
| port side, after deck, rower-to-rower crowding | **untested** (starboard fore only) | mirror by construction (solver uses body right); ask physics to stagger port and starboard stations | run the harness on all six slots; check rower-rower and rower-loom distances |
| GC spikes | PoC allocates | allocation-free port | performance-panel GC count over a 60 s row |
| shared skeleton bug via `clone()` | **verified** that plain clone shares | SkeletonUtils.clone | unit test: two instances, different poses |

**Headless tests to keep** (all exist in the PoC):
- hand-to-grip error from the real three.js skeleton, not solver internals;
- toe drift on deck;
- per-bone per-frame rotation (pop detector);
- min knee and elbow angle;
- reach deficit;
- µs per solve;
- posed OBJ dump → Blender contact sheet (side, 3/4 and top) of catch, mid-drive, finish, mid-recovery and hold.

**Needs a human eye in the browser:**
- whether the lean "reads" from the chase camera at 24 m;
- counter-balance against the deck roll in motion;
- gaze glances: timing and frequency, and whether coordination is visible;
- the chiton in motion;
- the step-in / relief hand-over choreography;
- the sumo-crouch question;
- shadow and reflection correctness on skinned meshes.

---

## 7. Open questions for you and physics
1. Can the merchant sweep arc come down to about 0.85 rad (or the agent cap long strokes), and can the tholes rise about 0.15 m? These two numbers decide between "deep lunge" and "natural". See `snaps_full2_sheet.png` vs `snaps_reduced_sheet.png`.
2. Who owns hand-over timing during a relief: does physics tolerate a sweep with no hands for about 0.5 s, or does the relief grip while the tired rower is still on it (two figures on one loom)?
3. Port and starboard sweeps at the same station put both rowers within about 0.6 m of the centreline (handles reach x ≈ ±0.17 m at mid-stroke). Will stations be staggered?
4. Do you want one merged-material crew primitive (8 draws per pass) at the cost of a new vertex-colour slot material?
5. Should the walker collide with the moving looms? It is a different problem from figure solids.

## Files
- `crew-anim/rig_rower.py`: Blender rig and export PoC → `fig_rower.glb`, `previews/`
- `crew-anim/node/load_check.mjs`: GLTFLoader, skin, bind, mixer and clone checks
- `crew-anim/node/rowerIK.mjs`: the solver
- `crew-anim/node/sim.mjs`: randomised-stroke harness and metrics, OBJ snapshots (env: GRIP, D0, LAT, SPF, SPB; arg `full|reduced`)
- `crew-anim/render_snaps.py`: Blender contact sheet from snapshots
- `crew-anim/snaps_full2_sheet.png`, `crew-anim/snaps_reduced_sheet.png`: pose sheets (rows: catch, mid-drive, finish, mid-recovery, hold; columns: side, 3/4, top)
