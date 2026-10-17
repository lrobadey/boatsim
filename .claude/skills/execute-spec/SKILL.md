---
name: execute-spec
description: Lead playbook for executing a settled spec pass (e.g. expectations MVP Pass 1a/1b/1c) with a team of agents — recorder, implementer, gate-test author, auditor, gate runner. Use when the user asks to execute or continue a spec pass with the team.
---

# Executing a spec pass with the team

The main session is the lead. It plans, fixes interfaces, briefs agents, merges, runs gates and talks
to the user. It writes no feature code, though it may make small fixes after an audit.

## Team (definitions in .claude/agents/)

| Role | Agent | Model | Writes |
|---|---|---|---|
| Baseline recorder | spec-recorder | sonnet | test scripts, golden data |
| Implementer | spec-implementer | opus | the files its brief assigns |
| Gate-test author | spec-gate-author | sonnet | new test files and helpers only |
| Auditor | spec-auditor | opus | nothing (read and run) |
| Gate runner | spec-gate-runner | haiku | mechanical edits, command runs |

If the named agent types aren't loaded in the session (definitions load at session start), spawn
`general-purpose` with the same `model` and tell it to read and follow `.claude/agents/<role>.md`.

Writers run with `isolation: "worktree"`, in the background. Two writers never touch the same file.

## Sequence for one pass

1. **Read.** Read the spec pass and its gate, docs/vision.md, and the code surface it touches.
2. **Baseline first.** If the pass claims no behaviour change, the recorder records the golden from
   today's code before anything else lands. Merge it before the implementer's branch.
3. **Fix the contract.** Write `docs/pass-<id>-contract.md`: data shapes, every state transition,
   function signatures, invariants, file ownership, and what's out of scope. Resolve small
   inconsistencies in the spec yourself and record them in the contract. Take real design questions to
   the user. Commit the contract before briefing anyone.
4. **Parallel lanes.** Implementer, with its file list. Gate-test author, black-box from the contract,
   never reading the new implementation. Gate runner, for mechanical edits like the test-setup helper
   swap. Disjoint files only.
5. **Merge** in order: baseline, implementer, tests, mechanical. Use `git merge --no-ff <branch>`.
   Resolve conflicts yourself.
6. **Gate.** Run `npm run typecheck`, `npm run test:trade`, the pass golden and the pass gate tests.
   A pass is done only when all are green on the merged branch.
7. **Audit.** Have the auditor review `git diff <pass-base>..HEAD` against the spec, the contract and
   the vision.
8. **Fix.** Small findings the lead fixes directly. Large ones go back to the implementer with the
   finding text. Re-run the gate.
9. **Close.** Update the spec's status line and the memory file. Commit locally only; never push
   unless the user asks. Report to the user: what landed, the gate output, the audit result, the
   decisions you made inside the contract, and the open questions.

## Standing rules every brief repeats

- Stop and report ambiguity; never improvise around the spec.
- Gates are commands. Never re-record a golden or change an expected value without a stated reason.
  From 1b on, re-recording needs the user's approval.
- Headless only. No browser tests unless the user says so.
- Commit to the LLM: no rules-only fallback paths for character dealings.
- UI text is plain. No hints, causes or optimal values.

## User checkpoints

After each pass gate, after any budget or economics run (1b), and whenever an agent reports a spec
question that changes design.

## Pass notes

- **1a:** the contract is docs/pass-1a-contract.md, the golden is `npm run test:trade-golden`, and
  test-setup writes to `voyage.manifest` / `voyage.purse` become `resetBooks` (scripts/trade-fixture.mjs).
- **1b:** the calendar lane is independent and can run as its own session. The world lane runs
  sequentially because it shares economy.ts. The budget-scenario author works in parallel against
  fixed interfaces.
- **1c:** fix the interfaces for records, proposals and settlement first. Then the implementer and the
  gate-test author work in parallel on the long gate list.
