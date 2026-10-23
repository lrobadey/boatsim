# Three Thalassa paddle mechanisms

Playable game: `npm run dev:thalassa`, port 5175, append
`?dev&ship=thalassa&start=sea&hud=1&wind=8&drive=paddles&paddle=polypous`.
The three selector IDs are `helios`, `polypous`, `scarab`. This is an isolated dev
refit; it does not register ships or write saved voyages.

## Mechanisms

| | Helios | Polypous | Scarab |
|---|---|---|---|
| Arrangement | One monumental side wheel per flank | Eight articulated sweeps per flank | One endless paddle ladder per flank |
| Hull use | Concentrated amidships | 56 m between first/last stations | 58.8 m end-to-end track |
| Blade motion | Radial rotation | Lifted, elliptical rowing stroke | Long submerged run, high dry return |
| Boards per side | 12 | 8 | 36 |
| Board width / height | 2.8 / 0.85 m | 1.6 / 1.5 m | 3 / 0.85 m |
| Transmission estimate | 78% | 72% | 66% |
| Capstan-to-cycle speed ratio | 1.5 | 1.5 | 0.3 |

Helios has a 9.4 m blade-centre diameter, an 800 mm timber axle, open bearing
frames, bronze sunburst, cedar spokes and oxblood trim. Swept diameter is 10.25 m.
Its machinery mass and rotor inertia come from signed tetrahedral integration of
rendered components, with explicit assumed material densities and an 8 t allowance
for hidden transmission and deck reinforcement.

Polypous distributes propulsion along the ship like a rowing crew. Each blade
centre follows y = 1 + 2.6 cos(q), z = station + 2.8 sin(q), with stations 8 m
apart and staggered phases. Its two 5 m arms satisfy a two-link inverse-kinematics
constraint throughout the cycle. The board stays vertical; the upper return lifts
it out of calm water. A paired cam/follower drive is assumed to impose the two
joint motions from the line shaft; cam profiles, joint contact loads and the
internal transmission are not resolved. This is a constrained mechanical prototype,
not a complete manufacturing design.

Scarab is a 54 m straight-span conveyor on each side, with 2.4 m-radius end drums.
The closed path is sampled by arc length, so chain speed stays constant through
straight runs and semicircular ends. At the nominal waterline, the board centres
are 1.3 m underwater on the lower run and 3.5 m above water on the return. Timber
links connect adjacent board stations. Joint pins, chain tension, stretch, slack,
sprocket engagement and wave slamming remain design work; the visible ladder is a
kinematically constrained endless track. The solid timber drums make this the
heaviest machinery option.

## Power and dynamics

All designs share 160 active workers × 75 W = 12 kW input, or an 80-worker / 6 kW
watch. A 24 kW / 320-worker-equivalent dev option doubles available source power
and active-worker mass. Installed torque and governor limits remain unchanged;
extra capstan stations/worker occupancy are not modeled. Eight 2 m-radius walking capstans are shown. At the design watch, 80 workers
per side × 187.5 N × 2 m gives 30 kN·m before gearing. The cycle torque caps follow
that input, transmission efficiency and speed ratio. Torque falls with a smaller
watch and remains limited by installed machinery. The governor is a control model,
not a detailed human gait/fatigue simulation. Provisioning, relief watches and
animated workers are not included.

`paddleKinematics.ts` supplies blade position, normal, radial/vertical span and
position derivative dp/dq to both rendering and fluid loads. The water solver uses
body velocity + (dp/dq) qdot - wave velocity. Generalized drive load is F·dp/dq;
shaft work is that load × qdot. It never uses P/ship-speed or a cosmetic thrust
multiplier. Each side has independent finite drive inertia, torque, source-power
cap, neutral and reverse. Water force acts at each actual blade centre.

Long mechanisms use an equivalent constant drive inertia from moving timber,
path speed and an assumed 2 t / 1.5 m rim flywheel per side. Their 12 t hidden
machinery allowance includes those flywheels. This approximation omits varying
link inertia, linkage reactions and elastic power exchange. The angular-momentum
reaction is an equivalent crankshaft model, not a multibody mechanism solution.
Machinery and active-worker masses alter the hull's mass/CG/inertia; long moving
assemblies are distributed longitudinally rather than placed on a fictitious giant
wheel. Static support/gear mass positions remain lumped estimates.

## Comparison controls

The selector replaces the entire mechanism and its physical parameters, resets
shaft history and keeps the hull's current motion. `Restart · paddles only` places
it at the initial position/heading, furls sails and commands both sides ahead.
World wind/waves continue; this is not an identical-wave replay. For controlled
comparisons use the seeded headless suite. Cycle RPM for Scarab means complete
track circuits, not drum RPM. CSV includes design ID; data clears on refit/reset.

## Validation, 2026-10-23

- `node scripts/test-paddle-geometry.mjs`: 120 phases per design; rendered blade
  centres agree with force paths; Polypous arms retain their 5 m lengths and all
  endpoints are reachable.
- `node scripts/test-paddle-variants.mjs`: nine 40 s actual-ShipPhysics scenarios:
  forward, differential pivot and wind/waves for each design. Finite state,
  passive fluid load, 12 kW source cap and shaft/fluid energy accounting pass.
  Results and exact assumptions: `results/paddle-variants.json`.
- Calm-water 40 s acceleration probes reach 0.30 kn (Helios), 0.43 kn (Polypous),
  0.31 kn (Scarab). Corresponding pivot changes are 2.36°, 4.06°, 2.64°.
  These are acceleration-window results, not terminal speeds or calibrated real
  ship predictions. In the wave probes Helios/Scarab are briefly driven backward;
  available human power does not guarantee headway in every condition.
- Typecheck and production build pass.
- Live browser: all three selectors, actual shaft/blade animation, restart,
  forward and differential commands inspected. Polypous showed opposing signed
  thrust, finite state, zero grounding and the 12 kW source cap. Browser warning/
  error log was empty at inspection. Saved views: `results/helios-browser.png`,
  `results/polypous-browser.png`, `results/scarab-browser.png`.

This validates a bounded gameplay simulation. Hydrodynamic coefficients, gear/cam
contact stresses, timber fatigue, bearing wear, chain tension, rotor buoyancy,
wave impact and structural viability have not been established. The UI's axle
stress numbers are simple screening calculations, not a structural approval.

## Fourth study: Polypous Basileus — three visual passes

`paddle=basileus` adds a separate, selectable development of Polypous. The original
is preserved. Eight mechanical rowers per side work rigid oars about fixed rowlocks,
with the same evenly staggered travelling rhythm. The appearance draws on Talos
(bronze-clad timber rowers, crested helmets, articulated arms) and Poseidon (broad
trident-crowned blades, oxblood inset and raised bronze spine). Human watch power
still drives the machinery; the automata supply no free energy.

Geometry: 10.2 m rowlock-to-blade-centre reach, 3 m inboard handle, 4 × 2.2 m blade
envelope. `royalOarProfile.ts` shares the actual normalized outline and its shoelace
area factor (0.6392) with rendering and drag: 5.625 m² per blade versus the original
2.4 m². Nominal overall length is 15.2 m from grip to blade tip. Rowlocks are at
local y=5.8 m, with handles above the 5.55 m deck through the full cycle.

The oar direction follows yaw = 0.42 sin(q), depression = 0.47 - 0.26 cos(q).
Blade centres, analytic dp/dq, orientation and feather angle are shared by graphics
and fluid loads. Recovery feathers up to 90° about the loom. The sampler now
accounts for both blade length and width in vertical immersion, and mirrors all
position/velocity/normal frame components on the port side. A single blade-centre
load remains an approximation: distributed rotational blade velocities, pressure
centres, hinge friction and contact stress are not resolved.

The higher-load transmission uses 1:1 capstan/cycle speed rather than the original
1.5:1 speed-up. At the assumed design input force it permits 21.6 kN·m per side,
with the same 72% transmission estimate and independent 12/24 kW source cap. The
cycle governor is 0.60 rad/s. Bronze helmets/joints are hollow shells and collars
are sleeves; their mesh volumes determine mass. Visible geometry plus the 12 t
hidden drive allowance estimates 143.7 t machinery. Drive inertia remains a reduced,
constant equivalent estimate, and mass positions are lumped as in the other studies.

Visual pass records, inspected live after each pass:
1. `results/basileus-pass-01.png`: rigid oars, rowlocks, mechanical crew and stagger.
2. `results/basileus-pass-02.png`: broad trident crown, heavier loom, oblique blade view.
3. `results/basileus-pass-03.png`: Talos detailing, sleeved fittings, deck clearance,
   final 1:1 gearing and live 24 kW operation.

A non-indexed extruded-mesh volume bug encountered during pass 2 was corrected;
the volume integrator now handles both indexed and non-indexed geometry.

Validation: `test-paddle-geometry.mjs` checks 120 phases per variant, including
Basileus fixed rowlocks, constant oar reach, handle/deck clearance, feather-normal
agreement, connected fixed-length arm links and actual hands on grips. Physics
checks pass for 12 kW ahead, pivot and waves, and 24 kW ahead. Results:
`results/paddle-variants-basileus.json` and `results/paddle-variants-basileus-24kw.json`.
At 40 s calm-water starts Basileus reaches 0.441 kn / 0.617 kn at 12/24 kW;
original Polypous reaches 0.431 / 0.580 kn. These compare complete variants,
including gearing and mass, not isolated blade-area efficiency. The 12 kW pivot
changes heading 4.81° in 40 s. Finite state, passive fluid loads, source caps and
shaft/fluid energy accounting pass. This does not establish structural viability.
