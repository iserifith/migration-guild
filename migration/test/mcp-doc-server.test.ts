import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { applyIndexDbSchema } from "../index-db/schema";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * specs/007-doc-rag-lookup — T023: server wiring for the guild-docs MCP
 * server (contracts/mcp-tool-contract.md): read-only DB open, tool
 * registration, happy-path dispatch, malformed-input tool errors.
 */

function seededDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyIndexDbSchema(db);
  db.prepare(
    "INSERT INTO ingestion_runs (run_id, started_at, completed_at, triggered_by, locked_set_snapshot_count) VALUES ('run-1', datetime('now'), datetime('now'), 'test', 1)",
  ).run();
  db.prepare(
    `INSERT INTO documentation_entries
       (entry_id, library_name, library_version, symbol_kind, symbol_name, signature, description, return_type, source_url, source_excerpt, ingestion_run_id)
     VALUES ('doc-m1', 'com.google.guava:guava', '33.2.1-jre', 'method', 'Preconditions#checkNotNull', '(java.lang.Object)',
             'Ensures that an object reference is not null.', 'T', 'https://guava.dev/api/Preconditions.html#checkNotNull', 'checkNotNull(T reference)', 'run-1')`,
  ).run();
  return db;
}

async function makeClient(db: Database.Database) {
  const { createDocServer } = await import("../mcp-doc-server/server");
  const server = createDocServer(db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test("openReadOnlyIndexDb opens the database read-only", async () => {
  const { openReadOnlyIndexDb } = await import("../mcp-doc-server/server");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guild-ro-"));
  const dbPath = path.join(dir, "index.db");
  const writer = new Database(dbPath);
  applyIndexDbSchema(writer);
  writer.close();

  const ro = openReadOnlyIndexDb(dbPath);
  assert.throws(
    () => (ro as Database.Database).prepare("INSERT INTO ingestion_runs (run_id, started_at, triggered_by, locked_set_snapshot_count) VALUES ('x', 'now', 'op', 0)").run(),
    /readonly/i,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("server registers exactly the three tools (Phase 4 + Phase 5)", async () => {
  const { client, server } = await makeClient(seededDb());
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["lookup_library_doc", "lookup_library_doc_search", "verify_library_docs"]);
  await client.close();
  await server.close();
});

test("happy-path lookup_library_doc call returns the contract payload", async () => {
  const { client, server } = await makeClient(seededDb());
  const res = await client.callTool({
    name: "lookup_library_doc",
    arguments: {
      library_name: "com.google.guava:guava", library_version: "33.2.1-jre",
      symbol_kind: "method", symbol_name: "Preconditions#checkNotNull", signature: "(java.lang.Object)",
    },
  });
  const payload = JSON.parse((res.content as { type: string; text: string }[])[0].text) as { status: string; entry?: { chunk?: unknown } };
  assert.equal(payload.status, "found");
  assert.deepEqual(payload.entry?.chunk, { index: 0, of: 1 });
  assert.notEqual(res.isError, true);
  await client.close();
  await server.close();
});

test("malformed input surfaces as an MCP tool error, never a not_found payload", async () => {
  const { client, server } = await makeClient(seededDb());
  const res = await client.callTool({
    name: "lookup_library_doc",
    arguments: { library_name: "com.google.guava:guava", library_version: "33.2.1-jre", symbol_kind: "module", symbol_name: "X" },
  });
  assert.equal(res.isError, true, "invalid symbol_kind must be a tool error");
  await client.close();
  await server.close();
});

test("resolveServerIndexDbPath prefers GUILD_INDEX_DB_PATH over the workspace default", async () => {
  const { resolveServerIndexDbPath } = await import("../mcp-doc-server/server");
  assert.equal(resolveServerIndexDbPath({ GUILD_INDEX_DB_PATH: "/tmp/explicit.db" }), "/tmp/explicit.db");
  assert.match(resolveServerIndexDbPath({}), /\.guild[\/\\]index\.db$/);
});

/**
 * T030 (US2): verify_library_docs handler — per contracts/mcp-tool-contract.md.
 * A batch request returns { results, truncated }, each outcome one of
 * verified-present | verified-absent | unavailable, in one call.
 */

test("server registers the verify_library_docs tool (Phase 5)", async () => {
  const { client, server } = await makeClient(seededDb());
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["lookup_library_doc", "lookup_library_doc_search", "verify_library_docs"]);
  await client.close();
  await server.close();
});

test("verify_library_docs returns results/truncated shape, one outcome per reference", async () => {
  const { client, server } = await makeClient(seededDb());
  const res = await client.callTool({
    name: "verify_library_docs",
    arguments: {
      references: [
        { library_name: "com.google.guava:guava", library_version: "33.2.1-jre", symbol_name: "Preconditions#checkNotNull", signature: "(java.lang.Object)" },
        { library_name: "com.google.guava:guava", library_version: "33.2.1-jre", symbol_name: "Preconditions#checkNotBlank", signature: "(java.lang.String)" },
        { library_name: "com.example:never-ingested", library_version: "1.0", symbol_name: "Anything" },
      ],
    },
  });
  assert.notEqual(res.isError, true);
  const payload = JSON.parse((res.content as { type: string; text: string }[])[0].text) as {
    results: { reference: unknown; outcome: string }[];
    truncated: boolean;
  };
  assert.equal(payload.truncated, false);
  assert.equal(payload.results.length, 3);
  assert.deepEqual(
    payload.results.map((r) => r.outcome),
    ["verified-present", "verified-absent", "unavailable"],
  );
  await client.close();
  await server.close();
});

test("verify_library_docs rejects malformed input as a tool error, never a result payload", async () => {
  const { client, server } = await makeClient(seededDb());
  const res = await client.callTool({
    name: "verify_library_docs",
    // references is required; pass an empty/non-array → malformed.
    arguments: { references: [] },
  });
  assert.equal(res.isError, true, "empty references array must be a tool error");
  await client.close();
  await server.close();
});
