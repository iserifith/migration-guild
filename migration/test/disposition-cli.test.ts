import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { applySchema } from "../registry/db/schema";

/**
 * T008 — registry CLI coverage for
 * specs/006-dependency-disposition/contracts/cli-surface.md, spawning
 * migration/registry/cli.ts via tsx (mirroring evidence-cli.test.ts).
 */

function createFixture(): { dir: string; dbPath: string; cwd: string } {
  const cwd = path.resolve(__dirname, "..");
  const dir = mkdtempSync(path.join(tmpdir(), "guildctl-disposition-cli-"));
  const dbPath = path.join(dir, "registry.db");
  const db = new Database(dbPath);
  try {
    applySchema(db);
  } finally {
    db.close();
  }
  return { dir, dbPath, cwd };
}

function runRegistryCli(fixture: { cwd: string; dbPath: string }, args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(fixture.cwd, "registry", "cli.ts"), "--db", fixture.dbPath, ...args],
    {
      cwd: fixture.cwd,
      encoding: "utf8",
      env: { ...process.env, DOTENV_CONFIG_SILENT: "true" },
    },
  );
}

function withFixture(fn: (fixture: ReturnType<typeof createFixture>) => void): void {
  const fixture = createFixture();
  try {
    fn(fixture);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

const PROPOSE_ARGS = [
  "propose-disposition",
  "--library", "joda-time:joda-time",
  "--disposition", "replace-with-native",
  "--native-replacement", "java.time",
  "--rationale", "java.time supersedes Joda-Time since Java 8",
  "--proposed-by", "planner-collector",
  "--current-version", "2.10.14",
];

test("propose-disposition enforces required flags", () => {
  withFixture((fixture) => {
    const missing = runRegistryCli(fixture, ["propose-disposition", "--library", "x:y"]);
    assert.notEqual(missing.status, 0, "missing required flags must exit non-zero");
  });
});

test("propose-disposition rejects replace-with-native without --native-replacement", () => {
  withFixture((fixture) => {
    const result = runRegistryCli(fixture, [
      "propose-disposition",
      "--library", "x:y",
      "--disposition", "replace-with-native",
      "--rationale", "should fail",
      "--proposed-by", "planner-agent",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /native/i);
  });
});

test("propose-disposition emits JSON output on success", () => {
  withFixture((fixture) => {
    const result = runRegistryCli(fixture, PROPOSE_ARGS);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const row = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(row.library_name, "joda-time:joda-time");
    assert.equal(row.disposition, "replace-with-native");
    assert.equal(row.status, "proposed");
    assert.equal(row.native_replacement, "java.time");
    assert.equal(row.proposed_by, "planner-collector");
  });
});

test("list-dispositions returns rows ordered with --status and --pending-only filters", () => {
  withFixture((fixture) => {
    assert.equal(runRegistryCli(fixture, PROPOSE_ARGS).status, 0);
    assert.equal(runRegistryCli(fixture, [
      "propose-disposition",
      "--library", "com.google.guava:guava",
      "--disposition", "keep",
      "--rationale", "deep collections usage — keep",
      "--proposed-by", "planner-collector",
      "--locked-version", "31.1-jre",
    ]).status, 0);

    const listAll = runRegistryCli(fixture, ["list-dispositions"]);
    assert.equal(listAll.status, 0, listAll.stderr || listAll.stdout);
    const all = JSON.parse(listAll.stdout) as Array<Record<string, unknown>>;
    assert.deepEqual(all.map((r) => r.library_name), ["com.google.guava:guava", "joda-time:joda-time"]);

    const proposed = JSON.parse(runRegistryCli(fixture, ["list-dispositions", "--status", "proposed"]).stdout) as unknown[];
    assert.equal(proposed.length, 2);
    const confirmed = JSON.parse(runRegistryCli(fixture, ["list-dispositions", "--status", "confirmed"]).stdout) as unknown[];
    assert.equal(confirmed.length, 0);

    // Plant a pending re-proposal directly to exercise --pending-only.
    const db = new Database(fixture.dbPath);
    try {
      db.prepare(`
        UPDATE dependency_dispositions
        SET status = 'confirmed', confirmed_by = 'operator', confirmed_at = datetime('now'),
            pending_disposition = 'replace-with-native', pending_rationale = 'new evidence',
            pending_proposed_by = 'planner-agent', pending_at = datetime('now')
        WHERE library_name = 'com.google.guava:guava'
      `).run();
    } finally {
      db.close();
    }

    const pendingOut = runRegistryCli(fixture, ["list-dispositions", "--pending-only"]);
    assert.equal(pendingOut.status, 0, pendingOut.stderr || pendingOut.stdout);
    const pending = JSON.parse(pendingOut.stdout) as Array<Record<string, unknown>>;
    assert.deepEqual(pending.map((r) => r.library_name), ["com.google.guava:guava"]);
  });
});
