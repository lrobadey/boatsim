# Sailing validation

This report records the original sailing evolution. The subsequent [performance tuning](sailing-tuning.md) changes the coefficient, default wind and crew trim; its separate results supersede the performance numbers below for the current source.

The coupled square-rig implementation satisfies the researched contract in [sailing-spec.md](sailing-spec.md). Lead and GPT-6 Astra (low reasoning) authored the design; GPT-6 Luna (high reasoning) workers implemented bounded slices. [Directions](sailing-directions.md), [agent discussion](sailing-agent-discussion.md), and [Astra review](sailing-review.md) record the choices and review.

## Verification

- `npm run test:sailing`: **11/11 passed**, final lead-run exit code 0. Full measurements and per-test results: [sailing-validation-results.json](sailing-validation-results.json).
- `npm run test:rowing`: **18/18 passed**, worker-run exit code 0 with the new hull model and sail integration. Recorded output metrics: [body worker discussion, evidence appendix](sailing-discussion/luna-body.md). The original unchanged suite also passed before implementation.
- `npm run typecheck`, `npm run build`, and `git diff --check`: passed.
- The initial acceptance run was headless. At the user's subsequent request, the lead verified the production build in the browser, including native sail controls, the rendered rig/HUD, propulsion regimes and console/shader health. See [the browser verification record](sailing-browser-validation.md) for screenshots, telemetry and limits.

## Different propulsion regimes

Controlled flat-water runs began at rest, used constant uniform 8 m/s following wind, deep terrain, no mooring, squared manual yard, and 120 Hz physics for 120 seconds. Rowing order was Full when active. Speeds are means over the final 30 seconds, rather than maximum speed targets.

| Configuration | Mean speed | Sail impulse | Oar impulse | Final crew stamina |
| --- | ---: | ---: | ---: | ---: |
| Sail only | 4.226 kn | 258.236 kN s | 0 | 1.000 |
| Rowing only | 6.698 kn | 0 | 668.640 kN s | 0.991 |
| Sail + rowing | 6.877 kn | 146.017 kN s | 581.234 kN s | 1.000 |

Combined propulsion gives a modest speed gain in this moderate following breeze while reducing delivered oar impulse by about 13.1%. Its moving-sail load was 1.092 kN, versus 3.526 kN on the stationary body in the same air flow: rowing changes the wind over the sail, so the forces are not two independent thrust sources. These are local model results, not historical trireme measurements.

With no true wind, the deployed sail imposed air resistance on a rowing ship. Mean speed was 6.434 kn with cloth deployed versus 6.606 kn furled in the 60-second fixture, within the specified 5% envelope. Facing an 8 m/s headwind, Full rowing with the sail set made 18.67 m forward progress over 20 seconds; the resting crew drifted 8.57 m backward. Brailing remains a useful player choice when the sail is aback.

## Coupling and robustness

- A loaded, braced sail in the mirrored beam-wind fixture produced 0.253 m/s water-relative lateral velocity and 5.33° heel; mirrored lateral response matched and heel differed only at numerical roundoff.
- Gust loading while rowing changed actual heel by up to 7.31° relative to calm and changed cumulative blade immersion. The existing per-oar geometry/force authority remains intact.
- Uniform-wind half-sail load was exactly 50% of full; with height shear it was 51.54%. Its exposed-area center rose 1.75 m, following the brailed geometry. Maximum per-step deployment load change was 0.154% of full load.
- A 40-second automatic-trim heading sweep passed through drawing, luffing and aback states with signed pressure inversion. Fill changed by at most 0.01045 per 120 Hz step and yard motion remained within 0.25 rad/s. Settled headwind sail drive was negative.
- The 1,000-case sail passivity test and 1,000-case hull passivity test passed. Lift/drag coefficients stayed continuous through separation and broadside loading; exact calm produced zero true wind and zero wind-driven flutter.
- 120 versus 240 Hz convergence over 60 seconds: final speed error **0.00382 m/s**, position error **0.0608 m**, sail impulse error **0.1204%**, yard error **0 rad**. The original tolerances were retained.
- A 300-second varied wind/wave run remained finite and kept the quaternion normalized. Maximum heel was 6.38°, maximum sail load 6.57 kN. During its genuine 50-second calm/rest interval, rigid-body kinetic energy fell from 47.23 to 20.17 kJ. This is numerical stability evidence, not storm-survivability validation.
- The preserved rowing suite's ten-minute default-sea check passed. Local offline full-ship CPU timing was mean 0.931 ms, p95 1.034 ms; these numbers do not establish browser or GPU performance.

The convergence audit found a real four-Hz controller timing defect: floating-point accumulation delayed the 120 Hz trim decision by one step. A tolerance-aware period comparison fixed the schedule. Review also corrected the calm-window fixture and replaced an edge-on sail fixture with a loaded sail before final acceptance. No coefficient or acceptance threshold was changed to conceal a failing test.

## Fidelity boundary

Sail section coefficients, coherent gusts and shallow-hull lift are bounded engineering approximations. The model includes distributed rigid-body apparent wind, finite sail/yard response, coupled heel/leeway and preserved rowing work. It does not solve cloth dynamics, terrain airflow, atmospheric stability, or CFD, and is not calibrated to an Olympias performance polar. Cloth billow is a visualization of physical loading on planar force geometry.
