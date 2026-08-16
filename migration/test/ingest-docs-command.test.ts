import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { applyIndexDbSchema } from "../index-db/schema";
import { applySchema } from "../registry/db/schema";
import type { AgentRunResult } from "../guildctl/runner";
import { upsertProposedDisposition, confirmDisposition } from "../registry/commands/dispositions";

/**
 * specs/007-doc-rag-lookup — T015: ingest-docs command behavior
 * (contracts/ingestion-cli-contract.md): locked-set filtering to 'keep' rows,
 * per-library outcome recording, idempotent unchanged-skip (FR-007),
 * per-library failure isolation (FR-012), no-op on an empty locked set.
 */

function freshRegistryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

function freshIndexDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyIndexDbSchema(db);
  return db;
}

function seedLockedSet(registryDb: Database.Database, rows: { name: string; disposition: string; version?: string }[]): void {
  for (const row of rows) {
    upsertProposedDisposition(registryDb, {
      libraryName: row.name,
      disposition: row.disposition as never,
      rationale: "seeded by test",
      proposedBy: "test",
      lockedTargetVersion: row.version,
      nativeReplacement: row.disposition === "replace-with-native" ? "java.util.ArrayList" : undefined,
      inlineNote: row.disposition === "inline" ? "folded into caller" : undefined,
    });
    confirmDisposition(registryDb, { libraryName: row.name, confirmedBy: "test" });
  }
}

function makeSpawn(log: string[]): { spawnAgent: (opts: { agent: string; prompt: string }) => Promise<AgentRunResult> } {
  return {
    spawnAgent: async (opts) => {
      log.push(opts.prompt);
      return { runId: "r1", agent: opts.agent, model: "m", prompt: opts.prompt, exitCode: 0 } as AgentRunResult;
    },
  };
}

function seedIndexedEntry(indexDb: Database.Database, library: string, version: string): void {
  const runId = `seed-${library}`;
  indexDb.prepare(
    "INSERT INTO ingestion_runs (run_id, started_at, completed_at, triggered_by, locked_set_snapshot_count) VALUES (?, datetime('now'), datetime('now'), 'test', 1)",
  ).run(runId);
  indexDb.prepare(
    `INSERT INTO documentation_entries
       (entry_id, library_name, library_version, symbol_kind, symbol_name, description, source_url, source_excerpt, ingestion_run_id)
     VALUES (?, ?, ?, 'class', ?, 'd', 'https://example.test/doc', 'verbatim excerpt', ?)`,
  ).run(`doc-seed-${library}`, library, version, `${library}.SomeClass`, runId);
}

test("ingest-docs is a no-op when the locked set has no keep rows", async () => {
  const { runIngestDocs } = await import("../guildctl/commands/ingest-docs");
  const registryDb = freshRegistryDb();
  seedLockedSet(registryDb, [{ name: "com.example:dropme", disposition: "replace-with-native", version: "1.0" }]);
  const indexDb = freshIndexDb();
  const calls: string[] = [];

  const report = await runIngestDocs(registryDb, indexDb, { triggeredBy: "operator" }, {
    ...makeSpawn(calls),
    indexDbPath: ":memory:",
  });

  assert.equal(report.locked_set_snapshot_count, 0);
  assert.deepEqual(report.libraries, []);
  assert.equal(calls.length, 0, "no agent dispatch on an empty keep set");
  assert.equal(indexDb.prepare("SELECT COUNT(*) AS n FROM ingestion_runs").pluck().get(), 1);
  const run = indexDb.prepare("SELECT completed_at FROM ingestion_runs").get() as { completed_at: string | null };
  assert.ok(run.completed_at, "even a no-op run is completed (FR-004 audit row)");
});

test("ingest-docs launches one agent turn per keep library and records indexed outcomes (FR-005, FR-012)", async () => {
  const { runIngestDocs } = await import("../guildctl/commands/ingest-docs");
  const registryDb = freshRegistryDb();
  seedLockedSet(registryDb, [
    { name: "com.google.guava:guava", disposition: "keep", version: "33.2.1-jre" },
    { name: "org.apache.commons:commons-lang3", disposition: "keep", version: "3.14.0" },
    { name: "com.example:dropme", disposition: "inline", version: "9.9" },
  ]);
  const indexDb = freshIndexDb();
  const calls: string[] = [];

  const report = await runIngestDocs(registryDb, indexDb, { triggeredBy: "operator" }, {
    ...makeSpawn(calls),
    indexDbPath: ":memory:",
  });

  assert.equal(report.locked_set_snapshot_count, 2, "only keep-disposition libraries are considered");
  assert.equal(report.libraries.length, 2);
  assert.ok(report.libraries.every((l) => l.outcome === "indexed"));
  assert.ok(report.libraries.every((l) => l.reason == null));
  assert.equal(calls.length, 2, "one agent launch per keep library");
  assert.ok(calls.some((p) => p.includes("com.google.guava:guava") && p.includes("33.2.1-jre")));
  assert.ok(calls.some((p) => p.includes("org.apache.commons:commons-lang3") && p.includes("3.14.0")));
  assert.ok(calls.every((p) => !p.includes("com.example:dropme")), "replace-with-native/inline never dispatched (FR-005)");

  // Readiness composition (FR-004): one outcome row per library, run completed.
  const rows = indexDb.prepare("SELECT * FROM ingestion_run_libraries WHERE run_id = ?").all(report.run_id) as unknown[];
  assert.equal(rows.length, 2);
});

test("a second ingest-docs run with no version changes skips every library as unchanged (FR-007)", async () => {
  const { runIngestDocs } = await import("../guildctl/commands/ingest-docs");
  const registryDb = freshRegistryDb();
  seedLockedSet(registryDb, [{ name: "com.google.guava:guava", disposition: "keep", version: "33.2.1-jre" }]);
  const indexDb = freshIndexDb();
  seedIndexedEntry(indexDb, "com.google.guava:guava", "33.2.1-jre");
  const calls: string[] = [];

  const report = await runIngestDocs(registryDb, indexDb, { triggeredBy: "operator" }, {
    ...makeSpawn(calls),
    indexDbPath: ":memory:",
  });

  assert.equal(report.libraries.length, 1);
  assert.equal(report.libraries[0].outcome, "unchanged");
  assert.equal(report.libraries[0].entries_written, 0);
  assert.equal(calls.length, 0, "already-current libraries must not re-launch the agent");
});

test("a targeted --library run re-ingests even when the version is already indexed", async () => {
  const { runIngestDocs } = await import("../guildctl/commands/ingest-docs");
  const registryDb = freshRegistryDb();
  seedLockedSet(registryDb, [
    { name: "com.google.guava:guava", disposition: "keep", version: "33.2.1-jre" },
    { name: "org.apache.commons:commons-lang3", disposition: "keep", version: "3.14.0" },
  ]);
  const indexDb = freshIndexDb();
  seedIndexedEntry(indexDb, "com.google.guava:guava", "33.2.1-jre");
  seedIndexedEntry(indexDb, "org.apache.commons:commons-lang3", "3.14.0");
  const calls: string[] = [];

  const report = await runIngestDocs(registryDb, indexDb, { triggeredBy: "operator", library: "com.google.guava:guava" }, {
    ...makeSpawn(calls),
    indexDbPath: ":memory:",
  });

  assert.equal(report.locked_set_snapshot_count, 1, "targeted run only considers the named library");
  assert.equal(report.libraries[0].library_name, "com.google.guava:guava");
  assert.equal(report.libraries[0].outcome, "indexed");
  assert.equal(calls.length, 1);
});

test("one library's agent failure is recorded as failed and does not abort the run (FR-012)", async () => {
  const { runIngestDocs } = await import("../guildctl/commands/ingest-docs");
  const registryDb = freshRegistryDb();
  seedLockedSet(registryDb, [
    { name: "com.example:bad", disposition: "keep", version: "1.0" },
    { name: "com.google.guava:guava", disposition: "keep", version: "33.2.1-jre" },
  ]);
  const indexDb = freshIndexDb();

  const report = await runIngestDocs(registryDb, indexDb, { triggeredBy: "operator" }, {
    spawnAgent: async (opts: { agent: string; prompt: string }) => {
      if (opts.prompt.includes("com.example:bad")) throw new Error("harness blew up");
      return { runId: "r", agent: opts.agent, model: "m", prompt: opts.prompt, exitCode: 0 } as AgentRunResult;
    },
    indexDbPath: ":memory:",
  });

  assert.equal(report.libraries.length, 2, "the run still covers every locked library");
  const bad = report.libraries.find((l) => l.library_name === "com.example:bad")!;
  assert.equal(bad.outcome, "failed");
  assert.match(bad.reason ?? "", /harness blew up/);
  const good = report.libraries.find((l) => l.library_name === "com.google.guava:guava")!;
  assert.equal(good.outcome, "indexed");
  const run = indexDb.prepare("SELECT completed_at FROM ingestion_runs WHERE run_id = ?").get(report.run_id) as { completed_at: string | null };
  assert.ok(run.completed_at, "run completes despite the per-library failure");
});

test("runIngestDocs requires a triggered-by actor", async () => {
  const { runIngestDocs } = await import("../guildctl/commands/ingest-docs");
  await assert.rejects(
    () => runIngestDocs(freshRegistryDb(), freshIndexDb(), { triggeredBy: " " }),
    /triggered-by/i,
  );
});
