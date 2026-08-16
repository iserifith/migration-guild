# Implementation Plan: Version-Locked Documentation RAG for Codegen

**Branch**: `007-doc-rag-lookup` | **Date**: 2026-08-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/007-doc-rag-lookup/spec.md`

**Note**: This template is filled in by the `$speckit-plan` command; its definition describes the execution workflow.

## Summary

Stand up `.guild/index.db`, a second workspace-local SQLite database holding
version-pinned Java API documentation for exactly the libraries spec 006's
confirmed locked dependency set marks `keep`, indexed for both exact lookup
(library+version+signature) and FTS5 full-text search. Populate it via a new
harness-driven `doc-ingestion-agent`, pinned to the `opencode` harness (the one
harness confirmed to ship native `webfetch`/`websearch` tools under this
project's OpenAI-compatible provider setup), invoked through a new
`ingest-docs` registry CLI command — never automatically, per Constitution
Principle VI. Every entry the agent writes must carry a source URL and a
verbatim excerpt (write-path-enforced, not just persona instruction),
satisfying "Evidence Over Assertion" for what would otherwise be an
ingestion-time hallucination risk. Migrate (`code-writer-agent`) and Critic
(`review-agent`) consume the index through a new, narrowly-scoped internal MCP
server exposing `lookup_library_doc`, `lookup_library_doc_search`, and the
batch `verify_library_docs` — registered per-harness via each harness's
already-confirmed MCP-client mechanism (opencode's `mcp` config block, codex's
`-c mcp_servers.*` overrides, goose's `extensions` block). Full technical
rationale in [research.md](./research.md); persisted shapes in
[data-model.md](./data-model.md); interface contracts in
[contracts/](./contracts/).

## Technical Context

**Language/Version**: TypeScript, compiled via `tsc`/`tsup` (`migration/tsconfig.json`, `migration/tsup.config.ts`); Node.js runtime, tests via `node --test` under `tsx` — same toolchain as spec 006, this feature extends the same `migration/` project rather than introducing a new one.

**Primary Dependencies**: `better-sqlite3` (already present, `.guild/index.db` connection mirrors `registry/db/connection.ts` — research.md §2/§3), `commander` (registry CLI, already present), `@modelcontextprotocol/sdk` (NEW — the only new runtime dependency this feature introduces, for the stdio MCP server per FR-009/contracts/mcp-tool-contract.md; no browsing/fetch library is added, per FR-014a).

**Storage**: A second SQLite database, `.guild/index.db` (`better-sqlite3`, WAL mode), schema in a new `migration/index-db/index_db_schema.sql` applied via a new `migration/index-db/schema.ts` — deliberately separate from `registry.db` (data-model.md; spec.md's Assumptions). No changes to `registry_schema.sql` or existing registry tables.

**Testing**: Node's built-in test runner via `tsx`, `migration/test/*.test.ts`, in-memory `better-sqlite3` (`new Database(":memory:")` + the new `applyIndexDbSchema(db)`) — same convention as every existing `disposition-*.test.ts` file; MCP tool contract tests exercise the server's request/response handlers directly (in-process), not a live stdio subprocess, for speed and determinism.

**Target Platform**: Linux/macOS developer and CI environments running `guildctl`/`registry` Node CLIs against a user's legacy-code workspace, plus (new) the ingestion agent's harness process (`opencode`, pinned — research.md §5) and the MCP server subprocess spawned by whichever harness launches Migrate/Critic agents.

**Project Type**: Single TypeScript CLI/library project (`migration/`), extended with one new sub-package (`migration/index-db/`) and one new small server package (`migration/mcp-doc-server/`) — not a restructure.

**Performance Goals**: SC-004 — ingestion of 20 libraries completes with a per-library report in under 10 minutes (agent-turn-bound, not index-bound: each library is one non-interactive `opencode run` invocation, matching the existing per-artifact agent-turn cost model in `migrate.ts`). SC-001/SC-002 — exact lookup is a single indexed `UNIQUE` read, sub-second. SC-006 — FTS5 search returns ranked results in the top 3 at least 90% of the time on a 10-query benchmark set (query-quality goal, not a latency goal — FTS5 query latency itself is not the bottleneck at this row-count scale).

**Constraints**: No browsing/fetch tool is built (FR-014a — reuse harness-native tools only); the new MCP server is read-only against `.guild/index.db` and scoped to index-query tools only (FR-009 as narrowed in Clarifications); every `documentation_entries` write requires non-empty `source_url` and `source_excerpt`, enforced at the write layer (FR-003a); ingestion never runs automatically (research.md §6); read-only over `legacy/` (Principle II — nothing in this feature touches `legacy/` or `modern/` except the existing `dispositionContextForArtifact` prompt-suffix path spec 006 already owns).

**Scale/Scope**: Per-library-per-version-per-symbol grain; tens to low hundreds of libraries per workspace (bounded by the locked keep set, itself bounded by spec 006's SC-004 500-library sizing), each contributing tens to low hundreds of `documentation_entries` rows (class + method-level, with per-overload rows per FR-011).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design below.*

| Principle | Assessment | Gate |
|---|---|---|
| I. Evidence Over Assertion | The single largest risk this feature introduces is an ingestion-time hallucination replacing a codegen-time one. Addressed structurally, not by instruction alone: `upsertDocumentationEntry` rejects any write missing `source_url`/`source_excerpt` (contracts/index-db-schema.md's write-path invariant) — an agent's unsourced claim cannot reach the index at all, mirroring how `confirmDisposition` rejects an invalid transition rather than trusting the caller. | PASS |
| II. Legacy Is Read-Only; `modern/` Is the Only Write Target | Ingestion writes only to `.guild/index.db`; the ingestion agent's persona (`doc-ingestion-agent.agent.md`) explicitly forbids `legacy/`/`modern/` writes. Migrate/Critic's new MCP tool calls are reads against `.guild/index.db`, adding no new write path to either tree. | PASS |
| III. Registry-Mediated Coordination | `.guild/index.db` is deliberately a second database, not registry state (research.md §2) — this is a documentation cache, not migration coordination state, so it does not need claims/leases/evidence machinery. It still coordinates through structured, queryable tables rather than conversation: ingestion outcomes are rows in `ingestion_run_libraries`, not log lines an operator has to parse. | PASS |
| IV. Separation of Powers: Builder, Critic, Arbiter | Not implicated in the builder/critic/arbiter sense — `lookup_library_doc`/`verify_library_docs` are read-only reference tools available to both Migrate (builder-side) and Critic (independent reviewer), analogous to how both already read `modern/` via `reference-agent`. Critic's verification remains independent: it queries the same index Migrate does, but its `verify_library_docs` calls and findings are its own turn, not something Migrate's turn produces or can suppress. | N/A / PASS |
| V. Tests Before Production Code | This plan phase produces no production code. `quickstart.md`'s "Regression coverage" section enumerates the `migration/test/*.test.ts` additions `tasks.md` must sequence ahead of/alongside implementation — new schema, a new write-path invariant, and new CLI/MCP surfaces all fall inside §V's "phase control flow" and "claims/evidence gates" scope by analogy (a rejected-write invariant is exactly this kind of gate). | Deferred to tasks.md — flagged, not violated |
| VI. Fail-Closed Automation | Ingestion is never automatic (research.md §6) — an explicit `ingest-docs` invocation is required, keeping its network/token cost visible and deliberate. If the pinned `opencode` harness isn't installed/reachable, ingestion fails closed via the existing `checkHarness()` preflight pattern rather than silently falling back to an unverified harness. One library's ingestion failure doesn't abort the run for the rest (FR-012) — same posture as Plan's per-artifact fail-closed-but-not-fail-stop behavior. | PASS |
| VII. Pluggable Stacks, Neutral Providers | v1 ingestion is Java/Maven-only, reusing the exact `groupId:artifactId` identity format the `java-spring` stack pack's `dependencies:` block already establishes (research.md §7) — no new stack-specific knowledge is hardcoded into core runtime; a second ecosystem would add its own identity/source-discovery convention without changing `documentation_entries`' shape. The LLM/harness layer stays swappable in principle (FR-014a documents *why* v1 pins one harness for ingestion specifically — a documented, justified exception, not a hardcoded assumption baked silently into core code). | PASS (with a scoped, documented exception — see below) |

**Complexity Tracking entry required**: pinning the ingestion agent to
`opencode` (research.md §5) is a narrower interpretation of Principle VII's
"harnesses MUST stay swappable" than the rest of the codebase follows (every
other agent dispatch inherits `config.harness`). Justified below rather than
silently deviating.

## Project Structure

### Documentation (this feature)

```text
specs/007-doc-rag-lookup/
├── plan.md              # This file ($speckit-plan command output)
├── research.md          # Phase 0 output ($speckit-plan command)
├── data-model.md         # Phase 1 output ($speckit-plan command)
├── quickstart.md         # Phase 1 output ($speckit-plan command)
├── contracts/             # Phase 1 output ($speckit-plan command)
│   ├── index-db-schema.md
│   ├── mcp-tool-contract.md
│   └── ingestion-cli-contract.md
└── tasks.md               # Phase 2 output ($speckit-tasks command - NOT created by $speckit-plan)
```

### Source Code (repository root)

Single existing TypeScript project (`migration/`) — no new top-level
directory outside it. Two new sub-packages, following the repository's
established boundary of "registry commands own persistence, guildctl owns
workspace/agent orchestration" (the same split spec 006 used):

```text
migration/
├── index-db/                              # NEW — mirrors migration/registry/db/ shape
│   ├── index_db_schema.sql                # documentation_entries, _fts, ingestion_runs, ingestion_run_libraries (contracts/index-db-schema.md)
│   ├── schema.ts                          # applyIndexDbSchema(db) — mirrors registry/db/schema.ts
│   ├── connection.ts                      # getIndexDb(dbPath?) — mirrors registry/db/connection.ts
│   └── commands/
│       └── entries.ts                     # NEW — upsertDocumentationEntry, lookupEntry, searchEntries, verifyReferences (contracts/index-db-schema.md, mcp-tool-contract.md)
├── mcp-doc-server/                        # NEW — small stdio MCP server
│   └── server.ts                          # lookup_library_doc / lookup_library_doc_search / verify_library_docs handlers, delegates to index-db/commands/entries.ts (contracts/mcp-tool-contract.md)
├── registry/
│   └── cli.ts                             # + ingest-docs, index-doc-entry commands (contracts/ingestion-cli-contract.md)
├── guildctl/
│   ├── config.ts                          # + resolveIndexDbPath(); + ingestion.harness config field, default "opencode" (research.md §5, contracts/index-db-schema.md)
│   └── commands/
│       └── ingest-docs.ts                 # NEW — filters getLockedDependencySet() to 'keep', dispatches doc-ingestion-agent per library (contracts/ingestion-cli-contract.md)
├── harness.ts                             # unchanged core resolver; MCP wiring lives in the per-harness adapter scripts below, not here
└── test/
    └── *.test.ts                          # new index-db schema/write-invariant/lookup/search/verify + ingest-docs CLI coverage (quickstart.md "Regression coverage")

package/
├── harness/
│   ├── opencode.mjs                       # writeProviderConfig gains an `mcp` block (mcp-tool-contract.md)
│   ├── codex.mjs                          # buildCodexInvocation gains -c mcp_servers.guild-docs.* overrides
│   └── goose.mjs                          # gains an extensions.guild-docs config.yaml block
└── agents/
    └── doc-ingestion-agent.agent.md       # NEW persona (contracts/ingestion-cli-contract.md)

stacks/java-spring/classification.yaml     # unchanged — reuses the existing dependencies: block's identity format; no new stack-pack knowledge needed for v1
```

**Structure Decision**: Extend the existing single-project layout in place.
`migration/index-db/` is a new sub-package rather than folding tables into
`migration/registry/` because `.guild/index.db` is a deliberately separate
database file (research.md §2) — mirroring its own connection/schema module
pair, the same way `registry/db/` is its own pair, keeps the "two databases"
decision structurally visible in the source tree rather than implicit.
`migration/mcp-doc-server/` is a new, small top-level package (not folded into
`index-db/`) because it has a distinct runtime shape — a long-lived stdio
server process, not a library other modules import — matching why
`registry/cli.ts` and `guildctl/cli.ts` are already separate entry points from
the modules they wrap.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Ingestion agent's *default* harness is pinned to `opencode` (`config.ingestion.harness`) rather than inheriting `config.harness` like every other agent dispatch (Principle VII) | FR-014a requires ingestion to use its harness's *already-existing* native web tools rather than this feature building one. Only `opencode` has confirmed native `webfetch`/`websearch` tools that work with this project's custom OpenAI-compatible provider setup (research.md §5); goose needs an unconfirmed MCP extension, codex's native web tool is tied to OpenAI-hosted accounts this project doesn't use. | Inheriting `config.harness` unconditionally was rejected: it would silently degrade to an unverified or likely-nonfunctional web-tool path for workspaces configured with a different primary harness — exactly the "guess past an unexplained failure" Principle VI forbids. Building a custom MCP-based `fetch_url` tool to make all harnesses uniform was rejected during `/speckit-clarify` (FR-009 explicitly scoped the new MCP server to index-query tools only). The chosen middle ground — a dedicated `ingestion.harness` config field, defaulting to the one harness confirmed to work, documented as a scoped exception here rather than silently baked into code — keeps the deviation visible and revisitable once goose/codex's web-tool support is verified (research.md §5's follow-up note). **This exception is scoped to the config *default* only — `env.AGENT_CMD` still overrides `ingestion.harness` exactly as it overrides `harness` for every other agent (research.md §5, tasks.md T018/T021), so Principle VII's `AGENT_CMD`-escape-hatch guarantee is not weakened, only the default-harness *selection* deviates.** |

## Post-Design Constitution Re-Check

*Re-evaluated after Phase 1 (`data-model.md`, `contracts/`, `quickstart.md`) — GATE: must pass before `tasks.md`.*

- **I. Evidence Over Assertion**: confirmed — `contracts/index-db-schema.md`'s
  write-path invariant makes `source_url`/`source_excerpt` a hard requirement
  enforced at write time (`IndexDbError` on violation), not a persona-only
  convention; `quickstart.md` Scenario 2 exercises the rejection directly.
- **II. Legacy Is Read-Only**: confirmed — no entity, contract, or file in
  `data-model.md`/`contracts/` touches `legacy/` or `modern/`; the
  `doc-ingestion-agent` persona (contracts/ingestion-cli-contract.md)
  explicitly forbids it.
- **III. Registry-Mediated Coordination**: confirmed — `.guild/index.db`
  remains a deliberately separate store from `registry.db` (design didn't
  drift back toward merging them); its own tables (`ingestion_runs`,
  `ingestion_run_libraries`) are the coordination record for ingestion state,
  not conversation or log-only output.
- **IV. Separation of Powers**: still N/A/PASS — no design change introduced a
  self-certification path; Critic's `verify_library_docs` calls are its own
  independent turn against the same read-only index Migrate reads.
- **V. Tests Before Production Code**: `quickstart.md`'s Regression coverage
  section is explicit and maps every new behavior class (schema, write-path
  invariant, lookup, search, batch verify, chunking, ingestion CLI, readiness
  composition) to required `migration/test/*.test.ts` coverage for the tasks
  phase.
- **VI. Fail-Closed Automation**: confirmed — `contracts/ingestion-cli-contract.md`
  documents the no-op-on-empty-locked-set case and per-library failure
  isolation (FR-012) precisely; `research.md` §5 documents the fail-closed
  preflight behavior when the pinned harness is unavailable.
- **VII. Pluggable Stacks, Neutral Providers**: the one documented exception
  (ingestion harness pinning) is captured in Complexity Tracking with a
  rejected-alternatives rationale and an explicit follow-up to revisit it —
  not a silent violation. Everything else (library identity format, v1's
  Java/Maven-only scope) stays stack-pack-driven per research.md §7.

No new violations surfaced during design beyond the one already justified in
Complexity Tracking. **Gate: PASS.**
