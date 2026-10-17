# BoatSim — Expanded Vision & Design Philosophy
Strategic Context for Future Development
October 16, 2026

## Purpose

This document captures a significant evolution in the vision for BoatSim (working title). It is intended to provide a coding agent with the conceptual context, design priorities, and long-term direction necessary to make architectural decisions consistent with the project's ambitions.

This is a vision document, NOT an implementation request. Do not begin implementing these ideas without explicit authorization. The purpose is to preserve the thinking, establish guiding principles, and inform future technical planning.

## 1. The fundamental vision

BoatSim is not ultimately intended to be a conventional sailing simulator or a trading simulator.

The emerging vision is a PERSISTENT, SYSTEMIC MARITIME CIVILIZATION SIMULATOR.

The player begins as an individual with a small vessel in a living, independently functioning world. Through interaction with the world's physical, economic, social, and political systems, they can gradually acquire wealth, relationships, ships, businesses, influence, and potentially enormous power.

The ultimate fantasy is not simply becoming wealthy. It is beginning as one person in a functioning world and gradually becoming capable of shaping that world.

Possible player identities include:

- Sailor and navigator
- Independent merchant
- Shipbuilder and shipowner
- Explorer
- Fleet operator
- Trading magnate
- Political power broker
- Founder of settlements or commercial institutions
- Someone who simply enjoys living aboard and customizing a ship

These should NOT necessarily be predefined classes, progression trees, or mutually exclusive career paths.

They should emerge from what the player owns, knows, builds, controls, and accomplishes.

The world must continue functioning independently of the player.

The player is a participant in the simulation, not its center.

The fundamental aspiration is to combine the systemic depth and strategic scope of games like Victoria 3 with the intimacy and physical presence of a first-person simulation.

## 2. Connection to Chronicle

This vision draws heavily from the user's earlier project, Chronicle: a persistent, living, breathing simulated world.

The central ideas are:

- An objective world state exists independently of AI-generated narration.
- Characters have persistent identities, histories, memories, relationships, resources, and objectives.
- Individuals possess incomplete and sometimes incorrect knowledge of the world.
- Events emerge from interacting systems rather than being invented on demand.
- Economic, social, political, and physical changes persist and have consequences.
- LLMs allow players to interact naturally with the simulation, but do not constitute the underlying simulation.
- The world's history develops through actual simulated events.

BoatSim potentially offers a more concrete, constrained realization of Chronicle.

Its maritime setting provides a strong physical foundation: ships, harbors, geography, weather, transport, trade, and travel.

The player's physical presence aboard a vessel grounds what might otherwise become an abstract civilization simulation.

The aspiration is to make a world that feels as though it exists whether or not the player is observing it.

## 3. Core philosophy: capabilities, not scripts

THIS IS THE MOST IMPORTANT DESIGN PRINCIPLE.

The developer should prioritize implementing general-purpose systems, capabilities, and constraints rather than predefined gameplay situations or solutions.

The goal is not to anticipate every interesting thing a player might do.

The goal is to construct systems flexible enough that interesting behavior emerges when they interact.

EXAMPLE: MASSIVE SHIP AND TENDER

Imagine the player constructs an enormous, multi-deck flagship.

Its size and draft make it impossible to enter a shallow harbor.

The game should NOT need a special scripted mechanic saying:

"Your ship is too large. You must use a tender."

Instead:

1. The ship has physically simulated dimensions and draft.
2. The harbor has actual water depth.
3. Grounding and collision are simulated.
4. The player approaches the harbor and discovers that the vessel cannot safely proceed.
5. The player can anchor offshore.
6. Because smaller boats exist as independent, usable vessels, they can deploy a tender and travel ashore.
7. The tender can also be used anywhere else, for any purpose its general capabilities permit.

This is emergent gameplay.

There is no dedicated "use tender to access harbor" mechanic.

There are simply vessels, water depth, anchoring, transportation, and player movement.

The combination creates the solution.

Other possible emergent solutions:

- Hire another ship to transport supplies.
- Use smaller cargo boats to transfer goods.
- Construct or finance a deeper harbor.
- Negotiate access to another port.
- Establish offshore storage or trading operations.
- Operate a floating headquarters.

These should follow from reusable systems wherever feasible.

DESIGN RULE:

Program capabilities and constraints, not predetermined solutions.

This does NOT mean avoiding explicit programming.

Physics, economics, property rights, contracts, movement, construction, ownership, and AI decision-making all require carefully defined rules.

The objective is composability: systems should work together without requiring special-case gameplay scripts for every combination.

## 4. Modular shipbuilding and floating homes

One of the most exciting long-term possibilities is a highly modular shipbuilding system.

Ships should not merely be selectable vehicles with predefined statistics.

They should become physical spaces the player can design, construct, inhabit, operate, and continually modify.

Potential construction variables:

- Hull form and dimensions
- Draft, displacement, stability, and mass distribution
- Number and arrangement of decks
- Internal rooms and compartments
- Cabins and living quarters
- Kitchens and canteens
- Lavatories and sanitation
- Storage rooms and cargo holds
- Workshops
- Crew accommodations
- Masts and sails
- Rowing stations
- Steering systems
- Anchoring equipment
- Propulsion machinery
- Auxiliary boats and tenders
- Lighting and furnishings
- Defensive equipment, potentially

The aspiration includes VERY LARGE vessels.

A player might eventually operate an enormous, multi-deck flagship that serves simultaneously as:

- Their home
- Their commercial headquarters
- Their transport vessel
- Their workshop
- Their fleet's command center
- A floating settlement of sorts

Crucially, a bigger ship is not simply an upgrade.

It creates new capabilities AND new problems.

Examples:

- Increased draft restricts harbor access.
- Increased displacement changes acceleration and maneuverability.
- More crew requires additional provisions, wages, and accommodation.
- Larger vessels require greater maintenance.
- Extensive cargo changes trim and stability.
- Different propulsion configurations have different power requirements.
- Internal layouts affect usable space, accessibility, and potentially operation.
- Auxiliary boats become useful for moving between vessels and shore.

The player should be able to walk through their vessel and inspect its actual facilities.

Ship interiors should not simply be decorative.

They should have meaningful functions within the simulation.

For example, a kitchen might affect food preparation and provisioning; water storage affects voyage endurance; additional sleeping quarters support more crew.

GRANULARITY PRINCIPLE:

Simulate individual components when their interactions produce meaningful consequences.

Not every object requires microscopic physical simulation.

The important goal is systemic consequence, not detail for its own sake.

## 5. Historical setting and technological freedom

The world is inspired by the ancient Mediterranean, especially classical antiquity.

Historical plausibility remains valuable, but strict historical reconstruction is NOT the overriding objective.

The user is open to alternate-history or speculative ancient technology when it expands the systemic possibilities.

For example, unusually large vessels might employ experimental mechanical propulsion.

Possibilities include:

- Human-powered machinery
- Animal-powered machinery
- Paddle wheels
- Unusual transmission mechanisms
- Experimental crank or lever-operated propulsion
- Other technologies consistent with the world's chosen engineering assumptions

Historically implausible devices should not automatically be excluded.

However, technology should remain physically coherent.

Machinery should require energy, produce forces, occupy space, have mass, and impose operating costs.

The goal is not arbitrary fantasy technology.

It is a believable ancient-inspired world with room for engineering experimentation.

The exact historical-versus-alternative-history boundary is NOT yet settled.

## 6. The economy: a living system, not a money generator

Trade should provide economic motivation and connective structure, but it should not necessarily define the game's identity.

A trading loop should NOT consist merely of buying goods cheaply, traveling somewhere, and selling them for a predictable profit.

Trade should involve:

- Actual production and consumption
- Regional resource differences
- Local supply and demand
- Independent markets
- Transportation costs
- Cargo capacity
- Crew wages
- Ship maintenance
- Weather and travel times
- Information delays
- Competition
- Ownership
- Contracts
- Financial risk

The economy should function whether or not the player participates.

Goods should move because economic actors decide to transport them.

Prices should change for reasons.

A player might hear that a harbor has a grain shortage, load wheat, sail there, and discover that another merchant arrived first.

The anticipated profit disappears.

This is interesting because the world did something independently of the player.

The player can respond by:

- Developing better information networks
- Taking different routes
- Diversifying cargo
- Employing faster vessels
- Negotiating advance contracts
- Hiring agents in distant ports
- Acquiring warehouses
- Establishing competing operations

These capabilities should emerge from general systems rather than a sequence of scripted upgrades.

CORE PRINCIPLE:

Profit is not the ultimate gameplay reward.

Money expands the player's ability to act within the world.

Wealth is interesting because of what it enables the player to build, influence, and experience.

## 7. Autonomous NPCs and captains

This may be the most strategically important long-term system.

Characters should be persistent economic and social agents, not quest dispensers or decorative conversational interfaces.

Consider the player's first hired captain.

In a conventional game, purchasing a captain might generate a fixed amount of passive income every month.

That is specifically NOT the desired approach.

Instead, the captain is an autonomous individual.

They may possess:

- Personal wealth
- Employment and contractual obligations
- Skills and experience
- Risk tolerance
- Knowledge of markets and geography
- Personal ambitions
- Relationships
- Memories
- Personality traits
- Preferences
- Needs
- Reputation
- Loyalty
- Their own long-term goals

The player can hire the captain and assign responsibilities.

The captain then attempts to accomplish those responsibilities using the world's actual systems.

They might:

- Select trading routes
- Purchase and sell cargo
- Evaluate opportunities
- Hire crew
- Respond to weather
- Delay departure
- Seek alternative ports
- Negotiate contracts
- Make mistakes
- Earn or lose money
- Disagree with the player
- Abandon employment
- Eventually acquire their own vessel

The captain is NOT guaranteed to generate profit.

The captain is a person participating in the simulation.

Hiring a second captain should not activate a hardcoded "two-captain gameplay phase."

It simply means there are now two autonomous agents operating vessels within the world.

Their interactions may generate unforeseen developments.

Perhaps they compete for cargo.

Perhaps they cooperate.

Perhaps one becomes wealthier or more successful than the other.

Perhaps one leaves and establishes a competing business.

IMPORTANT ARCHITECTURAL PRINCIPLE:

Wherever practical, NPCs and the player should interact with the same underlying world systems.

An NPC's purchases should affect the real market.
An NPC's money should exist in the actual economy.
An NPC's ship should have physical and operational constraints.
An NPC should only possess information they could plausibly have obtained.

Avoid separate, artificial NPC economies that merely approximate activity through arbitrary rewards.

HOWEVER:

Full high-fidelity physics does not need to run continuously for every distant NPC vessel.

Use multiple simulation resolutions.

Nearby vessels can use detailed rigid-body physics, crew behavior, rendering, and collision.

Distant vessels can operate through cheaper route, weather, logistics, and economic models.

The different simulation levels must remain consistent with the same authoritative world state.

## 8. LLMs as interfaces to real characters

The user strongly supports using LLMs to make the simulation socially accessible.

But the architectural boundary is essential:

THE LLM IS NOT THE SIMULATION.

The simulation contains authoritative facts.

The LLM helps a character interpret, communicate, and respond to those facts.

For instance, an NPC captain's money, ship location, cargo, contract, and knowledge should not be freely invented by an LLM.

These belong to structured simulation state.

The LLM can be used for:

- Natural conversations
- Negotiations
- Explanations
- Character expression
- Personal opinions
- Interpreting player instructions
- Occasional higher-level deliberation
- Social interaction
- Context-sensitive dialogue

Characters should possess persistent memories.

They should remember interactions with the player and with other characters, subject to realistic memory limitations.

They should have distinct personalities and relationships.

The player should be able to encounter people organically.

For example, the player might meet a philosopher in a harbor marketplace.

That philosopher might introduce the player to another person because an actual social relationship exists between those characters.

The encounter should not necessarily be a scripted quest.

It can arise through the combination of:

- Character schedules and locations
- Occupations
- Relationships
- Knowledge
- Interests
- Personal objectives
- Conversation

The same principle applies to captains, merchants, artisans, laborers, officials, and political figures.

The LLM should make the world intelligible and socially vivid.

It should not be responsible for fabricating the underlying world.

SCALABILITY:

Do not assume every agent requires continuous LLM inference.

Most routine decisions should use deterministic or probabilistic algorithms, planners, utility functions, or other economical decision systems.

Invoke LLMs selectively, especially when natural language, complex negotiation, or higher-level interpretation adds value.

## 9. Knowledge, memory, and information

One of Chronicle's most important ideas should carry directly into this project:

OBJECTIVE WORLD STATE IS DIFFERENT FROM CHARACTER KNOWLEDGE.

The world may contain an objective fact:

A grain shipment was lost at sea.

But different characters may possess different information.

One captain knows immediately.

A merchant learns several days later.

The player hears an inaccurate rumor.

Another trader remains unaware.

Their economic decisions should reflect their actual knowledge rather than omniscient access to the simulation.

Information becomes a resource.

The player may develop advantages through:

- Personal relationships
- Trade contacts
- Reliable captains
- Messenger networks
- Commercial correspondence
- Local agents
- Better geographic knowledge
- Experience
- Reputation

This can create meaningful differences between similarly wealthy organizations.

The most successful merchant might not simply own the most ships.

They might have the best information.

Character memories and information transmission should be grounded in actual events.

## 10. Institutions and political power

The long-term aspiration includes the possibility of becoming a politically influential trading magnate.

This requires systems beyond commerce.

The world should eventually support institutional relationships such as:

- Ownership
- Employment
- Contracts
- Debt and credit
- Taxes
- Trade privileges
- Public infrastructure
- Political offices
- Laws or regulations
- Organizations
- Commercial partnerships
- Competing interests

Political influence should arise from material and social relationships where possible.

EXAMPLE:

The player owns a fleet responsible for supplying a city's grain.

The city becomes economically dependent on those deliveries.

The player employs many local sailors, controls warehouse capacity, and has significant relationships with prominent merchants.

This may give the player political leverage.

If the government proposes a new tax, the player might:

- Negotiate
- Accept the tax
- Redirect trade
- Coordinate with other shipowners
- Fund an alternative harbor
- Seek favorable legislation

The consequences ripple into the economy and wider society.

Political power should not simply be an abstract meter that rises when the player completes quests.

It should reflect actual influence over people, resources, organizations, and critical economic activities.

Other agents should be able to accumulate influence through similar mechanisms.

## 11. The gameplay loop: nested scales

The project's identity does not necessarily require one fixed activity such as trading, sailing, or construction.

The central decision loop can remain consistent across different scales:

OBSERVE
   ↓
UNDERSTAND
   ↓
DECIDE
   ↓
ACT
   ↓
EXPERIENCE CONSEQUENCES
   ↓
ADAPT

This repeats at three interconnected scales.

INDIVIDUAL SCALE

- Sail
- Navigate
- Explore
- Converse
- Trade
- Repair
- Build
- Maintain a home aboard a ship

ORGANIZATIONAL SCALE

- Own vessels
- Employ captains
- Manage commercial ventures
- Construct ships
- Organize transportation
- Negotiate contracts
- Develop infrastructure
- Expand trading operations

SOCIETAL SCALE

- Influence regional markets
- Participate in politics
- Shape trade networks
- Fund settlements
- Compete with powerful organizations
- Change the economic geography of the world

The user is especially interested in the transition toward organizational and societal scales.

They want to begin by personally commanding a small vessel but eventually make decisions whose consequences ripple across the world, somewhat like Victoria 3.

IMPORTANT:

Progression toward the strategic scale should not remove the physical, first-person experience.

Even as the owner of an enormous trading empire, the player should retain the freedom to walk aboard a ship, personally sail a vessel, inspect cargo, converse with crew, or wander through a marketplace.

The same persistent world supports both scales.

## 12. Emergence must be legible

A complicated simulation is not automatically an interesting game.

The game must satisfy three requirements:

1. CAUSALITY
Events occur for intelligible reasons within the simulation.

2. LEGIBILITY
The player can discover why those events occurred.

3. CONSEQUENCE
Events meaningfully alter opportunities, constraints, relationships, or decisions.

For example, suppose a trading expedition loses money.

The player should be able to investigate why:

- Weather delays?
- Rising wages?
- Poor information?
- Excessive loading costs?
- Competition?
- Market changes?
- Captain error?
- Damaged or spoiled cargo?

The world should expose that information through several possible channels.

These might include:

- Account books
- Voyage records
- Trade ledgers
- Physical evidence
- Conversations with participants
- Reports from captains
- Market observations

LLM conversations could become an especially useful interface.

The player might ask a captain:

"Why was the voyage so expensive?"

The captain could explain the events based on their own knowledge and the available records.

This allows sophisticated simulation systems to become understandable without forcing the player to navigate enormous dashboards.

The challenge is to preserve systemic depth while making causality discoverable.

## 13. Story and emergent history

A conventional scripted main story is not currently a priority.

The stronger possibility is a world with meaningful initial conditions, competing interests, and persistent historical development.

For example:

- One city relies heavily on imported grain.
- Another produces timber and shipbuilding materials.
- A third controls important shipping routes.
- Some merchants possess established commercial networks.
- Other characters are struggling financially.
- Political factions have competing objectives.
- Individuals have personal histories and relationships.

These conditions create opportunities for events to emerge.

A merchant becomes wealthy.
A ship sinks.
A shortage develops.
A captain changes employers.
An influential family loses power.
A trade network collapses.
A new harbor becomes commercially important.

The game records these events, and subsequent decisions take them into account.

The world accumulates history.

Authored content is not prohibited.

Carefully designed personalities, locations, tensions, and starting conditions can make the world more interesting.

The important distinction is that outcomes should not be rigidly predetermined.

The player should be free to intervene or ignore events, and the world should respond coherently.

## 14. Important design risks

RISK A: FEATURE ACCUMULATION

Adding many unrelated systems does not necessarily produce emergence.

Systems must share meaningful state and interact causally.

Prioritize integration over sheer feature count.

RISK B: SIMULATION WITHOUT INTERESTING DECISIONS

A complex economy can become boring if its effects are imperceptible or its outcomes feel arbitrary.

Feedback loops must be understandable and consequential.

RISK C: LOSING THE PHYSICAL WORLD

As the player's organization expands, the game must not become exclusively a spreadsheet interface.

Preserve the relationship between strategic decisions and tangible, explorable locations and objects.

RISK D: FAKE NPC AUTONOMY

Characters should not merely deliver the appearance of independence while executing predetermined economic bonuses.

Their decisions should have real consequences in shared systems.

RISK E: UNBOUNDED LLM COSTS

Hundreds of characters should not require constant model calls.

Use structured agent state, efficient decision systems, and selective language-model inference.

RISK F: GRANULARITY WITHOUT PURPOSE

Not every detail needs high-fidelity simulation.

Allocate computational and development resources to interactions that meaningfully affect behavior.

RISK G: HISTORICAL CONSTRAINTS

Historical accuracy is valuable but should not automatically prevent compelling systemic possibilities.

Establish consistent world rules, even when allowing speculative technology.

RISK H: TECHNICAL COMPLEXITY

Highly modular systems require clear interfaces, invariants, deterministic testing, and validation.

Emergence should not become an excuse for chaotic or untestable software architecture.

## 15. Current project state — historical snapshot, October 16, 2026

> This section preserves the status reported in the original context document on October 16, 2026. Branch, pull-request, implementation, and validation claims are historical context; verify them against the current repository before relying on them.

As of October 16, 2026, the repository is lrobadey/boatsim.

The newest work is on the branch:

harbour-kit-and-traders

This branch is three commits ahead of main and has an open pull request.

Existing systems include:

- Two playable historical vessel types
- Six-degree-of-freedom ship physics
- Individual agent-based rowing
- Sail and wind physics
- Physically simulated ocean and weather effects
- Procedural Mediterranean geography
- Harbors and docking
- Anchoring
- Player movement aboard vessels and ashore
- Cargo storage and physical loading
- Regional economic simulation
- Trade and voyage persistence
- Authored harbor environments
- Conversational merchant characters
- Initial persistent character information
- Rendering and performance infrastructure

These systems constitute a substantial foundation, but they do not yet realize the larger civilization-simulation vision.

Some key existing limitations include:

- Rough-water merchant hydrodynamics still need validation.
- Fully autonomous ship-owning economic agents are not yet established.
- Political and institutional simulation is not yet implemented.
- Large-scale modular ship construction remains aspirational.
- An integrated, long-duration gameplay loop still needs validation.
- Authored harbor content is not yet universally generalized across world seeds.

Do not confuse implemented functionality with future ambitions.

## 16. Most promising next experiment

A particularly valuable architectural proof of concept would be ONE genuinely autonomous NPC captain.

The captain should:

1. Exist as a persistent person.
2. Possess money, memories, knowledge, personality, and objectives.
3. Control or own an actual vessel.
4. Participate in the existing economy.
5. Make decisions without continuous player input.
6. Travel between ports using a scalable simulation.
7. Trade with the same underlying systems as the player.
8. Experience profit, loss, risk, and operational constraints.
9. Develop a persistent history.
10. Be available for natural-language interaction.
11. Explain decisions based on actual simulated events.
12. Remain active when not observed.

This would demonstrate that the world can support meaningful autonomous activity.

From there, multiple captains could create competition, cooperation, employment, fleet operations, and eventually organizations.

This is a suggested experiment, not an approved implementation task.

The user has not committed to this as the next development priority.

## 17. The long-term player experience

Imagine the player after approximately 100 hours.

They began with a small vessel.

They learned to navigate the archipelago, traded goods, developed relationships, and gradually acquired wealth.

Now they own six ships.

They employ multiple captains and crews, each with distinct abilities, personalities, relationships, and histories.

Their captains conduct voyages independently.

The player has commercial contacts across the region and owns warehouses in several ports.

Their primary residence is an enormous multi-deck flagship they designed and constructed.

The vessel has crew quarters, kitchens, storage compartments, workshops, and smaller boats.

Its draft prevents entry into some harbors, so the player anchors offshore and travels ashore in a tender.

Meanwhile, their trading network continues operating.

A captain returns unexpectedly with news of a major shortage.

A rival merchant has begun undercutting their prices.

A city official wants to negotiate a supply contract.

A former employee now owns a successful vessel.

The player's economic influence has begun affecting regional politics.

None of these developments needs to be part of a predefined narrative sequence.

They arise from interacting systems.

And despite their accumulated wealth and influence, the player can still decide to spend the afternoon sailing a small boat, walking through a market, or talking with an old friend.

That coexistence of intimate physical experience and large-scale systemic consequence is the central ambition.

## 18. Final design principles

1. THE WORLD EXISTS INDEPENDENTLY OF THE PLAYER.

2. SYSTEMS GENERATE POSSIBILITIES; SCRIPTS SHOULD NOT DICTATE EVERY SOLUTION.

3. THE SAME FUNDAMENTAL RULES SHOULD GOVERN PLAYERS AND NPCS WHERE PRACTICAL.

4. ECONOMIC VALUE MUST COME FROM REAL RESOURCES, PRODUCTION, DEMAND, LABOR, TRANSPORTATION, AND INFORMATION.

5. CHARACTERS SHOULD BE AUTONOMOUS PARTICIPANTS, NOT PASSIVE REWARD GENERATORS.

6. LLMs INTERPRET AND EXPRESS THE SIMULATION; THEY DO NOT INVENT AUTHORITATIVE WORLD STATE.

7. INFORMATION AND KNOWLEDGE SHOULD BE LOCAL, IMPERFECT, AND HISTORICALLY GROUNDED.

8. MODULARITY SHOULD ENABLE USES THAT WERE NOT INDIVIDUALLY SCRIPTED.

9. THE PLAYER'S INFLUENCE SHOULD EMERGE FROM ACTUAL OWNERSHIP, RELATIONSHIPS, INSTITUTIONS, AND CONTROL OF RESOURCES.

10. STRATEGIC SCALE SHOULD NOT REPLACE PHYSICAL PRESENCE.

11. COMPLEXITY IS VALUABLE ONLY WHEN IT CREATES MEANINGFUL, LEGIBLE CONSEQUENCES.

12. THE WORLD SHOULD ACCUMULATE HISTORY.

13. PRIORITIZE GENERAL SYSTEMS THAT INTERACT RICHLY OVER LARGE NUMBERS OF ISOLATED FEATURES.

14. PRESERVE PLAYER FREEDOM. DO NOT FORCE A SINGLE CAREER, PROGRESSION PATH, OR ENDGAME.

15. IMPLEMENTATION MUST REMAIN COMPUTATIONALLY PRACTICAL, TESTABLE, AND ARCHITECTURALLY COHERENT.

## 19. The central question

The project is no longer simply asking:

"How do we make a realistic ancient ship simulator?"

It is asking:

"How do we construct a persistent maritime world whose physical, economic, and social systems are sufficiently coherent and composable that individuals—including the player—can create their own lives, organizations, histories, and forms of power within it?"

The desired result is not a collection of predetermined activities.

It is a WORLD OF POSSIBILITIES.

A world where a tiny decision aboard a single ship can eventually ripple through an entire civilization.

And where those consequences arise because the simulation actually supports them.

This is the emerging vision for BoatSim.

END OF CONTEXT DOCUMENT.
