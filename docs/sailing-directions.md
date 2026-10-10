# Sailing evolution: three directions

The intended outcome is a square-rigged trireme whose wind-only, rowing-only, and combined propulsion differ through the same coupled physical system. Preserve existing per-oar contact/force/animation identity. Lead and GPT-6 Astra own design; GPT-6 Luna workers implement a frozen spec. No browser testing unless the user explicitly requests it.

## 1. Performance polar and improved global breeze

Replace the current normal-force approximation with a heading/speed polar, finite trim, calm support, and clearer sail status. This is inexpensive and easy to tune, but a prescribed speed/drive map obscures the relationship between yard position, apparent wind, leeway, heel, and rowing. It improves the envelope without substantially deepening the system.

## 2. Coupled square rig, coherent wind, and hydrodynamic balance (recommended)

Model the existing single square sail with a small fixed set of distributed aerodynamic load samples, continuous attached/separated lift and drag, local rigid-body apparent wind, bounded filling/luffing, finite yard motion, and partial brailing/reefing. Use the rendered rig dimensions as shared geometry. Add a dissipative shallow-hull lateral model so useful sail drive carries leeway and induced-resistance costs. Wind supports actual calm, height shear referenced to 10 m, and deterministic continuous spatial/temporal gusts while the sea follows the slower mean.

Retain automatic crew trim as the default, with optional direct yard control and partial sail area. A restrained existing-HUD extension explains what the ship is doing through apparent-wind bearing, draw/luff/aback state, leeway, and an understated wind/rowing balance. Loaded cloth and flutter use the same physical state; gust loads create real roll/yaw. Wind-only conserves crew stamina but loses authority near the wind; rowing can carry the ship through a turn while shifting apparent wind and sail loading; rowing-only remains precise at low speed and incurs crew work. No synthetic propulsion-mode multipliers.

This is a substantial systemic change with deterministic acceptance tests and a modest fixed workload. Its aerodynamic coefficients and hull corrections are engineering approximations, not a claim of CFD or measured Olympias calibration.

## 3. Aeroelastic cloth and local airflow solver

Replace the sail with tensioned cloth and many aerodynamic panels, coupled to terrain flow and dynamic hull hydrodynamics. This can eventually model detailed fabric response and turbulent interaction, but requires material/rig calibration and substantial numerical/performance work. Without experimental data, extra resolution does not establish accuracy. It is poorly matched to the app's present single-sail geometry and acceptance infrastructure.

## Research basis and current defects

- [Dynamic Simulation Model for an Autonomous Sailboat, Robotic Sailing 2018](https://ceur-ws.org/Vol-2331/paper3.pdf): relative flow at a surface includes translation and rotational velocity; forces resolve into lift and drag, with continuous separation and induced drag, applied at physical points.
- [Bradbury, An experimental investigation of the flow past hulls at leeway](https://www.sciencedirect.com/science/article/pii/0167610585900200): a shallow hull generates lateral lift with considerable drag cost. Use this as qualitative support, not trireme coefficients.
- [Lasher, CFD Analysis of the Survivability of a Square-Rigged Sailing Vessel](https://www.tandfonline.com/doi/abs/10.1080/19942060.2009.11015255): square-rig sail loads and heel depend on wind and sail configuration; experimentally validated detailed models are a separate fidelity tier.
- [Trireme Olympias: The Final Report](https://www.jstor.org/stable/j.ctvh1dqmv): reconstruction trials support sailing capability and maneuverability but do not give this app a calibrated polar.

Current source: `src/ship/physics.ts` uses one plate at a fixed center, constant 1.12 wind shear, translation-only apparent wind, and a forward-force-only trim search. Cloth pressure sign derives from forward thrust rather than which face is loaded. `src/world/wind.ts` clamps speed to at least 0.5 m/s. Rendered sail is 10 × 7 m while physics assumes 58 m². `src/ship/trireme.ts` filters cloth per rendered frame. Existing lateral hull resistance is diagonal crossflow drag rather than a coupled lift/drag balance.

## Requested Astra decision

Review all three directions, choose and refine one, and jointly specify the physical formulas, signs, geometry, contracts, control bindings, restrained interface changes, bounded implementation ownership, and decisive tests. Workers must not choose mechanics or calibrate arbitrary advantages. Preserve the existing controls and rowing behavior. User specifically requests a substantial step up in systemic design and gameplay with intuitive, subtle UI.
