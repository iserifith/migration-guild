/**
 * Query helpers for the guild-docs MCP server (007-doc-rag-lookup, US1).
 *
 * Exact lookup never crosses versions (FR-002): every query pins
 * (library_name, library_version). Search (FR-002a) uses the FTS5 index and
 * is likewise scoped to the same library+version pair.
 */
import { DocLookupValidationError } from "./server";
import type { DocQueryDb } from "./server";
import type { DocumentationEntry } from "../index-db/types";

export interface LookupInput {
  library_name: string;
  library_version: string;
  symbol_kind: "class" | "method";
  symbol_name: string;
  signature?: string;
  chunk_index?: number;
}

export type LookupResult =
  | { status: "found"; entry: Record<string, unknown> }
  | { status: "not_found" }
  | { status: "unavailable"; reason: string };

export interface SearchCandidate {
  symbol_name: string;
  signature: string | null;
  snippet: string;
  rank: number;
}

export type SearchResult =
  | { status: "ok"; candidates: SearchCandidate[] }
  | { status: "empty" }
  | { status: "unavailable"; reason: string };

function requireString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new DocLookupValidationError(`Missing or invalid required field: ${field}`);
  }
  return value.trim();
}

function validateLookupInput(input: Record<string, unknown>): LookupInput {
  const symbol_kind = requireString(input, "symbol_kind");
  if (symbol_kind !== "class" && symbol_kind !== "method") {
    throw new DocLookupValidationError(`Unknown symbol_kind: "${symbol_kind}". Valid values: class, method`);
  }
  const signature = input["signature"];
  if (symbol_kind === "method" && (typeof signature !== "string" || !signature.trim())) {
    throw new DocLookupValidationError('signature is required when symbol_kind is "method" (FR-011)');
  }
  return {
    library_name: requireString(input, "library_name"),
    library_version: requireString(input, "library_version"),
    symbol_kind,
    symbol_name: requireString(input, "symbol_name"),
    signature: typeof signature === "string" ? signature.trim() || undefined : undefined,
    chunk_index: typeof input["chunk_index"] === "number" ? input["chunk_index"] : undefined,
  };
}

export function lookupLibraryDoc(db: DocQueryDb, rawInput: Record<string, unknown>): LookupResult {
  const input = validateLookupInput(rawInput);

  // "unavailable" = the library+version has no index rows at all (not in the
  // locked set's indexed docs). Distinct from "not_found" (library is indexed,
  // but this symbol is not).
  const scoped = db
    .prepare("SELECT COUNT(*) AS n FROM documentation_entries WHERE library_name = ? AND library_version = ?")
    .get(input.library_name, input.library_version) as { n: number };
  if (scoped.n === 0) {
    return {
      status: "unavailable",
      reason: `${input.library_name}@${input.library_version} is not in the indexed documentation set`,
    };
  }

  const row = db.prepare(`
    SELECT * FROM documentation_entries
    WHERE library_name = ? AND library_version = ?
      AND symbol_kind = ? AND symbol_name = ?
      AND COALESCE(signature, '') = COALESCE(?, '')
  `).get(
    input.library_name,
    input.library_version,
    input.symbol_kind,
    input.symbol_name,
    input.symbol_kind === "method" ? input.signature ?? "" : "",
  ) as DocumentationEntry | undefined;

  if (!row) return { status: "not_found" };
  return {
    status: "found",
    entry: {
      symbol_name: row.symbol_name,
      signature: row.signature,
      description: row.description,
      return_type: row.return_type,
      source_url: row.source_url,
      chunk: { index: 0, of: 1 },
    },
  };
}

export function searchLibraryDocs(db: DocQueryDb, rawInput: Record<string, unknown>): SearchResult {
  const library_name = requireString(rawInput, "library_name");
  const library_version = requireString(rawInput, "library_version");
  const query = requireString(rawInput, "query");
  const rawLimit = rawInput["limit"];
  const limit = typeof rawLimit === "number" && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 50) : 10;

  const scoped = db
    .prepare("SELECT COUNT(*) AS n FROM documentation_entries WHERE library_name = ? AND library_version = ?")
    .get(library_name, library_version) as { n: number };
  if (scoped.n === 0) {
    // Search treats "no rows for this scope" as empty, not unavailable: the
    // quickstart distinguishes search's empty (distinct from lookup's
    // not_found) from a genuine unavailability condition.
    return { status: "empty" };
  }

  // Free-text query → OR'd quoted terms so a multi-word description like
  // "argument null check" matches entries containing any of those tokens
  // (ranked by bm25), rather than requiring every token to be present
  // (FTS5's implicit-AND default, which would starve real matches).
  const matchExpr = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, "")}"`)
    .join(" OR ");

  const rows = db.prepare(`
    SELECT e.symbol_name, e.signature, snippet(documentation_entries_fts, 1, '', '', '…', 12) AS snippet,
           bm25(documentation_entries_fts) AS rank
    FROM documentation_entries_fts
    JOIN documentation_entries e ON e.rowid = documentation_entries_fts.rowid
    WHERE documentation_entries_fts MATCH ?
      AND e.library_name = ? AND e.library_version = ?
    ORDER BY rank
    LIMIT ?
  `).all(matchExpr, library_name, library_version, limit) as SearchCandidate[];

  if (rows.length === 0) return { status: "empty" };
  // bm25 returns more-negative-is-better scores; normalize to a 0..1-ish
  // positive rank for the contract's "rank" field.
  return {
    status: "ok",
    candidates: rows.map((r) => ({
      symbol_name: r.symbol_name,
      signature: r.signature,
      snippet: r.snippet,
      rank: Math.abs(r.rank),
    })),
  };
}
