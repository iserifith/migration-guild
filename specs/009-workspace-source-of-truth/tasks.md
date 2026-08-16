# Tasks: Wave 1 — Workspace Source-of-Truth (Onboarding Hardening)

**Input**: Design documents from `/specs/009-workspace-source-of-truth/`
(Spec: Issue #130 — the three sub-issues #113/#114/#115 are one bug wearing three hats:
a `setup.ts`-produced workspace is not a complete, independently-runnable thing.)

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md,
data-model.md, contracts/config-contract.md, quickstart.md (all present in this feature dir).

**Tests**: Constitution §V requires behavior changes to ship with regression tests. The
`tasks.md` therefore includes test tasks where the spec/contract pins observable behavior
(FR-003/FR-004 toolkit-link removal, FR-005 orphan removal, FR-009 isolation). These are
written FIRST and must FAIL before the production code they cover is changed.

**Organization**: Tasks are grouped by user story so each story can be implemented and tested
independently. The three sub-issues are delivered as ONE coherent change (option (a):
self-contained workspace).

**Approach assumption (autonomous-run, no human available)**: Option (a) chosen — the workspace
produced by `setup.ts` is a complete, independently-runnable unit; `.guild/config.yaml` is the
single config source of truth; the kit bundles a built `migration/` runtime. These match
spec.md §Assumptions and research.md Decisions 1–6, and align with constitution §Repository
Source-of-Truth Boundaries.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Exact file paths included in every task

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the workspace-layout invariants and the contract test scaffolding that
the user-story phases depend on. No production code yet.

- [ ] T001 Create `migration/test/config-source-of-truth.test.ts` with failing contract tests for FR-005/FR-006/FR-009:
  - assert that a freshly scaffolded workspace contains `.guild/config.yaml` and NOT `guildctl.config.json`;
  - assert that edits to `.guild/config.yaml` (via `config-set`) are reflected by `guildctl config` output;
  - assert two workspaces resolve distinct `profiles.default.model` (isolation). Use `scaffoldGuildConfig`, `resolveGuildConfig`, and `setDottedPath` from `migration/guildctl/config.ts`.
- [ ] T002 [P] Amend `migration/test/workspace-isolation-defaults.test.ts` (lines 54–67) to drop the "init creates symlinks `migration`/`package`/`stacks` pointing into the toolkit checkout" assertion. Replace with: when `migration/`, `package/`, `stacks/` already exist locally in the workspace, `scaffoldGuildConfig` leaves them intact (no re-link); and toolkit-fallback links are created ONLY when a dir is absent. Keep the existing distinct-registry-db test (line 74) and the toolkit-checkout WARNING test (line 101) intact. This is the sanctioned Decision-3 contract change from research.md.
- [ ] T003 [P] Add a failing test in `migration/test/workspace-isolation-defaults.test.ts` (or a new `init-toolkit-free.test.ts`) asserting `scaffoldGuildConfig(root)` succeeds and exits cleanly for a workspace that has NO sibling `package/`/`stacks/`/`migration/` checkout and emits NO "missing toolkit target" error (FR-003/FR-004). Drive it through `migration/guildctl/cli.ts init` in a temp dir.

**Checkpoint**: Tests compile and FAIL (red) — proving the current code still requires a toolkit-root and still emits the orphan config. Implementation begins in the user-story phases.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The single code change that unblocks all three user stories — make `init`/`config`
fully workspace-local so a self-contained workspace needs no sibling toolkit-root.

- [ ] T004 Make `scaffoldWorkspaceLinks` in `migration/guildctl/config.ts` (lines 319–323) workspace-local and non-fatal: for each of `migration`/`package`/`stacks`, if the workspace-local directory already exists as a real dir, SKIP linking (Decision 3). Only fall back to `ensureLinkOrJunction` into `findToolkitRoot()` when the local dir is absent. If neither a local dir nor a toolkit target exists, emit an actionable message ("run setup, or provide <dir>") instead of throwing "missing toolkit target" (FR-003/FR-004, constitution §VI fail-closed).
- [ ] T005 Update `scaffoldGuildConfig` in `migration/guildctl/config.ts` (line 380) to call the amended `scaffoldWorkspaceLinks(root)` and guarantee `init` never throws for a self-contained workspace. Verify the `.github/` subdirs, `.guild/prompts/default/`, `.guild/runs/`, `.guild/evidence/`, and `.guild/.env.example` are still created (Contract 2 postconditions). Idempotency (no `--force` preserves existing config) is already present and must be preserved.

**Checkpoint**: Foundational done — US1/US2/US3 can now be implemented/tested independently.

---

## Phase 3: User Story 1 — Self-contained workspace from setup (Priority: P1) 🎯 MVP

**Goal**: A `setup.ts`-produced workspace contains a built `migration/` runtime and a correct
local config so `node migration/dist/guildctl/cli.js --help` works with no sibling checkout
(FR-001/FR-002/FR-011, sub-issue #115 + kit half of #113).

**Independent Test**: On a machine with only the distributed kit tarball, extract → `node setup.js`
→ `node migration/dist/guildctl/cli.js --help` succeeds AND `guildctl.config.json` is absent
(Scenario A in quickstart.md; SC-001, SC-004).

### Tests for User Story 1

- [ ] T006 [P] [US1] Add a build-dist assertion test (or script check) that the assembled tarball contains `migration/dist/guildctl/cli.js` (pre-built runtime) and does NOT contain a root `guildctl.config.json`. Place in `scripts/` or `migration/test/`; reference `scripts/build-dist.mjs` output `dist/migration-guild-kit.tar.gz`.

### Implementation for User Story 1

- [ ] T007 [P] [US1] In `scripts/build-dist.mjs`, bundle the built `migration/` runtime into the kit: after `npx tsup` builds `migration/` (Step 1), copy `migration/` (excluding `node_modules`, `registry.db*`) into `buildDir/migration` so the tarball carries `migration/dist/guildctl/cli.js`. Stop filtering `migration/` out in `shouldCopyPackageEntry`/assembly (currently top-level `migration` is skipped at line 102). No `guildctl.config.json` is copied.
- [ ] T008 [US1] In `setup.ts`, confirm the existing `ROOT_MAPPINGS.tools → migration` copy (lines 41–47, 179–187, 99–109) preserves the built runtime during both install and `--update`, and that it already skips `node_modules`/`registry.db*`. Add a "Next steps" note that the `cd migration && npm install` build step is OPTIONAL when `migration/dist/` is already present (research.md open item) — do not imply a self-contained runtime that isn't there (FR-001/FR-002, FR-010).

**Checkpoint**: A kit-built tarball yields a runnable workspace with no checkout. US1 independently testable via Scenario A.

---

## Phase 4: User Story 2 — Documented config file is the one the runtime uses (Priority: P2)

**Goal**: Following GETTING-STARTED.md edits the file the runtime actually reads
(`.guild/config.yaml`); the orphan `guildctl.config.json` is gone from setup output, kit, and
docs (FR-005/FR-006/FR-007/FR-009, sub-issue #113).

**Independent Test**: Follow GETTING-STARTED's "Configure OpenAI-compatible runtime" verbatim
against a fresh workspace; `guildctl config` reflects the edited `profiles.default.base_url` /
`api_key_env` / `model` and top-level `harness:`. No `guildctl.config.json` present (Scenario C;
SC-002, SC-004).

### Tests for User Story 2

- [ ] T009 [P] [US2] Extend `migration/test/config-source-of-truth.test.ts` (T001) with a doc-follows-config scenario: after `init`, `config-set profiles.default.base_url "<url>"`, `config-set profiles.default.api_key_env "EXAMPLE_KEY"`, `config-set harness "opencode"`, assert `resolveGuildConfig().model.base_url` and `.api_key_env` and `.harness` reflect the edits (FR-006). This is the SC-002 gate.

### Implementation for User Story 2

- [ ] T010 [US2] In `setup.ts` (lines 201–210), remove `guildctl.config.json` from the root-file copy list so it is no longer emitted into workspaces. Keep `.env.example` and `agent-shim.mjs`. (This alone closes the setup-output half of #113 / FR-005.)
- [ ] T011 [US2] Delete the orphan root `guildctl.config.json` from the repository (it is never loaded by the runtime — research.md Decision 1). Confirm no remaining reference in `setup.ts`, `benchmark.ts`, `GETTING-STARTED.md`, or `scripts/build-dist.mjs` before deletion.
- [ ] T012 [US2] In `migration/guildctl/commands/benchmark.ts` (lines 92–95), remove `guildctl.config.json` from the `copyWorkspace` root-file copy loop (dead weight; Decision 1). Keep `.env.example` and `agent-shim.mjs`.
- [ ] T013 [US2] Rewrite the "Configure OpenAI-compatible runtime" section of `GETTING-STARTED.md` (lines 120–132) to instruct editing `.guild/config.yaml` with the exact schema the runtime reads: `profiles.default.base_url`, `profiles.default.api_key_env`, `profiles.default.model`, and top-level `harness:`. Remove ALL `guildctl.config.json` references. Add an explicit `guildctl init` step between setup (step 5) and running pipeline phases so `.guild/config.yaml` is created (FR-007/FR-008). Reference `.env` only for the API-key env var, not for config.
- [ ] T014 [US2] In `GETTING-STARTED.md` (line 38), fix the step-5 note that points users at `guildctl.config.json`; it must point at `.guild/config.yaml` instead.

**Checkpoint**: Docs and setup output agree on `.guild/config.yaml`; orphan removed everywhere. US2 independently testable via Scenario C.

---

## Phase 5: User Story 3 — `guildctl init` works for any workspace shape (Priority: P3)

**Goal**: `init` succeeds for a workspace with no sibling toolkit-root, using workspace-local
copies and never throwing a cryptic "missing toolkit target" (FR-003/FR-004, sub-issue #114).

**Independent Test**: From a tarball-extracted/copied workspace (own `migration/`/`package/`/
`stacks/`, no sibling checkout), `guildctl init` exits 0, produces `.guild/config.yaml`, and
`guildctl doctor` passes (Scenario B; SC-003).

### Tests for User Story 3

- [ ] T015 [P] [US3] Add `migration/test/init-toolkit-free.test.ts` (extends T003) asserting: (a) `init` in a workspace lacking `package/`/`stacks/`/`migration` siblings exits 0 and creates `.guild/config.yaml`; (b) re-running `init` without `--force` preserves an edited `.guild/config.yaml`; (c) `doctor` (if available) passes post-init; (d) NO "missing toolkit target" string appears in stderr.

### Implementation for User Story 3

- [ ] T016 [US3] Verify `migration/guildctl/cli.ts` `init` command (lines 121–134) calls `scaffoldGuildConfig(root, force)` and prints `Guild config ready: <path>`; ensure it does NOT add any toolkit-root precondition. The Foundations work (T004/T005) already removed the hard link requirement. Add a clear failure message path in `scaffoldWorkspaceLinks` for the genuinely-absent case (FR-004).
- [ ] T017 [US3] In `setup.ts` `--update` mode (`runUpdate`, lines 80–120), confirm it refreshes kit files while preserving `registry.db`, `legacy/`, `modern/`, and existing `.guild/config.yaml` (FR-010). Optionally add: during `--update`, remove a stale root `guildctl.config.json` if present (contract: orphan SHOULD be removed during update). No clobber of user-owned state.

**Checkpoint**: `init` works for every workspace shape; US3 independently testable via Scenario B.

---

## Phase N: Polish & Cross-Cutting Concerns

**Purpose**: Cross-cutting validation, docs consistency, and the regression guard before the PR
is marked ready.

- [ ] T018 [P] Update `CHANGELOGS.MD` under `Unreleased` with a human-readable date heading summarizing Wave 1 (#130): self-contained setup-produced workspace, `.guild/config.yaml` as sole config source of truth, removed orphan `guildctl.config.json`, `init` no longer requires a toolkit-root, kit now bundles built `migration/` runtime. (Constitution §Development Workflow: notable changes belong in CHANGELOGS.MD.)
- [ ] T019 [P] Update `DEVELOPMENT.md` if the kit-assembly / build-dist contract changed (it did — `migration/` is now bundled into the tarball). Document that the distributable includes a pre-built runtime so kit/tarball users need no separate build (constitution §Repository Source-of-Truth Boundaries + §Development Workflow packaging note).
- [ ] T020 Run `npm test` (migration suite `node --test` under `migration/test/` + Mission Control UI suite) and confirm ZERO regressions (SC-005). Specifically: amended `workspace-isolation-defaults.test.ts`, new `config-source-of-truth.test.ts`, and new `init-toolkit-free.test.ts` all pass; the `migration` suite + UI suite are green.
- [ ] T021 Execute the quickstart.md validation scenarios A–E against a kit-built tarball in a clean dir (no repo checkout): self-contained runnable workspace, `init` with no toolkit-root, docs-follows-config, config isolation, `--update` preserves user state. Record results as evidence (constitution §I Evidence Over Assertion) — exit code 0 is not completion; the scenarios must actually pass.

---

## Dependencies & Execution Order

### Phase Dependencies
- **Setup (Phase 1)**: No deps — write failing contract tests first (constitution §V).
- **Foundational (Phase 2)**: Depends on Setup (red tests exist). BLOCKS all user stories.
- **User Stories (Phase 3–5)**: All depend on Foundational completion. Can proceed in priority
  order P1 → P2 → P3; US2 and US3 are largely independent once Foundations land.
- **Polish (Phase N)**: Depends on all desired user stories complete.

### User Story Dependencies
- **US1 (P1)**: After Foundational. Also depends on `scripts/build-dist.mjs` change (T007) which
  is independent of the config code — can be done in parallel with US2/US3 file edits.
- **US2 (P2)**: After Foundational (config locality). Mainly doc + orphan-removal edits.
- **US3 (P3)**: After Foundational (T004/T005 removes toolkit-root requirement). Pure test +
  verification of existing `init` command.

### Within Each User Story
- Tests written FIRST, must FAIL before implementation (T001→T006/T009/T015).
- Implementation after red tests (T007/T008, T010–T014, T016/T017).
- Story complete before next priority checkpoint.

### Parallel Opportunities
- T002 and T003 (Setup tests) are independent files → parallel.
- T006 (build-dist test) vs T007 (build-dist impl) vs T010–T014 (doc/orphan edits) vs T016/T017
  (init verify) touch different files → largely parallelizable after Foundational.
- All `[P]`-marked tasks are safe to parallelize.

---

## Parallel Example: User Story 1

```bash
# Launch the build-dist test and the build-dist implementation together (different files):
Task T006: "Add build-dist assertion test for bundled migration/dist + absence of guildctl.config.json"
Task T007: "In scripts/build-dist.mjs, copy built migration/ (no node_modules/registry.db) into buildDir/migration"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)
1. Complete Phase 1: Setup — failing contract tests (T001–T003).
2. Complete Phase 2: Foundational — `scaffoldWorkspaceLinks`/`scaffoldGuildConfig` locality (T004/T005).
3. Complete Phase 3: US1 — kit bundles built `migration/` runtime (T006–T008).
4. **STOP and VALIDATE**: Scenario A (extract kit → setup → `node migration/dist/guildctl/cli.js --help`) passes with no checkout.
5. Implement US2 + US3, then Polish.

### Incremental Delivery
1. Setup + Foundational → red tests, then green.
2. US1 → test via Scenario A → MVP.
3. US2 → test via Scenario C.
4. US3 → test via Scenario B.
5. Polish → changelog/dev-docs + `npm test` regression guard (T020) + quickstart evidence (T021).

### Parallel Team Strategy
With multiple implementers:
- Developer A: Foundational (T004/T005) — blocks others, do first.
- After Foundations: Developer B → US1 (T006–T008), Developer C → US2 (T009–T014), Developer D → US3 (T015–T017).
- Polish (T018–T021) integrates everything and runs the regression guard.

---

## Notes
- [P] tasks = different files, no dependencies.
- [Story] label maps task to a specific user story for traceability to spec.md priorities.
- Every behavior change ships with a test (constitution §V): T001/T002/T003 (Setup), T006/T009/T015 (per-story).
- The `workspace-isolation-defaults.test.ts` amendment (T002) is a sanctioned, documented contract
  change (research.md Decision 3), NOT a silent regression — the old assertion pinned the
  toolkit-link model this feature retires.
- Verified root-cause for #114: `scaffoldGuildConfig` → `scaffoldWorkspaceLinks` →
  `ensureLinkOrJunction` throws "missing toolkit target" when no sibling toolkit-root exists.
  Fix is in `migration/guildctl/config.ts`, not in `setup.ts`.
- Verified root-cause for #115: `scripts/build-dist.mjs` `shouldCopyPackageEntry` skips top-level
  `migration/` (line 102), so the tarball never carries a built runtime. Fix is in
  `scripts/build-dist.mjs`.
- Verified root-cause for #113: `setup.ts` copies `guildctl.config.json` (line 202); docs
  (GETTING-STARTED.md:38/129) and `benchmark.ts` (line 92) reference it, but the runtime never
  loads it (`config.ts` only reads `.guild/config.yaml`). Fix removes the orphan end-to-end.
