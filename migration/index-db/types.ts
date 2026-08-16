/**
 * TypeScript interfaces for `.guild/index.db` (007-doc-rag-lookup).
 * Fields per specs/007-doc-rag-lookup/data-model.md; interface style follows
 * migration/registry/types.ts's DependencyDisposition convention.
 */

export type SymbolKind = "class" | "method";

export interface DocumentationEntry {
  entry_id: string;
  library_name: string;
  library_version: string;
  symbol_kind: SymbolKind;
  symbol_name: string;
  signature: string | null;
  description: string;
  return_type: string | null;
  source_url: string;
  source_excerpt: string;
  ingestion_run_id: string;
  indexed_at: string;
}

export interface IngestionRun {
  run_id: string;
  started_at: string;
  completed_at: string | null;
  triggered_by: string;
  locked_set_snapshot_count: number;
}

export type IngestionOutcome = "indexed" | "skipped" | "unchanged" | "failed";

export interface IngestionRunLibrary {
  run_id: string;
  library_name: string;
  library_version: string;
  outcome: IngestionOutcome;
  reason: string | null;
  entries_written: number;
}
