/**
 * Ingestion-run recording helpers (007-doc-rag-lookup, FR-004/FR-012).
 * Re-exported from entries.ts; implemented there next to IndexDbError so the
 * write path shares one error type.
 */
export {
  IndexDbError,
  startIngestionRun,
  recordIngestionRunLibrary,
  completeIngestionRun,
} from "./entries";
export type {
  StartIngestionRunOptions,
  RecordIngestionRunLibraryOptions,
} from "./entries";
