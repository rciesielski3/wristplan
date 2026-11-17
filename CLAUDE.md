@AGENTS.md

# wristplan — agent operating rules

Context (local only, never commit): `.ai/PROJECT_CONTEXT.md`, `.ai/garmin-integration-options.md`, `.ai/implementation-plan.md`, `.ai/findings.md`.

## Orchestration

The main session is the orchestrator. For each task from `.ai/implementation-plan.md`:

1. Break the milestone into small, independently verifiable tasks. Track them with the task list.
2. Delegate implementation to `implementer`. Independent tasks may run in parallel.
3. Delegate test design and gate execution to `qa-engineer`.
4. Delegate review to `reviewer` before every commit.
5. Loop implement → gate → review until every AC of the task is met and the gate is green. Do not stop at partial results.
6. Commit per task. Never push without asking.
7. Stop and ask only when: a human check is required (e.g. workout visible on the watch), an AC is ambiguous, docs are unreachable, or a decision is irreversible.
8. Record outcomes and gotchas in `.ai/findings.md`.
