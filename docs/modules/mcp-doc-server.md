# The MCP Doc Server (`guild-docs`) — Server Mechanics Deep-Dive

> **Scope note.** The companion doc
> [`docs/modules/doc-rag-lookup.md`](./doc-rag-lookup.md) covers the *retrieval
> behavior* of the whole 007-doc-rag-lookup subsystem: why the index exists,
> how ingestion quality is enforced, and what the tools mean for agents. This
> document deliberately does **not** repeat that material. Here we map the
> *server itself*: the process under `migration/mcp-doc-server/`, its tool
> surface as registered over MCP, its transport and lifecycle, the exact code
> path a request travels, and the harness wiring that decides which agents get
> the server at all.

## Overview

`guild-docs` is a stdio [Model Context Protocol](https://modelcontextprotocol.io)
server that answers documentation queries against `.guild/index.db`. It is
small by design — two source files:

- `migration/mcp-doc-server/server.ts` — process entry point, DB opening,
  tool registration, error mapping.
- `migration/mcp-doc-server/queries.ts` — the two query implementations
  (exact lookup, FTS search).

The server is **read-only end to end**. It opens the SQLite file with
`{ readonly: true, fileMustExist: true }`
(`migration/mcp-doc-server/server.ts:openReadOnlyIndexDb`) and never issues a
write; all ingestion writes happen in the *ingestion agent's own process*
through the `index-doc-entry` registry CLI command
(`migration/registry/cli.ts`, `index-doc-entry` command). This split is stated
in the module header comment (`migration/mcp-doc-server/server.ts:1-11`) and is
the single most important invariant of the component.

The server identifies itself as `guild-docs` version `0.1.0`
(`migration/mcp-doc-server/server.ts:MCP_SERVER_NAME`, `MCP_SERVER_VERSION`)
and declares only the `tools` capability
(`migration/mcp-doc-server/server.ts:createDocServer`).

## Architecture

```
 agent process (opencode / codex / goose)
   │  spawns with env GUILD_INDEX_DB_PATH=…/.guild/index.db
   ▼
 node --import tsx migration/mcp-doc-server/server.ts
   │  StdioServerTransport (JSON-RPC over stdin/stdout)
   ▼
 createDocServer(db) ── CallToolRequestSchema handler
   ├─ lookup_library_doc        → queries.lookupLibraryDoc
   ├─ lookup_library_doc_search → queries.searchLibraryDocs
   └─ verify_library_docs       → verifyLibraryDocsHandler → index-db verifyReferences
   ▼
 better-sqlite3, opened READ-ONLY on .guild/index.db
```

Key structural choices:

- **No HTTP, no daemon.** The server lives exactly as long as the agent
  process that spawned it; lifecycle is owned by the harness adapter
  (see [Harness wiring](#harness-wiring-how-agents-connect) below).
- **Dependency injection for tests.** `createDocServer(db)` takes any object
  satisfying `DocQueryDb = Pick<Database.Database, "prepare">`
  (`migration/mcp-doc-server/server.ts:49`). Tests pass an in-memory database;
  production wires the real read-only handle in `main()`
  (`migration/mcp-doc-server/server.ts:main`). The test suite exercises this
  seam directly (`migration/test/mcp-doc-server.test.ts`).
- **Queries import the validation error from the server**, not vice versa:
  `queries.ts` imports `DocLookupValidationError` from `./server`
  (`migration/mcp-doc-server/queries.ts:8`), while the server imports the query
  functions. The circular-import risk is broken because `DocQueryDb` is a type
  alias re-exported back to `queries.ts`
  (`migration/mcp-doc-server/server.ts:48-49`).

## Tool / API surface

Exactly three tools are registered in
`migration/mcp-doc-server/server.ts:createDocServer` (the ListTools handler).
A test pins this count: *"server registers exactly the three tools"*
(`migration/test/mcp-doc-server.test.ts:58`).

### 1. `lookup_library_doc`

Input schema requires `library_name`, `library_version`, `symbol_kind`
(enum `class | method`), `symbol_name`; optional `signature` (required at
validation time when `symbol_kind === "method"`, FR-011) and `chunk_index`
(`migration/mcp-doc-server/server.ts:108-124`).

Implementation: `migration/mcp-doc-server/queries.ts:lookupLibraryDoc`.
Three mutually exclusive result statuses:

- `"unavailable"` — a scope probe `SELECT COUNT(*) … WHERE library_name = ?
  AND library_version = ?` returns zero
  (`migration/mcp-doc-server/queries.ts:71-79`): the library+version has no
  rows at all, i.e. it was never ingested.
- `"not_found"` — the scope is indexed but no row matches symbol kind/name and
  `COALESCE(signature,'') = COALESCE(?, '')`
  (`migration/mcp-doc-server/queries.ts:81-94`).
- `"found"` — returns a trimmed projection (`symbol_name`, `signature`,
  `description`, `return_type`, `source_url`, and a constant
  `chunk: { index: 0, of: 1 }`)
  (`migration/mcp-doc-server/queries.ts:95-105`). Note the chunk fields are
  currently hardcoded — there is no real chunking yet; `chunk_index` is
  accepted in the schema but not used by the query.

### 2. `lookup_library_doc_search`

Input: `library_name`, `library_version`, `query` required; optional `limit`
(`migration/mcp-doc-server/server.ts:126-140`).

Implementation: `migration/mcp-doc-server/queries.ts:searchLibraryDocs`.

- Unlike lookup, an unindexed scope returns `{ status: "empty" }`, **not**
  `"unavailable"` — a deliberate asymmetry documented inline
  (`migration/mcp-doc-server/queries.ts:118-123`).
- The free-text query is tokenized on whitespace and rebuilt as OR'd quoted
  terms (`migration/mcp-doc-server/queries.ts:129-134`), so multi-word
  descriptions match on *any* token instead of FTS5's implicit AND. Embedded
  double quotes are stripped to keep the MATCH expression well-formed.
- The SQL joins `documentation_entries_fts` against the content table on
  `rowid`, uses `snippet(..., 12)` for highlighted excerpts and `bm25(...)` for
  ordering, and re-applies the library+version filter on the content table so
  results can never cross versions
  (`migration/mcp-doc-server/queries.ts:136-145`).
- `limit` defaults to 10 and is clamped to at most 50
  (`migration/mcp-doc-server/queries.ts:113`).
- bm25 scores are more-negative-is-better, so the returned `rank` is
  `Math.abs(rank)` (`migration/mcp-doc-server/queries.ts:150-158`).

The FTS table itself is an external-content FTS5 virtual table kept in sync by
standard INSERT/DELETE/UPDATE triggers defined in
`migration/index-db/schema.ts:31-56`; the server only reads it.

### 3. `verify_library_docs`

Batch verification (US2). Input: non-empty `references` array plus optional
integer `cursor` (`migration/mcp-doc-server/server.ts:verifyLibraryDocsHandler`).
Each reference must carry `library_name`, `library_version`, `symbol_name`;
`signature` is optional (`migration/mcp-doc-server/server.ts:validateReference`).

The handler validates shape at the tool boundary and delegates to
`verifyReferences` in `migration/index-db/commands/entries.ts:278`. Per
reference the outcome is one of:

- `verified-present` — a row exists for library+version+symbol (+signature)
- `verified-absent` — the scope is indexed but this symbol isn't
- `unavailable` — no rows at all for the scope

Batches are capped at `MAX_VERIFY_REFERENCES = 50`
(`migration/index-db/commands/entries.ts:241`); an over-limit batch is
**truncated, never dropped**: the response carries `truncated: true` and
`next_cursor` (the index of the first unreturned reference), which the caller
passes back as `cursor` to continue
(`migration/index-db/commands/entries.ts:291-336`). `next_cursor` is omitted
from the JSON unless truncation occurred
(`migration/mcp-doc-server/server.ts:82-88`).

Notably, a malformed *individual* reference inside an otherwise valid batch
does **not** throw — it degrades to `unavailable`
(`migration/index-db/commands/entries.ts:313-319`), because the tool boundary
already validated the array's shape and the read-side compute must never abort
a whole batch.

All three tools return their payload as a single JSON text content block
(`migration/mcp-doc-server/server.ts:185`).

## Request lifecycle walkthrough

A concrete `lookup_library_doc` call, end to end:

1. **Spawn.** The harness adapter launched
   `node --import tsx migration/mcp-doc-server/server.ts` with
   `GUILD_INDEX_DB_PATH` in its environment (see wiring section below).
2. **Startup.** `main()` resolves the DB path via
   `resolveServerIndexDbPath` — `GUILD_INDEX_DB_PATH` trimmed, else
   `resolveIndexDbPath()` which yields `<workspaceRoot>/.guild/index.db`
   (`migration/mcp-doc-server/server.ts:32-34`;
   `migration/guildctl/config.ts:resolveIndexDbPath`). It opens the file
   read-only with `fileMustExist: true` — a missing index.db kills the server
   at startup rather than producing runtime errors.
3. **Connect.** A `StdioServerTransport` is attached
   (`migration/mcp-doc-server/server.ts:main`); from here the SDK drives
   JSON-RPC over stdin/stdout.
4. **Discovery.** The client sends `tools/list`; the ListTools handler returns
   the three static tool descriptors with their JSON Schemas
   (`migration/mcp-doc-server/server.ts:105-169`).
5. **Invocation.** `tools/call` arrives; the CallToolRequestSchema handler
   destructures `name`/`arguments`, coerces missing arguments to `{}` and
   dispatches on the tool name
   (`migration/mcp-doc-server/server.ts:171-184`). Unknown names raise
   `McpError(MethodNotFound)`.
6. **Validation.** `queries.validateLookupInput` runs `requireString` on each
   required field (empty/whitespace strings rejected) and enforces the
   method-signature rule
   (`migration/mcp-doc-server/queries.ts:38-63`). Failures throw
   `DocLookupValidationError`.
7. **Query + response.** The scoped-count probe and the exact-match SELECT run
   synchronously (better-sqlite3 is synchronous), and the status object is
   JSON-stringified into the response.
8. **Error mapping.** If step 6 threw, the catch block converts
   `DocLookupValidationError` into `{ isError: true, content: [{ type: "text",
   text: {"ok":false,"error":…} }] }` — an *isError tool result*, not a thrown
   protocol error, so clients see `res.isError` rather than a transport
   exception (`migration/mcp-doc-server/server.ts:186-198`). The comment is
   explicit about why: malformed input must be distinguishable from a valid
   query that found nothing. `McpError`s are rethrown untouched; anything else
   propagates.

## Indexing / data flow from ingest

The server consumes `.guild/index.db` but shares nothing with the writer at
runtime — the coupling is purely via the SQLite file and the
`GUILD_INDEX_DB_PATH` convention. The flow:

1. **Target selection.** `runIngestDocs`
   (`migration/guildctl/commands/ingest-docs.ts:127`) filters the locked
   dependency set to `disposition === "keep"` rows with a locked target
   version, optionally narrowed by `--library`.
2. **Idempotency skip.** Full runs skip libraries already indexed at the
   locked version (`countDocumentationEntries > 0`), recording outcome
   `"unchanged"` without launching an agent
   (`migration/guildctl/commands/ingest-docs.ts:177-181`).
3. **Agent dispatch.** For each remaining library, the `doc-ingestion-agent`
   persona is spawned through the *pinned* ingestion harness
   (`ingestion.harness`, default `opencode` — never the workspace's primary
   `config.harness`; `pinnedIngestionConfig`,
   `migration/guildctl/commands/ingest-docs.ts:61-63`). A fail-closed preflight
   probes the harness binary once before any dispatch
   (`checkHarness`, lines 91-100, applied at 157-169).
4. **Writes.** The prompt (`ingestionPrompt`, lines 102-125) instructs the
   agent to record each entry via
   `node migration/registry/dist/cli.js index-doc-entry …`, always with
   `--source-url` and `--source-excerpt` and the run id. The write path
   rejects entries missing either field (FR-003a) inside
   `upsertDocumentationEntry` (`migration/index-db/commands/entries.ts:75-78`),
   upserting on the natural key and deleting superseded-version rows in the
   same transaction (see the `--supersedes-version` option,
   `migration/registry/cli.ts:1062-1090`).
5. **Visibility.** Because each CLI invocation opens its own connection and
   commits synchronously, every committed row (and its FTS-trigger-maintained
   index row) is immediately visible to any subsequently started MCP server.
   There is no cache invalidation problem: the server holds no in-memory state
   beyond the SQLite connection.

For the quality/provenance rules governing steps 3–4, see
`docs/modules/doc-rag-lookup.md`.

## Harness wiring: how agents connect

The server is registered per-agent by the harness adapters, only for personas
that migrate or review code. All three adapters share the same allowlist:

```js
// package/harness/opencode.mjs:49
export const DOC_MCP_AGENTS = new Set(["code-writer-agent", "test-writer-agent", "review-agent"]);
```

(The goose adapter keeps a private copy of the same set,
`package/harness/goose.mjs:267`.) The doc-ingestion agent is deliberately
excluded — it writes the index directly and needs no reader
(`package/harness/opencode.mjs:45-48`).

- **OpenCode** (`package/harness/opencode.mjs:docMcpServerBlock`, wired in
  `writeProviderConfig`): emits an `mcp["guild-docs"]` block of type `local`
  with `command: ["node", "--import", "tsx", <repo>/migration/mcp-doc-server/server.ts]`
  and `environment.GUILD_INDEX_DB_PATH` defaulting to `<cwd>/.guild/index.db`.
- **Codex** (`package/harness/codex.mjs:41-53`): passes `-c
  mcp_servers.guild-docs.command=…`, `mcp_servers.guild-docs.args=…` (a
  TOML-encoded JSON array `["--import","tsx",<script>]`), and
  `mcp_servers.guild-docs.env.GUILD_INDEX_DB_PATH=…` on the command line.
- **Goose** (`package/harness/goose.mjs:writeDocMcpGooseConfig`, wired in
  `buildGooseInvocation`): writes a temp `config.yaml` with an
  `extensions.guild-docs` stdio block (same node/tsx/script argv, same env,
  `timeout: 60`) and points `GOOSE_CONFIG` at it.

In all three cases the explicit `GUILD_INDEX_DB_PATH` environment variable wins
over the derived default, mirroring `resolveServerIndexDbPath`'s precedence
(tested in `migration/test/ingest-docs-agent-persona.test.ts:63-96` and
`migration/test/mcp-doc-server.test.ts:95`). The tests also pin that
non-Migrate/Critic personas (e.g. `analyze-agent`) receive **no** guild-docs
registration at all.

Note the adapters launch the TypeScript source directly via
`node --import tsx` — there is no separate build artifact for the server, so
`tsx` must be resolvable from the workspace.

## Invariants & edge cases

- **Read-only or nothing.** `fileMustExist: true` means the server refuses to
  start against a nonexistent index rather than silently creating one
  (`migration/mcp-doc-server/server.ts:37`).
- **Never cross versions.** Every query — exact lookup, search, and each
  verify reference — filters on `(library_name, library_version)`
  (`migration/mcp-doc-server/queries.ts:5-6`).
- **Three-state vocabulary is asymmetric on purpose.** Lookup distinguishes
  `not_found` vs `unavailable`; search collapses both into `empty`
  (`migration/mcp-doc-server/queries.ts:68-79` vs `118-123`).
- **Malformed input ≠ empty result.** Validation errors surface as
  `isError` tool results, never as a `not_found`/`empty` payload
  (`migration/mcp-doc-server/server.ts:188-197`).
- **Signature matching is COALESCE-normalized.** Both lookup and verify match
  `COALESCE(signature,'') = COALESCE(?, '')`, so NULL and empty-string
  signatures are equivalent; an omitted signature matches class rows and
  signature-less methods (`migration/mcp-doc-server/queries.ts:85-91`,
  `migration/index-db/commands/entries.ts:303-310`).
- **Bounded responses.** Search limit ≤ 50; verify batches ≤ 50 references
  with cursor continuation (`migration/mcp-doc-server/queries.ts:113`,
  `migration/index-db/commands/entries.ts:241`).
- **Entry-point guard.** `main()` only runs when executed directly
  (`import.meta.url === file://${process.argv[1]}`), so importing the module
  in tests never starts a server
  (`migration/mcp-doc-server/server.ts:212-217`).

## Gotchas

- **`chunk_index` is accepted but ignored.** The schema advertises it and the
  found-payload hardcodes `chunk: { index: 0, of: 1 }`
  (`migration/mcp-doc-server/queries.ts:103`). Chunking is future work; don't
  rely on it.
- **Search's `unavailable` doesn't exist.** If you query an unindexed library
  via search you get `empty`, indistinguishable from "indexed but no match".
  Use `lookup_library_doc` when you need the unavailable signal.
- **Rank normalization is lossy.** `Math.abs(bm25)` flips sign but the values
  are only meaningful for relative ordering within one response.
- **Per-item failures hide inside verify batches.** A reference with blank
  fields comes back as `unavailable`, not an error — check the reference echo
  in each result item if you suspect malformed input.
- **The server trusts the file it's pointed at.** Whatever `GUILD_INDEX_DB_PATH`
  says is opened read-only; pointing it at a stale or foreign index.db yields
  confidently wrong `unavailable`/`not_found` answers with no warning.
- **Goose timeout is 60s** (`package/harness/goose.mjs:289`); long-running
  tool calls would need that raised in the generated config.

## Extension points

- **New read-only tool:** add the descriptor to the ListTools array and a
  branch in the CallToolRequestSchema dispatcher
  (`migration/mcp-doc-server/server.ts:171-200`); implement the query in
  `queries.ts` following the validate-then-status-object pattern. Anything
  that writes belongs in the ingestion path, not here.
- **Real chunking:** replace the hardcoded chunk projection in
  `lookupLibraryDoc` and honor `chunk_index` — the schema surface already
  exists.
- **New harness adapter:** replicate the pattern — gate on the
  Migrate/Critic persona set, spawn
  `node --import tsx migration/mcp-doc-server/server.ts`, inject
  `GUILD_INDEX_DB_PATH`, and add a test alongside
  `migration/test/ingest-docs-agent-persona.test.ts`.
- **Path override:** `resolveIndexDbPath`
  (`migration/guildctl/config.ts:273`) anticipates a future
  `database.index_path` config key without a contract change.
