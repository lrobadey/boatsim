# Merchant crew rowing: technical proposal

Status: consultant proposal, 2026-10-10, for the lead engineer to turn into a spec. The prototype is in this folder (`crewrow.mjs` plus the experiment scripts) and runs inside the real `ShipPhysics` (MERCHANT, 6-DOF, ITTC x 1.82 resistance, real rudders and lateral plane), so every number below comes from the game's own hull. No repo file was modified.

Confidence tags: **[src]** taken from a source, **[meas]** measured in the prototype, **[est]** my estimate or a calibration choice. Treat every [est] as something you can argue with.

---

## 0. Headline

| | Current (4 sweeps, prescribed stroke) | Proposed (6 sweeps, force-balance crew) [meas] |
|---|---|---|
| Full: kn at 30 s / 60 s | 0.5 / 0.9 | **1.15 / 1.81** |
| Full: time to 1 kn | 68 s | **25 s** |
| Full: steady speed | 1.86 kn | **2.46 kn** (115 W per rower, 18 spm) |
| Half / Slow / Back steady | n/a | 2.18 / 1.02 / -1.98 kn |
| Propulsive efficiency, thrust x speed / all positive crew work | 21 % | **38 %** (49 % in the drive alone) |
| Hold water from 2 kn to below 0.2 m/s | n/a | **26.8 m = 1.9 lengths** (target: 5) |
| Pivot from rest, full helm, Full | n/a | 90 deg in 56 s, turning circle about 6 m |
| dt 1/60, 1/120, 1/240 (Full steady) | n/a | 2.450 / 2.458 / 2.461 kn |
| Energy audit (per oar, 240 s) | n/a | closes to below 0.1 J out of 25 kJ |

The 21 % problem has three causes, and fixing the arc only cures the first. (1) The blade speed was scripted, so slip could not adapt to the load. (2) The blade went in at zero speed relative to the hull, which brakes a moving ship: the catch alone cost about 18 % of drive impulse in my first force-balance run. (3) The recovery was rushed, so a lot of work went into reversing a heavy oar. The force balance fixes (1). Two skills that real rowers have fix (2) and (3): a catch that matches blade speed to the water, and a recovery whose duration is limited by hand force. Section 1 covers both.

---

## 1. Oar and rower mechanics (per oar)

### 1.1 Which joints are physics, which are the rower's

| Joint | Driven by | Why |
|---|---|---|
| **Sweep** θ (about the hull's vertical axis at the thole) | **Physics state** (θ, ω), every phase | All the energy flows through it. Stroke speed, slip and rate have to emerge here. |
| **Dip** δ (loom elevation, i.e. blade depth) | **Rower-positioned kinematic track** (quintic or Hermite) | Rowers set blade depth by handle height. The loads are small and the motion is position-controlled. Its actuation work **is charged to the rower** (see below). |
| **Feather** φ | **Rower-positioned kinematic track** | Same reasoning. Squaring finishes before entry; feathering starts once the blade is clear. |

Dip and feather are not free. Each patch's water force is dotted with the dip and feather part of the blade velocity, and `max(0, -F·v_dipfeather)` is added to the rower's positive work, his fatigue input and `telemetry.positivePower`. In the prototype this is 7 % of crew work at Full (about 25 W at the catch and 28 W at extraction, mostly profile drag on the blade edge as it moves fast vertically). Leaving it out would be a hidden energy source.

### 1.2 Equation of motion

Use the generalised force from virtual work, not a "moment": dip couples the axes, and this form is exact for any pose. Blade patch j has wet area A_j, normal n, a position derivative per unit sweep rate **s**_j (from `evaluateOar` with dSweep=1), and a base slip **b**_j = body velocity at the patch - orbital water velocity + dip/feather joint velocity. Then

```
slip_j(ω) = b_j + ω s_j                                  (linear in ω within a step)
F_j(ω)    = bladeDrag(A_j, slip_j(ω), n)                 (existing law, Cn 1.8, Ct 0.025)
Q_w(ω)    = Σ_j F_j(ω) · s_j                             (water generalised force on the sweep)
Q_r(ω)    = rower generalised force (1.3)
I_eff ω̇   = Q_r(ω) + Q_w(ω)
```

**Effective inertia** varies with wetness, so it is a state:

```
I_eff = I_oar + m_refl (r_h cos δ)² + m_a (r_b² + L_b²/12) · wetFraction · cos²φ
```

| Term | Value | Basis |
|---|---|---|
| I_oar | 80 kg m² | [est] 5.6 m fir sweep of about 14.5 kg: loom 1.8 kg/m outboard, 2.9 kg/m inboard, blade 2.7 kg at 3.65 m. A lighter 10 kg oar gives about 55; the sensitivity run with 55 changed Full by +0.03 kn. |
| m_refl | 20 kg at the hands (about 25 kg m²) | [est] Arms plus the part of the trunk that moves with the handle. Body CoM moves about 0.45x handle travel, so 65 x 0.45² ≈ 13 kg, plus arms. |
| m_a | 14.5 kg (about 195 kg m² when fully wet and square) | [est] Half the 2-D flat-plate value ρπ(w/2)²L, reduced for aspect ratio 4.5 and the free surface just above. This is the largest inertia term and the one I am least sure of. |

**Changing inertia without creating energy.** When the blade enters (I rises), the added mass is picked up so that momentum is conserved, `I0 ω0 = I1 ω0'`, and the lost energy is logged as `pickupLoss` (an inelastic collision). When the blade leaves (I falls), ω is kept and `½ΔI ω²` is logged as `shedKE`, energy left in the wake. My first version let I change without doing either, and the audit caught a 0.7 % free-energy leak. With the fix the audit closes exactly (section 6.6).

**Hull coupling.** The hull receives the patch water forces at the patch centroids, as now. The inertial reaction of the oar and the rower's body is internal and zero-mean over a stroke, so I do not apply it (quantified in 5.3).

### 1.3 Rower force law: do not use min(F_max, P_max/v)

Your starting idea, `min(F_max, P_max/v)`, is a poor muscle model. Near v = 0 it is a flat force cap and above that a hyperbola, so a rower working against a stalled blade would deliver peak power at walking pace. Multi-joint pushes and pulls (legs, trunk and arms together) follow an approximately **linear force-velocity relation**, F = F0(1 - v/v0), so power is parabolic with its peak at v0/2 [src: Jaric 2015, *Int J Sports Med*; Samozino et al.]. The drive law is:

```
v_h  = dir · ω · r_h cos δ                         (handle speed along the stroke, r_h = 1.25 m hand centre)
g(θ) = clamp(1 - 0.55 ((θ-θmid)/0.5)², 0.45, 1)    (weaker at full reach and at the finish)  [est]
F_h  = u · S · g(θ) · F0 · (1 - v_h/v0)            v_h ≥ 0 (concentric)
F_h  = u · S · g(θ) · F0 · (1 + 0.5(1 - e^{v_h/0.25}))   v_h < 0 (eccentric, up to 1.5x)  [est, standard muscle ratio]
Q_r  = dir · F_h · r_h cos δ                       dir = -1 ahead, +1 backing; pushing uses 0.85 F0
```

Here u is the rower's activation (0..1, first-order lag with τ 60 ms rising and 90 ms falling) and S is his current strength from fatigue (section 4).

| Rower parameter | Value | Basis |
|---|---|---|
| F0 (isometric two-hand standing pull, braced feet, mid-stroke) | 900 N | [est] Elite sliding-seat peak handle forces are 800-1200 N [src: Kleshnev, rowing biomechanics]. A 65 kg labourer standing with a foot cleat is lower, but his isometric force is well above his rowing peak. |
| v0 (unloaded handle speed) | 2.8 m/s | [est] Ergometer handle peaks are about 2.5-3 m/s. |
| Peak instantaneous power F0·v0/4 | 630 W | [est] Plausible for an untrained 65 kg man. |
| Recovery hand force bound | 220 N | [est] |
| Hold-water capacity | 1.25 x 0.75 x F0 x S ≈ 845 N | [est] Eccentric or isometric. |

**Outside the drive** (recovery, ready, hold, transfer, the catch turnaround, extraction braking) the rower is a **bounded tracking servo** on a planned trajectory:

```
Q_r = clamp(I_eff θ̈_ref + Kp(θ_ref - θ) + Kd(θ̇_ref - ω), ±F_bound r_h cos δ),   ωn = 12 rad/s, ζ = 1
```

This keeps one integrator for every phase, keeps θ and ω continuous across all mode changes, counts every joule the rower puts into the oar (accelerating it in the recovery is real work), and lets a recovering blade that hits a crest be pushed back, because the bound is finite. Nothing is ever pose-snapped.

### 1.4 Integration (stable at 1/60)

Per step: dip and feather are evaluated at t1, and the geometry is frozen at θ* = θ0 + ω0 dt. We then solve backward Euler for ω1:

```
G(ω) = I_eff (ω - ω0')/dt - Q_r(ω) - Q_w(ω) = 0,     θ1 = θ0 + ω1 dt
```

G is **strictly increasing** in ω: drag decreases with ω, the force-velocity relation decreases with v_h, and the servo term is -Kd - Kp·dt. So the root is unique. A safeguarded Newton step with bracketing and a numerical derivative converges in 2-4 iterations, capped at 8. Q_w(ω) is cheap to evaluate exactly, because once the geometry is frozen slip is linear in ω (four patches, three drag evaluations per iteration). Forces applied to the hull use ω1. At 1/60 the water-damping time constant (about 0.03-0.12 s) is no problem for the implicit step [meas: section 6.5]. Cost: the crew system adds about 20 µs per step on top of ShipPhysics (about 41 µs).

### 1.5 One stroke, phase by phase (skilled technique built in)

1. **Ready / catch (0.22 s).** The blade drops from dDry to dWet. The servo runs a cubic Hermite turnaround that ends with ω_m = -v_ship/(r_b cos δ), so **the blade enters already moving with the water** (zero slip at entry). Activation u ramps up, and over the last 40 % of the catch the servo hands over to the force-velocity law (Q = (1-β)·servo + β·FV). This took catch braking from -28 W (18 % of drive impulse) to -2 W.
2. **Drive.** Pure force balance. u = u_plan x taper, where the taper eases force to 25 % over the last 30 % of the arc, so the water slows the blade while it is still giving thrust. The drive ends when θ + |ω|·T_extract/2 reaches θ_finish (anticipation), or on a stall (|ω| < 0.05 for 0.6 s).
3. **Extraction (0.20 s).** The hands stop the loom: a Hermite from (θ, ω) to rest, bounded by F0·S, while the dip lifts the blade out. This keeps the total excursion inside the 0.85 rad reach.
4. **Recovery.** A quintic from rest at the finish to rest at the catch. Its duration is at least `max(0.55 + 0.45·arc, sqrt(5.77·arc·I/(0.8·F_rec·r_h)))`, i.e. the peak acceleration must stay within the hand-force bound. It is retimed at 20 Hz by the phase coupling (section 3). Feathering starts after extraction and squaring is done before entry.
5. **Hold.** Servo to θ_hold = 0.07 with the blade wet and square, bounded by the hold capacity. If the water moment is larger, the oar yields; there is no clamp.
6. **Backing.** The same cycle mirrored (dir = +1), with pushing at 0.85 F0. A **felt rule** applies: if the boat moves against the intended stroke faster than 0.35 m/s (0.5 m/s once rowing), the rower holds water first and backs only once she is checked. Without this rule the back-water order from 2 kn never stopped her, because the blades stalled at full reach.

### 1.6 Stroke numbers (Full, steady, stroke oar) [meas]

| Quantity | Value |
|---|---|
| Rate | 18.2 spm (emergent; period 3.3 s) |
| Drive | 1.2-1.3 s |
| Recovery | 1.6-1.8 s |
| Arc | 0.70-0.85 rad (40-49 deg) |
| Handle travel at the hands | 0.85-1.0 m |
| Handle speed in the drive | 0.55-0.70 m/s |
| Peak handle force | 450-600 N steady (745 N on the 4th-5th stroke from rest) |
| Mean blade force in the drive | about 150 N |
| Blade speed relative to hull at mid-drive | about 2.3 m/s, with slip about 1.0 m/s at 1.27 m/s ship speed |

Power split for the whole crew at Full [meas], in W: drive 536 (of which 239 to the hull and 222 to slip), catch 49 (dip 25), extraction 28 (dip 28), recovery 48 positive and 48 negative.

The gearing is heavy (r_b/r_h = 3.65/1.25 = 2.9), so the hands move slowly and with high force (about 0.6 m/s at 450 N, well below the 1.4 m/s power optimum). That is realistic for a heavy, slow boat. In the prototype the rower compensates with effort u ≈ 0.6-0.8 rather than with rate.

### 1.7 Standing sweep body to handle (for animation and payload)

The rower faces aft, the loom passes outboard of his body, and he pulls ("step and fall back").

- Stroke progress p runs from 0 at the catch (reaching aft) to 1 at the finish. Legs move over p 0-0.5 (pelvis travels 0.45 m toward the bow, knee flexion released), trunk swing over p 0.2-0.85 (from +26 deg leaning aft to -17 deg leaning toward the bow), arms over p 0.6-1. The recovery runs in reverse (arms, then trunk, then legs).
- Feet are planted with the aft foot braced at a cleat. The arc is capped at **0.85 rad** total, which matches the animation rig limit.
- Handle height in the drive (with the tholes raised 0.15 m) is 1.14-1.34 m above deck. That is above the hip, so the trunk can straighten.
- The stroke station's handle sits high (1.34 m), because the sheer rises aft. I recommend lowering that one thole by 0.15 m, so `pinDy` becomes per-station.

---

## 2. Deck layout for six sweeps

Stations alternate sides fore and aft, and the stroke is the aftmost oar, directly in front of the helmsman:

| Station s | Oar side | Pin x, y(WL), z (m) | Deck y | Deck half-width | dip wet/dry (deg) | Handle end: catch / square / finish (x, y above deck, z) |
|---|---|---|---|---|---|---|
| 0.17 (bow) | P | -1.43, 1.39, -4.55 | 0.82 | 1.25 | 26/15 | (-0.20, 1.23, -3.99) / (-0.08, 1.23, -4.55) / (-0.19, 1.23, -5.07) |
| 0.25 | S | 1.75, 1.24, -3.44 | 0.67 | 1.56 | 24/13 | (0.50, 1.17, -2.87) / (0.37, 1.17, -3.44) / (0.48, 1.17, -3.98) |
| 0.33 | P | -1.95, 1.15, -2.34 | 0.58 | 1.77 | 22/12 | (-0.69, 1.14, -1.76) / … / (-0.67, 1.14, -2.88) |
| 0.62 | S | 1.99, 1.26, 1.65 | 0.69 | 1.81 | 24/13 | (0.75, 1.18, 2.22) / … / (0.73, 1.18, 1.12) |
| 0.70 | P | -1.77, 1.43, 2.76 | 0.86 | 1.60 | 27/16 | (-0.56, 1.25, 3.31) / … / (-0.54, 1.25, 2.24) |
| 0.78 (stroke) | S | 1.46, 1.65, 3.86 | 1.08 | 1.29 | 31/20 | (0.29, 1.34, 4.39) / … / (0.28, 1.34, 3.36) |

- **Sweep.** Length 5.6 m, inboard 1.5 m, hands at 1.05-1.45 m, blade 0.9 x 0.2 m at r_b = 3.65 m. Pins sit at hb + 0.02 and sheer + 0.27 (raised 0.15 m). The arc is +0.43 to -0.40 rad (0.83 rad). I kept the blade: a 1.0 x 0.25 blade gives only +0.07 kn at Full (+8 % efficiency) [meas]. Take it if the art allows; the physics does not need it.
- **Stagger.** Port and starboard stations are separated by 0.8-1.1 m in z. Every rower stands within about 0.6 m of the centreline, on the opposite side from his oar's handle end (a port-oar rower stands at x ≈ +0.1 to +0.4). This fits the rig's 0.6 m constraint. Handles cannot collide, because neighbours are on opposite sides and different z. When neighbours are in step, their bodies move fore and aft together. A 100 ms phase error closes about 0.15 m of their 0.8-1.1 m gap.
- **Space per rower.** About 1.4 m (z) x 0.7 m (x): handle travel 0.85-1.0 m plus a 0.35 m body plus clearance.
- **Clearances.**
  - Mast (z -0.83) to the s 0.33 catch handle: 0.93 m.
  - Amphorae at s 0.47-0.53 sit between the groups, and the future hold (s 0.40-0.60) has no oar in it. The s 0.62 rower's finish lean reaches about z 0.8 (s 0.56), at the edge of the hold. Accept that or move the group 0.01 s aft.
  - **Helm.** The stroke's hands at full catch reach z 4.39; the helmsman stands at z 4.96 (s 0.86). That is 0.57 m: tight but workable. The tiller sweep must stay aft of z ≈ 4.6, or the helmsman stands at s 0.88.
- **Helm sight line.** Eye 2.94 m above WL at s 0.86; the stroke's head is 2.76 m at 1.1 m forward. Looking dead ahead over an upright stroke, the helmsman sees water from 18 m ahead (6 m beyond the stem). Because the stroke stands just off the centreline (x ≈ +0.05), a half-step to either side opens a clear corridor. The foredeck rowers are lower (deck 0.6-0.8) and do not block the view.
- **Relief stations.** Fore: beside the mast, x ±1.0, z ≈ -0.8. Aft: x ±1.2 at s 0.55. When the hold opens, use the side decks.

---

## 3. Crew agent architecture

Your three layers are right. I would change three things inside them.

1. **Intent should not output Newtons.** A crew does not think "800 N of surge". The intent layer outputs *normalised* demands X*, N* in [-1, 1], a **power budget per man** (the order's exertion level, which a rower gauges by his own breathing), a target rate, and flags (hold, manned count). The allocator distributes signed shares of that budget.
2. **Lever arms: fore and aft oars do NOT have very different turning leverage.** Thrust acts at the *blade*, about 5.4 m off the centreline for every oar, so the thrust-differential lever is the same fore and aft. The z-lever enters only through the side force of an off-centre arc. For a fore oar, a catch-biased stroke raises its yaw moment from 5.4F to 6.3F, and a finish-biased one lowers it to 4.4F (± 18 %); aft oars are the reverse. So arc placement is a real but secondary allocation variable, `bias_i`, which the prototype implements. The primary yaw tool is still side-to-side differential effort, including backing the inner side.
3. **Do not use continuous Kuramoto oscillators.** A rower's phase *is* his oar's physical state; he is not a free oscillator. The only timing he controls is **when he catches**, which means how long his recovery takes (and, more slowly, his stroke length). Coupling therefore acts on recovery duration, as event-based predictive coupling retimed at 20 Hz. It is mathematically the discrete Kuramoto map (below), but it acts on the right variable and respects body limits.

### 3.1 Layers, rates and data flow

```
120 Hz  physics:        per-oar force balance, activation, fatigue integration, payload points
 20 Hz  rower re-time:  recovery retarget toward the predicted beat (during recovery only)
events  rower decide:   finish → plan next stroke (arc, effort, placement); catch → log beat, update period estimate
 10 Hz  crew intent:    order, helm, hold, ship speed → X*, N*, P*, rate*, yawPriority, manned
 10 Hz  allocation:     X*, N*, fatigue → signed share a_i ∈ [-1,1] and arc bias b_i per oar; watch selection
  1 Hz  rotation:       relief decisions
```

Mode transitions are per-oar state machines evaluated every physics step on the rower's own state (rest → transfer → ready → catch → drive → extract → recover → catch …; hold; shipped). "Decide" events are cheap and deterministic.

### 3.2 Crew intent (order + helm + state)

```
low  = 1 - smoothstep(0.5, 2.0, |v|)                       (oars matter most at low speed)
turn = smoothstep(0.05, 1, |helm|) · sign(helm)
X*   = order.dir · (1 - 0.6 |turn| · low)                  (hard over at rest: give up way for the pivot)
N*   = turn · (0.35 + 0.65 low)
P*   = order.P,  rate* = order.rate,  yawPriority = 0.4 + 0.6 low
Oars Up → no rowing whatever the helm                      (a pivot is a manoeuvre intent, not Oars Up)
```

**Manoeuvre intents** (Turn 180 and others) slot in here as objects that output the same tuple over time, from a small state machine on heading error and speed. Example: "turn 180 to port" means X* = 0 and N* = -1 until 150 deg have been turned, then easing N* toward 0 to arrive at 180, then handing back to the order. Nothing below this layer changes.

### 3.3 Allocation ("knowing what the others do")

Minimise over a_i ∈ [-1, 1]:

```
J = wx (Σa_i/6 - X*)² + wn (Σ(-side_i)a_i/6 - N*)² + Σ c_i a_i²
c_i = 0.02 + 0.25 (1 - W'_i/W'max) + 0.2 (1 - R_i)       (tired men are spared; an absent rower costs 1e3)
wx = 1, wn = 3 · yawPriority
```

This is solved by projected gradient with step 0.9/L (L = Lipschitz bound), 80 iterations, fixed order, so it is deterministic. Then:

- **Arc bias** b_i = foreSign · (-side_i · sign(a_i) · N*) · smoothstep(0.2, 0.8, |N*|). Fore oars reach forward and aft oars finish long when their side must turn harder.
- **Watches.** When the order mans fewer than 6 oars (Slow = 2), the same men stay on (hysteresis), one per side, nearest amidships first. A side's man is swapped only when his cost exceeds an idle man's by 0.15.
- A rower's power target is P_i = |a_i| · P*, and his direction is sign(a_i). If |a_i| < 0.12 he rests his oar.

Results [meas]: full helm from rest gives outer side +1.00 and inner side -0.79 (a pivot). Full helm at 2.3 kn gives the same split; the crew sheds way and tightens the turn.

### 3.4 Individual execution: perception, planning, coupling

**What a rower perceives** (and nothing else):

| Channel | Content | Latency / weight |
|---|---|---|
| Proprioception | Own oar angle and rate, own handle force, own drive time, own work per cycle | Immediate |
| Interoception | Own exertion (W' balance) and long-term tiredness (R), as "S" | Immediate |
| Feel of the water | Ship speed through water, filtered with τ 2 s, used for the catch speed match and the check-before-backing rule | Immediate (filtered) |
| Sight | Catches of rowers **aft** of him (he faces aft); the stroke is the most salient; the stroke sees the helmsman | 0.15 s delay; weight 1.0 for the stroke, 0.5 for others in view |
| Hearing | Catches of everyone (blade entry, thole knock) | 0.15 s delay; weight 0.15 (0.3 for the stroke heard from behind) |
| Orders | Helmsman's order, helm, hold water | Via the blackboard |

He does **not** perceive other men's forces, fatigue numbers or plans. He sees fatigue only indirectly, through shortened strokes, and in the allocation through the common-knowledge fatigue cost below.

**Blackboard (shared crew state, all common knowledge in a drilled crew):** current intent tuple; per-oar allocation share and arc bias; assignments (who is on which oar, who is waiting, the pending handover); role table (stroke = aftmost manned oar; leadership passes forward if the stroke is relieved or rested); a log of catch events with timestamps (each rower reads only what he could see or hear, after the delay); fatigue cost per man (visible effort cues, used only by the allocator and rotation).

**Per-stroke plan (at each finish):**

```
T     = stroke: 60/rate* · (1 + bias_i + wander(t));   others: T_strokeObserved · (1 + bias_i)
arc  ← clamp(arc · (T_d*/T_d,last)^0.6, 0.30, 0.85·(0.8+0.2 S)),   T_d* = 0.5 T
       then shrink 4 % at a time until  T_d(arc) + T_rec,min(arc) + T_catch + T_extract ≤ 0.97 T   (stay in the beat)
u    ← clamp(u · clamp(sqrt(P_i / P_cycle,last), 0.8, 1.25), 0.12, min(1, S))
θ_c, θ_f = θmid + 0.12 b_i ± arc/2, kept inside [-0.40, +0.43]
```

From rest this gives the behaviour you asked for, purely from felt drive time [meas, Full from rest, stroke oar]:

| Stroke | 1 | 2 | 3 | 4 | 6 | 9 | 13 | 17 |
|---|---|---|---|---|---|---|---|---|
| Speed (kn) | 0.13 | 0.23 | 0.35 | 0.49 | 0.78 | 1.12 | 1.47 | 1.74 |
| Arc (deg) | 23 | 26 | 29 | 31 | 32 | 34 | 37 | 40 |
| Drive time (s) | 1.73 | 1.35 | 1.32 | 1.30 | 1.34 | 1.29 | 1.28 | 1.26 |
| Effort u | 0.69 | 0.86 | 1.00 | 1.00 | 0.91 | 0.82 | 0.83 | 0.79 |
| Peak handle force (N) | 440 | 538 | 655 | 746 | 710 | 601 | 590 | 551 |

**Phase coupling (the discrete Kuramoto map on catch times):**

```
t_nat  = own last catch + T_i
pred_j = j's last catch + j's observed period, wrapped to the beat nearest t_nat (only if seen or heard)
t_ref  = Σ w_ij pred_j / Σ w_ij
t*     = t_nat + K (t_ref - t_nat) + jitter_i(stroke#)        K = 0.7 followers, 0.1 stroke
recovery duration = clamp(t* - now, T_rec,min, 3.2 s), re-aimed every 0.05 s
```

For a follower who sees the stroke, the error left after each stroke is (1-K) = 30 %. A personal rate bias β_i (±2 %) settles to an offset of about β_i·T/K ≈ ±90 ms. Jitter is ±35 ms per stroke, from a deterministic hash. The stroke's own rate wanders by ±1.2 % (two incommensurate sines, periods 57 s and 134 s). The organic look comes from these sources, all deterministic and explainable: reaction lag on the first stroke, individual bias, jitter, and the crew lagging when the stroke quickens and the minimum recovery binds.

**Rhythm result [meas, Full from rest; offsets of the 5 followers' catches from the stroke's, in ms]:**

| Stroke # | t (s) | Mean lag | Spread (sd) | Max | Offsets |
|---|---|---|---|---|---|
| 0 | 2.8 | +202 | 8 | 208 | 192 208 192 208 208 (reaction to his first catch) |
| 1 | 6.2 | +92 | 29 | 142 | 142 75 108 67 67 |
| 3 | 12.8 | +40 | 28 | 75 | 42 58 75 33 -8 |
| 7 | 26.0 | +48 | 17 | 67 | |
| 11 | 39.1 | -2 | 24 | 42 | 8 33 0 -8 -42 (settled) |
| 15 | 52.4 | -68 | 11 | 83 | crew a touch early as the stroke eases |
| 19 | 65.7 | -5 | 17 | 25 | |
| 24 | 82.2 | +113 | 26 | 142 | stroke quickens, the crew trails |
| 30 | 101.6 | +12 | 22 | 50 | re-settled |

With **no coupling** (K = 0) the spread grows steadily: 8, 48, 131, 243, 440, 619 then 900 ms by stroke 30, and the crew falls apart. Strong coupling (K = 0.9) gives a 15-20 ms spread with the same group drift. Full table: `results.json → rhythm`.

### 3.5 Determinism

The prototype has no `Math.random`. All variation comes from `hash(handId, strokeCount)` and time-based sines. It uses fixed iteration orders, an iteration-capped Newton, and allocation with a fixed iteration count. Two identical runs give bit-identical hull pose and oar angles [meas]. Required in the spec: no floating-point-order-dependent containers (Map iteration is fine; avoid `Set` of floats), and the same fixed dt for decisions (decision clocks advance by exact sums of dt).

### 3.6 How mistakes plug in later

Mistakes are **perturbations of a rower's motor plan**, never of the physics:

- **Crab.** The dip track at extraction is late or too deep. The blade is then still wet and square while the boat runs on; the water torque exceeds the hand force bound, the servo yields, and the loom drives into the rower. All of this is physical; you only add a "lost the handle" state and a recovery behaviour.
- **Missed water.** The dip target is too shallow, giving partial wetness. The force falls by itself.
- **Rushing or lagging.** A larger jitter, or a lower K under fatigue.

Implement this as a `Skill` record per hand (`timingSd`, `depthSd`, `K`, `reaction`, `catchMatch`, `taper`) feeding the planner. Today's values are the "skilled" preset.

---

## 4. Rotation and fatigue

### 4.1 Physiology (per hand) [est, structure from sources]

- **Short term: the W′-balance critical-power model** [src: Monod & Scherrer; Skiba et al. 2012/2015]. Parameters: CP = 100 W mechanical (±8 % per man), W′ = 14 kJ. Below CP, W′ recovers at rate (CP - P)(W′0 - W′)/W′0. It is driven by **stroke-averaged** power (τ 8 s). Using instantaneous drive power drains W′ even below CP, a mistake I made and fixed.
- **Long term: an endurance reserve R** (glycogen and general tiredness). dR/dt = -(P/CP)^2.5/9000 s, plus recovery (1-R)/5400 s when resting. At Half (80 W) R falls 1 → 0.6 in 90 min; it reaches empty after about 4 h.
- **Available strength** S = strength_i · (0.6 + 0.4·sqrt(W′/W′0)) · (0.65 + 0.35 R). S caps the rower's effort u and the hold force.
- **Fatigue input** = positive mechanical work, plus 25 % of negative work, plus an isometric cost of 0.04 W/N of handle force (hold water at full weight, recovery and drive at 30 %).
- **CP 100 W is a deliberate choice.** It makes Half (80 W) sustainable for hours and Full (115 W) a 20-25 minute effort before reliefs matter. That fits a fit labourer [src: Wilson, *Bicycling Science*: about 75 W for 8 h, 100-150 W for an hour for healthy non-athletes].

### 4.2 When to swap

Checked at 1 Hz:

- **Trigger:** the most fatigued rowing man (score = (1 - W′/W′0) + 0.5(1 - R)) has W′ < 35 %, or a waiting man is fresher by more than 0.15 in R and the rower has been on for at least 10 min. The waiting man must have W′ ≥ 80 %.
- **Never** during hold water, Oars Up, or a turn (|N*| > 0.3). Only one handover is in progress at a time, at least 20 s apart, so a side is never short. Turn intents raise the threshold. Rotation also has to respect watch assignments.

### 4.3 Choreography: two figures on one loom, for one stroke

Answer to the animation specialist: **an unattended sweep cannot go 0.5 s.** The oar's CoM is about 1.2 m outboard of the thole: 14.5 kg x 9.81 x 1.2 ≈ 170 N m of gravity torque on the dip axis against roughly 80 kg m². The blade drops about 0.27 rad, roughly 1 m at the blade, in 0.5 s. It would hit the water on the recovery, and with way on it would trail and slam the loom into the next man.

Sequence, in which thrust never drops [meas]:

1. The relief walks to the station's free side (the side opposite that oar, outboard of the rower). He moves along a slalom through alternating free halves of the deck, at 0.8 m/s with a path factor of 1.3; walks take 4-8 s.
2. He places his hands on the loom **inboard** of the rower's, at about r = 0.85-1.0 m, during a recovery. From the **next catch** he is the driving rower, and the outgoing man's hands follow passively. His mass is added to I_eff for that one stroke.
3. At that stroke's finish the outgoing man lets go and steps out during the recovery, aft-outboard, then walks to the relief spot.

Speed dip per handover: worst -0.4 %, mean -0.14 % (7 hands, Full).

### 4.4 One relief versus two (90 min, calm) [meas]

| | 10 min | 30 min | 60 min | 90 min | Swaps | Min W′ at 90 min | Min R |
|---|---|---|---|---|---|---|---|
| Full, 6 hands | 2.42 kn | 2.28 | 2.22 | **2.17** | 0 | 2.5 kJ | 0.47 |
| Full, 7 hands | 2.42 | 2.35 | 2.30 | **2.25** | 21 | 4.7 | 0.49 |
| Full, 8 hands | 2.42 | 2.36 | 2.32 | **2.31** | 23 | 3.9 | 0.49 |
| Half, 6 / 7 / 8 hands | 2.20 | 2.18 | 2.16 | 2.14 / 2.14 / 2.15 | 0 / 2 / 4 | 14 | 0.61 / 0.66 / 0.69 |

- **At Full**, one relief buys about +0.08 kn after an hour and two buy about +0.14. The second relief helps mainly because each group (fore and aft) gets its own, so nobody has to walk the 6-8 m through the waist.
- **At Half** reliefs barely matter over 90 min; they would over a 4-6 h day, through R. My recommendation is **8 hands (two reliefs, one per group)**. A 7th hand is acceptable but does worse fore-aft walking.

---

## 5. Crew weight

### 5.1 Mass

**65 kg per man, including clothing and kit.** Ancient Mediterranean adult males averaged about 1.62-1.70 m [src: J. L. Angel's skeletal series for Greece, Classical to Hellenistic; I would re-check the exact figures before quoting them]. A working man with a BMI of 22-23 at that height weighs 60-66 kg. Total: 6 rowers + 2 reliefs + helmsman = **585 kg**, 3.3 % of 17.7 t.

### 5.2 Effects [meas, ShipPhysics with payload points]

| Effect | Value |
|---|---|
| Sinkage | 1.74 cm |
| Trim | +0.05 deg by the stern (crew centroid slightly aft, the helmsman at z 4.96) |
| A relief walking 6 m forward | moves trim 0.06 deg |
| Full steady speed | 2.483 kn with the crew aboard vs 2.496 kn without (-0.5 %) |
| Acceleration | -3.3 % (linear mass) |
| Resistance | the model's column wetted area barely changes. A real hull would take about +2.2 % (S ∝ Δ^2/3, so -0.7 % speed). If you want that, scale wettedFactor by (Δ/Δ0)^{2/3}. |

Implement the crew as **live payload points** (one per hand) at body-CoM positions, updated every physics step from the body-pose model (cheap). Walkers interpolate along their path.

### 5.3 Body-motion momentum coupling: do not model it

- Each rower's CoM moves about 0.6 m peak to peak in the stroke (A ≈ 0.3 m). At 18 spm (ω = 1.9 rad/s), with all six in phase (390 kg), the internal force is about 390 x 0.3 x 1.9² ≈ 420 N amplitude.
- Hull surge-velocity oscillation: F/(Mω) ≈ 0.012 m/s (0.02 kn, 1 % of speed). Surge displacement: 6 mm. Mean speed effect through drag non-linearity: of order (δv/v)²/2 ≈ 4e-5.
- In a racing shell the crew is about 80 % of the moving mass; here it is 3 %.
- **Conclusion:** invisible and irrelevant to speed or energy. Keep payload points for weight and trim, and keep the oar and body inertial reaction internal. If someone insists, applying the reaction -Σm·a_rel at the feet is one line, needs the same payload data, and should be audited as an internal force (zero work over a cycle).

---

## 6. Prototype results [meas]

Setup: real `ShipPhysics(MERCHANT)` in calm water; the existing rowing seam is replaced by `CrewRowing`; crew payload on; 240 s runs, steady value = mean of the last 60 s. Resistance check by towing at constant force: R ≈ 130 v² at 0.9 m/s and ≈ 119 v² at 1.3 m/s (`tow.json`).

### 6.1 Orders (dt 1/120)

| Order | Oars manned | Power per active man (target) | kn at 30 s | kn at 60 s | Time to 1 kn | Steady kn | Thrust | Efficiency | spm (emergent) | Mean arc |
|---|---|---|---|---|---|---|---|---|---|---|
| Slow | 2 (one per side) | 45 W | 0.31 | 0.51 | 196 s | **1.02** | 52 N | 0.30 | 13.9 | 30 deg (rowing pair about 40) |
| Half | 6 | 80 W | 1.00 | 1.54 | 28.5 s | **2.18** | 159 N | 0.38 | 16.3 | 45 deg |
| Full | 6 | 115 W | 1.15 | 1.81 | 24.9 s | **2.46** | 191 N | 0.38 | 18.2 | 40 deg |
| Back | 6 | 80 W | -1.00 | -1.49 | — | **-1.98** | -180 N | 0.39 | 15.3 | 47 deg |

**Sanity check against Kyrenia II.** With 4 oars manned the model gives 1.46 / 1.68 / 1.91 kn at 45 / 60 / 80 W per man. So the reported "typically 1.8 kn with 4" corresponds to about 70 W per man, a plausible sustained cruise. The hull, oar and human numbers are mutually consistent with the one datum we have.

**Recommended per-order targets:**

| Order | Spec |
|---|---|
| Slow | 2 oars manned (a watch), 45 W, 14 spm, about 1 kn, sustainable indefinitely |
| Half | 6 oars, 80 W, 16 spm, about 2.2 kn, sustainable for hours |
| **Full** | 6 oars, **115 W, 18 spm, about 2.45 kn**: hard; W′ runs low after about 25 min; with two reliefs she holds 2.3 kn for 90 min |
| Back | 6 oars, 80 W, 15 spm, about 2 kn astern |

**What Full should be: 115 W per man**, which gives 2.45 kn, inside your 1.5-2.5 band. A Full of 150 W would give about 2.7 kn but would be anaerobic within minutes (W′ gone in about 5 min), so it does not suit an order the player leaves on. If you want a sprint, that is a separate, time-limited order. Rates are targets: the actual rate emerges and lands within about 0.3 spm of target because the planner shortens the arc to keep the beat.

### 6.2 Stopping from 2 kn (to below 0.2 m/s)

| Method | Distance | Time | Peak brake | Peak handle force |
|---|---|---|---|---|
| Coast | over 188 m (still above 0.2 m/s at 400 s) | — | — | — |
| **Hold water** | **26.8 m (1.9 lengths)** | 65 s | 949 N | 473 N (capacity 845 N, never reached) |
| Back water (check, then back) | 19.6 m (1.4 lengths) | 37 s | 972 N | 498 N |

### 6.3 Turning, full helm, Full ordered

| Case | Heading after 30 s / 60 s | Steady yaw rate | Speed in the turn | Turning circle | Time to 90 deg |
|---|---|---|---|---|---|
| Underway (2.3 kn), crew assist | 37 / 65 deg | 0.92 deg/s | 0.75 kn | 48 m | 87 s |
| From rest, crew assist | 47 / 96 deg | 1.63 deg/s | 0.16 kn | 6 m (a pivot) | 56 s |
| Underway, rudder only (symmetric rowing) | 23 / 42 deg | 0.58 deg/s | 1.5 kn | 153 m | — |
| From rest, rudder only | 5 / 18 deg | 0.55 deg/s | 1.45 kn | 155 m | — |

Turning is sluggish. A 180 deg pivot takes about 2 min, set by the hull's yaw damping (`angularDamp` 0.6 x mass, plus the lateral plane) against about 1.5-3 kN·m of oar moment. If the turn rate is a gameplay concern, `angularDamp` (a hull calibration) is the lever, not the oars.

### 6.4 Rhythm

See 3.4. It settles from a 200 ms ragged start to a 15-30 ms spread within about 3 strokes and within ±50 ms mean lag by stroke 10, with deterministic drift episodes of ±70-110 ms as the stroke's rate wanders. Without coupling it falls apart (spread 900 ms by stroke 30).

### 6.5 Timestep independence

| | dt 1/60 | 1/120 | 1/240 |
|---|---|---|---|
| Full: kn at 30 s / 60 s | 1.15 / 1.81 | 1.15 / 1.81 | 1.15 / 1.81 |
| Full steady (kn) | 2.450 | 2.458 | 2.461 |
| Full efficiency | 0.383 | 0.383 | 0.385 |
| Half steady (kn) | 2.173 | 2.180 | 2.183 |

The remaining 0.4 % spread comes from mode changes landing on step boundaries. Fix it with sub-step event times if it matters.

### 6.6 Energy audit (Full, 240 s, per oar, J)

Example oar: rower positive work 25,690, negative 5,508; water on the sweep -18,969; hull work 9,840; slip loss 12,931; dip/feather work -3,801; numerical (backward-Euler) loss 286; added mass shed 768; pickup loss 157.

- **Oar balance:** pos - neg + water - ΔKE - numLoss - shed - pickup = **0.0 J** for all six oars.
- **Patch power identity:** hull + water + dip + slip = **0.0 J**.
- **No force is scaled or clipped anywhere.** Every limit is a rower force law or bound, and the water force is always the unmodified drag at the solved ω.
- **Determinism:** two runs are bit-identical.

---

## 7. Integration plan

### 7.1 One interface, two implementations

```ts
// src/ship/oarPropulsion.ts
export interface OarPropulsion {
  readonly slots: readonly OarSlot[];
  readonly previous: BladeFrame; readonly current: BladeFrame;   // joint[6n], forceWorld, wetArea, handleForce, positivePower, contact …
  readonly events: RowEventRing;                                   // catchBeat (stroke's catch), enterWater, leaveWater
  readonly telemetry: RowTelemetry;                                // same keys as today (oarThrust, portThrust, …, crewLoad, …)
  step(dt: number, time: number, body: RowBody, helm: number, waves: WaveField, forceOut: Vector3, torqueOut: Vector3): void;
  reset(body: RowBody, time: number): void;
  refreshWorld(body: RowBody): void;
  renderPose(index: number, alpha: number, out: OarKinematics): void;
  readonly crewView?: CrewView;                                    // only the crew system: animation data contract (7.3)
}
```

- `RowingSystem` (trireme) implements it unchanged. Only `implements OarPropulsion` is added, and `sides` stays as a trireme-only extra.
- `ShipDesign.oars` gains `system: 'banks' | 'crew'` plus a `crew?: CrewRowingParams` block (stations, sweep, rower, orders table, hands). `ShipPhysics` picks the implementation through a factory: `this.rowing = design.oars.system === 'crew' ? new CrewRowing(crew, design.oars, this.payload) : new RowingSystem(crew, design.oars)`. Change the type of `rowing` to `OarPropulsion`.
- **Reused unchanged from rowing.ts:** `evaluateOar`, `createKinematics`, `BladeClipper`, `bladeDrag`, `nominalDip`, `BladeFrame`, `RowEventRing`, `ROWING_CONSTANTS`. The prototype imports exactly these. No change to their behaviour means the trireme tests cannot break.

### 7.2 New files

| File | Contents |
|---|---|
| `src/ship/crew/crewRowing.ts` | `CrewRowing implements OarPropulsion`: step loop, frames, events, telemetry, payload |
| `src/ship/crew/sweepDynamics.ts` | Patch linearisation, Q_w(ω), implicit Newton solve, added-mass pickup/shed, audit accumulators |
| `src/ship/crew/rowerBody.ts` | Force-velocity law, activation, servo, body-pose mapping (for the view and payload) |
| `src/ship/crew/physiology.ts` | `Hand`: W′-balance, R, S, traits |
| `src/ship/crew/stroke.ts` | Per-oar mode machine, stroke planner, catch/extraction/recovery trajectories |
| `src/ship/crew/coupling.ts` | Perception filter (visibility graph, delays), predicted-beat coupling, retiming |
| `src/ship/crew/intent.ts` | Order/helm → intent tuple; `Manoeuvre` interface (Turn180 later) |
| `src/ship/crew/allocation.ts` | Projected-gradient allocator, arc bias, watches |
| `src/ship/crew/rotation.ts` | Relief logic, walking paths, handover |
| `src/ship/crew/crewView.ts` | Animation data contract |

### 7.3 Animation data contract (`crewView`, read at render alpha)

**Per oar:**
- The joint state is already in `previous/current.joint`. Use `renderPose(i, α)` as today, **including shipping**: shipping becomes a physics mode `shipped`, a servo to sweep -1.48 / dip 0.04 / feather π/2 with the blade dry, replacing the visual-only `oarStow` in merchantModel. Animation and physics then agree.
- `handleForce`, `contact`, `forceWorld` are in the frames.

**Per hand, double-buffered like the frames:**

```ts
interface HandView {
  id: number; state: 'rowing'|'handover-in'|'handover-out'|'walking'|'waiting'|'leaving';
  oar: number | -1;
  phase: number;            // 0..1 since own last catch, by own period
  subPhase: 'ready'|'catch'|'drive'|'extract'|'recover'|'hold'|'rest'|'transfer'|'shipped';
  progress: number;         // 0 catch reach … 1 finish (body sequencing driver)
  effort: number;           // activation u (0..1)
  exertion: number;         // 1 - S  (breathing / visible strain)
  handOuter: Vec3; handInner: Vec3;   // ship-local grip targets on the loom (r 1.45 / 1.05; relief at 0.85-1.0 during handover)
  feet: { aft: Vec3; fwd: Vec3 };     // planted while rowing; footstep targets while walking
  pelvis: Vec3; trunkPitch: number;   // from the sequencing model (1.7); IK may refine
  gaze: { kind: 'stroke'|'helmsman'|'blade'|'path'|'oar', target: Vec3 };
  walk?: { from: Vec3; to: Vec3; t: number; T: number; waypoints: Vec3[] };
}
```

Gaze rules: followers watch the stroke's back or the man in front; the stroke watches the helmsman; walkers watch their path; at the catch, a glance to the blade.

### 7.4 What the consumers need, and what is preserved

| Consumer | Uses today | Crew system provides |
|---|---|---|
| ShipPhysics | `step`, `reset`, `refreshWorld`, `telemetry.oarThrust` | The same. Plus payload entries owned by the crew system, mutated in place. |
| merchantModel.ts | `slots`, `renderPose`, `previous/current.forceWorld`, `current.contact` | The same. Six slots instead of four: the geometry builds one instance per slot. Remove `oarStow` and read the `shipped` mode instead. Add rower figures from `crewView`. |
| oarWater.ts / foam.ts | `slots`, `current.contact`, `current.forceWorld`, `events` with independent cursors | The same, with the same event semantics. |
| audio.ts | `events`: catchBeat → drum (disabled for the merchant), contact bins | catchBeat on the stroke's catch only (drum off via `drum: false`); contact events per blade |
| hud.ts / crew facade | `crew.order`, `orderIndex`, `rate`, `stamina`, `holdWater`, `setOrder`, `maxOrder` | `rate` = stroke's emergent rate; `phase` = stroke's phase; `stamina` = mean over the crew of (W′/W′0)·(0.5 + 0.5R); `readiness` from modes |
| main.ts debug | `rowing.sides` | Trireme-only. Guard it, or give the crew system a `sides`-shaped summary. |

**scripts/test-rowing.mjs** builds `ShipPhysics` with the default TRIREME, so every test there exercises `RowingSystem` and must keep passing untouched. The constraints it implies for us: (a) do not change the shared helpers' signatures or numbers; (b) keep `BladeFrame` field layout (6 joint values per oar) and the `RowEventRing` semantics (cursor epochs, no events on construction or reset, overflow accounting); (c) `ShipPhysics.step` must call propulsion exactly once before integration and `refreshWorld` after it. The merchant-specific script `measure-merchant-rowing.mjs` changes meaning (its sweep overrides stop applying) and should be rewritten from `orders.mjs`.

---

## 8. Acceptance tests (offline, `scripts/test-crew-rowing.mjs`)

1. **Energy audit:** per oar over 240 s at every order, |pos - neg + water - ΔKE - numLoss - shed - pickup| < 1e-3 of positive work. Patch identity: hull + water(sweep) + dip + slip = 0 within 1e-6 relative.
2. **No hidden clipping:** water forces applied to the hull equal `bladeDrag(slip(ω1))` exactly. There is no scalar scale anywhere; grep-level assertion plus a numerical re-evaluation at random steps.
3. **Passivity:** for every patch and step, F·slip ≤ 0. A held blade at rest does zero rower work.
4. **Joint continuity:** θ, ω continuous at every mode boundary (|Δθ| ≤ ω·dt + 1e-9; |Δω| ≤ (|Q|max/I_min)·dt); dip and feather are C1. Over 10 min of mixed orders, helm and hold: θ in [-0.47, 0.50], dip in [-0.3, 1.2], feather in [-0.15, π/2 + 0.15]. Peak-to-peak arc ≤ 0.85 rad + 0.02.
5. **Timestep independence:** Full and Half steady speed within 0.5 % across dt 1/60, 1/120, 1/240; kn at 60 s within 0.02 kn.
6. **Speed bands (calm, 240 s):** Slow 0.9-1.2, Half 2.0-2.3, Full 2.3-2.6, Back -1.8 to -2.2 kn. Full: at least 1.0 kn by 30 s and at least 1.6 kn by 60 s; time to 1 kn ≤ 30 s.
7. **Efficiency:** Full and Half thrust·v / crew positive work ≥ 0.35 (catches the stroke-technique regressions).
8. **Stopping:** hold water from 2 kn to below 0.2 m/s within 5 lengths (measured 1.9). Peak handle force ≤ hold capacity, or yield is observed and logged.
9. **Turning:** from rest, full helm at Full: at least 70 deg in 60 s and |v| < 0.5 kn. Underway: crew assist gives at least 1.5x the rudder-only yaw rate. Oars Up plus helm gives no rowing.
10. **Rhythm:** Full from rest: spread ≤ 60 ms by stroke 5, and median spread ≤ 35 ms over strokes 10-35. The no-coupling control diverges (spread > 300 ms by stroke 15), which proves the coupling does the work. Followers' first catch lags the stroke by their reaction time ± 20 ms.
11. **Startup adaptation:** the first stroke's arc ≤ 30 deg and grows monotonically (±2 deg) to at least 38 deg by stroke 17. Peak handle force is highest within strokes 3-6.
12. **Rotation:** at Full with 8 hands for 60 min, at least 1 swap; no swap during |N*| > 0.3, hold or Oars Up; never two handovers within 20 s; per-handover speed dip ≤ 1 %; an oar is never without hands (each oar's handle has at least one hand every step).
13. **Determinism:** two runs with the same inputs are bit-identical (pose, joints, the catch log).
14. **Payload:** 9 x 65 kg lowers the CG by 1.7 ± 0.3 cm and changes Full speed by under 1 %; walking moves trim smoothly (no step change above 0.01 deg per step).
15. **Waves (adversarial, from the trireme suite):** a single 0.5 m swell, orders cycled: all finite, wet area ≤ blade area, misses produce zero force, the event ring never overflows, the recovery servo never exceeds its bound by more than 1e-6.
16. **CPU:** crew propulsion ≤ 0.1 ms mean per step (prototype: about 20 µs measured on this machine, ShipPhysics itself about 41 µs).

---

## 9. Open questions and honest uncertainties

1. **Added mass m_a (14.5 kg).** It is the largest inertia term, but my estimate could be off by 2x either way. It shapes catch dynamics more than speed (shed and pickup are only 4 % of work). A towing-tank figure for a partly submerged narrow blade would settle it.
2. **Rower force-velocity numbers (F0 900 N, v0 2.8 m/s) and CP 100 W** are estimates for a 65 kg labourer working standing. Speed scales roughly with P^(1/3), so ±20 % power is ±6 % speed. Fatigue timescales scale directly with CP and W′.
3. **Do you accept Full = 2.45 kn at 115 W**, and Slow = 2 oars manned rather than 6 oars paddling at about 8 W each (6 men cannot row a 1 kn Slow at any meaningful effort)?
4. **Facing aft (pulling) versus forward (pushing, Venetian style)** for ancient standing sweeps. I chose pulling: stronger, and the stroke can watch the helmsman. Pushing would invert the visibility graph (rowers would see the men *forward* of them, and the stroke would be the bow man). The architecture supports either.
5. **Turning is slow** (a 2 min pivot), and the cause is hull yaw damping, not the oars. Do you want `angularDamp` reviewed?
6. **Stroke-to-helm clearance of 0.57 m.** Do you accept it, or move the helmsman to s 0.88 and shorten the stroke's catch reach?
