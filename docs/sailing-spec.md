# Coupled sailing contract

Design decision: direction 2 from `sailing-directions.md`, refined here. Direction 1 hides the interactions the player should learn; direction 3 spends complexity without establishing accuracy. This step models a square rig, apparent wind and shallow hull together. Rowing changes air flow over the sail; sail loading changes speed, heel, leeway and therefore oar immersion. No propulsion mode bonuses, speed clamps or prescribed sailing polar. These coefficients are deliberately small engineering approximations, not CFD or an experimentally calibrated Olympias replica.

The lead-owned [performance tuning follow-up](sailing-tuning.md) updates the pressure-drag coefficient, prevailing wind and heel-aware crew trim. Astra reviewed the original implementation; the user excluded Astra from this follow-up. The current formulas below include these changes.

## Ownership and scope

- A: `src/world/wind.ts`, new `src/ship/sailGeometry.ts`, new `src/ship/sailing.ts`.
- B: `src/ship/physics.ts`, optional isolated shallow-hull helper.
- C: `src/game.ts`, `src/ship/trireme.ts`, `src/ui/hud.ts`, README.
- D: `scripts/test-sailing.mjs`, package test command.
- Lead: integration, coefficient changes supported by evidence, final verification.

Fixed work: nine force samples, a 25-candidate trim evaluation four times per simulated second, existing hull columns. No cloth solver, terrain airflow, new sailing subsystem UI, damage, resource economy or changes to rowing internals. Terrain shelter is a useful future extension, but is deferred: this change first establishes trustworthy open-water interactions. Browser testing requires an explicit user request.

## Coordinates and shared rig geometry

Hull-local +x is starboard, +y up, -z forward. Positive THREE rotation about y gives yard tangent `t=(cos(g),0,-sin(g))`, rear-facing sail normal `n=(sin(g),0,cos(g))`. This is the actual rendered yard rotation; do not retain the old opposite-sign normal. Body `pos` is world CoG; `cg` is its hull-local location. World material point: `p=pos+quat*(local-cg)`.

`sailGeometry.ts` exports `SAIL_RIG` with `width=10`, `height=7`, `area=70`, `mastStation=.42`, `mastHeight=11.5`, `yardDrop=.7`, `clothTopDrop=.1`, `clothOffsetZ=.2`, `yardLength=12.5`, `maxYardAngle=Math.PI/4`, `sampleCount=9`. Mast base and z use the existing `deckY(.42)` and `zOf(.42)`. Render and physics import the same values.

`evaluateSailSample(index:number,set:number,yard:number,out:THREE.Vector3):THREE.Vector3` returns a hull-local point. Row-major 3×3 midpoint samples: x = width*((column+.5)/3-.5); y = -clothTopDrop-height*set*(row+.5)/3; z = clothOffsetZ. Rotate this offset by yard about y, then add yard origin. Each sample area is `area*set/9`. Raising/brailing collects the bottom toward the yard: the exposed height, area and load center therefore change together. At set=0 there is no exposed aerodynamic area. Furl bundle thickness is decorative and must not increase force area.

## Public integration contract

```ts
interface SailBody {
  pos: THREE.Vector3; quat: THREE.Quaternion;
  vel: THREE.Vector3; angVel: THREE.Vector3; cg: THREE.Vector3;
}
interface SailWind {
  vx: number; vz: number;
  sampleAt?(x:number,y:number,z:number,time:number,out:THREE.Vector3):THREE.Vector3;
}
type SailStatus = 'furled'|'setting'|'drawing'|'luffing'|'aback';
interface SailState {
  deployment:number; yardAngle:number; fill:number; // fill is signed [-1,1]
  pressure:number; flutter:number; // fixed-step visual state, interpolated with previous
}
interface SailTelemetry {
  forwardForce:number; lateralForce:number; load:number; // N, local forward/starboard, summed panel-load magnitudes
  pressure:number; flutter:number; // signed [-1,1], unsigned [0,1]
  apparentSpeed:number; heelMoment:number; // m/s; world sail torque projected onto local forward axis, N m
  pointOfSail:'calm'|'windward'|'reach'|'run'; // descriptive apparent-wind sector, not a force mode
  apparentWind:THREE.Vector3; // local air-moving-toward vector at rig center
  apparentFrom:number; // radians, atan2(-apparentWind.x, apparentWind.z); 0 is ahead
  status:SailStatus;
}
class SailingSystem {
  deploymentTarget:number; // [0,1], initial 0
  trimMode:'auto'|'manual'; // initial auto
  manualYardTarget:number; // initial 0, bounded by maxYardAngle
  readonly current:SailState;
  readonly previous:SailState;
  readonly telemetry:SailTelemetry;
  step(dt:number,time:number,body:SailBody,wind:SailWind,
       force:THREE.Vector3,torque:THREE.Vector3):void;
  reset():void; // match previous to current, reset trim timer; do not unexpectedly deploy
}
```

Step adds to supplied accumulators; never clears existing loads. For each sample add `Fworld` and `(p-pos)×Fworld`. Read-only telemetry can additionally expose sample forces/points for deterministic tests. Reuse storage in steady-state loops. Export a pure aerodynamic force evaluator for direct coefficient/passivity tests, with documented arguments; D can adapt its test calls to A's exact pure-helper signature.

Nonfinite or nonpositive step duration is a no-op. Deployment and manual yard targets are bounded at the command boundary. Invalid wind base speed becomes calm and invalid base bearing becomes zero; valid inputs follow the equations below unchanged. Copy all five visual state fields current-to-previous once per valid fixed step; publish pressure/flutter after force integration. Rendering interpolates these stored physical states and does not evolve a separate response.

`ShipPhysics` owns `readonly sailing`. Preserve legacy names with accessors: sailSet ↔ current.deployment; sailTarget ↔ deploymentTarget; yardAngle ↔ current.yardAngle; sailForce = forwardForce; sailPressure = pressure; apparentWind = telemetry.apparentWind. Remove the old sail force/trim implementation. `place()` calls sailing.reset(). Integration runs sailing once inside each physics step. Do not advance global wind from each ship. Preserve hull/rig windage, but sample its own point and rigid-body velocity; keep this separate from sail telemetry so a furled sail reports zero sail load.

Expose `leeway` as the signed water-relative drift angle for the existing HUD, using the same sampled water velocity as forward-speed telemetry. The HUD displays it only while progressing forward; astern angle wrapping is not a forward-sailing warning.

## Wind field

Preserve `baseFrom`, `baseSpeed`, `from`, `speed`, `meanSpeed`, `vx`, `vz`, `dirX`, `dirZ`, `update(dt)`. Add `sampleAt(x,y,z,time,out)`; time is absolute simulation seconds. `update` accumulates its own clock and evaluates the same origin/10 m sample. `meanSpeed` is slow mean only and continues driving waves. Sampling is pure, deterministic, allocation-free and independent of call order. It derives every value from explicit time/base parameters, never the cached from/meanSpeed/speed produced by update; ShipPhysics has its own settled simulation clock and must pass that exact clock.

Default base speed is 12 m/s at the 10 m reference height; controlled fixtures may choose other reference speeds explicitly.

10 m reference wind: preserve slow speed modulation `.35*noise1(t/600,seed+7)` and slow veer `.42*noise1(t/420,seed)`. Gust magnitude uses `.18*noise1(t/6+x/180+z/240,seed+11)+.08*noise1(t/1.7-x/70+z/95,seed+13)`. Local direction also uses `.08*noise1(t/37+x/600-z/800,seed+3)`. Wind speed is `max(0,baseSpeed)*max(0,1+slow)*max(0,1+gust)`; no minimum breeze. At baseSpeed=0 every sample is exactly zero regardless of time or height. Wind moves toward `(sin(from+PI),0,-cos(from+PI))`.

Height factor is `(max(.5,y)/10)^.11`, with y as world height above mean sea level. This neutral marine power-law approximation follows the near-neutral exponent in [NOAA marine guidance](https://www.weather.gov/media/mdl/marinetpb2.pdf). It is not atmospheric stability modeling. At 10 m the factor is exactly 1. Wind fallback lacking sampleAt uses the provided vx/vz without extra shear; this preserves existing harness fixtures. Keep noise continuous; no random refreshes or frame-dependent gust changes. Do not change wave state from each gust.

## Aerodynamic force and physical sail state

At every sample, `u=wind(p,t)-(vel+angVel×(p-pos))`. Keep all three components, including heave/roll-induced apparent air. Dynamic pressure `q=.5*1.225*|u|²`. If speed <1e-8 or area=0, force is exactly zero. Let `d=u/|u|`, world normal n transformed from the shared rig, `s=clamp(d·n,-1,1)`, `alpha=asin(abs(s))` in [0,PI/2].

Attached coefficient `CLattached=4.0*sin(alpha)*cos(alpha)`. Separated coefficient `CLseparated=1.0*sin(2*alpha)`. Separation weight is smoothstep(18°,32°,alpha). `CL=lerp(CLattached,CLseparated,separation)`. Unsigned drag `CLeffective=abs(fill)*CL`; `CD=.035+1.7*sin(alpha)^2+CLeffective^2/(PI*.7*.7)`. Full-sail geometric aspect ratio is vertical span squared divided by area, `7²/70=.7`; the final .7 is the engineering efficiency factor. Keep reference aspect ratio fixed in this bounded reef model rather than inventing increased reef efficiency. Induced drag therefore vanishes with actual lift when fill collapses. These curves are continuous, zero-lift edge-on/broadside and drag-positive.

Lift unit direction is `sign(s)*(n-s*d)/sqrt(max(1e-16,1-s*s))`; when perpendicular length <1e-8 set lift to zero. Force `F=q*area*(CD*d+abs(fill)*CL*liftDirection)`. Scale the pressure drag term `1.7*sin²(alpha)` by `.2+.8*abs(fill)`; baseline and induced drag remain nonnegative. This guarantees `F·u>=0`: the sail cannot add energy relative to its surrounding air. The passive relative-air check is the sign above, not F·boatVelocity. Near 90°, guard division and use zero lift; coefficients approach zero lift continuously.

A single coherent signed fill state represents the sail, not independent artificial panel flaps. At the center evaluate normal air speed vn and incidence. Fill target = `tanh(vn/1.2)*smoothstep(2°,9°,alpha)`. Integrate exponentially `fill += (target-fill)*(1-exp(-dt/tau))`, tau=.65 s filling, .22 s collapsing/reversing (use collapse whenever target*fill<0 or abs(target)<abs(fill)). Fill must cross zero on a tack; lift fades during that crossing. Force sign always comes from current air incidence, never stale fill. Reverse normal flow loads the opposite face physically even before the cloth has fully inverted.

At squared yard, following wind moves toward -z, so signed pressure is negative for a normally drawing sail. `pressure=fill*clamp(load/(.5*1.225*70*8*8),0,1)`. Renderer uses this sign directly as displacement along the shared +normal; change the existing shader `-uBillow` sign to match, rather than passing signed fill through an opposite convention. Do not derive it from forward thrust. Flutter = deployment * (1-abs(fill)) * smoothstep(.3,3,centerAirSpeed), bounded [0,1]; true calm has no wind flutter.

Point-of-sail telemetry: apparent speed<.3 gives calm; abs(wrapped apparentFrom)<60° gives windward; >135° gives run; otherwise reach. These are descriptive sectors, not a claim of an exact no-go cone. `lateralForce` is sideforce and `forwardForce` is drive; `heelMoment` is total sail-only torque projected onto quat*(0,0,-1).

Status precedence: deployment<.02 → furled; deployment differs from target >.04 → setting; fill>.15 and incidence>9° → aback; abs(fill)<.2 or incidence<7° → luffing; otherwise drawing. Slight temporal hysteresis in HUD is acceptable, never in force. 'Drawing' describes filled cloth, not guaranteed forward thrust. Aback remains possible in auto mode while crossing the wind; no hidden force suppression when facing upwind.

## Crew trim and deployment

Deployment moves toward target at 1/6 per second, exactly rate-limited. Yard movement is rate-limited to .25 rad/s and ±45°. Same physical limits apply to manual/auto. No instant trim or instant reef loads.

Automatic trim runs each .25 simulated seconds, using 25 uniformly spaced candidate angles including endpoints and zero. Estimate candidate settled force from center apparent wind and the same coefficient model (candidate fill target, exposed area). Score in N: `forwardForce-sidePenalty*abs(lateralForce)-300*abs(candidate-currentYard)`, where `sidePenalty=.22+1.8*smoothstep(8°,18°,abs(heel))` from the actual body orientation. The lateral penalty represents crew preference for manageable side load, not an extra force. Retain existing target unless improvement exceeds max(20 N, .025*abs(currentScore)); deterministic ties prefer nearest current angle then smallest absolute angle. With negligible wind or deployment<.02, target zero. Do not let trim depend on frame rate. This controller only moves the yard; it cannot directly change hull speed or heel.

Controls, only where sail control was already allowed: F retains raise/lower using last nonzero selection (initial full); G toggles full/half exposed sail without forcing a furled sail to raise; J/L hold to move manual target left/right at .35 rad/s and enter manual mode; K restores crew trim. J means negative yard angle and L positive. F does not silently reset manual mode. Existing V spyglass, R, Z, X, W/S, A/D, [/] bindings retain meaning. Player input dt is simulated dt consistently with helm control. If J/L collide with an existing binding outside inspected game code, report to lead before rebinding.

## Shallow-hull lateral balance

Retain existing buoyancy, vertical damping, longitudinal skin/wave drag, rudders, oars and column sampling. Replace the column lateral expression with a coupled horizontal lift/drag contribution plus its existing low-speed crossflow resistance; do not add a keel or remove viscous losses.

For local hull velocity relative to water `(vx,vz)`, speed U, let `b=atan2(vx,abs(vz))` (zero when U tiny). `CL=.8*sin(2*b)`; this is odd in lateral slip and zero at pure broadside. Lift direction `(-abs(vz)/U, sign(vz)*vx/U)` in x,z, multiplied by signed CL: it opposes lateral slip and is perpendicular to velocity for both ahead and astern. Its force magnitude is `.5*1025*Alat*U²*CL`, with existing submerged `Alat=subDepth*c.dz/4`. Induced drag coefficient = `CL²/(PI*.18*.7)`; force along `-(vx,vz)/U`, magnitude `.5*1025*Alat*U²*CDinduced`. Preserve existing crossflow `Fx=-.5*1025*1.1*Alat*vx*abs(vx)-400*Alat*vx`. Add lift and induced drag to x/z, apply at the existing submerged column center. Exactly zero at zero flow, and total horizontal force dotted with local water-relative velocity must be nonpositive. Pure forward/astern flow leaves existing rowing resistance unchanged. The shallow aspect ratio .18 is a bounded engineering approximation. No increased forward force from lateral resistance alone; perpendicular lift may have a forward component while the combined water-relative power remains dissipative.

## Visual and HUD contract

Cloth width, deployed height, yard axis/rotation, sample centers and signed pressure share the geometry source. Use physics previous/current interpolation for deployment/yard/fill and time-based flutter; remove per-render-frame .05 filtering. Exposed fabric collapses toward the yard with deployment. Preserve existing shader style while making billow sign/loading and slack/flutter honest. Do not make every gust flap a fully loaded sail. Rig geometry is planar for force integration; billow is a visual approximation, explicitly documented.

Keep the existing sail line rather than add a panel: `Sail drawing · crew trim`, `Half sail · drawing`, `Sail luffing`, `Sail aback`, with a brief `manual trim` suffix when relevant. Remove routine kN from this player-facing line; leave quantitative load in debug telemetry. Furled state can fade after a few seconds as today. Add one small apparent-wind tick/chevron to the existing heading tape, using apparent-from bearing, visually distinct from heading. If apparent wind lies outside the tape span, retain a subdued outward-pointing amber chevron inset 6 px at the corresponding edge; it must not disappear during ordinary reaches/runs. Within 5° of directly astern relative to the camera, show both edge chevrons to avoid ambiguous ±180° side flips. Suppress wind markers below .3 m/s apparent speed. This marker remains in full/minimal density. In full density only, show restrained `leeway 6°` when abs water-relative leeway exceeds 3° and forward speed >.5 m/s, after .5 s persistence. Minimal density keeps sail condition but omits leeway/control hints; none stays none. Full help lists F/G/J L/K. No efficiency score, optimal-angle target, racing laylines, windward warning banner or compulsory tutorials. The physical cloth, heading tick and short state labels should explain the same event.

## Acceptance evidence

Run `npm run test:rowing` unchanged, `npm run test:sailing`, build/type checks. Report actual measured values, not historical claims. Tests are headless physics and geometry; no browser request is implied.

1. Geometry: nine sample areas sum to 70*set within 1e-10; rendered/full and half extents agree; all points transform around the actual yard; normal/tangent orthogonal at -45/0/+45°. Finite-difference rigid-body sample velocity agrees within 1e-5 m/s.
2. Pure force: 1,000 deterministic orientations/velocities satisfy `F·u >= -1e-8*max(1,|F||u|)`; zero flow exactly zero; mirrored flow/yard yields mirrored force within 1e-8 relative. Broadside lift→0; coefficient finite and continuous across 18/32/90° (1e-5 rad perturbations cause <.001 coefficient jump). Test both normal signs.
3. Fill/luff/aback: edge-on incidence gives abs(fill)<.05 after 2 s; stable following wind yields fill<-.8, headwind yields fill>.8; reversing at fixed yard crosses zero continuously, no per-step change >.1 at 120 Hz. Flutter vanishes in calm. Six-second deployment reaches target within one step, yard moves no faster than .25 rad/s.
4. Wind: baseSpeed=0 returns zero at 0/10/30 m and multiple positions/times; 10 m factor=1, height ratios follow exponent .11. Identical seed/location/time repeats exactly independent of sample order. Nearby x+0.01 m/t+0.001 s samples differ <.02 m/s; 120 versus 240 update schedules agree at equal time within 1e-9 m/s. Mean sea driver does not contain fast gust terms.
5. Reef: locked body, same stationary wind/manual angle, settled fill, full versus half load ratio .45–.55 in uniform wind; full field with shear must still reduce resultant load by >35%. Center of exposed area moves upward. No force discontinuity >3% of settled full load per 120 Hz step during deployment.
6. Hull: 1,000 deterministic velocities show nonpositive water-relative horizontal power; pure forward/astern leaves baseline axial drag unchanged within 1e-9. Mirror port/starboard sail+water setup mirrors lateral acceleration and heel. In 8 m/s beam/quartering air, sail-only creates measurable lateral slip (>0.01 m/s) and heel (>0.05°), both finite; do not tune to a historical heel target.
7. Propulsion regimes: flat water, constant uniform wind, initial rest, 120 s, deep terrain, no mooring. Run sail-only (crew rest), row-only (sail furled), combined (same rowing order). Report mean last-30-s speed, stamina, sail/oar impulse, heel, leeway. Following 8 m/s wind: sail-only forward speed >.3 m/s with no active rowing stamina expenditure; row-only >.3; combined exceeds row-only speed by >.05 m/s and differs from sail-only. Verify combined sail load differs from static-body load because boat velocity changes apparent wind. Calm row-only and calm combined after furled/deployed drag converge within 5% speed; a moving deployed sail may impose air drag and is not required to be identical.
8. No-go crossing: prescribed heading sweep -80→+80° across wind-from over 40 s and a freely moving head-to-wind comparison. Force, fill and yard stay continuous; near headwind settled forward sail force is <=0, never a drive bonus. Active rowing provides positive oar impulse and greater forward progress than rest over 20 s headwind. Log rather than impose a universal exact no-go angle; the actual envelope emerges from geometry/drag.
9. Coupling: use a gust/beam-wind episode with same rowing order; actual roll and blade immersion differ from calm, with all existing per-oar force/geometry invariants intact. No synthetic mode flags influence force.
10. Convergence: identical 60 s deterministic smooth-wind scenario at 120/240 Hz yields final speed within max(.03 m/s,2%), final position within 1 m, integrated sail impulse within 2%, yard within .01 rad; if failed, investigate integrator/controller scheduling before relaxing tolerance.
11. Long run: 300 s varied wind/wave deep-water run, including partial sail, reversal and calm interval; every pose/velocity/load finite, quaternion norm within 1e-5, no unbounded energy gain in calm with crew rest. Record maxima and runtime. This is local stability evidence, not a storm-survivability claim.

If any numerical target conflicts with preserved rowing tests, lead resolves the physical cause and documents a justified coefficient/spec revision. Workers do not tune arbitrary advantages to make a speed assertion green.
