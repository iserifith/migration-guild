# Feature Specification: Version-Locked Documentation RAG for Codegen

**Feature Branch**: `007-doc-rag-lookup`

**Created**: 2026-08-16

**Status**: Draft

**Input**: User description: "Proposal: Version-locked documentation RAG for codegen (.guild/index.db + lookup_library_doc), GitHub issue #62. Create a local .guild/index.db (SQLite) storing version-pinned documentation (Javadoc / API specs) for target libraries. Migrate and Critic agents query it via a lookup_library_doc tool to prevent API hallucinations and ensure compatibility with locked library versions. Heaviest of the proposals: requires an ingestion pipeline for version-pinned docs, a tool surface for agents, and keeping the index in sync with the locked dependency set. Depends on the dependency-pruning proposal (#61 / spec 006) for the locked library versions it indexes. Scouting confirmed: no existing agent tool-registration surface exists in the codebase (agents run through a harness/CLI-adapter layer, not a registerTool/allowedTools framework) — standing up that tool-surface mechanism is additional in-scope work. #61's locked dependency set is only partially built today. Keep as its own spec — cross-cutting infrastructure, not a single-issue fix."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Migration agent looks up real API documentation before generating code (Priority: P1)

As a migration operator, when the Migrate agent is about to generate code that calls into a kept third-party library, I want the agent to be able to retrieve the actual, version-pinned API documentation for that library — matching the locked version from the dependency disposition set — so that generated code calls methods and signatures that really exist at that version instead of a hallucinated or wrong-version API.

**Why this priority**: This is the entire point of the feature — it directly attacks the API-hallucination failure mode observed in migration runs. Without a working lookup path, nothing else in this feature has value.

**Independent Test**: Given a workspace where a library has already been indexed at its locked version, invoke the lookup during a Migrate run against an artifact that uses that library, and confirm the returned documentation matches the real, version-correct API (verified against the library's published reference) and that the generated code only references members present in that documentation.

**Acceptance Scenarios**:

1. **Given** a library with a confirmed "keep" disposition and locked version, and its documentation already ingested into the index, **When** the Migrate agent needs information about that library's API while generating code, **Then** it can query the index by library + version and class/method and receive the matching documentation entry.
2. **Given** a documentation query for a library/version/symbol combination that is not present in the index, **When** the query runs, **Then** the agent receives an explicit "not found" result rather than a fabricated answer or a silent fallback to a different version's docs.
3. **Given** two different locked versions of the same library exist across different workspaces (or across a version bump), **When** a query is made, **Then** the index returns documentation for the exact locked version requested, never a nearby or default version.
4. **Given** the agent knows a library and version but only an approximate or partial symbol name (e.g., it recalls the method does something with "connection pooling" but not the exact method name), **When** it searches instead of doing an exact lookup, **Then** it receives a ranked set of candidate documentation entries from that library/version to choose from, rather than a hard "not found" that forces a guess.
5. **Given** a matched documentation entry (or a candidate set from search) is large — e.g., a class with dozens of methods — **When** it is returned to the agent, **Then** the response is sized to the agent's token budget (summarized or paginated) rather than dumped in full, with a way to request the next chunk or the full entry for a specific symbol.

---

### User Story 2 - Critic agent verifies generated code against indexed documentation (Priority: P1)

As a migration operator, I want the Critic agent to be able to check that a method or class referenced by newly generated code actually exists (with that signature) in the version-locked documentation index, so that hallucinated API usage is caught and flagged before the migration is accepted, not discovered later at compile or runtime.

**Why this priority**: Generation-time lookup (Story 1) reduces hallucinations but doesn't guarantee they're eliminated; an independent verification pass closes the loop and is what actually prevents bad code from being accepted. Tied for P1 because the issue's stated rationale ("prevent API hallucinations") requires both a producer-side and a checker-side use of the index to be credible.

**Independent Test**: Feed the Critic agent a generated code sample referencing one real (indexed) API call and one fabricated API call against the same locked library version; confirm the Critic flags only the fabricated call, citing the absence of a matching entry in the index.

**Acceptance Scenarios**:

1. **Given** generated code that references a library method with a signature present in the index for the locked version, **When** the Critic reviews it, **Then** no documentation-mismatch finding is raised for that reference.
2. **Given** generated code that references a library method/class not present in the index for the locked version, **When** the Critic reviews it, **Then** a finding is raised identifying the specific unverifiable reference and the library/version checked against.
3. **Given** a library used by generated code that has no documentation indexed at all (ingestion never ran for it), **When** the Critic reviews related code, **Then** it reports the verification as skipped/unavailable for that library rather than treating the absence of a hit as either a pass or a hallucination finding.
4. **Given** a generated artifact references many distinct library API calls (e.g., a class with 15 calls across 3 libraries), **When** the Critic reviews it, **Then** it can submit all referenced symbols in a single batch verification request and receive one result set (verified-present / verified-absent / unavailable per reference) rather than issuing one lookup per reference — keeping the review pass efficient and within the agent's per-turn tool-call and token budget.

---

### User Story 3 - Operator ingests version-pinned documentation for the locked dependency set (Priority: P1)

As a migration operator, I want to run an ingestion step that populates `.guild/index.db` with documentation for exactly the libraries and versions in the workspace's confirmed locked dependency set, so the index that agents query is always scoped to what this workspace actually depends on, at the versions it actually locked.

**Why this priority**: Stories 1 and 2 assume an index already exists; this is how it gets populated and kept correct. Without ingestion tied to the locked set, the index is either empty (stories 1/2 can't function) or drifts from what's actually in the target, reintroducing the version-mismatch risk the feature exists to prevent. P1 alongside the other two because none of them work without it.

**Independent Test**: Run ingestion against a workspace with a confirmed locked dependency set of 3 kept libraries at specific versions; confirm the index afterward contains documentation scoped to exactly those 3 libraries at exactly those versions, and confirm re-running ingestion after a version lock changes updates the index rather than leaving stale entries queryable.

**Acceptance Scenarios**:

1. **Given** a workspace with a confirmed locked dependency set, **When** ingestion runs, **Then** the index is populated with documentation for every kept library at its exact locked version, and the ingestion result reports which libraries succeeded, failed, or were skipped (e.g., no documentation source available).
2. **Given** a library's locked version changes after a re-plan (per spec 006's re-confirmation flow), **When** ingestion is re-run, **Then** the index reflects the new version's documentation and queries against the old version either return nothing or are clearly marked as stale/superseded, never silently served as current.
3. **Given** a library in the locked set for which no documentation source can be found or ingested, **When** ingestion completes, **Then** the workspace's readiness state reflects that this library's docs are unavailable, so operators and downstream agents know verification is degraded for it rather than assuming full coverage silently.
4. **Given** ingestion has already run for a library/version, **When** ingestion is invoked again without any change to the locked set, **Then** it does not needlessly re-ingest already-current documentation.

---

### Edge Cases

- What happens when the agent tool-registration surface needed for `lookup_library_doc` doesn't exist yet at all? This feature includes standing up an internal MCP server over stdio as an explicit scope item — it is not assumed to pre-exist (see Assumptions and FR-009).
- What happens when a full-text search query matches nothing in the index (no candidates above a relevance threshold)? Search returns an empty result set, distinct from the exact-lookup "not found" result, so the agent knows to fall back to a different query rather than assuming the library isn't indexed at all.
- What happens when a batch verification request (`verify_library_docs`) includes a mix of references across multiple libraries, some indexed and some not? The batch result carries one outcome per reference (verified-present / verified-absent / unavailable); one unavailable library in the batch does not fail or block the results for the other references.
- What happens when the locked dependency set (spec 006) has libraries without a confirmed disposition yet? Those libraries are excluded from ingestion until confirmed; querying them returns "not found," not a partial/unconfirmed answer.
- What happens when a documentation source for a library is ambiguous or unreachable (e.g., network/source access issues during ingestion)? Ingestion records the library as failed/unavailable for that run; it does not block ingestion of the rest of the locked set, and the failure is surfaced in workspace readiness.
- What happens when the same library/version is needed across multiple workspaces? Each workspace's `.guild/index.db` is scoped to that workspace; nothing here assumes or requires a shared cross-workspace cache in v1.
- What happens when generated code needs a symbol from a transitive dependency that isn't itself in the locked "keep" set? Lookup only covers libraries present in the workspace's confirmed locked dependency set; transitive-only libraries are out of scope and return "not found."
- How does the system handle documentation for overloaded methods or generic signatures? The index must be able to disambiguate by full signature (parameter types), not just method name, so lookups return the specific overload relevant to the generated call.
- What happens if ingestion runs against a workspace before spec 006 (locked dependency set) exists or is empty? Ingestion has nothing to do and completes as a no-op, clearly reported as such rather than as a silent success with zero entries.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST maintain a per-workspace local documentation index (`.guild/index.db`) that stores documentation entries keyed by library identity, exact version, and symbol (class/method/signature), and MUST also maintain a full-text search index (FTS5) over documentation content alongside those exact keys, so entries are reachable both by precise identity and by approximate/keyword search.
- **FR-002**: The system MUST provide an exact-match query capability that, given a library, an exact version, and a symbol reference, returns the matching documentation entry if present, or an explicit not-found result if absent — never a best-effort match from a different version or a fabricated answer.
- **FR-002a**: The system MUST provide a full-text search capability that, given a library, an exact version, and a free-text or partial query, returns a ranked list of candidate documentation entries from that library/version — for cases where the agent does not know the exact symbol name. Search results MUST be scoped to the specified library/version like exact lookups are (FR-002); search never crosses into a different version's documentation.
- **FR-003**: The system MUST provide an ingestion process that populates the index from the workspace's confirmed locked dependency set (per spec 006), scoped to exactly the kept libraries and their exact locked versions, and MUST populate the FTS5 index as part of the same ingestion pass.
- **FR-004**: Ingestion MUST report, per library, whether documentation was successfully indexed, skipped, or failed, and this status MUST be visible in workspace readiness/reporting rather than only in logs.
- **FR-005**: Libraries without a confirmed disposition, or with a disposition other than "keep," MUST NOT be queryable through the lookup path (replaced/inlined libraries have no locked version to index against).
- **FR-006**: When a library's locked version changes (re-plan / re-confirmation per spec 006), re-running ingestion MUST update the index so queries reflect the new version; documentation for a superseded version MUST NOT be served as if it were current.
- **FR-007**: Re-running ingestion for a library/version already current in the index MUST be a no-op for that entry (idempotent, does not require re-fetching unchanged documentation).
- **FR-008**: The Migrate agent's code-generation workflow MUST be able to invoke the documentation lookup while producing code for artifacts that use an indexed library, so lookups can inform generation rather than only happening after the fact.
- **FR-009**: Because no agent tool-registration surface currently exists in the codebase, this feature MUST stand up a standardized tool surface by implementing an internal MCP (Model Context Protocol) server exposing `lookup_library_doc` (and the other tools in this spec) over a stdio interface, rather than a one-off adapter bolted onto the existing harness/CLI-adapter layer. This is a deliberate commitment, not a placeholder: it gives every current and future agent framework a single, protocol-standard way to call these tools instead of each framework needing its own throwaway integration.
- **FR-010**: The Critic agent's review workflow MUST be able to check whether a specific API reference in generated code matches an indexed documentation entry for the locked version, and MUST distinguish three outcomes: verified-present, verified-absent (flagged as a hallucination risk), and unavailable (library/version not indexed, verification skipped).
- **FR-010a**: The tool surface MUST expose a batch verification operation (`verify_library_docs`) that accepts a list of library/version/symbol references in one call and returns one result (verified-present / verified-absent / unavailable) per reference, so the Critic can verify all API references in a reviewed artifact in a single round trip instead of one tool call per reference.
- **FR-011**: The documentation index MUST disambiguate overloaded/generic method signatures so a lookup returns the entry matching the specific signature used, not merely the first entry matching a method name.
- **FR-012**: Ingestion of one library's documentation failing MUST NOT prevent ingestion of the remaining libraries in the locked set for that run.
- **FR-013**: The index MUST be workspace-scoped (one `.guild/index.db` per workspace); this feature does not require a shared or cross-workspace documentation cache in v1.
- **FR-014**: The actual documentation source/ingestion mechanism per library (e.g., how Javadoc or API specs are located and parsed for a given library+version) MUST be pluggable per library ecosystem rather than hard-coded to a single source, since the locked set can include libraries from different ecosystems over time.
- **FR-015**: Tool responses (lookup, search, and batch verification results) MUST respect a bounded token budget: any single response that would exceed a defined size threshold MUST be chunked/paginated (or summarized with a pointer to the full entry) rather than returned in full, so a single large documentation entry or a large batch verification result cannot blow out an agent's context in one call.

### Key Entities

- **Documentation Index (`.guild/index.db`)**: The workspace-local SQLite store holding version-pinned documentation entries; keyed by library identity, exact version, and symbol/signature.
- **Documentation Entry**: A single indexed unit — library, exact version, class/method/signature, and the documentation content (description, parameters, return type/behavior) needed to verify or inform a code reference.
- **Ingestion Run**: A record of one ingestion pass over the locked dependency set — which libraries were attempted, and per-library outcome (indexed / skipped / failed) and reason.
- **Documentation Lookup**: A query made by an agent (Migrate or Critic) against the index for a specific library+version+symbol, returning a matched entry, an explicit not-found result, or an unavailable-library result.
- **Documentation Search**: A full-text query (FTS5-backed) made by an agent against a library/version's indexed documentation using free text or a partial symbol, returning a ranked candidate list rather than a single exact match.
- **Batch Verification Request/Result**: A Critic-side operation (`verify_library_docs`) submitting multiple library/version/symbol references in one call and receiving one verified-present/verified-absent/unavailable outcome per reference.
- **Tool Surface**: The internal MCP (Model Context Protocol) server, exposed over stdio, through which `lookup_library_doc`, documentation search, and `verify_library_docs` are exposed as callable operations to the Migrate and Critic agents (and to future agent frameworks), given no such tool-registration framework exists in the codebase today.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a workspace with a fully ingested locked dependency set, 100% of documentation lookups for indexed library/version/symbol combinations return the correct, version-matching documentation (verified against the library's published reference for a benchmark set of at least 20 symbols across at least 3 libraries).
- **SC-002**: Lookups for symbols not present in the index return an explicit not-found result in 100% of cases — zero instances of a query silently returning documentation from the wrong version.
- **SC-003**: On a benchmark migration run comparing generated code with and without documentation lookup available to the Migrate agent, code produced with lookup available shows a measurable reduction in Critic-flagged API-hallucination findings (target: at least 50% fewer such findings) on the same input artifacts.
- **SC-004**: Ingestion of a locked dependency set of 20 libraries completes with a per-library success/failure report in under 10 minutes, with partial failures not blocking the successfully ingested libraries from being queryable.
- **SC-005**: An operator can determine, without inspecting logs, which libraries in the current locked dependency set have usable documentation coverage and which do not, directly from workspace readiness reporting.
- **SC-006**: For a benchmark set of at least 10 queries where the exact symbol name is not known (only a description of behavior), full-text search returns the correct documentation entry within the top 3 ranked results at least 90% of the time.
- **SC-007**: No single tool response (lookup, search, or batch verification) exceeds the defined token budget threshold in testing across the benchmark libraries — oversized results are chunked/paginated in 100% of cases rather than returned whole.
- **SC-008**: A Critic review of an artifact referencing 15 distinct library API calls completes its documentation verification in a single batch tool call rather than 15 separate calls, measured on the benchmark migration run.

## Assumptions

- This feature depends on spec 006 (Planner-Emitted Dependency Disposition Records) for the confirmed locked dependency set it indexes. Spec 006 is itself only partially built as of this writing (the disposition-record machinery exists in outline but the full locked-set retrieval it defines is the actual prerequisite); this spec assumes spec 006 reaches the point of producing a queryable, confirmed locked dependency set with resolved versions before this feature's ingestion can run end-to-end. Where spec 006's delivery lags, ingestion against an empty or partial locked set is treated as a no-op per the Edge Cases, not an error.
- No agent tool-registration surface (e.g., a `registerTool`/`allowedTools` framework or MCP-server tool exposure) exists in the codebase today; agents currently run through a harness/CLI-adapter layer (`migration/guildctl/harness.ts`, driving `opencode`, `goose`, `codex`, or `copilot` per run). This spec commits to closing that gap with a standard internal MCP server over stdio (FR-009) rather than a bespoke adapter. This is confirmed feasible, not merely plausible: all three of `opencode`, `goose`, and `codex` — the harnesses `harness.ts` resolves today — are MCP-client-capable via a non-interactive, config-file-driven mechanism (opencode's `mcp` block in `opencode.json`; goose's `extensions` block in `config.yaml` with `type: stdio`, documented for headless/scripted setups; codex's `[mcp_servers.<name>]` in `config.toml`, settable via the same `-c key=value` override style `codex.mjs` already uses for provider config). None of the three existing adapter scripts (`package/harness/opencode.mjs`, `codex.mjs`, `goose.mjs`) wire this in today, so doing so for each is real, in-scope adapter work under FR-009 — not a discovered blocker. The fourth harness, `copilot` (`agent-shim.mjs`), was not checked for MCP support as part of this spec.
- SQLite is the storage substrate, consistent with the existing `registry.db` precedent (WAL mode, foreign keys, schema-managed) — `.guild/index.db` is a second, separate SQLite database rather than new tables in the registry, since it holds bulk reference documentation rather than workflow/decision state. SQLite's FTS5 extension is confirmed available: `better-sqlite3` is pinned at `12.8.0` in `migration/package.json`, and that version's bundled SQLite amalgamation is compiled with `SQLITE_ENABLE_FTS5` set (verified against the tagged upstream source) — no additional native module or runtime extension loading is required for FR-001/FR-002a.
- The token budget threshold that triggers chunking (FR-015) is an implementation-tunable constant, not a fixed number specified here; the requirement is that a bound exists and is enforced, not a specific token count.
- "Documentation" in scope means library API reference material (Javadoc-equivalent: classes, methods, signatures, descriptions) sufficient to confirm a method/class exists with a given signature — not full prose guides, tutorials, or migration articles.
- Per-ecosystem ingestion sources (e.g., how Javadoc is obtained and parsed for a Java library) are assumed to be implemented incrementally, starting with the ecosystem(s) actually present in locked dependency sets encountered first; the pluggable-source requirement (FR-014) is about not hard-coding to one source, not about shipping every ecosystem's ingestion on day one.
- Documentation ingestion for a given library/version is assumed to happen once per workspace and reused for the life of that locked version — not re-fetched on every migration run — consistent with the idempotency requirement (FR-007).
- Verification via the Critic (User Story 2) is advisory/flagging, not a hard build-blocking gate in v1 — consistent with how other Critic findings are surfaced today; making hallucination findings blocking is a policy decision left to existing Critic-severity handling, not introduced fresh by this feature.
