#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { execSync } from "child_process";

// Resolve the kit root (where package/, migration/, stacks/ live). setup.ts can
// run two ways: from a full checkout (node setup.ts) where these dirs are siblings
// of setup.ts, or from a built dist/setup.js (where __dirname is dist/ and the kit
// dirs are one level up at the repo root). We never assume a toolkit-root *layout* —
// the workspace is meant to be self-contained, so the kit just copies these dirs in.
function findKitRoot(): string {
  // 1) dist/setup.js shipped in a built checkout: ../ from dist/
  const asDist = path.resolve(__dirname, "..");
  if (
    fs.existsSync(path.join(asDist, "migration")) &&
    fs.existsSync(path.join(asDist, "package")) &&
    fs.existsSync(path.join(asDist, "stacks"))
  ) {
    return asDist;
  }
  // 2) setup.ts run from a full source checkout: siblings of setup.ts
  const asSource = path.resolve(__dirname);
  if (
    fs.existsSync(path.join(asSource, "migration")) &&
    fs.existsSync(path.join(asSource, "package")) &&
    fs.existsSync(path.join(asSource, "stacks"))
  ) {
    return asSource;
  }
  // 3) setup.js at kit root (e.g. tarball entrypoint that sits beside package/)
  for (const candidate of [asDist, asSource]) {
    if (fs.existsSync(path.join(candidate, "package"))) return candidate;
  }
  // Fallback to the legacy assumption.
  return path.resolve(__dirname, "..");
}

const KIT_ROOT = findKitRoot();
const PKG_DIR = path.join(KIT_ROOT, "package");

// ── CLI flag parsing ──────────────────────────────────────────────────────────
// Supports non-interactive mode:
//   --framework "Spring Boot 3.x"   skip framework prompt
//   --legacy-url <url>               skip repo URL prompt + auto-clone
//   --legacy-path <dir>              copy from a local directory instead
//   --update [workspace-path]        update kit files only; optional explicit target dir
//   --yes                            accept all defaults (Spring Boot 3.x, no clone)
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
};
const hasFlag = (name: string) => args.includes(name);

// ── Resolve workspace target directory ────────────────────────────────────────
// When --update is given with an explicit path argument, use it as the target.
// Otherwise fall back to the working directory.
const _updateArg = flag("--update");
const CWD = (_updateArg && !_updateArg.startsWith("-") && fs.existsSync(_updateArg))
  ? path.resolve(_updateArg)
  : process.cwd();
const GITHUB_DIR = path.join(CWD, ".github");

const GITHUB_MAPPINGS: Record<string, string> = {
  agents:       path.join(GITHUB_DIR, "agents"),
  skills:       path.join(GITHUB_DIR, "skills"),
  prompts:      path.join(GITHUB_DIR, "prompts"),
  instructions: path.join(GITHUB_DIR, "instructions"),
};

// Kit directories copied into the workspace so it is self-contained (no toolkit
// root, no symlinks). Each key is the *source* subdirectory under KIT_ROOT; the
// value is the destination under the workspace CWD.
const ROOT_MAPPINGS: Record<string, string> = {
  migration: path.join(CWD, "migration"),
  package:   path.join(CWD, "package"),
  stacks:    path.join(CWD, "stacks"),
  harness:   path.join(CWD, "harness"),
  legacy:    path.join(CWD, "legacy"),
  modern:    path.join(CWD, "modern"),
};

const FRAMEWORKS = [
  { label: "Spring Boot 3.x", value: "Spring Boot 3.x" },
  { label: "Quarkus",         value: "Quarkus"         },
  { label: "Micronaut",       value: "Micronaut"       },
  { label: "Jakarta EE 10",   value: "Jakarta EE 10"   },
  { label: "Plain Java 21",   value: "Plain Java 21"   },
];

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function copyDir(src: string, dest: string, skip: string[] = []): string[] {
  if (!fs.existsSync(src)) return [];
  fs.mkdirSync(dest, { recursive: true });
  const copied: string[] = [];
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copied.push(...copyDir(srcPath, destPath, []));
    } else {
      fs.copyFileSync(srcPath, destPath);
      copied.push(path.relative(CWD, destPath));
    }
  }
  return copied;
}

// Source path for a kit directory. Root-level dirs (migration, package, stacks,
// harness) live under KIT_ROOT; the .github/* assets live under KIT_ROOT/package.
function kitSrc(folder: string): string {
  return path.join(KIT_ROOT, folder);
}

// ── Update mode: sync kit files only, leave registry/legacy/modern alone ──────
async function runUpdate() {
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║   Migration Guild — Update Kit Files          ║");
  console.log("╚══════════════════════════════════════╝\n");
  console.log("Updating agents, skills, prompts, instructions, and migration CLI.");
  console.log("legacy/, modern/, and migration/registry.db are untouched.\n");

  let total = 0;

  for (const [folder, dest] of Object.entries(GITHUB_MAPPINGS)) {
    const src = path.join(PKG_DIR, folder);
    const files = copyDir(src, dest);
    if (files.length) {
      console.log(`  .github/${folder}/`);
      files.forEach((f) => console.log(`    ↺ ${f}`));
      total += files.length;
    }
  }

  // Root-level kit dirs — copied verbatim so the workspace stays self-contained.
  // migration/ skips its registry.db + node_modules; stacks/ and harness/ copy whole.
  const rootSync: Array<[string, string[]]> = [
    ["migration", ["node_modules", "registry.db", "registry.db-wal", "registry.db-shm"]],
    ["stacks", []],
    ["harness", []],
  ];
  for (const [folder, skip] of rootSync) {
    const files = copyDir(kitSrc(folder), ROOT_MAPPINGS[folder], skip);
    if (files.length) {
      console.log(`  ${folder}/`);
      files.forEach((f) => console.log(`    ↺ ${f}`));
      total += files.length;
    }
  }
  const copilotShim = path.join(PKG_DIR, "agent-shim.mjs");
  if (fs.existsSync(copilotShim)) {
    fs.copyFileSync(copilotShim, path.join(CWD, "agent-shim.mjs"));
    total++;
  }

  console.log(`\nDone. ${total} file(s) updated.`);
  console.log("\nNext step: cd migration && npm install && npm run build && cd ..\n");
}

// ── Install mode: full fresh setup ────────────────────────────────────────────
async function runInstall() {
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║   Migration Guild — Setup  ║");
  console.log("╚══════════════════════════════════════╝\n");

  let framework: string;
  let repoUrl = "";
  let legacyPath: string | undefined;

  const cliFramework = flag("--framework");
  const cliUrl       = flag("--legacy-url");
  const cliPath      = flag("--legacy-path");
  const nonInteractive = hasFlag("--yes") || (cliFramework !== undefined && (cliUrl !== undefined || cliPath !== undefined));

  if (nonInteractive) {
    framework  = cliFramework ?? FRAMEWORKS[0].value;
    repoUrl    = cliUrl ?? "";
    legacyPath = cliPath;
    console.log(`✓ Target framework : ${framework}`);
    if (repoUrl)    console.log(`✓ Legacy repo URL  : ${repoUrl}`);
    if (legacyPath) console.log(`✓ Legacy path      : ${legacyPath}`);
    console.log();
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log("Which framework are you migrating to?\n");
    FRAMEWORKS.forEach((f, i) => console.log(`  ${i + 1}. ${f.label}`));
    console.log();

    framework = FRAMEWORKS[0].value;
    const answer = (await ask(rl, "Enter number [1]: ")).trim();
    const choice = parseInt(answer || "1", 10);
    if (choice >= 1 && choice <= FRAMEWORKS.length) {
      framework = FRAMEWORKS[choice - 1].value;
    } else if (answer) {
      framework = answer;
    }
    console.log(`\n✓ Target framework: ${framework}\n`);

    console.log("How do you want to supply your legacy source?\n");
    console.log("  1. Legacy repo URL (git clone)");
    console.log("  2. Local legacy directory path");
    console.log("  (leave blank to skip — legacy/ will be empty)\n");
    const sourceChoice = (await ask(rl, "Enter number [1]: ")).trim();
    const sourceMode = sourceChoice === "2" ? 2 : 1;
    if (sourceMode === 2) {
      const suppliedPath = (await ask(rl, "Local legacy directory path: ")).trim();
      if (suppliedPath) {
        legacyPath = suppliedPath;
      }
    } else {
      repoUrl = (await ask(rl, "Legacy repo URL (leave blank to skip): ")).trim();
    }
    rl.close();
  }

  let total = 0;

  for (const [folder, dest] of Object.entries(GITHUB_MAPPINGS)) {
    const src = path.join(PKG_DIR, folder);
    const files = copyDir(src, dest);
    if (files.length) {
      console.log(`  .github/${folder}/`);
      files.forEach((f) => console.log(`    + ${f}`));
      total += files.length;
    }
  }

  // Root-level kit dirs copied into the workspace so it is self-contained — no
  // toolkit root, no symlinks. migration/ skips registry.db + node_modules.
  const rootCopy: Array<[string, string[]]> = [
    ["migration", ["node_modules", "registry.db", "registry.db-wal", "registry.db-shm"]],
    ["package", ["node_modules"]],
    ["stacks", []],
    ["harness", []],
  ];
  for (const [folder, skip] of rootCopy) {
    const files = copyDir(kitSrc(folder), ROOT_MAPPINGS[folder], skip);
    if (files.length) {
      console.log(`  ${folder}/`);
      files.forEach((f) => console.log(`    + ${f}`));
      total += files.length;
    }
  }

  const instructionsSrc  = path.join(PKG_DIR, "agent-instructions.md");
  const instructionsDest = path.join(GITHUB_DIR, "agent-instructions.md");
  if (fs.existsSync(instructionsSrc)) {
    fs.mkdirSync(GITHUB_DIR, { recursive: true });
    let content = fs.readFileSync(instructionsSrc, "utf-8");
    content = content.replace("{{TARGET_FRAMEWORK}}", framework);
    fs.writeFileSync(instructionsDest, content, "utf-8");
    console.log(`  .github/`);
    console.log(`    + ${path.relative(CWD, instructionsDest)}`);
    total++;
  }

  // Copy .env.example to the workspace root. (Config lives in .guild/config.yaml,
  // which `guildctl init` scaffolds — there is no separate guildctl.config.json.)
  for (const f of [".env.example", "agent-shim.mjs"]) {
    const src  = path.join(PKG_DIR, f);
    const dest = path.join(CWD, f);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
      console.log(`    + ${f}`);
      total++;
    }
  }

  if (repoUrl) {
    console.log(`\nCloning legacy repo into legacy/...`);
    try {
      const legacyDir = path.join(CWD, "legacy");
      // Clone straight into legacy/ — the old temp-dir + per-entry rename threw
      // EPERM on Windows. force:true ignores a missing/empty scaffold dir.
      fs.rmSync(legacyDir, { recursive: true, force: true });
      execSync(`git clone --depth 1 ${repoUrl} "${legacyDir}"`, { stdio: "inherit" });
      // Drop history; maxRetries lets Node retry past Windows' read-only .git pack locks.
      fs.rmSync(path.join(legacyDir, ".git"), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      console.log(`✓ Legacy source cloned into legacy/`);
    } catch (err) {
      console.error(`✗ Clone failed: ${(err as Error).message}`);
      console.error(`  You can clone manually: git clone ${repoUrl} legacy/`);
    }
  } else if (legacyPath) {
    // Fail-closed: a missing/invalid local path is NOT silently treated as a
    // resolved legacy source — surface a clear error and drop legacyPath so the
    // FR-007 no-legacy warning still fires (US3 FR-012).
    if (!fs.existsSync(legacyPath) || !fs.statSync(legacyPath).isDirectory()) {
      console.error(`✗ Legacy path not found: ${legacyPath}`);
      console.error(`  Provide an existing directory containing your legacy source.`);
      legacyPath = undefined;
    } else {
      console.log(`\nCopying legacy source from ${legacyPath}...`);
      try {
        const legacyDir = path.join(CWD, "legacy");
        const files = copyDir(legacyPath, legacyDir, [".git"]);
        console.log(`✓ ${files.length} files copied into legacy/`);
        total += files.length;
      } catch (err) {
        console.error(`✗ Copy failed: ${(err as Error).message}`);
        legacyPath = undefined;
      }
    }
  }

  console.log(`\nDone. ${total} file(s) installed.`);
  const hasLegacy = repoUrl || legacyPath;
  if (!hasLegacy) {
    console.log(`\n⚠ WARNING: No legacy source was provided`);
    console.log(`legacy/ is empty (0 files).`);
    console.log(`  Supply a legacy repo URL or local directory path so migration has input.`);
  }
  console.log(`\nNext steps:`);
  if (!hasLegacy) console.log(`  1. Copy your legacy Java source into legacy/`);
  const n = hasLegacy ? 1 : 2;
  console.log(`  ${n}. Install runtime dependencies (migration/ ships with the kit; this just adds node_modules):`);
  console.log(`       cd migration && npm install && cd ..`);
  console.log(`  ${n+1}. Scaffold the workspace config:`);
  console.log(`       node migration/guildctl/dist/cli.js init`);
  console.log(`  ${n+2}. Configure your runtime — edit .guild/config.yaml (see GETTING-STARTED "Configure runtime").`);
  console.log(`  ${n+3}. Run the full migration pipeline:`);
  console.log(`       node migration/guildctl/dist/cli.js run --parallel 3`);
  console.log(`  ${n+4}. Watch live progress (second terminal):`);
  console.log(`       node migration/guildctl/dist/cli.js doctor\n`);
}

async function main() {
  // Guard: refuse to run against the kit source repository itself.
  // Detected by the presence of package/agent-instructions.md inside CWD.
  const kitRootMarker = path.join(CWD, "package", "agent-instructions.md");
  if (fs.existsSync(kitRootMarker)) {
    console.error("\n✗  Cannot run setup against the Migration Guild kit source tree.");
    console.error("   Change into a migration workspace, or pass an explicit target path:");
    console.error("   node setup.js --update /path/to/your/workspace\n");
    process.exit(1);
  }

  if (hasFlag("--update")) {
    await runUpdate();
  } else {
    await runInstall();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
