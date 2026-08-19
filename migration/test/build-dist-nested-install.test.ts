import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

// Stage a temp kit root like build-dist-docs-skip.test.ts does, but with a
// knob to omit migration/node_modules and migration/ui/node_modules — the
// fresh-clone-with-only-root-install shape US2/#148 must support (FR-004):
// build-dist.mjs's main() has to perform the nested installs itself.
function stageKitRoot(withNestedInstalls: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mg-nested-"));
  const copy = (rel: string) => {
    fs.cpSync(path.join(repoRoot, rel), path.join(root, rel), {
      recursive: true,
      filter: (src) => !src.includes("node_modules"),
    });
  };

  for (const f of ["README.md", "GETTING-STARTED.md", "AGENTS.md", ".env.example", "package.json", "setup.ts", "tsconfig.json"]) {
    if (fs.existsSync(path.join(repoRoot, f))) {
      fs.copyFileSync(path.join(repoRoot, f), path.join(root, f));
    }
  }
  copy("package");
  copy("migration");
  copy("stacks");
  copy("scripts");

  // FR-004's fresh-clone shape: the ROOT node_modules is present (so npm/npx
  // resolve), but the nested migration/ and migration/ui/ installs are absent.
  if (withNestedInstalls) {
    for (const rel of [path.join("migration", "node_modules"), path.join("migration", "ui", "node_modules")]) {
      const src = path.join(repoRoot, rel);
      if (fs.existsSync(src)) {
        fs.cpSync(src, path.join(root, rel), { recursive: true });
      }
    }
  }
  const rootNodeModules = path.join(repoRoot, "node_modules");
  if (fs.existsSync(rootNodeModules)) {
    fs.cpSync(rootNodeModules, path.join(root, "node_modules"), { recursive: true });
  }

  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "dist", "setup.js"), path.join(root, "dist", "setup.js"));

  return root;
}

function runBuildDist(kitRoot: string): { status: number; output: string; tarball: string } {
  let output = "";
  let status = 0;
  const tarball = path.join(kitRoot, "dist", "migration-guild-kit.tar.gz");
  try {
    output = execFileSync(
      process.execPath,
      ["--import", "tsx", path.join(kitRoot, "scripts", "build-dist.mjs")],
      {
        cwd: kitRoot,
        encoding: "utf8",
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (err) {
    status = (err as { status?: number }).status ?? 1;
    output = ((err as { stdout?: string }).stdout ?? "") + ((err as { stderr?: string }).stderr ?? "");
  }
  return { status, output, tarball };
}

function extractTarball(tarballPath: string, destDir: string): string {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarballPath], { cwd: destDir, stdio: "ignore" });
  return path.join(destDir, "migration-guild-kit-build");
}

test("US2: build:dist works on a fresh clone with only the root npm install run (FR-004)", { timeout: 600_000 }, () => {
  const kitRoot = stageKitRoot(false);
  try {
    assert.equal(fs.existsSync(path.join(kitRoot, "migration", "node_modules")), false, "staged kit must omit migration/node_modules");
    assert.equal(fs.existsSync(path.join(kitRoot, "migration", "ui", "node_modules")), false, "staged kit must omit migration/ui/node_modules");
    assert.equal(fs.existsSync(path.join(kitRoot, "node_modules")), true, "staged kit must keep the root node_modules");

    const { status, output, tarball } = runBuildDist(kitRoot);
    assert.equal(status, 0, `expected exit 0 from the stripped kit (FR-004), got ${status}\n${output}`);
    assert.ok(fs.existsSync(tarball), "tarball not produced from the stripped kit");
  } finally {
    fs.rmSync(kitRoot, { recursive: true, force: true });
  }
});

test("US2: the nested install really ran — dotenv lands in the staged kit, not a stale artifact (FR-004)", { timeout: 600_000 }, () => {
  const kitRoot = stageKitRoot(false);
  try {
    const { status, output } = runBuildDist(kitRoot);
    assert.equal(status, 0, `expected exit 0, got ${status}\n${output}`);
    // A tarball alone could have been produced from stale dist/ artifacts in
    // the staged tree; a leaf dependency in the freshly installed
    // migration/node_modules proves the install genuinely ran in place.
    assert.ok(
      fs.existsSync(path.join(kitRoot, "migration", "node_modules", "dotenv")),
      "migration/node_modules/dotenv must exist after build:dist performs the nested install",
    );
  } finally {
    fs.rmSync(kitRoot, { recursive: true, force: true });
  }
});

test("US2: already-installed clone keeps the same tarball shape (FR-004 no-behavior-change regression)", { timeout: 600_000 }, () => {
  const kitRoot = stageKitRoot(true);
  try {
    const { status, output, tarball } = runBuildDist(kitRoot);
    assert.equal(status, 0, `expected exit 0, got ${status}\n${output}`);
    const kitBuild = extractTarball(tarball, path.join(kitRoot, ".extract"));
    const top = fs.readdirSync(kitBuild).sort();
    assert.deepEqual(
      top,
      ["AGENTS.md", "GETTING-STARTED.md", "README.md", "migration", "package", "setup.js", "stacks"].sort(),
      "tarball top-level shape must be unchanged by the nested-install step (docs/ excluded by this staging)",
    );
    // US1's three additions (T003) are the only new migration/ entries.
    for (const rel of ["package.json", "package-lock.json", "registry_schema.sql", "registry", "guildctl", "ui-dist"]) {
      assert.ok(fs.existsSync(path.join(kitBuild, "migration", rel)), `expected migration/${rel} in the tarball`);
    }
    // The package/ tree must still be filtered (no .ts sources, no node_modules).
    assert.equal(fs.existsSync(path.join(kitBuild, "package", "node_modules")), false, "package/node_modules must not ship");
  } finally {
    fs.rmSync(kitRoot, { recursive: true, force: true });
  }
});

test("US2: DEVELOPMENT.md 'Build the repo' states all three install locations up front (FR-005)", () => {
  const text = fs.readFileSync(path.join(repoRoot, "DEVELOPMENT.md"), "utf8");
  const start = text.indexOf("### 5. Build the repo");
  assert.ok(start >= 0, "DEVELOPMENT.md must have a '### 5. Build the repo' section");
  const next = text.indexOf("\n### ", start + 1);
  const section = text.slice(start, next === -1 ? undefined : next);
  assert.match(section, /migration\//, "'Build the repo' must mention the migration/ install location");
  assert.match(section, /migration\/ui/, "'Build the repo' must mention the migration/ui/ install location");
  assert.match(section, /npm install/, "'Build the repo' must mention npm install steps");
});
