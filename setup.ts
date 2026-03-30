#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { execSync } from "child_process";

const PKG_DIR = path.join(__dirname, "..", "package");
const CWD = process.cwd();
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
  console.log("║   legmod — Update Kit Files          ║");
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
  console.log("║   legmod — Java Migration Kit Setup  ║");
  console.log("╚══════════════════════════════════════╝\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("Which framework are you migrating to?\n");
  FRAMEWORKS.forEach((f, i) => console.log(`  ${i + 1}. ${f.label}`));
  console.log();

  let framework = FRAMEWORKS[0].value;
  const answer = (await ask(rl, "Enter number [1]: ")).trim();
  const choice = parseInt(answer || "1", 10);
  if (choice >= 1 && choice <= FRAMEWORKS.length) {
    framework = FRAMEWORKS[choice - 1].value;
  } else if (answer) {
    framework = answer;
  }

  console.log(`\n✓ Target framework: ${framework}\n`);

  const repoUrl = (await ask(rl, "Legacy repo URL (leave blank to skip): ")).trim();
  rl.close();

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

  if (repoUrl) {
    console.log(`\nCloning legacy repo into legacy/...`);
    try {
      const tmpDir = path.join(CWD, ".legmod-clone-tmp");
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
      execSync(`git clone --depth 1 ${repoUrl} "${tmpDir}"`, { stdio: "inherit" });
      const legacyDir = path.join(CWD, "legacy");
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
  }

  console.log(`\nDone. ${total} file(s) installed.`);
  console.log("\nNext steps:");
  if (!repoUrl) console.log("  1. Copy your legacy Java source into legacy/");
  const n = repoUrl ? 1 : 2;
  console.log(`  ${n}. Build the registry CLI: cd migration && npm install && npm run build && cd ..`);
  console.log(`  ${n+1}. Run Copilot and say: "Run inventory"`);
  console.log(`  ${n+2}. Then: "Run planning"`);
  console.log(`  ${n+3}. Then open sessions and say: "Migrate next task"\n`);
}

async function main() {
  if (process.argv.includes("--update")) {
    await runUpdate();
  } else {
    await runInstall();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
