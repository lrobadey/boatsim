# Trireme rowing implementation specification

Status: implementation contract, 2026-10-05; revision 3 (stroke efficiency and continuous human-limit transitions). Author: delegated rowing specialist. Scope: rowing, its necessary water-relative force integration, oar rendering, and rowing sound/foam only. Browser screenshots and final visual review were explicitly authorized by the user after revision 1; mathematical tests remain offline. This document describes the final design, not already implemented behavior.

## 1. Outcome and fidelity boundary

Make all 170 oars visibly and physically agree. Each bank uses its actual length and fulcrum; blades enter, load, extract, feather, recover, and square. Commands take effect through continuous joint trajectories. Hard low-speed helm can back the inner side without erasing its effort. Waves affect each longitudinal station independently. A blade that misses the water contributes zero force, and a submerged recovering blade contributes drag. Stopping by holding water dissipates hull motion; it never supplies a hidden reverse engine.

Use a **bounded kinematic traction model**: prescribed, continuous human stroke trajectories plus dissipative hydrodynamic traction limited by handle force, instantaneous mechanical power, and sustained energy availability. This is an explicit reduced-order approximation. Saturation represents unresolved hand/shaft compliance and blade slip; it is not an exact rigid-oar torque-equilibrium solution. Do not claim otherwise. It is selected to preserve disciplined formation timing and reliable control within this engine. Geometry, velocities, contact, force direction, and power accounting must nevertheless agree exactly within the tolerances below.

Deferred: dynamically solved oar angular inertia and shaft bending, added-mass/catch impulses, vortex/lift histories, rower body/seat inertia, individual skeletal rowers, hull/oar collisions and breakage, individual injuries, finite-depth wave dispersion, current fields, and CPU FFT micro-wave contact. No generic thrust multiplier, speed clamp, extra yaw torque, simulated catch impulse, or recovery-force disabling is permitted. Existing hull dimensions, mass, sail, terrain, harbor, world generation, clouds, camera and controls stay in scope only where explicit integration below requires it.

## 2. Evidence and interpretation

These sources support the physical choices; the numerical gameplay constants in subsequent sections are authored calibration choices unless explicitly identified here.

* Labbé, Boucher, Clanet and Benzaquen, *Physics of rowing oars*, sections 2–4, equations 1–5: blade velocity combines motion relative to the hull with hull motion relative to water; drag opposes slip; the inboard/outboard lever connects hand and blade forces. Their controlled-force experiment motivates a force limit rather than unbounded prescribed-motion thrust. The model omits some flow effects; it is not a direct ancient-rower calibration. [Author paper](https://arxiv.org/html/1904.09338v1).
* Grift et al., *Hydrodynamics of rowing propulsion*, JFM (2021): unsteady blade flow and the free surface matter. This implementation deliberately does not pretend that a steady normal-drag law captures all of them. [Publisher article](https://www.cambridge.org/core/journals/journal-of-fluid-mechanics/article/hydrodynamics-of-rowing-propulsion/C2B6C018FF1B7A677A1A1EC5FAE5B458).
* Barré and Kobus, *Comparison between common models of forces on oar blades and forces measured by towing tank tests*: normal-force models are an established simplified representation, but their coefficients require experimental comparison. [Paper](https://journals.sagepub.com/doi/10.1243/17543371JSET43).
* Hellenic Navy museum specifies Olympias length 36.90 m, width 5.50 m and draft 1.25 m; its published displacement is 70 tonnes. Preserve the current modeled displacement, rather than importing a conflicting displacement from another loading condition. [Official construction account](https://averof.hellenicnavy.gr/en/trireme-olympias/construction-of-the-trireme-by-the-hn/).
* Rankov (ed.), *Trireme Olympias: The Final Report*, chapter 4, Table 4.2 and sections 4.1–4.2: reduced-crew 1994 sprint trials recorded 6.3–7.0 kn means at 42–44 spm, with calculated effective resistance power 9.9–14.1 kW. The report describes immersion problems from reduced draft and small heel changes. Those runs had approximately 120 active rowers and cannot be treated as a full-crew speed/power curve. [Primary trial report, searchable PDF](https://www.ancientportsantiques.com/wp-content/uploads/Documents/AUTHORS/Rankov2012-TriremeOlympia.pdf). The full PDF exceeded the web reader's size limit; the cited table and sections were retrieved through its indexed text.

Do not use generic “9 knots continuously” claims as measured calibration data. The existing 170 slots and bank-specific dimensions remain an artistic reconstruction; this work does not certify archaeological accuracy. Broad speed envelopes below are game acceptance targets, not claims about an ancient vessel.

## 3. Current defects confirmed by inspection

`physics.ts` evaluates six groups at `bank.zMid`, with radius 2.8 m and y=-0.1, instead of actual blade geometry. All zMid values are zero. It ignores dip, feather, slot jitter, and water orbital velocity. Inner-side reverse orders at maximum low-speed helm can have zero effort. `trireme.ts` animates the original forward order on both sides, builds all oars with length 4.15/inboard 0.9, and separately tracks blade centers with bank-dependent radii. `bladeIn` is stroke phase rather than contact. `foam.ts` detects transitions from that render-time flag, and `audio.ts` schedules release noise from a predicted drive duration. Hull damping uses a moving-point surface-height finite difference as if it were particle velocity.

The lead's original-method headless regression reproduces zero thrust despite 119 actual rendered blade centers being submerged in a longitudinal short-wave pose; the same stroke in flat water gives 53.3 kN. Retain that adversarial test concept with the new shared geometry, not its defective constants.

## 4. Ownership and public seams

Create `src/ship/rowing.ts`. `ShipPhysics` constructs and owns one `readonly rowing: RowingSystem`, passing the existing `Crew`. `Crew` remains the public orders/stamina facade used by input and HUD. Remove independent phase/kinematic evolution from `Crew.update`; only `RowingSystem` advances stroke state. `ShipPhysics.step(dt)` calls rowing exactly once before rigid-body integration. Remove the separate `crew.update(SIM_DT)` call from `game.ts`. Preserve existing order indices, names, short names, `setOrder`, `holdWater`, `stamina`, `strength`, `readiness`, `rate`, `phase`, `driveTime`, `period`, `driveFrac`, and `exhausted` as compatibility properties. They are telemetry/requests, not parallel drivers. Remove obsolete `stroke` and `OAR_BLADE_R` uses; remove their exports if unused.

Minimal interfaces (names below are contractual; extra private helpers are allowed):

```ts
export type RowSide = -1 | 1;
export type RowMode = 'rest' | 'row' | 'exit' | 'transfer' | 'enter' | 'hold';
export interface JointPose {
  sweep: number; dip: number; feather: number;
  dSweep: number; dDip: number; dFeather: number;
}
export interface OarKinematics {
  // all vectors hull-local, relative to the hull's geometric origin
  pivot: THREE.Vector3; center: THREE.Vector3;
  axis: THREE.Vector3; widthAxis: THREE.Vector3; normal: THREE.Vector3;
  centerVelocity: THREE.Vector3;
  axisVelocity: THREE.Vector3; widthAxisVelocity: THREE.Vector3;
  matrix: THREE.Matrix4;
}
export interface RowBody {
  readonly pos: THREE.Vector3; readonly quat: THREE.Quaternion;
  readonly vel: THREE.Vector3; readonly angVel: THREE.Vector3;
  readonly cg: THREE.Vector3;
}
export function evaluateOar(
  slot: Readonly<OarSlot>, joint: Readonly<JointPose>, out: OarKinematics
): void;
export class RowingSystem {
  readonly slots: readonly OarSlot[];
  readonly previous: BladeFrame;
  readonly current: BladeFrame;
  readonly events: RowEventRing;
  // Call before ship integration, at the same t used for other forces.
  step(dt: number, time: number, body: RowBody, helm: number,
       waves: WaveField, forceOut: THREE.Vector3, torqueOut: THREE.Vector3): void;
  // Writes interpolated local joints/geometry. Does not mutate simulation/events.
  renderPose(index: number, alpha: number, out: OarKinematics): void;
  reset(body: RowBody, time: number): void;
}
```

`forceOut` and `torqueOut` are additive accumulators, never reset inside rowing. Do not expose or call `ShipPhysics` private force methods. Torque is `(worldContact - body.pos) cross force`. `RowingSystem` is usable headlessly with Three math classes and fake water/body, with no DOM/WebGL/AudioContext.

`BladeFrame` is allocated once: Float64Array joint[170*6] (sweep,dip,feather,dSweep,dDip,dFeather), centerLocal[510], centerWorld[510], normalWorld[510], forceWorld[510], wetArea[170], positivePower[170], handleForce[170]; plus Uint8Array contact[170]. Previous/current buffers are copied/reused each fixed step, not recreated. Store per-blade energy reservoir and contact hysteresis separately. Side controllers hold mode, latched direction, target direction, phase time, durations, effort, target effort, transition elapsed and six boundary values per joint; no per-frame objects. Slots keep stable IDs equal to array index. Side-to-slot mapping is allocated once.

`Crew.phase` is the forward/port reference cycle phase (0..1), or 0 while stopped/holding; `Crew.rate` is reference cadence (spm) and becomes 0 when no side is rowing. `readiness` reports 1 whenever any side is not rest and 0 in rest, smoothed with a 0.25 s time constant for legacy telemetry only; it must not alter geometry or forces. `driveTime` and other compatibility getters return the currently latched cycle timing. Existing roll damping must stop using readiness as an extra oar-drag term: change cRoll to its hull-only 22000; actual oar drag now supplies the oar contribution. Retain existing hull quadratic roll damping.

## 5. Shared layout and mesh geometry

Extend `OarSlot` with `id`, `length`, `inboard`, `bladeLength`, `bladeWidth`, `bladeThickness`, `bladeRadius`. Generate exactly once from `oarSlots()` in rowing; renderer consumes that array. Preserve current bank counts 31/27/27 per side, slot station formulas and fulcrum x/y/z. Use lengths 4.5/4.2/3.9 m, inboards 0.95/0.95/0.9 m. Blade length Lb=0.66 m, width Wb=0.17 m, thickness 0.028 m; area = 0.1122 m²; center radius R = length-inboard-Lb/2, namely 3.22/2.92/2.67 m. Every calculation uses these exact values.

Build three `InstancedMesh` objects, one per bank, rather than distorting a shared length. Bank geometry: shaft spans local x=[-inboard,length-inboard], blade box is centered at local (R,0,0), dimensions (Lb,Wb,thickness). Matrix columns are axis, widthAxis, normal; translation is the original slot pivot. Determinant must be +1, with no negative scaling. Map global slot ID to bank instance ID once. Preserve shadow/refraction/material behavior. Remove unused original shaft/blade temporary geometries and the old constant-length mesh. Do not translate the fulcrum inboard for rest; rest means feathered, raised oars still run out. Shipping oars through ports is deferred.

Coordinates: hull-local +x starboard, +y up, -z forward; side s is -1 port/+1 starboard. Positive sweep a puts the blade toward the bow. Positive dip d lowers the blade. For c=cos and q=sin:

```
u = (s*cos(d)*cos(a), -sin(d), -cos(d)*sin(a))
b = (s*sin(d)*cos(a),  cos(d), -sin(d)*sin(a))
n0 = u cross b
B = b*cos(f) + n0*sin(f)
N = n0*cos(f) - b*sin(f)
C = pivot + R*u
```

Here f=0 is squared (blade broad dimension largely vertical), f=pi/2 feathered. `matrix.makeBasis(u,B,N).setPosition(pivot)`. Blade point at local material offsets (l,w) is `pivot+(R+l)*u+w*B`. Differentiate the displayed equations analytically with joint angular velocities; centerVelocity=R*du/dt. Provide derivatives of both u and B, including feather motion. A wet patch centroid is a material location for instantaneous velocity: `(R+l)*du + w*dB`; **do not differentiate the motion of the wet centroid itself**, which is not water/oar material velocity.

No random phase jitter in the first implementation: deterministic common side timing is necessary for paired-bank clearance and mirrored turning tests. Existing static visual jitter is removed. Bank differences in reach/dip already avoid a mechanically cloned appearance; ornamental jitter can only be added later through the same evaluated joint state.

## 6. Cyclic stroke and stationary poses

All interpolation uses quintic smoothstep Q(x)=6x^5-15x^4+10x^3, Q'=30x²(x-1)², clamped x in [0,1]. Angles interpolate q=q0+(q1-q0)Q; velocity=(q1-q0)Q'/duration. Never finite-difference wrapped phases or use an old rate with a new period. Cycle durations are latched at a cycle boundary.

Orders retain existing rates 18/0/18/26/31/46 and efforts .5/0/.45/.65/.85/1. Requested rate changes by at most 6 spm/s in controller state; latch new rate at cycle boundary. Start a row cycle at 18 spm, ramping thereafter; there is no multi-second near-zero cadence wait on startup.

For rate r, T=60/r, D=clamp(.48*T,.68,1.55), and C=E=min(.12,.10*D). D is the entire sweeping/working interval, including overlapping catch and extraction. A=0.72 rad, Z=-0.58 rad. Forward endpoints are A→Z; backing endpoints Z→A (do not negate both endpoints about zero). At 18/26/31/46 spm, D is 1.55/1.10769/.92903/.68 seconds. Do not retain revision 1's short, sharply peaked quintic drive or stationary immersed catch/extraction dwells.

The drive uses a smooth, nearly constant angular-speed profile. Define epsilon=.15, k=1/(1-epsilon), Q as above, and IQ(x)=x^6-3*x^5+2.5*x^4 (the integral of Q). For normalized drive time x=t/D in [0,1]:

```
if x < epsilon:
  P = epsilon*k*IQ(x/epsilon)
  dPdx = k*Q(x/epsilon)
else if x > 1-epsilon:
  P = 1-epsilon*k*IQ((1-x)/epsilon)
  dPdx = k*Q((1-x)/epsilon)
else:
  P = k*(x-epsilon/2)
  dPdx = k
sweep = start + (end-start)*P
dSweep = (end-start)*dPdx/D
```

This has zero endpoint velocity/acceleration and continuous shoulders. Peak angular speed is 1.17647 times mean, rather than 1.875 times mean for a full quintic sweep. Keep quintic position interpolation for dip, feather, recovery, and interrupted transitions.

Per blade, nominal dip angles are:

```
dWet = asin(clamp((pivotY + .23)/R, -.2, .90))
dDry = asin(clamp((pivotY - .42)/R, -.2, .90))
```

They target blade centers 0.23 m below and 0.42 m above the design plane. Do not chase instantaneous waves: ship heave/roll and different water heights naturally produce misses, deeper catches and recovery strikes. This prevents a magical sea-following oar and honors limited rower reach. These nominal targets are fixed by slot geometry, not recomputed from contact.

Cycle table (all intervals in seconds):

| Interval | Sweep | Dip | Feather |
|---|---|---|---|
| 0..C, moving catch | drive profile at t/D | dDry→dWet | 0 |
| C..D-E, loaded drive | same continuous drive profile | dWet | 0 |
| D-E..D, moving extraction | same continuous drive profile | dWet→dDry | 0 |
| D..D+.12, feather | fixed end | dDry | 0→pi/2 |
| D+.12..T-.12, recovery | end→start using Q | dDry | pi/2 |
| T-.12..T, square | fixed start | dDry | pi/2→0 |

Catch and extraction now overlap the smooth sweep shoulders. Do not split the sweep into three independent interpolations: P(t/D) runs across all of 0..D, and dip evolves separately. The fastest recovery remains .38435 s at 46 spm, avoiding revision 1's unrealistically hurried .075 s recovery. Rest pose: sweep=.07, dip=dDry, feather=pi/2. Hold pose: sweep=.07, dip=dWet, feather=0. Both have zero derivatives. `missedDriveFraction` counts only C<=t<D-E, where the blade is commanded loaded; `crew.driveTime` remains D.

Revision rationale and measured evidence: the faithful revision 1 implementation missed the original speed gates (SLOW2.62/HALF2.99/FULL3.45kn) and dissipated 90–93% of input power as slip. Allowed +15% power calibration failed to remedy that and worsened stamina. The fault was the authored trajectory, not a discovered force-sign implementation error. An isolated prototype replacing only the cyclic trajectory with revision 2, retaining all original force/power constants, produced 120s last30s means SLOW3.973/HALF5.631/FULL6.673/BACK-3.601/RAM7.594kn. FULL stamina was .982; mechanical input27.57kW versus slip loss11.27kW. These are prototype CPU measurements; final integrated validation must repeat every gate. No speed target, power cap, handle cap, or hull coefficient is relaxed by this revision.

## 7. Commands and transitions

Side index 0=port,1=starboard. Requests are recomputed each step but directions change only through the state machine. Hold request has priority over orders/helm. Stop requests rest on both sides. Back orders back on both sides; helm eases the inner side but does not reverse the outer side while backing.

For forward rowing compute speed through water at the CoG projected onto world-forward. `turn = smoothstep(.35,1,abs(helm))`, `low = 1-smoothstep(.8,3,abs(speedThroughWater))`; smooth these controller factors with exponential time constant .20 s. The inner side is the side with sign(helm); when abs(helm)<.05 neither side is inner. Outer effort = order effort. Inner signed command `c=1-turn*(.65+1.10*low)`, range [-.75,1]. Use hysteresis: enter backing when c<-.12, return forward when c>.12; in the dead zone request rest. For the backing state effort = order.effort*abs(c), never the old `(1-turn)` multiplier. A fully hard helm at rest therefore backs the inside at .75 effort while the outside rows forward at full ordered effort. At high speed it eases to .35 and never backs. For a back-water order, inner effort = order.effort*(1-.55*turn), both directions=-1. Effort itself slews at max 1.5/s and stays nonnegative.

Normal changes in rate/effort do not interrupt a cycle. Direction, hold, or rest changes do:

1. Enter `exit` immediately from the actual present joint values and velocities. Over .28 s move dip to dDry, feather to 0, and sweep to `clamp(currentSweep + .12*currentDSweep, Z, A)`. Finish with zero velocities. No order cancels hydrodynamic contact; force continues from the moving blade.
2. Enter `transfer` for .38 s: at dDry, move sweep to the requested direction's catch endpoint, or .07 for rest/hold. Feather goes to pi/2 for rest, zero for hold/row. End with zero velocities.
3. Rest target: enter `rest`. Hold target: `enter` for .22 s lowers dip to dWet, then `hold`. Row target: enter `row` at phase time 0 with dry, squared blades, beginning the normal catch. Never lower once in `enter` and then jump back to a dry cycle pose.

If a request changes during exit, update only pending destination; finish the existing exit curve. If it changes during transfer or enter, restart an exit curve from current values AND current derivatives. Do not restart the curve merely because effort/rate changes. The final pending request is read at each stage boundary, so startup hold with rate=0 works and release-hold→stop ends dry. Initial construction/reset is rest pose, zero velocities, no contact/audio events, stamina retained unless new game explicitly resets it.

Transition interpolation must preserve incoming angular velocities. Use quintic Hermite boundary interpolation with q(0)=q0, q'(0)=v0, q''(0)=0, q(1)=q1, q'(1)=q''(1)=0. With x=t/H:

```
q = q0 + (q1-q0)*Q(x) + H*v0*(x-6*x^3+8*x^4-3*x^5)
dq/dt = (q1-q0)*Q'(x)/H + v0*(1-18*x^2+32*x^3-15*x^4)
```

The zero assumed initial acceleration gives C1 continuity; do not claim C2 when interrupting a cycle. In tests ensure angles remain within [Z-.25,A+.25], dip [-.3,1.20], feather [-.15,pi/2+.15]. If a .28 s exit overshoots these bounds, shorten projected sweep stop distance, not pose-clamp the animation. If a transition consumes a boundary within a fixed step, process remaining time in the next stage; max four boundaries per step, with an assertion if exceeded. Copy previous frames before evolution. Compute analytic instantaneous derivatives; validate with central differences only in tests. Frame interpolation must not be used for physical derivatives.

## 8. Water query and spatial sampling

Add `WaveField.sampleFlowAt(x,y,z,t,out)` returning height, height gradient hx/hz, and particle velocity vx/vy/vz. Output object is caller-owned scratch. Preserve existing surface rendering and `heightAt` semantics. Invert horizontal Gerstner displacement with the same four fixed-point iterations as heightAt, followed by the final evaluation. Compute gradient using the horizontal displacement Jacobian at the resulting undisplaced coordinates: `gradWorld = J^-T * gradUndisplaced`. Guard abs(detJ)<.10 by a sign-preserving .10 denominator; count guards in diagnostics. The current steepness budget should normally avoid this guard.

At that undisplaced point, each component has theta=k*(dx*px+dz*pz)-omega*t+phase. With depth=max(0,height-y), attenuate each component by exp(-k*depth). Sum:

```
vx += attenuation*q*amp*omega*dx*sin(theta)
vz += attenuation*q*amp*omega*dz*sin(theta)
vy += attenuation*(-amp*omega*cos(theta))
```

These are material orbital velocities consistent with the existing frozen-amplitude Gerstner geometry, with a deep-water decay approximation. Ignore the minute-scale amplitude derivative rather than mixing it with advective height change. State this approximation in code. Preserve legacy velocityAt if other callers need it; implement it through the same inverse-coordinate convention at depth zero. No current exists yet, so zero waves means zero flow.

Per oar query the actual blade center once. Its tangent water plane is `eta(X,Z)=height+hx*(X-centerX)+hz*(Z-centerZ)`. Split the rectangle into four equal **longitudinal blade strips**, l∈[-Lb/2+j*Lb/4,-Lb/2+(j+1)*Lb/4], w∈[-Wb/2,Wb/2]. Clip each world-space strip against `eta(X,Z)-Y >=0` with Sutherland–Hodgman, using fixed-capacity numeric scratch arrays (at most five polygon vertices). Compute polygon area and material centroid in (l,w) by the shoelace formula. This gives continuously varying physical wet area including partial-width/partial-length immersion for squared or feathered blades; do not multiply by a phase envelope. Four strips are independent force samples, and all 170 distinct station centers are always sampled.

At wet centroid get body-point velocity `body.vel + body.angVel cross (worldPatch-body.pos)`. Add rotated material joint velocity from section 5. Subtract orbital water velocity. Center flow may be reused for all four patches in the normal path, evaluated at each patch's depth using the center's per-component phases and exp(-k*patchDepth); cache phase sin/cos in preallocated arrays while evaluating center query. This avoids additional inversion queries and still accounts for depth.

Accuracy fallback: set blade-radius bound rb=hypot(Lb/2,Wb/2). At the center inverse query compute the smallest singular value sigma of the 2x2 horizontal Jacobian. Accumulate H=sum(abs(amp)*k²), Hx=sum(abs(q*amp)*k²), and estimate K=H/(max(.25,sigma-rb*Hx)^3). This is a conservative local curvature trigger, not a proved global surface error bound; the independent comparison test below establishes its usable domain. If .5*K*rb²>.025 m, query each strip center's exact water height and gradient and use that strip's own tangent plane/phase cache. Maximum five flow inversions per blade; no global force-point shortcut is allowed. Use actual array length rather than hard-coded 24 in CPU loops, enabling single-wave test fixtures. Production still uses 24 components.

Area should change continuously from clipping; no extra wet/dry force latch. Area <1e-9 m² is dry, returning exactly zero force. Event hysteresis is separate. No force acts on a fully dry blade. The flat-water blade-center target -.23 m normally submerges the blade completely, but local geometry and heel decide the actual result.

## 9. Force law, caps, and energy accounting

Use rho=1025 kg/m³, normal coefficient Cn=1.8, tangential coefficient Ct=.025. At wet patch area Aj and relative material velocity v:

```
vn = dot(v,Nworld)
vt = v - vn*Nworld
Fraw = -.5*rho*Aj*(Cn*vn*abs(vn)*Nworld + Ct*length(vt)*vt)
```

This is a normal flat-plate model with small profile drag. It has `Fraw dot v <= 0` by construction. Feathering rotates the normal, reducing horizontal resistance naturally; do not multiply by a feather scalar. At forward drive a decreases, blade sweeps aft relative to hull (+z), water reaction is forward (-z). At back drive this reverses. At high forward speed near catch/release the same law may brake; never clamp longitudinal force to positive.

For each blade collect four raw patch forces before limiting. Let rj = worldPatch-worldPivot. Demand handle force `Hraw = length(sum(rj cross Frawj))/inboard`; this accounts for all joint loading, including dip. Let positive actuator power `Praw=sum(max(0,-Frawj dot vJointWorldj))`. Conservative summation avoids hiding simultaneous positive and negative patch work. Negative work is absorbed and never credited to stamina/energy stores.

Human limits have continuous state, rather than instantaneous mode-dependent caps. Store three unscaled scalar states per side controller: `handleLimit=120` N, `peakLimit=100` W, and `meanLimit=20` W at construction. “Unscaled” means before strength and calibration multipliers. They describe how firmly the rowers are currently braced and how rapidly they can currently deliver/replenish mechanical work. Both sides own separate states; all blades on a side share their limits.

After request processing and controller evolution each fixed step, compute targets from the resulting mode and continuously slewed effort:

| Mode | Handle target N | Peak-power target W | Mean-power target W |
|---|---|---|---|
| row | 750*effort | 1400*max(.2,effort) | orderMean*(order.effort>0 ? effort/order.effort : 0) |
| exit/transfer/enter | 750*max(.25,lastEffort) | 500 | 60 |
| hold | 900 | 100 | 30 |
| rest | 120 | 100 | 20 |

orderMean is back90,stop20,slow70,half120,full190,ram320 W. Clamp the unscaled targets to [0,900], [0,1400], [0,320] respectively for defensive safety. Filter each of the three scalar states with time constant tau=.16 s: `state += (target-state)*(1-exp(-dt/.16))`. This uses the step's final mode for the bounded fixed-step approximation; subdivision at a mode boundary is optional if it preserves the same continuous filter. Do not snap or reinitialize these states at cycle, stage, order, direction, or hold boundaries, including interrupted exit/transfer/enter. `reset`/teleport retains all three states together with stamina and blade energy; only a new RowingSystem initializes them. Filters advance only during positive simulation dt, not rendering or paused time.

Effective per-blade Hcap=`side.handleLimit*strength*handleMultiplier`; Ppeak=`side.peakLimit*strength`. The filter is the authoritative human limit: transient retention of a stronger grip while lifting/backing out of a stroke is intentional. Do not additionally clamp it instantly to the new mode's target, which would reintroduce the snap. Hard absolute bounds remain 900*strength*handleMultiplier N and 1400*strength W. Strength=.65+.35*sqrt(stamina), replacing the old .35 floor. These are tuned human-scale upper bounds, not claimed measured ancient strengths.

Each blade has energy E, maximum Emax=2*320=640 J, initialized full once at new simulation creation. Replenish before force evaluation by `Pmean=side.meanLimit*strength*powerMultiplier`, `E=min(Emax,E+Pmean*dt)`. Reservoir never refills instantly on an order change or stroke boundary. Available energy power cap = E/dt. Record actual accepted replenishment (after reservoir capacity clipping) for the cumulative energy inequality. The smoothed replenishment transient is part of this recorded budget, not an extra free energy source.

This handles freshSTOP→hold with zero prior effort: the transition target remains at least187.5N but entering hold ramps toward900N without a grip discontinuity. Hold→rest/row retains grip briefly while extracting, then ramps to the target. Grip is never multiplied by zero rowing effort in hold. A stationary hold blade has zero actuator power, so neither an empty reservoir nor a low peak-power state may disable its passive resistance.

Revision 3 evidence: revision 2's exact mode switch produced locked-body flat-water braking Fz=10,103N at t=.875s (`enter`, Hcap187.5N) and Fz=48,495N at .88333s (`hold`, Hcap900N), despite only2.8e-5rad of dip change. This was a specification defect. Smoothing human scalar limits removes it without smoothing force vectors, changing drag direction, or relaxing energy/passivity gates. The .16s time constant is an authored control-response choice. Repeat the full acceptance matrix after this amendment; revision2 speed numbers are provisional historical evidence, not final results.

Uniformly scale ALL four patch force vectors by:

```
scale = min(1, Hcap/max(Hraw,1e-9), Ppeak/max(Praw,1e-9),
            (E/dt)/max(Praw,1e-9))
```

When Praw=0 the power/energy factors are 1, regardless of E; this is essential for passive hold drag. For zero Hraw force factor=1. Accumulate scaled patch forces and moments at their actual centroids. Subtract `dt*scale*Praw` from E, floor only for roundoff ≤1e-8 J. This limits traction rather than applying an unbounded hydrodynamic force behind a decorative animation. Record saturation ratios so calibration can expose sustained overload, rather than silently calling it precise biomechanics.

Power identity per patch: `F dot (vBody - vWater) = -F dot vJoint - D`, where `D=-F dot(vBody+vJoint-vWater)>=0`. Thus propulsion comes from positive actuator work, wave/current energy, or existing body kinetic energy, never from a sign error. Verify this identity directly in tests. Applying force at the wet centroid and adding r cross F ensures rotational work is included. The rowers/oars are treated as massless relative to the existing body inertia, explicitly excluding body-motion/inertial catch effects.

Do not smooth force vectors independently: a lagged force can point with current slip and inject energy. Geometry, continuous joint motion, area clipping and scalar caps provide continuity. Cap corners are continuous though not continuously differentiable. Any later filter must reproject/recheck dissipation.

## 10. Stamina and feedback telemetry

Stamina responds to delivered work and exertion, not merely selected order. Compute each blade's load = positivePower + `60*(handleForce/max(1,Hcap))²` + (rowing ? 15+.6*sideRate : 0) W. Average across 170, then exponentially filter with tau=3 s. Let L be filtered load. Sustainable reference=220 W, reserve=16000 J, recovery divisor=32000 J. `dStamina/dt = (220-L)/16000` for L>220, else `(220-L)/32000`, capped in magnitude to .02/s and clamped to [0,1]. This is an explicit gameplay reserve model, not a physiological prediction. At stamina≤.05 demote RAM→FULL once and set exhausted; forbid new RAM until stamina≥.20; clear exhausted at .30. No energy or rate reset on demotion.

Telemetry required: total signed forward oarThrust, port/starboard thrust, yaw moment, total actual wet area, wet blade count, mechanical positive power, dissipated slip power, filtered crew load, force-cap/power-cap fraction of active blade-steps, missed drive fraction (drive-time blade samples with wetArea<.02*area), and fallback water-query count. These need only be programmatic/debug values; do not add HUD clutter. Mechanical reserve is not the same as ship effective power (thrust*speed).

## 11. Fixed-step/render/event coherence

At fixed-step start t0, copy current to previous. Advance side controllers and evaluate joints for t1=t0+dt. Sample water and assemble forces at t1 using the pre-integration rigid-body pose (same explicit force convention as current hydrostatics). Integrate hull. Refresh current world centers using the integrated hull pose, without reapplying forces; local frame values remain those used for force calculation. Store contact event positions from the actual force evaluation, not the post-step refresh. Document this one-step explicit integration convention so comparisons use the correct body snapshot.

Rendering at alpha uses the same previous/current interval as hull interpolation. Interpolate local joint angles linearly, never phase modulo 1 or world centers from mismatched hull frames; call pure evaluateOar with interpolated angles and interpolate angular velocities for diagnostic output. Use interpolated hull transform for the actual instance matrices. Linear joint interpolation approximates the analytic curve with an O(dt²) error. At alpha 0/1 endpoints must be exact. `Trireme.update` receives alpha and uses `physics.rowing.renderPose`; it has no order/stroke logic. `bladeWorld` and `bladeIn` may remain as compatibility display telemetry but must no longer drive effects or physics.

Use a preallocated event ring with capacity4096, monotonic event IDs, and typed fields `{id, time, bladeId, side, kind, x,y,z, intensity}`. Kinds: catchBeat, enterWater, leaveWater. Physical contact hysteresis: enter when wetArea/area rises above .08; leave when it falls below .02; per-blade event cooldown .06 s. Initialize contact without emitting events on construction/reset. Emit a catchBeat once when a side enters cycle phase0; if both sides catch within .08 s combine at consumption into one drum beat. Never synthesize water splash on catchBeat.

Contact intensity = clamp(sqrt(max(0,dissipatedPatchPowerSum)/250),0,1); entering water can use normal material-relative impact speed as fallback: max(previous intensity,clamp(abs(vn)/3,0,1)) with nonzero wet area. Leave uses last wet intensity*.65. Physical wave wash while resting may emit small real contact sounds/foam, but no drum.

Both foam and audio need independent read cursors; do not let the first consumer destroy events. Consume once per presentation update up to interpolation renderTime=t1-dt+alpha*dt; leave newer events queued. Stamp foam at event x/z, not current moving blade centers. Group audio water events by side and kind in 50 ms bins, sum squared intensities then sqrt and clamp; max one burst per bin per side/kind. If paused, neither consume simulation time nor generate new events. On reset/camera-independent teleport explicitly clear ring and cursors. Ring overflow increments diagnostic and advances stale cursors to oldest retained ID; normal 12-step catch-up must have zero overflows. No pre-scheduled release sounds; preserve drum synthesis and thole sound but trigger them from current cycle events, separating `strokeBeat` from `oarContact` methods in audio.

## 12. Necessary integration with existing water forces

In `physics.ts` hydrostatic buoyancy remains based on existing geometry/height. Replace `(water-waterPrev)/dt` vertical damping correction with actual sampled orbital particle velocity at cp, subtracting all three velocity components before transforming into hull coordinates. Remove waterPrev state. For rudders similarly subtract sampleFlowAt velocity before local transformation; otherwise a moving wave drives rowing and rudders against different reference frames. Leave aerodynamic forces unchanged. `ShipPhysics.speed` is documented currently as through-water but implemented over-ground: correct it to forward projection of vel minus CoG water flow, and use that same quantity for differential rowing. Heading remains unchanged. Remove only the double-counted artificial oar roll damping noted above.

These integration edits are scoped necessities, not a hull-resistance redesign. Do not change longitudinal resistance coefficients to hit a speed target. The 56.6 t modeled mass is retained. Report changed wave damping behavior as an intentional correction; verify whole-ship stability headlessly.

## 13. Calibration contract

Constants above are the starting release candidate. Acceptance speed ranges are deliberately broad because the existing hull is not a measured Olympias drag curve. Run the tests first. If any target fails, inspect geometry, passivity, wet area, power/cap telemetry, and command state before touching constants.

Only the following bounded calibration is authorized within this spec: one global multiplier on Pmean values in [0.85,1.15], one on handle caps in [0.90,1.10], normal drag Cn in [1.6,2.0], and dWet target depth in [.20,.27] m. Search these on a deterministic grid (power multiplier .05 increments, handle .05, Cn .1, depth .01) only if necessary; choose the smallest squared normalized deviation from the original values among candidates satisfying all hard invariants and speed envelopes. No separate forward/reverse/yaw force cheats. Record final selected constants and measured results in `docs/rowing-validation.md`; amend this spec's starting-constant table with chosen values if changed. If no allowed candidate succeeds, stop parameter search and report the unmet gate; do not quietly expand ranges or call the spec fulfilled.

A full exhaustive grid is not required: monotone one-dimensional searches in order power, handle, Cn, depth are preferred, retaining earlier selected values. Validate all acceptance cases on the final candidate. The goal is a responsive heavy vessel with readable load pulses, not restoration of the old exaggerated force trace.

## 14. Offline acceptance matrix

Create `scripts/test-rowing.mjs` using the repository TypeScript compiler's transpilation for an isolated module loader or a checked-in equivalent; avoid adding a framework dependency. Add `npm run test:rowing`. Tests use actual RowingSystem/ShipPhysics, real Three math, deep flat terrain, sail fully furled, zero wind, and controlled wave fixtures. Preserve the lead's temporary original-source harness as external evidence; do not import temporary paths in permanent tests. Assertions below are mandatory except explicitly labeled measured targets.

| Test | Setup and acceptance |
|---|---|
| Layout | Exactly170 unique IDs; bank side counts31/27/27; radii3.22/2.92/2.67 to1e-12; immutable ordering. |
| Mesh/physics identity | For all slots and 21 phases, forward/back/hold/rest, transform actual bank geometry blade center and corners by instance matrix and compare pure geometry: ≤1e-6 m; basis orthonormal/determinant+1 to1e-10. No WebGL needed. |
| Analytic derivatives | Central-difference pure geometry at h=1e-5 s for interior phases/transitions: center and four material-corner velocity error<1e-4 m/s. Include changes in dip and feather. At state boundaries compare one-sided velocities<1e-4 rad/s continuity. |
| Area clipping | Flat plane dry/full/quarter/half/three-quarter blade area across multiple orientations, compare independent polygon/analytic rectangle clipping to1e-7 m². Sum strip areas≤blade area+1e-10. Dry force exactly0. |
| Force sign/passivity | 10,000 deterministic randomized velocities/orientations/wet areas; each scaled patch F·v≤1e-7 W; power identity relative error<1e-9 or absolute<1e-7 W. Zero-wave stationary hold produces zero force. Forward locked-body mid-drive Fz<0; back Fz>0. |
| Human-limit transition continuity | FreshSTOP→hold in flat water on a locked body moving4m/s: adjacent120Hz steps straddling enter→hold differ in total braking force by<5kN (revision2 defect was38.4kN). No scalar state reset on any order/stage/hold toggle; per-step change bounded by full scalar range*(1-exp(-dt/.16))+1e-9. Exercise all modes including zero-effort hold and interrupted enter/exit. With positive-power reservoir emptied, stationary wet hold retains passive drag and zero actuator power. Retest cumulative work using actual filtered replenishment and check hard absolute handle/power bounds. At a transition advanced using h=1e-6s, force difference across the same stationary hold-entry endpoint must be<2N; this verifies absence of a finite jump rather than merely shrinking the120Hz jump. |
| Force/power budget | Per-blade handle≤cap+1e-6N, P≤Ppeak+1e-6W; reservoir in[0,640]±1e-8; cumulative work≤initial reservoir+integral replenishment+1e-5J. Test abrupt order swaps to prevent free refills. |
| Recovery contact | Force on submerged feathered recovery is nonzero at nonzero slip, passive, and lower than squared blade in corresponding horizontal flow; blade entirely above water has exactly0N despite any drive phase. |
| Short waves | Actual24-wave field plus single11m longitudinal wave, amplitude .5m, q=0 then q=.5, phases spanning2pi; independently enumerate all170 wet rectangles. Wet active samples cannot vanish because all center-bank samples happen to be dry. Reversing wave direction changes distributed load/moment, finite results. |
| Plane approximation | Compare approximate area/force against exact strip-center sampling for11m, amp≤.75m and normal sea fixtures: per-blade absolute wet-area error≤.08*area; aggregate thrust relative error≤5% when reference thrust>1kN (else absolute≤50N). If fallback used, compare against exact corner heights, area error≤.05*area. |
| Water velocity | Single frozen-amplitude wave: surface particle velocity matches time derivative of displacement at fixed undisplaced coordinate to1e-5m/s, including sign. At depth1/k per-component amplitude ratio exp(-1) to1e-10. Zero waves exactly zero. Moving point over static sloped surface must not create water vertical velocity. |
| Startup/hold/rest | Fresh stop120s: no rowing beat, no forward acceleration attributable to oars. Space from initial0rate enters hold≤.9s; hold release→stop ends dry≤.9s. Every order→every order at 16 phase offsets: finite continuous pose/velocity and eventual correct mode≤1.5s unless a new command interrupts. |
| Differential steering | Rest+FULL+helm±1 for20s: inner becomes back with nonzero effort≤1.5s, both force signs as commanded in first complete locked-body drive. Free-body yaw sign correct; opposite tests mirrored speed/yaw within2% using symmetric flat setup; no artificial yaw torque. |
| Cadence/frame independence | Feed equivalent input schedules at render30/60/144Hz with120Hz fixed simulation; final body/crew/joints equal≤1e-9 where step counts match. No duplicates/lost event IDs; alpha endpoints match. |
| Speed envelopes | Fromrest120s, stamina active, flatwater; last30s mean: SLOW3.5–6.2kn, HALF5.0–7.5kn, FULL6.0–8.6kn, BACK magnitude2.5–4.8kn. Forward means strictly increasing. These are measured gameplay gates, not archaeological facts. |
| Sprint | Begin rested at convergedFULL; RAM raises best5s mean speed by≥.20kn within30s, stays<10kn, and cannot remain available indefinitely: under continuously wet normal rowing demotes within60–180s. Report actual mean/peak power and stamina trace. If it never uses reserve, calibration fails rather than adding order-only drain. |
| Hold stopping | Start settled flat at4m/s, no sail/wind, command hold: reaches≤.3m/s within60s and sooner than oars-up coast; never reverses faster than.05m/s from hold alone. Planar kinetic energy due to isolated hold-oar work never increases beyond numerical tolerance1e-6 relative. |
| Turning envelope | SettledHALF then fullhelm: reaches90deg heading change within15–90s; stays finite, no reversal of commanded yaw; track180deg time and diameter but do not assert historical one-minute claims. Fromrest fullhelm produces≥15deg within20s. |
| Stamina | Low-load rest raises stamina monotonically; SLOW does not drain fromS=.5; FULL loses<.25 over120s; RAM load exceedsFULL and demotes by above gate; zero-contact rowing cannot spend more mechanical energy than delivered but still incurs motion overhead. |
| Stability |10min actual24-wave wind sea with seeded time-varying order/helm/hold inputs and120Hz: finite position/quaternion/forces, quaternion norm error<1e-8, no event overflow, no invalid areas, absheel<60deg under moderate(default) sea. Extreme synthetic waves only require finiteness and no energy-sign violation, not guaranteed seaworthiness. |
| Numerical convergence | Repeat flatFULL/BACK/hold and single-wave20s at120/240Hz: mean speed differs<3%, integrated oar impulse<5%, contact event count differs≤2 perblade over20s. |
| CPU/allocations | Warm1000 steps; time5000 rowing steps on actual24-component field at120Hz, measure p50/p95 and mean; target mean≤1.5ms,p95≤3ms on this machine. Report host/runtime. Zero new Vector3/Quaternion/Matrix4/Array allocations in rowing step/evaluate/renderPose after construction. Force loops ≤680patches, usual170 inverse queries; record fallback cost separately. Full simulator offline p95<8.33ms is target. No browser/GPU performance claim. |

Speed/stamina/turn targets may reveal a genuine incompatibility with the reduced-order model. Do not weaken invariant tests or silently relabel failed targets as successes. Numerical tests must isolate physical oar work from buoyancy/sail and other forces when testing passivity; total rigid-body energy in waves is not expected to decrease monotonically.

## 15. Integration sequence and definition of done

1. Preserve dirty source; use current contents and narrow edits. Add shared slots, pure kinematics, exact three-bank mesh geometry and math/geometry tests.
2. Implement shared flow sampler, clipping and dissipative traction in rowing module; validate water and energy identities before attaching body forces.
3. Implement controller/state machine, caps/reserve/stamina and offline command-transition tests; ensure initial stop and hold work at zero cadence.
4. Replace old aggregate physics, remove duplicate crew updates, correct flow reference in hull/rudders, remove duplicate oar roll damping. Run isolated and whole-ship tests.
5. Connect interpolated bank meshes; delete independent visual stroke logic. Update contact-driven foam and split beat/contact audio. Preserve unrelated edits in trireme/game/foam/audio.
6. Run `npm run typecheck`, `npm run build`, `npm run test:rowing`; execute final offline matrix and record machine, constants, measured outputs, and any failures. Add a concise mechanism/fidelity note to existing appropriate project documentation if one exists; no unrelated document churn.
7. Deliver implementation and validation file paths. The user subsequently authorized browser screenshots: capture representative forward, backing, hold, transition and wave-contact states and have the spec author review them. Distinguish inspected screenshots from moving-animation/audio validation and GPU timing; a build or headless matrix cannot certify live appearance or sound.

The lead must follow this specification's mechanics, interfaces and invariant gates. Calibration is allowed only as explicitly bounded above. A significant deviation requires an amended spec that states the reason and new acceptance condition; do not replace this design with six-point thrust plus cosmetic animation.
