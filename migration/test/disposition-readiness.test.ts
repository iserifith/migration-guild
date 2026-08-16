import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  evaluatePlanningReadiness,
  formatPlanningBlockMessage,
} from "../guildctl/readiness";
import {
  confirmDisposition,
  upsertProposedDisposition,
} from "../registry/commands/dispositions";
import { registerArtifact } from "../registry/commands/artifacts";
import { replaceDependencyFindings } from "../registry/commands/modernization";
import { recordScopeDecision } from "../registry/commands/scope";
import { applySchema } from "../registry/db/schema";

/**
 * T017 — US2 readiness-gate coverage for specs/006-dependency-disposition
 * (FR-006/FR-007, contracts/registry-schema.md "Readiness integration").
 */

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function seedProposedDisposition(db: Database.Database, libraryName: string): void {
  upsertProposedDisposition(db, {
    libraryName,
    currentVersion: "1.0.0",
    disposition: "replace-with-native",
    nativeReplacement: "java.util.Objects",
    rationale: "Seed proposal.",
    proposedBy: "planner-collector",
  });
}

test("unconfirmedDispositions includes status='proposed' rows and confirmed rows with a pending re-proposal", () => {
  const db = createDb();
  try {
    // Plain proposed row.
    seedProposedDisposition(db, "org.apache.commons:commons-lang3");

    // Confirmed row WITHOUT pending → NOT unresolved.
    seedProposedDisposition(db, "com.acme:already-settled");
    confirmDisposition(db, { libraryName: "com.acme:already-settled", confirmedBy: "operator" });

    // Confirmed row WITH a pending re-proposal → unresolved again.
    upsertProposedDisposition(db, {
      libraryName: "joda-time:joda-time",
      currentVersion: "2.10",
      disposition: "keep",
      lockedTargetVersion: "2.10",
      rationale: "Keep seed.",
      proposedBy: "planner-collector",
    });
    confirmDisposition(db, { libraryName: "joda-time:joda-time", confirmedBy: "operator" });
    upsertProposedDisposition(db, {
      libraryName: "joda-time:joda-time",
      currentVersion: "2.12.7",
      disposition: "replace-with-native",
      nativeReplacement: "java.time",
      rationale: "Re-run evidence.",
      proposedBy: "planner-collector",
    });

    const readiness = evaluatePlanningReadiness(db);
    const names = readiness.unconfirmedDispositions.map((row) => row.library_name).sort();
    assert.deepEqual(names, ["joda-time:joda-time", "org.apache.commons:commons-lang3"]);
  } finally {
    db.close();
  }
});

test("formatPlanningBlockMessage returns the disposition-blocked message AFTER scope → JVM → dependency branches", () => {
  const db = createDb();
  try {
    seedProposedDisposition(db, "org.apache.commons:commons-lang3");
    const readiness = evaluatePlanningReadiness(db);

    const block = formatPlanningBlockMessage(readiness);
    assert.ok(block, "disposition branch fires when earlier branches are clear");
    assert.equal(block.summary, "Planning blocked by unconfirmed dependency dispositions.");
    assert.equal(block.command, "node migration/dist/registry/cli.js list-dispositions --status proposed");
    assert.match(block.reason, /1 librar/);

    // Ordering: a dependency-strategy block wins over the disposition branch
    // (scope and JVM precede it as well — covered by planning-gates.test.ts).
    const artifactId = "legacy-source:com.acme:OrderingCheck";
    registerArtifact(db, {
      id: artifactId,
      kind: "legacy-source",
      path: "legacy/src/main/java/com/acme/OrderingCheck.java",
      tier: "first-class",
      module: "com.acme",
      role: "service",
      framework: "plain-java",
    });
    replaceDependencyFindings(db, artifactId, [{
      dependency_name: "log4j:log4j",
      current_version: "1.2.17",
      target_hint: "org.slf4j:slf4j-api",
      category: "eol",
      severity: "critical",
      summary: "EOL Log4j 1.x API detected.",
      remediation: "Approve a logging replacement strategy.",
    }]);
    // Clear the scope gate so the dependency branch is the one that fires.
    recordScopeDecision(db, { module: "com.acme", decision: "keep", reason: "fixture", decidedBy: "test" });

    const withDependencyBlock = evaluatePlanningReadiness(db);
    const block2 = formatPlanningBlockMessage(withDependencyBlock);
    assert.ok(block2);
    assert.equal(block2.summary, "Planning blocked by unresolved dependency modernization strategies.");
  } finally {
    db.close();
  }
});

test("a dependency_findings row whose library has a confirmed non-keep disposition is excluded from unresolvedDependencyFindings", () => {
  const db = createDb();
  try {
    const artifactId = "legacy-source:com.acme:LegacyJodaService";
    registerArtifact(db, {
      id: artifactId,
      kind: "legacy-source",
      path: "legacy/src/main/java/com/acme/LegacyJodaService.java",
      tier: "first-class",
      module: "com.acme",
      role: "service",
      framework: "plain-java",
    });
    replaceDependencyFindings(db, artifactId, [{
      dependency_name: "joda-time:joda-time",
      current_version: "2.10",
      target_hint: null,
      category: "outdated",
      severity: "warning",
      summary: "Joda-Time is superseded by java.time.",
      remediation: "Replace with java.time.",
    }]);

    // Baseline: no disposition → the finding is unresolved.
    let readiness = evaluatePlanningReadiness(db);
    assert.equal(readiness.unresolvedDependencyFindings.length, 1);

    // Confirmed keep → does NOT resolve the finding (kept libraries still
    // need approved strategies exactly as today).
    upsertProposedDisposition(db, {
      libraryName: "joda-time:joda-time",
      currentVersion: "2.10",
      disposition: "keep",
      lockedTargetVersion: "2.10",
      rationale: "Keep.",
      proposedBy: "planner-collector",
    });
    confirmDisposition(db, { libraryName: "joda-time:joda-time", confirmedBy: "operator" });
    readiness = evaluatePlanningReadiness(db);
    assert.equal(readiness.unresolvedDependencyFindings.length, 1, "confirmed keep does not resolve the finding");

    // Confirmed non-keep → the disposition IS the resolution (NOT EXISTS filter).
    confirmDisposition(db, {
      libraryName: "joda-time:joda-time",
      confirmedBy: "operator",
      disposition: "replace-with-native",
      nativeReplacement: "java.time",
      rationale: "Override: replace with java.time.",
    });
    readiness = evaluatePlanningReadiness(db);
    assert.equal(readiness.unresolvedDependencyFindings.length, 0,
      "confirmed non-keep disposition resolves the dependency finding");
  } finally {
    db.close();
  }
});
