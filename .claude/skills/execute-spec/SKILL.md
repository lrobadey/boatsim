---
name: execute-spec
description: Lead playbook for executing a spec pass or any sizeable change with agents. The lead composes a workflow per task from a menu of roles (Haiku implements what the lead designed, Sonnet for judgment, Opus reviews), using only the roles the task's real risks justify. Use when the user asks to execute or continue a spec pass (e.g. expectations MVP 1b/1c) or to run work "with the team".
---

# Executing work with agents

The main session (Opus) is the lead. It reads the code, makes every design decision, briefs the
agents, merges their work, runs the checks and talks to the user. Agents carry out what the lead has
already decided. The user wants speed with judgment: the lightest process that's safe for the task, not
the full ceremony every time.

## Compose the workflow for each task

There's no fixed team. For each task, look at what it actually needs and put together the smallest
workflow that makes it safe. That might be one Haiku agent, the lead alone, or several lanes in parallel
with a reviewer. Before launching anything, say the plan to the user in one or two lines: which roles,
which models, what runs in parallel, and why.

**Questions that decide the shape**
- **Is the design settled?** If not, the lead settles it first, or asks the user. Agents don't design.
- **What could go wrong that the existing tests wouldn't catch?** Each role you add should answer a risk
  you can name. Roles added "to be thorough" are the waste the user wants gone.
- **Is it meant to change behaviour?** If a change must leave behaviour untouched and the tests can't
  prove that, a baseline recorder earns its place. If behaviour is meant to change, a baseline adds
  little.
- **Which pieces are independent?** Separate files and no shared results means they can run in parallel.
  Pieces sharing files run one after another, or as one agent.
- **How bad is a mistake, and how hard to see?** Money, saves and simulation invariants justify an Opus
  review. A UI tweak or a local fix usually doesn't.
- **Is it faster for the lead to just do it?** A few lines in code the lead has already read: just do it.
  Briefing and merging have a cost too.

**Patterns to draw from (examples, not rules)**
- **Lead alone:** tiny, local edits.
- **Lead and one Haiku:** a clear change with existing tests as the check.
- **Recorder, then Haiku, then one review:** a refactor that must change nothing and touches money or
  saves. Pass 1a done well would have looked like this.
- **Parallel Haiku lanes:** independent pieces, such as the 1b calendar beside the world lane, each with
  its own brief and worktree.
- **Sonnet for judgment pieces:** a budget scenario, choosing what a golden captures, writing the few
  tests that matter, or investigating something unclear before the lead designs.
- **Full lanes with a capped test author and a review:** a large new system with a long gate list.

If unsure, start lighter. A focused review at the end catches what matters more cheaply than extra roles
up front.

## Writing a brief Haiku can execute

Because Haiku implements, the brief is the design. There's no separate contract document unless the
task is large or several agents share the interface. A brief contains:

- The files it may touch, and that nothing else may change.
- Per file, the exact change: new types and fields, function signatures, what each function does step by
  step, the order of operations where it matters, and the exact UI strings.
- The invariants that must hold, and the command that proves each one.
- What not to do: no re-recording goldens, no changing expected values, no extra checks or fuzzing
  beyond the listed commands, no new tests unless the brief asks for them.
- Stop rule: if the code doesn't match what the brief describes, stop and report. Don't improvise.
- Report format: five lines or fewer. Commit hash, files, command results, anything that didn't fit.

Read the code before writing the brief. Pass 1a's contract had a wrong invariant (it said landed jars
leave the books, but today's code keeps them on the quay until the cart clears). That cost corrections
to two running agents. Verify every claim the brief makes about current behaviour.

## Worktrees and merging

- A single agent can work in the main checkout if nothing else is running.
- `isolation: "worktree"` cuts the worktree from `main`, not from the working branch. Make worktrees
  yourself instead:
  `git worktree add .claude/worktrees/<name> -b <branch> <working-branch>`, then
  `ln -s ../../../node_modules .claude/worktrees/<name>/node_modules`. Tell the agent to use only that
  path and to `git add` explicit paths, never the node_modules link.
- Merge with `git merge --no-ff <branch>`. Work that was based on `main` comes over with
  `git cherry-pick`.
- When done, remove the worktrees and delete their branches after checking the commits are merged.

## Usual order (skip steps the composed workflow doesn't include)

1. Read the code the task touches, then compose the workflow and tell the user the plan.
2. Baseline, if one is in the plan: recorded from today's code and merged before anything else.
3. Brief and launch the agents, in parallel where their files don't overlap.
4. Merge and check: `npm run typecheck`, `npm run test:trade` (which includes the trade golden), plus
   the task's own commands.
5. Review, if one is in the plan: one Opus review of `git diff <base>..HEAD`, given the risk areas and
   the decisions already accepted.
6. Fix small findings yourself. Send large ones back with the finding text.
7. Close:
   - update the spec status and memory;
   - commit locally (never push unless asked);
   - remove the worktrees;
   - report briefly: what landed, the checks, the review and the decisions made.

## Standing rules

- Test proportionately (the user's rule): test only what's needed for the change to work. A golden
  proves "no behaviour change". Add a short file only for what neither it nor existing tests can see.
  No permutation or negative-case batteries. No fuzzing unless the lead asks.
- Put caps in the first brief. Pass 1a's test author wrote a full suite, was cut down mid-way, and ended
  up the slowest step (about 16 minutes).
- Never re-record a golden or change an expected value without a stated reason. From 1b on,
  re-recording needs the user's approval. Tests that check a format the task deliberately changes
  (e.g. the save version) are updated by the lead, with the reason in the commit.
- Headless only. No browser tests unless the user says so.
- Commit to the LLM: no rules-only fallback paths for character dealings.
- UI text is plain. No hints, causes or optimal values.

## User checkpoints

After each pass, after any economics or budget run (1b), and whenever a design question comes up that the
spec doesn't settle. Small inconsistencies the lead resolves and reports.

## Pass 1a retrospective (October 16, 2026)

1a took roughly an hour of mostly one-step-after-another agent time for a refactor touching money and saves. What paid
off: the golden trace (`npm run test:trade-golden`) and one Opus review, which found a real save-loss
path. What was waste: an Opus implementer that also ran a 48k-operation fuzz test the golden made
redundant; a test author with no size cap; five roles with five handoffs; a contract written before
the code was fully read; worktrees cut from `main`. Done the new way, 1a would have been the lead's
brief, a Sonnet recorder, a Haiku implementer and one review, in about half the time. The lesson is not
"use four roles". It's that each role must answer a named risk.

## Pass notes

- **1a (done):** contract in docs/pass-1a-contract.md. Books live in src/trade/books.ts. Only that module
  writes purse, manifest, lots or receipts. Existing tests that build state by hand call
  `rebuildBooks`. `npm run test:trade` runs everything, including scripts/test-books.mjs and the golden.
  Open follow-up: receipts grow about 110 bytes per handled unit, so saves will need compaction.
- **1b (likely shape, decide when you get there):**
  - Calendar: independent, can run in parallel.
  - World lane: land use, then wallets, then the celebration and Philon. These go in order, or to one
    agent, because they share economy.ts. Behaviour changes on purpose: re-record the goldens with the
    user's approval, giving the reason.
  - Budget scenario: needs judgment. Report its result to the user before any tuning.
- **1c (likely shape):** many interacting rules. Set the interfaces for records, proposals and
  settlement first, then decide the lanes.
