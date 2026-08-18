import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

// Copy a minimal, buildable kit root into a temp dir. We exclude large trees
// (node_modules, legacy, modern) and reproduce just what build-dist.mjs needs:
// README.md, GETTING-STARTED.md, AGENTS.md, .env.example, package/, migration/
// (with its own node_modules + migration/ui/node_modules so build-dist can
// rebuild registry/dist, guildctl/dist, and ui-dist for real), stacks/,
// docs/ (optional), and dist/setup.js.
function stageKitRoot(includeDocs: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mg-build-"));
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
  // migration/node_modules provides @types/node etc. needed when build-dist
  // self-rebuilds migration via tsup inside the temp kit.
  const migrationNodeModules = path.join(repoRoot, "migration", "node_modules");
  if (fs.existsSync(migrationNodeModules)) {
    fs.cpSync(migrationNodeModules, path.join(root, "migration", "node_modules"), { recursive: true });
  }
  // migration/ui/node_modules provides vite/tsc etc. needed when build-dist
  // self-rebuilds the Mission Control UI (`npm run build:ui`) inside the temp
  // kit (scripts/build-dist.mjs Step 3/4, US2/#123).
  const uiNodeModules = path.join(repoRoot, "migration", "ui", "node_modules");
  if (fs.existsSync(uiNodeModules)) {
    fs.cpSync(uiNodeModules, path.join(root, "migration", "ui", "node_modules"), { recursive: true });
  }
  if (includeDocs) {
    copy("docs");
  }

  // build-dist.mjs's main() shells out to `npx tsup` to (re)build the kit before
  // assembling the tarball; that needs the root node_modules present in the temp
  // kit. Copy it (node_modules is large but required for the subprocess build).
  const rootNodeModules = path.join(repoRoot, "node_modules");
  if (fs.existsSync(rootNodeModules)) {
    fs.cpSync(rootNodeModules, path.join(root, "node_modules"), { recursive: true });
  }

  // Ship dist/setup.js so runInstall() can resolve the kit root one level up.
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "dist", "setup.js"), path.join(root, "dist", "setup.js"));

  return root;
}

function runBuildDist(kitRoot: string): { status: number; output: string; tarball: string } {
  let output = "";
  let status = 0;
  // Run the TEMP KIT's own scripts/build-dist.mjs so its repoRoot resolves to the
  // staged kit (not the real repo root) — this makes the docs/ presence/absence
  // test deterministic regardless of the real repo's docs/ contents. The tarball
  // lands at kitRoot/dist/migration-guild-kit.tar.gz.
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

function extractTarball(tarballPath: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarballPath], { cwd: destDir, stdio: "ignore" });
}

test("US1: build-dist succeeds WITHOUT docs/ and skips it gracefully", () => {
  const kitRoot = stageKitRoot(false);
  try {
    assert.equal(fs.existsSync(path.join(kitRoot, "docs")), false);
    const { status, output, tarball } = runBuildDist(kitRoot);
    assert.equal(status, 0, `expected exit 0, got ${status}\n${output}`);
    assert.ok(fs.existsSync(tarball), "tarball not produced when docs/ absent");
    const extractDir = path.join(kitRoot, ".extract-nodocs");
    extractTarball(tarball, extractDir);
    assert.equal(
      fs.existsSync(path.join(extractDir, "migration-guild-kit-build", "docs")),
      false,
      "docs/ should NOT be in the tarball when absent at repo root",
    );
  } finally {
    fs.rmSync(kitRoot, { recursive: true, force: true });
    fs.rmSync(path.join(kitRoot, "dist", "migration-guild-kit.tar.gz"), { force: true });
  }
});

test("US1: build-dist includes docs/ when it IS present at repo root", () => {
  const kitRoot = stageKitRoot(true);
  try {
    assert.equal(fs.existsSync(path.join(kitRoot, "docs")), true);
    const { status, output, tarball } = runBuildDist(kitRoot);
    assert.equal(status, 0, `expected exit 0, got ${status}\n${output}`);
    assert.ok(fs.existsSync(tarball), "tarball not produced when docs/ present");
    const extractDir = path.join(kitRoot, ".extract-docs");
    extractTarball(tarball, extractDir);
    assert.equal(
      fs.existsSync(path.join(extractDir, "migration-guild-kit-build", "docs")),
      true,
      "docs/ SHOULD be in the tarball when present at repo root",
    );
  } finally {
    fs.rmSync(kitRoot, { recursive: true, force: true });
    fs.rmSync(path.join(kitRoot, "dist", "migration-guild-kit.tar.gz"), { force: true });
  }
});
