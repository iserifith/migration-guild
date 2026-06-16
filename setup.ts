#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { execSync } from "child_process";

const PKG_DIR = fs.existsSync(path.join(__dirname, "package"))
  ? path.join(__dirname, "package")          // setup.js at kit root (e.g. node setup.js)
  : path.join(__dirname, "..", "package");   // setup.js inside dist/ subfolder

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

const ROOT_MAPPINGS: Record<string, string> = {
  legacy: path.join(CWD, "legacy"),
  modern: path.join(CWD, "modern"),
  tools:  path.join(CWD, "migration"),
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

  // migration/ — skip registry.db and node_modules
  const toolsSrc  = path.join(PKG_DIR, "tools");
  const toolsDest = ROOT_MAPPINGS.tools;
  const toolFiles = copyDir(toolsSrc, toolsDest, [
    "node_modules", "registry.db", "registry.db-wal", "registry.db-shm",
  ]);
  if (toolFiles.length) {
    console.log(`  migration/`);
    toolFiles.forEach((f) => console.log(`    ↺ ${f}`));
    total += toolFiles.length;
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
  let repoUrl: string;
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

    repoUrl = (await ask(rl, "Legacy repo URL (leave blank to skip): ")).trim();
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

  const ROOT_LABELS: Record<string, string> = { legacy: "legacy", modern: "modern", tools: "migration" };
  for (const [folder, dest] of Object.entries(ROOT_MAPPINGS)) {
    const src = path.join(PKG_DIR, folder);
    const files = copyDir(src, dest);
    if (files.length) {
      console.log(`  ${ROOT_LABELS[folder] ?? folder}/`);
      files.forEach((f) => console.log(`    + ${f}`));
      total += files.length;
    }
  }

  const instructionsSrc  = path.join(PKG_DIR, "copilot-instructions.md");
  const instructionsDest = path.join(GITHUB_DIR, "copilot-instructions.md");
  if (fs.existsSync(instructionsSrc)) {
    fs.mkdirSync(GITHUB_DIR, { recursive: true });
    let content = fs.readFileSync(instructionsSrc, "utf-8");
    content = content.replace("{{TARGET_FRAMEWORK}}", framework);
    fs.writeFileSync(instructionsDest, content, "utf-8");
    console.log(`  .github/`);
    console.log(`    + ${path.relative(CWD, instructionsDest)}`);
    total++;
  }

  // Copy .env.example and guildctl.config.json to workspace root
  for (const f of [".env.example", "guildctl.config.json"]) {
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
      const tmpDir = path.join(CWD, ".guildctl-clone-tmp");
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
      execSync(`git clone --depth 1 ${repoUrl} "${tmpDir}"`, { stdio: "inherit" });
      const legacyDir = path.join(CWD, "legacy");
      fs.mkdirSync(legacyDir, { recursive: true });
      for (const entry of fs.readdirSync(tmpDir)) {
        if (entry === ".git") continue;
        fs.renameSync(path.join(tmpDir, entry), path.join(legacyDir, entry));
      }
      fs.rmSync(tmpDir, { recursive: true });
      console.log(`✓ Legacy source cloned into legacy/`);
    } catch (err) {
      console.error(`✗ Clone failed: ${(err as Error).message}`);
      console.error(`  You can clone manually: git clone ${repoUrl} legacy/`);
    }
  } else if (legacyPath) {
    console.log(`\nCopying legacy source from ${legacyPath}...`);
    try {
      const legacyDir = path.join(CWD, "legacy");
      const files = copyDir(legacyPath, legacyDir, [".git"]);
      console.log(`✓ ${files.length} files copied into legacy/`);
      total += files.length;
    } catch (err) {
      console.error(`✗ Copy failed: ${(err as Error).message}`);
    }
  }

  console.log(`\nDone. ${total} file(s) installed.`);
  const hasLegacy = repoUrl || legacyPath;
  console.log("\nNext steps:");
  if (!hasLegacy) console.log("  1. Copy your legacy Java source into legacy/");
  const n = hasLegacy ? 1 : 2;
  console.log(`  ${n}. Install runtime dependencies:`);
  console.log(`       cd migration && npm install && cd ..`);
  console.log(`  ${n+1}. Run the full migration pipeline:`);
  console.log(`       npx guildctl run --parallel 3`);
  console.log(`  ${n+2}. Watch live progress (second terminal):`);
  console.log(`       node migration/registry/dist/cli.js serve\n`);
}

async function main() {
  // Guard: refuse to run against the kit source repository itself.
  // Detected by the presence of package/copilot-instructions.md inside CWD.
  const kitRootMarker = path.join(CWD, "package", "copilot-instructions.md");
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
