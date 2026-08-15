import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  confirmDisposition,
  dispositionContextForArtifact,
  upsertProposedDisposition,
} from "../registry/commands/dispositions";
import { codePromptForArtifact } from "../guildctl/commands/migrate";
import { registerArtifact } from "../registry/commands/artifacts";
import { replaceDependencyFindings } from "../registry/commands/modernization";
import { applySchema } from "../registry/db/schema";

/**
 * T025 — dispositionContextForArtifact + migrate.ts codePrompt wiring for
 * specs/006-dependency-disposition (US3, FR-010, quickstart Scenario 6).
 *
 * codePromptForArtifact is the per-artifact prompt builder used by the
 * code-writer pool (migrate.ts): with no artifact id it returns the base
 * prompt unchanged; with one it appends the disposition suffix when non-null.
 */

const ARTIFACT_ID = "legacy-source:com.acme.customer:CustomerService";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  registerArtifact(db, {
    id: ARTIFACT_ID,
    kind: "legacy-source",
    path: "legacy/src/main/java/com/acme/customer/CustomerService.java",
    tier: "first-class",
  });
  return db;
}

function confirmLibrary(
  db: Database.Database,
  opts: {
    libraryName: string;
    disposition: "keep" | "replace-with-native" | "inline";
    nativeReplacement?: string;
    inlineNote?: string;
    lockedTargetVersion?: string;
    usageJson?: string;
  },
): void {
  upsertProposedDisposition(db, {
    libraryName: opts.libraryName,
    disposition: opts.disposition,
    nativeReplacement: opts.nativeReplacement,
    inlineNote: opts.inlineNote,
    lockedTargetVersion: opts.lockedTargetVersion,
    rationale: "seeded for context test",
    usageJson: opts.usageJson,
    proposedBy: "planner-collector",
  });
  confirmDisposition(db, { libraryName: opts.libraryName, confirmedBy: "operator" });
}

test("confirmed replace-with-native on a library used by the artifact (usage_json match) names the native target", () => {
  const db = createDb();
  try {
    confirmLibrary(db, {
      libraryName: "joda-time:joda-time",
      disposition: "replace-with-native",
      nativeReplacement: "java.time",
      usageJson: JSON.stringify({ using_artifacts: [ARTIFACT_ID] }),
    });
    const context = dispositionContextForArtifact(db, ARTIFACT_ID);
    assert.ok(context != null, "context must be present for a pruned library in use");
    assert.match(context!, /joda-time:joda-time/, "names the library");
    assert.match(context!, /java\.time/, "names the native replacement");
    assert.match(context!, /do not re-declare/i, "instructs the code writer not to re-declare");
  } finally {
    db.close();
  }
});

test("confirmed inline disposition surfaces the inline note", () => {
  const db = createDb();
  try {
    confirmLibrary(db, {
      libraryName: "com.google.code.gson:gson",
      disposition: "inline",
      inlineNote: "Only JsonParser.parseString used; inline the two call sites",
      usageJson: JSON.stringify({ using_artifacts: [ARTIFACT_ID] }),
    });
    const context = dispositionContextForArtifact(db, ARTIFACT_ID);
    assert.ok(context != null);
    assert.match(context!, /com\.google\.code\.gson:gson/);
    assert.match(context!, /Only JsonParser\.parseString used/);
  } finally {
    db.close();
  }
});

test("falls back to dependency_findings dependency_name match when usage_json does not list the artifact", () => {
  const db = createDb();
  try {
    // usage_json does NOT list the artifact — the fallback join on
    // dependency_findings.dependency_name must still surface the disposition.
    confirmLibrary(db, {
      libraryName: "joda-time:joda-time",
      disposition: "replace-with-native",
      nativeReplacement: "java.time",
      usageJson: JSON.stringify({ using_artifacts: [] }),
    });
    replaceDependencyFindings(db, ARTIFACT_ID, [{
      dependency_name: "joda-time:joda-time",
      current_version: "2.10.14",
      category: "outdated",
      severity: "warning",
      summary: "Joda-Time is in maintenance mode",
      remediation: "Migrate to java.time",
    }]);
    const context = dispositionContextForArtifact(db, ARTIFACT_ID);
    assert.ok(context != null, "findings fallback must surface the disposition");
    assert.match(context!, /joda-time:joda-time/);
    assert.match(context!, /java\.time/);
  } finally {
    db.close();
  }
});

test("returns null when the artifact only uses keep libraries", () => {
  const db = createDb();
  try {
    confirmLibrary(db, {
      libraryName: "com.fasterxml.jackson.core:jackson-databind",
      disposition: "keep",
      lockedTargetVersion: "2.17.2",
      usageJson: JSON.stringify({ using_artifacts: [ARTIFACT_ID] }),
    });
    assert.equal(dispositionContextForArtifact(db, ARTIFACT_ID), null);
  } finally {
    db.close();
  }
});

test("returns null for merely-proposed (unconfirmed) non-keep dispositions", () => {
  const db = createDb();
  try {
    upsertProposedDisposition(db, {
      libraryName: "joda-time:joda-time",
      disposition: "replace-with-native",
      nativeReplacement: "java.time",
      rationale: "proposed only — not yet confirmed",
      usageJson: JSON.stringify({ using_artifacts: [ARTIFACT_ID] }),
      proposedBy: "planner-collector",
    });
    assert.equal(dispositionContextForArtifact(db, ARTIFACT_ID), null);
  } finally {
    db.close();
  }
});

test("returns null for an artifact with no matching libraries", () => {
  const db = createDb();
  try {
    confirmLibrary(db, {
      libraryName: "joda-time:joda-time",
      disposition: "replace-with-native",
      nativeReplacement: "java.time",
      usageJson: JSON.stringify({ using_artifacts: ["legacy-source:com.acme.other:OtherService"] }),
    });
    assert.equal(dispositionContextForArtifact(db, ARTIFACT_ID), null);
  } finally {
    db.close();
  }
});

test("migrate.ts codePromptForArtifact appends the disposition suffix (when non-null) to the code-writer prompt", () => {
  const db = createDb();
  try {
    const base = "Write production code for next tests-written task";

    // No artifact id (pool-level fallback) → base prompt unchanged.
    assert.equal(codePromptForArtifact(db, base), base);

    // Artifact with only keep libraries → no suffix appended.
    confirmLibrary(db, {
      libraryName: "com.fasterxml.jackson.core:jackson-databind",
      disposition: "keep",
      lockedTargetVersion: "2.17.2",
      usageJson: JSON.stringify({ using_artifacts: [ARTIFACT_ID] }),
    });
    assert.equal(codePromptForArtifact(db, base, ARTIFACT_ID), base);

    // Artifact using a pruned library → prompt carries the guidance.
    confirmLibrary(db, {
      libraryName: "joda-time:joda-time",
      disposition: "replace-with-native",
      nativeReplacement: "java.time",
      usageJson: JSON.stringify({ using_artifacts: [ARTIFACT_ID] }),
    });
    const prompt = codePromptForArtifact(db, base, ARTIFACT_ID);
    assert.ok(prompt.startsWith(base), "base prompt preserved as prefix");
    assert.match(prompt, /joda-time:joda-time/);
    assert.match(prompt, /java\.time/);
  } finally {
    db.close();
  }
});
