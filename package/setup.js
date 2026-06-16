#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// setup.ts
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var readline = __toESM(require("readline"));
var import_child_process = require("child_process");
var PKG_DIR = fs.existsSync(path.join(__dirname, "package")) ? path.join(__dirname, "package") : path.join(__dirname, "..", "package");
var CWD = process.cwd();
var GITHUB_DIR = path.join(CWD, ".github");
var args = process.argv.slice(2);
var flag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : void 0;
};
var hasFlag = (name) => args.includes(name);
var GITHUB_MAPPINGS = {
  agents: path.join(GITHUB_DIR, "agents"),
  skills: path.join(GITHUB_DIR, "skills"),
  prompts: path.join(GITHUB_DIR, "prompts"),
  instructions: path.join(GITHUB_DIR, "instructions")
};
var ROOT_MAPPINGS = {
  legacy: path.join(CWD, "legacy"),
  modern: path.join(CWD, "modern"),
  tools: path.join(CWD, "migration")
};
var FRAMEWORKS = [
  { label: "Spring Boot 3.x", value: "Spring Boot 3.x" },
  { label: "Quarkus", value: "Quarkus" },
  { label: "Micronaut", value: "Micronaut" },
  { label: "Jakarta EE 10", value: "Jakarta EE 10" },
  { label: "Plain Java 21", value: "Plain Java 21" }
];
function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}
function copyDir(src, dest, skip = []) {
  if (!fs.existsSync(src)) return [];
  fs.mkdirSync(dest, { recursive: true });
  const copied = [];
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
async function runUpdate() {
  console.log("\n\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557");
  console.log("\u2551   Migration Guild \u2014 Update Kit Files          \u2551");
  console.log("\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D\n");
  console.log("Updating agents, skills, prompts, instructions, and migration CLI.");
  console.log("legacy/, modern/, and migration/registry.db are untouched.\n");
  let total = 0;
  for (const [folder, dest] of Object.entries(GITHUB_MAPPINGS)) {
    const src = path.join(PKG_DIR, folder);
    const files = copyDir(src, dest);
    if (files.length) {
      console.log(`  .github/${folder}/`);
      files.forEach((f) => console.log(`    \u21BA ${f}`));
      total += files.length;
    }
  }
  const toolsSrc = path.join(PKG_DIR, "tools");
  const toolsDest = ROOT_MAPPINGS.tools;
  const toolFiles = copyDir(toolsSrc, toolsDest, [
    "node_modules",
    "registry.db",
    "registry.db-wal",
    "registry.db-shm"
  ]);
  if (toolFiles.length) {
    console.log(`  migration/`);
    toolFiles.forEach((f) => console.log(`    \u21BA ${f}`));
    total += toolFiles.length;
  }
  console.log(`
Done. ${total} file(s) updated.`);
  console.log("\nNext step: cd migration && npm install && npm run build && cd ..\n");
}
async function runInstall() {
  console.log("\n\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557");
  console.log("\u2551   Migration Guild \u2014 Setup  \u2551");
  console.log("\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D\n");
  let framework;
  let repoUrl;
  let legacyPath;
  const cliFramework = flag("--framework");
  const cliUrl = flag("--legacy-url");
  const cliPath = flag("--legacy-path");
  const nonInteractive = hasFlag("--yes") || cliFramework !== void 0 && (cliUrl !== void 0 || cliPath !== void 0);
  if (nonInteractive) {
    framework = cliFramework ?? FRAMEWORKS[0].value;
    repoUrl = cliUrl ?? "";
    legacyPath = cliPath;
    console.log(`\u2713 Target framework : ${framework}`);
    if (repoUrl) console.log(`\u2713 Legacy repo URL  : ${repoUrl}`);
    if (legacyPath) console.log(`\u2713 Legacy path      : ${legacyPath}`);
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
    console.log(`
\u2713 Target framework: ${framework}
`);
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
  const ROOT_LABELS = { legacy: "legacy", modern: "modern", tools: "migration" };
  for (const [folder, dest] of Object.entries(ROOT_MAPPINGS)) {
    const src = path.join(PKG_DIR, folder);
    const files = copyDir(src, dest);
    if (files.length) {
      console.log(`  ${ROOT_LABELS[folder] ?? folder}/`);
      files.forEach((f) => console.log(`    + ${f}`));
      total += files.length;
    }
  }
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
  for (const f of [".env.example", "guildctl.config.json"]) {
    const src = path.join(PKG_DIR, f);
    const dest = path.join(CWD, f);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
      console.log(`    + ${f}`);
      total++;
    }
  }
  if (repoUrl) {
    console.log(`
Cloning legacy repo into legacy/...`);
    try {
      const tmpDir = path.join(CWD, ".guildctl-clone-tmp");
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
      (0, import_child_process.execSync)(`git clone --depth 1 ${repoUrl} "${tmpDir}"`, { stdio: "inherit" });
      const legacyDir = path.join(CWD, "legacy");
      fs.mkdirSync(legacyDir, { recursive: true });
      for (const entry of fs.readdirSync(tmpDir)) {
        if (entry === ".git") continue;
        fs.renameSync(path.join(tmpDir, entry), path.join(legacyDir, entry));
      }
      fs.rmSync(tmpDir, { recursive: true });
      console.log(`\u2713 Legacy source cloned into legacy/`);
    } catch (err) {
      console.error(`\u2717 Clone failed: ${err.message}`);
      console.error(`  You can clone manually: git clone ${repoUrl} legacy/`);
    }
  } else if (legacyPath) {
    console.log(`
Copying legacy source from ${legacyPath}...`);
    try {
      const legacyDir = path.join(CWD, "legacy");
      const files = copyDir(legacyPath, legacyDir, [".git"]);
      console.log(`\u2713 ${files.length} files copied into legacy/`);
      total += files.length;
    } catch (err) {
      console.error(`\u2717 Copy failed: ${err.message}`);
    }
  }
  console.log(`
Done. ${total} file(s) installed.`);
  const hasLegacy = repoUrl || legacyPath;
  console.log("\nNext steps:");
  if (!hasLegacy) console.log("  1. Copy your legacy Java source into legacy/");
  const n = hasLegacy ? 1 : 2;
  console.log(`  ${n}. Install runtime dependencies:`);
  console.log(`       cd migration && npm install && cd ..`);
  console.log(`  ${n + 1}. Run the full migration pipeline:`);
  console.log(`       npx guildctl run --parallel 3`);
  console.log(`  ${n + 2}. Watch live progress (second terminal):`);
  console.log(`       node migration/registry/dist/cli.js serve
`);
}
async function main() {
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
