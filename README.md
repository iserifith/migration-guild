# legmod — Java Migration Kit

**Migrate any legacy Java codebase to a modern framework using GitHub Copilot CLI.**

Supports Spring Boot 3.x, Quarkus, Micronaut, Jakarta EE 10, and plain Java 21.

---

## How it works

legmod installs a set of Copilot agents, skills, and prompts into your project. Each agent handles one phase of the migration. A SQLite registry tracks every file's status so multiple Copilot sessions can run in parallel without stepping on each other.

```
Inventory → Planning → Migration (parallel) → Review
```

---

## Prerequisites

- [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line) installed and authenticated
- Node.js 18+
- Git

---

## 1. Setup

Run the installer inside a new empty folder (your migration workspace):

```bash
mkdir my-migration && cd my-migration
npx legmod-setup
```

The setup wizard asks two questions:

1. **Target framework** — choose from the list or type your own
2. **Legacy repo URL** — paste the GitHub URL; it will be cloned into `legacy/` automatically

Then build the registry CLI:

```bash
cd migration && npm install && npm run build && cd ..
```

Your workspace will look like:

```
legacy/          ← your original Java source (read-only)
modern/          ← migration target (starts empty)
migration/       ← registry CLI and database
.github/
  agents/        ← Copilot agents
  skills/        ← Copilot skills
  prompts/       ← Copilot prompt shortcuts
  instructions/  ← file-level Copilot context
  copilot-instructions.md
```

---

## 2. Inventory

Open Copilot in your workspace and run the inventory phase. This scans every Java file in `legacy/`, classifies it, and registers it in the registry.

```bash
cd my-migration
copilot --agent context-agent --model gpt-4.1 --yolo
```

Then say:

```
Run inventory on all Java files in legacy/
```

**What happens:** The agent reads each `.java` file, identifies its role (service, utility, interface, etc.), detects legacy framework patterns, and runs `register-artifact` for each file. All files start with status `pending`.

**Check progress:**

```bash
node migration/registry/dist/cli.js list-artifacts
```

---

## 3. Planning

Once inventory is complete, run the planner to build the dependency graph and assign wave numbers.

```bash
copilot --agent planner-agent --model claude-sonnet-4.6 --yolo
```

Then say:

```
Run planning
```

Or use the built-in prompt:

```
#analyze-and-plan
```

**What happens:** The planner reads all `pending` artifacts, detects which files depend on which, assigns dependencies, and groups files into waves. Wave 1 has no dependencies and can be migrated immediately. Wave 2 depends on Wave 1 being done, and so on.

**Check the wave plan:**

```bash
node migration/registry/dist/cli.js wave-plan
```

---

## 4. Migration

This is the main phase. Each session claims one task atomically — you can run many sessions in parallel.

```bash
copilot --agent migration-agent --model claude-sonnet-4.6 --yolo
```

Then say:

```
Migrate next task
```

**What happens:**

1. The agent claims the next available `planned` artifact (lowest wave first)
2. Reads the legacy file
3. Finds the target framework equivalent using the reference agent
4. Writes tests in `modern/` first (TDD)
5. Writes the migrated production code
6. Updates the registry to `migrated`

**To migrate a specific file:**

```
#migrate-file file=legacy/jolt-core/src/main/java/com/bazaarvoice/jolt/Chainr.java
```

**Run multiple parallel sessions** by opening additional terminals:

```bash
# Terminal 1
copilot --agent migration-agent --model claude-sonnet-4.6 --yolo -p "Migrate next task"

# Terminal 2
copilot --agent migration-agent --model claude-sonnet-4.6 --yolo -p "Migrate next task"

# Terminal 3
copilot --agent migration-agent --model claude-sonnet-4.6 --yolo -p "Migrate next task"
```

Each session will claim a different task — the registry prevents conflicts.

---

## 5. Review

After migration, review each file for correctness.

```bash
copilot --agent review-agent --model claude-sonnet-4.6 --yolo
```

Then say:

```
Review migration for modern/src/main/java/com/example/Chainr.java
```

Or use the built-in prompt:

```
#review-migration file=modern/src/main/java/com/example/Chainr.java
```

**What happens:** The reviewer compares the migrated file against the original, checks for behavior drift, missing tests, legacy imports, and framework misuse. It writes a verdict (`reviewed` or `needs-rework`) to the registry.

If a file needs rework, run migration again for that file:

```
#migrate-file file=legacy/...
```

---

## Inspect progress

**Terminal dashboard:**

```bash
node migration/registry/dist/cli.js show-status
```

**Visual UI:**

```bash
node migration/registry/dist/cli.js serve
# Opens http://localhost:3322
```

The UI shows:

- All artifacts with status, wave, role, and path
- Filter by status, module, or kind
- Click any row to see the full event log
- Wave Plan tab: progress bars per wave

**Useful registry commands:**

```bash
# What can be claimed right now?
node migration/registry/dist/cli.js list-ready

# Wave progress summary
node migration/registry/dist/cli.js wave-plan

# All artifacts with a filter
node migration/registry/dist/cli.js list-artifacts --status needs-rework

# Event history for one file
node migration/registry/dist/cli.js get-events --id "legacy-source:jolt-core:Chainr"
```

---

## Update the kit

When a new version of legmod is released, update your workspace without touching the registry or legacy source:

```bash
npx legmod-setup --update
cd migration && npm install && npm run build && cd ..
```

---

## Recommended models

| Phase     | Agent             | Model               |
| --------- | ----------------- | ------------------- |
| Inventory | `context-agent`   | `gpt-4.1`           |
| Planning  | `planner-agent`   | `claude-sonnet-4.6` |
| Migration | `migration-agent` | `gpt-5.2-codex`, `claude-sonnet-4.6`, `gpt-5-mini` |
| Review    | `review-agent`    | `claude-sonnet-4.6` |

---

## Status reference

| Status          | Meaning                                    |
| --------------- | ------------------------------------------ |
| `pending`       | Registered, not yet planned                |
| `planned`       | Wave assigned, ready to be claimed         |
| `in-progress`   | Claimed by an active session               |
| `tests-written` | Target tests written, production code next |
| `migrated`      | Migration complete, awaiting review        |
| `reviewed`      | Approved                                   |
| `needs-rework`  | Review flagged issues, re-migrate          |

---

## Troubleshooting

**Registry not found**
Make sure you run Copilot from the workspace root (not inside `legacy/` or `migration/`).

**"No claimable tasks"**
All planned artifacts are either in-progress or waiting on dependencies. Check `wave-plan` to see which wave is blocked and why.

**Agent doesn't run shell commands**
Ensure you pass `--yolo` (or `--allow-all-tools`) when starting Copilot. Without it, the agent can't run `node migration/registry/dist/cli.js`.
