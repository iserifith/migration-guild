#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

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
  legacy:    path.join(CWD, "legacy"),
  modern:    path.join(CWD, "modern"),
  tools:     path.join(CWD, "migration"),  // package/tools/ → migration/
};

const FRAMEWORKS = [
  { label: "Spring Boot 3.x",  value: "Spring Boot 3.x"  },
  { label: "Quarkus",          value: "Quarkus"          },
  { label: "Micronaut",        value: "Micronaut"        },
  { label: "Jakarta EE 10",    value: "Jakarta EE 10"    },
  { label: "Plain Java 21",    value: "Plain Java 21"    },
];

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function copyDir(src: string, dest: string): string[] {
  if (!fs.existsSync(src)) return [];
  fs.mkdirSync(dest, { recursive: true });
  const copied: string[] = [];
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copied.push(...copyDir(srcPath, destPath));
    } else {
      fs.copyFileSync(srcPath, destPath);
      copied.push(path.relative(CWD, destPath));
    }
  }
  return copied;
}

async function main() {
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║   legmod — Java Migration Kit Setup  ║");
  console.log("╚══════════════════════════════════════╝\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // ── Framework selection ───────────────────────────────────────────────────
  console.log("Which framework are you migrating to?\n");
  FRAMEWORKS.forEach((f, i) => console.log(`  ${i + 1}. ${f.label}`));
  console.log();

  let framework = FRAMEWORKS[0].value;
  const answer = (await ask(rl, "Enter number [1]: ")).trim();
  const choice = parseInt(answer || "1", 10);
  if (choice >= 1 && choice <= FRAMEWORKS.length) {
    framework = FRAMEWORKS[choice - 1].value;
  } else if (answer) {
    // Allow free-form entry
    framework = answer;
  }

  console.log(`\n✓ Target framework: ${framework}\n`);
  rl.close();

  // ── Copy .github/ artifacts ───────────────────────────────────────────────
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

  // ── Copy root folders (legacy/, modern/, migration/) ────────────────────
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

  // ── Write copilot-instructions.md ─────────────────────────────────────────
  const instructionsSrc = path.join(PKG_DIR, "copilot-instructions.md");
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

  console.log(`\nDone. ${total} file(s) installed.`);
  console.log("\nNext steps:");
  console.log("  1. Copy your legacy Java source into legacy/");
  console.log("  2. Build the registry CLI: cd migration && npm install && npm run build && cd ..");
  console.log("  3. Run Copilot and say: \"Run inventory\"");
  console.log("  4. Then: \"Run planning\"");
  console.log("  5. Then open sessions and say: \"Migrate next task\"\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
