# Agent Instructions

This project is undergoing a legacy software modernization using the **Migration Guild** kit.

## Project Configuration

- **Legacy source root**: `legacy/`
- **Migration target root**: `modern/`
- **Target framework**: {{TARGET_FRAMEWORK}}
- **Registry database**: `migration/registry.db`

## Migration Workflow

Phases run in order. Phases 3–5 are parallelizable across multiple Agent sessions.

```
1. Inventory — scan legacy/, register all artifacts (status: pending)
2. Planning  — analyze dependencies, assign waves, set status: planned
3. Analyze   — extract behavior from legacy file, write context, set status: analyzed
4. Tests     — write target-side tests from context, set status: tests-written
5. Codegen   — write migrated production code, set status: migrated
6. Review    — verify correctness, write verdict
```

Exception path:

```
Remediation — recover failed runs, stalled claims, blocked artifacts, or needs-rework items before resuming the happy path
```

## Registry CLI

The registry CLI tracks all migration state. Run from the project root:

```bash
node migration/registry/dist/cli.js <command>
```

Key commands:

- `claim --agent <name>` — atomically claim the next available task
- `claim --agent <name> --wave <n>` — claim from a specific wave
- `list-ready` — preview claimable tasks without claiming
- `wave-plan` — show migration waves and their status
- `set-artifact-status --id <id> --status <status>` — update artifact state
- `show-status` — operator dashboard
- `set-verification --id <id> --state <state> --method <method> [--reason <slug>]` — record whether your own output was checked
- `get-verification --id <id>` — read the current verification state (always answers, never blank)

## Reporting Verification

Migration status and verification state are **two separate facts**. Reaching `migrated`
says you produced the output; it does not say the output was checked. Record what you
actually know:

- After finishing an artifact, record your own bounded check with `set-verification`.
  Use `--state verified` only when a check actually ran and passed, and pass
  `--duration-ms` and `--scope` so the record can say what it covered.
- If you could not verify your own output — no toolchain, the check could not run, you
  ran out of budget, or you simply did not check — record it explicitly:

  ```bash
  node migration/registry/dist/cli.js set-verification --id <id> \
    --state unverified --method none --reason agent-reported-unverifiable
  ```

- **Never close silently.** An artifact with no verification record reads as
  `unverified` / `not-attempted`, which is honest but tells the operator nothing about
  why. Saying `agent-reported-unverifiable` is always better than saying nothing.
- Never claim `verified` for work you did not check. Verification is triage input for
  reviewers; it does not approve anything, does not substitute for acceptance evidence,
  and does not unlock a status transition. Overstating it only misleads the next reader.
- Valid reasons: `not-attempted`, `no-stack-check`, `tree-incomplete`, `budget-exhausted`,
  `agent-reported-unverifiable`, `check-failed`, `check-error`.

## Agent Rules

- `legacy/` is **read-only** — never modify files here
- `modern/` is the **only** write target for migrated code
- Remediation is registry-only — do not fix `needs-rework` or stalled items by editing files during triage; requeue them and resume the normal phase flow
- If `legacy/` was edited accidentally, restore it from version control or a fresh copy before running more migration steps
- Always write tests before production code
- Check registry before starting work — use `claim` to avoid duplicate work
- Update registry status after each meaningful step
- On "start", "let's start", "continue", or "proceed", determine the next phase from registry state first, then execute it immediately
- If the registry is empty, default to **Inventory** immediately — do not do exploratory classification first
- Do not create or update `plan.md` unless the user explicitly requested planning mode
- Do not invoke classification or mapping skills before inventory unless the user explicitly asked for analysis
- Prefer phase execution over broad exploration; read only the minimum needed to safely run the next phase

## Recommended Models per Phase

Run each phase with the most cost-effective model for the task:

| Phase     | Agent             | Recommended model   | Reason                                |
| --------- | ----------------- | ------------------- | ------------------------------------- |
| Inventory | `context-agent`   | `gpt-5-mini`        | High volume, pattern matching         |
| Planning  | `planner-agent`   | `claude-sonnet-4.6` | Dependency graph reasoning            |
| Analysis  | `analyze-agent`   | `gpt-5-mini`        | Pattern extraction, structured output |
| Tests     | `test-agent`      | `claude-sonnet-4.6` | Behavior reasoning, meaningful tests  |
| Codegen   | `codegen-agent`   | `gpt-5-mini`        | Mechanical translation given spec     |
| Review    | `review-agent`    | `claude-sonnet-4.6` | Code review judgment                  |
| Remediation | `remediation-agent` | `claude-sonnet-4.6` | Failure diagnosis and conservative recovery |
| Reference | `reference-agent` | `gpt-5-mini`        | Simple pattern retrieval              |

Usage: `agent --agent <agent-name> --model <model-id> -p "..."`
Note: Always use agents with `--yolo` to allow writing and tools execution access.
