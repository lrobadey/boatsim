# Rough-water rowing: outside review (2026-10-10)

The user put the question below to an outside expert reviewer and pasted back the answer. The question was
written from the measurements in `docs/merchant-crew-handoff.md` ("Rough-water speed investigation"). The answer
is kept here verbatim. It is a diagnosis and a proposal, not checked against the code by the reviewer beyond
reading it.

## Short version

- **About 300 N of steady wave push is physically plausible** for this hull in Hs 1.5 m (about 5 % of the
  `ρ g B Hs²/16` momentum scale). The model doesn't *establish* it, though: several second-order effects make
  mean forces with nothing tying them together consistently.
- **Barely 1 kn into a fresh wind and sea is possible.** A 12 m/s headwind alone puts about 450 N on the
  merchant's windage, which is more than the crew's ~410 N at Full. Test waves only and wind plus waves
  separately.
- **Historical calibration:** Cariolou's Kyrenia II account reports **0.75 kn with four standing oarsmen** in
  dead calm (16 t, yard raised, sail brailed), and loss of control under oars in about 5–7 kn of wind. Our spec's
  1.8 kn benchmark is contested.
- **Our force tally does not close** (−124 N at rest, +59 N rowing): something isn't being counted. Check the
  momentum balance including the implicit added-mass reaction.
- **Top suspect:** pitch and roll rotating the anisotropic added mass and excitation (heave Ca ≈ 1, surge
  ≈ 0.06), which projects vertical forces into surge. Next: moving sampling points and depth, V × a phase
  correlation, variable added mass without full dynamics, and Gerstner kinematics reused below the surface.
- **Drag:** 10× calm drag at low speed is expected from any quadratic law with zero-mean oscillation
  (`D̄ ≈ 2K·mean|w|·U`), so it isn't proof of double counting alone. Three specific concerns: the steady `Fr⁶`
  wave-making term applied per column, steady lift and induced drag used for oscillatory crossflow, and the 1.4
  astern multiplier rectifying symmetric flow.
- **The 8 s low-pass experiment** doesn't validate or rule out either term: it changed the phases.
- **Proper fix (larger work):** first-order wave loads on the mean geometry plus an explicit mean-drift table,
  `F̄ = Σ a_j² D(ω_j, β_j, U)`, with clear ownership of each second-order term.
- **First diagnostic:** freeze excitation geometry, added mass and its orientation at the mean attitude, and log
  each drag piece separately.

## The reviewer's answer (verbatim)

**300 N is physically plausible. Your present model does not establish that it is the correct force.** The strongest concern is an inconsistent second-order force balance: changing immersion, moving sampling points, rotating anisotropic added mass, and nonlinear drag all generate mean forces, without a complete second-order hydrodynamic model tying them together.

**1. What magnitude of wave resistance is plausible?**

Wave height alone is insufficient. Period, directional spectrum, draft, and motion response matter enormously. A 1.5 m long swell and 1.5 m short chop need not produce comparable resistance.

Your spectrum's peak-frequency formula, evaluated at 12 m/s and 40 km fetch, gives approximately T_p = 4.88 s, λ_p = 37.2 m, λ_p/L = 2.66. That is **not the short-wave limit** for a 14 m hull. Faltinsen's short-wave asymptote should therefore not be applied to the whole spectrum. Reflection and motion-induced resistance need separate treatment; NMRI's hybrid method explicitly makes that distinction. (https://www.nmri.go.jp/en/study/research_organization/fluid/actual_sea_performance/umi-10/Hybrid/kaw_e.html)

A useful dimensional check comes from wave momentum. For deep-water irregular waves, E = ρ g m0 = ρ g Hs²/16. A perfectly reflecting, normally incident vertical barrier experiences mean force E per unit width. Consequently, a reference scale for your hull is F_scale = ρ g B Hs²/16. With B = 4 m and Hs = 1.5 m: F_scale ≈ 5.66 kN. Your 300 N corresponds to an effective coefficient of only C_eff = 300/5656 ≈ 0.053.

**Thus 300 N requires no implausibly large momentum transfer.** This is a dimensional plausibility argument, not a prediction: a floating, transmitting, moving hull behaves very differently from a reflecting wall. The barrier scale is also not a universal upper bound for a resonant three-dimensional body.

For beam seas, using length rather than beam gives a lateral reference scale near 20 kN. A few percent of that is hundreds of newtons. But distinguish sway drift (mean force sideways, generally down-wave) from surge added resistance (mean force opposing forward travel). A stationary, fore–aft symmetric hull in perfectly symmetric beam waves should have zero mean surge force by symmetry, while still experiencing sway drift. Your actual hull, directional spreading, forward speed, and steering break some of those symmetries.

I would regard **hundreds of newtons as credible**, but would not assign this hull a validated head-sea or beam-sea force interval without frequency-dependent calculations or measurements. Mean-drift calculations depend on the combined incident, diffraction, and motion-radiation fields, not displacement and Hs alone. (https://ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/aqwa_thy/aqwathy_2ndO_unidirwaveforce.html)

**2. Is barely 1 kn realistic under six oars?**

**Possible, yes; established historically for these conditions, no.**

First, the historical calibration needs reconciling. Cariolou's Kyrenia II account reports **0.75 kn with four competent standing oarsmen**, on a 16 t vessel, in absolute calm with the yard raised and sail brailed. It also reports loss of oar-only control in approximately 5–7 kn wind. That does not disprove a different trial achieving 1.8 kn, but it prevents treating 1.8 kn as an uncontested general benchmark. (Cariolou, "Kyrenia II", p. 94: https://www.ancientportsantiques.com/wp-content/uploads/Documents/ETUDESarchivees/Navires/Kyrenia/Kyrenia2-Cariolou1997.pdf)

Second, separate human mechanical power from useful towing power: P_crew = 6 × 115 = 690 W, P_effective = T̄ U. Blade slip, recovery, gearing, and immersion reduce effective power. Near zero speed, use the actual thrust–speed curve; a constant-power law would incorrectly allow infinite thrust.

For illustration, approximate calm resistance by R0(U) = 150 U² N and choose 250 W effective power (about 2.3 kn in calm water). Solving 250 = [150 U² + R_extra] U gives: 0 N → 2.30 kn; 100 N → 1.94 kn; 300 N → 1.32 kn; 600 N → 0.78 kn; 750 N → 0.63 kn. These are force-budget examples, not Kyrenia sea-trial predictions.

Wind is decisive here. The merchant configuration (`src/ship/design.ts`, windage) gives approximately F_wind = ½ (1.225)(0.6)(8.5)(12)² ≈ 450 N at rest in a direct headwind. That already exceeds the reported 411 N oar thrust. With comparable thrust, opposing waves would prevent steady forward progress. Therefore, a real 12 m/s headwind plus 1.5 m head sea can plausibly defeat these sweeps. **Wave-only tests and wind-plus-wave tests must be separate.**

**3. Which excitation mechanisms can create an erroneous mean force?**

The column excitation (`physics.ts`, `columnResponse`) is essentially a moving-body Morison approximation, F = ρ V a + A(a − v̇), with added mass moved into the implicit inertia. This is a legitimate approximate structure; it is not a general diffraction solution for a ship. Morison inertia and viscous drag can legitimately coexist.

Expanding the incident-force approximation: V = V0 + V1 + …, a(x0 + ξ) = a1 + (ξ·∇)a1 + a2 + … The mean second-order contribution includes F̄⁽²⁾ ~ ρ [ mean(V1 a1) + V0 mean((ξ·∇)a1) + V0 mean(a2) ], plus orientation, pressure-boundary, diffraction, and radiation contributions. The model includes selected pieces of that expression. Their means need not cancel correctly.

Suspects, in practical order:

| Mechanism | Assessment |
|---|---|
| Pitch/roll rotating anisotropic excitation | High priority. With Ca,heave = 1 and Ca,surge = 0.06, pitch can project substantial vertical excitation into surge. A contribution scales like ρ V (Ca,heave − Ca,surge) mean(θ a_y). |
| Moving depth and horizontal sampling | Produces second-order correlations. Physical ingredients, but unreliable when included without the other terms of the same order. |
| Instantaneous V times acceleration | Can produce a mean through phase-lagged immersion. Not automatically wrong or automatically nonzero. For a fixed column in a linear progressive wave, elevation and horizontal acceleration are in quadrature. |
| Variable added mass with incomplete dynamics | Updating inertia with immersion while keeping only selected Kirchhoff terms is not a complete energy-consistent variable-added-mass model. Simply adding Ȧ v would not by itself fix it. |
| Hybrid Gerstner kinematics | Needs correction or an explicit approximation boundary. |

Applying an anisotropic tensor in hull axes is not itself a mistake. The problem is keeping its nonlinear force projections without the corresponding consistent dynamics and pressure terms.

The wave sampler (`waves.ts`, `sampleFlowAt`) already inverts surface horizontal displacement, so this is not simply "forgot to invert Gerstner coordinates". Instead: the inverse is for the surface and submerged queries reuse those phases; attenuation uses depth below the instantaneous surface; horizontal motion is scaled by the rendering steepness factor q; `accelAtDepth` differentiates the harmonic phase at fixed labels and depth, without all derivatives of the actual sampling map. That is not a consistently defined subsurface Eulerian velocity and acceleration field. At first order some differences are harmless; at second order they affect the mean.

Also, instantaneous-surface buoyancy is only an approximation to vertical wave excitation. It does not generally replace depth-dependent incident pressure for finite kT. Consistent nonlinear Froude–Krylov models integrate incident pressure over the wetted surface (Giorgi et al.).

**4. Why can drag become ten times the calm value?**

Even a valid quadratic viscous law can do this at low mean speed. With relative velocity U + w(t), symmetric zero-mean w and constant K: D̄ = K mean((U+w)|U+w|). Near U = 0, D̄ ≈ 2K mean(|w|) U. For sinusoidal w = a cos ωt, D̄ / (K U²) ≈ 4a / (π U). The ratio grows as U falls. "Ten times calm drag" alone is not proof of double counting. Measure the actual relative-velocity distribution, including hull motion.

Three additional concerns in the implementation:

1. **Steady wave-making resistance is applied locally.** In `resistance.ts` the Fr⁶ coefficient makes its force scale as roughly |v|⁸. That is a steady translating-hull resistance curve, not a column-level oscillatory damping law. Its actual importance at these speeds needs measurement.
2. **Steady lift and induced drag are used for oscillatory crossflow.** `hullLateral.ts` combines crossflow damping with a low-aspect-ratio steady lifting model. Oscillatory wave-relative flow does not automatically support the same developed circulation and induced-drag closure.
3. **The astern coefficient explicitly breaks symmetry.** Longitudinal resistance is multiplied by 1.4 for astern relative flow. Symmetric zero-mean relative velocity then produces a mean force. Fore–aft asymmetry can be physical, but this multiplier must be measured separately.

The proper split: steady viscous/form resistance and steady wave-making resistance for the translating hull; radiation and diffraction from a potential-flow response model; local relative-flow viscous losses where appropriate; oar forces against local water motion; an explicit mean wave-drift model with clearly defined ownership of the second-order terms.

The failed 8 s filter experiment does not validate either original term. It changes the motion and force phase relationships. Filtering orbital flow while leaving hull wave-frequency motion in the drag velocity can also increase relative velocity.

**5. A concrete real-time formulation**

A consistent first-order motion model plus explicit second-order mean loads, keeping the existing column geometry.

Use a slowly translating and yawing reference frame with equilibrium draft and trim. Evaluate first-order wave loads on that mean geometry, not on the instantaneous heaving and pitching geometry. For each component, η_j = a_j cos θ_j, θ_j = k_j·x − ω_j t + φ_j, p_j⁽¹⁾ = ρ g a_j e^(k_j z) cos θ_j, with z from mean sea level. Use matching linear Eulerian velocities and accelerations, without the rendering q multiplier.

Motion equation: (M + A∞) ξ̈ + B_v ξ̇ + C ξ + F_radiation memory = F_excitation⁽¹⁾ + F_propulsion + F_manoeuvring + F̄_wave.

- Compute restoring forces from mean-water hydrostatics; do not also keep instantaneous-wave buoyancy alongside a complete incident-pressure excitation.
- Get first-order excitation and added-mass/radiation coefficients offline, preferably from the actual hull.
- Approximate radiation memory with a small passive state-space model, or a documented narrow-band damping approximation.
- Keep steady wave-making resistance outside the local viscous column law.
- Keep pointwise blade flow for the oars.
- Use separate calibrated viscous roll/crossflow damping.

Explicit mean drift: define D(ω, β, U) = F̄_regular / a². Then for the discrete directional components, **F̄_wave = Σ_j a_j² D(ω_j, β_j, U)**, including surge, sway and yaw as needed. For a one-sided spectrum normalised so ∬S dω dβ = m0, **F̄_wave = 2 ∬ D(ω, β, U) S(ω, β) dω dβ** (factor two from regular-wave variance a²/2; check imported QTF conventions). Inputs: hull geometry and load, speed, relative wave direction, component frequency and amplitude. Precompute a modest frequency–heading–speed table; interpolate and sum at a low update rate. Getting trustworthy coefficients is the real work. Use diagonal drift coefficients for the mean; add difference-frequency QTF terms only if slow-drift variability matters. Do not add the full QTF mean on top of the existing uncontrolled second-order potential-force products.

Provisional closure if coefficients are unavailable: F̄ = Σ_j ½ ρ g a_j² B⊥,j C_j(kL, kT, β, U) k̂_j. A calibratable momentum-scale model, not a validated prediction. C_j cannot be derived from the present constant Ca values; it lacks a general yaw model and should not be presented as Maruo or Faltinsen theory.

**6. What should the tests assert?**

Start with force accounting, then coefficients, then speed. The reported means do not close: 411 − 248 − 104 = +59 N; −325 + 201 = −124 N. For 20 t, sustained residuals of those sizes change velocity over 90 s by about 0.52 kn and 1.08 kn. They indicate omitted forces, remaining acceleration, or coordinate/accounting issues. Assert the vector impulse balance, including all external forces and the solver's added-mass reactions: ΔP = ∫ F_external dt. Use displacement over time for mean track velocity. Report velocity relative to mean current and relative to instantaneous orbital flow separately.

| Test | Assertion |
|---|---|
| Fixed body, first-order monochromatic excitation | Mean tends to zero over complete periods. |
| Small-amplitude scaling | First-order motions scale with a; explicit mean drift scales with a². |
| Mirrored symmetric hull and waves | Corresponding sway/yaw forces reverse; symmetry-forbidden components vanish. |
| Radiation/viscous passivity | Damping cannot generate net energy in still water. |
| Fixed-speed tow | Extra mean tow force matches the selected coefficient model, with viscous changes identified separately. |
| Constant-force tow | Settled speed satisfies the measured force balance. |
| Free drift | Settled drift satisfies the full mean force balance; do not prescribe a universal drift speed. |
| Rowing | Mean thrust, resistance, windage and wave loads close at the measured speed. |

Conditional regression: if added resistance is 300 N at Hs 1.5 m and speed dependence is weak, scaling only amplitudes (same periods and directions) gives R_AW(0.4) = 300 (0.4/1.5)² ≈ 21.3 N. At the 193 N tow force, quadratic calm resistance predicts U/U0 ≈ √((193 − 21.3)/193) = 0.943. So **94 % retention is consistent with that force model; 28 % is not**, unless extra losses, a different spectrum or strong speed dependence explain it. Changing wind speed to change Hs also changes the spectrum, so it isn't a clean amplitude-scaling test.

For drift and rowing, assert the balance against a chosen coefficient and thrust model rather than hard-coding an unsupported "realistic" speed. Run regular-wave sweeps across roughly 0.5 < λ/L < 6, then irregular seas with several phases and convergence checks. A 90 s average may keep substantial beat-frequency bias.

**First diagnostic change:** freeze excitation geometry, added mass and its orientation at the mean attitude, while logging longitudinal friction, steady wave-making, crossflow, induced drag and rotated heave damping separately. That identifies which correlations make the mean. The physical replacement should then give first-order motion and second-order drift explicit, consistent ownership, not tune away a plausible 300 N just to recover a desired rowing speed.
