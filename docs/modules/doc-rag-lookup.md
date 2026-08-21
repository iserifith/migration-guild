# The Documentation RAG Lookup Subsystem (`007-doc-rag-lookup`)

## What this is

This subsystem is the answer to a specific problem: during migration, the
agents that write and review code need to know the *authoritative API surface*
of the third-party libraries they are migrating against — at the *exact locked
version*, not whatever the latest docs happen to say. Without this, a
code-writer or reviewer can hallucinate a method signature, or cite docs for a
different version of the library than the one pinned in the workspace's locked
dependency set.

The subsystem provides three things, split cleanly across a write side and a
read side:

1. **A version-pinned documentation index** — a separate SQLite database,
   `.guild/index.db`, deliberately separate from `registry.db`.
2. **An ingestion pipeline** — the `guildctl ingest-docs` command dispatches
   the `doc-ingestion-agent` persona to read the authoritative docs for each
   *keep*-disposition library in the locked set and write entries into the
   index via a thin CLI (`index-doc-entry`).
3. **A read-only MCP server** (`guild-docs`) that exposes three tools —
   exact lookup, ranked full-text search, and batch reference verification —
   to the migrating/reviewing agents, each scoped strictly to one
   library+version pair.

Everything here lives under `migration/index-db/` (the store + write commands),
`migration/mcp-doc-server/` (the read server), the `ingest-docs` guildctl
command, and the `index-doc-entry` registry CLI command. The design contract is
`specs/007-doc-rag-lookup/`, and the whole feature was landed as a single
phased commit, so it is stable enough to document end to end.

## Architecture: two databases, one version-pinned store

The most important design decision is the *separation of the index from the
registry*. `registry.db` is the source of truth for migration *state* — claims,
artifacts, dispositions, verification results. `index.db` is a derived,
rebuildable *cache of documentation content* for third-party libraries. They
never share a connection, and each has its own schema, its own connection
module, and its own path resolver.

- Registry connection: `migration/registry/db/connection.ts`
- Index connection: `migration/index-db/connection.ts`
- Registry path: `resolveRegistryDbPath` in `migration/guildctl/config.ts:255`
- Index path: `resolveIndexDbPath` in `migration/guildctl/config.ts:273`

The two connection modules are near-identical in spirit (WAL mode, foreign keys
on, a 5s busy timeout, schema auto-applied on every open) but the index path
resolver is intentionally simpler — it just returns
`<workspaceRoot>/.guild/index.db` with no config override today. The comment at
`config.ts:267` notes that a future `database.index_path` override can be added
"the same way `database.path` overrides the registry, without a contract
change" — a deliberate, documented extension point.

### Read vs. write connections to the same file

A key subtlety: the two halves of the subsystem open `index.db` in *different
modes*.

- The **ingestion side** opens it read-write. `getIndexDb` in
  `migration/index-db/connection.ts:15` uses `new Database(resolved)` (writable),
  and the `index-doc-entry` CLI call in `migration/registry/cli.ts:1076` routes
  through it.
- The **MCP server** opens it strictly read-only. `openReadOnlyIndexDb` in
  `migration/mcp-doc-server/server.ts:36` uses
  `new Database(dbPath, { readonly: true, fileMustExist: true })`. The server
  "only answers queries; ingestion writes happen through the ingestion agent's
  own process" (server.ts:7). This is a real operational boundary, not a
  stylistic one: even if the agent prompted the MCP server to mutate state,
  there is no mutation path to reach — the handle literally cannot write.

This is worth calling out because it is the load-bearing reason the write path
has to be a separate CLI command (`index-doc-entry`) rather than an MCP tool.
The MCP server has no write capability by construction.

## The schema: `documentation_entries` + FTS5, plus ingestion-run bookkeeping

The schema is defined twice, in two files that must stay in sync:

- `migration/index-db/schema.ts:11` — an embedded string `INDEX_DB_SCHEMA`
- `migration/index-db/index_db_schema.sql` — the canonical SQL source

The embedded-in-TS duplication exists for a concrete build reason, documented
in the comment at `schema.ts:6`: the compiled `dist/index-db/schema.js` must
work "regardless of whether the bundler copied the `.sql` alongside it", since
both the registry CLI and the MCP server open the DB from build output, not
source. If you add a column, you must touch *both* files; `doc-consistency.test.ts`
guards against drift between them.

There are four tables (plus triggers and an index):

### `documentation_entries`
The actual documentation rows. Each row is one symbol (a class or a method) at
one library+version. Key columns:

- `entry_id TEXT PRIMARY KEY` — a deterministic hash id, see below.
- `library_name`, `library_version` — the pinned coordinates. A `UNIQUE
  (library_name, library_version, symbol_kind, symbol_name, signature)`
  constraint is the dedup key.
- `symbol_kind TEXT CHECK (symbol_kind IN ('class','method'))` — only these two
  kinds are supported (FTS5 index config and all validation assume it).
- `signature TEXT` — nullable. Disambiguates method overloads (FR-011). Deliberately
  `NULL` for class-kind entries (see the normalization rule in the write path).
- `description`, `return_type` — the prose and the return type.
- `source_url`, `source_excerpt` — the FR-003a provenance columns (more below).
- `ingestion_run_id`, `indexed_at` — provenance of when this row was written.

### `documentation_entries_fts`
An FTS5 **external-content** virtual table over `symbol_name` and `description`,
with `content='documentation_entries'` and `content_rowid='rowid'`. It does not
store its own copy of the text; it indexes the columns of the base table.

Because it is external-content, it is kept in sync entirely by triggers:
`documentation_entries_ai` (AFTER INSERT), `documentation_entries_ad` (AFTER
DELETE), and — the interesting one — `documentation_entries_au` (AFTER UPDATE).
The UPDATE trigger exists because the write path's `ON CONFLICT ... DO UPDATE`
upsert is a *real UPDATE statement*, not an INSERT; without the AU trigger, any
content correction that didn't change the unique key would leave the FTS index
stale (a silent correctness bug — the FTS index and base table would disagree).
The AU trigger handles it by deleting the old rowid from FTS then inserting the
new rowid's text. This is a subtle, easy-to-miss correctness detail that the
`index-db-schema.test.ts` and `doc-lookup-search.test.ts` suites exercise.

### `ingestion_runs` and `ingestion_run_libraries`
Bookkeeping for *how* entries got in. One `ingestion_runs` row per `ingest-docs`
invocation (with `triggered_by`, `started_at`, `completed_at`, and a snapshot of
how many libraries were in scope). One `ingestion_run_libraries` row per
library attempted, with an `outcome CHECK (outcome IN ('indexed','skipped',
'unchanged','failed'))` and an `entries_written` count. This gives an audit
trail of whether a library was freshly indexed, skipped, re-ingested-but-
unchanged, or failed — and why.

## The write path: `index-doc-entry` and `upsertDocumentationEntry`

The agent does not write to the DB through some agent-side library. It shells
out to the registry CLI:

```
node migration/registry/dist/cli.js index-doc-entry \
  --library <name> --version <v> \
  --symbol-kind <class|method> --symbol-name <name> [--signature <sig>] \
  --description <text> [--return-type <t>] \
  --source-url <url> --source-excerpt <verbatim text> \
  --ingestion-run-id <runId>
```

This is defined in `migration/registry/cli.ts:1061`. Its `action` handler
(migration/registry/cli.ts:1076) calls `upsertDocumentationEntry` from
`migration/index-db/commands/entries.ts:88`. The command accepts an
`--index-db <path>` flag that overrides `GUILD_INDEX_DB_PATH` env, which is how
the ingestion agent (running in its own process) targets the same file the
`ingest-docs` command opened in-process.

### FR-003a: provenance is enforced at the write boundary, not requested

The single most important invariant is that **no entry can exist without a
verifiable citation**. `validateEntry` (entries.ts:64) throws `IndexDbError(1,
...)` if `source_url` or `source_excerpt` is missing or empty. The comments at
entries.ts:72 and cli.ts:1058 are explicit that this is a *write-time
guarantee* — the persona tells the agent "every entry MUST include the exact
source URL and a verbatim excerpt" (ingest-docs.ts:121), but the DB itself
rejects an entry lacking them, so a hallucinated or best-guess description
cannot persist even if the agent misbehaves. This is the difference between a
policy ("agents should cite") and an enforcement point ("the write fails
otherwise").

### Deterministic `entry_id` (FR-007 idempotency)

`entryIdFor` (entries.ts:56) derives the primary key from the entry's
coordinates:

```ts
const digest = createHash("sha1")
  .update([libraryName, libraryVersion, symbolKind, symbolName, signature ?? ""].join("|"))
  .digest("hex")
  .slice(0, 12);
return `doc-${digest}`;
```

Two consequences:
1. Re-ingesting identical docs is an idempotent no-op write rather than a
   duplicate — the same id resolves to the same row.
2. The hash input *must* match what is stored in the `signature` column, or the
   computed id and the row it resolves to could disagree. The write path
   enforces this by normalizing the signature once at entries.ts:94 — class
   entries are always normalized to `null` — and reusing that normalized value
   for both the hash and the `INSERT`.

### Version-change lifecycle: supersede, don't accumulate

When you write a new version of a symbol, stale-version documentation must not
remain queryable (the data-model's version-change lifecycle). This is handled
inside the same transaction that does the insert (entries.ts:97):

1. **Auto-detect prior versions** — a `SELECT DISTINCT library_version` finds
   any other version of the same (library, kind, symbol, signature) and deletes
   all its rows. This is why callers don't have to thread the old version
   through: the DB finds it.
2. **Explicit `supersedesVersion`** — if provided (tests pass it), rows at that
   specific version are also deleted, but *scoped to the same
   symbol/signature* so sibling symbols documented at the superseded version are
   untouched.

Then the `INSERT ... ON CONFLICT (...) DO UPDATE` upsert either inserts a new
row or patches an existing one's content. The whole thing is wrapped in
`db.transaction`, so a partial supersede-then-insert can't be observed
half-applied.

### The `signature`/`COALESCE` dance (FR-011)

Method overloads are disambiguated by signature; classes have no signature.
Because `signature` is `NULL` for class rows, every query that filters on it
uses `COALESCE(signature, '') = COALESCE(?, '')` so that a missing signature
matches class rows *and* signature-less method lookups, while a supplied
signature only matches rows with that exact signature. You'll see this exact
`COALESCE` pattern repeated in the write path (entries.ts:104,115,123), the
lookup query (queries.ts:85), and the verify query (entries.ts:322). It is the
linchpin of overload disambiguation, and every variant must use the identical
`COALESCE` shape or overloads/classes start matching each other.

## The ingestion orchestration: `runIngestDocs`

`migration/guildctl/commands/ingest-docs.ts:127` (`runIngestDocs`) is where a
whole ingestion run is driven. Its contract is
`specs/007-doc-rag-lookup/contracts/ingestion-cli-contract.md`. The flow:

1. **Scope to the locked 'keep' set (FR-005).** It pulls the locked dependency
   set via `getLockedDependencySet` from
   `migration/registry/commands/dispositions` and filters to
   `disposition === "keep"` with a non-empty `locked_target_version`
   (ingest-docs.ts:137). `replace-with-native` / `inline` libraries are *not*
   considered at all — you only document the libraries the migration will
   actually keep against. An optional `--library` restricts to one library
   (targeted re-ingest after a version bump).

2. **Start the run.** `startIngestionRun` (entries.ts:170) records an
   `ingestion_runs` row with `triggered_by` and the snapshot count of libraries
   in scope.

3. **Fail-closed harness preflight (Constitution Principle VI).** Before any
   agent is dispatched, `checkHarness` (ingest-docs.ts:91) runs
   `<harness> --version` with a 15s timeout. If the pinned ingestion harness is
   unreachable, it closes the run and throws — the point is to discover a dead
   harness *before* some libraries have been ingested and others haven't, not
   mid-loop (ingest-docs.ts:161).

4. **Per-library loop.** For each target library:
   - **Unchanged-skip (FR-007).** If not a targeted re-run and
     `countDocumentationEntries(indexDb, library, version) > 0`, the library is
     recorded as `unchanged` with zero entries written and **no agent is
     launched** (ingest-docs.ts:177) — saving the network/token cost of
     re-reading already-indexed docs.
   - **Dispatch the agent.** `spawnAgent` runs the `doc-ingestion-agent` persona
     (via the prompt built in `ingestionPrompt`, ingest-docs.ts:102) with the
     run id threaded through. The agent's only writes are `index-doc-entry` CLI
     calls (the prompt is explicit: "Do NOT write to legacy/ or modern/").
   - **Record the outcome.** After the agent returns, the command counts entries
     again and diffs against the pre-count to derive `entries_written`
     (ingest-docs.ts:197). Note the comment at ingest-docs.ts:198: the agent's
     writes happen in its *own* CLI process, so the orchestrator cannot count
     them in-process; a non-throwing agent run is the success signal, recorded
     as `indexed`.
   - **Failure is contained.** If the agent throws, the library is recorded as
     `failed` with the reason, and the loop continues to the next library
     (FR-012, ingest-docs.ts:203). One library's failure does not abort the run.

5. **Close the run.** `completeIngestionRun` (entries.ts:219) stamps
   `completed_at`, and a report with per-library outcomes is returned.

### Harness pinning is deliberate

`pinnedIngestionConfig` (ingest-docs.ts:61) forces the ingestion harness to
`config.ingestion?.harness || "opencode"`, *never* the workspace's primary
`harness` setting. The comment (ingest-docs.ts:56) explains why: the ingestion
loop must be harness-deterministic for v1. This means `resolveIngestionLaunch`
(injecting into `spawnAgent`) is what actually carries the pinned harness
through, because `spawnAgent` would otherwise re-resolve `config.harness`
itself. There is a real trap here: wiring a custom primary harness and assuming
ingestion follows it would silently use the wrong runner. The tests
(`ingest-docs-command.test.ts`) assert this pinning.

## The read side: the `guild-docs` MCP server

`migration/mcp-doc-server/server.ts` creates a stdio MCP server named
`guild-docs`, version `0.1.0`, exposing only three tools
(`createDocServer`, server.ts:99).

Path resolution (server.ts:32): `GUILD_INDEX_DB_PATH` env wins (set by the
harness wiring), else `resolveIndexDbPath()` against the workspace root.

The `CallToolRequestSchema` handler (server.ts:171) routes by tool name and
returns `{ content: [{ type: "text", text: JSON.stringify(payload) }] }`.
Error shaping is important and consistent: a malformed *query* is returned as an
`isError: true` result (a tool error), *never* thrown as a transport-level
exception and *never* reported as `not_found` (server.ts:188). This lets the
caller distinguish "I asked a bad question" from "the library isn't indexed"
from "this symbol isn't in the indexed set" — three very different situations.

### Tool 1: `lookup_library_doc` — exact, version-pinned lookup

`lookupLibraryDoc` (queries.ts:65). Inputs are validated by
`validateLookupInput` (queries.ts:46), which enforces FR-011: `signature` is
*required* when `symbol_kind === "method"` (queries.ts:52). The result can be
one of three statuses:

- `unavailable` — the library+version has **no** rows at all in the index
  (queries.ts:74). Not in the locked set's indexed docs.
- `found` — a row matched, with `chunk: { index: 0, of: 1 }` (the chunking
  contract stubbed to a single chunk for now).
- `not_found` — the library is indexed, but this specific symbol isn't.

The SQL pins `library_name`, `library_version`, `symbol_kind`, `symbol_name`,
and `COALESCE(signature, '') = COALESCE(?, '')` (queries.ts:81). FR-002 is the
invariant here: **exact lookup never crosses versions**. You cannot accidentally
get the docs for a different version.

### Tool 2: `lookup_library_doc_search` — ranked full-text search

`searchLibraryDocs` (queries.ts:108). Same version-pinning discipline, but over
the FTS5 index. Two notable mechanics:

- **OR'd quoted terms.** The query is split on whitespace and each term is
  quoted and joined with ` OR ` (queries.ts:129). This is a deliberate
  deviation from FTS5's implicit-AND default, documented at queries.ts:125:
  a multi-word description like "argument null check" should match entries
  containing *any* of those tokens (ranked by bm25), not require all of them.
  Terms are stripped of `"` to avoid breaking out of the quoted string.
- **Snippet + rank.** The SELECT uses `snippet(documentation_entries_fts, 1, '',
  '', '…', 12)` for a 12-token excerpt around the match in column 1
  (`description`), and `bm25(documentation_entries_fts)` for relevance. The FTS
  table is JOINed back to `documentation_entries e` on rowid, and the search is
  further scoped with `e.library_name = ? AND e.library_version = ?`.

The bm25 score is negative (more-negative = better), so the result is normalized
with `Math.abs(r.rank)` (queries.ts:156) to a positive rank for the contract.
`limit` is clamped to `[1, 50]`, defaulting to 10 (queries.ts:113). Note the
subtle status distinction here: search returns `empty` for both "no rows for
this scope" *and* "no matches", which the contract deliberately distinguishes
from lookup's `not_found` and from a genuine `unavailable` (queries.ts:118).

### Tool 3: `verify_library_docs` — batch reference verification

`verifyLibraryDocsHandler` (server.ts:88) validates the batch at the tool
boundary, then delegates to `verifyReferences` in `migration/index-db/commands/
entries.ts:278`. This is the US2 feature: given many API references, return one
outcome per reference, order-preserved, in a single call. The three outcomes
are (entries.ts:264):

- `verified-present` — a row exists for library+version+symbol (+signature).
- `verified-absent` — the library+version IS indexed but this symbol isn't.
- `unavailable` — no rows at all for that library+version.

Per-reference logic (entries.ts:292): a reference missing a required field
yields `unavailable` rather than aborting the whole batch — the tool boundary
already enforced shape, so this read-side compute "must never throw on a bad
per-item field" (entries.ts:302). The scoping query (entries.ts:311) first
checks whether the library+version has any rows (deciding `unavailable` vs
`verified-absent`/`verified-present`), then the exact-match query with the same
`COALESCE(signature,'') = COALESCE(?, '')` shape.

**Token-budget bounding and pagination.** `MAX_VERIFY_REFERENCES = 50`
(entries.ts:241) is a hard cap derived from the FR-015 token budget — the
comment walks the arithmetic: ~80 tokens per echoed reference+outcome, × 50 ≈
4k tokens, within the single-response budget shared with lookup/search. A batch
larger than 50 is *truncated*, not dropped: the result carries `truncated: true`
and a `next_cursor`, and the caller passes that cursor back to continue from
where it left off (entries.ts:331). A malformed `cursor` (non-integer or
negative) throws `DocLookupValidationError` (entries.ts:286). The
`index-db-verify.test.ts` and `doc-rag-hallucination-benchmark.test.ts` suites
cover this shape.

## Harness wiring: who gets the MCP server

The MCP server is not registered for every persona. In
`package/harness/opencode.mjs`:

```js
export const DOC_MCP_AGENTS = new Set(["code-writer-agent", "test-writer-agent", "review-agent"]);
```

`docMcpServerBlock` (opencode.mjs:51) points the server script at
`migration/mcp-doc-server/server.ts` (run via `node --import tsx`) and injects
`GUILD_INDEX_DB_PATH`. It is added to the temporary opencode config's `mcp`
block *only* when the launching agent is in `DOC_MCP_AGENTS`
(opencode.mjs:86). The comment at opencode.mjs:45 explains why: the ingestion
agent writes to index.db directly and does not need the read server. So the 
read surface is exposed to the Migrate/Critic-launching personas
(code-writer, test-writer, review) and withheld from the one that populates the
store. The same pattern repeats in the codex and goose harness adapters
(`package/harness/codex.mjs`, `package/harness/goose.mjs`), each configuring
the MCP server in that runner's config format.

## Invariants and edge cases worth remembering

- **FR-002 (lookup)**: exact lookup *never* crosses versions. Every read query
  pins `library_name` + `library_version`. This is enforced in SQL, not just
  documented.
- **FR-003a (provenance)**: no entry without a non-empty `source_url` AND
  non-empty `source_excerpt`. Enforced at the write boundary, so a bad agent
  cannot persist an uncited entry.
- **FR-007 (idempotency)**: deterministic `entry_id` + `UNIQUE` constraint +
  the unchanged-skip in `runIngestDocs` make re-ingest a no-op when nothing
  changed.
- **FR-011 (overloads)**: `signature` is required for method lookups and used
  with `COALESCE` everywhere; classes always normalize to `NULL` signature.
- **Read-only read path**: the MCP server opens the DB with
  `{ readonly: true, fileMustExist: true }` — it cannot mutate the store even
  in principle.
- **Failure containment**: one library's ingestion failure is recorded and the
  loop continues (FR-012); a bad harness is caught *before* any dispatch
  (fail-closed).
- **Error/status disambiguation**: `unavailable` (no rows for this scope) vs
  `not_found` (scope indexed, symbol missing) vs `empty` (search) vs an
  `isError` tool error (malformed input) are all distinct and intentional.

## Gotchas

- **Two schema copies.** `schema.ts` and `index_db_schema.sql` must stay in
  sync; the schema test guards it. Add a column to both, and mirror the 
  registry's guarded-ALTER approach from the journal if you need in-place
  upgrade of an existing workspace.
- **FTS staleness on UPDATE.** Without the AFTER UPDATE trigger, the upsert
  path (which is a real UPDATE) would silently desync the FTS index. If you
  touch the triggers, don't drop `documentation_entries_au`.
- **The `COALESCE` shape.** Every signature filter must use the identical
  `COALESCE(signature, '') = COALESCE(?, '')` pattern; a variant that treats
  `NULL` differently will start cross-matching classes and methods.
- **`signature` normalization and `entry_id`.** The hash input must match the
  stored `signature` (class → `null`), or the derived id and the row it names
  can disagree.
- **Harness pinning.** Ingestion uses `ingestion.harness` (default opencode),
  *not* the primary `harness`. Wiring a custom primary harness won't change
  ingestion's runner.
- **The agent counts via its own process.** `entries_written` for an agent run
  is a *diff* of row counts around the dispatch, not an in-process count; a
  non-throwing run is the success signal.
- **The MCP server runs from build/source via tsx** and needs `GUILD_INDEX_DB_PATH`
  (or a valid `.guild/index.db`) or it fails fast on `fileMustExist`.

## Extension points

- **Versioned search** — the codebase already encodes "never cross versions";
  a future "search across all versions of a library" would be a *new* tool, not
  a relaxation of the existing ones.
- **`database.index_path` override** — the resolver at `config.ts:267` is
  explicitly structured to accept one "the same way `database.path` overrides
  the registry, without a contract change".
- **Chunking** — lookup returns `chunk: { index: 0, of: 1 }` and accepts a
  `chunk_index` input, so oversized entries are anticipated but not yet
  implemented; a future chunked-description scheme slots in behind that shape.
- **More personas on the read surface** — the `DOC_MCP_AGENTS` set in each
  harness adapter is the single place that decides who can see the tools.
- **New ingestion sources** — `runIngestDocs` already isolates the agent prompt
  and the per-library outcome recording; adding another ingestion source means
  adding another `IngestionOutcome` value and its `CHECK`/validation, not
  rewriting the loop.

## What the tests confirm

The `migration/test/` suite has direct coverage of this subsystem:

- `index-db-schema.test.ts` — schema application and the FTS triggers.
- `index-db-verify.test.ts` — the batch verify three-outcome semantics and
  truncation cursor.
- `index-db-ingestion-runs.test.ts` — run/bookkeeping recording.
- `index-db-provenance-audit.test.ts` — the FR-003a write-time enforcement.
- `index-doc-entries.test.ts` — the `index-doc-entry` write path incl.
  version supersede.
- `ingest-docs-command.test.ts` — orchestration, harness pinning, unchanged-skip,
  failure containment.
- `ingest-docs-agent-persona.test.ts` — the agent-facing prompt contract.
- `mcp-doc-server.test.ts` / `doc-lookup.test.ts` / `doc-lookup-search.test.ts` —
  the read tools' status semantics.
- `doc-rag-hallucination-benchmark.test.ts` — the anti-hallucination motivation.
- `doc-consistency.test.ts` — the `schema.ts` vs `index_db_schema.sql` parity
  guard.

All of these pass with the current `node --import tsx --test` runner in
`migration/`.