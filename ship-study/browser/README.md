# Thalassa sea-trial dev build

Isolated browser fixture, October 22, 2026. Actual game `ShipPhysics`, `CrewRowing`,
`SailingSystem`, `Wind` and `WaveField`; a purpose-built flat-water rendering scene.
No main-game ship registration, voyage reads/writes, world generation or production-source edits.

From the repository root:

```sh
./node_modules/.bin/vite --config ship-study/browser/vite.config.ts
# http://127.0.0.1:5174/
./node_modules/.bin/tsc --noEmit -p ship-study/browser/tsconfig.json
./node_modules/.bin/vite build --config ship-study/browser/vite.config.ts
node ship-study/browser/probe.mjs
node ship-study/browser/tow.mjs
node ship-study/browser/turn.mjs
node ship-study/browser/turn.mjs --area=4
node ship-study/browser/turn.mjs --area=8
```

The distributable build is `build/`. Export the exterior with:

```sh
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
  --python-exit-code 1 -P ship-study/blender/export_thalassa.py
```

The export rebuilds pass 5 without overwriting its saved scenes. It omits moving
oars, yards and sails, and replaces four scenic steering sweeps with two effective
quarter rudders at the solver's actual blade centres. Runtime oar joints come from
the current crew solver. Render-only micro-bevels are removed: 191 MB became 26.7 MB.

## Controls and measurements

Drag/scroll to inspect; overview, quarter, deck and waterline views. A/D command the
helm, Space pauses. The heading-hold option commands only existing helm/crew inputs;
it supplies no external yaw torque. Reset reloads a fresh trial, including fatigue.
Simulation runs at 120 Hz and pauses while the tab is hidden. 2×/4× time rates are
available; time dropped under load is displayed instead of silently called real time.

Motion, Forces, Power and Sizing are tabs on narrower screens. Measurements include:

- Speed through water/over ground, drift, heading, yaw rate, pitch, heel, draft,
  per-hull buoyant support, mass, CG and initial metacentric-height estimate.
- Stage-measured forces and yaw moments; main and aft sails, rowing, water, windage,
  rudders and optional test thrust. The visible water row and arrow subtract weight.
- Mechanical rowing work and signed hull power; kinetic energy; physics/rowing CPU
  time per step; raw frame cadence and render submission time. GPU time is not measured.
- Force vectors, two separate sets of buoyancy columns, track and speed history.
- Sizing at 2/3/4/6 knots; adjustable rudder area; 0–40 kN external test thrust.
  Test thrust acts equally at both sterns. It is a force actuator, not a simulated paddle device.
- CSV history at 4 Hz, rolling one-hour limit; source-force means over disjoint 0.25 s
  windows. Snapshot JSON includes settings, assumed body properties and the last measurement window.

CSV positions and source forces use world coordinates: +Y up, north is -Z.
`*_yawNm` is torque about the negative world-Y axis. The live force table rotates
the wrenches into ship axes. `forceClosureN` checks both the source ledger against
the solver force and the ledger impulse against linear momentum change; gravity
is included separately. This does not validate the constitutive force laws.

## Body and assumptions

82 m hulls, 6.6 m beam each, centres ±8.5 m. The hull functions reproduce the Blender
sections, with a clear channel between the two buoyant column sets. 512 columns
give 1,335.85 t design displacement; fine quadrature gives 1,347.18 t (0.84% difference).
Mass follows the solver's waterline convention, not a construction weight estimate.
CG is assumed at +2.5 m; inertia is the existing column-distribution estimate.
The 30.5 m initial GM estimate describes small-angle hydrostatic stiffness only.

188 looms follow the modeled ports, including the boarding opening. One current
crew agent runs each loom. Default three hands per oar scales motor force, power,
recovery force and physiological reserves as a group (564 people represented).
One/five-hand alternatives are explicit experiments. Individual grips and ergonomics
are unresolved; changing the group preserves its reserve fraction. Inboard length,
oar inertia, blade added mass, windage and rudder dimensions are provisional.

Calm means no CPU wave components and a flat buoyancy surface. Water normal detail is
visual only. Open-water wind still uses the game's gusts, shear and direction changes.
Two independent copies of the existing sail solver apply the modeled sail areas;
there is no aerodynamic shadowing. The original trireme hydro response keeps damping
at the two hulls. The merchant response centres damping on x=0 and is not adopted here.
No catamaran interference, flexible bridge, structural loads, paddle wash, damage,
interiors, walk collision or navigation world are represented.

## Preliminary results

All eight bounded probes completed with finite state, stable flotation and a complete
force/momentum ledger (largest residual below 4e-8 N). These are current-model outcomes,
not validated full-size ship predictions. Speeds below are means over the final 30 s;
the vessels are still accelerating, so these are not terminal speeds.

| Probe | Duration | Final-30-s speed | Observation |
|---|---:|---:|---|
| Rest, no wind | 60 s | effectively zero | Floats without drift |
| Full rowing, 3 hands/oar, no wind | 240 s | 4.86 kn | ~87 kW mechanical, ~29 kW signed hull power |
| Full rowing, 1 hand/oar, no wind | 240 s | 0.011 kn | Long-oar model gives almost no net propulsion; requires investigation |
| Sails only, base wind 8 m/s | 240 s | 2.93 kn | Wind varies by the actual game algorithm |
| Half rowing + sails, base wind 8 m/s | 240 s | 5.57 kn | Heading hold uses normal steering inputs |
| 6.4 kN test drive, no wind | 360 s | 2.62 kn | Low steady-power requirement still means a long acceleration |
| Hard helm from rest, full rowing | 240 s | 0.62 kn | 97° heading change; 90° at 222 s; moves about 53 m |
| Hard helm from rest, oars/sails off | 60 s | effectively zero | No artificial rudder turn in still water |

Headless full-rowing physics averaged about 0.35 ms/step locally; browser measurements
are visible live and depend on the view and host. No reduced rowing algorithm was needed.

### Turning underway

Identical 240 s full-rowing run-up to 4.96 kn, then full starboard for 300 s:

| Area of each of two rudders | Heading change after 300 s |
|---:|---:|
| 2 m² baseline | 27.1° |
| 4 m² | 43.8° |
| 8 m² | 70.6° |

None reached 90° in the measured interval. Baseline final speed was 4.20 kn. Its
mean water torque opposed the ~312 kNm rudder and ~91 kNm rowing turn moments.
This is inadequate cruising manoeuvrability in this prototype. Larger surfaces help,
but do not establish a correct hydrodynamic model; lateral-force/yaw closures, steering
geometry and independent propulsion deserve separate calibration. No turning-radius
claim is made from an unsteady five-minute arc.

### Moderate-speed propulsion budget

Actual solver, upright constant-speed towing carriage, flat water, no wind, sails
furled and oar physics disabled. Includes water, still-air and current rudder profile
drag. Figures are baseline 2 m² rudders; the UI adjusts their profile-drag contribution
when changing area. `tow.json` retains component forces and exact values.

| Speed | Required thrust | Effective hull power | Input power at assumed 60% efficiency |
|---:|---:|---:|---:|
| 2 kn | 1.76 kN | 1.81 kW | 3.02 kW |
| 3 kn | 3.75 kN | 5.79 kW | 9.65 kW |
| 4 kn | 6.42 kN | 13.21 kW | 22.02 kW |
| 6 kn | 13.70 kN | 42.30 kW | 70.50 kW |

At 4 kn, hypothetical 140 W humans with 40–60% overall efficiency imply about
158–236 hands for steady travel. This is an energy-budget scenario, not the output
of the long-oar simulation, which includes substantial recovery/entrained-water costs.
Reaching 4 kn with constant acceleration over 180 s adds 15.27 kN, making end-of-ramp
thrust about 21.7 kN and effective power about 44.6 kW; added mass is excluded.

Gameplay implication: low-power auxiliary travel can be plausible but slow to accelerate.
Starting, stopping and turning create a much higher peak demand. Port/starboard drives
with independent ahead/astern control provide a useful next experiment for a future
paddle device. Animal power, gearing, feed, fatigue, friction and paddle efficiency
have not been modeled or assigned invented performance values.

## Evidence

`results/report.json`, per-case CSVs, `results/tow.json`, and `results/turn*.json/csv`.
`window.thalassa` exposes the trial and renderer for local inspection. Build/typecheck
are separate from live browser acceptance. Screenshots and a browser-check record
are saved beside the results after exercising the actual UI and exports.
