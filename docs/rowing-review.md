# Independent rowing specification and implementation review

Reviewed 2026-10-05 by the delegated specification author, against `docs/rowing-spec.md` revision 3. This review covers rowing and necessary integration only; unrelated pre-existing working-tree edits were not reviewed or changed.

## Current disposition

One concrete P2 defect was found in revision 2: grip/power limits changed discontinuously at controller mode boundaries. The specification itself required the discontinuous values, so revision 3 corrects the contract rather than blaming a faithful implementation. The continuous scalar limits are implemented and independently rechecked. The final consolidated report passes all18 cases, and the strengthened supplemental full-cycle order-transition fixture also passes. The implementation is accepted against revision3 within its documented fidelity and evidence limits. No other blocking runtime defect was identified in the reviewed rowing paths.

## Resolved P2 — Smooth the human limits across mode transitions

Location: `src/ship/rowing.ts`, force/power/replenishment target selection following wet-patch force accumulation (revision 2 approximately lines 375–390).

Reproduction: a locked hull in flat water moving forward at 4 m/s, fresh STOP crew, then `holdWater=true`. At t=.875s, the last `enter` sample has handle cap187.5 N and braking force10,103 N. At t=.883333s, `hold` raises the cap to900 N and force48,495 N. The blade dip changes only2.8e-5 rad. This is an artificial38.4 kN one-step braking jump, despite continuous pose and angular velocity. The isolated reproducer is `/private/tmp/rowing-review-hold.mjs`.

Required fix is specified exactly in revision3 section9: independent per-side handle/peak/mean limit states, exponential .16s response, no state reset at stage/order/hold interruptions or teleport, and retained passive hold drag when energy is empty. Force vectors must not be temporally filtered; their dissipative direction and energy identity remain unchanged. Acceptance includes both120Hz and1-microsecond boundary checks, scalar rate bounds, hard absolute force/power limits, and the original full validation matrix.

Revision3 resolution: inspected the final filter placement after request/controller evolution, all three target ranges, strength/calibration application, and retention through reset. Independently reran the original locked-body reproducer: boundary force is now10,087.7→12,036.9N (delta1,949.2N), rather than38.4kN. The continuous cap is187.215→223.389N. The new focused regression also reports0.4801N change for a1-microsecond boundary interval, below2N. The fix is accepted; all18 consolidated regression cases now pass.

## Mechanics reviewed

Inspected `rowing.ts`, `oarLayout.ts`/`oarGeometry.ts`, `crew.ts`, `physics.ts`, `waves.ts`, `trireme.ts`, and the game/foam/audio seams, plus the executable tests and supplied results.

The implementation uses170 distinct longitudinal blade locations and bank-specific material geometry. Render matrices consume the same kinematic evaluator as the force sampling. The four-strip clipping path retains recovery contact rather than masking it by stroke phase. Material velocities include sweep/dip/feather and rigid-body angular velocity. Wave particle velocity uses inverse-coordinate phase and depth attenuation. Normal/profile drag is dissipative, and uniform scalar capping preserves that direction. Work is charged against a finite reservoir; passive stationary grip does not require positive actuator power. Differential low-speed helm uses nonzero reverse effort with the corresponding reverse motion. C1 joint interruption and cycle-boundary tests now exercise the actual trajectory. Audio uses observed contacts rather than scheduled fictitious releases, with independent event readers and reset generation handling.

The deliberately reduced-order limitation remains: capped kinematic traction is not a dynamically solved rigid-oar/rower system. It is accurately disclosed in the specification; this review does not upgrade that fidelity claim.

## Offline evidence reviewed

The final revision3 report at `docs/rowing-review/final-results.json` records **18/18 passing cases**, including human-limit continuity, all-order transitions, independent fallback corner sampling, actual locked-body force directions, audio grouping/reset, stamina, and ten-minute varying-weather stability:

| Measure | Result |
|---|---:|
| SLOW / HALF / FULL last30s means |3.973 /5.631 /6.673 kn|
| Back-water mean |−3.601 kn|
| FULL stamina after120s |.9827|
| Sprint best5s mean |7.911 kn|
| Sprint automatic demotion |135.375 s|
| Hold stopping4m/s to≤.3m/s |12.225 s|
| Hard-helm90° /180° turn |35.47 /78.83 s|
| Mirrored low-speed pivot at20s |±.73907 rad|
| Isolated hold-oar work |−452.55 kJ|
|120/240Hz worst mean-speed difference among four cases |.101%|
|120/240Hz largest per-blade contact-count difference |2|
| Independent curved-corner fallback area error |2.341% of full blade area|
|10min varying-weather maximum heel |9.19°|
| Full-ship CPU mean /p95 on Apple M4 Pro, Node25.4 |.981 /1.162 ms|

The prior overstrict whole-body zero velocity assertion was correctly replaced by the actual requirement: exactly zero oar forces and no catch beats in fresh flat-water STOP. The final report passes this case. Tiny whole-body settling is not treated as oar-generated propulsion. No original speed, stamina, turning, passivity, or work-budget gate was relaxed.

The existing test suite's mathematical proof plus geometry identity is stronger evidence for force/motion consistency than screenshot inference. CPU timing is local whole-ship simulation timing and does not measure GPU frame time or audible quality.

## Production screenshot review completed

Opened and visually inspected all nine production captures using the image tool, alongside their before/after telemetry in `docs/rowing-review/browser-evidence.json`:

* `forward-01.jpg`: recovery in waves; the dipped side visibly interacts with the surface. Negative instantaneous thrust is consistent with a recovering blade striking water, not evidence of a sign error. Telemetry records78–82 wet blades and port-side dry contact during the capture interval.
* `forward-02.jpg`: raised/squaring near the next catch, with only17–27 wet blades. This is not a photograph of the main loaded drive; do not label it as one.
* `back-01.jpg`: reversed order, negative through-water speed, and sweep pose toward the opposite end of travel. The capture straddles extraction; momentary force reversal is physically allowed.
* `hold-01.jpg`: steady lowered broadside oars,170 wet blades and zero actuator power; passive resistance remains present.
* `pivot-01.jpg`: opposite-side control is verified by telemetry (port forward, starboard back at effort .6375). The near-side pose and surface contact are visually coherent. A still image alone cannot establish temporal direction.
* `rest-01.jpg`: raised/feathered oars remain run out; wave/heel contact is visible/recorded on part of the lower side. Zero actuator power is consistent with this passive wash.
* `transition-01.jpg`: forward-to-back withdrawal (`exit` on both sides), raised blades and greatly reduced contact, with no obvious disconnected fulcrums or bank-scale mismatch.
* `final-hold.jpg`: rebuilt revision3 production capture; squared, lowered oars and170 wet blades with zero actuator power. No new visual mismatch after smoothing the limits.
* `final-forward-drive.jpg`: actual loaded forward drive (phase .164–.198),163 wet blades, positive24.3–24.6kN thrust and visible corresponding blade contact. This fills the loaded-drive phase absent from the first forward captures.

All images show the expected three dense banks with consistent shaft/blade construction. No obvious detached oar geometry, stale splash-position trail, incorrectly scaled bank, or visual mode mismatch was found. Screenshot telemetry confirms instance counts62/54/54. Recorded console warning/error arrays are empty. These camera views and resolution do not establish individual oar collision clearance or subtle temporal smoothness. The screenshots span finite simulation intervals (~.04–.10s); telemetry is a bracket, not an exact image timestamp. Continuous motion, listening to audio, and an isolated rowing GPU-cost measurement have not been independently established by this screenshot review.

## Final sign-off

The runtime code, the resolved grip-limit defect, the18-case consolidated report, and all nine production screenshots have been reviewed. No unresolved blocking rowing implementation or screenshot finding remains. The supplemental explicit16-uniform-phase order-transition result in `docs/rowing-review/phase-transition-results.json` passes, strengthening phase coverage without changing runtime. Final acceptance is granted against revision3. Preserve the stated model and screenshot/audio/performance limitations in the handoff.
