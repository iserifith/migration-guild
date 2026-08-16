# Quickstart: Validating Version-Locked Documentation RAG for Codegen

**Feature**: `007-doc-rag-lookup` | **Date**: 2026-08-16

Runnable validation scenarios proving the feature end-to-end. Per the
constitution, kit behavior is validated in a fresh workspace OUTSIDE this
repository using `package/mock/` sample content — never against the repo root.

## Prerequisites

- Kit built: `npm run build`.
- A scratch workspace bootstrapped per `GETTING-STARTED.md`, taken through
  spec 006's flow far enough to have a non-empty confirmed locked dependency
  set (`node migration/dist/registry/cli.js locked-dependency-set` returns at
  least one `keep` row with a `locked_target_version`) — e.g. reuse spec 006's
  own quickstart scenario 1 workspace after its `plan` run.
- `opencode` installed and reachable (`opencode --version`) — the ingestion
  agent is pinned to this harness for v1 (research.md §5) regardless of the
  workspace's configured primary `harness`.
- Network access from the workspace (the ingestion agent's harness-native
  `webfetch`/`websearch` tools need it) — this scenario cannot run fully
  offline in v1.

## Scenario 1 — Ingestion populates the index for exactly the locked keep set (US3, FR-003/FR-005)

```bash
node migration/dist/registry/cli.js locked-dependency-set   # note the keep rows + versions
node migration/dist/registry/cli.js ingest-docs --triggered-by operator
```

Expected: the JSON report lists one entry per `keep`-disposition library with
an `outcome` of `indexed`, `skipped`, or `failed` and a `reason` on any
non-`indexed` outcome; `replace-with-native`/`inline` libraries from
`locked-dependency-set` do not appear at all (FR-005). Every row in
`.guild/index.db`'s `documentation_entries` for an `indexed` library has a
non-empty `source_url` and `source_excerpt` (FR-003a) — spot-check with:

```bash
sqlite3 .guild/index.db "SELECT library_name, source_url FROM documentation_entries LIMIT 5;"
```

## Scenario 2 — Ingestion-time hallucination is structurally blocked (FR-003a, SC-009)

Attempt to write an entry missing provenance directly against the write path
(simulating a misbehaving agent turn):

```bash
node migration/dist/registry/cli.js index-doc-entry \
  --library "com.google.guava:guava" --version "33.2.1-jre" \
  --symbol-kind class --symbol-name "com.google.common.base.Preconditions" \
  --description "..." --source-url "" --source-excerpt ""
```

Expected: `IndexDbError` — the write is rejected before it reaches
`documentation_entries`, not merely discouraged by the agent's persona
instructions (`contracts/index-db-schema.md`'s write-path invariant).

## Scenario 3 — Exact lookup never crosses versions (US1, FR-002, SC-002)

After Scenario 1, simulate a query for a version other than the one just
ingested (e.g. bump the same library's locked version via
`confirm-disposition --locked-version <newer>` without re-running
`ingest-docs`):

```bash
node migration/dist/registry/cli.js locked-dependency-set   # confirm the new version
# lookup_library_doc call (via MCP client or a direct test harness) for the NEW version
```

Expected: `{"status":"unavailable","reason":"..."}` or `{"status":"not_found"}`
— never documentation from the stale, previously-ingested version. Re-running
`ingest-docs` for that library deletes the old-version rows in the same
transaction that writes the new ones (data-model.md's lifecycle note), then
the lookup returns `status: "found"` for the new version only.

## Scenario 4 — Search finds a symbol the agent doesn't know by name (US1, FR-002a, SC-006)

Via an MCP client (or a direct call into the query package used by the MCP
server), issue a `lookup_library_doc_search` call for the ingested library
with a behavior-description query instead of an exact symbol name (e.g.
"argument null check" against Guava's `Preconditions`).

Expected: `status: "ok"` with `checkNotNull`-family methods ranked in the top
candidates; a query against a different library/version scope than what was
ingested returns `status: "empty"`, not an error.

## Scenario 5 — Batch verification catches a fabricated call without penalizing the real one (US2, FR-010/FR-010a)

```bash
# verify_library_docs call with two references against the same ingested
# library/version: one real (e.g. Preconditions#checkNotNull(Object)) and one
# fabricated (e.g. Preconditions#checkNotBlank(String))
```

Expected: one `results` entry per input reference, in order; the real
reference is `verified-present`, the fabricated one is `verified-absent`, and
both come back from a single tool call (SC-008).

## Scenario 6 — Idempotent re-run and per-library failure isolation (FR-007, FR-012)

```bash
node migration/dist/registry/cli.js ingest-docs --triggered-by operator   # second run, no version changes
```

Expected: every previously-`indexed` library now reports `outcome: "unchanged"`
with `entries_written: 0` and the ingestion agent is not re-launched for it
(`contracts/ingestion-cli-contract.md`'s idempotency check). If one library in
the locked set has no discoverable documentation source, its row reports
`outcome: "failed"` with a reason, and the run still completes successfully
for the rest (FR-012) — verify via the run's summary that `libraries.length`
still equals `locked_set_snapshot_count`.

## Regression coverage this quickstart maps to

`tasks.md` must sequence `migration/test/*.test.ts` coverage ahead of/alongside
implementation (Constitution §V — this feature adds new schema, a new
registry-CLI command, and a new agent-dispatch path):

- index-db schema: tables/CHECKs/FTS5 virtual table + triggers exist as
  specified (mirror the registry's `registry-schema-delta.test.ts` approach);
- write-path invariant: `upsertDocumentationEntry` rejects missing
  `source_url`/`source_excerpt`; version-change deletes superseded rows
  in the same transaction;
- exact lookup: found / not_found / unavailable, overload disambiguation by
  signature (FR-011);
- search: ranked candidates scoped to library+version, empty ≠ not_found;
- batch verify: order-preserved per-reference outcomes, partial-batch
  unavailable does not fail the whole batch;
- token-budget chunking: an oversized entry/batch response is chunked, never
  returned whole (FR-015);
- ingestion CLI: locked-set filtering (`keep` only), per-library outcome
  reporting, idempotent unchanged-skip, one library's failure doesn't abort
  the run (FR-012), no-op on an empty locked set;
- readiness: doc-coverage gaps are visible via the composed
  `ingestion_run_libraries` + `getLockedDependencySet` read (FR-004/SC-005),
  not only in logs.
