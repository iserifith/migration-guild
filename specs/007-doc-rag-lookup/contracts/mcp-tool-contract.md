# Contract: MCP Tool Surface (`lookup_library_doc`, `verify_library_docs`)

**Feature**: `007-doc-rag-lookup` | **Date**: 2026-08-16

Per FR-009 (as narrowed during `/speckit-clarify`): a new internal MCP server,
scoped to index-query tools only — no browsing/fetch tools live here (that's
the ingestion agent's harness-native tools instead, research.md §4-5).

## Server

New package `migration/mcp-doc-server/` (sibling to `migration/registry/` and
`migration/guildctl/`), a small Node process speaking MCP over stdio (the
official `@modelcontextprotocol/sdk` TypeScript server helpers — same
ecosystem the harnesses themselves already speak as MCP *clients*, research.md
of the earlier `/speckit-specify` session). It opens `.guild/index.db`
read-only (`new Database(path, { readonly: true })`) — this server only
answers queries; ingestion writes happen through the ingestion agent's own
process, never through this server.

## Harness wiring

Each harness that resolves to a Migrate- or Critic-capable persona
(`code-writer-agent`, `test-writer-agent`, `review-agent`) gets this server
registered per FR-009's confirmed-feasible mechanisms:

- **opencode**: `writeProviderConfig` in `opencode.mjs` gains an `mcp` block:
  `{ "guild-docs": { type: "local", command: ["node", "<path-to-mcp-doc-server>"], environment: { GUILD_INDEX_DB_PATH: "<resolved path>" } } }`.
- **codex**: `buildCodexInvocation` in `codex.mjs` gains additional `-c`
  overrides: `-c mcp_servers.guild-docs.command=...`, `-c mcp_servers.guild-docs.args=...`
  — the same override style already used for `model_providers.migration_guild.*`.
- **goose**: a `config.yaml` `extensions.guild-docs` block
  (`{ cmd: "node", args: [...], type: "stdio" }`), written by `goose.mjs`
  the same way `opencode.mjs` writes a temp `opencode.json` today.

Only Migrate/Critic-launching invocations register this server — the
ingestion agent (research.md §5, pinned to opencode) does not need it, since
it writes to `.guild/index.db` directly rather than through the MCP surface.

## Tool: `lookup_library_doc`

**Input**:
```json
{
  "library_name": "com.google.guava:guava",
  "library_version": "33.2.1-jre",
  "symbol_kind": "method",
  "symbol_name": "Preconditions#checkNotNull",
  "signature": "(java.lang.Object)"
}
```
`signature` is required when `symbol_kind` is `"method"` (FR-011); omitted for
`"class"` lookups.

**Output** — exactly one of:
```json
{ "status": "found", "entry": { "description": "...", "return_type": "...", "source_url": "...", "chunk": { "index": 0, "of": 1 } } }
{ "status": "not_found" }
{ "status": "unavailable", "reason": "library not in locked keep set" }
```
`entry.chunk` is present whenever the full entry exceeds the FR-015 token
budget threshold; callers pass `{ "chunk_index": N }` on a repeat call to
retrieve subsequent chunks of the same entry.

## Tool: `lookup_library_doc_search` (FR-002a)

**Input**: `{ "library_name": "...", "library_version": "...", "query": "connection pooling", "limit": 10 }`.

**Output**:
```json
{ "status": "ok", "candidates": [ { "symbol_name": "...", "signature": "...", "snippet": "...", "rank": 0.83 } ] }
```
or `{ "status": "empty" }` — distinct from `lookup_library_doc`'s `not_found`
per the spec's Edge Cases entry (an empty search result means "no match," not
"library isn't indexed").

## Tool: `verify_library_docs` (FR-010a, batch)

**Input**:
```json
{
  "references": [
    { "library_name": "com.google.guava:guava", "library_version": "33.2.1-jre", "symbol_name": "Preconditions#checkNotNull", "signature": "(java.lang.Object)" }
  ]
}
```
Bounded to a maximum reference count derived from the FR-015 token budget; an
over-limit request returns `truncated: true` with a `next_cursor` rather than
silently dropping references (data-model.md's Batch Verification entity).

**Output**:
```json
{
  "results": [
    { "reference": { "...": "..." }, "outcome": "verified-present" }
  ],
  "truncated": false
}
```
`outcome` is one of `verified-present` | `verified-absent` | `unavailable`, one
per input reference, order-preserved (FR-010, FR-010a).

## Error handling

Malformed input (missing required field, unknown `symbol_kind`) returns an MCP
tool error, not a `"not_found"` — callers must be able to distinguish "your
query was invalid" from "your query was valid and found nothing," so a Critic
finding is never raised from a malformed call it made itself.
