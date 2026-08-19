import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

// Copy a minimal, buildable kit root into a temp dir (same staging contract
// as build-dist-docs-skip.test.ts): root node_modules, migration/ WITH its
// node_modules, migration/ui WITH its node_modules, stacks/, scripts/, and
// dist/setup.js — so the staged scripts/build-dist.mjs can really run its
// `npx tsup` and `npm run build:ui` steps inside the temp kit.
function stageKitRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mg-pack-"));
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
  for (const rel of [path.join("migration", "node_modules"), path.join("migration", "ui", "node_modules"), "node_modules"]) {
    const src = path.join(repoRoot, rel);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(root, rel), { recursive: true });
    }
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

test("US1: tarball carries migration/package.json, package-lock.json, and registry_schema.sql (FR-003)", () => {
  const kitRoot = stageKitRoot();
  try {
    const { status, output, tarball } = runBuildDist(kitRoot);
    assert.equal(status, 0, `expected exit 0, got ${status}\n${output}`);
    assert.ok(fs.existsSync(tarball), "tarball not produced");
    const kitBuild = extractTarball(tarball, path.join(kitRoot, ".extract"));
    for (const rel of ["package.json", "package-lock.json", "registry_schema.sql"]) {
      const inTarball = path.join(kitBuild, "migration", rel);
      assert.ok(
        fs.existsSync(inTarball),
        `expected migration/${rel} in the extracted tarball (FR-003); build output:\n${output}`,
      );
    }
  } finally {
    fs.rmSync(kitRoot, { recursive: true, force: true });
  }
});

test("US1: packaged migration/package.json is a verbatim copy — dependencies deep-equal the repo's (FR-002)", () => {
  const kitRoot = stageKitRoot();
  try {
    const { status, output, tarball } = runBuildDist(kitRoot);
    assert.equal(status, 0, `expected exit 0, got ${status}\n${output}`);
    const kitBuild = extractTarball(tarball, path.join(kitRoot, ".extract-deps"));
    const packaged = JSON.parse(fs.readFileSync(path.join(kitBuild, "migration", "package.json"), "utf8"));
    const repo = JSON.parse(fs.readFileSync(path.join(repoRoot, "migration", "package.json"), "utf8"));
    assert.deepEqual(
      packaged.dependencies,
      repo.dependencies,
      "packaged migration/package.json dependencies must deep-equal the repo's (verbatim copy, FR-002)",
    );
    for (const dep of ["dotenv", "better-sqlite3", "commander", "yaml", "@modelcontextprotocol/sdk"]) {
      assert.ok(repo.dependencies?.[dep], `repo migration/package.json must still declare ${dep}`);
    }
    // Verbatim, not rewritten: the whole file byte-compares too.
    assert.equal(
      fs.readFileSync(path.join(kitBuild, "migration", "package.json"), "utf8"),
      fs.readFileSync(path.join(repoRoot, "migration", "package.json"), "utf8"),
      "packaged migration/package.json must be byte-identical to the repo's",
    );
    assert.equal(
      fs.readFileSync(path.join(kitBuild, "migration", "registry_schema.sql"), "utf8"),
      fs.readFileSync(path.join(repoRoot, "migration", "registry_schema.sql"), "utf8"),
      "packaged migration/registry_schema.sql must be byte-identical to the repo's",
    );
  } finally {
    fs.rmSync(kitRoot, { recursive: true, force: true });
  }
});

test("US1 SC-001 live smoke: extract cold, npm install, guildctl --help + registry list-artifacts", { timeout: 300_000 }, async () => {
  const kitRoot = stageKitRoot();
  try {
    const { status, output, tarball } = runBuildDist(kitRoot);
    assert.equal(status, 0, `expected exit 0, got ${status}\n${output}`);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mg-smoke-"));
    execFileSync("tar", ["-xzf", tarball], { cwd: scratch, stdio: "ignore" });
    const kitBuild = path.join(scratch, "migration-guild-kit-build");

    // GETTING-STARTED.md step 4: cd migration && npm install
    // (execFileSync with a cwd option is authoritative, but pass it in env too
    // so an npm shim that re-resolves from INIT_CWD behaves the same.)
    execFileSync("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: path.join(kitBuild, "migration"),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, INIT_CWD: path.join(kitBuild, "migration") },
      shell: process.platform === "win32",
    });

    // Smoke test (GETTING-STARTED.md): guildctl --help must exit 0.
    const help = spawnCapture(process.execPath, [path.join(kitBuild, "migration", "guildctl", "dist", "cli.js"), "--help"], scratch);
    assert.equal(help.status, 0, `guildctl --help exited ${help.status}\n${help.output}`);

    // registry list-artifacts must exit 0 and print [].
    const list = spawnCapture(process.execPath, [path.join(kitBuild, "migration", "registry", "dist", "cli.js"), "list-artifacts"], scratch);
    assert.equal(list.status, 0, `registry list-artifacts exited ${list.status}\n${list.output}`);
    assert.ok(
      /\[\]/.test(list.output.replace(/\s/g, "")) || list.output.trim() === "[]",
      `registry list-artifacts should print []; got:\n${list.output}`,
    );
  } finally {
    fs.rmSync(kitRoot, { recursive: true, force: true });
  }
});

function spawnCapture(command: string, args: string[], cwd: string): { status: number; output: string } {
  try {
    const out = execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, output: out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}
