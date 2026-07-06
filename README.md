# Migration Guild — Evidence-Gated Modernization Toolkit

[![CI](https://github.com/iserifith/migration-guild/actions/workflows/ci.yml/badge.svg)](https://github.com/iserifith/migration-guild/actions/workflows/ci.yml)

**Map legacy systems first. Plan from evidence. Migrate in bounded, reviewable slices.**

Migration Guild is an open-source toolkit for AI-assisted legacy modernization. It turns a legacy codebase into an auditable migration workspace with repo-local configuration, prompt packs, evidence outputs, run ledgers, and explicit gates before migration intent.

Migration Guild uses an **Evidence-Gated Migration Runtime**:

```text
Initialize → Map Evidence → Review Evidence → Plan → Execute Bounded Slices → Review
```

The runtime blocks planning and execution until required evidence has been collected: dependencies, entry points, routes, persistence, configuration, tests, and known risk areas. Every material run is recorded so modernization work is reproducible, reviewable, and recoverable.

The runtime contract is provider-neutral: Migration Guild targets OpenAI-compatible chat-completions endpoints. Local servers, internal gateways, LiteLLM, OpenRouter, vLLM, llama.cpp servers, or hosted providers can be selected through named profiles without changing the migration workflow.

---

## Why Migration Guild

Legacy modernization fails when teams jump directly from intent to rewrite. Migration Guild makes the safer path the default:

- **Evidence first** — map what exists before proposing what should change.
- **Explicit gates** — require inventory and review before migration planning or code changes.
- **Provider-neutral runtime** — depend on an OpenAI-compatible API contract, not a vendor CLI.
- **Repo-local configuration** — keep workspace settings in `.guild/config.yaml`.
- **Environment-based secrets** — keep API keys in shell environment or local `.env`, never in config.
- **Named profiles** — switch between cheap, default, reviewer, local, or internal runtimes by profile.
- **Prompt packs** — version the migration instructions used by each phase.
- **Run ledgers** — record prompts, inputs, evidence, outputs, and status for later review.
- **Bounded execution** — migrate small slices with acceptance evidence and review.

---

## Workspace model

A Migration Guild workspace is separate from this kit repository. Run setup/init in the target migration workspace, not inside the kit source tree.

```text
my-migration/
  legacy/                 # original source tree, treated as read-only
  modern/                 # migration target
  migration/              # guildctl and registry tooling
  .guild/
    config.yaml           # workspace config
    .env.example          # local secret template
    prompts/
      default/
        init.md
        map.md
        evidence.md
        plan.md
        execute.md
        review.md
    evidence/             # collected findings and scan outputs
    runs/                 # run ledgers and reports
  .env                    # optional local secrets, gitignored
```

---

## Quick start

From a migration workspace:

```bash
node migration/guildctl/dist/cli.js init
node migration/guildctl/dist/cli.js doctor
node migration/guildctl/dist/cli.js run init
```

`init` scaffolds `.guild/config.yaml`, the default prompt pack, evidence directories, run directories, and `.guild/.env.example`.

`doctor` validates config, selected profile, API key environment, prompt pack, git detection, and run-ledger directories.

`run init` performs the first evidence-mapping pass and writes a report under `.guild/runs/<timestamp>/report.md`.

> `.guild/.env.example` is the template. Copy values into a workspace-root `.env` or export the same variables in your shell.

---

## Configuration

Migration Guild is configured through `.guild/config.yaml`.

```yaml
version: 1
harness: codex

workspace:
  name: my-migration
  root: .

model:
  model: GUILD_MODEL
  base_url: null
  api_key_env: GUILD_API_KEY

prompts:
  directory: .guild/prompts
  active_pack: default

evidence:
  output_dir: .guild/evidence
  include_git_diff: true
  include_static_scan: true
  include_dependency_scan: true

migration:
  default_mode: init
  require_evidence_before_intent: true
  max_autonomous_steps: 3

profiles:
  default:
    base_url: https://your-openai-compatible-endpoint.example/v1
    model: your-default-model
    api_key_env: GUILD_API_KEY
  cheap:
    base_url: https://your-openai-compatible-endpoint.example/v1
    model: your-cheap-model
    api_key_env: GUILD_API_KEY
  reviewer:
    base_url: https://your-openai-compatible-endpoint.example/v1
    model: your-reviewer-model
    api_key_env: GUILD_API_KEY
  local:
    base_url: http://localhost:1234/v1
    model: local-coder-model
```

Use profiles without rewriting config:

```bash
node migration/guildctl/dist/cli.js --profile cheap run init
node migration/guildctl/dist/cli.js --profile reviewer doctor
node migration/guildctl/dist/cli.js --profile local config
```

Secrets stay outside config:

```bash
cp .guild/.env.example .env
# edit .env, or export variables directly in your shell
export GUILD_API_KEY=...
```

---

## Harness adapters

`harness: codex` is the default adapter for executing agent-like work. `AGENT_CMD` can override it with another executable or Node shim. Optional adapters can exist for specific CLIs, but they are integrations behind the Guild contract, not the product spine.

First-party adapters implement the stable guildctl call shape:

```text
<harness> --agent <persona> --model <model> --yolo -p <prompt>
```

Adapters parse those flags, load the selected persona prompt, configure the underlying CLI from `model.base_url` and `model.api_key_env`, run non-interactively with workspace tool permissions, inherit stdout/stderr, and exit with the child process status.

---

## Evidence-gated workflow

### 1. Initialize the workspace

```bash
node migration/guildctl/dist/cli.js init
node migration/guildctl/dist/cli.js doctor
```

### 2. Map evidence before intent

```bash
node migration/guildctl/dist/cli.js run init
```

Inspect the generated report:

```text
.guild/runs/<timestamp>/report.md
```

Do not proceed to planning until the evidence report is plausible.

### 3. Inventory and plan

For packaged Java workspaces using the registry-backed workflow:

```bash
node migration/guildctl/dist/cli.js inventory
node migration/guildctl/dist/cli.js plan
```

Planning is blocked by critical modernization findings until the risks are resolved or explicitly approved.

### 4. Bootstrap, migrate, and review bounded slices

```bash
node migration/guildctl/dist/cli.js bootstrap
node migration/guildctl/dist/cli.js migrate --parallel 3
node migration/guildctl/dist/cli.js review --parallel 2
```

Each worker claims bounded artifacts through the registry so parallel sessions do not step on each other.

### 5. Inspect progress and recover safely

```bash
node migration/guildctl/dist/cli.js status
node migration/guildctl/dist/cli.js watch
node migration/guildctl/dist/cli.js release --id <artifact-id>
node migration/guildctl/dist/cli.js remediate --id <artifact-id>
```

Use remediation for unclear failures, stalled claims, or review rework instead of manually guessing the next state.

---

## Prompt packs

Prompt packs live under `.guild/prompts/<pack>/` and define phase-specific instructions.

```text
.guild/prompts/default/
  init.md
  map.md
  evidence.md
  plan.md
  execute.md
  review.md
```

Switch the active pack in config:

```yaml
prompts:
  directory: .guild/prompts
  active_pack: java-spring
```

Prompt packs make the workflow portable across Java, .NET, PHP, Rails, Node, batch jobs, services, libraries, and internal modernization standards.

---

## Run ledgers

Every evidence-mapping run writes a ledgered output under `.guild/runs/`. A run directory contains:

```text
.guild/runs/<timestamp>/
  input.json              # phase + profile + input passed to the run
  config.snapshot.yaml    # sanitized config snapshot (API keys redacted)
  prompt.final.md         # the full rendered prompt sent to the model
  response.md             # model response (if captured)
  evidence/
    init-evidence.json    # structured evidence (files, deps, git, risks)
  report.md               # human-readable evidence report
```

Ledgers make it possible to answer:

- What did the runtime see?
- Which profile/model was used?
- Which prompt pack was active?
- What evidence was collected?
- What output was produced?
- What is safe to do next?

---

## Target selection

Migration Guild does not assume the target framework up front. It chooses based on evidence from the legacy codebase.

| Legacy project type | Typical target |
| --- | --- |
| Web apps: JAX-RS, servlets, `web.xml` | Spring Boot 3.x + `spring-boot-starter-web` |
| Services, batch jobs, CLI tools, queue consumers | Spring Boot 3.x + `spring-boot-starter` without embedded web assumptions |
| Libraries and utilities with no `main()` | Plain Java 17+ with JUnit 5 |

Java is a supported starting profile, not the product boundary. The workspace model is intended to support other legacy stacks through prompt packs, inventory adapters, and target templates.

---

## CLI reference

```bash
# Workspace configuration
node migration/guildctl/dist/cli.js init
node migration/guildctl/dist/cli.js doctor
node migration/guildctl/dist/cli.js config
node migration/guildctl/dist/cli.js config-set migration.max_autonomous_steps 5

# Evidence runtime
node migration/guildctl/dist/cli.js run init
node migration/guildctl/dist/cli.js run

# Registry-backed legacy workflow
node migration/guildctl/dist/cli.js inventory
node migration/guildctl/dist/cli.js plan
node migration/guildctl/dist/cli.js bootstrap
node migration/guildctl/dist/cli.js migrate --parallel 3
node migration/guildctl/dist/cli.js review --parallel 2
node migration/guildctl/dist/cli.js remediate --id <artifact-id>

# Operations
node migration/guildctl/dist/cli.js status
node migration/guildctl/dist/cli.js watch
node migration/guildctl/dist/cli.js release --id <artifact-id>

# Evidence and arbitration
node migration/guildctl/dist/cli.js evidence add --artifact <id> --type test-command --produced-by reviewer --pass --summary "Tests passed"
node migration/guildctl/dist/cli.js evidence list --artifact <id>
node migration/guildctl/dist/cli.js arbitrate --artifact <id> --approve --arbiter reviewer --reason "Evidence accepted"

# Society proof + benchmarks
node migration/guildctl/dist/cli.js society-report
node migration/guildctl/dist/cli.js benchmark run --fixture <id> --mode both
node migration/guildctl/dist/cli.js benchmark report
node migration/guildctl/dist/cli.js benchmark compare --baseline <id> --guild <id>

# Registry inspector (live dashboard on http://localhost:3322)
node migration/registry/dist/cli.js serve
node migration/registry/dist/cli.js list-artifacts
```

The registry model, phase orchestration, worker spawning, pre-claim/atomic-claim logic, failure handling, recovery flow, and the Builder → Critic → Arbiter review loop all live in this repository under `migration/guildctl/` and `migration/registry/`. Run `guildctl --help` to see every command, or read `migration/guildctl/cli.ts` for the authoritative command list.

---

## Legacy packaged Agent workflow

Earlier Migration Guild packages included Agent-specific agents, skills, prompts, and manual invocation recipes. Those artifacts remain useful as optional integrations and compatibility paths, but they are no longer the product spine.

Use this path only when working with an existing packaged Java/Agent workspace.

```bash
# Example legacy setup path
mkdir my-migration && cd my-migration
npx guildctl-setup
cd migration && npm install && cd ..
```

Legacy workspace layout:

```text
legacy/          # original Java source, read-only
modern/          # migration target
migration/       # registry CLI and database
.github/
  agents/        # optional Agent-specific workers
  skills/        # optional Agent-specific skills
  prompts/       # optional Agent prompt shortcuts
  instructions/  # optional file-level Agent context
```

If using a raw agent CLI manually, keep the same phase discipline:

1. inventory first
2. plan only after inventory and gates pass
3. bootstrap target structure
4. migrate bounded artifacts
5. review with evidence
6. remediate exceptions through registry state, not ad-hoc edits

Prefer `guildctl` where possible because it records state, claims artifacts atomically, and keeps recovery paths explicit.

---

## Status reference

| Status | Meaning |
| --- | --- |
| `pending` | Registered, not yet planned |
| `planned` | Wave assigned, ready to be claimed |
| `in-progress` | Claimed by an active session |
| `tests-written` | Target tests written, production code next |
| `migrated` | Migration complete, awaiting review |
| `reviewed` | Approved |
| `needs-rework` | Review flagged issues, re-migrate |
| `blocked` | Requires remediation or human decision |

---

## Troubleshooting

### Missing API key

Set the environment variable named by the active profile's `api_key_env`.

```bash
node migration/guildctl/dist/cli.js --profile default config
node migration/guildctl/dist/cli.js --profile default doctor
```

### Missing prompt pack

Rerun init or create the active pack manually:

```bash
node migration/guildctl/dist/cli.js init --force
```

Expected path:

```text
.guild/prompts/<active_pack>/
```

### Unsupported runtime

Use an OpenAI-compatible chat-completions endpoint. Vendor-specific SDKs or CLIs can be wrapped behind an OpenAI-compatible gateway, but they are not required by the Guild runtime contract.

### Registry not found

Run registry-backed commands from the migration workspace root, not inside `legacy/` or `migration/`.

### No claimable tasks

All planned artifacts are either in progress or blocked by dependencies. Check status and active claims:

```bash
node migration/guildctl/dist/cli.js status
node migration/guildctl/dist/cli.js watch
```

### Worker crashed mid-task

Release a clearly stale claim:

```bash
node migration/guildctl/dist/cli.js release --id <artifact-id>
```

If the failure mode is unclear, use remediation instead:

```bash
node migration/guildctl/dist/cli.js remediate --id <artifact-id>
```

### Legacy source changed unexpectedly

Stop and restore `legacy/` from version control or a fresh copy. The legacy tree is evidence, not the write target.

---

## Minimal validation path

Before treating a migrated slice as complete:

1. build the migrated output
2. run migrated and retained tests
3. run target static checks
4. record acceptance evidence
5. review behavior against the legacy source
6. arbitrate or send back to rework

---

## Product summary

Migration Guild is an open-source evidence-gated modernization toolkit for converting legacy systems into auditable migration workspaces before planning or executing code changes.
