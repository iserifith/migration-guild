# Agent Instructions

This repository is the **source code for the Migration Guild kit itself**. It is **not** a migration workspace.

## Working model

- Treat `package/` as the source of truth for shipped Agent runtime artifacts:
  - `package/agents/`
  - `package/skills/`
  - `package/prompts/`
  - `package/instructions/`
  - `package/agent-instructions.md`
- Treat root `.github/` as maintainer-only repo context.
- Treat `migration/` as the repo's live development copy of the shipped CLIs. This is the canonical source.

## Do not use this repo as a migration workspace

- Do not run migration phases against the repository root.
- Do not recreate repo-root `legacy/` or `modern/` testing trees.
- Do not add shipped migration agents, prompts, skills, or path instructions back under root `.github/`.
- When validating installed behavior, create a fresh workspace outside this repository and install or copy the kit there.

## Repo-local Agent behavior

The root `.github/` tree is only for maintainers working on the kit itself.

- Keep repo-only helper agents under `.github/agents/`.
- Keep shipped behavior under `package/`, not root `.github/`.
- Update `DEVELOPMENT.md` and `CHANGELOGS.MD` when maintainer workflow or repository architecture changes.
