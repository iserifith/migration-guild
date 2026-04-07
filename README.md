# legmod — Java Migration Kit

**Migrate any legacy Java codebase to a modern framework using GitHub Copilot CLI.**

The target framework is chosen based on what the legacy code actually is — not assumed upfront:

| Legacy project type | Target |
| --- | --- |
| Web apps (JAX-RS, servlets, `web.xml`) | Spring Boot 3.x + `spring-boot-starter-web` |
| Services, batch jobs, CLI tools, queue consumers | Spring Boot 3.x + `spring-boot-starter` (no embedded server) |
| Libraries and utilities (no `main()`, published as JAR) | Plain Java 17+ with JUnit 5 |

---

## How it works

legmod installs a set of Copilot agents, skills, and prompts into your project. Each agent handles one phase of the migration. A SQLite registry tracks every file's status so multiple Copilot sessions can run in parallel without stepping on each other.

```
Inventory → Planning → Bootstrap → Migration (parallel) → Review
```

**Want the internals?** See [docs/how-legmod-works.md](docs/how-legmod-works.md) for the registry model, phase orchestration, agent spawning, failure handling, and recovery flow.

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

1. **Legacy repo URL** — paste the GitHub URL; it will be cloned into `legacy/` automatically
2. **Project type** — `web`, `service`, or `library` (used to select the right Gradle build template)

Then build the registry and legmod CLIs:

```bash
cd migration && npm install && cd ..
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

## Using the legmod CLI (recommended)

The `legmod` CLI is a one-command orchestrator that drives the full pipeline for you. It spawns Copilot under the hood with the right agent, model, and flags — no manual wiring needed.

```bash
# Run the full pipeline (inventory → plan → migrate → review)
node migration/legmod/dist/cli.js run

# Run with 3 parallel migration + review sessions
node migration/legmod/dist/cli.js run --parallel 3

# Run individual phases
node migration/legmod/dist/cli.js inventory
node migration/legmod/dist/cli.js plan
node migration/legmod/dist/cli.js bootstrap
node migration/legmod/dist/cli.js migrate --parallel 3
node migration/legmod/dist/cli.js review --parallel 2

# Check current status
node migration/legmod/dist/cli.js status
```

**What legmod handles automatically:**
- Selects the right agent and model per phase
- Passes `--yolo` so agents can run registry commands without interruption
- Prompts you to confirm framework mappings before planning proceeds
- Spawns N parallel sessions for migration and review
- Polls `registry.db` for live progress via SQLite triggers (no agent cooperation needed)
- Advances phases automatically when the current phase completes

> **Tip:** Set `COPILOT_CMD=gh` (or whatever your Copilot CLI binary is named) if `copilot` doesn't resolve on `PATH`. For example: `COPILOT_CMD=gh node migration/legmod/dist/cli.js run`
>
> Set `LEGMOD_STALL_MINS=<n>` to change the stall warning threshold in `legmod watch` (default: 10 minutes).

---

## Manual Copilot invocation (advanced)

The steps below describe the same workflow using raw `copilot` CLI commands. Use these when you need fine-grained control, want to target a specific file, or the legmod CLI doesn't cover your use case.



Open Copilot in your workspace and run the inventory phase. This scans every Java file in `legacy/`, classifies it, and registers it in the registry.

```bash
cd my-migration
copilot --agent context-agent --model gpt-5-mini --yolo
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

## 4. Bootstrap

Before agents start writing migrated files, scaffold the target module:

```bash
node migration/legmod/dist/cli.js bootstrap
```

**What happens:**

1. legmod classifies the legacy project as `web`, `service`, or `library`
2. Scaffolds `modern/` with the matching Gradle template
3. Creates source roots, `settings.gradle`, and for Spring targets an `Application.java` plus `application.yml`
4. Leaves any existing target files in place

---

## 5. Migration

This is the main phase. Each session claims one task atomically — you can run many sessions in parallel.

```bash
copilot --agent migration-agent --model gpt-5-mini --yolo
```

Then say:

```
Migrate next task
```

**What happens:**

1. The agent claims the next available `planned` artifact (lowest wave first)
2. Reads the legacy file
3. Finds the target framework equivalent using the reference agent
4. Writes tests in `modern/` first (TDD) — plain JUnit 5 for libraries, Spring Boot test slices (`@WebMvcTest`, `@SpringBootTest`) for web and service targets
5. Writes the migrated production code
6. Updates the registry to `migrated`

**To migrate a specific file:**

```
#migrate-file file=legacy/jolt-core/src/main/java/com/bazaarvoice/jolt/Chainr.java
```

**Run multiple parallel sessions** by opening additional terminals:

```bash
# Terminal 1
copilot --agent migration-agent --model gpt-5-mini --yolo -p "Migrate next task"

# Terminal 2
copilot --agent migration-agent --model gpt-5-mini --yolo -p "Migrate next task"

# Terminal 3
copilot --agent migration-agent --model gpt-5-mini --yolo -p "Migrate next task"
```

Each session will claim a different task — the registry prevents conflicts.

---

## 6. Review

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

## 6. Remediation (exception path)

When a background worker fails, a claim stalls, or review sends an artifact back, use the dedicated remediation agent instead of folding recovery policy into the orchestrator.

```bash
copilot --agent remediation-agent --model claude-sonnet-4.6 --yolo
```

Then say:

```
Remediate the next blocked or stalled artifact
```

**What happens:** The remediation agent inspects registry state, recent events, and worker outcomes, then chooses one safe action: release for retry, send the artifact back to `planned`, leave it `blocked` with a reason, or escalate to a human.

---

## 7. Inspect progress

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

# See what every agent is currently working on (with age)
node migration/registry/dist/cli.js show-in-progress

# Inspect recent worker outcomes
node migration/registry/dist/cli.js list-runs --limit 20

# Release a stuck in-progress artifact (e.g. after a crashed agent)
node migration/registry/dist/cli.js release --id "legacy-source:jolt-core:Chainr" --agent "operator" --reason "agent crashed"

# Event history for one file
node migration/registry/dist/cli.js get-events --id "legacy-source:jolt-core:Chainr"
```

---

## Update the kit

When a new version of legmod is released, update your workspace without touching the registry or legacy source:

```bash
npx legmod-setup --update
cd migration && npm install && cd ..
```

---

## Recommended models

| Phase     | Agent             | Model               |
| --------- | ----------------- | ------------------- |
| Inventory | `context-agent`   | `gpt-5-mini`        |
| Planning  | `planner-agent`   | `claude-sonnet-4.6` |
| Migration | `migration-agent` | `gpt-5-mini`        |
| Review    | `review-agent`    | `claude-sonnet-4.6` |
| Remediation | `remediation-agent` | `claude-sonnet-4.6` |

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
All planned artifacts are either in-progress or waiting on dependencies. Check `wave-plan` to see which wave is blocked and why. Use `show-in-progress` to see what agents are holding claims.

**Agent crashed mid-task**
An artifact left `in-progress` by a crashed agent blocks that slot. Release it so another session can pick it up:
```bash
node migration/registry/dist/cli.js release --id "<id>" --agent "operator" --reason "agent crashed"
```

If the failure mode is unclear or the artifact already moved to `needs-rework` / `blocked`, run `remediation-agent` instead of guessing the next state.

**Agent doesn't run shell commands**
Ensure you pass `--yolo` (or `--allow-all-tools`) when starting Copilot. Without it, the agent can't run `node migration/registry/dist/cli.js`.
