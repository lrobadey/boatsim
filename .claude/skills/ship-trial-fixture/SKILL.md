---
name: ship-trial-fixture
description: Build or inspect an isolated BoatSim vessel physics/browser trial using existing simulation subsystems and authored Blender geometry, including propulsion and turning diagnostics.
---

Use `ship-study/browser/README.md` for the Thalassa fixture, commands, assumptions and
bounded evidence. Read current source before extrapolating its coefficients to another vessel.
This fixture does not authorize ship registration or changes to normal voyages.
Follow repository permission for browser testing; headless probes are a separate gate.

- Reuse `scripts/register-ts.mjs` to run the actual TypeScript solver headlessly. Keep
  geometry, forces and visible joints shared with the browser. `CrewRowing.renderPose`
  supplies oar transforms; avoid a second animation-only stroke controller.
- A twin-hull body needs two displaced column sets; an outer width envelope alone would
  fill the channel with fictitious buoyancy. `ShipPhysics` derives mass from the nominal
  waterline. State explicitly when CG, inertia and construction weight are estimates.
- The merchant `hydro.response` centres column heave damping at x=0. Reusing it on two
  hulls requires a deliberate assessment. A stable calm run does not validate seakeeping.
- Log every subsystem wrench, include gravity and verify the complete ledger against
  momentum change. Distinguish source-law validation from integration closure. Record
  force-window durations and frames; avoid overlapping CSV force averages.
- Separate rest, rowing, sailing, tow, low-speed differential turn and underway turn.
  A good near-rest pivot does not establish cruising manoeuvrability. Do not infer a
  steady radius or terminal speed from a still-changing short trace.
- Separate effective power F*v from input power and acceleration force m*dv/dt.
  Propulsor efficiency and group motor scaling are explicit experiments, not measured
  crew or animal performance. Preserve yaw torque and force-at-point geometry.
- Blender micro-bevel modifiers can inflate a modest source mesh by an order of magnitude
  on GLB export. Inspect evaluated/exported triangle counts, preserve saved render scenes,
  and remove render-only bevels in the game export where their visual scale permits.
- Blender +X bow/+Z up maps through standard glTF + a runtime Y rotation of pi/2 to game
  (-Blender Y, Blender Z, -Blender X). Check hulls, joints and sail centres in that frame.
- Blender-exported glTF materials arrive `doubleSided`; as shadow casters their lit faces shadow
  themselves, and acne makes whole decks render near-black. `ThalassaModel` casts solid materials
  from back faces (`shadowSide`), leaving open sheets double-sided. Diagnose by toggling a mesh's
  `castShadow`/`receiveShadow` before changing albedo or lights.
- The export drops Blender's wood color texture; `src/dev/thalassa.ts` restores `wood_color.png`
  with the normal map's UV transform and the Blender tints scaled to the game's plank luminance.
  Blender's palette was judged under studio area lights and AgX, so its raw albedo reads too dark here.
- Unbounded sky PMREM radiance can bleach PBR colors. Inspect environment intensity
  separately from direct lighting. Frame the camera in the sea area above dev tools.
  Measure CPU submit, raw rAF cadence and GPU cost separately; submit time is not GPU time.

Keep future propulsion mechanisms separate from a labeled external-force actuator.
For alternative drives, see `ship-study/propulsion/README.md` and `budget.mjs`.
Separate source mechanical power, gear loss and propulsive efficiency; distinguish
active-watch power from daily energy or sustainable output without reliefs. Include
the mass/space of machinery, working teams and provisions in later trials. A power
budget alone does not specify starting thrust: `F=P/shipSpeed` is singular at rest.
Model finite drive torque and water loading before claiming docking/pivot authority.
Record browser interactions, shader health, exports and final presented screenshots
only after the user authorizes that browser work.

## Playable Thalassa dev entry

- `npm run dev:thalassa` runs the normal game at port 5175 with
  `?dev&ship=thalassa&start=sea&hud=1&wind=8`. Port 5174 remains the isolated trial.
  `src/dev/thalassaDesign.ts` adapts the study's design without catalogue registration
  or saved-voyage writes; `src/dev/thalassa.ts` loads the authored exterior.
- `Game` accepts an optional `DevVessel` visual/solids/start adapter. The ocean's
  `uHullOffset` makes two cutouts while preserving visible water between the hulls.
  Do not substitute the outer envelope for this channel or for the displaced columns.
- `ShipDesign.additionalRigs` uses separate aerodynamic loads but follows the main
  rig's actual deployment and yard pose. F/G/J/L/K control all rigs together.
- The playable dev rig is intentionally larger than the preserved engineering trial:
  28 x 13 m main and 24 x 10 m aft, about 555 square metres projected area. Change
  `src/dev/thalassaDesign.ts`, keeping width, height, yard length and tapered cloth
  area coupled. Preserve the original `ship-study/browser/design.ts` for comparisons.
  `node scripts/probe-thalassa-sails.mjs` compares wind-only acceleration under the
  same wind, initial heading and wave field; oars rest and there is no added thrust.
- `findOpenWaterStart` checks the current generated seabed, every harbour's distance,
  a 350 m disk and a 1 km departure corridor. Never assume the original trireme start
  is clear enough for this vessel. The same query runs before construction/settling.
- `npm run test:thalassa` covers the generated default world, GLB geometry/embedded
  PNG streams, solver-driven visual frames and a 90 s wind/wave/helm run. Its texture
  placeholders are intentional: it proves neither browser image upload nor shader health.
  `SailingSystem.reset()` matches interpolation history; it does not furl a sail.

## Twin-paddle variant

- `&drive=paddles` on the port-5175 Thalassa URL mounts the separate Blender retrofit
  `ship-study/browser/assets/thalassa-twin-paddles.glb`; oar mode remains the default.
  Read `ship-study/propulsion/TWIN-PADDLES.md` for power/weight/control assumptions.
- `ShipPhysics.externalDrive` replaces oar stepping and contributes its world wrench
  before body integration. `src/dev/twinPaddles.ts` shares geometry with authored rotor
  pivots; positive wheel commands are ahead, physical shaft angles decrease about game +X.
  Blender/glTF rotor-local Z maps to game +X under the shell's Y rotation of pi/2.
- Separate relative shaft angular momentum from the hull wrench. Blade forces act at
  their real positions; subtract rotor angular acceleration torque from the hull to avoid
  counting it twice. Keep fluid passivity, shaft work/energy and body impulse checks distinct.
- Installed source watts, transmitted shaft watts and delivered hull work differ. Default
  active watch is 160 x 75 W, 80% transmission. Power selector also changes worker mass;
  machinery is an explicit static load. This is an active-watch estimate, not day-long output.
- `npm run test:twin-paddles` saves trajectories plus exact assumptions under
  `ship-study/propulsion/results/twin-paddles.json`. Initialise heading from the placed
  quaternion: `ShipPhysics.place()` does not refresh heading telemetry until its next step.
- Export detailed lashings/joinery as material batches separately for each rotor and static
  assembly. Preserve rotor pivot/probe nodes, and save the editable Blender scene before
  merging export batches. Hundreds of separate rope pieces should not become draw calls.
- Browser data is mirrored to DOM `#paddle-review-state` for read-only automation. CSV rows
  are instantaneous snapshots at wall-time intervals with explicit simulation timestamps,
  unlike the isolated trial's non-overlapping force windows. Do not treat them as equivalent.

## Distinct whole-hull paddle mechanisms

- The playable paddle dev view now selects `paddle=helios|polypous|scarab` without
  reloading. Read `ship-study/propulsion/THREE-MECHANISMS.md` for current engineering
  assumptions; the earlier GLB wheel remains a baseline, not the playable selector.
- `paddleKinematics.ts` owns blade paths and dp/dq for rendering and virtual-work
  water loads. A conveyor cycle radian is not a drum radian: use F dot dp/dq for
  generalized torque, and the same derivative for contact velocity and shaft work.
- Never use equivalent drive inertia to locate physical masses on a giant fictitious
  wheel. Long mechanisms distribute moving weight longitudinally; equivalent shaft
  inertia is a separate reduced dynamic model with explicit limitations.
- `test-paddle-geometry.mjs` compares actual rendered blade matrices with force paths
  over 120 phases and verifies fixed 5 m sweep arms. `test-paddle-variants.mjs` checks
  all three mechanisms with actual ShipPhysics. Tests are bounded acceleration
  windows, not terminal-speed or real construction certification.
- A useful three-way art/mechanism exploration changes topology and hull occupancy,
  not just wheel diameter, trim or coefficient presets. One concentrated wheel,
  phased full-length sweeps and a full-length endless track are the present studies.

- `paddle=basileus` is the fourth, rigid-oar Polypous study. Its rowlock, blade frame,
  feathering and analytical dp/dq are shared by the model and solver. Mirror tangent
  and normal X components as well as blade-position X on the port side: earlier
  wheel/sweep paths had zero lateral components and hid this requirement.
- ExtrudeGeometry is often non-indexed. Component-volume integration must handle
  indexed and non-indexed triangles; model hollow bronze shells and sleeves instead
  of treating decorative cladding as solid metal. Use the authored blade profile's
  shoelace area rather than its rectangular envelope for water loads.
- For oar refinement, preserve the original variant, verify rowlock position, fixed
  loom length, hand/grip connection, deck clearance and feathered normal across a
  full cycle. Larger blades change torque demand; compare complete variants at
  matched input caps and label gearing/weight changes. Do not infer speed from area.
