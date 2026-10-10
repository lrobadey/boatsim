# Sailing performance tuning

Follow-up scope: the user requested a more consequential wind contribution and clarified a target of **8 knots with sail plus Full rowing in favorable wind**. The user explicitly excluded Astra from this pass. The lead owns the decisions and integration; the existing GPT-6 Luna high workers execute the defined source, measurement and test tasks.

## Frozen changes

- The loaded-sail pressure-drag coefficient increases from 1.25 to 1.7. This is a gameplay calibration of an engineering approximation, not a measured historical coefficient. Profile drag, lift, separation, induced drag, apparent air, shared rig geometry and load application points retain their definitions. Both the force integration and trim search use the same evaluator.
- Prevailing wind at the 10 m reference height changes from 8 to 12 m/s (about 23 knots). Actual wind still varies with seed, time, position, height and gusts. The sea continues responding to slow mean wind through its existing spectrum; it is not held artificially calm to preserve a speed result.
- Crew trim's lateral-load preference becomes `0.22 + 1.8*smoothstep(8°,18°,abs(heel))`. This preference applies equally to current and candidate yard scores. The crew can sacrifice drive to reduce sideways load as heel builds, by moving the actual yard at its existing finite rate. It is not a force limiter or guaranteed heel cap. Manual trim remains under player control.
- The automatic-trim slew preference increases from 120 to 300 N/rad to discourage yard hunting under the stronger loads. The four-Hz schedule, candidate set, physical yard rate and original convergence tolerances remain intact.
- The opt-in review setup accepts a bounded `sailingWind` reference speed and exposes actual wind/sea telemetry. Normal gameplay does not gain a speed override.

Rowing power, stamina, per-oar geometry/contact, hull resistance, hull lateral balance, mast/sail dimensions, deployment/fill timing, yard limits and player-facing interface are outside this tuning scope. There is no hard speed cap or propulsion-mode bonus.

## Why these changes

At 8 knots in an 8 m/s following wind, the original moving sail supplied only about 829 N while the one-step still-water resistance estimate was 7.35 kN. Apparent wind necessarily falls as the ship accelerates. Multiplying every force enough to achieve the target in that breeze would make sideways and opposing loads excessive.

The pre-change uniform following-wind measurements averaged 6.877/7.347/7.724/8.209 knots combined at 8/12/14/16 m/s respectively. A modest coefficient adjustment and fresher prevailing wind bring useful assistance into a more accessible part of the wind envelope. The 8-knot acceptance condition is **14 m/s steady following wind**, flat deep water, automatic trim, full sail and Full rowing, simulated for 120 seconds and averaged over the last 30. It is a favorable-condition target, not an all-weather guarantee.

Crosswind measurements revealed the coupled risk: the original full-sail configuration already reached about 34.5° maximum heel in the 14 m/s beam-wind fixture; the first pressure-drag tuning reached about 35°. Half sail reduced this substantially. This evidence prompted the bounded heel response in automatic trim, rather than changes to hull stability or hidden force clipping.

## Historical context and fidelity

The [Trireme Trust's Olympias trial summary](https://eodg.atm.ox.ac.uk/user/dudhia/rowing/trireme/poster.pdf) reports cruising under oars up to 6 knots over more than 30 miles, a sprint just under 9 knots, and a momentary 10.8 knots under sail in a following gust. These are different conditions and durations. They support 8 knots as a plausible favorable-condition gameplay goal, but do not calibrate this app's coefficients or establish a sustained combined-propulsion polar. The reconstruction also carried a boat-sail in addition to its mainsail, unlike this app's single sail.

The retained apparent-flow, distributed-force and passive lift/drag structure follows the [Robotic Sailing 2018 dynamic model](https://ceur-ws.org/Vol-2331/paper3.pdf). Neither that paper nor the trial summary supplies the new 1.7 coefficient. The model still omits cloth mechanics, terrain airflow, historical performance calibration, damage and storm survival.

## Verification

Results will be recorded after integration. [Baseline and staged measurements](sailing-tuning-baseline.json) distinguish pre-change, initial coefficient/weather tuning and final verification. Intermediate runs preceding heel relief are evidence of the problem, not acceptance of the final controller.

Run `npm run test:sailing-tuning` for the target envelope, calm/headwind behavior, reef load/heel, automatic heel relief, convergence and seeded wind/wave coupling. The original sailing and rowing suites remain required. Original reports and Astra's earlier signoff describe the earlier implementation; the follow-up is reviewed and accepted by the lead.
