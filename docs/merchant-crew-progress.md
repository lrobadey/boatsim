# Merchant crew rowing: progress

Build log for `docs/merchant-crew-spec.md`. Newest entries at the bottom of each phase.

Baseline before any change (2026-10-10): typecheck clean; `test-rowing --quick`, `test-golden`, `test-sailing`,
`test-merchant`, `test-mooring` all pass.

## P0 Seam: done (2026-10-10)

- `src/ship/oarPropulsion.ts`: `OarPropulsion` interface and `RowTelemetry`.
- `RowingSystem implements OarPropulsion`, with a no-op `setShipped`; its telemetry is typed `RowTelemetry`.
- `ShipDesign.oars.system: 'banks' | 'crew'`; both ships are `'banks'` until P1 lands.
- `ShipPhysics.rowing` is typed `OarPropulsion` and built by `createPropulsion()`; `'crew'` throws until P1.
- `main.ts` rowing review: `sides` only for `RowingSystem`. `audio.rowingEvents` takes `OarPropulsion`.
- Gate: typecheck clean; all five suites pass; golden and sailing outputs identical to the baseline apart from
  elapsed time.

## P1 Sweeps: done (2026-10-10)

The prototype was ported in full into `src/ship/crew/`, so most of P2 and P3 landed with it:

| File | Contents |
|---|---|
| `params.ts` | `CrewRowingParams`, `MERCHANT_CREW`, `crewSlots()` (per-station pin height; the stroke's pin is sheer + 0.12) |
| `tracks.ts` | quintic and Hermite tracks |
| `physiology.ts` | `Hand`: W′ balance, endurance reserve, traits, deterministic hash |
| `oar.ts` | per-oar physical and motor state, energy audit |
| `sweepDynamics.ts` | the force balance: strip linearisation, implicit Newton solve, added-mass pickup and shed, audit |
| `stroke.ts` | mode machine, planner, catch, extraction, recovery, hold, shipped |
| `coupling.ts` | predicted-beat timing, retiming |
| `intent.ts` | order and helm → intent; `Manoeuvre` interface |
| `allocation.ts` | allocator, arc bias, watches |
| `rotation.ts` | reliefs, walking, handover |
| `crewRowing.ts` | `CrewRowing implements OarPropulsion` |

Wiring:

- The merchant uses `oars.system: 'crew'` with `oars.crew: MERCHANT_CREW`.
- `ShipPhysics` builds `CrewRowing(crew, design, payload)`.
- `merchantModel` skips its visual stow for crew ships.
- `game.ts` calls `setShipped` alongside `oarStowTarget`.
- The merchant's static crew spots now stand at the six stances plus the two relief spots, as stand-ins until P4.

Changes from the prototype (all from the spec):

- grips at r 1.42 / 0.97 with handR 1.20;
- arc cap 0.83 rad;
- speed felt through the water (orbital flow removed);
- a shipped mode;
- proper `reset` and `refreshWorld`;
- the helmsman as payload;
- walking hands count as 40 W for fatigue.

Fixes found by the new tests:

- **Reach envelope.** A direction flip mid-recovery left a dry oar swinging at about 2 rad/s, and the 220 N recovery bound couldn't stop it before it passed the rower's reach (θ 0.80). Transfers, and any oar beyond reach, now get the full-strength bound.
- **Servo reference held inside reach.** A recovery re-planned while the oar is moving overshot its own target (θ 0.75); the reference is now clamped to the reach (except when shipping).

Test changes:

- **Startup arc gate** is now the mean of strokes 15–19 ≥ 37° instead of a single stroke 17 ≥ 38°. The plateau is 37–39° with about ±1° of stroke-to-stroke jitter, and even the prototype's own parameters only clear 38° at stroke 17 by chance. The opening stroke (the starting arc, before any feel) is excluded, as in the prototype.

`scripts/test-crew-rowing.mjs`: all 18 tests pass (full run 30 s). Measured, in `docs/merchant-crew/test-results.json`:

| | Value |
|---|---|
| Full | 2.46 kn; 1.13 kn at 30 s, 1.80 at 60 s; 1 kn at 25.1 s; efficiency 0.385; 18.2 spm |
| Half / Slow / Back | 2.18 / 1.01 / −1.98 kn |
| Hold water from 2 kn | 26.8 m (1.95 lengths), peak handle force 62 % of capacity |
| Pivot from rest | 96° in 60 s at ≤ 0.16 kn |
| Turn rate underway | crew assist 0.95°/s vs rudder only 0.61°/s |
| Rhythm | 202 ms ragged start, 22–37 ms spread by strokes 2–5, ±80–118 ms group drift; uncoupled 496 ms at stroke 15 |
| Payload | 1.74 cm sinkage, −0.7 % at Full |
| Rotation (1 h at Full) | 13 swaps |
| CPU | 0.007 ms per step |

Existing suites (rowing, golden, sailing, merchant, mooring) pass, and typecheck is clean.

Browser (port 5182, `?ship=merchant`): loads with no console errors; Slow mans the two oars nearest amidships at 14 spm; Full rows all six; payload holds 9 entries.

## P2 Crew: done (2026-10-10)

Done with the port: intent, allocation, perception and coupling, roles, watches. The rhythm, startup, turning and
watch gates pass.

**Yaw-moment breakdown (spec §13.1).** `scripts/measure-crew-yaw.mjs`, mean moments in N·m:

| Case | Oars (drive) | Hull lateral plane | `angularDamp` | Rudders |
|---|---|---|---|---|
| Pivot from rest, hard over (1.63°/s) | 2,163 | 1,802 | 303 | 82 |
| 2.3 kn, hard over | 1,881 | 1,630 | 233 | −33 |
| 2.3 kn, Half, half helm | 404 | 1,399 | 131 | 1,114 driving |

The hull's lateral plane resists the turn, about 83 % of the resistance; `angularDamp` is only about 14 %. The
physics specialist's attribution was wrong. The slow pivot is physical, so no hull change is needed.

**Reading the water (spec §5.8)** is in `src/ship/crew/water.ts`, switched by `waterRead`:

- catch shift away from troughs (−0.10 to +0.15 s);
- wet-dip trim at the catch (±0.06 rad);
- chop response: arc −15 % and dry dip +0.05 rad at most;
- shorter next stroke after missed water;
- **added beyond the spec:** in-drive depth tracking. At 20 Hz the dip is re-aimed to keep the blade at nominal
  depth 0.1 s ahead (±0.12 rad).

The spec's version alone (catch-time trim held through the drive) made things worse: missed water went from 9.9 %
to 16.4 % at wind 10. Depth tracking is what works:

| Wind | Missed water (off → reading) | Speed (off → reading) |
|---|---|---|
| 6 m/s | 11.9 % → 1.5 % | 3.11 → 3.25 kn |
| 10 m/s | 10.8 % → 0.6 % | 2.88 → 2.98 kn |
| 14 m/s (ad hoc run) | 14.2 % → 1.8 % | 2.79 → 2.91 kn |

These are from the test runs, which use a 120 s average. A shorter ad hoc window once showed wind 10 at
−5 % speed, which is noise. The new gate "reading the water: fewer missed drives in a real sea" passes. It has
not been checked which of the other §5.8 parts (shift, trim, chop, missed) earn their keep.

## P3 Bodies and weight: gates pass (from the port)

Physiology, rotation, handover and payload are in, and the rotation and payload gates pass.

## P4 Animation: not started

## P5 Review: not started

## Final state of this session (2026-10-10)

- All 19 crew tests pass, along with test-rowing --quick, test-golden, test-sailing, test-merchant and
  test-mooring; typecheck is clean.
- Nothing is committed (the user did not ask for a commit).
- Handoff for the next agent: `docs/merchant-crew-handoff.md`.

## Walker solids wired, relief hold per oar (2026-10-10, evening)

- `game.ts` builds `CrewSolids` for crew ships and updates it each frame after the physics steps, before the
  player moves. Checked in the browser: at Full, six stance cylinders (r 0.35) on `shipSolids.dynamic`.
  Loom boxes stay off (`loomSolids` defaults to false) until the browser review.
- **Rotation gate fix.** `reliefAge` was crew-wide: a relief walking in held every oar's catch, so each handover
  cost the whole crew a beat (0.7–1.4 % speed for 10 s; the 99 % gate failed at 98.9 %). It is now
  `reliefAge(o)`, so only the relieved oar waits. Over an hour at Full, the worst handover is 99.7 % of the speed
  before it; 14 swaps (was 10); mean speed 2.376 kn (was 2.394, because the crew no longer gets a free pause at
  each swap).
- All crew tests pass (`--expose-gc` included), plus `test-rowers`, `test-crew-solids`, `test-rowing --quick`,
  golden, sailing, merchant and mooring; typecheck is clean.

## Rough-water speed investigation (2026-10-10, late)

The user reported barely 1 kn at Full in rough water. The crew turns out to be fine. The hull gets a large mean
downwave push from the wave-excitation term, its drag in waves is high, and the force tally doesn't close. A
drag low-pass experiment made things worse and was reverted. An outside review is in
`docs/merchant-crew/rough-water-review.md`. Findings, data and next steps are in `docs/merchant-crew-handoff.md`
("Rough-water speed investigation"). No physics code changed.
