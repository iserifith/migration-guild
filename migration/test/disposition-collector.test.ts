import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { collectDispositions } from "../guildctl/dispositions";
import { registerArtifact } from "../registry/commands/artifacts";
import { replaceDependencyFindings } from "../registry/commands/modernization";
import { applySchema } from "../registry/db/schema";
import type { LoadedStackPack } from "../guildctl/stack";

/**
 * T006 — collector coverage for
 * specs/006-dependency-disposition (FR-004, FR-008, FR-012, edge cases #1/#2).
 */

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

const PACK_BLOCK = `
dependencies:
  manifest_globs:
    - "**/pom.xml"
  library_prefixes:
    "org.apache.commons:commons-lang3": ["org.apache.commons.lang3"]
    "joda-time:joda-time": ["org.joda.time"]
    "com.acme:legacy-helper": ["com.acme.helper"]
    "com.acme:declared-unused": ["com.acme.unused"]
  native_equivalents:
    "joda-time:joda-time":
      native: "java.time"
      note: "java.time supersedes Joda-Time since Java 8; JSR-310 is the platform API."
`;

function makePack(dependenciesBlock = PACK_BLOCK): { pack: LoadedStackPack; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "disposition-pack-"));
  fs.writeFileSync(path.join(dir, "classification.yaml"), `version: 1\n${dependenciesBlock}`);
  return {
    pack: {
      dir,
      manifest: {
        id: "test-pack",
        classification_spec: "classification.yaml",
        dependency_parsers: [
          {
            match: "pom.xml",
            pattern: '<dependency>\\s*<groupId>([^<]+)</groupId>\\s*<artifactId>([^<]+)</artifactId>(?:\\s*<version>([^<]+)</version>)?',
            flags: "gms",
          },
        ],
      } as unknown as LoadedStackPack["manifest"],
      rules: [],
    },
    dir,
  };
}

function makeWorkspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "disposition-ws-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

function seedArtifact(db: Database.Database, id: string, relPath: string): void {
  registerArtifact(db, { id, kind: "legacy-source", path: relPath, tier: "first-class" });
}

function seedFinding(db: Database.Database, artifactId: string, name: string, version: string | null): void {
  replaceDependencyFindings(db, artifactId, [{
    dependency_name: name,
    current_version: version,
    target_hint: null,
    category: "outdated",
    severity: "warning",
    summary: `${name} usage detected`,
    remediation: "review",
  }]);
}

function rows(db: Database.Database) {
  return db.prepare("SELECT * FROM dependency_dispositions ORDER BY library_name ASC").all() as Array<Record<string, unknown>>;
}

function withAll<T>(fn: (ctx: { db: Database.Database; pack: LoadedStackPack; root: string; cleanup: () => void }) => T): T {
  const db = createDb();
  const { pack, dir } = makePack();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "disposition-ws-"));
  const cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    return fn({ db, pack, root, cleanup });
  } finally {
    cleanup();
  }
}

const POM = (deps: string) => `<project><dependencies>${deps}</dependencies></project>`;
const DEP = (group: string, artifact: string, version: string) =>
  `<dependency><groupId>${group}</groupId><artifactId>${artifact}</artifactId><version>${version}</version></dependency>`;

test("library universe = dependency_findings (MAX current_version) UNION manifest declarations", () => {
  withAll(({ db, pack, root }) => {
    seedArtifact(db, "legacy-source:com.acme:ServiceA", "legacy/src/main/java/com/acme/ServiceA.java");
    seedFinding(db, "legacy-source:com.acme:ServiceA", "org.apache.commons:commons-lang3", "3.11.0");
    seedFinding(db, "legacy-source:com.acme:ServiceA", "org.apache.commons:commons-lang3", "3.12.0");
    // A library with NO findings that only exists as a manifest declaration.
    fs.mkdirSync(path.join(root, "legacy"), { recursive: true });
    fs.writeFileSync(path.join(root, "legacy", "pom.xml"), POM(DEP("com.acme", "legacy-helper", "1.2.3")));

    const summary = collectDispositions(db, pack, root);

    assert.deepEqual(summary.libraries.sort(), ["com.acme:legacy-helper", "org.apache.commons:commons-lang3"]);
    const byName = new Map(rows(db).map((r) => [r.library_name as string, r]));
    assert.equal(byName.get("org.apache.commons:commons-lang3")?.current_version, "3.12.0", "MAX across findings");
    assert.equal(byName.get("com.acme:legacy-helper")?.current_version, "1.2.3");
  });
});

test("a declared-but-unused library still gets a keep row carrying a scan-limitation note (edge case #1)", () => {
  withAll(({ db, pack, root }) => {
    fs.mkdirSync(path.join(root, "legacy"), { recursive: true });
    fs.writeFileSync(path.join(root, "legacy", "pom.xml"), POM(DEP("com.acme", "declared-unused", "9.9.9")));
    // No artifact imports com.acme.unused.

    collectDispositions(db, pack, root);

    const row = rows(db).find((r) => r.library_name === "com.acme:declared-unused");
    assert.ok(row, "row exists for unused declaration");
    assert.equal(row.disposition, "keep", "dead declarations default to keep — never invented removals");
    const usage = JSON.parse(row.usage_json as string) as { using_artifact_count: number; scan_notes: string[] };
    assert.equal(usage.using_artifact_count, 0);
    assert.ok(usage.scan_notes.length > 0, "usage/scan-limitation note recorded");
    assert.match(row.rationale as string, /unused|no usage|not imported/i);
  });
});

test("an unparseable manifest produces a scan_notes limitation instead of failing the run (FR-012)", () => {
  withAll(({ db, pack, root }) => {
    fs.mkdirSync(path.join(root, "legacy"), { recursive: true });
    fs.writeFileSync(path.join(root, "legacy", "pom.xml"), POM(DEP("com.acme", "legacy-helper", "1.0.0")));
    // A second manifest the regex cannot extract any declarations from.
    fs.mkdirSync(path.join(root, "legacy", "broken"), { recursive: true });
    fs.writeFileSync(path.join(root, "legacy", "broken", "pom.xml"), "<project><dependencies>garbage-no-valid-deps</dependencies>");

    const summary = collectDispositions(db, pack, root);

    assert.deepEqual(summary.libraries, ["com.acme:legacy-helper"]);
    assert.ok(summary.scan_notes.some((note) => /no declarations|could not|unparseable|skipped/i.test(note)),
      `scan limitation recorded, got: ${JSON.stringify(summary.scan_notes)}`);
    const row = rows(db).find((r) => r.library_name === "com.acme:legacy-helper");
    const usage = JSON.parse(row!.usage_json as string) as { scan_notes: string[] };
    assert.ok(usage.scan_notes.length >= 0, "usage_json well-formed");
  });
});

test("a library in the pack's native_equivalents seeds a replace-with-native proposal", () => {
  withAll(({ db, pack, root }) => {
    fs.mkdirSync(path.join(root, "legacy"), { recursive: true });
    fs.writeFileSync(path.join(root, "legacy", "pom.xml"), POM(DEP("joda-time", "joda-time", "2.10.14")));
    fs.mkdirSync(path.join(root, "legacy", "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "legacy", "src", "DateSvc.java"), "import org.joda.time.DateTime;\nclass DateSvc {}");
    seedArtifact(db, "legacy-source:com.acme:DateSvc", "legacy/src/DateSvc.java");

    collectDispositions(db, pack, root);

    const row = rows(db).find((r) => r.library_name === "joda-time:joda-time");
    assert.ok(row);
    assert.equal(row.disposition, "replace-with-native");
    assert.equal(row.native_replacement, "java.time");
    assert.match(row.rationale as string, /java\.time supersedes Joda-Time/);
    assert.equal(row.status, "proposed");
    assert.equal(row.proposed_by, "planner-collector");
  });
});

test("a library with no pack mapping defaults to keep — never an invented replacement (edge case #2)", () => {
  withAll(({ db, pack, root }) => {
    fs.mkdirSync(path.join(root, "legacy"), { recursive: true });
    fs.writeFileSync(path.join(root, "legacy", "pom.xml"), POM(DEP("com.acme", "legacy-helper", "2.0.0")));

    collectDispositions(db, pack, root);

    const row = rows(db).find((r) => r.library_name === "com.acme:legacy-helper");
    assert.ok(row);
    assert.equal(row.disposition, "keep");
    assert.equal(row.native_replacement, null, "no invented native replacement");
    assert.equal(row.inline_note, null, "no invented inline note");
  });
});

test("conflicting manifest versions resolve to MAX with the conflict narrative in rationale (FR-008)", () => {
  withAll(({ db, pack, root }) => {
    fs.mkdirSync(path.join(root, "legacy", "mod-a"), { recursive: true });
    fs.writeFileSync(path.join(root, "legacy", "mod-a", "pom.xml"), POM(DEP("com.acme", "legacy-helper", "2.10.0")));
    fs.mkdirSync(path.join(root, "legacy", "mod-b"), { recursive: true });
    fs.writeFileSync(path.join(root, "legacy", "mod-b", "pom.xml"), POM(DEP("com.acme", "legacy-helper", "2.9.0")));

    collectDispositions(db, pack, root);

    const row = rows(db).find((r) => r.library_name === "com.acme:legacy-helper");
    assert.ok(row);
    assert.equal(row.current_version, "2.10.0", "MAX wins");
    assert.equal(row.locked_target_version, "2.10.0", "keep proposal locks the resolved MAX");
    assert.match(row.rationale as string, /conflict/i);
    assert.match(row.rationale as string, /2\.9\.0/);
  });
});

test("usage analysis counts importing artifacts in usage_json", () => {
  withAll(({ db, pack, root }) => {
    fs.mkdirSync(path.join(root, "legacy"), { recursive: true });
    fs.writeFileSync(path.join(root, "legacy", "pom.xml"), POM(DEP("org.apache.commons", "commons-lang3", "3.12.0")));
    fs.mkdirSync(path.join(root, "legacy", "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "legacy", "src", "A.java"), "import org.apache.commons.lang3.StringUtils;\nclass A {}");
    fs.writeFileSync(path.join(root, "legacy", "src", "B.java"), "import org.apache.commons.lang3.tuple.Pair;\nclass B {}");
    fs.writeFileSync(path.join(root, "legacy", "src", "C.java"), "class C {}");
    seedArtifact(db, "legacy-source:com.acme:A", "legacy/src/A.java");
    seedArtifact(db, "legacy-source:com.acme:B", "legacy/src/B.java");
    seedArtifact(db, "legacy-source:com.acme:C", "legacy/src/C.java");

    collectDispositions(db, pack, root);

    const row = rows(db).find((r) => r.library_name === "org.apache.commons:commons-lang3");
    const usage = JSON.parse(row!.usage_json as string) as {
      using_artifacts: string[];
      using_artifact_count: number;
      import_count: number;
    };
    assert.equal(usage.using_artifact_count, 2);
    assert.deepEqual(usage.using_artifacts.sort(), ["legacy-source:com.acme:A", "legacy-source:com.acme:B"]);
    assert.ok(usage.import_count >= 2);
  });
});
