# Twin paddles: three visual passes

Reviewed in the actual port-5175 open-sea game, at the current world spawn, using the real
wave field and new drive. These are in-game screenshots, not offline stand-in images.

1. **Fit and clearance.** Checked the full ship broadside. Axles and animation axes agreed
   with the physical model. The wheel merged into the dark hull and the tools obscured
   the model. Added folding tools and inspection cameras; selected lighter oiled timber.
   [First screenshot](visual-pass-01.jpg).
2. **Material and moving mechanism.** Reviewed the closer wheel view while powered. Added
   a bronze-faced hub and joinery, and increased support clearances beyond the full swept
   board envelope. [Second screenshot](visual-pass-02.jpg).
3. **Antiquity refinement.** Following the user's direction, replaced perfect circular
   metal-banded rims with pegged timber felloe segments, split paddles into planks, added
   hemp bindings and a bronze sun boss, and retained open wooden supports. Reviewed in
   the game again. [Wheel screenshot](visual-pass-03-wheel.jpg),
   [quarter screenshot under sail](visual-pass-03-quarter.jpg).

The final geometry is 40,112 triangles in 13 material/assembly batches (2.29 MB GLB).
The saved Blender file retains separately editable joinery and lashings; export joins
parts by material within each of the two rotating assemblies and the static supports.

Browser checks also exercised the 6/12 kW watch selector (crew mass changed by 6.4 tonnes),
independent reverse/pivot, ahead, folding controls, inspection cameras, coupled sails,
expanded power diagnostics and CSV download. The downloaded CSV contained 763 finite
rows and 27 numeric columns; a copy is browser-export.csv. No captured console errors or
warnings. GPU timing is local game telemetry, not an all-hardware performance claim;
renderer.info after postprocessing describes the last pass, not total scene draw cost.

A final camera review found the main game's underway auto-centering overriding inspection
presets. Inspection views now lock their orbit; choosing W/S + A/D releases it. The existing
camera test suite passes.
