# legmod development guide

This file is for people changing the **kit itself**, not for users running a migration workspace.

## What this repository contains

legmod has two parallel concerns:

1. **Repository-local maintainer artifacts** used while developing the kit
2. **Packaged kit artifacts** copied into user workspaces by `setup.ts`

The split matters because not everything in this repository ships.

## Source of truth by area

| Path | Purpose | Ships |
| --- | --- | --- |
| `.github/agents/` | Repo-local maintainer agents for working on the kit itself | No |
| `.github/copilot-instructions.md` | Repo-local Copilot context for this repository | No |
| `package/agents/` | Agent definitions installed into migration workspaces | Yes |
| `package/skills/` | Skill definitions and shipped skill assets installed into migration workspaces | Yes |
| `package/prompts/` | Prompt shortcuts installed into migration workspaces | Yes |
| `package/instructions/` | Path-scoped instructions installed into migration workspaces | Yes |
| `package/tools/` | Registry CLI, legmod CLI, Foundry integrations, packaging-time runtime files | Yes |
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
- `docs/` — deeper architecture and Copilot customization reference material
- `DEVELOPMENT.md` — maintainer workflow and packaging rules
- `CHANGELOGS.MD` — repository-level change log for ongoing development

### Runtime and packaging paths

- `migration/` — live development copy of the registry and legmod CLIs used in this repo
- `package/tools/` — packaged copy of the same toolset that gets shipped
- `dist/` — compiled installer and assembled tarball output
- `package/mock/` — packaged sample fixture content for setting up a separate test workspace

## Core workflows

### 1. Update repo-local maintainer behavior

Use the root `.github/` tree only when you are changing how Copilot helps maintain **this repository itself**.

Typical examples:

- dev-only agents
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
- `package/copilot-instructions.md`

Do not mirror shipped agents, skills, prompts, or instructions into root `.github/`. `package/` is the source of truth for shipped Copilot runtime behavior.

### 3. Test shipped behavior

Do not use this repository root as a migration workspace.

Instead:

1. Create a fresh workspace outside this repository.
2. Install the kit there with `npx legmod-setup` or by unpacking the built tarball.
3. Copy a fixture into that external workspace when you need a reproducible migration scenario.

Use `package/mock/` for maintained sample content instead of recreating `legacy/` or `modern/` at the repo root.

### 4. Update installer behavior

`setup.ts` is the installer source. It:

- copies packaged agents, prompts, skills, and instructions into `.github/`
- copies `package/tools/` into `migration/`
- writes `.github/copilot-instructions.md` with the selected target framework
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
- `npm run build:dist` runs the cross-platform dist builder, builds `package/tools/`, rebuilds `dist/setup.js`, then assembles `dist/legmod-kit.tar.gz`

## Mirroring rules

The only intentional live mirror is:

- `migration/*` and `package/tools/*`

For Copilot artifacts, `package/` is the shipped source of truth and root `.github/` is repo-only maintainer context. Do not reintroduce mirrored runtime copies under root `.github/`.

## Docs expectations for this repo

Use docs by audience:

- **Users of the kit** → `README.md`, `GETTING-STARTED.md`, `docs/`
- **Maintainers of the kit** → `DEVELOPMENT.md`, `CHANGELOGS.MD`

When a change affects maintainer workflow, packaging, source-of-truth boundaries, or repo-local automation, capture it in `DEVELOPMENT.md`.

When a change is notable enough that future maintainers should see it in chronological form, add it to `CHANGELOGS.MD` under `Unreleased`.

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
copilot --agent documentation-agent --yolo -p \
  "Review the staged changes for the current commit in this repository. Update only DEVELOPMENT.md and CHANGELOGS.MD when the staged behavior changes require maintainer workflow notes or an unreleased changelog entry. If no such docs changes are needed, do not edit anything."
```

Then review only the maintainer docs:

```bash
git status --short -- DEVELOPMENT.md CHANGELOGS.MD
```

### Future automation

- Preferred end state: run the documentation agent after CI, not in `pre-commit`
- Until repo/CI provisioning is available, keep this as a manual maintainer step

### Copilot binary selection

Use `COPILOT_CMD` if you need to point at a non-default Copilot CLI binary.

Example:

```bash
COPILOT_CMD=/path/to/copilot copilot --agent documentation-agent --yolo -p "<prompt>"
```

## Practical maintainer checklist

When making a change, ask:

1. Is this repo-only, or should it ship?
2. If it should ship, did I update the `package/` copy?
3. If it changes `migration/`, did I update `package/tools/` too?
4. If it changes maintainer workflow, did I update `DEVELOPMENT.md`?
5. If it is worth recording for later context, did I add an `Unreleased` note to `CHANGELOGS.MD`?
