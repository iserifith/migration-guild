# Contract: Ingestion CLI + Agent Invocation

**Feature**: `007-doc-rag-lookup` | **Date**: 2026-08-16

## Registry CLI addition

Follows the exact conventions of `locked-dependency-set` /
`confirm-disposition` (`migration/registry/cli.ts`): JSON output via the
shared `run(...)` wrapper, `RegistryError`/`IndexDbError` for validation
failures.

```text
ingest-docs
  Description: Populate .guild/index.db with documentation for the confirmed
               locked ("keep") dependency set (spec 006), via the doc-ingestion
               agent. Prints a per-library outcome report on completion.
  Required:
    --triggered-by <actor>   Operator or authorized automation actor identity.
  Optional:
    --library <name>         Restrict this run to one library (re-ingest after
                              a single version change, rather than the full set).
  Output: { run_id, locked_set_snapshot_count, libraries: [{ library_name,
            library_version, outcome, reason?, entries_written }] }
  Notes: no-op (locked_set_snapshot_count: 0, libraries: []) when
  getLockedDependencySet(db) returns zero 'keep' rows — Edge Cases: "ingestion
  runs before spec 006's locked set exists."
```

## Ingestion agent invocation

`ingest-docs` (implemented in a new
`migration/guildctl/commands/ingest-docs.ts`, mirroring the shape of
`migration/guildctl/commands/migrate.ts`'s per-artifact agent dispatch) does,
per library in the filtered locked set:

1. Write an `ingestion_runs` row (`run_id`, `started_at`, `triggered_by`,
   `locked_set_snapshot_count`).
2. For each `keep`-disposition library, launch the `doc-ingestion-agent`
   persona through the harness — **always resolved via `ingestion.harness`
   (default `"opencode"`), not the workspace's primary `harness` setting**
   (research.md §5) — with a prompt naming the exact library coordinate and
   locked version, and instructing it to:
   - find authoritative documentation for that exact library/version,
   - extract class/method-level entries with descriptions and signatures,
   - record the source URL and a verbatim excerpt for each entry (FR-003a —
     the agent's prompt states this is a hard requirement, and the write path
     enforces it regardless per `index-db-schema.md`'s write-path invariant),
   - call the new `upsertDocumentationEntry` write path (exposed to the agent
     as a CLI subcommand it can shell out to, e.g.
     `registry index-doc-entry --library ... --source-url ... --excerpt ...`,
     the same "agent shells out to a registry CLI command to record structured
     results" pattern `code-writer-agent`/`review-agent` already use for their
     own registry writes — not a new agent-facing mechanism).
3. Record one `ingestion_run_libraries` row per library
   (`indexed`/`skipped`/`unchanged`/`failed` + `reason` + `entries_written`) —
   FR-012: one library's agent failure/timeout does not abort the loop for
   the rest.
4. Set `ingestion_runs.completed_at` and print the summary report (FR-004).

## Agent persona

New `package/agents/doc-ingestion-agent.agent.md`, following the frontmatter
and constraints shape of `reference-agent.agent.md` /
`code-writer-agent.agent.md`:

```markdown
---
name: doc-ingestion-agent
description: "Finds and records version-pinned API documentation for a single
  locked third-party library. Use only via `guildctl registry ingest-docs`,
  never invoked directly on a codegen/review turn."
---

You are a documentation researcher. Your job is to find real, authoritative
API documentation for exactly the library and version you are given, and
record it with a verifiable source for every entry.

## Constraints

- DO NOT write to `legacy/` or `modern/` — this agent only writes
  documentation-index rows via the registry CLI.
- Every entry you record MUST include the exact source URL and a verbatim
  excerpt you copied it from. An entry without both is rejected by the write
  path — do not attempt to work around this by inventing a plausible-looking
  citation.
- If you cannot find a citable source for a class/method, skip it rather than
  writing a best-guess description.
```

## Idempotency (FR-007)

Before dispatching the agent for a library, `ingest-docs` checks whether
`documentation_entries` already has rows for `(library_name, locked_target_version)`
from a prior run; if so and the operator did not pass `--library` to force a
targeted re-run, that library is recorded as `outcome: 'unchanged'` and the
agent is not launched for it — avoiding an unnecessary agent turn (and its
network/token cost) for already-current documentation.
