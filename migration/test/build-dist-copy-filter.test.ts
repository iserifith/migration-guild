import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const buildDistPath = path.join(repoRoot, "scripts", "build-dist.mjs");

// #300: build-dist.mjs now delegates copyFilteredDirectory's recursive
// traversal to fs.cp (recursive, source-root-relative filter) instead of a
// hand-rolled readdir walk. These tests pin the packaging policy and the copy
// behavior the five assembleTarball() call sites depend on: nested exclusions,
// included assets, empty directories, missing-source failures, and the
// explicit symlink policy.
//
// The module is exercised through a tiny per-call ESM child process rather
// than an in-process import: tsx compiles .ts tests to CJS, so importing the
// ESM-only build script in-process is not possible here, and functions cannot
// cross a process boundary. The child imports build-dist.mjs (its
// main-module guard keeps that side-effect free), runs ONE function call with
// JSON.stringify-able arguments, and prints the JSON result. Relative paths
// the functions compute internally still resolve against the child's cwd, so
// the test passes absolute paths everywhere.
function runInBuildDistModule(call: { fn: "shouldCopyPackageEntry" | "copyFilteredDirectory"; args: unknown[] }): unknown {
  const script =
    `const mod = await import(${JSON.stringify(buildDistPath)});` +
    `const result = await mod[${JSON.stringify(call.fn)}](...${JSON.stringify(call.args)});` +
    "console.log(result === undefined ? \"undefined\" : JSON.stringify(result));";
  try {
    const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (stdout.trim() === "undefined") {
      return undefined;
    }
    return JSON.parse(stdout) as unknown;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    // Surface the child's error to the test assertion machinery: rethrow a
    // tagged error the callers can match on (it carries the child's stderr).
    const failure = new Error(`build-dist.mjs child call ${call.fn} failed: ${e.stderr ?? e.message}`) as Error & { childFailed?: true };
    failure.childFailed = true;
    throw failure;
  }
}

function callShouldCopyPackageEntry(relativePath: string, isDirectory: boolean): boolean {
  return runInBuildDistModule({ fn: "shouldCopyPackageEntry", args: [relativePath, isDirectory] }) as boolean;
}

async function callCopyFilteredDirectory(sourceDir: string, destinationDir: string, rootDir?: string): Promise<void> {
  const args = rootDir === undefined ? [sourceDir, destinationDir] : [sourceDir, destinationDir, rootDir];
  await runInBuildDistModule({ fn: "copyFilteredDirectory", args });
}

async function expectChildRejectsWithCode(run: () => Promise<void>, code: string): Promise<void> {
  await assert.rejects(
    run(),
    (error: Error & { childFailed?: boolean; message?: string }) => error.childFailed === true && (error.message ?? "").includes(code),
    `expected the child call to fail with ${code}`,
  );
}

function writeTree(root: string, files: Array<[string, string]>): void {
  for (const [rel, content] of files) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function assertShipped(dest: string, rel: string, content?: string): void {
  const abs = path.join(dest, rel);
  assert.ok(fs.existsSync(abs), `expected ${rel} in destination`);
  if (content !== undefined) {
    assert.equal(fs.readFileSync(abs, "utf8"), content, `content mismatch for ${rel}`);
  }
}

function assertNotShipped(dest: string, rel: string): void {
  assert.equal(fs.existsSync(path.join(dest, rel)), false, `${rel} must not ship`);
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("#300: shouldCopyPackageEntry policy — root-relative exclusions and .ts file-vs-directory", () => {
  // The copy root itself always ships.
  assert.equal(callShouldCopyPackageEntry("", true), true);

  // Included assets at any depth.
  assert.equal(callShouldCopyPackageEntry("agents/plan.md", false), true);
  assert.equal(callShouldCopyPackageEntry("skills/deep/SKILL.md", true), true);
  assert.equal(callShouldCopyPackageEntry("styles/main.ts.map", false), true, ".ts.map files ship");

  // node_modules is excluded at every depth, as file or directory entry.
  assert.equal(callShouldCopyPackageEntry("node_modules/pkg/index.js", false), false);
  assert.equal(callShouldCopyPackageEntry("agents/node_modules/left-pad/index.js", false), false);
  assert.equal(callShouldCopyPackageEntry("deep/nested/node_modules", true), false);

  // .env is excluded as file or directory.
  assert.equal(callShouldCopyPackageEntry("instructions/.env", false), false);
  assert.equal(callShouldCopyPackageEntry("instructions/.env", true), false);

  // legacy/modern/migration are excluded at the TOP level of the copy root
  // only — the same names nested deeper ship.
  assert.equal(callShouldCopyPackageEntry("legacy/a.txt", true), false);
  assert.equal(callShouldCopyPackageEntry("modern/a.txt", false), false);
  assert.equal(callShouldCopyPackageEntry("migration/a.txt", true), false);
  assert.equal(callShouldCopyPackageEntry("nested/legacy/a.txt", true), true);

  // Raw .ts files do not ship; a DIRECTORY named *.ts does (the policy
  // distinguishes directory from file for the .ts exclusion).
  assert.equal(callShouldCopyPackageEntry("skills/bundle.ts", false), false);
  assert.equal(callShouldCopyPackageEntry("deep/nested/module.ts", false), false);
  assert.equal(callShouldCopyPackageEntry("widget.ts", true), true);
});

test("#300: copyFilteredDirectory keeps nested exclusions, included assets, and empty directories", async () => {
  const tmp = makeTempDir("mg-cpfilter-");
  try {
    const src = path.join(tmp, "src");
    writeTree(src, [
      ["README.md", "readme"],
      ["assets/logo.svg", "<svg/>"],
      ["agents/plan.md", "plan"],
      ["agents/node_modules/left-pad/index.js", "junk"],
      ["deep/keep.txt", "deep-keep"],
      ["deep/nested/node_modules/pkg/index.js", "junk"],
      ["legacy/inner/keep.txt", "junk"],
      ["instructions/.env", "SECRET=1"],
      ["instructions/env.md", "env-doc"],
      ["styles/main.ts", "raw-source"],
      ["styles/main.ts.map", "map"],
      ["widget.ts/README.txt", "dir-ts"],
    ]);
    // Included empty directories must survive the copy.
    for (const dir of ["empty", "deep/empty-too"]) {
      fs.mkdirSync(path.join(src, dir), { recursive: true });
    }

    const dest = path.join(tmp, "dest");
    await callCopyFilteredDirectory(src, dest);

    // Included assets survive with identical content.
    assertShipped(dest, "README.md", "readme");
    assertShipped(dest, "assets/logo.svg", "<svg/>");
    assertShipped(dest, "agents/plan.md", "plan");
    assertShipped(dest, "deep/keep.txt", "deep-keep");
    assertShipped(dest, "instructions/env.md", "env-doc");
    assertShipped(dest, "styles/main.ts.map", "map");
    assertShipped(dest, path.join("widget.ts", "README.txt"), "dir-ts");

    // Nested exclusions are skipped whole (fs.cp never descends into an
    // excluded directory, so no partial subtree leaks).
    assertNotShipped(dest, "agents/node_modules");
    assertNotShipped(dest, "deep/nested/node_modules");
    assertNotShipped(dest, "legacy");
    assertNotShipped(dest, "instructions/.env");
    assertNotShipped(dest, "styles/main.ts");

    // Empty included directories still exist in the destination.
    for (const dir of ["empty", path.join("deep", "empty-too")]) {
      const abs = path.join(dest, dir);
      assert.ok(fs.existsSync(abs) && fs.statSync(abs).isDirectory(), `empty directory ${dir} must ship`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("#300: copyFilteredDirectory fails on a missing source (ENOENT propagates like the manual walk)", async () => {
  const tmp = makeTempDir("mg-cpfilter-missing-");
  try {
    // Same failure semantics as the manual walk: the destination directory is
    // created up front, then the missing source surfaces as a propagating
    // ENOENT that must fail the whole build.
    await expectChildRejectsWithCode(
      () => callCopyFilteredDirectory(path.join(tmp, "absent"), path.join(tmp, "dest")),
      "ENOENT",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("#300: explicit rootDir keeps policy evaluation source-root-relative (preserved third parameter)", async () => {
  const tmp = makeTempDir("mg-cpfilter-root-");
  try {
    const root = path.join(tmp, "root");
    const src = path.join(root, "sub");
    writeTree(src, [
      ["keep.txt", "sub-keep"],
      ["node_modules/pkg.js", "junk"],
      ["legacy/inner.txt", "sub-legacy"],
    ]);

    const dest = path.join(tmp, "dest");
    await callCopyFilteredDirectory(src, dest, root);

    // Entries are evaluated relative to `root`: "sub/node_modules" is an
    // excluded subtree, "sub/legacy" is a nested legacy dir that ships, and
    // the destination receives src's contents (no "sub" prefix level).
    assertShipped(dest, "keep.txt", "sub-keep");
    assertShipped(dest, path.join("legacy", "inner.txt"), "sub-legacy");
    assertNotShipped(dest, "node_modules");
    assertNotShipped(dest, "sub");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

if (process.platform !== "win32") {
  test("#300: symlink policy — file links dereference to content (fs.copyFile parity), dir links expand filtered", async () => {
    const tmp = makeTempDir("mg-cpfilter-symlink-");
    try {
      const src = path.join(tmp, "src");
      writeTree(src, [
        ["assets/logo.svg", "<svg-logo/>"],
        ["real.txt", "REAL"],
        // A .ts-named file behind a symlink target still does not ship.
        ["assets/module.ts", "raw-source"],
      ]);
      fs.symlinkSync(path.join(src, "real.txt"), path.join(src, "link-file.txt"));
      fs.symlinkSync(path.join(src, "assets"), path.join(src, "link-dir"));

      const dest = path.join(tmp, "dest");
      await callCopyFilteredDirectory(src, dest);

      // dereference: true — file symlinks ship as regular files holding the
      // target's content, exactly what the old fs.copyFile walk produced.
      const linked = fs.lstatSync(path.join(dest, "link-file.txt"));
      assert.ok(!linked.isSymbolicLink() && linked.isFile(), "file symlink must dereference to a regular file");
      assert.equal(fs.readFileSync(path.join(dest, "link-file.txt"), "utf8"), "REAL");

      // A symlink-to-directory expands to a filtered copy of its target
      // (relative to the copy root — the packaging policy still applies),
      // where the old walk hard-failed with EISDIR.
      assertShipped(dest, path.join("link-dir", "logo.svg"), "<svg-logo/>");
      assertNotShipped(dest, path.join("link-dir", "module.ts"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("#300: symlink policy — broken symlinks fail the copy (ENOENT, fail-closed)", async () => {
    const tmp = makeTempDir("mg-cpfilter-broken-");
    try {
      const src = path.join(tmp, "src");
      writeTree(src, [["real.txt", "REAL"]]);
      fs.symlinkSync(path.join(src, "missing.txt"), path.join(src, "link-broken.txt"));

      await expectChildRejectsWithCode(
        () => callCopyFilteredDirectory(src, path.join(tmp, "dest")),
        "ENOENT",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}
