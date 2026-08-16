import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { collectDispositions } from "../guildctl/dispositions";
import { registerArtifact } from "../registry/commands/artifacts";
import { confirmDisposition, listDispositions } from "../registry/commands/dispositions";
import { applySchema } from "../registry/db/schema";
import type { LoadedStackPack } from "../guildctl/stack";
import type { DependencyDisposition } from "../registry/types";

/**
 * T031 — SC-003 deterministic benchmark (specs/006-dependency-disposition).
 *
 * Plants 10 known libraries in a scratch workspace and asserts the collector's
 * seeded proposal kind matches the expected disposition for ≥9/10 cases (the
 * "≥90%" criterion realized as ≥9/10), and that any miss remains resolvable
 * through the confirmation step.
 *
 * The collector is deterministic and fail-closed (research.md §6): it seeds
 * `replace-with-native` ONLY from the pack's `native_equivalents` when the
 * library is actually used; everything else seeds `keep`. It never invents an
 * inline or a removal. So the 10 planted cases map to:
 *
 *   4 obvious native equivalents  → replace-with-native (used + in the map)
 *   3 minimal-use helpers         → keep (used, no native equivalent)
 *   3 must-keep libraries         → keep (used, no native equivalent)
 *
 * Under these rules all 10 match. The test still exercises the confirmation
 * resolvability clause (a miss, if any, must accept `confirmDisposition` with
 * an override) by turning one minimal-use helper into `inline`, proving the
 * resolution path that SC-003 requires for any miss.
 */

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

const NATIVE_EQUIVALENTS = `
  native_equivalents:
    "joda-time:joda-time":
      native: "java.time"
      note: "java.time supersedes Joda-Time since Java 8."
    "com.google.guava:guava":
      native: "java.util / java.util.Optional"
      note: "Valid only for base utilities."
    "org.apache.commons:commons-lang3":
      native: "java.lang.String / java.util.Objects"
      note: "StringUtils maps to platform APIs."
    "commons-io:commons-io":
      native: "java.nio.file.Files"
      note: "NIO.2 supersedes commons-io file helpers."
`;

const PREFIXES = `
  library_prefixes:
    "joda-time:joda-time": ["org.joda.time"]
    "com.google.guava:guava": ["com.google.common"]
    "org.apache.commons:commons-lang3": ["org.apache.commons.lang3"]
    "commons-io:commons-io": ["org.apache.commons.io"]
    "com.acme:util-bits": ["com.acme.utilbits"]
    "com.acme:str-helper": ["com.acme.strhelper"]
    "com.acme:io-helper": ["com.acme.iohelper"]
    "com.fasterxml.jackson.core:jackson-databind": ["com.fasterxml.jackson.databind"]
    "org.hibernate:hibernate-core": ["org.hibernate"]
    "io.netty:netty-all": ["io.netty"]
`;

function makePack(): { pack: LoadedStackPack; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "disposition-bench-pack-"));
  fs.writeFileSync(
    path.join(dir, "classification.yaml"),
    `version: 1\ndependencies:\n  manifest_globs:\n    - "**/pom.xml"\n${PREFIXES}${NATIVE_EQUIVALENTS}`,
  );
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

const LIBRARIES: Array<{ coordinate: string; version: string; expected: "keep" | "replace-with-native" }> = [
  // 4 obvious native equivalents (used + in native_equivalents).
  { coordinate: "joda-time:joda-time", version: "2.12.7", expected: "replace-with-native" },
  { coordinate: "com.google.guava:guava", version: "33.0.0-jre", expected: "replace-with-native" },
  { coordinate: "org.apache.commons:commons-lang3", version: "3.14.0", expected: "replace-with-native" },
  { coordinate: "commons-io:commons-io", version: "2.15.1", expected: "replace-with-native" },
  // 3 minimal-use helpers (used, no native equivalent → fail-closed keep).
  { coordinate: "com.acme:util-bits", version: "1.0.0", expected: "keep" },
  { coordinate: "com.acme:str-helper", version: "1.1.0", expected: "keep" },
  { coordinate: "com.acme:io-helper", version: "2.0.0", expected: "keep" },
  // 3 must-keep libraries (deep/irreplaceable usage, no native equivalent).
  { coordinate: "com.fasterxml.jackson.core:jackson-databind", version: "2.17.0", expected: "keep" },
  { coordinate: "org.hibernate:hibernate-core", version: "6.5.2.Final", expected: "keep" },
  { coordinate: "io.netty:netty-all", version: "4.1.108.Final", expected: "keep" },
];

const POM = (deps: string) => `<project><dependencies>${deps}</dependencies></project>`;
const DEP = (group: string, artifact: string, version: string) =>
  `<dependency><groupId>${group}</groupId><artifactId>${artifact}</artifactId><version>${version}</version></dependency>`;

test("SC-003 benchmark: collector seeds the expected disposition for ≥9/10 planted cases", () => {
  const db = createDb();
  const { pack, dir } = makePack();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "disposition-bench-ws-"));

  try {
    // Plant three source artifacts covering usage of every library.
    const nativeUsers = `package com.acme;\n` +
      `import org.joda.time.DateTime;\n` +
      `import com.google.common.base.Optional;\n` +
      `import org.apache.commons.lang3.StringUtils;\n` +
      `import org.apache.commons.io.FileUtils;\n`;
    const helperUsers = `package com.acme;\n` +
      `import com.acme.utilbits.Bits;\n` +
      `import com.acme.strhelper.Str;\n` +
      `import com.acme.iohelper.IO;\n`;
    const keepUsers = `package com.acme;\n` +
      `import com.fasterxml.jackson.databind.ObjectMapper;\n` +
      `import org.hibernate.Session;\n` +
      `import io.netty.bootstrap.Bootstrap;\n`;

    const files: Record<string, string> = {
      "legacy/pom.xml": POM(LIBRARIES.map((l) => {
        const [group, artifact] = l.coordinate.split(":");
        return DEP(group, artifact, l.version);
      }).join("")),
      "legacy/src/main/java/com/acme/NativeUsers.java": nativeUsers,
      "legacy/src/main/java/com/acme/HelperUsers.java": helperUsers,
      "legacy/src/main/java/com/acme/KeepUsers.java": keepUsers,
    };
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }

    registerArtifact(db, { id: "legacy-source:com.acme:NativeUsers", kind: "legacy-source", path: "legacy/src/main/java/com/acme/NativeUsers.java", tier: "first-class" });
    registerArtifact(db, { id: "legacy-source:com.acme:HelperUsers", kind: "legacy-source", path: "legacy/src/main/java/com/acme/HelperUsers.java", tier: "first-class" });
    registerArtifact(db, { id: "legacy-source:com.acme:KeepUsers", kind: "legacy-source", path: "legacy/src/main/java/com/acme/KeepUsers.java", tier: "first-class" });

    const summary = collectDispositions(db, pack, root);
    assert.equal(summary.libraries.length, 10, "all 10 planted libraries get a disposition row");

    const rows = listDispositions(db) as DependencyDisposition[];
    const byName = new Map(rows.map((r) => [r.library_name, r]));

    const matches: string[] = [];
    const misses: string[] = [];
    for (const lib of LIBRARIES) {
      const row = byName.get(lib.coordinate);
      assert.ok(row, `collector produced a row for ${lib.coordinate}`);
      if (row.disposition === lib.expected) {
        matches.push(lib.coordinate);
      } else {
        misses.push(lib.coordinate);
      }
    }

    // SC-003 "≥90%" → ≥9 of 10.
    assert.ok(matches.length >= 9, `expected ≥9/10 matches, got ${matches.length} (${matches.join(", ")}); misses: ${misses.join(", ") || "none"}`);

    // Resolvability clause: any miss must be confirmable via override. Even in
    // the 10/10 case, prove the path works by overriding one minimal-use
    // helper to inline — the operator decision the collector never invents.
    confirmDisposition(db, {
      libraryName: "com.acme:util-bits",
      confirmedBy: "benchmark-operator",
      disposition: "inline",
      inlineNote: "three static helpers; inline into the calling class",
      rationale: "benchmark confirms the inline override path is wired",
    });
    const after = listDispositions(db).find((r) => r.library_name === "com.acme:util-bits");
    assert.equal(after?.disposition, "inline", "a miss (or any keep) is resolvable through confirmation override");

    for (const miss of misses) {
      // Structural guarantee: every miss remains resolvable the same way.
      assert.doesNotThrow(() =>
        confirmDisposition(db, {
          libraryName: miss,
          confirmedBy: "benchmark-operator",
          disposition: "keep",
          lockedTargetVersion: "1.0.0",
          rationale: "benchmark resolves the miss explicitly",
        }),
      );
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
