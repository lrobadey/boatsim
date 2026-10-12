# Merchant crew rowing: spec

Revision 1 (draft for review), 2026-10-10. Merchant ship only; the trireme keeps `RowingSystem` unchanged.

Sources behind this spec:

- `docs/merchant-crew/physics-prototype/`: the physics and crew-AI prototype. It runs inside the real
  `ShipPhysics(MERCHANT)` and swaps in its own propulsion at runtime. `proposal.md` there has the full
  derivations; `results.json` has every measured number quoted below.
- `docs/merchant-crew/animation-poc/`: the rig and IK proof of concept (`fig_rower.glb`, the solver in
  `node/rowerIK.mjs`, the test harness in `node/sim.mjs`, and pose sheets for the reduced and full arcs).
- `docs/rowing-spec.md`: the trireme rowing spec. Its shared helpers (`evaluateOar`, `BladeClipper`,
  `bladeDrag`, `BladeFrame`, `RowEventRing`) are reused unchanged.
- `scripts/measure-merchant-rowing.mjs`: the measurement of today's merchant rowing that started this.

Tags: **[meas]** measured in the prototype on the game's hull; **[est]** an estimate or calibration choice;
**[new]** added in this spec and not yet prototyped.

---

## 0. Summary

### 0.1 The problem

Today the merchant reuses the trireme's scripted stroke: a 75° arc and a fixed drive time. The blade tears
back at about 3.6 m/s while the ship barely moves, and the force is then clipped to what the crew can supply.
The result:

| | Today |
|---|---|
| Full: speed at 30 s / 60 s | 0.5 / 0.9 kn |
| Full: time to 1 kn | 68 s |
| Full: top speed | 1.86 kn |
| Propulsive efficiency | 21 % |

### 0.2 The change

Six sweeps, three per side, each worked by a standing rower who is an individual agent:

- **Real physics per oar.** Stroke speed comes from a force balance between the rower's muscles and the water
  on the blade. Nothing is scripted or clipped.
- **Skilled technique.** The blade enters already moving with the water, force tapers at the finish, and the
  recovery speed is limited by hand force.
- **A crew that coordinates.** Each rower reads his own blade, the ship and the men he can see and hear.
  Together they decide who pulls, who eases and who backs when you put the helm over, and they keep time
  loosely behind a stroke oar.
- **Fatigue and reliefs.** Eight hands in all, so two reliefs swap in as men tire.
- **Animated rowers.** Built in Blender, their bodies are solved every frame to follow their actual oar.

### 0.3 Results [meas]

| | Today | Proposed |
|---|---|---|
| Full: speed at 30 s / 60 s | 0.5 / 0.9 kn | **1.15 / 1.81 kn** |
| Full: time to 1 kn | 68 s | **25 s** |
| Full: steady speed | 1.86 kn | **2.46 kn** |
| Efficiency (thrust × speed / crew work) | 21 % | **38 %** (49 % within the drive) |
| Hold water from 2 kn to under 0.2 m/s | — | 26.8 m (1.9 lengths) |
| Rhythm | lockstep | settles from 200 ms ragged to a 15–30 ms spread in about 3 strokes, then drifts and re-settles |

Cross-check against the one historical datum: with 4 oars at 70 W per man the model gives about 1.8 kn,
which is Kyrenia II's typical speed under oars.

---

## 1. Decisions

### 1.1 Fixed by the user

| # | Decision |
|---|---|
| U1 | Merchant only. The trireme keeps `RowingSystem` untouched. |
| U2 | Six sweeps, three per side, worked standing. |
| U3 | Crew of 6–8 hands with rotation; the player is the helmsman, separate from the hands. This spec uses **8 hands**: 6 rowing plus 2 reliefs, one per group (§6.4 explains why). |
| U4 | Account for the crew's weight. |
| U5 | Rowers are skilled humans with good instincts: rule- and score-based, deterministic and explainable. No learning. |
| U6 | No mistakes for now, but the architecture must leave room for them (§5.9). |
| U7 | No literal talking. Coordination is systemic: shared crew state plus what each man can perceive. |
| U8 | The order ladder stays as it is. A "Turn 180" command comes later, as a manoeuvre intent (§5.2). |
| U9 | Animated rowers you can watch leaning into each stroke, built with Blender. |

### 1.2 Settled in this spec (engineering calls)

| # | Decision | Why |
|---|---|---|
| E1 | Rowers face aft and **pull**. | Greek practice; pulling is stronger; the stroke oar can watch the helmsman. The architecture allows pushing. |
| E2 | Arc capped at **0.83 rad** (+0.43 / −0.40), down from 1.30. | A standing man with planted feet can follow it without a fencing lunge. It is also more efficient. |
| E3 | Tholes raised **0.15 m** (except the stroke station, §2.3). | The handle was at hip height, so the trunk never straightened. |
| E4 | Stations alternate sides fore and aft, so no two rowers share a station. | Rowers must stand within about 0.6 m of the centreline. |
| E5 | **Shipping oars becomes a physics mode**, replacing the visual-only `oarStow` on the merchant. | The oar as drawn, the oar in the physics and the rower's hands must agree. |
| E6 | Relief handover: **two men on one loom for one stroke.** | An unattended sweep's blade drops about 1 m in 0.5 s from gravity torque. |
| E7 | Body-motion surge coupling (crew mass moving fore and aft) is **not** modelled. | About 0.02 kn, which is invisible (§7.3). |
| E8 | One merged vertex-colour material for crew figures. | 8 draw calls per pass instead of 32. |
| E9 | The physics owns grips, effort, phase, gaze choice and walk targets. **The animator owns the visual body** (pelvis, trunk, feet). The physics keeps its own simple body model for payload weight only. | Animation runs at render rate and must never feed back into deterministic physics. |
| E10 | The player cannot walk through a manned station (§9.8). | The looms swing at chest height. |

### 1.3 Open, needs the user (§14)

Slow as a two-oar watch; Full at 115 W per man; whether to review the hull's turning calibration; the
stroke-to-helm clearance.

---

## 2. Crew, deck and sweeps

### 2.1 Hands

| Item | Value |
|---|---|
| Hands | 8: six on the sweeps, one relief for the fore group, one for the after group |
| Helmsman | the player, separate, standing at s 0.86 |
| Mass | 65 kg each with clothing [est: Greek Classical to Hellenistic male stature about 1.62–1.70 m; re-check the source before quoting] |
| Variation | strength and critical power ±8 % per man, from a fixed per-hand seed |

### 2.2 Stations [meas, `layout.json`]

Stroke progress runs bow to stern. The stroke oar is the aftmost, directly ahead of the helmsman.

| Station s | Oar side | Pin x, y(WL), z (m) | Deck y | Deck half-width | Dip wet / dry |
|---|---|---|---|---|---|
| 0.17 (bow) | port | −1.43, 1.39, −4.55 | 0.82 | 1.25 | 26° / 15° |
| 0.25 | starboard | 1.75, 1.24, −3.44 | 0.67 | 1.56 | 24° / 13° |
| 0.33 | port | −1.95, 1.15, −2.34 | 0.58 | 1.77 | 22° / 12° |
| 0.62 | starboard | 1.99, 1.26, 1.65 | 0.69 | 1.81 | 24° / 13° |
| 0.70 | port | −1.77, 1.43, 2.76 | 0.86 | 1.60 | 27° / 16° |
| 0.78 (stroke) | starboard | 1.46, 1.65, 3.86 | 1.08 | 1.29 | 31° / 20° |

- **Rower position.** *Measured deviation:* the opposite-side stance is out of reach. The grips sit 0.11 to
  1.09 m off the centreline on the oar's own side, beyond a 0.58 m arm reach. So each rower stands on his
  oar's side, about 0.3 to 0.9 m off the centreline (stance x 0.36 to 0.91 m, port and starboard alike), level
  with the mid-stroke handle across the deck and 0.6 m forward of it, facing aft. A second man in a handover
  steps 0.35 m inboard of the stance along the loom. The rule is in `src/ship/crew/stance.ts` (`stanceXZ`),
  shared by the sim and the animator (`src/crew/stance.ts`). Space per rower is about 1.4 m fore-aft by
  0.7 m across.
- **Clearances.**
  - Mast (z −0.83) to the s 0.33 catch handle: 0.93 m.
  - No oar sits over the future hold (s 0.40–0.60). The s 0.62 rower's finish lean reaches about s 0.56;
    acceptable.
  - The stroke's hands at full catch reach to within 0.57 m of the helmsman (§14, question 4).
- **Relief waiting spots.** Fore: beside the mast at x ±1.0, z ≈ −0.8. Aft: x ±1.2 at s 0.55.

### 2.3 Sweep

| Item | Value |
|---|---|
| Length / inboard | 5.6 m / 1.5 m |
| Blade | 0.9 × 0.2 m, centre at r_b = 3.65 m (1.0 × 0.25 adds only +0.07 kn [meas]; take it only if the art wants it) |
| Grips | outer hand 0.08 m from the handle end (r 1.42), inner hand 0.45 m further outboard (r 0.97). The force law uses r_h = 1.20 m (the midpoint). |
| Pin | at halfBeam + 0.02 and sheer + 0.27. The stroke station uses sheer + 0.12, because the sheer rises aft and its handle would otherwise sit at 1.34 m. So pin height is per station (`pinDy`). |
| Arc | +0.43 to −0.40 rad; the planner places each stroke inside it (§5.6) |
| Mass and inertia | about 14.5 kg; I_oar 80 kg·m² [est] |

---

## 3. Physics, per oar

### 3.1 Joints

| Joint | Driven by | Notes |
|---|---|---|
| Sweep θ | **physics state (θ, ω), in every phase** | All the propulsive energy flows through it, so stroke speed, slip and rate emerge here. |
| Dip δ | rower, as a kinematic track (Hermite or quintic) | The rower sets blade depth by handle height. **Its work is charged to him:** `max(0, −F·v_dip)` per patch goes into his positive work and fatigue (7 % of crew work at Full [meas]). |
| Feather φ | rower, as a kinematic track | Squaring finishes before entry; feathering starts once the blade is clear. Work charged the same way. |

### 3.2 Equation of motion

The sweep's equation comes from virtual work, which stays exact when dip couples the axes. Blade patch j has
wet area A_j, normal n, and **s**_j, the patch velocity per unit sweep rate (from `evaluateOar` with
dSweep = 1). **b**_j is the slip from everything else: hull motion at the patch, minus orbital water
velocity, plus dip and feather motion.

```
slip_j(ω) = b_j + ω s_j                 (linear in ω once the geometry for the step is frozen)
F_j(ω)    = bladeDrag(A_j, slip_j(ω), n)
Q_w(ω)    = Σ_j F_j(ω) · s_j            (water's generalised force on the sweep)
I_eff ω̇   = Q_r(ω) + Q_w(ω)
```

**Effective inertia**, a state that changes as the blade picks up and sheds water:

```
I_eff = I_oar + m_refl (r_h cos δ)² + m_a (r_b² + L_b²/12) · wetFraction · cos²φ
```

| Term | Value | Basis |
|---|---|---|
| I_oar | 80 kg·m² | [est] a 14.5 kg fir sweep; a 10 kg oar (55 kg·m²) changes Full by +0.03 kn |
| m_refl | 20 kg at the hands | [est] arms plus the part of the trunk that moves with the handle |
| m_a | 14.5 kg (about 195 kg·m² fully wet and square) | [est] reduced flat-plate added mass. Largest term, least certain: possibly 2× either way |

**Changing inertia without creating energy.**

- On entry (I rises), conserve momentum: `I0·ω0 = I1·ω0'`. Log the loss as `pickupLoss`.
- On exit (I falls), keep ω and log `½·ΔI·ω²` as `shedKE`.
- Skipping either step leaked 0.7 % free energy in the prototype; the audit caught it.

**Hull coupling.** The hull gets the patch water forces at the patch centroids, exactly as today. The
inertial reaction of the oar and body is internal and zero-mean, so it is not applied (§7.3).

### 3.3 Rower force law (drive)

The force law is linear force–velocity, the established model for whole-body pushes and pulls. It replaces
the earlier idea of `min(F_max, P_max / v)`.

```
v_h  = dir · ω · r_h cos δ                                  handle speed along the stroke
g(θ) = clamp(1 − 0.55 ((θ − θmid)/0.5)², 0.45, 1)           weaker at full reach and at the finish
F_h  = u · S · g(θ) · F0 · (1 − v_h/v0)                     v_h ≥ 0 (concentric)
F_h  = u · S · g(θ) · F0 · (1 + 0.5 (1 − e^(v_h/0.25)))     v_h < 0 (eccentric, up to 1.5×)
Q_r  = dir · F_h · r_h cos δ                                dir −1 ahead, +1 backing (backing pushes, at 0.85 F0)
```

Here u is activation (0..1, first-order lag: 60 ms rising, 90 ms falling) and S is the rower's current
strength from fatigue (§4).

| Parameter | Value | Basis |
|---|---|---|
| F0 (isometric standing two-hand pull) | 900 N | [est] elite sliding-seat peaks are 800–1200 N |
| v0 (unloaded handle speed) | 2.8 m/s | [est] ergometer handle peaks are 2.5–3 m/s |
| Peak power F0·v0/4 | 630 W | [est] plausible for an untrained 65 kg man |
| Recovery hand-force bound | 220 N | [est] |
| Hold-water capacity | 1.25 × 0.75 × F0 × S ≈ 845 N | [est] |

### 3.4 Outside the drive: a bounded tracking servo

In the recovery, ready, hold, shipping, catch turnaround and extraction, the rower tracks a planned path with
a force bound:

```
Q_r = clamp(I_eff θ̈_ref + Kp (θ_ref − θ) + Kd (θ̇_ref − ω),  ±F_bound · r_h cos δ)      ωn 12 rad/s, ζ 1
```

This gives:

- one integrator for every phase;
- θ and ω continuous across every mode change, with no pose snaps;
- every joule the rower puts into the oar counted, including the recovery;
- a finite bound, so a recovering blade that hits a crest gets pushed back.

### 3.5 Integration

1. Each step, evaluate dip and feather at t1.
2. Freeze the geometry at θ* = θ0 + ω0·dt.
3. Solve backward Euler for ω1: `G(ω) = I_eff (ω − ω0')/dt − Q_r(ω) − Q_w(ω) = 0`, then θ1 = θ0 + ω1·dt.

G is strictly increasing in ω, so the root is unique. Use a safeguarded Newton step with a bracket and a
numerical derivative: 2–4 iterations, capped at 8. Re-evaluating Q_w is cheap because slip is linear in ω.
Forces applied to the hull use ω1. The step is stable at 1/60. Cost is about 20 µs per physics step for all
six oars [meas].

### 3.6 One stroke

1. **Catch (0.22 s).** The blade drops from dry to wet dip. A cubic Hermite turnaround ends at
   `ω = −v_ship / (r_b cos δ)`, so the blade enters already moving with the water. Activation ramps up, and
   over the last 40 % the servo hands over to the force law (`Q = (1 − β)·servo + β·FV`). This cut catch
   braking from 18 % of drive impulse to almost nothing [meas].
2. **Drive.** Pure force balance. Effort is `u = u_plan × taper`; the taper eases force to 25 % over the last
   30 % of the arc. The drive ends when `θ + |ω|·T_extract/2` reaches θ_finish, or on a stall
   (|ω| < 0.05 for 0.6 s).
3. **Extraction (0.20 s).** The hands stop the loom (a Hermite to rest, bounded by F0·S) while the dip lifts
   the blade out.
4. **Recovery.** A quintic from rest at the finish to rest at the catch. Its duration is at least
   `max(0.55 + 0.45·arc, sqrt(5.77·arc·I / (0.8·F_rec·r_h)))`. It is retimed at 20 Hz by the phase coupling
   (§5.7).
5. **Hold water.** Servo to θ = 0.07 with the blade wet and square, bounded by hold capacity. If the water
   wins, the oar yields; there is no clamp.
6. **Backing.** The mirrored cycle (dir +1, pushing). **Check first:** if she moves against the intended
   stroke faster than 0.35 m/s (0.5 m/s once rowing), hold water until she is checked, then back. Without
   this rule the blades stalled at full reach and backing from 2 kn never stopped her [meas].
7. **Shipped [new mode].** Servo to sweep −1.48, dip 0.04, feather π/2, blade dry. A
   `setShipped(side, on)` request drives it (§10.4).

### 3.7 Stroke at Full, steady, stroke oar [meas]

| Quantity | Value |
|---|---|
| Rate | 18.2 spm (emergent; period 3.3 s) |
| Drive / recovery | 1.2–1.3 s / 1.6–1.8 s |
| Arc | 40–49° |
| Handle travel / speed in the drive | 0.85–1.0 m / 0.55–0.70 m/s |
| Peak handle force | 450–600 N steady; up to 745 N on the 4th–5th stroke from rest |
| Blade slip at mid-drive | about 1.0 m/s, at 1.27 m/s ship speed |

The gearing is heavy (r_b / r_h ≈ 3), so the hands move slowly under high force. That is right for a heavy,
slow boat.

---

## 4. Physiology (per hand)

- **Short term: W′-balance critical-power model** [Monod & Scherrer; Skiba et al.].
  - CP = 100 W (±8 % per man); W′ = 14 kJ.
  - Below CP, W′ recovers at `(CP − P)(W′0 − W′)/W′0`.
  - It is driven by stroke-averaged power (τ 8 s), **not** instantaneous drive power, which wrongly drains W′
    even below CP.
- **Long term: endurance reserve R.**
  - `dR/dt = −(P/CP)^2.5 / 9000 s`; while resting, recovery is `(1 − R)/5400 s`.
  - At Half, R falls from 1 to 0.6 in 90 min.
- **Strength:** `S = strength_i · (0.6 + 0.4·sqrt(W′/W′0)) · (0.65 + 0.35·R)`. S caps effort u and hold
  force.
- **Fatigue input:** positive mechanical work + 25 % of negative work + 0.04 W/N of handle force, as an
  isometric cost (full while holding water, 30 % in the drive and recovery).
- **Crew facade:** `crew.stamina` = mean over the six rowing hands of (W′/W′0)·(0.5 + 0.5·R). The HUD keeps
  working unchanged.

CP 100 W makes Half sustainable for hours and Full a 20–25 minute effort before reliefs matter [Wilson,
*Bicycling Science*: about 75 W for 8 h and 100–150 W for an hour for healthy non-athletes].

---

## 5. Crew agents

### 5.1 Layers and rates

```
120 Hz  physics      per-oar force balance, activation, fatigue integration, payload points
 20 Hz  re-time      each rower re-aims his recovery at the predicted beat (during recovery only)
events  decide       at the finish: plan the next stroke; at the catch: log the beat, update the period estimate
 10 Hz  intent       order, helm, hold, ship speed → demands
 10 Hz  allocation   demands + fatigue → each oar's share and arc bias; who mans a watch
  1 Hz  rotation     relief decisions
```

- Each oar has its own mode machine, evaluated every physics step on its rower's own state:
  rest → transfer → ready → catch → drive → extract → recover → catch …, plus hold and shipped.
- Decision clocks advance by exact sums of dt, so decisions are deterministic.

### 5.2 Intent

The intent layer turns orders into normalised demands. It never outputs Newtons.

```
low  = 1 − smoothstep(0.5, 2.0, |v|)                  oars matter most at low speed
turn = smoothstep(0.05, 1, |helm|) · sign(helm)
X*   = order.dir · (1 − 0.6 |turn| · low)             hard over at rest: give up way for the pivot
N*   = turn · (0.35 + 0.65 low)
P*   = order power per man;  rate* = order rate;  yawPriority = 0.4 + 0.6 low
Oars Up → no rowing, whatever the helm
```

**Manoeuvre intents** implement the same interface and output the same tuple over time, so nothing below this
layer changes when they arrive. Turn 180, for later: X* = 0 and N* = ±1 until 150° is turned, then ease N* to
arrive at 180°, then hand back to the order.

### 5.3 Allocation: how the crew "knows what the others do"

Minimise, over each oar's signed share a_i ∈ [−1, 1]:

```
J   = wx (Σ a_i / 6 − X*)²  +  wn (Σ (−side_i) a_i / 6 − N*)²  +  Σ c_i a_i²
c_i = 0.02 + 0.25 (1 − W′_i / W′max) + 0.2 (1 − R_i)          tired men are spared; an empty oar costs 1e3
wx  = 1,   wn = 3 · yawPriority
```

- **Solver:** projected gradient, step 0.9/L, 80 iterations in fixed order (deterministic).
- **Each rower's job:** power target `P_i = |a_i|·P*`, direction `sign(a_i)`. Below |a_i| = 0.12 he rests his
  oar.
- **Arc bias:** `b_i = foreSign · (−side_i · sign(a_i) · N*) · smoothstep(0.2, 0.8, |N*|)`. Fore oars reach
  forward and aft oars finish long when their side must turn harder.
- **Watches:** when an order mans fewer than six oars, the same men stay on, one per side, nearest amidships
  first. A man is swapped only when his cost exceeds an idle man's by 0.15.
- **Turning leverage, corrected.** Fore and aft oars have the *same* thrust lever, because thrust acts at the
  blade, about 5.4 m off the centreline. Arc placement shifts yaw by only about ±18 %. Turning is therefore
  mainly differential effort, including backing the inner side.
- **Result [meas]:** full helm, from rest or underway, gives outer side +1.00 and inner side −0.79, a pivot.

### 5.4 Perception: what a rower knows

| Channel | Content | Latency / weight |
|---|---|---|
| Proprioception | own oar angle and rate, handle force, drive time, work per cycle | immediate |
| Interoception | own S (from W′ and R) | immediate |
| Feel of the water | ship speed through water (τ 2 s), for the catch speed match and the check-before-backing rule | immediate, filtered |
| Water at the blade [new] | surface height and slope at his blade over the next 0.5 s (§5.8) | immediate |
| Sight | catches of rowers **aft** of him (he faces aft); the stroke sees the helmsman | 0.15 s; weight 1.0 for the stroke, 0.5 for others in view |
| Hearing | catches of everyone (blade entry, thole knock) | 0.15 s; weight 0.15 (0.3 for the stroke) |
| Orders | order, helm, hold water | via the crew state |

A rower does **not** perceive other men's forces, fatigue numbers or plans. He sees fatigue only as shortened
strokes; the allocator and rotation use fatigue as common knowledge (a drilled crew knows who is spent).

### 5.5 Shared crew state (the "talking")

The crew state is what a drilled crew holds in common:

- the current intent;
- each oar's share and arc bias;
- assignments: who is on which oar, who is waiting, the pending handover;
- the role table: stroke = aftmost manned oar. If the stroke is relieved or resting, leadership passes forward.
- a timestamped log of catches. Each rower reads only what he could see or hear, after the delay.
- each man's fatigue cost.

### 5.6 Stroke planner (at each finish)

```
T    = stroke: 60/rate* · (1 + β_i + wander(t));   others: observed stroke period · (1 + β_i)
arc  ← clamp(arc · (T_d* / T_d,last)^0.6, 0.30, 0.83 · (0.8 + 0.2 S)),   T_d* = 0.5 T
       then shrink 4 % at a time until T_d(arc) + T_rec,min(arc) + T_catch + T_extract ≤ 0.97 T
u    ← clamp(u · clamp(sqrt(P_i / P_cycle,last), 0.8, 1.25), 0.12, min(1, S))
θ_c, θ_f = θmid + 0.12 b_i ± arc/2, kept inside [−0.40, +0.43]
```

From rest this gives short, heavy strokes that lengthen as she gathers way, purely from felt drive time
[meas, stroke oar]:

| Stroke | 1 | 2 | 3 | 4 | 6 | 9 | 13 | 17 |
|---|---|---|---|---|---|---|---|---|
| Speed (kn) | 0.13 | 0.23 | 0.35 | 0.49 | 0.78 | 1.12 | 1.47 | 1.74 |
| Arc (°) | 23 | 26 | 29 | 31 | 32 | 34 | 37 | 40 |
| Peak handle force (N) | 440 | 538 | 655 | 746 | 710 | 601 | 590 | 551 |

### 5.7 Timing: coupling on the catch

A rower's phase is the physical state of his oar, so he is not a free oscillator. The only timing he controls
is when he catches, which means how long his recovery takes. Coupling therefore acts on recovery duration:

```
t_nat  = own last catch + T_i
pred_j = j's last catch + j's observed period, wrapped to the beat nearest t_nat   (only if seen or heard)
t_ref  = Σ w_ij pred_j / Σ w_ij
t*     = t_nat + K (t_ref − t_nat) + jitter_i(stroke#)                             K 0.7 followers, 0.1 stroke
recovery duration = clamp(t* − now, T_rec,min, 3.2 s), re-aimed every 0.05 s
```

The organic look comes from these sources, all deterministic and explainable:

- reaction lag on the first stroke;
- personal rate bias β_i (±2 %, which settles to an offset of about ±90 ms);
- jitter of ±35 ms per stroke, from `hash(handId, stroke#)`;
- the stroke's rate wandering ±1.2 % (sines with periods of 57 s and 134 s);
- the crew trailing when the stroke quickens and the minimum recovery binds.

**Result [meas]:** a 200 ms ragged start settles to a 15–30 ms spread within about 3 strokes. It then drifts
by ±70–110 ms as the stroke's rate wanders, and re-settles. With coupling off, the spread reaches 900 ms by
stroke 30.

### 5.8 Reading the water [new, not prototyped]

This is the part of "responding to the water" that the force balance doesn't give for free. The force balance
already reacts within a stroke: orbital flow changes slip, and a crest loads the blade. This section adds what
a skilled rower *anticipates*. Each rower samples the surface at his blade's predicted catch point
(`WaveField.heightAt`, from the planned pose, 0.1–0.5 s ahead):

1. **Catch timing:** if the predicted wet depth at t* is under 40 % of nominal (a trough), delay the catch
   up to 0.15 s, or bring it forward up to 0.10 s, toward better water. The coupling then treats the shifted
   catch like any other.
2. **Dip target:** raise or lower the wet dip by up to ±0.06 rad to keep the blade at nominal depth on the
   local slope.
3. **Chop:** if surface variance at the blade over the last 10 s exceeds a threshold, shorten the planned arc
   by up to 15 % and raise the dry dip (higher, quicker recoveries clear crests).
4. **Missed water:** if a drive's wet area falls under 30 % of expected for more than 0.3 s, the planner
   shortens the next stroke. That is the skilled response; a crab is a separate, later mistake.

Gate: in the default sea, the missed-drive fraction must improve on the same crew with this layer off, and
the rhythm gates (§12.2) must still pass.

### 5.9 Room for mistakes (later)

Mistakes are perturbations of a rower's motor plan, never of the physics. Each hand has a `Skill` record
feeding the planner: `timingSd, depthSd, K, reaction, catchMatch, taper, waterRead`. Today every hand gets the
"skilled" preset.

- **Crab:** late or deep extraction. The blade is held while the boat runs on, the servo yields and the loom
  drives into the man. Add a "lost the handle" state and a recovery behaviour.
- **Missed water:** too shallow a dip target.
- **Rushing or lagging:** more jitter, or a lower K when tired.

---

## 6. Rotation

### 6.1 When

Checked at 1 Hz:

- **Swap** when either:
  - the most fatigued rower (score `(1 − W′/W′0) + 0.5(1 − R)`) has W′ under 35 %; or
  - a waiting man is fresher by more than 0.15 in R and the rower has been on for at least 10 min.
- **The incoming man** must have W′ ≥ 80 %.
- **Never** during hold water, Oars Up or a turn (|N*| > 0.3).
- One handover at a time, at least 20 s apart. Respect watch assignments.
- Each group (fore, aft) uses its own relief first.

### 6.2 Handover (two men on one loom)

1. The relief walks to the station's free side along a slalom through the alternating free halves of the
   deck: 0.8 m/s, path factor 1.3, 4–8 s.
2. During a recovery he takes the loom inboard of the rower's hands (r 0.85–1.0). From the next catch he
   drives; the outgoing man's hands follow passively. His mass is added to I_eff for that stroke.
3. At that stroke's finish the outgoing man lets go and steps out aft and outboard in the recovery, then walks
   to the waiting spot.

Cost per handover [meas]: worst −0.4 % speed, mean −0.14 %.

### 6.3 Waiting

A resting relief recovers W′ and R at the resting rates. While walking he counts as light work (40 W) for
fatigue.

### 6.4 One relief versus two [meas, Full, 90 min, calm]

| Hands | 10 min | 30 min | 60 min | 90 min | Swaps |
|---|---|---|---|---|---|
| 6 | 2.42 kn | 2.28 | 2.22 | 2.17 | 0 |
| 7 | 2.42 | 2.35 | 2.30 | 2.25 | 21 |
| 8 | 2.42 | 2.36 | 2.32 | **2.31** | 23 |

Two reliefs help most because each group gets its own, so nobody walks 6–8 m through the waist. At Half,
reliefs barely matter within 90 min; they would over a 4–6 h day.

---

## 7. Weight

### 7.1 Live payload points

Each hand is one payload point (65 kg) in the physics' payload list, updated every physics step:

- **Rowing:** at the body centre of mass from the crew system's simple body model. The pelvis travels about
  0.45 m toward the bow over the first half of the drive; height is fixed at 1.0 m above deck.
- **Walking:** interpolated along the path.
- **Helmsman:** fixed at the helm, or at the player's position when on foot.

### 7.2 Effects [meas]

| Effect | Value |
|---|---|
| Total | 585 kg (8 hands plus the helmsman), 3.3 % of 17.7 t |
| Sinkage | 1.7 cm |
| Trim | +0.05° by the stern |
| A relief walking 6 m forward | 0.06° of trim |
| Full steady speed | −0.5 % |
| Acceleration | −3.3 % |

The column model's wetted area barely changes with draft; a real hull would take about +2 % resistance. Leave
it: under 1 % speed.

### 7.3 Not modelled: body-motion momentum

Six rowers in phase (390 kg) moving 0.6 m peak to peak at 18 spm give about 420 N of internal force. The
resulting hull surge is about 0.012 m/s (0.02 kn) with 6 mm of displacement. In a racing shell the crew is
about 80 % of the moving mass; here it is 3 %.

---

## 8. Orders

| Order | Oars manned | Power per active man | Target rate | Steady speed [meas] | Time to 1 kn | Sustainable |
|---|---|---|---|---|---|---|
| Back Water | 6 | 80 W | 15 spm | −1.98 kn | — | hours |
| Oars Up | 0 | — | — | — | — | — |
| Slow | **2 (a watch, one per side)** | 45 W | 14 spm | 1.02 kn | 196 s | indefinitely |
| Half | 6 | 80 W | 16 spm | 2.18 kn | 28.5 s | hours |
| Full | 6 | **115 W** | 18 spm | 2.46 kn | 24.9 s | about 25 min before reliefs matter; 2.3 kn held for 90 min with 8 hands |

- Rates are targets. The actual rate emerges and lands within about 0.3 spm, because the planner shortens the
  arc to stay in the beat.
- These values go in a merchant orders table in the design (`oars.crew.orders`). They don't change `ORDERS`
  in crew.ts, which the trireme still uses for names and indices.
- The HUD's spm shows the stroke's actual rate.

---

## 9. Animation

### 9.1 Rig (proved in the PoC)

- **Armature:** hand-built from the figures.py joint map, with Blender heat weights on the closed skin body
  only. Do **not** use Skin "Create Armature": it gives generic names and arbitrary rolls, and nothing for the
  separate parts.
- **20 bones:** root (non-deforming), pelvis, spine, chest, neck, head, and per side clavicle, upperarm,
  forearm, hand, thigh, shin, foot. The PoC's forearm-twist bones measured under 0.5° of twist and are
  dropped.
- **Rigid parts:** head and hair 100 % head; hands 100 % hand; feet 100 % foot.
- **Chiton and belt:** data transfer from the body, then reshaped:
  - no arm influence on the yoke (folded into the clavicles);
  - leg influence fades from 0 at the waist to at most 60 % at the hem;
  - shin and foot influence folds into the thigh;
  - 3 smoothing passes, at most 4 influences, normalised.
- **Size:** about 2000 tris; one merged vertex-colour primitive (E8).
- **Conventions:**
  - anatomical L/R, where +x is the figure's right. figures.py's comment says the opposite and is wrong;
    fix it.
  - no dots in bone names.
  - bone local +Y points at the child.
- **Exporter:** use the animation optimise flags (`export_force_sampling=False`,
  `export_optimize_animation_size=True`, `export_optimize_animation_keep_anim_armature=False`); without them
  each clip bakes 66 tracks instead of 3.

### 9.2 Build script: `tools/blender/rowers.py`

Outputs `public/assets/models/crew.glb`:

- **Figures:** `fig_rower_a/b/c`, with seeded proportion jitter (±4 % limb length) and hair and cloth variants.
  The armature node carries the figure name; the mesh is `<name>_mesh`.
- **Clips:** `walk`, `idle_stand`, `rest_sit`, optionally `turn_90`.
- **Previews** to `tools/blender/previews/`:
  - the rest pose;
  - a weight overlay per chain;
  - a pose-check contact sheet rendered from harness snapshots (catch, mid-drive, finish, mid-recovery,
    hold; side, three-quarter and top views).

### 9.3 Loader fixes (`src/gfx/models.ts`)

- `get()` must use `SkeletonUtils.clone` for anything containing a SkinnedMesh. A plain `clone()` shares one
  skeleton, so every rower would move together (verified).
- Look figures up by the armature node's name.

### 9.4 Runtime: the rower follows the oar

**The stroke pose is a function of the oar's grip positions plus a few smoothed values, never of stroke
phase.** Phase, effort and gaze change only style. That is why emergent strokes of any length, rate or timing
can't break it. Per figure, per render frame, in ship-local space:

1. **Clip layer:** the mixer updates walk, idle or rest.
2. **Grips** come from `renderPose(i, alpha)`, using the end and inner grip offsets (§2.3).
3. **Trunk yaw:** squares the shoulders to the loom (0.55 × the grip-line angle, plus 0.25 × lateral
   offset, clamped ±0.6 rad, spring ω 8), split 25/35/40 % over pelvis, spine and chest.
4. **Reach model:** a closed-form FK of the *same* curved spine. It must match the real FK exactly: an
   approximate version was 8 cm off, and that showed up one-for-one as hand error.
5. **Pelvis:** a preferred position from handle reach (asymmetric tanh, 0.8 × foot split) and height (drops
   with effort and stance spread), smoothed by a critically damped spring (ω 14 in the drive, 10 in the
   recovery). **Then the reach constraints are applied, after the smoothing and unsmoothed themselves.** This
   was the most important fix in the PoC: constraints before the spring left 30 % of frames with hand error
   above 3 cm.
6. **Trunk pitch:** a preferred posture (reach at the catch, laid back at the finish, thrown back under load),
   then bounded by reach (bisection, 12 iterations each way).
7. **Clavicle:** protracts toward the wrist target when reach exceeds 0.85.
8. **Arms:** analytic two-bone IK, soft extension from 97 %. The pole is `0.5·out − 0.2·up − 0.85·back`. It
   must point where the hands never go, i.e. behind the body; the first choice flipped the elbow 63° in one
   frame.
9. **Legs:** planted ankles, two-bone IK, soft extension from 98.5 %, heel lift past 99 %.
   - **Stance re-planting [new]:** the recent catch and finish handle positions set ideal feet. A foot more
     than 10 cm from its ideal steps while unloaded: the front foot late in the drive, the back foot in the
     recovery.
10. **Head:** look-at toward the gaze target, within ±1.2 rad yaw and −0.6/+0.5 rad pitch, split 35/65 neck
    and head, spring ω 6. It drops a little under effort and is counter-pitched to keep the eyes level.
11. **Secondary:** breathing (exhale in the drive) and per-figure seeded noise on head pitch.
12. **Blend:** per chain (body, each arm, legs, head) between the clip and procedural layers.

**Ship motion:** the trunk keeps 70 % of world vertical against roll through a spring (ω 4), giving a visible
lag; the legs absorb the rest. Heave flexes the knees. Use the *interpolated* render pose for world-up, not
the physics pose, or the trunk will jitter.

### 9.5 States

| Mode | Layer | Notes |
|---|---|---|
| row, hold | IK, all chains | hold needs no special code |
| shipped | arms follow the loom inboard, then hands off over 0.3 s; body blends to `idle_stand` | |
| stepIn | `walk` to the approach point, turn to face aft (0.6 s), two procedural foot placements (0.35 s arcs), hands reach to the grips over 0.4 s | |
| stepOut | stepIn reversed | the crew system releases the leaver only after the relief's hands are on |
| walk | `walk` clip, phase advanced by distance / stride (no skating) | root position and heading from the crew system |
| idle / rest | `idle_stand` / `rest_sit` | head look-at always on (weight 0.7) |

### 9.6 Data contract (crew system → animator, per hand, double-buffered, read at render alpha)

```ts
interface CrewMemberView {
  id: number;
  figure: 'fig_rower_a' | 'fig_rower_b' | 'fig_rower_c';
  seed: number;
  mode: 'row' | 'hold' | 'shipped' | 'walk' | 'stepIn' | 'stepOut' | 'idle' | 'rest';
  oar: number;                 // slot index, −1 if none
  handsOn: number;             // 0..1 grip target; handovers sequenced by the crew system
  gripInner: number;           // grip radius of the inner hand: 0.97 normally, 0.85–1.0 for a relief during handover
  effort: number;              // activation u, 0..1
  driving: boolean;            // in the drive (blade loaded)
  strokePhase: number;         // 0..1 since own last catch; style only
  progress: number;            // 0 catch … 1 finish; style only
  fatigue: number;             // 1 − S: slump, head lower, slower gaze
  gaze: { kind: 'member'; id: number } | { kind: 'helm' } | { kind: 'blade' } | { kind: 'point'; p: Vector3 } | null;
  walk?: { pos: { x: number; z: number }; yaw: number; speed: number; target: { x: number; z: number; yaw: number } };
}
```

Gaze rules: followers watch the man in front of them (aft), the stroke watches the helmsman, there is a glance
to the blade at the catch, and walkers watch their path. Gaze targeting a member aims at that member's live
head bone. **This is how the crew's coordination becomes visible.**

### 9.7 Performance [meas in Node]

- **CPU:** 13–20 µs median per rower per frame (p99 60–90 µs, from GC in the PoC); about 0.15 ms for eight.
  The production port must be allocation-free. No LOD needed; optionally skip solves for figures off-screen
  and out of the reflection.
- **GPU:** draw calls, not skinning; one merged primitive (E8).
- **Culling:** set `frustumCulled = false` on crew figures, or enlarge their bounds by 1 m. Skinned bounds
  come from the bind pose, so a lunging rower can be culled at the screen edge.

### 9.8 Walker collision

- **Dynamic solids:** add `WalkGeometry.dynamic: CylSolid[]`, checked brute-force (8 entries). The static grid
  isn't suited to per-frame updates.
- **Per hand:** a cylinder (r 0.28 m, 1.75 m tall) following the pelvis while walking. While rowing, it is
  centred on the stance at r 0.35.
- **Per manned station:** a keep-out box covering the stance and the handle's swept area (E10), removed when
  the station is empty or its oar is shipped.

---

## 10. Integration

### 10.1 One interface, two implementations

```ts
// src/ship/oarPropulsion.ts
export interface OarPropulsion {
  readonly slots: readonly OarSlot[];
  readonly previous: BladeFrame; readonly current: BladeFrame;
  readonly events: RowEventRing;
  readonly telemetry: RowTelemetry;          // today's keys (oarThrust, portThrust, …, crewLoad, …)
  step(dt: number, time: number, body: RowBody, helm: number, waves: WaveField, forceOut: Vector3, torqueOut: Vector3): void;
  reset(body: RowBody, time: number): void;
  refreshWorld(body: RowBody): void;
  renderPose(index: number, alpha: number, out: OarKinematics): void;
  setShipped(side: RowSide, on: boolean): void;   // RowingSystem: no-op (its ships keep the visual stow)
  readonly crewView?: CrewView;                  // crew system only (§9.6)
}
```

- `RowingSystem` gains `implements OarPropulsion` and a no-op `setShipped`. No behaviour change.
- `ShipDesign.oars` gains `system: 'banks' | 'crew'` and an optional `crew` block: stations, sweep, rower,
  physiology, orders table, hands, skill preset.
- `ShipPhysics` constructs `design.oars.system === 'crew' ? new CrewRowing(crew, design.oars, this.payload)
  : new RowingSystem(crew, design.oars)`. Its `rowing` field becomes `OarPropulsion`.
- Reused unchanged from rowing.ts: `evaluateOar`, `createKinematics`, `BladeClipper`, `bladeDrag`,
  `nominalDip`, `BladeFrame`, `RowEventRing`, `ROWING_CONSTANTS`. **Do not change their signatures or
  numbers.**

### 10.2 New files

| File | Contents |
|---|---|
| `src/ship/crew/crewRowing.ts` | `CrewRowing implements OarPropulsion`: step loop, frames, events, telemetry, payload |
| `src/ship/crew/sweepDynamics.ts` | patch linearisation, Q_w(ω), implicit solve, added-mass pickup and shed, audit accumulators |
| `src/ship/crew/rowerBody.ts` | force–velocity law, activation, servo, simple body CoM model (payload only) |
| `src/ship/crew/physiology.ts` | `Hand`: W′ balance, R, S, traits, `Skill` |
| `src/ship/crew/stroke.ts` | per-oar mode machine, planner, catch, extraction and recovery tracks |
| `src/ship/crew/coupling.ts` | perception (visibility graph, delays), predicted-beat coupling, retiming |
| `src/ship/crew/water.ts` | reading the water (§5.8) |
| `src/ship/crew/intent.ts` | order and helm → intent; `Manoeuvre` interface |
| `src/ship/crew/allocation.ts` | allocator, arc bias, watches |
| `src/ship/crew/rotation.ts` | relief logic, walking paths, handover |
| `src/ship/crew/crewView.ts` | the animation data contract, double-buffered |
| `src/crew/rowerRig.ts` | per-figure solver (port of `rowerIK.mjs`, allocation-free) |
| `src/crew/crewAnimator.ts` | figures, mixers, the state machine of §9.5, stance and step planning, chain blends, dynamic walk solids |
| `tools/blender/rowers.py` | rig and clips → `crew.glb` |
| `scripts/test-crew-rowing.mjs` | physics and agent tests (§12.1, §12.2) |
| `scripts/test-rowers.mjs` | animation tests (§12.3) |

### 10.3 Consumers

| Consumer | Uses today | Change |
|---|---|---|
| ShipPhysics | `step`, `reset`, `refreshWorld`, `telemetry.oarThrust` | type → `OarPropulsion`, plus the factory. The crew system owns its payload entries and mutates them in place. |
| merchantModel.ts | `slots`, `renderPose`, frames, `oarStow` | six instances; skip `oarStow` when the system is `crew`; the static crew loop is replaced by `CrewAnimator` |
| oarWater.ts, foam | `slots`, `current.contact`, `forceWorld`, `events` | none |
| audio.ts | `catchBeat` (drum), contact events | catchBeat is emitted on the stroke's catch only; the merchant's drum stays off |
| hud.ts | `crew.rate`, `stamina`, order | rate = the stroke's actual rate; stamina from §4 |
| main.ts debug review | `rowing.sides` | guard: trireme only |
| game.ts | order keys, `oarStowTarget` | §10.4 |
| design.ts | `crewSpots` | the merchant's static crew spots are removed (rowers come from the crew system); trireme unchanged |
| game.ts:291 static crew cylinders | `crewSpots` | merchant uses the dynamic solids (§9.8) |

### 10.4 game.ts

- **Shipping per side:** where it sets `model.oarStowTarget[side]`, also call
  `ship.rowing.setShipped(side, …)`. For a crew-system ship the model ignores `oarStow`, and the shipped
  side's rowers idle beside their sweeps.
- **Docked:** both sides shipped and the ladder locked, as now; the crew rests (`rest_sit`).
- **Lines out, anchor down, captain ashore:** these call `setOrder(ORDER_STOP)` today; unchanged.
- **Order keys (W/S):** unchanged. A future Turn 180 key creates a `Manoeuvre` (U8).

### 10.5 HUD

This follows the UI redesign: show the gradient, never the answer; oars and crew panel on the right.

- The crew system exposes true, instant per-oar data the oars and crew panel can draw:
  - effort, drive or recovery, catch times (the rhythm spread), and each man's exertion;
  - who is on which oar, and a relief walking.
- **No optimal values and no cause text.** No "ideal rate" and no "crew tired, rotate".
- The panel's visual design is out of scope here and goes through the UI redesign's own review.

---

## 11. Build phases

Each phase ends with its gate passing and the trireme suites (`test:rowing`, `test:golden`, `test:sailing`)
green and unchanged.

| Phase | Work | Gate |
|---|---|---|
| **P0 Seam** | `OarPropulsion`, the factory, `oars.system`; `RowingSystem` implements it; the main.ts guard | `tsc` clean; every existing suite passes with no numeric change |
| **P1 Sweeps** | six-station layout, sweep dynamics, rower body, single-rower stroke cycle (no agents: every oar uses the stroke's plan), shipped mode, merchant orders table; figures temporarily static at their stances | §12.1 energy, clipping, passivity, continuity, timestep, speed bands, efficiency, stopping |
| **P2 Crew** | intent, allocation, perception, crew state, planner, coupling, roles, watches; then reading the water (§5.8) | §12.2 rhythm, startup, turning; then the waves gates |
| **P3 Bodies and weight** | physiology, rotation, handover, payload points | §12.2 rotation; §12.1 payload |
| **P4 Animation** | `rowers.py`, loader fixes, `rowerRig`, `crewAnimator`, dynamic walk solids, merged material | §12.3 |
| **P5 Review** | browser review and tuning (§12.4); `docs/merchant-crew-validation.md` with measured results; update `merchant-ship-plan.md` §4.7 | the user signs off on the look and feel |

**Later:** Turn 180 manoeuvre; mistakes (§5.9); the quay-side crew tending lines when their oars are shipped;
the trireme realism pass deciding whether the trireme moves to the crew system.

---

## 12. Acceptance tests

### 12.1 Physics (`scripts/test-crew-rowing.mjs`)

1. **Energy audit:** per oar, over 240 s at every order,
   |pos − neg + water − ΔKE − numLoss − shed − pickup| < 1e-3 of positive work. Patch identity: hull + water +
   dip + slip = 0 within 1e-6 relative.
2. **No hidden clipping:** forces applied to the hull equal `bladeDrag(slip(ω1))` exactly. This is a
   numerical re-evaluation at random steps plus a check that no force-scaling code path exists.
3. **Passivity:** F·slip ≤ 0 for every patch and step. A held blade at rest does no rower work.
4. **Continuity:**
   - θ and ω continuous at every mode boundary; dip and feather C1.
   - Over 10 min of mixed orders, helm and hold, angles stay in range.
   - Peak-to-peak arc ≤ 0.83 rad + 0.02.
5. **Timestep:** Full and Half steady speed within 0.5 % across dt 1/60, 1/120 and 1/240; speed at 60 s
   within 0.02 kn.
6. **Speed bands (calm, 240 s):**
   - Slow 0.9–1.2 kn, Half 2.0–2.3, Full 2.3–2.6, Back −1.8 to −2.2.
   - Full: ≥ 1.0 kn by 30 s, ≥ 1.6 kn by 60 s, time to 1 kn ≤ 30 s.
7. **Efficiency:** Full and Half ≥ 0.35.
8. **Stopping:** hold water from 2 kn stops her (under 0.2 m/s) within 5 lengths. Peak handle force ≤ hold
   capacity, or yield is logged.
9. **Payload:** 9 × 65 kg sinks her 1.7 ± 0.3 cm and changes Full by under 1 %. Walking changes trim
   smoothly (no step above 0.01° per step).
10. **Waves (adversarial):** a single 0.5 m swell with orders cycled:
    - everything finite;
    - wet area ≤ blade area;
    - a dry blade produces zero force;
    - no event-ring overflow;
    - the servo never exceeds its bound by more than 1e-6.
11. **Determinism:** two runs are bit-identical (pose, joints, catch log). No `Math.random` anywhere in
    `src/ship/crew/`.
12. **CPU:** ≤ 0.1 ms mean per physics step for crew propulsion.

### 12.2 Crew

1. **Rhythm:** Full from rest:
   - spread ≤ 60 ms by stroke 5;
   - median spread ≤ 35 ms over strokes 10–35;
   - followers' first catch lags the stroke by their reaction time ± 20 ms.
   - The no-coupling control diverges (> 300 ms by stroke 15), proving the coupling does the work.
2. **Startup:** first-stroke arc ≤ 30°, growing (±2°) to ≥ 38° by stroke 17; peak handle force highest in
   strokes 3–6.
3. **Turning:**
   - From rest, full helm at Full: ≥ 70° in 60 s with |v| < 0.5 kn.
   - Underway: crew assist gives ≥ 1.5× the rudder-only yaw rate.
   - Oars Up plus helm: no rowing.
4. **Watches:** Slow mans exactly one oar per side, and the same men stay on unless the cost rule swaps them.
5. **Rotation:** Full with 8 hands for 60 min:
   - at least one swap;
   - none during |N*| > 0.3, hold or Oars Up;
   - no two within 20 s;
   - per-handover speed dip ≤ 1 %;
   - every manned oar has at least one hand on it every step.
6. **Reading the water:** in the default sea, missed-drive fraction lower than with §5.8 off, with the rhythm
   gates still passing.

### 12.3 Animation (`scripts/test-rowers.mjs`, from the PoC harness, all six stations)

1. Hand-to-grip error from the real three.js skeleton: p95 < 1 cm, max < 3 cm.
2. Planted toe drift < 0.5 cm per plant.
3. Pop detector: per-bone rotation < 12° per 60 Hz frame, except at input discontinuities.
4. Minimum knee angle ≥ 70°; elbow-flip detector (|pole·reach dir| < 0.8).
5. Rower-to-rower and rower-to-loom clearances ≥ 0.1 m at all six stations, driven by recorded physics strokes
   (not synthetic ones).
6. Two clones posed differently stay different (shared-skeleton regression).
7. ≤ 40 µs median per rower per frame; zero allocations per frame after warm-up.

### 12.4 Browser review (P5, human eye)

- Does the lean read from the chase camera at 24 m?
- Counter-balance against roll in motion.
- Gaze glances: is the coordination visible? Is the timing natural?
- The chiton in motion.
- Relief walk, step-in and handover.
- From rest: short, heavy strokes lengthening; the ragged start settling.
- A hard-over pivot from rest.
- Shadows and reflections on skinned meshes.
- No stutter at 60 fps; check the GC count over 60 s.

---

## 13. Review notes: where this spec departs from the specialists

1. **Turning attribution.** The physics proposal says the slow pivot (90° in 56 s) is set by the hull's
   `angularDamp`. My check disagrees:
   - The torque is `−mass × 0.6 × angVel` (physics.ts:280). At 1.63°/s that is only about 300 N·m, against
     a claimed oar moment of 1.5–3 kN·m.
   - The rest is probably the hull's lateral plane resisting rotation.
   - **Before anyone tunes turning**, P2 must log a yaw-moment breakdown (oars, rudders, lateral plane,
     `angularDamp`) during the pivot.
2. **Body ownership.** The physics proposal had the crew system output pelvis, trunk pitch and feet; the
   animation proposal has the animator solve them. The animator owns them (E9). The physics keeps a simple CoM
   model for payload only.
3. **Shipping.** The animation proposal had the rowers grip the visually stowed oar through a new
   `oarVisual()`. With shipping as a physics mode (E5), `renderPose` is the drawn oar, so no extra accessor is
   needed.
4. **Grip radii.** The animation PoC needed the hands 0.45 m apart (r 1.42 / 0.97); the physics used
   r 1.45 / 1.05 with r_h 1.25. Use the animation grips and r_h 1.20. Expect about a 1 % change in the
   numbers; P1 re-measures.
5. **Reading the water (§5.8)** is added here; neither specialist covered anticipating waves.

---

## 14. Open questions for the user

**Answered 2026-10-10: yes to all four recommendations.** Slow is a two-oar watch; Full is 115 W per man;
the yaw-moment breakdown is measured before any turning tuning; the helm clearance is decided in the browser
review.

1. **Slow as a two-oar watch.** Six men cannot row a 1 kn Slow at any real effort: fixed costs (catch,
   recovery, dip) swamp the useful work. Slow = two men rowing, one per side, is also how a real crew would
   cruise. Accept? *Recommended: yes.*
2. **Full at 115 W per man, 2.46 kn.** Hard work: reliefs start to matter after about 25 min. 150 W would give
   about 2.7 kn but exhausts the crew in about 5 min. A sprint, if wanted, would be a separate, time-limited
   order. *Recommended: 115 W.*
3. **Turning.** A 180° pivot takes about 2 minutes. That may be realistic for an 18 t hull with six oars, but
   it will matter for Turn 180. Review the hull's yaw calibration after the breakdown in §13.1, or leave it?
   *Recommended: measure first, decide then.*
4. **Stroke-to-helm clearance of 0.57 m.** Accept, or move the helm to s 0.88? *Recommended: decide in the
   browser review.*

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| Added mass m_a off by 2× | It shapes catch feel more than speed (shed and pickup are 4 % of work); P1 runs a sensitivity sweep at 0.5× / 1× / 2× and checks the gates hold |
| Rower strength and CP are estimates | Speed scales with about the cube root of power (±20 % power ≈ ±6 % speed); the per-order power table is the one tuning knob |
| The rhythm reads as robotic or as chaos | The coupling constants (K, jitter, bias, wander) are explicit; tune them in P5 by eye against the rhythm gates |
| GC spikes from the animation port | Allocation-free port; test 12.3.7 |
| Six visible oars plus crew crowd the deck view | Browser review at the helm and chase cameras in P5 |
| Scope | Phased; every phase ships behind `oars.system`, and the merchant can fall back to `banks` until P5 signs off |
