import * as fs from "fs";
import * as path from "path";
import { execFileSync, spawnSync } from "child_process";
import { ResolvedGuildConfig, sanitizedConfigSnapshot, stringifySimpleYaml } from "./config";

const DEFAULT_PROMPTS: Record<string, string> = {
  init: `You are Migration Guild in init mode. Map the repository from evidence before proposing migration intent. Separate observed facts from inferred risks. Do not edit source files.`,
  map: `You are Migration Guild in map mode. Use collected evidence to identify migration seams and dependencies.`,
  evidence: `You are Migration Guild in evidence mode. Collect and summarize proof.`,
  plan: `You are Migration Guild in plan mode. Produce a bounded implementation plan only from evidence.`,
  execute: `You are Migration Guild in execute mode. Execute only approved bounded steps. Stop at the configured autonomous step cap.`,
  review: `You are Migration Guild in review mode. Check implementation against evidence, plan, tests, and risk constraints.`,
};

export function defaultPromptModes(): string[] { return Object.keys(DEFAULT_PROMPTS); }

export function scaffoldDefaultPrompts(cfg: ResolvedGuildConfig): void {
  const packDir = path.resolve(cfg.guildRoot, cfg.prompts.directory, cfg.prompts.active_pack);
  fs.mkdirSync(packDir, { recursive: true });
  for (const [mode, prompt] of Object.entries(DEFAULT_PROMPTS)) {
    const file = path.join(packDir, `${mode}.md`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, `${prompt}\n`, "utf8");
  }
}

export function loadPromptTemplate(cfg: ResolvedGuildConfig, mode: string): string {
  const promptPath = path.resolve(cfg.guildRoot, cfg.prompts.directory, cfg.prompts.active_pack, `${mode}.md`);
  if (fs.existsSync(promptPath)) return fs.readFileSync(promptPath, "utf8");
  const builtIn = DEFAULT_PROMPTS[mode];
  if (!builtIn) throw new Error(`Missing prompt template for mode "${mode}" in ${promptPath}`);
  return builtIn;
}

export function renderPrompt(args: { cfg: ResolvedGuildConfig; mode: string; repoContext?: string; evidenceSummary?: string; input?: unknown }): string {
  const template = loadPromptTemplate(args.cfg, args.mode);
  return [
    template.trim(),
    "",
    "## Mode",
    args.mode,
    "",
    "## Resolved config snapshot",
    "```yaml",
    stringifySimpleYaml(sanitizedConfigSnapshot(args.cfg)),
    "```",
    "",
    "## Repo context",
    args.repoContext ?? "No repo context supplied.",
    "",
    "## Evidence summary",
    args.evidenceSummary ?? "No evidence collected yet.",
    "",
    "## User input",
    "```json",
    JSON.stringify(args.input ?? {}, null, 2),
    "```",
  ].join("\n");
}

function runGit(root: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (res.status !== 0) return (res.stderr || res.stdout || "").trim();
  return res.stdout.trim();
}

function walkFiles(root: string, max = 250): string[] {
  const skip = new Set([".git", "node_modules", "dist", "ui-dist", ".guild", "coverage", ".next", "build"]);
  const out: string[] = [];
  function walk(dir: string) {
    if (out.length >= max) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) walk(full);
      else out.push(rel);
      if (out.length >= max) return;
    }
  }
  walk(root);
  return out;
}

export interface EvidenceReport {
  observedFacts: string[];
  inferredRisks: string[];
  files: string[];
  packageScripts: Record<string, string>;
  dependencyFiles: string[];
  git: Record<string, string>;
}

export function collectInitEvidence(root: string): EvidenceReport {
  const files = walkFiles(root);
  const dependencyFiles = files.filter((f) => /(^|\/)(package.json|package-lock.json|pnpm-lock.yaml|yarn.lock|tsconfig.json|requirements.txt|pyproject.toml|pom.xml|build.gradle|gradlew|Makefile|Dockerfile)$/.test(f));
  const packageJsonPath = path.join(root, "package.json");
  const packageScripts: Record<string, string> = {};
  if (fs.existsSync(packageJsonPath)) {
    try { Object.assign(packageScripts, JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).scripts ?? {}); } catch {}
  }
  const extensions = new Set(files.map((f) => path.extname(f)).filter(Boolean));
  const observedFacts = [
    `Repository root: ${root}`,
    `Tracked evidence files sampled: ${files.length}`,
    `Detected extensions: ${Array.from(extensions).sort().join(", ") || "none"}`,
    `Dependency/config files: ${dependencyFiles.join(", ") || "none"}`,
    `Package scripts: ${Object.keys(packageScripts).join(", ") || "none"}`,
  ];
  const inferredRisks: string[] = [];
  if (!packageScripts.test) inferredRisks.push("No root package.json test script detected; verification command may need explicit config.");
  if (files.some((f) => f.includes("foundry"))) inferredRisks.push("Foundry-specific code exists; provider-neutral path must avoid depending on it.");
  if (files.some((f) => f.includes("copilot") || f.includes("agents/"))) inferredRisks.push("Existing Copilot artifact packaging exists; keep it optional and avoid hard prerequisites.");
  return {
    observedFacts,
    inferredRisks,
    files,
    packageScripts,
    dependencyFiles,
    git: {
      branch: runGit(root, ["branch", "--show-current"]),
      remotes: runGit(root, ["remote", "-v"]),
      status: runGit(root, ["status", "--short"]),
      diffSummary: runGit(root, ["diff", "--stat"]),
    },
  };
}

export function evidenceReportMarkdown(report: EvidenceReport): string {
  return [
    "# Migration Guild init evidence report",
    "",
    "## Observed facts",
    ...report.observedFacts.map((x) => `- ${x}`),
    "",
    "## Inferred risks",
    ...(report.inferredRisks.length ? report.inferredRisks.map((x) => `- ${x}`) : ["- None detected from lightweight scan."]),
    "",
    "## Git",
    `- Branch: ${report.git.branch || "unknown"}`,
    `- Status: ${report.git.status || "clean"}`,
    "",
    "## Package scripts",
    ...(Object.entries(report.packageScripts).map(([k, v]) => `- ${k}: ${v}`)),
  ].join("\n");
}

export function createRunLedger(args: { cfg: ResolvedGuildConfig; mode: string; input?: unknown; prompt: string; response?: string; evidence?: EvidenceReport }): string {
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.resolve(args.cfg.guildRoot, ".guild", "runs", id);
  fs.mkdirSync(path.join(runDir, "evidence"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "input.json"), JSON.stringify({ mode: args.mode, profile: args.cfg.selectedProfile, input: args.input ?? {} }, null, 2), "utf8");
  fs.writeFileSync(path.join(runDir, "config.snapshot.yaml"), stringifySimpleYaml(sanitizedConfigSnapshot(args.cfg)), "utf8");
  fs.writeFileSync(path.join(runDir, "prompt.final.md"), args.prompt, "utf8");
  fs.writeFileSync(path.join(runDir, "response.md"), args.response ?? "", "utf8");
  if (args.evidence) {
    fs.writeFileSync(path.join(runDir, "evidence", "init-evidence.json"), JSON.stringify(args.evidence, null, 2), "utf8");
    fs.writeFileSync(path.join(runDir, "report.md"), evidenceReportMarkdown(args.evidence), "utf8");
  } else {
    fs.writeFileSync(path.join(runDir, "report.md"), `# Migration Guild ${args.mode} run\n\nNo evidence report produced.\n`, "utf8");
  }
  return runDir;
}
