---

description: "Task list for feature 007-doc-rag-lookup"
---

# Tasks: Version-Locked Documentation RAG for Codegen

**Input**: Design documents from `/specs/007-doc-rag-lookup/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (index-db-schema.md, mcp-tool-contract.md, ingestion-cli-contract.md), quickstart.md — all present and complete.

**Tests**: Included and sequenced before their implementation tasks. Constitution Principle V ("Tests Before Production Code") is flagged in plan.md's Constitution Check ("Deferred to tasks.md — flagged, not violated"), and quickstart.md's "Regression coverage" section enumerates the required `migration/test/*.test.ts` additions this file sequences.

**Organization**: Phase 3 = US3 (P1), Phase 4 = US1 (P1), Phase 5 = US2 (P1). Spec.md lists them US1 → US2 → US3; they are reordered here to US3 → US1 → US2 because ingestion (US3) is what populates `.guild/index.db` in the first place — US1's lookup and US2's verification have nothing to query until US3's write path and CLI exist, mirroring how plan.md's Summary and research.md sequence ingestion before consumption. All three remain independently testable per their own quickstart.md scenarios once their prerequisite phase is done.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no unmet same-batch dependency)
- **[Story]**: US1, US2, or US3 — omitted for Setup/Foundational/Polish tasks
- Every task names exact repository file paths

---

## Phase 1: Setup

**Purpose**: Establish a clean baseline before introducing the new sub-packages.

- [x] T001 Run `npm run build && npm run test` from the repository root and confirm both succeed on the current branch tip, establishing the green baseline that Phase 2 onward must not regress.
- [x] T002 [P] Add `@modelcontextprotocol/sdk` to `migration/package.json` dependencies (the only new runtime dependency this feature introduces — plan.md Technical Context) and run `npm install` to update `migration/package-lock.json`.

**Checkpoint**: Baseline green, new dependency available.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: `.guild/index.db` schema, its connection/types modules, the MCP server skeleton, and per-harness MCP wiring — everything every user story's implementation code depends on.

**⚠️ CRITICAL**: No user story implementation task may start until T003–T012 are complete.

- [x] T003 [P] Write the schema-delta test in `migration/test/index-db-schema.test.ts`, mirroring `migration/test/registry-schema-delta.test.ts`'s PRAGMA-introspection approach: after `applyIndexDbSchema(db)` on an in-memory database, assert `documentation_entries` exists with all columns and the `symbol_kind` CHECK constraint from `specs/007-doc-rag-lookup/contracts/index-db-schema.md`; assert the `UNIQUE(library_name, library_version, symbol_kind, symbol_name, signature)` constraint and the `idx_documentation_entries_library_version` index exist; assert the `documentation_entries_fts` FTS5 virtual table and its `documentation_entries_ai`/`documentation_entries_ad` sync triggers exist; assert `ingestion_runs` and `ingestion_run_libraries` exist with the `outcome` CHECK and the `ingestion_run_libraries` composite primary key. This test MUST fail until T004 lands.
- [x] T004 Add the `documentation_entries`, `documentation_entries_fts`, its sync triggers, `ingestion_runs`, and `ingestion_run_libraries` DDL verbatim from `specs/007-doc-rag-lookup/contracts/index-db-schema.md` to a new `migration/index-db/index_db_schema.sql`. Makes T003 pass. (depends on T003)
- [x] T005 [P] Implement `applyIndexDbSchema(db)` in a new `migration/index-db/schema.ts`, mirroring `migration/registry/db/schema.ts`'s `applySchema(db)` shape (idempotent, safe to call on every open, no `ensureColumn` guards needed since every object is `IF NOT EXISTS`). (depends on T004)
- [x] T006 [P] Implement `getIndexDb(dbPath?, workspaceRoot?)` in a new `migration/index-db/connection.ts`, mirroring `migration/registry/db/connection.ts`'s `getDb`: WAL mode, `foreign_keys = ON`, `busy_timeout = 5000`, auto-applies `applyIndexDbSchema` on first open, resolves its path via the new `resolveIndexDbPath` from T007. (depends on T005, T007)
- [x] T007 [P] Add `resolveIndexDbPath(options: { workspaceRoot?: string }): string` to `migration/guildctl/config.ts`, mirroring `resolveRegistryDbPath` (`config.ts:240-249`) exactly — default `".guild/index.db"`, resolved against `resolveWorkspaceRoot()`. Also add an `ingestion: { harness: string }` field to `GuildConfig` and `DEFAULT_GUILD_CONFIG`, default `"opencode"` (research.md §5) — deliberately independent of the existing top-level `harness` field.
- [x] T008 [P] Add `DocumentationEntry`, `IngestionRun`, and `IngestionRunLibrary` TypeScript interfaces (fields per `specs/007-doc-rag-lookup/data-model.md`) to a new `migration/index-db/types.ts`, following the existing `DependencyDisposition`-style interface convention in `migration/registry/types.ts`.
- [x] T009 Implement the MCP server skeleton in a new `migration/mcp-doc-server/server.ts`: stdio transport bootstrap using `@modelcontextprotocol/sdk`'s server helpers, opens `.guild/index.db` read-only via `getIndexDb` (T006), registers the server with no tools yet (tool handlers are added in T027/T032) — enough for `node migration/mcp-doc-server/server.ts` to start and respond to an MCP `initialize` handshake. (depends on T002, T006)
- [x] T010 [P] Extend `writeProviderConfig` in `package/harness/opencode.mjs` to add an `mcp` block to the generated `opencode.json` — `{ "guild-docs": { type: "local", command: ["node", "<resolved path to migration/mcp-doc-server/server.ts>"], environment: { GUILD_INDEX_DB_PATH: "<resolved index db path>" } } }` — added only when `parsed.agent` is one of `code-writer-agent`, `test-writer-agent`, `review-agent` (per `specs/007-doc-rag-lookup/contracts/mcp-tool-contract.md`'s "only Migrate/Critic-launching invocations register this server").
- [x] T011 [P] Extend `buildCodexInvocation` in `package/harness/codex.mjs` to append `-c mcp_servers.guild-docs.command=...` / `-c mcp_servers.guild-docs.args=...` overrides (same `-c key=value` style already used for `model_providers.migration_guild.*`), gated to the same agent allowlist as T010.
- [x] T012 [P] Extend `package/harness/goose.mjs` to write an `extensions.guild-docs` block (`{ cmd: "node", args: [...], type: "stdio" }`) into the goose config path it already manages, gated to the same agent allowlist as T010.

**Checkpoint**: `.guild/index.db` schema and connection exist and are typed; the MCP server process starts; all three harness adapters can register it for Migrate/Critic-persona launches. User story implementation can begin.

---

## Phase 3: User Story 3 — Operator ingests version-pinned documentation for the locked dependency set (Priority: P1) 🎯 MVP part 1

**Goal**: An explicit `ingest-docs` command populates `.guild/index.db` with documentation for exactly the confirmed `keep`-disposition libraries in spec 006's locked dependency set, every written entry carrying enforced provenance, with per-library failure isolation and idempotent re-runs (FR-003, FR-003a, FR-004, FR-005, FR-007, FR-012).

**Independent Test**: quickstart.md Scenarios 1 (populates exactly the keep set), 2 (provenance is write-path-enforced, not just conventional), and 6 (idempotent re-run + per-library failure isolation).

### Tests for User Story 3

- [x] T013 [P] [US3] Write the write-path invariant test in `migration/test/index-db-write-invariant.test.ts` covering: `upsertDocumentationEntry` throws `IndexDbError` when `source_url` or `source_excerpt` is empty (FR-003a); `entry_id` is deterministic (`sha1` of library/version/kind/name/signature per data-model.md), so re-inserting an identical entry is a no-op rather than a duplicate row (FR-007); and re-ingesting a library at a new locked version deletes all prior-version rows for that `(library_name, old_version)` in the same transaction that inserts the new-version rows (data-model.md's lifecycle note), leaving zero queryable rows for the old version afterward.
- [x] T014 [P] [US3] Write the `ingest-docs` command test in `migration/test/ingest-docs.test.ts` covering: the library set considered is exactly `getLockedDependencySet(db)` filtered to `disposition === 'keep'` (FR-005 — `replace-with-native`/`inline` libraries never appear in the report); each library's outcome is one of `indexed`/`skipped`/`unchanged`/`failed` with a `reason` required on `skipped`/`failed`; one library's simulated agent failure does not prevent the rest of the run from completing (FR-012); and a locked dependency set with zero `keep` rows produces a no-op report (`locked_set_snapshot_count: 0, libraries: []`) rather than an error (Edge Cases: "ingestion runs before spec 006's locked set exists").
- [x] T015 [P] [US3] Write the ingestion-harness preflight test in `migration/test/ingestion-harness.test.ts` covering: the ingestion agent always resolves against `config.ingestion.harness` (default `"opencode"`), independent of `config.harness`, even when the latter is set to `"codex"` or `"goose"`; when the resolved harness binary is missing/unreachable, `ingest-docs` fails closed (non-zero exit, clear message) rather than silently falling back to `config.harness`; and — Constitution Principle VII (`AGENT_CMD` escape hatch, research.md §5) — when `env.AGENT_CMD` is set, ingestion resolves to that custom binary via `resolveHarness()` exactly as it does for every other agent dispatch, taking priority over both `config.ingestion.harness` and `config.harness`.
- [x] T016 [P] [US3] Write the readiness-composition test in `migration/test/index-db-readiness.test.ts` covering: a helper that joins the latest `ingestion_run_libraries` row per `library_name` (by `ingestion_runs.completed_at`) against `getLockedDependencySet(db)` reports, per locked `keep` library, whether documentation coverage is `indexed`/`unchanged` (covered), `failed`/`skipped` (gap, with reason), or never attempted (not yet ingested) — satisfying FR-004/SC-005's "visible in workspace readiness/reporting rather than only in logs" without a separate readiness cache table.

### Implementation for User Story 3

- [x] T017 [US3] Implement `upsertDocumentationEntry` in a new `migration/index-db/commands/entries.ts`, following `upsertProposedDisposition`'s shape in `migration/registry/commands/dispositions.ts` (`IndexDbError` on validation failure, `db.transaction(...)` wrapping the version-supersede-delete-then-insert). Makes T013 pass. (depends on T008, T013)
- [x] T018 [US3] Implement `migration/guildctl/commands/ingest-docs.ts`: filter `getLockedDependencySet(db)` to `disposition === 'keep'`; for each library, skip agent dispatch and record `outcome: 'unchanged'` when `documentation_entries` already has current-version rows (FR-007 idempotency check per `specs/007-doc-rag-lookup/contracts/ingestion-cli-contract.md`); otherwise launch the `doc-ingestion-agent` persona via `resolveHarness()` (`harness.ts`) called with an effective config whose `harness` field is `config.ingestion.harness` instead of `config.harness` — **not** a separate resolution path — so `env.AGENT_CMD` still overrides it first exactly as it does for every other agent (research.md §5, Constitution Principle VII), following `runner.ts:423`'s `--agent <name> --model <model> --yolo -p <prompt>` invocation shape; write one `ingestion_runs` row and one `ingestion_run_libraries` row per library via T017's connection. Makes T014 pass. (depends on T017, T007, T014)
- [x] T019 [P] [US3] Add the `ingest-docs` and `index-doc-entry` subcommands to `migration/registry/cli.ts` (commander, alongside `locked-dependency-set`), per `specs/007-doc-rag-lookup/contracts/ingestion-cli-contract.md` — `index-doc-entry` is the agent-facing write endpoint the `doc-ingestion-agent` persona shells out to, delegating to `upsertDocumentationEntry` (T017). (depends on T017, T018)
- [x] T020 [P] [US3] Create `package/agents/doc-ingestion-agent.agent.md` per `specs/007-doc-rag-lookup/contracts/ingestion-cli-contract.md`'s persona content — forbids `legacy/`/`modern/` writes, states the source-URL-and-verbatim-excerpt requirement as a hard constraint, instructs skipping a symbol rather than inventing a citation when no source is found.
- [x] T021 [US3] Implement the fail-closed harness preflight for ingestion in `migration/guildctl/commands/ingest-docs.ts` (same file as T018 — sequential): run the existing `checkHarness()` check against T018's `resolveHarness()` result before dispatching any agent, and exit non-zero with a clear message if unreachable. This must never silently substitute `config.harness` for the pinned `config.ingestion.harness` default — but MUST still resolve to `env.AGENT_CMD` first when set, since T018's `resolveHarness()` call already checks it (Constitution Principle VII). Makes T015 pass. (depends on T007, T018, T015)
- [x] T022 [US3] Implement the readiness-composition helper (e.g. `getDocCoverageReadiness(indexDb, registryDb)`) in `migration/index-db/commands/entries.ts` (same file as T017 — sequential), joining `ingestion_run_libraries` (latest run per library) with `getLockedDependencySet(db)`. Makes T016 pass. (depends on T017, T016)

**Checkpoint**: quickstart.md Scenarios 1, 2, and 6 pass — ingestion populates exactly the locked keep set with enforced provenance, idempotently, isolating per-library failures, fail-closed on a missing harness, with coverage gaps visible to readiness reporting.

---

## Phase 4: User Story 1 — Migration agent looks up real API documentation before generating code (Priority: P1) 🎯 MVP part 2

**Goal**: The Migrate agent (`code-writer-agent`/`test-writer-agent`) can query `.guild/index.db` for exact, version-matching documentation or search it by approximate description, with oversized responses chunked to a token budget (FR-002, FR-002a, FR-008, FR-011, FR-015).

**Independent Test**: quickstart.md Scenarios 3 (exact lookup never crosses versions) and 4 (search finds a symbol by description).

### Tests for User Story 1

- [x] T023 [P] [US1] Write the lookup/search test in `migration/test/index-db-lookup.test.ts` covering: exact lookup by `(library_name, library_version, symbol_kind, symbol_name, signature)` returns the matching row when present, `not_found` when absent, and `unavailable` when the library isn't in the confirmed locked `keep` set at all (FR-005); two overloads of the same method (different `signature`) resolve to distinct entries (FR-011); and full-text search scoped to a `(library_name, library_version)` returns ranked candidates by relevance, with a query matching nothing returning an explicitly empty result distinct from `not_found` (Edge Cases).
- [x] T024 [P] [US1] Write the chunking test in `migration/test/index-db-chunking.test.ts` covering: a `description` exceeding the token-budget threshold is split into ordered chunks (`{ index, of }`), a repeat call with `chunk_index` returns the next chunk of the same entry, and a response under the threshold has no `chunk` field at all (FR-015).
- [x] T025 [P] [US1] Write the MCP handler test in `migration/test/mcp-doc-server.test.ts` covering `lookup_library_doc` and `lookup_library_doc_search` per `specs/007-doc-rag-lookup/contracts/mcp-tool-contract.md`: valid requests return the documented `found`/`not_found`/`unavailable`/`ok`/`empty` shapes; a malformed request (missing `symbol_name`, or `signature` omitted for a `method` kind) returns an MCP tool error, never a `not_found` (so a caller can't mistake its own bad request for a real hallucination signal).

### Implementation for User Story 1

- [x] T026 [US1] Implement `lookupEntry` and `searchEntries` (with chunking) in `migration/index-db/commands/entries.ts` (same file as T017/T022 — sequential). Makes T023 and T024 pass. (depends on T017, T023, T024)
- [x] T027 [US1] Implement the `lookup_library_doc` and `lookup_library_doc_search` tool handlers in `migration/mcp-doc-server/server.ts` (same file as T009 — sequential), delegating to T026 and returning the exact response shapes from `specs/007-doc-rag-lookup/contracts/mcp-tool-contract.md`, including the malformed-input-is-an-error behavior. Makes T025 pass. (depends on T009, T026, T025)
- [x] T028 [P] [US1] Extend `package/agents/code-writer-agent.agent.md` and `package/agents/test-writer-agent.agent.md` with instructions to call `lookup_library_doc` (falling back to `lookup_library_doc_search` when the exact symbol name isn't known) before generating a call into a kept third-party library, per FR-008.

**Checkpoint**: quickstart.md Scenarios 3 and 4 pass — Migrate can retrieve real, version-correct documentation and search it by description, independent of US2.

---

## Phase 5: User Story 2 — Critic agent verifies generated code against indexed documentation (Priority: P1)

**Goal**: The Critic agent (`review-agent`) can verify every library API reference in a generated artifact against the index in a single batch call, distinguishing verified-present, verified-absent (flagged), and unavailable (FR-010, FR-010a).

**Independent Test**: quickstart.md Scenario 5 — a batch of one real and one fabricated reference against the same ingested library/version comes back with exactly the real one `verified-present` and the fabricated one `verified-absent`, in one call.

### Tests for User Story 2

- [x] T029 [P] [US2] Write the batch-verify test in `migration/test/index-db-verify.test.ts` covering: `verifyReferences` returns one outcome per input reference, order-preserved; a batch mixing indexed and never-ingested libraries returns `unavailable` only for the latter, without failing the whole batch (Edge Cases); and a batch exceeding the token-budget-derived reference-count limit returns `truncated: true` with a `next_cursor` rather than silently dropping references.
- [x] T030 [US2] Write the MCP handler test for `verify_library_docs` in `migration/test/mcp-doc-server.test.ts` (same file as T025 — sequential) per `specs/007-doc-rag-lookup/contracts/mcp-tool-contract.md`: a batch request returns the documented `results`/`truncated` shape, with each `outcome` one of `verified-present`/`verified-absent`/`unavailable`.

### Implementation for User Story 2

- [x] T031 [US2] Implement `verifyReferences` in `migration/index-db/commands/entries.ts` (same file as T017/T022/T026 — sequential). Makes T029 pass. (depends on T026, T029)
- [x] T032 [US2] Implement the `verify_library_docs` tool handler in `migration/mcp-doc-server/server.ts` (same file as T009/T027 — sequential), delegating to T031. Makes T030 pass. (depends on T027, T031, T030)
- [x] T033 [P] [US2] Extend `package/agents/review-agent.agent.md` with instructions to collect every distinct library API reference in a reviewed artifact and submit them in a single `verify_library_docs` call, raising a hallucination-risk finding only for `verified-absent` outcomes and explicitly noting `unavailable` references as unverified rather than treating them as either a pass or a finding (FR-010).

**Checkpoint**: quickstart.md Scenario 5 passes. All three user stories independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Full-suite regression confirmation and end-to-end validation against the documented quickstart, plus the three success criteria that need a dedicated benchmark rather than falling out of the story-level tests above.

- [ ] T034 [P] Run `npm run build && npm run test` from the repository root and confirm no regressions in pre-existing suites, in particular `migration/test/registry-schema-delta.test.ts`, `migration/test/disposition-locked-set.test.ts`, and `migration/test/opencode-harness.test.ts`/`codex-harness.test.ts` (unaffected by the T010/T011 MCP-wiring additions for non-Migrate/Critic agent launches).
- [ ] T035 Execute `specs/007-doc-rag-lookup/quickstart.md` Scenarios 1–6 end-to-end against a scratch workspace, confirming every documented "Expected" outcome, including the `opencode`-only network/browsing prerequisite noted there. (depends on T021, T027, T032)
- [ ] T036 [P] Write the SC-006 search-quality benchmark test in `migration/test/index-db-search-benchmark.test.ts`: plant at least 10 queries (behavior descriptions, not exact symbol names) against a fixture of indexed entries across at least 3 libraries, and assert the correct entry appears in the top 3 ranked `searchEntries` results for at least 9 of the 10 (SC-006's "at least 90%" realized as "≥9 of 10"). (depends on T026)
- [ ] T037 [P] Write the SC-009 provenance-completeness audit test in `migration/test/index-db-provenance-audit.test.ts`: after a fixture ingestion run writes multiple `documentation_entries` rows, assert every row has a non-empty `source_url` and `source_excerpt` — a direct SQL scan, not just a reliance on T013's per-call rejection, so a future write path added outside `upsertDocumentationEntry` can't silently reintroduce unsourced rows. (depends on T017)
- [ ] T038 Build the SC-003 hallucination-reduction benchmark: a fixture artifact set that calls into at least one ingested library, run twice through the real Migrate→Critic pipeline against a scratch workspace — once with the MCP tool surface (T010-T012 wiring) registered for `code-writer-agent`/`review-agent`, once with it deliberately unregistered — recording each run's count of Critic findings whose reference matches a `verify_library_docs` `verified-absent` outcome (FR-010) via a small comparison script in `migration/test/doc-rag-hallucination-benchmark.test.ts` (or a `guildctl benchmark`-style CLI addition if the fixture size makes a `node:test` run impractical — follow `migration/registry/commands/benchmark.ts`'s `recordBenchmarkRun`/`compareBenchmarkRuns` persistence pattern for the two run records rather than inventing a new comparison format, but note this is a distinct axis from that file's existing `guild`-vs-`baseline` mode — no existing `BenchmarkMode` metric captures a hallucination-finding count, so this adds one rather than reusing `elapsed_ms`/`completion_rate`/etc.). Assert the with-lookup run's finding count is at least 50% lower than the without-lookup run's (SC-003). Because this exercises real Migrate/Critic agent behavior rather than deterministic unit logic (unlike T036/T037), treat a failing/flaky first run as a signal to inspect the fixture and prompt wiring, not to loosen the 50% bar. (depends on T027, T032, T028, T033)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories.
- **US3 (Phase 3)**: Depends on Foundational only.
- **US1 (Phase 4)**: Depends on Foundational; its implementation tasks additionally depend on US3's `entries.ts`/`server.ts` groundwork (see Shared-File Sequencing) — in practice US1 implementation starts after US3 implementation, even though US3 is reordered ahead of US1 from spec.md's listed priority order for exactly this reason.
- **US2 (Phase 5)**: Depends on Foundational; its implementation tasks depend on US1's `lookupEntry`/`server.ts` groundwork in the same shared files.
- **Polish (Phase 6)**: Depends on US3 + US1 + US2 all complete.

### Shared-File Sequencing

Several files are touched by more than one task across stories and must be edited in the order below (same-file edits are never parallel, even when both tasks carry the same `[P]`-eligible file-disjointness from *other* files):

- **`migration/index-db/index_db_schema.sql`**: T004 only (Foundational) — prerequisite for every story.
- **`migration/index-db/commands/entries.ts`**: created in T017 (US3: `upsertDocumentationEntry`) → extended in T022 (US3: readiness helper) → extended in T026 (US1: `lookupEntry`/`searchEntries`) → extended in T031 (US2: `verifyReferences`). Strict sequential order: T017 → T022 → T026 → T031.
- **`migration/mcp-doc-server/server.ts`**: skeleton in T009 (Foundational) → extended in T027 (US1: lookup/search handlers) → extended in T032 (US2: verify handler). Strict sequential order: T009 → T027 → T032.
- **`migration/guildctl/commands/ingest-docs.ts`**: created in T018 (US3) → extended in T021 (US3: fail-closed preflight, same story, sequential).
- **`migration/registry/cli.ts`**: T019 only (US3) — adds both `ingest-docs` and `index-doc-entry` in one task since both land together per the contract.
- **`migration/guildctl/config.ts`**: T007 only (Foundational) — `resolveIndexDbPath` and `ingestion.harness` land together; every later story reads but does not modify this file.
- **`package/harness/opencode.mjs` / `codex.mjs` / `goose.mjs`**: each touched exactly once, in Foundational (T010/T011/T012) — no story-phase task modifies them again.
- **`migration/test/mcp-doc-server.test.ts`**: created in T025 (US1) → extended in T030 (US2, same file, sequential — not marked `[P]` for that reason even though it is otherwise a disjoint-story task).

### Within Each User Story

- Tests are written first and MUST fail before their paired implementation task lands (Constitution Principle V).
- Index-db command functions before the MCP handlers that expose them.
- Command/handler logic before the persona-prompt tasks that instruct agents to call them.

### Parallel Opportunities

- Foundational: T003 and T007 and T008 (disjoint files); once T004/T005/T006 land, T009 (server skeleton) and T010/T011/T012 (three disjoint adapter files) can all proceed together.
- US3 tests: T013, T014, T015, T016 (four disjoint test files) — launch together.
- US3 implementation: T019 and T020 are file-disjoint from the T017→T018→T021→T022 chain once T017/T018 land.
- US1 tests: T023, T024, T025 (three disjoint test files) — launch together.
- US1 implementation: T028 is disjoint from the T026→T027 chain.
- US2 tests: T029 is disjoint from T030 only once T025 (the file T030 extends) already exists — treat as sequential within Phase 5, not parallel.
- US2 implementation: T033 is disjoint from the T031→T032 chain.
- Polish: T034, T036, and T037 are mutually disjoint. T035 (manual/scripted end-to-end run) is best done after T034 is green but touches no shared file. T038 (SC-003 benchmark) depends on the full US1+US2 chain (T027, T032, T028, T033) rather than only Foundational, so it's the last Polish task to become runnable — not parallel with T034/T036/T037's earlier availability, though it can run alongside them once its dependencies land.

---

## Parallel Example: User Story 3

```bash
# Tests — four disjoint files, launch together:
Task: "Write write-path invariant test in migration/test/index-db-write-invariant.test.ts"
Task: "Write ingest-docs command test in migration/test/ingest-docs.test.ts"
Task: "Write ingestion-harness preflight test in migration/test/ingestion-harness.test.ts"
Task: "Write readiness-composition test in migration/test/index-db-readiness.test.ts"

# After T017 (entries.ts) and T018 (ingest-docs.ts) land, these are file-disjoint:
Task: "Add ingest-docs/index-doc-entry subcommands to migration/registry/cli.ts"
Task: "Create package/agents/doc-ingestion-agent.agent.md persona"
```

---

## Implementation Strategy

### MVP First (Setup + Foundational + US3 + US1)

1. Complete Phase 1 (Setup) and Phase 2 (Foundational).
2. Complete Phase 3 (US3) — validate with quickstart.md Scenarios 1, 2, 6.
3. Complete Phase 4 (US1) — validate with quickstart.md Scenarios 3, 4.
4. **STOP and VALIDATE**: run `npm run test` plus quickstart.md Scenarios 1–4. This is the MVP — the index is populated with provenance-enforced documentation and the Migrate agent can query it, directly attacking the API-hallucination failure mode on the generation side, satisfying the issue's core rationale even before Critic-side verification (US2) lands.

### Incremental Delivery

1. Complete Setup + Foundational → index-db and MCP surface exist.
2. Add US3 → Test independently → operators can populate the index for a real workspace.
3. Add US1 → Test independently → Migrate agents stop guessing at API signatures.
4. Add US2 → Test independently → Critic closes the loop by catching what US1 missed.
5. Each story adds value without breaking previous stories; US1 and US2 both depend on US3 having run at least once against a given library before their scenarios have data to query, but their *code paths* (lookup/search vs. batch verify) are independent of each other.

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together (the MCP server skeleton and all three adapter wirings can be split across developers within Phase 2).
2. Once Foundational is done:
   - Developer A: US3 (ingestion) — unblocks the other two once its `entries.ts` write path lands.
   - Developer B: starts US1's tests/persona work in parallel, wiring implementation in once T017 lands.
   - Developer C: starts US2's tests/persona work in parallel, wiring implementation in once T026 lands.
3. Stories complete and integrate independently once the shared `entries.ts`/`server.ts` sequencing points are respected.

---

## Notes

- [P] tasks = different files, no dependencies.
- [Story] label maps task to specific user story for traceability.
- `entries.ts` and `server.ts` are each a single growing file touched by all three stories in sequence — this is a deliberate consequence of plan.md's Structure Decision (one command module, one server module) and is called out explicitly in Shared-File Sequencing above so it isn't mistaken for a parallelizable task.
- Verify tests fail before implementing.
- Commit after each task or logical group.
- Stop at any checkpoint to validate story independently.
