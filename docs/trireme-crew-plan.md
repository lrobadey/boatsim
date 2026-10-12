# Trireme crew rowing: plan and record

The trireme's 170 oars moved from the scripted `RowingSystem` (`oars.system: 'banks'`) to the agent crew
(`CrewRowing`, `src/ship/crew/`) that the merchant already rows with (docs/merchant-crew-spec.md). Done
2026-10-10. Nothing is committed.

## 1. Decisions (the user's)

| Question | Decision |
|---|---|
| Rower figures | None for the trireme: the rowers are inside the hull. The oars must still look right, shipping included. |
| Speed | Let it emerge from rower and oar physics. Re-baseline the speed gates instead of tuning to the old numbers. |
| Slow | All 170 oars row easy (no watches by bank). |
| Old system | Kept in `rowing.ts`, selectable as `oars.system: 'banks'`; its own suite (`test-rowing`) runs on it. Remove later. |
| Ramming speed | A crew-wide drop to Full when the crew is spent; each man still tires at his own rate. |

## 2. Plan as run

1. **Generalise the crew without moving the merchant.** Every change behind a parameter whose merchant value keeps
   the old behaviour; checked after each step with an exact merchant trace (`scripts/trace-merchant.mjs`, 400
   frames of hull state and every oar joint through orders, turns, hold water, shipping and a sea): identical.
2. **The trireme's parameters** (`TRIREME_CREW`, `src/ship/crew/params.ts`), the design switch, physical shipping.
3. **Measure** (`scripts/measure-trireme-rowing.mjs`) and fix what the measurements showed (§4).
4. **Tests:** a new suite, `scripts/test-trireme-crew.mjs`; the old suites pointed at what they test; bands
   re-based where speed was a target.
5. **Browser:** the game, the rowing review scenes, oar pose continuity, back water at speed.

## 3. What changed

`src/ship/crew/`:

| Change | Where | Merchant |
|---|---|---|
| `layout` (oar slots from `oarSlots()`), `banks` (per-bank `handR`, `Ioar`, `addedMass` on each `Oar`) | params, oar, stroke, coupling, sweepDynamics | `stations` as before |
| `sightRange`, `crossDeck`: whom a man sees and hears; sight along his own bank below decks | coupling | Infinity, true |
| `wCall`: the keleustes' call carries the stroke's beat to all; with it a man expects his neighbours one called beat after their last catch; the stroke is paced to the whole crew's mean catch | coupling | 0 |
| `catchUp`: a man behind the called beat shortens his next stroke | stroke | false |
| `recoveryEffort`: recovery push rises with the power asked beyond critical power | oar, stroke, coupling, sweepDynamics | false |
| `addedMassRelative`: the entrained water is picked up at the sea's own sweep rate and its inertial force reaches the hull (§4.3) | sweepDynamics | false |
| `shipRipple`: span of the bow-to-stern shipping ripple | stroke | 14 (as the old literal) |
| `animated`: fill the per-hand view only when rowers are drawn | crewRowing | true |
| Ramming speed drops to Full at a mean reserve of 0.35 | crewRowing | no ramming order |

Outside: `design.ts` (trireme `system: 'crew'`, `crew: TRIREME_CREW`), `trireme.ts` (no visual stow for a crew:
shipping is physical), `game.ts` (rower figures and their colliders only for an animated crew; the trireme's
marines and archers keep theirs), comments in `oarPropulsion.ts` and `physics.ts`, README.

## 4. What the measurements found

### 4.1 Timing on a 37 m ship

With the merchant's coupling, the crew did not keep time: catches spread over a whole beat, in a travelling wave
from stern to bow, and at Half most of the crew settled half a beat out. Three causes, each fixed physically:

- Each man predicted a neighbour's next catch from that neighbour's own last interval. Across 170 men those
  slightly long intervals reinforced one another into a slower crew rhythm than the stroke's. With a call, the
  cadence is common knowledge: he expects his neighbours one called beat on.
- Each man weighted about 23 nearby oars, mostly by ear, against the call, so a late block kept itself late. In
  the din of 170 oars no single catch can be picked out by ear; a man sees the back of the one or two men ahead of
  him in his bank (`sightRange` 1 m, `wAudible` 0.02).
- The stroke man waited for a trailing crew only by what he perceives, the on-time oars beside him at the stern.
  The keleustes faces the whole crew; the stroke is now paced to their mean catch.

Plus `catchUp`: a stroke that fills the whole beat leaves no time to catch up, so a late man stays late.

Result: every order and every ramming call from 30 to 44 spm locks within 92–133 ms.

### 4.2 The oars are heavy

The rowers' work at Full went 45 % into the water. Half the loss was swinging the oar: accelerating it and
braking it again every stroke, which grows steeply with stroke rate. The first inertia estimate (a uniform rod)
was too high. Olympias' oars weighed 26 lb, 11.8 kg (Christian Science Monitor, 25 Aug 1988), with a heavy
inboard loom whose mass near the thole adds little inertia: 24 / 20 / 17 kg m² for the 4.5 / 4.2 / 3.9 m oars
(derivation in `params.ts`).

### 4.3 A physics gap in the sweep model: entrained water

`SweepDynamics` put the blade's added mass into the oar's inertia as if the water were at rest relative to the
hull. Two consequences:

- A blade entering at the water's speed (the skilled catch) lost about 60 % of its sweep rate as it wetted.
- The force of accelerating that water never reached the hull as thrust; it was braked or shed at every finish.

With `addedMassRelative`, the water is picked up at its own sweep rate (the rate at which the blade has no normal
slip) and its inertial force, −d/dt(I_add (ω − ω_f)), is a water force on the blade, applied to the hull like the
drag. Full went from 4.5 to 5.2 kn and efficiency from 0.23 to 0.35 on this change alone. Pickup loss is now
0.5 W per oar.

This is a fix to shared code, switched on for the trireme only. **The merchant has the same gap** (see §7).

### 4.4 Stroke rate

At ramming power the crew is fastest near 33–34 spm; faster calls shorten the stroke and spend more of each man's
work swinging the oar (5.95 kn at 34, 5.84 at 36, 5.13 at 44). Ramming speed is called at 36. Olympias counted up
to 48 spm in her sprints, so this is a known disagreement (§7).

## 5. Measured (calm water unless noted; `npm run test:trireme-crew`, docs/trireme-crew/test-results.json)

| | Agent crew | Old scripted banks |
|---|---|---|
| Slow (18 spm called) | 4.23 kn, 17.7 spm, 72° arc | 3.97 kn |
| Half (26) | 4.80 kn, 25.6 spm | 5.63 kn |
| Full (31) | 5.44 kn, 30.5 spm, 51° arc, 134 W a man, efficiency 0.38 | 6.67 kn |
| Back water | −3.90 kn | −3.60 kn |
| Ramming speed (36) | best 5 s 5.97 kn from 5.45; drops to Full after 197 s | 7.91 kn; dropped after 135 s |
| Catch spread | 92–133 ms at every order and ramming call | (all oars on one controller) |
| Hold water from Full | stopped in 8.7 m | |
| Pivot from rest, Slow, hard over | 112° in 60 s at ≤ 0.32 kn | |
| Hard over at Full | 1.50°/s; oars up 0.67°/s | |
| Wind 10 m/s sea, Full | 4.3–4.5 kn, missed water 0 %, max heel 7.2° | |
| Following 14 m/s wind | row only 5.66 kn, rowing + full sail 8.56, sail only 8.10 | 6.76 / 8.08 / 8.10 |
| CPU, full physics step | 0.27 ms mean, 0.44 ms p95 | 0.98 ms |

Against the Olympias trials:

| | Olympias | Here |
|---|---|---|
| Sustained | about 4–5 kn (later reassessments, via secondary sources); "just over 5 kn" (Wallinga, via Rankov) | Full 5.4 kn at critical power |
| Sprint | 9 kn (1987), 9.6 kn (1988); 0–7 kn in 32 s | 6.0 kn |
| Delivered power, sprint | about 80–120 W a man (Rankov 2012, Table 4.2; about 120 rowers, 42–44 spm) | about 55–60 W a man |
| Sprint stroke rate | up to 48 spm | best at 33–34 |
| Turn | 180° within one minute; 2.6°/s | 1.5°/s hard over at Full |

The sustained speed agrees; the sprint is slower and the turn slower. The hull's resistance is not part of this
work (its coefficients are unchanged); at 6.3 kn it needs an estimated 13.7 kW (scaled as v³ from the measured 9.0 kW at 5.47 kn), the top of Rankov's 9.9–14.1 kW, so
most of the sprint gap is in the rowing.

## 6. Tests

- New: `npm run test:trireme-crew` (10 tests, about 80 s). Speed bands there are regression bands around §5, not
  targets.
- `test-rowing` now runs its whole-ship checks on `system: 'banks'` (it is the old system's acceptance suite);
  `measure-rowing.mjs` likewise.
- `test-sailing-tuning`: the combined and row-only bands re-based to the measured 8.56 / 5.66 kn (they were the
  original 7.8–8.3 / 6.5–7.0 kn design targets); every structural check is unchanged and passes.
- `test-golden`: re-recorded (the trireme's trace changes by design).
- Unchanged and passing: test-crew-rowing, test-rowers, test-crew-solids, test-merchant, test-mooring,
  test-sailing, test-walker, test-camera, test-build, typecheck.
- **Not mine, failing:** `test-hull-waves` fails two merchant tow checks (calm tow 2.52 kn against 2.24 kn
  expected). The merchant's rowing trace is identical before and after this work, and none of these changes is
  switched on for her; another session was editing `physics.ts` and the hull code at the time.

## 7. Open questions for the user

1. **The merchant has the same entrained-water gap (§4.3).** Turning on `addedMassRelative` for her would raise
   her speed and efficiency and re-base her crew tests. Recommended, as its own step.
2. **High stroke rates are slower here than on Olympias.** Likely causes, in order: the recovery is planned as a
   rest-to-rest minimum-jerk swing, with no use of the oar's momentum or the rower's body; catch and extraction are
   a fixed 0.15 s each (0.1 s helped the sprint but cost Full: not understood yet); the fixed-seat force-velocity
   numbers are estimates. Worth a focused pass if the sprint matters.
3. **Hold water is very strong** (8.7 m from 5.4 kn): 170 blades held square, bounded by each man's grip. Plausible
   for a full crew, but untested against any source.
4. `catchUp` and `recoveryEffort` would probably help the merchant too; off for her for now.
5. The old `RowingSystem` can be removed once the trireme crew is accepted.

## 8. Sources

- Olympias trials: [Christian Science Monitor, 25 Aug 1988](https://www.csmonitor.com/1988/0825/dtri.html) (oar
  weight, 9.6 kn, 0–7 kn in 32 s, 48 spm, 2.6°/s turns); [Wikipedia: Olympias](https://en.wikipedia.org/wiki/Olympias_(trireme))
  (9 kn in 1987, 180° within a minute, 62/54/54 oars by bank).
- Rankov, *Trireme Olympias: The Final Report* (2012), Table 4.2, via docs/rowing-spec.md;
  [Rankov, "The Athenian trireme: lessons from Olympias"](https://eodg.atm.ox.ac.uk/user/dudhia/rowing/trireme/ttrankov2.html)
  (stroke too short to cruise at 7–8 kn; Wallinga's "just over 5 kn").
