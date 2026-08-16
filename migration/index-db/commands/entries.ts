import { createHash, randomUUID } from "crypto";
import type Database from "better-sqlite3";
import type { DocumentationEntry, IngestionOutcome, IngestionRun, IngestionRunLibrary, SymbolKind } from "../types";

/**
 * Read-side query-handle validation error, mirroring the MCP server's
 * `DocLookupValidationError`. Defined here (rather than imported from the
 * server) to keep entries.ts free of a circular import: the server's
 * queries.ts already imports types from entries.ts, and the server in turn
 * imports queries.ts. Callers map this to a tool error at the boundary.
 */
export class DocLookupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocLookupValidationError";
  }
}

/**
 * Migration Guild `.guild/index.db` write-path errors (007-doc-rag-lookup).
 * Mirrors registry/types.ts's RegistryError: validation failures are thrown,
 * never silently coerced, because FR-003a is a write-time guarantee.
 */
export class IndexDbError extends Error {
  constructor(
    public readonly code: 1 | 2 | 3 | 4 | 5,
    message: string,
  ) {
    super(message);
    this.name = "IndexDbError";
  }
}

const SYMBOL_KINDS = new Set<SymbolKind>(["class", "method"]);

export interface UpsertDocumentationEntryOptions {
  libraryName: string;
  libraryVersion: string;
  symbolKind: SymbolKind;
  symbolName: string;
  signature?: string | null;
  description: string;
  returnType?: string | null;
  sourceUrl: string;
  sourceExcerpt: string;
  ingestionRunId?: string;
  /** Prior version being superseded; its rows are deleted in this transaction. */
  supersedesVersion?: string | null;
}

/**
 * Deterministic entry id (FR-007): identical (library, version, kind, symbol,
 * signature) always derives the same id, so re-ingesting unchanged docs is an
 * idempotent no-op write rather than a duplicate.
 */
export function entryIdFor(libraryName: string, libraryVersion: string, symbolKind: SymbolKind, symbolName: string, signature: string | null): string {
  const digest = createHash("sha1")
    .update([libraryName, libraryVersion, symbolKind, symbolName, signature ?? ""].join("|"))
    .digest("hex")
    .slice(0, 12);
  return `doc-${digest}`;
}

function validateEntry(opts: UpsertDocumentationEntryOptions): void {
  if (!opts.libraryName?.trim()) throw new IndexDbError(1, "--library is required.");
  if (!opts.libraryVersion?.trim()) throw new IndexDbError(1, "--version is required.");
  if (!SYMBOL_KINDS.has(opts.symbolKind)) {
    throw new IndexDbError(1, `Unknown symbol kind: "${opts.symbolKind}". Valid values: class, method`);
  }
  if (!opts.symbolName?.trim()) throw new IndexDbError(1, "--symbol-name is required.");
  if (!opts.description?.trim()) throw new IndexDbError(1, "--description is required.");
  // FR-003a write-path invariant (contracts/index-db-schema.md): provenance is
  // enforced here, not merely requested of the agent.
  if (!opts.sourceUrl?.trim()) {
    throw new IndexDbError(1, "source_url is required and must be non-empty (FR-003a: no entry without a verifiable citation).");
  }
  if (!opts.sourceExcerpt?.trim()) {
    throw new IndexDbError(1, "source_excerpt is required and must be non-empty (FR-003a: no entry without a verbatim excerpt).");
  }
}

/**
 * Insert (idempotently) one documentation entry. When `supersedesVersion` is
 * given, all rows for (library, supersedesVersion) are deleted in the SAME
 * transaction that writes the new row — data-model.md's version-change
 * lifecycle: stale-version documentation must never remain queryable.
 */
export function upsertDocumentationEntry(db: Database.Database, opts: UpsertDocumentationEntryOptions): DocumentationEntry {
  validateEntry(opts);
  // Normalize once and reuse everywhere: entryIdFor's hash input MUST match
  // exactly what gets stored in the `signature` column (and therefore the
  // UNIQUE/ON CONFLICT key) below, or the computed id and the row it actually
  // resolves to can disagree for class-kind entries carrying a stray signature.
  const normalizedSignature = opts.symbolKind === "class" ? null : (opts.signature?.trim() || null);
  const entryId = entryIdFor(opts.libraryName.trim(), opts.libraryVersion.trim(), opts.symbolKind, opts.symbolName.trim(), normalizedSignature);

  const write = db.transaction(() => {
    // Version-change lifecycle (data-model.md): writing a new version of the
    // same symbol/signature must supersede every prior version of that symbol.
    // Detect it directly so callers (ingest-docs re-run, index-doc-entry CLI)
    // don't have to thread the old version through.
    const priorVersions = db
      .prepare(
        "SELECT DISTINCT library_version FROM documentation_entries WHERE library_name = ? AND symbol_kind = ? AND symbol_name = ? AND COALESCE(signature, '') = COALESCE(?, '') AND library_version <> ?",
      )
      .all(
        opts.libraryName.trim(),
        opts.symbolKind,
        opts.symbolName.trim(),
        normalizedSignature,
        opts.libraryVersion.trim(),
      ) as { library_version: string }[];
    for (const { library_version } of priorVersions) {
      db.prepare("DELETE FROM documentation_entries WHERE library_name = ? AND library_version = ?")
        .run(opts.libraryName.trim(), library_version);
    }
    // Explicit supersedesVersion (for tests that pass it) is still honored.
    if (opts.supersedesVersion?.trim() && opts.supersedesVersion.trim() !== opts.libraryVersion.trim()) {
      db.prepare(
        "DELETE FROM documentation_entries WHERE library_name = ? AND library_version = ?",
      ).run(opts.libraryName.trim(), opts.supersedesVersion.trim());
    }
    db.prepare(
      `INSERT INTO documentation_entries
         (entry_id, library_name, library_version, symbol_kind, symbol_name, signature, description, return_type, source_url, source_excerpt, ingestion_run_id, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (library_name, library_version, symbol_kind, symbol_name, signature) DO UPDATE SET
         description = excluded.description,
         return_type = excluded.return_type,
         source_url = excluded.source_url,
         source_excerpt = excluded.source_excerpt,
         ingestion_run_id = excluded.ingestion_run_id,
         indexed_at = excluded.indexed_at`,
    ).run(
      entryId,
      opts.libraryName.trim(),
      opts.libraryVersion.trim(),
      opts.symbolKind,
      opts.symbolName.trim(),
      normalizedSignature,
      opts.description.trim(),
      opts.returnType?.trim() || null,
      opts.sourceUrl.trim(),
      opts.sourceExcerpt.trim(),
      opts.ingestionRunId?.trim() || randomUUID().replace(/-/g, "").slice(0, 16),
    );
  });
  write();

  return db.prepare("SELECT * FROM documentation_entries WHERE entry_id = ?").get(entryId) as DocumentationEntry;
}

/** Count entries already indexed for a (library, version) pair — the FR-007 unchanged-skip probe. */
export function countDocumentationEntries(db: Database.Database, libraryName: string, libraryVersion: string): number {
  return db
    .prepare("SELECT COUNT(*) AS n FROM documentation_entries WHERE library_name = ? AND library_version = ?")
    .pluck()
    .get(libraryName, libraryVersion) as number;
}

export interface StartIngestionRunOptions {
  runId?: string;
  triggeredBy: string;
  lockedSetSnapshotCount: number;
}

export function startIngestionRun(db: Database.Database, opts: StartIngestionRunOptions): IngestionRun {
  if (!opts.triggeredBy?.trim()) throw new IndexDbError(1, "--triggered-by is required.");
  const runId = opts.runId ?? randomUUID().replace(/-/g, "").slice(0, 16);
  db.prepare(
    `INSERT INTO ingestion_runs (run_id, started_at, triggered_by, locked_set_snapshot_count)
     VALUES (?, datetime('now'), ?, ?)`,
  ).run(runId, opts.triggeredBy.trim(), opts.lockedSetSnapshotCount);
  return db.prepare("SELECT * FROM ingestion_runs WHERE run_id = ?").get(runId) as IngestionRun;
}

export interface RecordIngestionRunLibraryOptions {
  runId: string;
  libraryName: string;
  libraryVersion: string;
  outcome: IngestionOutcome;
  reason?: string | null;
  entriesWritten?: number;
}

const OUTCOMES = new Set<IngestionOutcome>(["indexed", "skipped", "unchanged", "failed"]);

export function recordIngestionRunLibrary(db: Database.Database, opts: RecordIngestionRunLibraryOptions): IngestionRunLibrary {
  if (!OUTCOMES.has(opts.outcome)) {
    throw new IndexDbError(1, `Unknown ingestion outcome: "${opts.outcome}". Valid values: indexed, skipped, unchanged, failed`);
  }
  if ((opts.outcome === "skipped" || opts.outcome === "failed") && !opts.reason?.trim()) {
    throw new IndexDbError(1, `Outcome "${opts.outcome}" requires a reason (contracts/ingestion-cli-contract.md).`);
  }
  db.prepare(
    `INSERT INTO ingestion_run_libraries (run_id, library_name, library_version, outcome, reason, entries_written)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id, library_name) DO UPDATE SET
       library_version = excluded.library_version,
       outcome = excluded.outcome,
       reason = excluded.reason,
       entries_written = excluded.entries_written`,
  ).run(
    opts.runId,
    opts.libraryName,
    opts.libraryVersion,
    opts.outcome,
    opts.reason?.trim() || null,
    opts.entriesWritten ?? 0,
  );
  return db
    .prepare("SELECT * FROM ingestion_run_libraries WHERE run_id = ? AND library_name = ?")
    .get(opts.runId, opts.libraryName) as IngestionRunLibrary;
}

export function completeIngestionRun(db: Database.Database, runId: string): void {
  db.prepare("UPDATE ingestion_runs SET completed_at = datetime('now') WHERE run_id = ?").run(runId);
}

/**
 * Read-side query handle used by verification/lookup (a structural subset of
 * `Database` from better-sqlite3 — `prepare` is all we need). Defined locally
 * to avoid a circular import with the MCP server's own `DocQueryDb` alias.
 */
export type DocQueryDb = Pick<Database.Database, "prepare">;

/**
 * Batch verification (FR-010 / FR-010a, US2) — bounded reference-count limit
 * derived from the FR-015 token budget. Each reference is a small payload, so
 * the budget is expressed as a reference count rather than a byte size: the
 * response is one small object per reference. 50 is a conservative bound —
 * at ~80 tokens per echoed reference+outcome, 50 ≈ 4k tokens, well inside the
 * single-response budget shared with lookup/search
 * (contracts/mcp-tool-contract.md). An over-limit request is truncated with a
 * `next_cursor`, never silently dropped (data-model.md's Batch Verification
 * entity).
 */
export const MAX_VERIFY_REFERENCES = 50;

export type VerifyOutcome = "verified-present" | "verified-absent" | "unavailable";

export interface VerifyReference {
  library_name: string;
  library_version: string;
  symbol_name: string;
  signature?: string;
}

export interface VerifyResultItem {
  reference: VerifyReference;
  outcome: VerifyOutcome;
}

export interface VerifyReferencesResult {
  results: VerifyResultItem[];
  truncated: boolean;
  /** Index of the first reference NOT returned because the batch exceeded MAX_VERIFY_REFERENCES. */
  next_cursor?: number;
}

/**
 * Verify a batch of library API references against the index in a single
 * read-side compute over existing `documentation_entries` rows (no writes, no
 * new columns — verification is derived, per contracts/mcp-tool-contract.md).
 *
 * Outcome per reference:
 *  - verified-present — a row exists for library+version+symbol (+signature)
 *  - verified-absent  — library+version IS indexed but this symbol isn't
 *  - unavailable      — no rows at all for that library+version
 *
 * Order is preserved and exactly one outcome is returned per input reference.
 * `cursor` supports continuation of a truncated batch: pass the `next_cursor`
 * from a previous call to receive the remaining slice.
 */
export function verifyReferences(
  db: DocQueryDb,
  references: VerifyReference[],
  cursor = 0,
): VerifyReferencesResult {
  if (!Array.isArray(references)) {
    throw new DocLookupValidationError("references must be an array");
  }
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw new DocLookupValidationError("cursor must be a non-negative integer");
  }

  // Slicing honors an optional continuation cursor and the hard count budget.
  const slice = references.slice(cursor, cursor + MAX_VERIFY_REFERENCES);
  const results: VerifyResultItem[] = slice.map((ref) => {
    const library_name = String(ref.library_name ?? "");
    const library_version = String(ref.library_version ?? "");
    const symbol_name = String(ref.symbol_name ?? "");
    // A method reference uses its signature to disambiguate overloads
    // (FR-011); the column defaults to NULL for class entries, so an
    // omitted signature matches class rows and signature-less lookups.
    const signature = ref.signature === undefined ? null : String(ref.signature ?? "");

    if (!library_name || !library_version || !symbol_name) {
      // A malformed reference within an otherwise-valid batch yields an
      // `unavailable` outcome rather than aborting the whole batch — the MCP
      // handler already enforces input shape at the tool boundary, so this
      // read-side compute must never throw on a bad per-item field.
      return { reference: ref, outcome: "unavailable" };
    }

    // "unavailable" = the library+version has no index rows at all.
    // "verified-absent" = the scope is indexed but this symbol isn't.
    const scoped = db
      .prepare("SELECT COUNT(*) AS n FROM documentation_entries WHERE library_name = ? AND library_version = ?")
      .get(library_name, library_version) as { n: number };
    if (scoped.n === 0) {
      return { reference: ref, outcome: "unavailable" };
    }

    const present = db
      .prepare(
        `SELECT 1 FROM documentation_entries
         WHERE library_name = ? AND library_version = ? AND symbol_name = ?
           AND COALESCE(signature, '') = COALESCE(?, '')`,
      )
      .get(library_name, library_version, symbol_name, signature ?? "") as unknown;
    return {
      reference: ref,
      outcome: present ? "verified-present" : "verified-absent",
    };
  });

  const truncated = cursor + slice.length < references.length;
  return {
    results,
    truncated,
    ...(truncated ? { next_cursor: cursor + slice.length } : {}),
  };
}
