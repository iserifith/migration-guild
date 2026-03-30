# Copilot Instructions

This project is undergoing a Java migration using the **legmod** kit.

## Project Configuration

- **Legacy source root**: `legacy/`
- **Migration target root**: `modern/`
- **Target framework**: {{TARGET_FRAMEWORK}}
- **Registry database**: `migration/registry.db`

## Migration Workflow

Phases run in order. Phases 3–5 are parallelizable across multiple Copilot sessions.

```
1. Inventory   — scan legacy/, register all artifacts (status: pending)
2. Planning    — analyze dependencies, assign waves, set status: planned
3. Test Prep   — claim task, write target-side tests first
4. Execute     — migrate production code to modern/
5. Review      — verify correctness, write verdict
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

## Agent Rules

- `legacy/` is **read-only** — never modify files here
- `modern/` is the **only** write target for migrated code
- Always write tests before production code
- Check registry before starting work — use `claim` to avoid duplicate work
- Update registry status after each meaningful step

## Recommended Models per Phase

Run each phase with the most cost-effective model for the task:

| Phase | Agent | Recommended model | Reason |
|---|---|---|---|
| Inventory | `context-agent` | `gpt-4.1` | High volume, pattern matching |
| Planning | `planner-agent` | `claude-sonnet-4.6` | Dependency graph reasoning |
| Migration | `migration-agent` | `gpt-5.2-codex` | Code-optimized transformations |
| Review | `review-agent` | `claude-sonnet-4.6` | Code review judgment |
| Reference | `reference-agent` | `gpt-4.1` | Simple pattern retrieval |

Usage: `copilot --agent <agent-name> --model <model-id> -p "..."`
