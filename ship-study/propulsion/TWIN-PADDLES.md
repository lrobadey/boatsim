# Thalassa twin-paddle dev variant

Open the **full game world**, not the isolated 5174 trial:

`npm run dev:thalassa`

http://127.0.0.1:5175/?dev&ship=thalassa&start=sea&hud=1&wind=8&drive=paddles

Remove `&drive=paddles` for the preserved rowing version. No saved-voyage registration.

## Working mechanism and power budget

Default: **160 active workers × 75 W = 12 kW mechanical input**. Estimated gearing/bearing
transmission efficiency 80% leaves **9.6 kW maximum across the two wheel shafts**. Actual
power can be lower when torque-limited, starting, or commanded below working speed.

This is a three-hour active-watch assumption. [FAO Table 11](https://www.fao.org/4/ah810e/ah810e08.htm)
lists 75 W over 180 minutes for a 35-year-old worker; its daily-energy discussion also
illustrates why this cannot mean the same crew works continuously. Relief watches, provisions,
individual fatigue and animated capstan workers are outside this exterior/mechanism trial.

Proposed antiquity-fantasy transmission: eight 2 m-radius walking capstans, twenty workers each,
four feeding each independent shaft through timber-toothed gearing, bronze bearing sleeves,
and separately disengageable/reversing drives. Working at 0.4 m/s and about 187.5 N tangential
force gives 75 W per worker. With 2:1 speed-up and 80% transmission, eighty workers can produce
12 kN·m at one wheel at 0.4 rad/s. The model caps wheel torque there, power at 4.8 kW per side,
and unloaded working speed at 0.8 rad/s (7.64 rpm). A 2:1 speed-up makes that capstan walking
speed 0.8 m/s. These are design assumptions, not evidence of an ancient built vessel.

Timber gears, pegs, rope bindings and bronze details are the chosen material language.
[LCMM's excavated horse ferry](https://www.lcmm.org/archaeology/vermont-underwater-historic-preserves/horse-ferry/)
is a much later mechanical analogy with a geared shaft and two paddle wheels. It does not
establish antiquity construction or ocean-going suitability.

The power selector compares 80/160/320 active workers at the same 75 W each. It also changes
active crew mass at 80 kg/person. The test adds **24 tonnes of machinery** and **12.8 tonnes
of active workers** at default to the original estimated displacement. Each source has a
specified position and changes ship mass, CG and inertia. Construction, machinery allowance,
rotor inertia and source output still need engineering validation; provisions and relief crew
would add further load. The exterior has transmission chests and shafts; the capstan room
and detailed gear train are not modeled internally.

## Geometry and physics

Two 7.2 m-diameter wheels, 2.4 m-wide radial boards, 12 boards each, axle centres at
(x,y,z) = (±13.5, 2, 3) m in game coordinates. Blades span 0.75 m radially, giving a swept
radius of 3.975 m. The near edge is beyond the hull, the outer bearings are beyond the blade
width, and the fore/aft cantilevers clear that full sweep. No feathering is assumed.

Each blade samples the game's current wave surface and orbital velocity. Its wetted fraction
and velocity relative to the water produce a normal drag load (Cd 1.65, assumed), a force
at the physical blade position, and a shaft load. Wheel inertia is 45,000 kg·m² per shaft.
The shaft starts with finite torque and accelerates under motor, water and bearing loads.
It can freewheel, reverse through finite inertia, or brake. There is no P/ship-speed thrust law.

The same wheel angle drives the authored rotor mesh. Independent shafts steer through their
force lever arms. Rotor acceleration is subtracted from the hull wrench to avoid assigning
its angular momentum twice. This is a lightweight blade-element approximation, without CFD,
ventilation/slamming, elastic drivetrain, gear tooth stress or full gyroscopic coupling.

## Controls and measurements

- Ahead, pivot port/starboard, coast; independent port/starboard sliders.
- W/S + A/D restores the game's order/helm controls. Space applies a finite shaft brake.
- F/G/J/L/K retain the existing coupled sails. Furl sails for a paddle-only comparison.
- Side, quarter and wheel camera presets. The header button folds the tools away.
- Live per-side RPM, thrust, shaft power; source power, yaw moment, speed and yaw rate.
- Expanded diagnostics: wet area, rotor energy, bearing loss, water dissipation, wave work,
  hull work, numerical integration residual and CPU time. CSV is instantaneous samples at
  4 Hz wall time, with simulation timestamps, not force-window averages or GPU timing.

`window.paddleLab` exposes drive, geometry and the bounded sample history; `window.game`
remains available for development. No oar propulsion is evaluated while the paddle drive
is mounted; the ordinary oar variant and its assets remain unchanged.

## Validation

`npm run test:twin-paddles` parses actual Blender meshes and moving pivot/probe nodes,
compares rendered shaft axes to physical geometry, and runs full ShipPhysics cases:
straight at 6/12 kW, mirrored pivots, an underway differential turn, neutral coasting,
shaft braking, and wind/waves at 8 m/s. Checks finite state, source power caps,
shaft work/energy closure, fluid work/dissipation closure and rigid-body force/impulse closure.
JSON trajectories and model assumptions: `results/twin-paddles.json`.

`npm run test:thalassa` retains the original playable oar/sail baseline and generated-world
spawn tests. Browser screenshots and the pass-by-pass findings are saved in [results/VISUAL-REVIEW.md](results/VISUAL-REVIEW.md).

Speeds/turns are preliminary behavior of the existing hull solver, not real-vessel predictions.
In particular, its large-vessel crossflow/yaw resistance remains uncalibrated. A short trace
is not a terminal-speed or steady-turn-radius measurement.

## Recorded final probe

All eight scenarios passed, with source caps, finite state, shaft/fluid energy and body impulse checks.

| Scenario | Duration | Final speed | Heading change |
|---|---:|---:|---:|
| ahead-12kW | 360 s | 2.19 kn | -0.00 deg |
| ahead-6kW | 360 s | 1.63 kn | -0.00 deg |
| pivot-stbd-12kW | 180 s | -0.00 kn | 14.15 deg |
| pivot-port-12kW | 180 s | -0.00 kn | -14.15 deg |
| underway-turn-12kW | 480 s | 1.26 kn | 7.60 deg |
| coast-12kW | 240 s | 0.84 kn | -0.00 deg |
| brake-12kW | 240 s | 0.65 kn | -0.00 deg |
| open-sea-8mps | 120 s | 1.11 kn | -2.08 deg |

The underway-turn scenario runs ahead for 240 seconds and then commands opposing wheels for 240 seconds. All sails are furled in these tests. The wave case uses seeded 8 m/s base wind; instantaneous gust speed varies. The mirrored pivots did not reach 90 degrees during their 180-second window.
