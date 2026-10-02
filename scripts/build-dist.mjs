#!/usr/bin/env node

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

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

export function shouldCopyPackageEntry(relativePath, isDirectory) {
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

// fs.cp filter factory rooted at the copy source root (#300). fs.cp hands the
// filter absolute, platform-native paths (backslashes on Windows), so every
// candidate is re-rooted relative to rootDir before the packaging policy sees
// it. lstat (not stat) keeps the directory/file decision identical to the old
// readdir Dirent walk this policy was written against: a directory named
// `*.ts` still ships, a file or symlink named `*.ts` still does not.
function makeSourceRootFilter(rootDir) {
  return async (sourcePath) => {
    const relativePath = path.relative(rootDir, sourcePath);

    if (relativePath === "") {
      // fs.cp consults the filter for the copy root itself; the policy
      // unconditionally ships it (same as the old pre-walk check).
      return true;
    }

    if (relativePath.startsWith("..")) {
      // Only reachable when fs.cp expands a symlink-to-directory whose target
      // lies OUTSIDE the copy root. The old fs.copyFile walk hard-failed on
      // such links (EISDIR); fail closed the same way instead of shipping
      // unfiltered content from outside the staged tree.
      throw new Error(`Refusing to copy content outside the source root: ${sourcePath}`);
    }

    return shouldCopyPackageEntry(relativePath.split(path.sep).join("/"), (await fs.lstat(sourcePath)).isDirectory());
  };
}

// Copies `sourceDir` into `destinationDir`, applying the packaging policy to
// every entry relative to `rootDir`. The recursive traversal itself is
// delegated to fs.cp (#300) instead of a hand-rolled readdir walk. Call sites,
// exclusions, and failure semantics are unchanged:
//   - an excluded directory is skipped whole (fs.cp never descends into it);
//   - an included empty directory still appears in the destination;
//   - a missing source fails the build (fs.cp throws ENOENT, like readdir did);
//   - every other copy error propagates and fails the build.
// Symlink behavior is an explicit choice of #300 (`dereference: true`):
//   - file symlinks ship as regular files holding the target's content —
//     exactly what the old fs.copyFile call produced;
//   - broken symlinks still fail the build (ENOENT, fail-closed);
//   - a symlink to a directory now expands to a filtered copy of its target
//     where the old walk hard-failed — only possible for trees that could not
//     build at all before, so no currently-succeeding build changes output.
// `dereference: false` was rejected: it ships links instead of content and
// needs symlink-creation privileges on Windows (EPERM on unprivileged hosts),
// a new failure mode for builds that succeed today.
// Exported for migration/test/build-dist-copy-filter.test.ts (#300).
export async function copyFilteredDirectory(sourceDir, destinationDir, rootDir = sourceDir) {
  const relativePath = path.relative(rootDir, sourceDir);
  const normalizedRelativePath = relativePath === "" ? "" : relativePath.split(path.sep).join("/");

  if (!shouldCopyPackageEntry(normalizedRelativePath, true)) {
    return;
  }

  await fs.mkdir(destinationDir, { recursive: true });

  await fs.cp(sourceDir, destinationDir, {
    recursive: true,
    dereference: true,
    filter: makeSourceRootFilter(rootDir),
  });
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
  // FR-004 (#148): a fresh clone only runs the ROOT `npm install` before
  // `npm run build:dist` — the nested migration/ and migration/ui/ installs
  // are this script's job. Installing into an already-populated node_modules
  // is a fast no-op, so this runs unconditionally; a genuinely broken install
  // propagates through main().catch() exactly like a failed tsup/vite step
  // (not wrapped in try/swallow — see the Step 3 comment for the same rule).
  await run("npm", ["install"], { cwd: path.join(repoRoot, "migration") });
  await run("npx", ["tsup"], { cwd: path.join(repoRoot, "migration") });
  console.log("  ✓ migration built");

  console.log("▶ Step 2/4 — Build setup.ts (tsup)");
  await run("npm", ["run", "build"], { cwd: repoRoot });
  console.log("  ✓ setup.js built");

  console.log("▶ Step 3/4 — Build Mission Control UI (vite)");
  // FR-004 (#148): the UI build needs migration/ui/node_modules; install it
  // here for the same fresh-clone reason as the Step 1 pre-install above.
  await run("npm", ["install"], { cwd: path.join(repoRoot, "migration", "ui") });
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

// Run the build pipeline only when executed directly (`node scripts/build-dist.mjs`,
// `npm run build:dist`). Importing the module must stay side-effect free — the
// packaging tests import shouldCopyPackageEntry/copyFilteredDirectory from here.
function isDirectRun() {
  if (!process.argv[1]) {
    return false;
  }

  const entryHref = pathToFileURL(process.argv[1]).href;
  // Windows paths are case-insensitive and shell-reported casing can differ
  // from on-disk casing; compare case-insensitively there so a direct run can
  // never silently no-op. POSIX keeps the exact comparison.
  if (process.platform === "win32") {
    return import.meta.url.toLowerCase() === entryHref.toLowerCase();
  }

  return import.meta.url === entryHref;
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error("");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
