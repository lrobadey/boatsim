# Mechanical propulsion for an antiquity-inspired world

October 22, 2026. Design exploration requested by the user; no propulsion mechanism
is implemented or selected. Existing browser and main-game behavior are unchanged.

## The design opportunity

Make the machinery a physical part of the vessel: working galleries, shafts,
replaceable wooden teeth, bronze bearing surfaces, clutches and independently
controlled port/starboard drives. The player commands a crew and a mechanism;
food, fatigue, upkeep, dimensions and available power determine what happens.

Separate the power source (people, animals or wind), transmission (treadles,
treadmills, capstans and gearing), and propulsor (paddles, screws or oscillating
blades). A new propulsor can improve control and power matching; its energy still
comes from its source. Gearing exchanges torque and rotational speed, with losses.

The setting has a particularly relevant historical starting point. The fourth-century
*De Rebus Bellicis* describes an ox-powered paddle ship. The surviving proposal is
not evidence of a ship actually built; the modern reconstruction is virtual, not
a verified full-scale sea trial. [Fleury and Madeleine, CAA proceedings](https://proceedings.caaconference.org/files/2011/14_Fleury_Madeleine_CAA2011.pdf).
Later animal-powered ferries have archaeological evidence, including gears and
two paddle wheels on the Burlington Bay wreck.
[Lake Champlain Maritime Museum](https://www.lcmm.org/archaeology/vermont-underwater-historic-preserves/horse-ferry/).

## Three principal directions

### 1. Human-powered twin paddle ship

Teams operate foot treadles, reciprocating beams, or walking mechanisms. A flywheel
smooths the cyclic input; gearing drives a paddle wheel on each side. Each drive
has its own engagement and direction control. The outside retains a shipwright's
material language: timber wheels, framed paddle galleries and metal hubs.

This is my first candidate for a mechanism prototype. Human power is already
represented by the game, so a new conversion mechanism can be compared at equal
source power. It gives the helmsman a controllable ahead/astern drive while keeping
labor, fatigue and wages consequential. A mechanism does not automatically outperform
well-designed oars; improved ergonomics and hydrodynamics must be measured.

Questions to test: wheel immersion through trim and waves, entry/exit losses,
reversing delay, sailing drag, independent steering, debris and repair access.
Articulating/feathering paddles would be a later mechanism experiment, not an
automatic efficiency bonus. Mounting and dimensions remain open; outboard wheels
increase berth width, and stern installations change appendage clearance.

### 2. Ox-powered millship

Animal teams drive circular mills on a broad machinery deck, or longitudinal
treadmills housed in the demihulls. The two drive trains remain independently
controllable. A human team could take a work station through an appropriate
transmission, but equal headcount does not imply equal power.

Circular animal walks are a poor fit inside a 6.6 m demihull: they require a real
layout study. Treadmills fit a long hull more naturally but introduce belts/slats,
rollers, traction and animal-footing problems. Put animal work where roll, pitch,
ventilation, access and structure permit; a calm-water success does not establish
open-sea operability. Feed, fresh water, rest, handlers and cleaning use real space.

The control mechanism needs to absorb changes in load. Engaging a clutch should not
instantly stop or accelerate the animals. Reversing the output needs an actual
reversing train or another mechanical arrangement; it need not require an animal
to walk backward. FAO identifies source/load speed matching and delayed, variable
animal effort as important design constraints.
[FAO, animal-to-machine mechanisms](https://www.fao.org/4/x5455b/x5455b0z.htm).

This direction gives a vessel the character of a moving estate: powerful labor
arrangements and a substantial service economy. It is best explored as auxiliary
propulsion and port handling before assuming fast, continuous ocean travel.

### 3. Twin screws powered by people or animals

The same working machinery drives two submerged screws near the sterns. Proposed
construction could use carved wooden blades on metal hubs, supported shafts and
accessible bearings. The fabrication challenge is an extrapolation of craft skills:
blade form, balance, axial thrust support, alignment and hull sealing all matter.
It is not a validated antique construction specification.

Wooden screw propulsion has historical working precedents: the Science Museum
records Francis Petit Smith's wooden screw in tests in 1837.
[Science Museum Group](https://collection.sciencemuseumgroup.org.uk/people/ap26698/smith-francis-petit).
This supports material plausibility, not a claim that large ancient propellers
would have modern efficiency or that their power transmission is easy to build.

This is the strongest candidate for retaining Thalassa's exterior silhouette while
adding concealed machinery. Two shafts permit differential thrust. Rudders could
use screw wash only if their placement and the simulated flow actually provide it.
Vulnerability shifts toward shafts, seals, underwater repairs and grounding clearance.

## A more experimental energy source: wind driving a screw

A cloth-and-timber wind rotor could drive a screw through gearing. The working
principle is real: full-scale trials of the 5.6 m *Falcon* included upwind travel.
[Bose and Small, 1985](https://doi.org/10.1016/0167-6105(85)90022-4).
Antiquity-style implementation and scaling to Thalassa remain conjectural.

This could be a distinctive experimental ship rather than a universal upgrade.
It depends on wind, adds machinery and elevated loads, and changes the silhouette.
A model must include the turbine's aerodynamic force as well as delivered shaft
power; ignoring its opposing drag could invent propulsion. It does not provide
calm-weather energy merely because the output device is a propeller.

## What the preliminary power budget allows

Run `node ship-study/propulsion/budget.mjs` from the repository root. It reads the
existing tow measurements and writes `budget.json`. It performs arithmetic and
interpolation only: no new propulsion, seakeeping or maneuvering simulation.

Illustrative active-work inputs: **100 W/person**, **350 W/ox**. FAO shows substantial
duration/individual variation and uses 350 W for five working hours in one oxen
sizing example. These are watch scenarios, not all-day output guarantees.
[FAO, human and animal power](https://www.fao.org/4/ah810e/ah810e08.htm).

Assume 80% transmission efficiency and 55% propulsive efficiency: **44% overall**
from source mechanical work to effective hull power. These efficiencies are trial
assumptions, not measurements of these proposed devices. The earlier browser's
60% figure starts at the propulsor input; it does not include this extra gear loss.

| Calm steady speed | Hull power from current tow model | Required source mechanical power | Active people | Active oxen |
|---|---:|---:|---:|---:|
| 2 kn | 1.8 kW | 4.1 kW | 42 | 12 |
| 3 kn | 5.8 kW | 13.2 kW | 132 | 38 |
| 4 kn | 13.2 kW | 30.0 kW | 301 | 86 |
| 6 kn | 42.3 kW | 96.1 kW | 962 | 275 |

For example, 24 oxen supply 8.4 kW gross and 3.7 kW effective under these assumptions;
interpolating the current curve gives about 2.6 kn after settling. Forty-eight give
about 3.3 kn. These counts are working teams, before relief capacity. They are
provisional game-model estimates, not real-ship predictions. The tow curve omits
catamaran interference and fixes the existing design displacement; the extra mass
of machinery, animals, accommodation and provisions needs a separate budget.

Acceleration and turns demand more than steady travel. In the previous trial,
6.4 kN from rest reached only 2.7 kn after six minutes, despite being near the
calculated steady requirement at 4 kn. A compact auxiliary drive can therefore
be useful even when sails remain the main passage power.

At hull-centre positions 17 m apart, equal opposing 10 kN forces make 170 kNm yaw
torque and zero net surge. This is a lever-arm calculation, not a turn-time prediction.
Actual achievable thrust at low speed must come from the wheel/screw load model.
Do not implement fixed power as `force = power / shipSpeed`: it becomes singular
at rest and would give fictional starting/steering authority. Use finite source
torque, gear ratio, drive inertia and water loading, including bollard conditions.

## Useful gameplay consequences

- **Helm commands:** port/starboard effort, ahead/neutral/astern, and a captain's
  maneuver command that coordinates actual machinery and crew inputs.
- **Physical presence:** visible moving mechanisms, load-dependent sound, access
  galleries and repair work. Retain intimate movement around the machinery.
- **Operating choices:** spend labor/feed for precise harbor handling; use favorable
  wind for passages; retain a tender for places the ship's draft/beam excludes.
- **Consequences:** crew fatigue, animal footing and reserve, worn teeth, shaft drag,
  damage or poor trim reduce the capabilities produced by the machinery itself.
- **Modularity:** winches or pumps might share a suitable power source through a
  clutch; the available shaft power must be allocated rather than duplicated.

A flywheel can smooth effort and brief transients. It is not an unlimited battery:
a 1 t rim at radius 2 m and 60 rpm stores about 79 kJ, under four ideal seconds at
20 kW. A 10 t weight dropping 5 m stores 491 kJ, about 25 ideal seconds at 20 kW,
before losses. Large stored-energy bursts need explicit space, mass and recharging.

## Suggested next comparison, not an approved implementation plan

Compare twin paddle wheels and twin screws at equal source power, with 10, 20 and
30 kW working inputs. Measure speed-up, stopping, near-rest 90° turns, underway
turning, effective power and source effort. Add mechanism mass/drag and then waves.
Start with a generic torque source to isolate propulsor behavior; attach human and
animal source models afterward. Preserve the existing oar trial as the reference.

My present preference is to prototype the human-powered twin paddle mechanism first,
then compare the same input driving twin screws. Ox-powered operation is a distinct
source/layout experiment. No choice here is a commitment by the user.

The implemented twin-wheel experiment is now described in [TWIN-PADDLES.md](TWIN-PADDLES.md).
It uses the full port-5175 open-sea Thalassa build, with a new Blender retrofit and finite
shaft/blade dynamics. The older budgets above remain comparison assumptions, rather than
results from this mechanism.
