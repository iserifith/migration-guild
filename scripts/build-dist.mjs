#!/usr/bin/env node

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..");
const distDir = path.join(repoRoot, "dist");
const buildDir = path.join(distDir, "migration-guild-kit-build");
const tarball = path.join(distDir, "migration-guild-kit.tar.gz");

function resolveCommand(command) {
  if (process.platform === "win32" && (command === "npm" || command === "npx")) {
    return `${command}.cmd`;
  }

  return command;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveCommand(command), args, {
      cwd: options.cwd ?? repoRoot,
      env: process.env,
      stdio: "inherit",
      // Windows cannot spawn .cmd shims (npm/npx/tsup) directly — needs a shell.
      shell: process.platform === "win32"
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}`));
    });
  });
}

function parseVersion(argv) {
  let version = "";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--version") {
      const next = argv[index + 1];

      if (!next) {
        throw new Error("Missing value for --version");
      }

      version = next;
      index += 1;
      continue;
    }

    throw new Error(`Unknown flag: ${arg}`);
  }

  return version;
}

async function maybeBumpVersion(version) {
  if (!version) {
    return;
  }

  console.log(`  Bumping version to ${version}`);

  const packageJsonPath = path.join(repoRoot, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  packageJson.version = version;
  await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function shouldCopyPackageEntry(relativePath, isDirectory) {
  if (!relativePath) {
    return true;
  }

  const normalized = relativePath.split(path.sep).join("/");
  const parts = normalized.split("/");
  const baseName = parts[parts.length - 1];

  if (parts.includes("node_modules")) {
    return false;
  }

  if (baseName === ".env") {
    return false;
  }

  const topLevel = parts[0];
  if (topLevel === "legacy" || topLevel === "modern" || topLevel === "migration") {
    return false;
  }

  if (!isDirectory && normalized.endsWith(".ts") && !normalized.endsWith(".ts.map")) {
    return false;
  }

  return true;
}

async function copyFilteredDirectory(sourceDir, destinationDir, rootDir = sourceDir) {
  const relativePath = path.relative(rootDir, sourceDir);
  const normalizedRelativePath = relativePath === "" ? "" : relativePath.split(path.sep).join("/");

  if (!shouldCopyPackageEntry(normalizedRelativePath, true)) {
    return;
  }

  await fs.mkdir(destinationDir, { recursive: true });

  const entries = await fs.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    const entryRelativePath = path.relative(rootDir, sourcePath);

    if (!shouldCopyPackageEntry(entryRelativePath, entry.isDirectory())) {
      continue;
    }

    if (entry.isDirectory()) {
      await copyFilteredDirectory(sourcePath, destinationPath, rootDir);
      continue;
    }

    await fs.copyFile(sourcePath, destinationPath);
  }
}

async function assembleTarball() {
  console.log("▶ Step 4/4 — Assemble dist/migration-guild-kit.tar.gz");

  await fs.rm(buildDir, { recursive: true, force: true });
  await fs.mkdir(buildDir, { recursive: true });

  const copyJobs = [
    fs.copyFile(path.join(repoRoot, "dist", "setup.js"), path.join(buildDir, "setup.js")),
    fs.copyFile(path.join(repoRoot, "README.md"), path.join(buildDir, "README.md")),
    fs.copyFile(path.join(repoRoot, "GETTING-STARTED.md"), path.join(buildDir, "GETTING-STARTED.md")),
    fs.copyFile(path.join(repoRoot, "AGENTS.md"), path.join(buildDir, "AGENTS.md"))
  ];

  // Repo-root docs/ is optional; mirror the .env.example ENOENT-skip precedent so
  // the build does not crash when docs/ is absent (FR-001..FR-004). Only the
  // "directory does not exist" case is skipped; any other copy error still throws.
  const docsSrc = path.join(repoRoot, "docs");
  if (fsSync.existsSync(docsSrc)) {
    copyJobs.push(fs.cp(docsSrc, path.join(buildDir, "docs"), { recursive: true }));
  } else {
    console.log("  • docs/ not found at repo root — skipping (FR-003)");
  }

  await Promise.all(copyJobs);

  const packagedDir = path.join(buildDir, "package");
  await copyFilteredDirectory(path.join(repoRoot, "package"), packagedDir);

  const envExample = path.join(repoRoot, "package", ".env.example");
  try {
    await fs.copyFile(envExample, path.join(packagedDir, ".env.example"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  // Self-contained kit: bundle the built migration CLI + stacks/ so a copied or
  // tarball workspace works without a sibling toolkit-root checkout (#115).
  // The tsup pipeline (migration/tsup.config.ts) writes registry/dist and
  // guildctl/dist — not migration/dist, which no build step ever creates — and
  // the UI (migration/ui → migration/ui-dist, via the build:ui step above) is
  // what registry/commands/serve.ts's UI_DIR (../../ui-dist relative to the
  // packaged registry/dist/cli.js) actually expects to find (#123).
  await copyFilteredDirectory(path.join(repoRoot, "migration", "registry", "dist"), path.join(buildDir, "migration", "registry", "dist"));
  await copyFilteredDirectory(path.join(repoRoot, "migration", "guildctl", "dist"), path.join(buildDir, "migration", "guildctl", "dist"));
  await copyFilteredDirectory(path.join(repoRoot, "migration", "ui-dist"), path.join(buildDir, "migration", "ui-dist"));
  await copyFilteredDirectory(path.join(repoRoot, "stacks"), path.join(buildDir, "stacks"));

  // FR-003 (#148): ship the migration package manifest, its lockfile, and the
  // registry schema verbatim so the kit's documented "cd migration && npm
  // install" step works from the tarball alone — no sibling checkout needed.
  // package-lock.json is required for the install to be reproducible offline-
  // from-cache; registry_schema.sql is loaded by the packaged CLI at runtime.
  await fs.copyFile(path.join(repoRoot, "migration", "package.json"), path.join(buildDir, "migration", "package.json"));
  await fs.copyFile(path.join(repoRoot, "migration", "package-lock.json"), path.join(buildDir, "migration", "package-lock.json"));
  await fs.copyFile(path.join(repoRoot, "migration", "registry_schema.sql"), path.join(buildDir, "migration", "registry_schema.sql"));

  await fs.mkdir(path.join(packagedDir, "legacy"), { recursive: true });
  await fs.mkdir(path.join(packagedDir, "modern"), { recursive: true });
  await fs.writeFile(path.join(packagedDir, "modern", ".gitkeep"), "");

  await fs.rm(tarball, { force: true });
  await run("tar", ["-czf", path.basename(tarball), path.basename(buildDir)], { cwd: distDir });
  await fs.rm(buildDir, { recursive: true, force: true });

  const { size } = await fs.stat(tarball);
  console.log(`  ✓ ${tarball} (${Math.floor(size / 1024)} KB)`);
}

async function main() {
  const version = parseVersion(process.argv.slice(2));
  await maybeBumpVersion(version);

  console.log("");
  console.log("╔══════════════════════════════════════╗");
  console.log("║       migration-guild-kit dist builder        ║");
  console.log("╚══════════════════════════════════════╝");
  console.log("");

  console.log("▶ Step 1/4 — Build migration (tsup)");
  await run("npx", ["tsup"], { cwd: path.join(repoRoot, "migration") });
  console.log("  ✓ migration built");

  console.log("▶ Step 2/4 — Build setup.ts (tsup)");
  await run("npm", ["run", "build"], { cwd: repoRoot });
  console.log("  ✓ setup.js built");

  console.log("▶ Step 3/4 — Build Mission Control UI (vite)");
  // Not wrapped in a try/swallow: a failed UI build must fail the whole
  // dist build (FR-006) the same way a failed tsup step does above — a
  // silently-absent migration/ui-dist is exactly the #123 defect.
  await run("npm", ["run", "build:ui"], { cwd: repoRoot });
  console.log("  ✓ migration/ui-dist built");

  await assembleTarball();

  console.log("");
  console.log("  Done! Distribute with:");
  console.log("    curl -fsSL <url>/migration-guild-kit.tar.gz | tar -xz && node migration-guild-kit-build/setup.js");
  console.log("");
}

main().catch((error) => {
  console.error("");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
