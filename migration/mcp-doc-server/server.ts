#!/usr/bin/env node
/**
 * Migration Guild documentation index MCP server (007-doc-rag-lookup).
 *
 * Stdio MCP server scoped to index-query tools only (contracts/mcp-tool-contract.md).
 * Opens `.guild/index.db` read-only — this server only answers queries;
 * ingestion writes happen through the ingestion agent's own process.
 *
 * Path resolution: GUILD_INDEX_DB_PATH env (set by the harness wiring) wins,
 * otherwise resolveIndexDbPath() against the workspace root.
 */
import Database from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import {
  lookupLibraryDoc,
  searchLibraryDocs,
} from "./queries";
import { resolveIndexDbPath } from "../guildctl/config";

export const MCP_SERVER_NAME = "guild-docs";
export const MCP_SERVER_VERSION = "0.1.0";

export function resolveServerIndexDbPath(env: Record<string, string | undefined> = process.env): string {
  return env["GUILD_INDEX_DB_PATH"]?.trim() || resolveIndexDbPath();
}

export function openReadOnlyIndexDb(dbPath: string): DocQueryDb {
  return new Database(dbPath, { readonly: true, fileMustExist: true }) as DocQueryDb;
}

/** Thrown by query functions on malformed input — mapped to an MCP InvalidParams tool error, never a "not_found". */
export class DocLookupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocLookupValidationError";
  }
}

/** Local type alias so queries.ts can throw the server's validation error without a circular import. */
export type DocQueryDb = Pick<Database.Database, "prepare">;

export function createDocServer(db: DocQueryDb): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "lookup_library_doc",
        description:
          "Look up version-pinned API documentation for an exact class or method symbol. " +
          "Returns found / not_found / unavailable — never cross-version results.",
        inputSchema: {
          type: "object",
          properties: {
            library_name: { type: "string" },
            library_version: { type: "string" },
            symbol_kind: { type: "string", enum: ["class", "method"] },
            symbol_name: { type: "string" },
            signature: { type: "string", description: "Required when symbol_kind is \"method\"; disambiguates overloads (FR-011)." },
            chunk_index: { type: "number", description: "Fetch chunk N of an oversized entry (see entry.chunk)." },
          },
          required: ["library_name", "library_version", "symbol_kind", "symbol_name"],
        },
      },
      {
        name: "lookup_library_doc_search",
        description:
          "Ranked full-text search over the version-pinned documentation index, scoped to one " +
          "library+version. Returns candidates or status:\"empty\" (distinct from lookup_library_doc's not_found).",
        inputSchema: {
          type: "object",
          properties: {
            library_name: { type: "string" },
            library_version: { type: "string" },
            query: { type: "string" },
            limit: { type: "number" },
          },
          required: ["library_name", "library_version", "query"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const input = (args ?? {}) as Record<string, unknown>;
    try {
      let payload: unknown;
      if (name === "lookup_library_doc") {
        payload = lookupLibraryDoc(db, input);
      } else if (name === "lookup_library_doc_search") {
        payload = searchLibraryDocs(db, input);
      } else {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    } catch (e) {
      if (e instanceof McpError) throw e;
      // Malformed input is a tool error, never a "not_found" — callers must be
      // able to distinguish an invalid query from a valid query with no match.
      // Return it as an isError result (not a thrown protocol error) so the
      // client sees res.isError === true rather than a transport-level exception.
      if (e instanceof DocLookupValidationError) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }],
        };
      }
      throw e;
    }
  });

  return server;
}

async function main(): Promise<void> {
  const db = openReadOnlyIndexDb(resolveServerIndexDbPath());
  const server = createDocServer(db);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`guild-docs MCP server failed to start: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
