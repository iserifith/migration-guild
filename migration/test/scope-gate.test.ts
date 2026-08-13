import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { registerArtifact, setArtifactStatus } from "../registry/commands/artifacts";
import { addManualDependency } from "../registry/commands/sourceDeps";
import {
  getModuleScopeSummary,
  getUndecidedModules,
  listScopeDecisions,
  recordScopeDecision,
} from "../registry/commands/scope";
import { applySchema } from "../registry/db/schema";
import { RegistryError } from "../registry/types";
import { evaluatePlanningReadiness, formatPlanningBlockMessage } from "../guildctl/readiness";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function registerInModule(db: Database.Database, id: string, module: string, status: string = "pending"): void {
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    path: `legacy/src/main/java/${module.replaceAll(".", "/")}/${id.split(":").pop()}.java`,
    tier: "first-class",
    module,
    role: "service",
    framework: "plain-java",
  });
  if (status !== "pending") setArtifactStatus(db, id, status as never);
}

test("recordScopeDecision validates inputs", () => {
  const db = createDb();
  try {
    registerInModule(db, "legacy-source:app:A", "app");
    assert.throws(() => recordScopeDecision(db, { module: "", decision: "keep", reason: "x", decidedBy: "op" }), RegistryError);
    assert.throws(() => recordScopeDecision(db, { module: "app", decision: "maybe" as never, reason: "x", decidedBy: "op" }), RegistryError);
    assert.throws(() => recordScopeDecision(db, { module: "app", decision: "keep", reason: "", decidedBy: "op" }), RegistryError);
    assert.throws(() => recordScopeDecision(db, { module: "app", decision: "keep", reason: "x", decidedBy: "" }), RegistryError);
    assert.throws(() => recordScopeDecision(db, { module: "does-not-exist", decision: "keep", reason: "x", decidedBy: "op" }), RegistryError);
  } finally {
    db.close();
  }
});

test("keep decision records an audit trail without touching artifact status", () => {
  const db = createDb();
  try {
    registerInModule(db, "legacy-source:checkout:A", "checkout");
    const result = recordScopeDecision(db, { module: "checkout", decision: "keep", reason: "core flow", decidedBy: "alice" });
    assert.equal(result.decision.decision, "keep");
    assert.equal(result.decision.reason, "core flow");
    assert.equal(result.decision.decided_by, "alice");
    assert.equal(result.skippedArtifactIds.length, 0);

    const artifact = db.prepare("SELECT status FROM artifacts WHERE id = ?").get("legacy-source:checkout:A") as { status: string };
    assert.equal(artifact.status, "pending");
  } finally {
    db.close();
  }
});

test("drop decision skips pre-migration artifacts but leaves in-flight ones alone", () => {
  const db = createDb();
  try {
    registerInModule(db, "legacy-source:admin:Pending", "admin", "pending");
    registerInModule(db, "legacy-source:admin:Planned", "admin", "planned");
    registerInModule(db, "legacy-source:admin:InProgress", "admin", "in-progress");

    const result = recordScopeDecision(db, { module: "admin", decision: "drop", reason: "not shipping", decidedBy: "alice" });

    assert.deepEqual(
      result.skippedArtifactIds.sort(),
      ["legacy-source:admin:Pending", "legacy-source:admin:Planned"].sort(),
    );
    assert.deepEqual(result.inFlightArtifactIds, ["legacy-source:admin:InProgress"]);

    const statuses = db.prepare("SELECT id, status FROM artifacts ORDER BY id").all() as Array<{ id: string; status: string }>;
    assert.deepEqual(statuses, [
      { id: "legacy-source:admin:InProgress", status: "in-progress" },
      { id: "legacy-source:admin:Pending", status: "skipped" },
      { id: "legacy-source:admin:Planned", status: "skipped" },
    ]);
  } finally {
    db.close();
  }
});

test("dropping a module surfaces cross-module dependents as a warning, not a block", () => {
  const db = createDb();
  try {
    registerInModule(db, "legacy-source:shared:Util", "shared");
    registerInModule(db, "legacy-source:checkout:Consumer", "checkout");
    addManualDependency(db, "legacy-source:checkout:Consumer", "legacy-source:shared:Util");

    const result = recordScopeDecision(db, { module: "shared", decision: "drop", reason: "dead code", decidedBy: "alice" });
    assert.deepEqual(result.crossModuleWarnings, [{ module: "checkout", edge_count: 1 }]);
    // Still drops — cross-module dependency is informational only (not a hard block).
    assert.equal(result.skippedArtifactIds.length, 1);
  } finally {
    db.close();
  }
});

test("re-deciding a module upserts rather than duplicating rows", () => {
  const db = createDb();
  try {
    registerInModule(db, "legacy-source:app:A", "app");
    recordScopeDecision(db, { module: "app", decision: "drop", reason: "first pass", decidedBy: "alice" });
    recordScopeDecision(db, { module: "app", decision: "keep", reason: "changed my mind", decidedBy: "bob" });

    const decisions = listScopeDecisions(db);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!.decision, "keep");
    assert.equal(decisions[0]!.decided_by, "bob");
  } finally {
    db.close();
  }
});

test("getUndecidedModules ignores modules with no first-class artifacts", () => {
  const db = createDb();
  try {
    registerArtifact(db, { id: "config:app:web", kind: "config", tier: "second-class", path: "legacy/app/web.xml", module: "app" });
    assert.deepEqual(getUndecidedModules(db), []);

    registerInModule(db, "legacy-source:app:A", "app");
    const undecided = getUndecidedModules(db);
    assert.equal(undecided.length, 1);
    assert.equal(undecided[0]!.module, "app");
  } finally {
    db.close();
  }
});

test("getModuleScopeSummary reports counts and decision status per module", () => {
  const db = createDb();
  try {
    registerInModule(db, "legacy-source:app:A", "app");
    registerInModule(db, "legacy-source:app:B", "app");
    registerArtifact(db, { id: "config:app:web", kind: "config", tier: "second-class", path: "legacy/app/web.xml", module: "app" });
    recordScopeDecision(db, { module: "app", decision: "keep", reason: "core", decidedBy: "alice" });

    const [summary] = getModuleScopeSummary(db);
    assert.equal(summary!.module, "app");
    assert.equal(summary!.artifact_count, 3);
    assert.equal(summary!.first_class_count, 2);
    assert.equal(summary!.second_class_count, 1);
    assert.equal(summary!.decision, "keep");
  } finally {
    db.close();
  }
});

test("planning readiness blocks on undecided module scope and unblocks once decided", () => {
  const db = createDb();
  try {
    registerInModule(db, "legacy-source:app:A", "app");

    let readiness = evaluatePlanningReadiness(db);
    assert.equal(readiness.unresolvedScopeModules.length, 1);
    const block = formatPlanningBlockMessage(readiness);
    assert.ok(block, "should block while scope is undecided");
    assert.match(block!.summary, /undecided module scope/);
    assert.match(block!.command, /scope/);

    recordScopeDecision(db, { module: "app", decision: "keep", reason: "core", decidedBy: "alice" });
    readiness = evaluatePlanningReadiness(db);
    assert.equal(readiness.unresolvedScopeModules.length, 0);
    assert.equal(formatPlanningBlockMessage(readiness), null, "decided scope must not block");
  } finally {
    db.close();
  }
});
