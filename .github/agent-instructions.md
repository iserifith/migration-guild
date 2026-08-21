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

## Known issue: this checkout's `.git` can end up `core.bare = true`

The primary checkout at the repository root is sometimes provisioned (or re-provisioned) with
`core.bare = true` set in `.git/config`, even though a full working tree of checked-out files is
sitting right there. That is a self-contradictory git state — a bare repo is defined as having no
working tree — so git correctly refuses any working-tree-dependent command (`status`, `diff`,
`add`, `commit`, plain `checkout`) run directly here, failing with:

```
fatal: this operation must be run in a work tree
```

**If you hit that error in this repo root**:

1. Confirm it's this issue: `git config --get core.bare` (or `git --git-dir=.git --work-tree=. status` to sidestep it and check).
2. If `true`, fix it directly: `git config core.bare false`. This is safe — it does not touch any
   branch, worktree, or history, only how this one checkout treats its own working tree. Prefer
   this simple fix over `--git-dir`/`--work-tree` flags on every command, and over creating a new
   worktree just to route around it.
3. It has recurred more than once. If you fix it and it comes back in a later session, that means
   something in this environment's provisioning/bootstrap re-runs `git init --bare` (or sets
   `core.bare` explicitly) against this directory — flag it to a maintainer rather than silently
   re-fixing it every time; the recurring root cause needs to be found and removed, not just
   patched per-session.
4. Do **not** work around this by defaulting to a linked worktree (`.claude/worktrees/*` via the
   `EnterWorktree` tool, or manual `git worktree add`) for every task — that adds an extra
   `npm install` step at every level (root, `migration/`, `migration/ui/`) since a fresh worktree
   has no `node_modules`, and is unnecessary overhead for most work. Worktrees remain the right
   tool for genuinely isolating a branch's changes from a dirty working tree, or when a hook
   explicitly requires it — not as the routine fix for this specific config bug.
