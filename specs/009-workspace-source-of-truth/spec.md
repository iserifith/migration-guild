# Feature Specification: Wave 1 — Workspace Source-of-Truth (Onboarding Hardening)

**Feature Branch**: `spec/issue-130`

**Created**: 2026-08-16

**Status**: Draft

**Input**: User description (Issue #130): "Wave 1 — Fix the config/workspace source of truth (onboarding hardening). A workspace produced by `setup.ts` isn't a complete, independently-runnable thing. Fix as a single coherent change covering #113 (docs edit the wrong config file), #114 (`guildctl init` requires a toolkit-root layout, fails for a copied/tarball workspace), #115 (`setup.ts` doesn't copy the `migration/` runtime into new workspaces)."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A kit/tarball user gets a complete, runnable workspace from setup (Priority: P1)

A user who downloads the kit (or copies a tarball into a fresh directory) runs the setup wizard and ends up with a workspace that contains everything needed to run the migration pipeline — agents, skills, stacks, harness, the `migration/` runtime, and a correct local config — without needing the kit source tree or a git checkout of the repository beside it.

**Why this priority**: This is the exact failure the black-box onboarding test reproduced (findings F4/F5/F6). Until a `setup.ts`-produced workspace is self-contained, nothing downstream in Wave 2 (build/scaffolding) or Wave 3 (provider/harness resolution) is reliably testable. It is the blocker described in the issue.

**Independent Test**: On a machine with only the distributed kit, run `setup.ts` into a clean directory, then run the smoke test `node migration/dist/guildctl/cli.js --help` and `guildctl config` with no surrounding checkout. Both must succeed. This single story is independently verifiable and delivers the core value (a runnable workspace).

**Acceptance Scenarios**:

1. **Given** a clean directory and only the distributed kit available, **When** the user runs `setup.ts`, **Then** the resulting workspace contains a `migration/` directory with a built runtime (so `node migration/dist/guildctl/cli.js --help` works without a separate checkout).
2. **Given** a workspace produced by `setup.ts`, **When** the user runs `guildctl init`, **Then** `init` completes successfully and creates `.guild/config.yaml` without requiring a sibling `package/`/`stacks/`/`migration/` toolkit-root layout.
3. **Given** a workspace produced by `setup.ts`, **When** the user opens the workspace config to set their provider, **Then** the file they edit is the one the runtime actually reads (`.guild/config.yaml`), and edits there change `guildctl config` output.

---

### User Story 2 - The documented config file is the one the runtime uses (Priority: P2)

A user following GETTING-STARTED.md to configure their OpenAI-compatible runtime edits the correct file with the correct schema, and that edit takes effect.

**Why this priority**: Finding F6 showed the docs tell users to edit `guildctl.config.json`, which the runtime never reads — so a literal-doc user cannot configure the runtime at all. This is the single highest-leverage doc bug in the test.

**Independent Test**: Follow GETTING-STARTED's "Configure runtime" instructions verbatim against a fresh workspace; confirm `guildctl config` reflects the provider/harness the doc told the user to set. Independently demonstrable without running a full migration.

**Acceptance Scenarios**:

1. **Given** GETTING-STARTED's runtime-configuration section, **When** a user edits the file and keys it specifies (e.g. `profiles.default.base_url`, `api_key_env`, `model`, and top-level `harness:`), **Then** `guildctl config` shows the edited values.
2. **Given** the workspace root, **When** the user inspects it after setup, **Then** there is no orphan `guildctl.config.json` that silently misleads them into editing a dead config (the file is either removed or made authoritative and actually read).
3. **Given** two workspaces on the same machine, **When** each has its own `.guild/config.yaml`, **Then** each `guildctl` invocation resolves config from its own workspace, not a shared/root file.

---

### User Story 3 - `guildctl init` works for any workspace shape (Priority: P3)

A user who already has a workspace (whether from `setup.ts`, a copy, or a tarball) can run `init` to produce valid local config without recreating a toolkit-root sibling layout.

**Why this priority**: Finding F5 — `init` hard-fails for the exact setup flow GETTING-STARTED describes, and the workaround (symlinking the repo's `package/`/`stacks/`) is not something a first-time user would know. It is a subset of the self-containment goal but worth isolating as its own testable slice.

**Independent Test**: From a tarball-extracted workspace (no `package/`/`stacks/` siblings), run `guildctl init` and confirm it exits 0 and produces a usable `.guild/config.yaml` plus the expected `.guild/` subdirectories.

**Acceptance Scenarios**:

1. **Given** a workspace that has its own bundled `package/`/`stacks/`/`migration/`, **When** `init` runs, **Then** `init` uses the workspace-local copies and does not require a sibling toolkit-root.
2. **Given** a workspace missing some toolkit dirs, **When** `init` runs, **Then** `init` materializes what it needs locally (or clearly reports what to run) instead of throwing a cryptic "missing toolkit target" error.

---

### Edge Cases

- What happens when `setup.ts` is re-run (`--update`) on an existing workspace that already has `migration/`, `.guild/`, and config? It must refresh kit files without clobbering the user's local config (registry, `legacy/`, `modern/`, and `.guild/config.yaml` are preserved).
- What happens when the kit does not yet contain a built `migration/dist/` (e.g. dev checkout where the user runs setup from source)? The wizard must still produce a consistent workspace — either by building, or by clearly documenting that this path requires a checkout with a built runtime, and must NOT imply a self-contained runtime that isn't there.
- What happens when a user has both a root `guildctl.config.json` (legacy) and `.guild/config.yaml`? The resolution must be unambiguous and documented; there must be exactly one source of truth.
- How does the system handle a copied workspace that was made before this fix (no `migration/` sibling)? `init`/doctor should guide rather than silently mislead.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The setup wizard (`setup.ts`) MUST produce a workspace that contains a `migration/` runtime directory with a built CLI (`migration/dist/guildctl/cli.js`) so that the documented smoke test (`node migration/dist/guildctl/cli.js --help`) succeeds immediately after setup, without any sibling checkout.
- **FR-002**: The setup wizard MUST copy the `migration/` runtime (skipping `node_modules`, `registry.db`, and other runtime-only artifacts) into the new workspace as part of both install and `--update` flows.
- **FR-003**: `guildctl init` MUST succeed for a workspace that has no sibling toolkit-root (no `package/`/`stacks/`/`migration/` directories beside it), using workspace-local copies when present and materializing what is needed otherwise.
- **FR-004**: `guildctl init` MUST NOT throw a "missing toolkit target" error for a workspace produced by the kit; if a required input is genuinely absent it MUST emit an actionable, human-readable message naming exactly what to run or provide.
- **FR-005**: There MUST be exactly one configuration source of truth for a workspace. If the runtime reads `.guild/config.yaml`, then either (a) the orphan root `guildctl.config.json` is removed from setup output and docs, or (b) `guildctl.config.json` is made authoritative and actually loaded by the runtime — but not both files existing as dead weight.
- **FR-006**: The runtime (`guildctl config`, `preflight`, `doctor`, and phase runs) MUST read the same config file that GETTING-STARTED.md instructs users to edit, and edits to that file MUST change resolved output.
- **FR-007**: GETTING-STARTED.md's runtime-configuration instructions MUST specify the file and schema the runtime actually uses (`.guild/config.yaml` → `profiles.default.base_url` / `api_key_env` / `model` and top-level `harness:`), replacing the incorrect `guildctl.config.json` guidance.
- **FR-008**: GETTING-STARTED.md MUST include an explicit `guildctl init` step between `setup` and running pipeline phases, so the `.guild/config.yaml` the runtime requires is created.
- **FR-009**: A workspace's config MUST resolve from its own `.guild/` directory, independent of any sibling or root config file, so two workspaces on one machine do not cross-contaminate.
- **FR-010**: The setup wizard's `--update` mode MUST refresh kit files (agents, skills, harness, `migration/`, stacks, config templates) while preserving the user's registry (`registry.db`), `legacy/`, `modern/`, and existing `.guild/config.yaml`.
- **FR-011**: The kit assembly (the distributable build) MUST include a pre-built `migration/` runtime so a tarball/kit user receives it without a separate build step.

### Key Entities *(include if feature involves data)*

- **Migration Workspace**: The directory produced by `setup.ts` — the single, self-contained source of truth for running a migration. Contains `legacy/`, `modern/`, `.github/` (agents/skills/prompts/instructions), `migration/` (runtime), `stacks/`, `harness/`, and `.guild/config.yaml` (config).
- **Guild Config (`.guild/config.yaml`)**: The authoritative, workspace-local configuration the runtime loads. Holds `profiles.default` (provider `base_url`, `model`, `api_key_env`) and `harness`, plus registry path and stack selection.
- **Kit / Distributable**: The packaged artifact assembled by the dist build that includes the wizard, the `package/` agent artifacts, and a pre-built `migration/` runtime.
- **Toolkit-Root Layout** (deprecated concept): The previous assumption that a workspace must sit beside a `package/`+`stacks/`+`migration/` source checkout. This requirement removes that assumption for initialized workspaces.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of the documented smoke-test steps in GETTING-STARTED.md pass against a workspace produced solely from the distributed kit, with no surrounding repo checkout.
- **SC-002**: A user following GETTING-STARTED.md verbatim can configure their provider and see that configuration reflected in `guildctl config` output (measured as: edit-the-doc-then-check passes without manual debugging).
- **SC-003**: `guildctl init` exits 0 against a tarball-extracted/copied workspace with no sibling toolkit-root, producing a valid `.guild/config.yaml` and a passing `guildctl doctor`.
- **SC-004**: Zero orphan/ambiguous config files remain in the workspace after setup — exactly one config file is both documented and read by the runtime.
- **SC-005**: Zero regressions in `npm test` (migration suite + Mission Control UI suite) introduced by the config-locality and setup changes.
- **SC-006**: The `--update` flow preserves user-owned state (registry, `legacy/`, `modern/`, `.guild/config.yaml`) across an upgrade, verified by a before/after comparison in the upgrade test.

## Assumptions

- **Approach chosen — (a) self-contained workspace.** Per the issue's framing, we adopt option (a): bundle `migration/` into the kit and make `init`/config fully workspace-local. This makes the workspace a complete, independently-runnable thing, which is the stated goal and aligns with the constitution's workspace-self-containment expectations (Source-of-Truth Boundaries). Option (b) ("workspace lives beside a checkout") was explicitly available but rejected because it does not produce a self-contained workspace and would keep init/setup fragile for kit/tarball users.
- **`.guild/config.yaml` is the authoritative config.** Investigation confirmed the runtime (`resolveGuildConfig`/`readGuildConfig` in `migration/guildctl/config.ts`) reads only `.guild/config.yaml`; the root `guildctl.config.json` is orphaned (written by setup, referenced by docs, but never loaded). We therefore make `.guild/config.yaml` the single source of truth and remove the orphan rather than wire up the JSON file.
- **Kit assembly already produces a tarball.** GETTING-STARTED references `scripts/build-dist.mjs` and a `__GUILDCTL_KIT_TGZ__` placeholder; this spec assumes the dist build can include a pre-built `migration/` runtime. The exact build plumbing is an implementation detail for the `tasks`/implement phase, not this spec.
- **`package/` and `stacks/` are already bundled by setup.** The wizard already copies agents/skills/stacks/harness; the gap is `migration/` runtime and config locality, so those are the focus.
- **No human was available to clarify.** Per the autonomous-run instructions, the three clarifying decisions above (approach (a) vs (b); config file = `.guild/config.yaml`; kit bundles built runtime) were made as the best-supported choices using the issue text, the constitution, and code investigation, and are documented here as explicit assumptions.
- **Registry, `legacy/`, `modern/` are user-owned.** These are not part of the kit's "source of truth" change beyond being preserved by `--update`; the workspace-source-of-truth fix is about kit-bundled and config files, not user data.
