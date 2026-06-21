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
| `package/tools/` | Registry CLI, guildctl CLI, Provider integrations, packaging-time runtime files | Yes |
| `setup.ts` | Installer entrypoint that copies `package/` into a target workspace | Yes, as compiled `dist/setup.js` |
| `scripts/build-dist.mjs` | Builds the distributable tarball | Dev tool |

## Shipping model

The distributable kit is built from **`package/` plus selected top-level docs and the compiled installer**.

`scripts/build-dist.mjs` assembles:

- `dist/setup.js`
- `README.md`
- `GETTING-STARTED.md`
- `AGENTS.md`
- `docs/`
- `package/` without source-only clutter such as `node_modules`, raw TypeScript, local `.env`, or repo-only working trees

Important consequence:

- If a migration capability should exist in user workspaces, it must be represented in **`package/`**
- If something is only for maintaining this repository, keep it at the repo root (for example `.github/agents/documentation-agent.agent.md`)

## Repository layout

### Top-level docs

- `README.md` — user-facing overview
- `GETTING-STARTED.md` — setup and first-run guide
- `docs/` — deeper architecture and Agent customization reference material
- `DEVELOPMENT.md` — maintainer workflow and packaging rules
- `CHANGELOGS.MD` — repository-level change log for ongoing development

### Runtime and packaging paths

- `migration/` — live development copy of the registry and guildctl CLIs used in this repo
- `package/tools/` — packaged copy of the same toolset that gets shipped
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
- `package/tools/`
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
- copies `package/tools/` into `migration/`
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
- `npm run build:dist` runs the cross-platform dist builder, builds `package/tools/`, rebuilds `dist/setup.js`, then assembles `dist/__GUILDCTL_KIT_TGZ__`

## Mirroring rules

The only intentional live mirror is:

- `migration/*` and `package/tools/*`

When runtime claim/run behavior changes, keep these pairs aligned in the same commit:

- `migration/registry/**` <-> `package/tools/registry/**`
- `__MIGRATION_GUILDCTL__/**` <-> `__PACKAGE_TOOLS_GUILDCTL__/**`
- `migration/registry_schema.sql` <-> `package/tools/registry_schema.sql`
- `migration/test/**` <-> `package/tools/test/**` for behavior-level regression coverage

For Agent artifacts, `package/` is the shipped source of truth and root `.github/` is repo-only maintainer context. Do not reintroduce mirrored runtime copies under root `.github/`.

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

If any of the above semantics change, update both maintainer docs (`DEVELOPMENT.md`, `CHANGELOGS.MD`) and the user-facing runtime architecture docs under `docs/`.

## Docs expectations for this repo

Use docs by audience:

- **Users of the kit** → `README.md`, `GETTING-STARTED.md`, `docs/`
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
2. If it should ship, did I update the `package/` copy?
3. If it changes `migration/`, did I update `package/tools/` too?
4. If it changes maintainer workflow, did I update `DEVELOPMENT.md`?
5. If it is worth recording for later context, did I add it to the correct `Unreleased` date group in `CHANGELOGS.MD`?
