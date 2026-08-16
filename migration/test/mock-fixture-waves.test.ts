import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { buildParallelPools } from "../registry/commands/sourceDeps";
import { scanAndRegister } from "../guildctl/commands/inventory";
import { applySchema } from "../registry/db/schema";

// Spec 008 — US2 regression (SC-003): planning the legacy-customer-utils +
// legacy-customer-reports pair produces 2+ waves with the dependency ordered first.
//
// This exercises the REAL inventory scanner + source-dependency extractor + parallel-pool
// builder against the actual mock fixture source files (copied into a temp workspace), so it
// pins real engine behavior rather than a hand-fed dependency graph. It does NOT change
// assertions about any existing fixture.

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CUSTOMER_UTILS = path.join(REPO_ROOT, "package", "mock", "legacy-customer-utils");
const CUSTOMER_REPORTS = path.join(REPO_ROOT, "package", "mock", "legacy-customer-reports");

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function makeWorkspace(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mg-008-waves-"));
  const legacyDir = path.join(root, "legacy");
  fs.mkdirSync(legacyDir, { recursive: true });

  // Copy each fixture's source tree into legacy/<fixture-name> so the scanner derives
  // module names "legacy-customer-utils" and "legacy-customer-reports" — exactly the
  // layout the scanner expects (^legacy/([^/]+)/src/main/java/).
  for (const [fixture, src] of [
    ["legacy-customer-utils", CUSTOMER_UTILS],
    ["legacy-customer-reports", CUSTOMER_REPORTS],
  ] as const) {
    fs.cpSync(path.join(src, "src"), path.join(legacyDir, fixture, "src"), { recursive: true });
  }

  return {
    root,
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("SC-003: dependent pair produces 2+ waves with legacy-customer-utils ordered first", () => {
  const db = createDb();
  const ws = makeWorkspace();
  try {
    // Real scan: registers first-class artifacts AND extracts source-level dependencies.
    const registered = scanAndRegister(db, ws.root);
    assert.ok(registered >= 2, `expected at least the two fixture classes, got ${registered}`);

    // The reports class imports LegacyCustomerKeyService, so a customer-utils → reports
    // edge must exist in the registry.
    const edges = db
      .prepare(
        "SELECT dependent_id, dependency_id FROM source_dependencies " +
          "WHERE dependency_id LIKE '%:LegacyCustomerKeyService'",
      )
      .all() as Array<{ dependent_id: string; dependency_id: string }>;
    assert.ok(edges.length >= 1, "expected a source dependency on LegacyCustomerKeyService");
    assert.ok(
      edges.every((e) => e.dependent_id.includes("legacy-customer-reports")),
      "dependency edge should originate from the reports module",
    );

    // Build parallel pools and assert ordering.
    const pools = buildParallelPools(db, 4);
    assert.ok(pools.length >= 2, `expected 2+ waves, got ${pools.length}: ${JSON.stringify(pools)}`);

    // Assert on the SPECIFIC dependency/dependent artifacts, not the module as a
    // whole: sibling artifacts in legacy-customer-utils (e.g. PropertiesRegionCodeResolver)
    // share the dependency's pool, so module-greedy matching would over-approximate.
    // The precise SC-003 contract is: the dependency (LegacyCustomerKeyService) must be
    // scheduled into an earlier pool than the dependent (CustomerReportService).
    const DEP = "legacy-source:legacy-customer-utils:LegacyCustomerKeyService";
    const DEPENDENT = "legacy-source:legacy-customer-reports:CustomerReportService";
    const depPool = pools.findIndex((p) => p.includes(DEP));
    const dependentPool = pools.findIndex((p) => p.includes(DEPENDENT));
    assert.ok(depPool >= 0, `dependency artifact ${DEP} should appear in a pool`);
    assert.ok(
      dependentPool >= 0,
      `dependent artifact ${DEPENDENT} should appear in a pool`,
    );
    assert.ok(
      depPool < dependentPool,
      `dependency must drain before dependent: ${DEP} pool ${depPool} < ${DEPENDENT} pool ${dependentPool}`,
    );
  } finally {
    ws.cleanup();
    db.close();
  }
});
