# Rowing validation — 2026-10-05

Status: complete. Revision 3 passes the consolidated suite and supplemental whole-cycle phase test; the same GPT-6 Astra specialist at medium reasoning independently signed off on code, results and nine production images.

## Mechanism and scope

All 170 bank-specific oars use the same evaluated geometry for animation and force. Four clipped strips per blade provide actual wet area, local material velocity and dissipative traction relative to orbital water flow. The continuous command controller handles forward/backing, hold, recovery, feathering, and differential helm. Handle force, instantaneous power and persistent energy reservoirs bound traction. Crew stamina follows delivered work plus exertion. Independent event cursors drive contact foam and grouped audio, and rendering interpolates local joints at the hull's interpolation time.

The implementation follows [the researched specification](rowing-spec.md), including its revision 2 trajectory correction and revision 3 continuous human-limit correction. No force/power/drag/depth calibration constants or hull resistance coefficients were changed to obtain passing speeds. This remains a bounded kinematic traction approximation: no dynamically solved shaft bending, oar inertia, unsteady vortices, individual rowing skeletons, or short GPU FFT wave contact. It cannot certify historical accuracy or optimal subjective feel.

## Reproducible checks

```
npm run typecheck
npm run build
npm run test:rowing
```

`node scripts/test-rowing.mjs --quick` omits the ten-minute stability/performance case. `--test=<substring>` runs a focused case. `ROWING_REPORT=<path>` saves measured JSON. The harness imports the actual runtime modules with the repository's TypeScript compiler and real Three.js math; no browser or replacement physics implementation is used for these checks.

Machine: Apple M4 Pro, macOS arm64, Node v25.4.0. Offline timing is local CPU evidence, not browser/GPU performance.

## Final integrated revision 3 measurements

Flat water, deep seabed, no sail or wind, 120 Hz, 170 rowers, active stamina. Forward/back runs start from rest and average their final 30 seconds of a 120-second run.

| Order | Mean speed | Final stamina |
|---|---:|---:|
| Slow | 3.973 kn | 1.000 |
| Half | 5.631 kn | 1.000 |
| Full | 6.673 kn | 0.983 |
| Back water | -3.601 kn | 1.000 |

Rested full→RAM best five-second mean within 30 seconds: 7.911 kn, from 6.609 kn. Work-based reserve depletion demotes RAM after 135.375 seconds.

From 4 m/s, hold-water reaches 0.3 m/s in 12.225 seconds; raised-oar coasting does not reach that threshold within 60 seconds. Isolated hold-oar work removes 452.55 kJ over 20 seconds, reducing 4 m/s to 0.1704 m/s; no positive actuator work or kinetic-energy increase. Both mirrored hard-helm tests turn 42.35° from rest in 20 seconds with equal speeds and opposite headings. From settled half, hard helm reaches 90° in 35.467 seconds and 180° in 78.825 seconds. Maximum distance from the turn's starting position over 90 seconds is 80.770 m; this is not a measured turning diameter.

120/240 Hz convergence over 20 seconds: full/back/hold/single-wave mean-speed differences all below 0.101%, impulse differences below 0.014%, and maximum contact-count difference two events per blade. The 11 m wave approximation comparison gives maximum blade-area error 0.0173% of full blade area and aggregate force error 0.0193% in the tested cases.

Raw consolidated evidence: [final-results.json](rowing-review/final-results.json),18cases passed. [phase-transition-results.json](rowing-review/phase-transition-results.json) adds an explicitly uniform16-phase check of every order pair across the whole stroke cycle. The sprint report includes10-second stamina/load/power samples; mean41.78kW and peak237.95kW refer to the complete180-second RAM→automaticFULL sequence, including time after demotion.

The ten-minute seeded, time-varying default sea/order/helm/hold run remains finite with normalized quaternion, valid areas, no consumed-event overflow, and maximum heel 9.186°. Warm full-simulator CPU steps: mean 0.981 ms, median 0.976 ms, p95 1.162 ms. This measures the full offline physics step, rather than an isolated force-law microbenchmark. Normal field fallback-query count was zero. Separate .75m/11m waves in both directions at three heel angles exercise401,880fallbackqueries; independent curved corner-height clipping differs by at most2.341% of blade area, within the5% gate. No fallback CPU-performance acceptance is claimed.

## Browser evidence

Production Vite preview at localhost:5174, high preset, seed1729, default wind sea, noon and chase camera. Opt-in `?dev&hud=1&rowingReview=forward|back|hold|pivot|rest|transition` fixes the requested scenario. The transition fixture cycles forward→back→hold→rest every12simulationseconds. Normal controls are unchanged.

Nine actual JPEG captures are in [rowing-review/](rowing-review/), with read-only DOM telemetry before/after each capture and console results in [browser-evidence.json](rowing-review/browser-evidence.json). Captures are moving frames; their telemetry brackets span about .04–.10simulationseconds, so labels do not assert exact phase synchronization. Mesh counts are62/54/54, totaling170.

The captures show distinct sweep/feather/contact poses for forward, backing, hold, raised oars and interrupted exit; pivot telemetry confirms forward port and backing starboard with nonzero effort. All captured console warning/error lists are empty. Scene movement and changing telemetry confirm the live build advances. Still images cannot establish animation quality over every transition or audible sound quality. No listening evaluation or browser-performance acceptance is claimed. These default-wave browser speeds are not the flat-water speed measurements above.

The same GPT-6 Astra agent at medium reasoning that authored the contract independently reviews runtime code, tests, and all nine images in [rowing-review.md](rowing-review.md). Its concrete P2 finding was a mode-dependent hold-entry grip-cap jump. Revision 3 filters grip, peak-power and replenishment limits with a .16s time constant, preserving dissipative force direction. The final regression measures only1.949kN adjacent-step force change and .480N across a two-microsecond boundary probe; both pass the specified gates. Astra independently reproduced and accepted the fix.
