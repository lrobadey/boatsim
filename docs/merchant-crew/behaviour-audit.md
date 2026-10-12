# Merchant crew rowing: behaviour audit

2026-10-10. Measurement only; no `src/` change. Reproduce with `node scripts/audit-crew-rowing.mjs <calm|ablate|vary|disturb|turn|endurance|whatif> --out=<dir>`.
All figures are means over at least 60 s (most 180–240 s) at dt 1/120. Rough-sea results average two wave seeds; differences under about 2 % are noise.

**How the sea was built.** `new Wind(n)` takes a *seed*, not a speed, so the existing test's "wind 6 / 10" seas were both about 12–14 m/s (Hs 1.7 and 1.5 m). The test also never calls `waves.update()`, so Gerstner steepness q stays 0 and there is **no horizontal orbital flow**. This audit sets `wind.baseSpeed` so the mean wind is U (Hs 0.40 / 1.06 / 1.96 m at 6 / 10 / 14 m/s) and calls `waves.update()` as the game does. A helmsman autopilot holds the course with |helm| ≤ 0.3 (mean 0.02–0.22).

## 1. Effectiveness (calm)

| Order | Steady kn | 1 kn / 2 kn | Efficiency | W per man (positive) | spm | Arc used | Mid-drive blade slip |
|---|---|---|---|---|---|---|---|
| Slow (2 oars) | 1.05 | 192 s / – | 0.31 | 45 | 14.0 | 37° | 0.66 m/s |
| Half | 2.20 | 29 s / 110 s | 0.39 | 78 | 16.3 | 42° | 0.78 m/s |
| Full | 2.47 | 25 s / 71 s | 0.39 | 104 (order says 115) | 18.3 | 37° of 47.6° cap | 0.92 m/s at 1.27 m/s ship speed |
| Back | −1.99 | – | 0.39 | 78 | 15.2 | 44° | 0.80 m/s |

Where Full's work goes: drive 80 %, catch 5 %, recovery 8 %, dip 7 %. Within the drive, 49 % reaches the hull; the rest is lost to slip.

**Historical check (estimates, not verified sources).** Spec datum: Kyrenia II, about 1.8 kn under 4 oars. Scaling to 6 men at about 100 W gives about 2.4 kn. Sustainable power of 75 W for 8 h and 100–150 W for 1 h (Wilson, *Bicycling Science*) fits 104 W at Full as a roughly one-hour effort. Blade efficiency for a heavy boat with narrow sweeps is likely 0.4–0.6, against 0.75–0.85 for racing shells. So 2.47 kn in calm water is plausible, at the top of the range.

**Performance left on the table (parameter what-ifs, calm Full):**

| Change | kn | Note |
|---|---|---|
| none (base) | 2.47 | |
| Full rate 16 spm instead of 18 | **2.52** | arc 44°, efficiency 0.415. Rate 20: 2.42 kn |
| oar inertia 55 kg·m² | 2.51 | |
| blade 0.25 m wide | 2.50 | |
| taper off / lighter | 2.46 | the taper costs nothing |
| no catch match | 2.41 | the skilled catch is worth 0.065 kn |
| delivered power 115 W instead of 104 W | about 2.55 (cube-root estimate) | |

The model is close to its physical ceiling in calm water. The arc is limited by rate (the planner's fits-the-beat rule), not by the cap.

**The big effectiveness problem is the hull in waves, not the crew.** A constant 193 N tow (Full's mean thrust) with the oars shipped:

| Sea | Speed |
|---|---|
| calm | 2.24 kn |
| Hs 0.40 m, head / beam | 0.81 / 0.50 kn |
| Hs 1.06 m, head / beam | 0.67 / 0.42 kn |
| Hs 1.06 m, head, q = 0 (the test harness's sea) | **3.10 kn** |

A single regular 0.2 m wave costs nothing. The loss comes from the full spectrum: `physics.ts` applies per-column quadratic drag and lateral-plane induced drag to the *pointwise* orbital velocity, including short waves. Zero-mean orbital noise rectifies into a large mean drag; that is the likely cause. With the crew rowing Full, speeds are 1.83 / 1.26 / 1.02 kn in head seas (U 6 / 10 / 14) and 0.92 / 0.57 / 0.44 kn in beam seas. In the game's default sea (12 m/s) she rows at about 1.1 kn into the sea and 0.5 kn across it. This is probably the "barely moving" feel, and the crew tests hide it.

## 2. Reading the water: ablation (Full)

Missed water % / blade-depth SD (m) / speed (kn) / J per m:

| Sea | All on | No in-drive depth tracking | All off | No catch shift |
|---|---|---|---|---|
| U6 head | 0.0 / 0.04 / 1.83 / 679 | 5.5 / 0.21 / 1.73 / 720 | 1.7 / 0.15 / 1.78 / 698 | 0.0 / 0.04 / 1.83 / 679 |
| U6 beam | 0.0 / 0.06 / 0.92 / 1360 | 10.1 / 0.27 / 0.76 / 1639 | 7.4 / 0.23 / 0.82 / 1509 | 0.1 / 0.06 / 0.92 / 1357 |
| U10 head | 0.2 / 0.06 / 1.26 / 916 | 8.7 / 0.25 / 1.13 / 1005 | 4.2 / 0.19 / 1.20 / 965 | 0.1 / 0.06 / 1.25 / 923 |
| U10 beam | 1.1 / 0.13 / 0.57 / 2138 | 12.2 / 0.34 / 0.51 / 2368 | 12.9 / 0.31 / 0.51 / 2365 | 1.2 / 0.14 / 0.57 / 2128 |
| U14 head | 1.0 / 0.09 / 1.02 / 886 | 10.6 / 0.28 / 0.95 / 927 | 6.9 / 0.24 / 1.00 / 900 | 0.9 / 0.09 / 1.03 / 877 |
| U14 beam | 2.5 / 0.18 / 0.44 / 2202 | 15.3 / 0.39 / 0.35 / 2508 | 13.4 / 0.35 / 0.36 / 2457 | 2.2 / 0.17 / 0.43 / 2238 |

Verdicts:

- **In-drive depth tracking: earns its keep.** It cuts missed water by 5–13 points and depth SD by 3–4×. Speed rises 5–25 % and energy per metre falls 4–14 %.
- **Catch shift: hurts.** It brings no speed in any sea (±1 %). It wrecks sync: median catch spread rises from 20 ms to 70–150 ms, and p90 to 0.2–1.1 s (skipped beats). Each man shifts his own catch.
- **Catch trim: marginal.** It is worth +2–5 % in beam seas and is neutral to −4 % in head seas. Without tracking, it makes things worse: "tracking off" is below "all off" everywhere.
- **Chop response: does not earn.** Turned off alone, speed changes by +0.4 % to +9 % (head seas gain most) with up to 1 point more missed water. Its sensor saturates in beam seas (k = 0.86–0.94, because it measures the ship's own roll at the blade).
- **Missed-water shortening: dead with tracking on.** It fires on 0–2 % of strokes and the effect is within noise.
- **Track + trim only (shift, chop and missed off):** the same speed as all on (−1.6 % to +4.8 %), with sync restored to 20–28 ms (U14 beam stays at 163 ms).

## 3. Responsiveness and organicness

| Sea | Period CV | Arc (SD) | Peak force CV | Handle-height SD in drive | Median spread (p90) |
|---|---|---|---|---|---|
| calm | 1.4 % | 36.6° (1.0°) | 5 % | 0.1 cm | 22 ms (31) |
| U6 head, shift off | 1.4 % | 33.5° (1.6°) | 4 % | 5.9 cm | 22 ms (31) |
| U10 head, shift off | 1.5 % | 30.6° (3.8°) | 10 % | 6.9 cm | 22 ms (31) |
| U10 beam, shift off | 1.6 % | 25.4° (2.7°) | 8 % | 9.5 cm | 23 ms (32) |
| U14 head, shift off | 8.6 % | 28.8° (6.4°) | 22 % | 8.0 cm | 62 ms (266) |
| U10 head, shift on | 6.0 % | 32.6° (4.2°) | 9 % | 6.9 cm | 153 ms (1087) |

- **The variation inside the stroke is driven by the water.** Drive time correlates with the along-ship orbital surge at r = 0.37–0.78.
- **The rate is a metronome.** With the shift off, the period is 3.284 s in calm, U6 and U10, identical to the millisecond. The recovery absorbs everything. The only period variation in rough water comes from each man's own catch shift (incoherent) or from U14 stalls.
- **A watcher can tell rough from calm** by the shorter arcs (−8 to −30 %), handles working 6–10 cm up and down, recoveries lifted up to 2.5°, and uneven force. **Not** by the rhythm, which either stays a metronome or turns ragged.
- **After a disturbance:**
  - A 0.5 m/s surge kick: short heavy strokes again (arc 37.7° to 32.2°, peak force +8 %), recovered in about 6 strokes; sync unaffected (5–22 ms).
  - Helm hard over for 15 s: the stroke holds water, so no lead catches. The crew re-forms in 2 strokes (170 ms, then 31, then 20 ms).
  - A 0.9 m head-wave group: afterwards the whole crew trails the stroke by 150–300 ms (bow oar up to 0.8 s) for about 45 s (14 strokes). The stroke (K = 0.1) does not wait for his crew.
- **Turning at 2 kn, hard over:** the outer side pulls at share 1.0, the inner side gets −0.77 (backing), but the check rule holds them in **hold water for the whole 90 s**. She settles at 0.73 kn (0.38 m/s, just above the 0.35 m/s rule), so they never back. That gives 87° in 85 s (about 1.0°/s), slower than the 1.6°/s pivot from rest. At half helm the inner side eases to 0.19–0.32: 69° in 85 s, with speed down to 1.3 kn.

## 4. Coordination and endurance (Full, calm, 60 min)

| | 10 min | 30 min | 60 min | Swaps | Median spread |
|---|---|---|---|---|---|
| 8 hands | 2.44 kn | 2.39 | 2.32 | 13 (from 11.5 min, in pairs about 20 s apart) | 17–19 ms |
| 6 hands, no rotation | 2.44 | 2.29 | 2.24 | 0 | 19–21 ms |

Rotation is worth +3.6 % at 1 h. Calm sync is excellent and steady.

## 5. Bugs and dead logic

1. **Test harness sea** (`scripts/test-crew-rowing.mjs`): `Wind(6/10)` are seeds, and there is no `waves.update()`, so there is no horizontal orbital flow. The progress-log figures "wind 6 / 10 / 14" and "3.1 kn in waves" are not what the game produces.
2. **Hull drag in waves** (`physics.ts`, column loop): 64–81 % speed loss at constant thrust in Hs 0.4–1.1 m. It affects every ship.
3. **Missed-water shortening is not gated by `waterRead`** (`stroke.ts` planStroke, `o.missed ? 0.9 : 1`), so the "off" control in the existing gate is not fully off.
4. **Hold latch in turns:** the 0.35 m/s check with hysteresis traps the inner side in hold water.
5. **`leader()` accepts an oar in hold** (it only requires |alloc| > 0.12). During a turn the "stroke" is holding: there is no `catchBeat`, the HUD rate goes stale, and followers time themselves on a stale period.
6. **Delivered power is 104 W, not 115 W:** the allocator's fatigue cost gives shares of 0.92–1.0 even when the crew is fresh, plus about 6 % undershoot in the power controller.
7. **The chop sensor measures the ship's roll** and saturates in beam seas.
8. **`catchShift` extrapolates the hull linearly**, including heave velocity, up to about 1.6 s ahead, and ignores roll and pitch rates.
9. **`telemetry.missedDriveFraction` uses wet < 0.02** while the planner uses wet < 0.3, so a panel would show about 0.
10. **The catch match uses ship speed through the water, not the water velocity at the blade.** In waves the entry slip is off by the orbital velocity (±0.3–0.5 m/s).

## 6. Improvements, in priority order

1. **Must-fix: low-pass the orbital flow the hull drag sees** (`physics.ts`). Average over the hull length, or exclude waves shorter than about the hull. Gate: a towed hull at Hs 0.4 m keeps at least 85 % of its calm speed. Expected (estimate): U10 head from 1.26 kn to about 2 kn. This is the biggest gain available.
2. **Must-fix: build the test sea at a real wind speed and call `waves.update()`** (`test-crew-rowing.mjs`). Re-baseline the water gate.
3. **Must-fix: remove the per-man catch shift** (`coupling.ts` retime, `stroke.ts` beginRecovery). Optionally let only the stroke shift the beat, so followers follow and the rate breathes with the sea. Expected: rough-sea spread from 70–150 ms to about 20 ms at no speed cost, and period CV 1.5 % → 3–5 % that is *coherent*.
4. **High-value: release hold to backing** once the speed is under 0.6 m/s or after 2 s of hold in a turn (`stroke.ts` desiredMode). Expected: hard-over turn at 2 kn from 1.0°/s to about 1.4–1.6°/s.
5. **High-value: `leader()` must require a rowing mode** (`crewRowing.ts`). This keeps the beat, the drum and the HUD rate through turns.
6. **High-value: the stroke waits for a trailing crew.** Raise `Klead` toward 0.4 while the mean follower lag is over 100 ms (`coupling.ts`). Expected: re-gathering after a wave group in 3–4 strokes instead of 14.
7. **High-value: the chop response should lift only the recovery** (keep the dry-dip lift, drop the 15 % arc cut), and measure chop relative to the hull (`water.ts`). Expected: +3–9 % speed in head seas.
8. **Optional:**
   - gate `missed` by `waterRead`;
   - give Full a 16–17 spm rate target (+0.05 kn);
   - make shares exactly 1 for fresh men at full demand (+0.08 kn);
   - catch match against the orbital flow at the blade;
   - make `missedDriveFraction` use wet < 0.3.
