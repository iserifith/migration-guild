import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadDispositionSpec } from "../guildctl/dispositions";
import type { LoadedStackPack } from "../guildctl/stack";

/**
 * T005 — stack-pack `dependencies:` block loader coverage for
 * specs/006-dependency-disposition/contracts/disposition-pack-yaml.md.
 *
 * Every test drives loadDispositionSpec against a scratch pack directory whose
 * classification.yaml is written per-case, so validation rules are exercised
 * against the real YAML parsing path (same `yaml` parse as
 * loadClassificationSpec).
 */

function makePack(classificationYaml: string, id = "test-pack"): LoadedStackPack {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "disposition-pack-"));
  fs.writeFileSync(path.join(dir, "classification.yaml"), classificationYaml);
  return {
    dir,
    manifest: { id, classification_spec: "classification.yaml" } as LoadedStackPack["manifest"],
    rules: [],
  };
}

const VALID_BLOCK = `
version: 1
frameworks: { allowed: [plain-java], fallback: plain-java, ambiguous: ambiguous }
roles: { allowed: [service] }
dependencies:
  manifest_globs:
    - "**/pom.xml"
    - "**/build.gradle"
  library_prefixes:
    "org.apache.commons:commons-lang3": ["org.apache.commons.lang3"]
    "joda-time:joda-time": ["org.joda.time"]
  native_equivalents:
    "joda-time:joda-time":
      native: "java.time"
      note: "java.time supersedes Joda-Time since Java 8"
`;

test("a valid dependencies: block parses into manifest_globs / library_prefixes / native_equivalents", () => {
  const pack = makePack(VALID_BLOCK);
  try {
    const { spec, warnings } = loadDispositionSpec(pack);
    assert.deepEqual(spec.manifest_globs, ["**/pom.xml", "**/build.gradle"]);
    assert.deepEqual(spec.library_prefixes["org.apache.commons:commons-lang3"], ["org.apache.commons.lang3"]);
    assert.equal(spec.native_equivalents["joda-time:joda-time"]?.native, "java.time");
    assert.equal(spec.native_equivalents["joda-time:joda-time"]?.note, "java.time supersedes Joda-Time since Java 8");
    assert.deepEqual(warnings, []);
  } finally {
    fs.rmSync(pack.dir, { recursive: true, force: true });
  }
});

test("an unknown top-level key inside dependencies: raises a load error naming the pack and key", () => {
  const pack = makePack(`${VALID_BLOCK}  bogus_key: true\n`, "strict-pack");
  try {
    assert.throws(
      () => loadDispositionSpec(pack),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /strict-pack/);
        assert.match(err.message, /bogus_key/);
        return true;
      },
    );
  } finally {
    fs.rmSync(pack.dir, { recursive: true, force: true });
  }
});

test("an empty-string manifest_globs entry errors", () => {
  const bad = VALID_BLOCK.replace('"**/build.gradle"\n', '"**/build.gradle"\n    - ""\n');
  const pack = makePack(bad);
  try {
    assert.throws(() => loadDispositionSpec(pack), /manifest_globs/i);
  } finally {
    fs.rmSync(pack.dir, { recursive: true, force: true });
  }
});

test("a non-string-array library_prefixes value errors", () => {
  const bad = VALID_BLOCK.replace('["org.apache.commons.lang3"]', '"org.apache.commons.lang3"');
  const pack = makePack(bad);
  try {
    assert.throws(() => loadDispositionSpec(pack), /library_prefixes/i);
  } finally {
    fs.rmSync(pack.dir, { recursive: true, force: true });
  }
});

test("a native_equivalents entry with an empty native errors", () => {
  const bad = VALID_BLOCK.replace('native: "java.time"', 'native: ""');
  const pack = makePack(bad);
  try {
    assert.throws(() => loadDispositionSpec(pack), /native/i);
  } finally {
    fs.rmSync(pack.dir, { recursive: true, force: true });
  }
});

test("a native_equivalents key absent from library_prefixes is a load-time WARNING, not an error", () => {
  const withOrphan = VALID_BLOCK.replace(
    'note: "java.time supersedes Joda-Time since Java 8"\n',
    `note: "java.time supersedes Joda-Time since Java 8"
    "com.google.guava:guava":
      native: "java.util"
      note: "base utilities only"
`,
  );
  const pack = makePack(withOrphan);
  try {
    const { spec, warnings } = loadDispositionSpec(pack);
    assert.ok(spec.native_equivalents["com.google.guava:guava"], "entry still loads");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /com\.google\.guava:guava/);
  } finally {
    fs.rmSync(pack.dir, { recursive: true, force: true });
  }
});

test("a pack with no dependencies: block loads with a degraded empty result", () => {
  const pack = makePack(`
version: 1
frameworks: { allowed: [plain-java], fallback: plain-java, ambiguous: ambiguous }
roles: { allowed: [service] }
`);
  try {
    const { spec, warnings } = loadDispositionSpec(pack);
    assert.deepEqual(spec.manifest_globs, []);
    assert.deepEqual(spec.library_prefixes, {});
    assert.deepEqual(spec.native_equivalents, {});
    assert.deepEqual(warnings, []);
  } finally {
    fs.rmSync(pack.dir, { recursive: true, force: true });
  }
});
