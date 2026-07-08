import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "path";
import test from "node:test";
import Database from "better-sqlite3";
import { dismissFinding, listAuditOverrides, listJvmAuditFindings, reopenFinding, replaceJvmAuditFindings } from "../registry/commands/modernization";
import { applySchema } from "../registry/db/schema";
import { registerArtifact } from "../registry/commands/artifacts";
import { evaluatePlanningReadiness, formatPlanningBlockMessage } from "../guildctl/readiness";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function registerFirstClassArtifact(db: Database.Database, id: string): void {
  const moduleName = id.split(":")[1] ?? "com.acme";
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    path: `legacy/src/main/java/${moduleName.replaceAll(".", "/")}/${id.split(":")[2]}.java`,
    tier: "first-class",
    module: moduleName,
    role: "service",
    framework: "plain-java",
  });
}

function criticalJvmFinding(artifactId: string, symbol: string) {
  return {
    tool: "source-scan",
    category: "internal-api" as const,
    severity: "critical" as const,
    symbol,
    summary: `Internal API usage detected: ${symbol}`,
    evidence: `L1: ${symbol}`,
    remediation: "Replace with supported API.",
  };
}

test("dismiss/reopen lifecycle records reason and toggles dismissed_at", () => {
  const db = createDb();
  try {
    const id = "legacy-source:com.acme:UnsafeApi";
    registerFirstClassArtifact(db, id);
    const [finding] = replaceJvmAuditFindings(db, id, [criticalJvmFinding(id, "sun.misc.Unsafe")]);
    const findingId = finding.finding_id;
    assert.equal(finding.dismissed_at, null);

    const override = dismissFinding(db, { findingId, reason: "Legacy internal API is intentional for this migration." });
    assert.equal(override.action, "dismiss");
    assert.equal(override.reason, "Legacy internal API is intentional for this migration.");
    assert.equal(override.dismissed_by, "operator");

    const afterDismiss = listJvmAuditFindings(db).find((f) => f.finding_id === findingId)!;
    assert.ok(afterDismiss.dismissed_at, "dismissed_at should be set");
    assert.ok(afterDismiss.override_id, "override_id should reference the override row");

    const reopened = reopenFinding(db, findingId);
    assert.equal(reopened.action, "reopen");
    const afterReopen = listJvmAuditFindings(db).find((f) => f.finding_id === findingId)!;
    assert.equal(afterReopen.dismissed_at, null);
    assert.equal(afterReopen.override_id, null);

    const overrides = listAuditOverrides(db, { findingId });
    assert.equal(overrides.length, 2);
    // Created within the same second (identical created_at), so assert the set, not order.
    assert.deepEqual(overrides.map((o) => o.action).sort(), ["dismiss", "reopen"]);
  } finally {
    db.close();
  }
});

test("gate blocks on open critical findings and passes once dismissed (uniform semantics)", () => {
  const db = createDb();
  try {
    const id = "legacy-source:com.acme:CriticalJvm";
    registerFirstClassArtifact(db, id);
    const [finding] = replaceJvmAuditFindings(db, id, [criticalJvmFinding(id, "sun.misc.Unsafe")]);

    // Open critical -> blocks.
    let readiness = evaluatePlanningReadiness(db);
    assert.equal(readiness.blockingJvmFindings.length, 1);
    const blockOpen = formatPlanningBlockMessage(readiness);
    assert.ok(blockOpen, "should block while open");
    assert.match(blockOpen!.command, /findings dismiss/);
    assert.match(blockOpen!.command, /--override-audit/);

    // Dismissed -> passes (no block).
    dismissFinding(db, { findingId: finding.finding_id, reason: "Accepted risk." });
    readiness = evaluatePlanningReadiness(db);
    assert.equal(readiness.blockingJvmFindings.length, 0);
    assert.equal(formatPlanningBlockMessage(readiness), null, "dismissed critical must not block");
  } finally {
    db.close();
  }
});

test("re-audit preserves dismissals (idempotent acknowledge)", () => {
  const db = createDb();
  try {
    const id = "legacy-source:com.acme:Reaudit";
    registerFirstClassArtifact(db, id);
    const [finding] = replaceJvmAuditFindings(db, id, [criticalJvmFinding(id, "sun.misc.Unsafe")]);
    dismissFinding(db, { findingId: finding.finding_id, reason: "Intentional." });

    // A second audit pass over the same artifact must NOT resurrect the finding.
    replaceJvmAuditFindings(db, id, [criticalJvmFinding(id, "sun.misc.Unsafe")]);
    const after = listJvmAuditFindings(db).find((f) => f.finding_id === finding.finding_id)!;
    assert.ok(after.dismissed_at, "dismissal survives re-audit");
    assert.equal(evaluatePlanningReadiness(db).blockingJvmFindings.length, 0);
  } finally {
    db.close();
  }
});

test("python-compat findings render as python-compat, never jvm", () => {
  const db = createDb();
  try {
    const id = "legacy-source:com.acme:Py2Print";
    registerFirstClassArtifact(db, id);
    // Mimic what the Python stack pack audit engine now emits for python-compat rules.
    replaceJvmAuditFindings(db, id, [{
      tool: "source-scan",
      category: "python-compat",
      severity: "critical",
      symbol: "print x",
      summary: "Python 2 print statement detected: print x",
      evidence: "L1: print x",
      remediation: "Use print().",
    }]);
    const [finding] = listJvmAuditFindings(db);
    assert.equal(finding.category, "python-compat");
    assert.notEqual(finding.category, "jvm");
    // And it still counts as a blocking critical finding under the gate.
    assert.equal(evaluatePlanningReadiness(db).blockingJvmFindings.length, 1);
  } finally {
    db.close();
  }
});
