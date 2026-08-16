import { createHash, randomUUID } from "crypto";
import type Database from "better-sqlite3";
import type { DocumentationEntry, IngestionOutcome, IngestionRun, IngestionRunLibrary, SymbolKind } from "../types";

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
