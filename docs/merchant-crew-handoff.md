# Merchant crew rowing: handoff

For the next agent picking up the merchant ship's agent crew. Written 2026-10-10 at the end of the session that
specced and built P0–P3. **Updated late 2026-10-10:** P4 is built, and a rough-water speed problem is under
investigation. **Start with "Rough-water speed investigation" below; it is the open work.**

## Read these first, in order

1. `docs/merchant-crew-spec.md`: the spec (rev. 1). §14 records the user's answers: yes to all four
   recommendations.
2. `docs/merchant-crew-progress.md`: what was built, every deviation from the spec and why, and measured
   results.
3. `docs/merchant-crew/animation-poc/proposal.md`: the P4 design, backed by a working rig and IK proof of
   concept.
4. `docs/merchant-crew/physics-prototype/proposal.md`: derivations behind the physics (reference; it is ported).

## What the user wants (in their words, condensed)

The merchant's rowing felt dead ("barely moving"). The user asked for a real system: rowers as individual skilled
agents who respond to the water, to their own blade and to each other, and know what the others do in turns.
The movement should be organic: strokes slightly out of step, settling and drifting. Specifics:

- No literal talking; coordination is systemic.
- No mistakes yet, but leave room.
- Six rowers, three per side, worked standing; 8 hands with rotation; the player is the helmsman.
- Crew weight counted.
- Order ladder unchanged; Turn 180 later.
- Animated rowers built with Blender.

They asked for the work "phase by phase on a loop until it's all integrated and works". They prefer plain wording
(see memory `plain-ui-text`). Don't commit unless asked.

## State

| Phase | State |
|---|---|
| P0 seam (`OarPropulsion`, `oars.system`) | done |
| P1 sweeps (force-balance physics, six stations, shipped mode) | done |
| P2 crew (intent, allocation, coupling, watches, reading the water, yaw breakdown) | done |
| P3 bodies and weight (physiology, rotation, payload) | done (gates pass) |
| P4 animation (rowers.py, crew.glb, rowerRig, crewAnimator, crewSolids, view, test-rowers) | done; walker solids wired in game.ts |
| P5 browser review | not started; waits on the rough-water question below |
| **Rough-water speed** | **under investigation: next** |

Everything passes:

- `node scripts/test-crew-rowing.mjs` (19 tests, about 45 s; `--quick` about 25 s);
- `test-rowing --quick`, `test-golden`, `test-sailing`, `test-merchant`, `test-mooring`;
- `npx tsc --noEmit`.

Results are written to `docs/merchant-crew/test-results.json`.

Headline numbers (calm water):

| | Value |
|---|---|
| Full | 2.46 kn; 1 kn in 25 s; efficiency 0.385 (was 1.86 kn, 68 s, 0.21) |
| Half / Slow / Back | 2.18 / 1.01 / −1.98 kn |
| Hold water from 2 kn | 1.95 lengths |
| Pivot from rest | 96° in 60 s |

## Where the code is

`src/ship/crew/`:

| File | Contents |
|---|---|
| `crewRowing.ts` | `CrewRowing implements OarPropulsion`: the step loop, frames, events, telemetry, Crew facade, payload |
| `sweepDynamics.ts` | the per-oar force balance (implicit Newton), added mass, energy audit, the reach envelope |
| `stroke.ts` | per-oar mode machine and stroke planner; `CrewContext` |
| `coupling.ts` | timing: predicted beat, retiming |
| `allocation.ts` | who pulls, eases or backs; watches |
| `intent.ts` | order and helm → intent; `Manoeuvre` interface for Turn 180 |
| `rotation.ts` | reliefs |
| `physiology.ts` | `Hand` |
| `water.ts` | reading the water |
| `params.ts` | `MERCHANT_CREW` and `crewSlots` |
| `oar.ts`, `tracks.ts` | per-oar state and motor tracks |

Touched outside the folder, all narrow edits:

- `src/ship/oarPropulsion.ts` (new);
- `rowing.ts` (`implements`, no-op `setShipped`);
- `physics.ts` (factory, field type);
- `design.ts` (`oars.system`, `oars.crew`; merchant set to `'crew'`; merchant `crewSpots` now stand at the six
  stances plus two relief spots as static stand-ins; `merchantSweeps` removed);
- `merchantModel.ts` (skip visual stow for crew ships);
- `game.ts` (`setShipped` next to `oarStowTarget`);
- `main.ts` (guard `rowing.sides`);
- `audio.ts` (type).

Tools:

- `scripts/test-crew-rowing.mjs`;
- `scripts/measure-merchant-rowing.mjs` (calm-water order trial; its old override arguments no longer apply);
- `scripts/measure-crew-yaw.mjs`;
- `.claude/launch.json` has a `trieres-crew` entry on port 5182, because other sessions use 5173.

**Other sessions are editing this repo at the same time** (mooring, UI redesign, sailing). Many files show as
modified that are not this work. Re-read before editing and keep edits narrow.

## P4 animation: done (the original plan, kept for reference)

1. `tools/blender/rowers.py`, based on `docs/merchant-crew/animation-poc/rig_rower.py` (Blender 5.2.2,
   headless: `/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P …`):
   - 20 bones (drop the forearm-twist bones);
   - one merged vertex-colour primitive;
   - the armature node carries the figure name;
   - clips `walk`, `idle_stand`, `rest_sit`, with the exporter optimise flags;
   - outputs `public/assets/models/crew.glb` plus previews.
2. `src/gfx/models.ts`: use `SkeletonUtils.clone` for skinned models. Today's plain `clone()` shares one skeleton
   (verified). Fix the figures.py L/R comment.
3. `src/crew/rowerRig.ts`: an allocation-free port of `animation-poc/node/rowerIK.mjs`. Keep the three
   hard-won rules:
   - reach constraints run *after* the smoothing springs;
   - the reach model must equal the real spine FK;
   - the elbow pole points behind the body.
4. `src/crew/crewAnimator.ts`, built from `merchantModel`'s crew section. It replaces the static figures for
   crew ships and drives from `CrewMemberView` (spec §9.6). That view **does not exist yet**: add `crewView` to
   `CrewRowing`, double-buffered, filled from `Hand` and `Oar` state:
   - mode from `hand.state` and `oar.mode`;
   - `gripInner` 0.85–1.0 for a relief during handover (`oar.second`);
   - effort = `oar.u`; phase and progress from `lastCatch`, `period` and `plan`;
   - fatigue = 1 − S;
   - gaze: followers → the man aft, the stroke → the helm, the blade at the catch;
   - walk from `hand.walk`.

   The rowers grip `renderPose(i, alpha)`; shipping is physical, so no `oarVisual()` is needed.
5. Walker: `WalkGeometry.dynamic` cylinders per hand plus a keep-out box per manned station (spec §9.8). Remove
   the merchant's static crew-spot cylinders (game.ts, around line 291).
6. `scripts/test-rowers.mjs`, from `animation-poc/node/sim.mjs`, driven by *recorded physics strokes* at all six
   stations (spec §12.3).

**Known gap for P4:** walking in `rotation.ts` is a straight-line lerp. The spec's slalom (alternating free halves
of the deck, path factor 1.3) is only accounted for in walk time. The animator needs waypoints: add them to
`HandWalk`.

## Rough-water speed investigation (open, 2026-10-10 late)

**What the user saw:** at Full in the game, in rough water, the merchant barely makes 1 kn. They suspected the oar
physics was holding the boat back. It isn't the oars.

**What was measured** (scratch scripts, see below; Full order, no wind, autopilot on course; "into the sea" means
bow into the waves):

| Sea (wind U, Hs) | Waves astern | Beam | Into the sea |
|---|---|---|---|
| calm | 2.2 kn at 120 s (2.46 steady) | | |
| 8 m/s, 0.7 m | 2.02 | 1.60 | 0.98 |
| 12 m/s, 1.5 m (game default) | 1.92 | 0.98 | 0.41 |
| 16 m/s, 2.5 m | 1.89 | 0.40 | −0.07 |

- **The crew is fine.** Oar thrust *rises* in waves (about 410–435 N into the sea against 226 N in calm), the
  stroke rate holds (16–18 spm) and missed water is 0–6 %.
- **The hull is being pushed downwave.** Mean forces along the heading (N, 90 s average, 12 m/s sea):

  | Case | Wave excitation (`columnResponse`) | Drag and the rest of `hydrostatics` | Oars | Result |
  |---|---|---|---|---|
  | at rest, into the sea | −325 | +201 | 0 | drifts astern 0.36 kn |
  | at rest, waves astern | +294 | −227 | 0 | drifts ahead 0.38 kn |
  | Full, into the sea | −248 | −104 | +411 | 0.11 kn |

  Drag in waves at 0.4 kn is about 200 N; calm drag at that speed is about 10 N.
- **The tally doesn't close:** −124 N at rest and +59 N rowing are left over, enough to change her speed by about
  a knot in 90 s. Some force or acceleration is not being counted. Best guess: the integrator divides force by a
  different effective mass per hull axis (heave added mass ≫ surge), so as she pitches, big vertical forces leak
  into fore-and-aft acceleration without ever showing up as a force.
- **`scripts/test-hull-waves.mjs` fails 2 of 3 gates.** A towed merchant in a 0.4 m sea keeps 28 % of its calm
  speed (gate 85 %), and its calm-tow reference (2.24 kn) is stale: it measures 2.489 now. Find out why calm
  changed before trusting that gate. The trireme passes (it's fast compared with the orbital flow).
- **Tried and reverted:** measuring horizontal hull drag against an 8 s low-pass of the CG orbital flow (the
  audit's must-fix 1, `docs/merchant-crew/behaviour-audit.md`). It made every heading **worse** (12 m/s: 1.06 /
  0.65 / 0.26 kn), because the pointwise drag was partly holding the hull against the excitation's push.
  `physics.ts` is back to how it was.

**Outside review** (the user asked an expert reviewer; full answer in `docs/merchant-crew/rough-water-review.md`):

- About 300 N of steady wave push is **physically plausible** for this hull and sea. The model just doesn't
  *establish* it consistently. Don't tune it away to recover a rowing speed.
- **Wind matters most in the game.** A 12 m/s headwind on the merchant's windage is about 450 N, more than the
  whole crew's thrust. Rowing into a fresh wind and sea at about 1 kn or less may simply be correct. Always test
  waves only and wind plus waves separately.
- **Historical benchmark:** Cariolou's Kyrenia II report gives **0.75 kn with four oarsmen in dead calm**. Our
  spec's 1.8 kn benchmark is contested, so our calm speed may be generous.
- Top suspects for a spurious mean: pitch/roll rotating the anisotropic added mass and excitation; moving
  sampling points and depth; V × a phase correlation; variable added mass without full dynamics; Gerstner
  kinematics reused below the surface. On the drag side: the steady `Fr⁶` wave-making term applied per column,
  steady induced drag used for oscillating crossflow, and the astern multiplier rectifying symmetric flow.
- Long-term fix: first-order wave loads on the mean geometry plus an explicit mean-drift table. That is a rewrite
  of how *every* hull handles waves, so it needs the user's go-ahead.

**Next steps, in order** (diagnose first; no physics changes until the user agrees):

1. **Close the momentum balance.** Log ΔP against ∫F over the run, including the implicit added-mass reaction
   (the per-axis effective-mass division in `ShipPhysics.step`) and every force source (sailing, payload,
   mooring, ground). Use track over ground for mean speed. Find the missing ~124 N.
2. **Freeze the attitude-dependent parts** at the resting attitude, one at a time: excitation geometry, the
   added mass and its orientation, the depth used by `accelAtDepth`. Each one whose freeze makes the mean push
   vanish is a culprit.
3. **Log the drag pieces separately:** skin friction, the `Fr⁶` wave-making term, lateral crossflow, induced drag,
   the astern multiplier, rotated heave damping.
4. **Run with and without wind** (the game's wind on: `WIND=1` in `_rough-row.mjs`), and with the wind on the
   quarter and dead astern, to give the user honest in-game expectations.
5. Report to the user and decide together: a targeted fix for whatever is spurious, or the reviewer's
   formulation (§5 of the review). Then revisit the calm-water benchmark (0.75 vs 1.8 kn) with them.
6. Then P5, the browser review.

**Scratch scripts** (delete when done; not part of the suite):

- `scripts/_rough-row.mjs`: Full order across seas and headings, with thrust, crew power, wet blades, missed
  water, rate and hull power. Env: `US=0,8,12,16`, `RELS=0,90,180` (0 = waves astern, 180 = into the sea),
  `SECS`, `WIND=1`. About 95 s for the default grid.
- `scripts/_drift.mjs`: mean force breakdown by source (wraps `hydrostatics`, `columnResponse`, `kirchhoff`,
  `rudders`, `windage` and the oars), projected on the horizontal heading. Env: `U`, `REL`, `ORDER` (−1 = oars
  shipped), `SHIP=TRIREME`. About 40 s per run. It does not capture the added-mass division in the integrator
  yet (step 1).

Heading convention: in these scripts `heading = wind.from + π + rel`. In `test-hull-waves.mjs`
`heading = from + rel`, so its `HEAD = 0` is bow into the sea.

## Then P5 (needs the user)

Browser review checklist in spec §12.4. The user decides the stroke-to-helm clearance there (0.57 m). Write
`docs/merchant-crew-validation.md` and update `docs/merchant-ship-plan.md` §4.7 (it still describes four sweeps).

## Open threads and cautions

- **Reading the water:** in-drive depth tracking is what makes it work (missed water about 11 % → 1 %). The
  spec's catch-time trim alone made it worse. Nobody has checked whether the catch shift, chop response or
  missed-water parts help on their own; ablate them if you touch this. Update spec §5.8 to include depth
  tracking.
- **Turning is physical:** the hull's lateral plane provides about 83 % of the yaw resistance in a pivot. Don't
  "fix" it by lowering `angularDamp` (14 %). Turn 180 (later) will take about 2 min for 180°; raise that with the
  user then.
- **The HUD's spm** shows the stroke's actual rate. The UI redesign (memory `ui-redesign-direction`) wants an oars
  and crew panel on the right with true per-oar data and no optimal values. The crew system exposes the data
  (`oars[i].u`, `mode`, catch log, `hands[i]`), but no panel exists yet. That belongs to the UI-redesign work.
- **Units:** `ship.speed` in waves includes orbital-flow removal, so short-window readings swing about ±0.5 kn.
  Average over at least 60 s.
- **Determinism:** no `Math.random` in `src/ship/crew/`; a test greps for it.
