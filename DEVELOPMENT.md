# Migration Guild development guide

This file is for people changing the **kit itself**, not for users running a migration workspace.

## What this repository contains

Migration Guild has two parallel concerns:

1. **Repository-local maintainer artifacts** used while developing the kit
2. **Packaged kit artifacts** copied into user workspaces by `setup.ts`

The split matters because not everything in this repository ships.

## Source of truth by area

| Path | Purpose | Ships |
| --- | --- | --- |
| `.github/agents/` | Repo-local maintainer agents for working on the kit itself | No |
| `.github/prompts/` | Repo-local maintainer prompt shortcuts for working on the kit itself | No |
| `.github/agent-instructions.md` | Repo-local Agent context for this repository | No |
| `package/agents/` | Agent definitions installed into migration workspaces | Yes |
| `package/skills/` | Skill definitions and shipped skill assets installed into migration workspaces | Yes |
| `package/prompts/` | Prompt shortcuts installed into migration workspaces | Yes |
| `package/instructions/` | Path-scoped instructions installed into migration workspaces | Yes |
| `migration/` | Registry CLI, guildctl CLI, OpenAI-compatible runtime files, test suite | Yes |
| `setup.ts` | Installer entrypoint that copies `package/` into a target workspace | Yes, as compiled `dist/setup.js` |
| `scripts/build-dist.mjs` | Builds the distributable tarball | Dev tool |

## Shipping model

The distributable kit is built from **`package/` plus selected top-level docs and the compiled installer**.

`scripts/build-dist.mjs` assembles:

- `dist/setup.js`
- `README.md`
- `GETTING-STARTED.md`
- `AGENTS.md`
- `package/` without source-only clutter such as `node_modules`, raw TypeScript, local `.env`, repo-only working trees, or maintainer-only architecture notes

Important consequence:

- If a migration capability should exist in user workspaces, it must be represented in **`package/`**
- If something is only for maintaining this repository, keep it at the repo root (for example `.github/agents/documentation-agent.agent.md`)

## Repository layout

### Top-level docs

- `README.md` — user-facing overview
- `GETTING-STARTED.md` — setup and first-run guide
- External maintainer-only notes — deeper architecture and agent customization reference material kept outside public repository history
- `DEVELOPMENT.md` — maintainer workflow and packaging rules
- `CHANGELOGS.MD` — repository-level change log for ongoing development

### Runtime and packaging paths

- `migration/` — canonical source for the registry and guildctl CLIs, test suite, and runtime code
- `dist/` — compiled installer and assembled tarball output
- `package/mock/` — packaged sample fixture content for setting up a separate test workspace

## Core workflows

### 1. Update repo-local maintainer behavior

Use the root `.github/` tree only when you are changing how Agent helps maintain **this repository itself**.

Typical examples:

- dev-only agents
- repo-local prompt shortcuts
- maintainer instructions

These changes do not ship.

### 2. Update shipped migration behavior

Use `package/` when you are changing what users receive after running the installer.

Common paths:

- `package/agents/`
- `package/skills/`
- `package/prompts/`
- `package/instructions/`
- `package/agent-instructions.md`

Do not mirror shipped agents, skills, prompts, or instructions into root `.github/`. `package/` is the source of truth for shipped Agent runtime behavior.

### 3. Test shipped behavior

Do not use this repository root as a migration workspace.

Instead:

1. Create a fresh workspace outside this repository.
2. Install the kit there with `npx guildctl-setup` or by unpacking the built tarball.
3. Copy a fixture into that external workspace when you need a reproducible migration scenario.

Use `package/mock/` for maintained sample content instead of recreating `legacy/` or `modern/` at the repo root.

### 4. Update installer behavior

`setup.ts` is the installer source. It:

- copies packaged agents, prompts, skills, and instructions into `.github/`
- writes `.github/agent-instructions.md` with the selected target framework
- optionally clones or copies legacy source into `legacy/`

If setup behavior changes, update:

- `setup.ts`
- packaged files under `package/` if the installed workspace should change
- user-facing docs if setup flow or resulting layout changes

### 5. Build the repo

Common commands:

```bash
npm run build
npm run build:dist
```

What they do:

- `npm run build` compiles `setup.ts` to `dist/setup.js`
- `npm run build:dist` runs the cross-platform dist builder, builds `migration/`, rebuilds `dist/setup.js`, then assembles `dist/__GUILDCTL_KIT_TGZ__`

## Source of truth

- `migration/` is the canonical source for CLI runtime code
- `package/` contains shipped Agent artifacts (agents, skills, prompts, instructions) but NOT runtime code
- Do not mirror runtime code between directories

For Agent artifacts, `package/` is the shipped source of truth and root `.github/` is repo-only maintainer context. Do not reintroduce mirrored runtime copies under root `.github/`.

## Inventory classification quality contract

Stack packs must provide a structured `classification.yaml` and reference it from `stack.yaml` with `classification_spec: classification.yaml`.

Required fields:

- `frameworks.allowed`: canonical source framework identifiers accepted in the registry.
- `frameworks.aliases`: normalization map for human/model variants.
- `frameworks.fallback`: canonical no-evidence fallback. Java uses `plain-java`; never use broad `Java-EE` as fallback.
- `frameworks.ambiguous`: canonical value for equal-precedence conflicting evidence.
- `roles.allowed`: registry role vocabulary only; do not invent stack-specific roles like `servlet`.
- `modules.source_roots`: stack-defined source-root regex rules that derive `artifact.module` from build/source-set ownership, not package names. Java examples: `legacy/app/src/main/java/...` → `app`, `legacy/app/src/test/java/...` → `app-test`, `legacy/it-selenium/src/test/java/...` → `it-selenium-test`, `legacy/db-utils/src/main/java/...` → `db-utils`.
- `signals`: deterministic source/path regex signals with `framework`, `role`, `priority`, `confidence`, and human-readable `evidence`.
- `quality.fallback_max_percentage`: advisory concentration threshold for large inventories unless the stack explicitly sets `fallback_concentration: error`.
- `quality.fallback_min_confidence` and `quality.fallback_required_evidence`: fallback records must prove high-confidence negative evidence. A mostly plain-code project can pass; files with configured framework signals may not silently fall through to fallback.
- `tags.generic` / `tags.meaningful`: lifecycle tags such as `analyzed` are generic and do not count as classification evidence.

Runtime contract:

- `guildctl` owns source scanning and first-class artifact registration.
- The context agent classifies that expected ID set only; it must not register extras unless a future orchestrator explicitly delegates second-class discovery. Inventory snapshots the registry before agent execution and rolls back any agent-created first- or second-class records on failure, while preserving legitimate pre-existing second-class artifacts.
- Classifications should be submitted via `registry batch-classify --file <json>`.
- `batch-classify` validates all rows before mutation, rejects duplicates/unknown IDs/unsupported frameworks/unsupported roles/missing evidence, supports `--dry-run`, and applies accepted records transactionally.
- The agent must run `registry mark-inventory-complete` after successful batch application. Exit code zero alone is not completion evidence.
- `guildctl run inventory` runs validation and refuses to print `Inventory complete` when quality fails.
- `guildctl run plan` independently re-runs the inventory-quality gate before stack-advisor/planner work.

Existing workspaces should run `node migration/registry/dist/cli.js migrate` (or rerun any guildctl phase, which applies schema idempotently) to create `artifact_classifications`, then rerun inventory so classifications are normalized under the active stack pack. Workspaces from the older package-derived-module scanner should clear and rescan inventory rather than reusing IDs/modules such as `org.apache...`: current Java module semantics are build/source-set ownership. Safe reset sequence for a failed inventory is:

```bash
# from the workspace using the packaged runtime paths
node migration/registry/dist/cli.js migrate
sqlite3 .guild/registry.sqlite "DELETE FROM artifact_classifications; DELETE FROM artifact_tags WHERE artifact_id IN (SELECT id FROM artifacts WHERE kind='legacy-source'); DELETE FROM artifacts WHERE kind='legacy-source'; DELETE FROM operator_state WHERE key='inventory_completion';"
GUILDCTL_INVENTORY_TIMEOUT_MINUTES=45 node migration/guildctl/dist/cli.js run inventory
node migration/guildctl/dist/cli.js run plan
```

Preserve hand-curated second-class descriptor/config artifacts unless they were created by the failed inventory run; inventory failure cleanup now handles newly-created unauthorized records automatically.

## Claim lease and run lifecycle notes

Recent runtime behavior depends on lease-backed claims and run-linked ownership.

Operator/runtime expectations:

- Claims are now represented by `artifact_claims` rows with `claim_id` + `claim_token` and lease timestamps.
- Worker runs are recorded with stable run IDs and ownership metadata (`owner_id`, `phase`) before subprocess launch.
- Worker agents are expected to claim exactly one artifact per run, heartbeat before finalizing, then advance status with claim credentials.
- Claim cleanup can happen by run ID, owner ID, lease expiry, or stale-run reconciliation.

Environment knobs introduced for migration pool reliability:

- `GUILDCTL_ANALYZE_TIMEOUT_MINS`
- `GUILDCTL_TEST_TIMEOUT_MINS`
- `GUILDCTL_CODE_TIMEOUT_MINS`
- `GUILDCTL_CLAIM_LEASE_MINS`

If any of the above semantics change, update both maintainer docs (`DEVELOPMENT.md`, `CHANGELOGS.MD`) and any external maintainer-only runtime architecture notes.

## Docs expectations for this repo

Use docs by audience:

- **Users of the kit** → `README.md`, `GETTING-STARTED.md`
- **Maintainers of the kit** → `DEVELOPMENT.md`, `CHANGELOGS.MD`

When a change affects maintainer workflow, packaging, source-of-truth boundaries, or repo-local automation, capture it in `DEVELOPMENT.md`.

When a change is notable enough that future maintainers should see it in chronological form, add it to `CHANGELOGS.MD` under `Unreleased` using a human-readable date heading with the related items listed beneath it, for example `### April 10, 2026`. These headings group unreleased development batches; they are not release dates.

## Documentation agent

This repository has a repo-local `documentation-agent`.

Current intent:

- keep maintainer docs current while the broader docs set is still evolving
- avoid touching shipped kit files just to document repo-only workflows
- keep the workflow lightweight locally until repository/CI automation is provisioned

Current doc targets:

- `DEVELOPMENT.md`
- `CHANGELOGS.MD`

### Run it manually

```bash
agent --agent documentation-agent --yolo -p \
  "Review the staged changes for the current commit in this repository. Update only DEVELOPMENT.md and CHANGELOGS.MD when the staged behavior changes require maintainer workflow notes or an unreleased changelog entry grouped under the appropriate human-readable date heading. If no such docs changes are needed, do not edit anything."
```

Then review only the maintainer docs:

```bash
git status --short -- DEVELOPMENT.md CHANGELOGS.MD
```

### Future automation

- Preferred end state: run the documentation agent after CI, not in `pre-commit`
- Until repo/CI provisioning is available, keep this as a manual maintainer step

### Agent binary selection

Use `AGENT_CMD` if you need to point at a non-default agent CLI binary.

Example:

```bash
AGENT_CMD=/path/to/agent agent --agent documentation-agent --yolo -p "<prompt>"
```

## Practical maintainer checklist

When making a change, ask:

1. Is this repo-only, or should it ship?
2. If it should ship as an Agent artifact, did I update `package/`?
3. If it changes CLI/runtime code, did I update `migration/`?
4. If it changes maintainer workflow, did I update `DEVELOPMENT.md`?
5. If it is worth recording for later context, did I add it to the correct `Unreleased` date group in `CHANGELOGS.MD`?
