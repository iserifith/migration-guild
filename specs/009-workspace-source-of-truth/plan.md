# Implementation Plan: Wave 1 — Workspace Source-of-Truth (Onboarding Hardening)

**Branch**: `spec/issue-130` | **Date**: 2026-08-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/009-workspace-source-of-truth/spec.md`
(Issue #130 — the three sub-issues #113/#114/#115 are one bug wearing three hats: a
`setup.ts`-produced workspace is not a complete, independently-runnable thing).

## Summary

Adopt option (a) from the issue: the workspace produced by `setup.ts` becomes a complete,
self-contained, independently-runnable unit. Concretely this plan: (1) makes
`.guild/config.yaml` the single configuration source of truth and removes the orphan
`guildctl.config.json` from setup output, the kit, `benchmark.ts`, and the docs (#113);
(2) removes the toolkit-root requirement from `guildctl init` so it works for any workspace
shape, using workspace-local `migration/`/`package/`/`stacks/` and never throwing a cryptic
"missing toolkit target" (#114); (3) ensures the kit/distributable bundles a built
`migration/` runtime so a tarball-extracted workspace has `migration/dist/guildctl/cli.js`
without a separate build step (#115). The three fixes are delivered as one coherent change so
downstream Wave 2 (build/scaffolding) and Wave 3 (provider/harness resolution) have a
workspace they can actually run against.

## Technical Context

**Language/Version**: TypeScript (Node.js 18+). `setup.ts` runs via `tsx`; `guildctl` is
built with `tsup` into `migration/dist/`.

**Primary Dependencies**: Node `fs`/`path`/`child_process` (setup), `commander` (CLI),
`better-sqlite3` (registry), `tsx`/`tsup` (build), `yaml` (config parsing — a small
hand-rolled YAML reader in `config.ts`, not a full parser). No new runtime dependencies are
required by this plan.

**Storage**: SQLite registry (`.guild/registry.db`, workspace-local). Not changed by this
plan beyond preservation guarantees.

**Testing**: `npm test` — the `migration` suite (`node --test` under `migration/test/`) and
the Mission Control UI suite. Behavior changes ship with updated regression tests.

**Target Platform**: Linux/macOS/Windows (NTFS junctions for the legacy link path; this plan
retires that path for self-contained workspaces).

**Project Type**: CLI tooling / onboarding scripts + docs. No new service or library surface.

**Performance Goals**: N/A (onboarding correctness, not throughput).

**Constraints**:
- Constitution §II: `legacy/` read-only; never written by setup beyond user copy/clone.
- Constitution §Repository Source-of-Truth Boundaries: kit = source; installed workspace =
  standalone. The kit MUST contain a built runtime, not expect one to be built by the user.
- Constitution §V: changes to `scaffoldWorkspaceLinks` and the config contract MUST ship with
  regression tests.

**Scale/Scope**: Three touched areas — `setup.ts`, `migration/guildctl/config.ts` +
`cli.ts`, `scripts/build-dist.mjs`, `GETTING-STARTED.md`, and `benchmark.ts` (dead-weight
removal). No new data model; filesystem-layout invariants only.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Evidence Over Assertion | PASS | Plan delegates verification to `npm test` + quickstart scenarios; no self-report. |
| II. Legacy Is Read-Only | PASS | `setup.ts` only copies/clones into `legacy/`; never edits it. |
| III. Registry-Mediated Coordination | PASS | Registry stays workspace-local (`.guild/registry.db`); isolation preserved. |
| IV. Separation of Powers | PASS | No certification logic touched. |
| V. Tests Before Production Code | PASS | Amended `workspace-isolation-defaults.test.ts` + new config/doc test required by tasks. |
| VI. Fail-Closed Automation | PASS | `init` must emit actionable messages, not cryptic throws (FR-004) — fail-closed, not fail-silent. |
| VII. Pluggable Stacks, Neutral Providers | PASS | `stacks/` still bundled/used; provider layer untouched. |
| Source-of-Truth Boundaries | PASS | Kit now bundles built runtime; workspace is standalone — directly satisfies the boundary. |

**No gate violations.** One sanctioned contract change: `workspace-isolation-defaults.test.ts`
lines 54–67 currently pin the *toolkit-link* model (init creates symlinks into the checkout).
Under the self-contained model that assertion is wrong and MUST be amended in the implement
phase (documented in `research.md` Decision 3). This is a deliberate, evidence-backed change,
not a silent regression.

## Project Structure

### Documentation (this feature)

```text
specs/009-workspace-source-of-truth/
├── spec.md              # (pre-existing, specify phase) feature spec
├── plan.md              # This file
├── research.md          # Phase 0: decisions resolving all NEEDS CLARIFICATION
├── data-model.md        # Phase 1: workspace/config/kit entities + invariants
├── quickstart.md        # Phase 1: end-to-end validation scenarios
├── contracts/
│   └── config-contract.md   # Phase 1: config file + init + setup CLI contracts
├── checklists/
│   └── requirements.md  # (pre-existing) requirement traceability
└── tasks.md             # Phase 2 output ($speckit-tasks — NOT created here)
```

### Source Code (repository root) — files this plan changes

```text
setup.ts                         # stop emitting guildctl.config.json; confirm migration/ copy
migration/guildctl/config.ts     # scaffoldGuildConfig: workspace-local, no toolkit-link requirement
migration/guildctl/cli.ts        # (init already calls scaffoldGuildConfig; verify no toolkit assumption)
migration/guildctl/commands/benchmark.ts  # drop guildctl.config.json copy (dead weight)
scripts/build-dist.mjs           # bundle built migration/ runtime into the kit tarball
GETTING-STARTED.md               # fix config-file + init-step docs (#113/#114)
guildctl.config.json             # DELETE from repo root (orphan source)
migration/test/workspace-isolation-defaults.test.ts  # amend toolkit-link assertion (Decision 3)
migration/test/ (new)            # doc-follows-config test (FR-006/FR-007)
```

**Structure Decision**: Single-project CLI/tooling change — no new modules or packages. The
delivered plan deliberately shows the concrete touched files rather than the template's
generic `src/` tree. All changes are within existing files plus one deleted orphan and one
new test file.

## Complexity Tracking

No constitution violations requiring justification. The only notable complexity is the
sanctioned test-contract amendment (Decision 3), which is a simplification (removes the
toolkit-link coupling), not added complexity — recorded above rather than here.

## Phase 0 → Phase 1 traceability

- `research.md` decisions 1–6 resolve all Technical-Context unknowns and pin the approach.
- `data-model.md` records the workspace/config/kit entities and the post-change invariants.
- `contracts/config-contract.md` locks the three external surfaces (config file, `init`,
  `setup`) that a kit user depends on.
- `quickstart.md` gives runnable validation scenarios mapped to SC-001..SC-006 and FR-001..FR-011.
- `tasks.md` (next phase, `$speckit-tasks`) will decompose the file-level edits above into
  ordered, verifiable tasks, each traceable to a requirement in `spec.md`.
