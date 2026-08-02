import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { parse } from "yaml";
import type { GuildConfig, ResolvedGuildConfig } from "./config";

export type InterpolationKey = "symbol" | "line" | "text" | "version" | "target";

export interface StackAuditRule {
  id: string;
  finding: "jvm" | "dependency" | "python-compat";
  category: string;
  severity: "critical" | "warning";
  match: string;
  flags?: string;
  summary_template: string;
  remediation: string;
  dependency_name?: string;
  target_hint?: string;
  details_template?: string;
  coordinate_hints?: string[];
}

export interface ExternalProbe {
  name: string;
  cmd: string;
  availability_args: string[];
  args: string[];
  targets: string[];
  target_suffixes?: string[];
  available_note: string;
  fallback_note: string;
}

interface ProjectTypeDescription {
  template: string;
  any?: { roles?: string[]; frameworks?: string[]; paths?: string[] };
  all_roles?: string[];
}

interface ScaffoldDescription {
  default_project_type: string;
  library_project_type: string;
  source_extension: string;
  default_package: string;
  default_app_name: string;
  main_source_dir: string;
  test_source_dir: string;
  resources_dir: string;
  resources_file: string;
  build_file: string;
  settings_file: string;
  application_template: string;
  settings_template: string;
  resources_template: string;
  package_marker: string;
  app_name_marker: string;
  app_class_marker: string;
  group_marker: string;
}

/**
 * Optional per-artifact verification declared by a stack pack
 * (contracts/stack-pack-verify.md).
 *
 * Constitution VII: a per-unit compile or test invocation is stack-specific
 * knowledge — `./gradlew compileJava` is meaningless to the Python pack — so it
 * is declared here as **data**. Core reads it and executes it; core contains no
 * build or test command for any stack.
 */
export interface PerArtifactVerify {
  /** Recorded as artifact_verifications.method. */
  id: string;
  /** Executable, resolved from the workspace root. */
  cmd: string;
  args?: string[];
  /** Probed first; failure means unverified/no-stack-check, not a failed check. */
  availability_args?: string[];
  /** Relative to the workspace root; must stay inside it. */
  working_dir?: string;
  /** Per-stack override of verification.budget_seconds. */
  budget_seconds?: number;
  /** Defaults to [0]. */
  pass_exit_codes?: number[];
  /** Operator-facing text when availability_args fails. */
  unavailable_note?: string;
}

export interface StackVerify {
  per_artifact?: PerArtifactVerify;
}

/** Values substituted into `args` and `working_dir`, all from registry rows. */
export interface VerifyPlaceholderValues {
  artifact_path: string;
  output_paths: string[];
  dependency_paths: string[];
  module: string;
  workspace_root: string;
}

/**
 * The closed verify placeholder vocabulary. There is deliberately no
 * `{all_artifacts}`: a pack must not be able to request a tree-wide build.
 */
const VERIFY_PLACEHOLDERS = new Set([
  "artifact_path",
  "output_paths",
  "dependency_paths",
  "scope_paths",
  "module",
  "workspace_root",
]);

function verifyPlaceholderValue(key: string, values: VerifyPlaceholderValues): string {
  switch (key) {
    case "artifact_path": return values.artifact_path;
    case "output_paths": return values.output_paths.join(" ");
    case "dependency_paths": return values.dependency_paths.join(" ");
    case "scope_paths": return [...values.output_paths, ...values.dependency_paths].join(" ");
    case "module": return values.module;
    case "workspace_root": return values.workspace_root;
    default: throw new Error(`Unsupported verify placeholder: {${key}}`);
  }
}

function expandVerifyTemplate(template: string, values: VerifyPlaceholderValues): string {
  return template.replace(/\{([^{}]+)\}/g, (_whole, key: string) => {
    if (!VERIFY_PLACEHOLDERS.has(key)) throw new Error(`Unsupported verify placeholder: {${key}}`);
    return verifyPlaceholderValue(key, values);
  });
}

/**
 * Expand each arg template into exactly one argv entry. Values are never
 * concatenated into a command line, so a path containing a space, quote, or
 * shell metacharacter cannot alter the command — the caller spawns with
 * `shell: false`.
 */
export function expandVerifyArgs(args: string[], values: VerifyPlaceholderValues): string[] {
  return args.map((arg) => expandVerifyTemplate(arg, values));
}

export function expandVerifyWorkingDir(
  workingDir: string | undefined,
  values: VerifyPlaceholderValues,
): string | undefined {
  return workingDir == null ? undefined : expandVerifyTemplate(workingDir, values);
}

/** Reject an unknown verify placeholder at pack load, not at execution time. */
function validateVerifyTemplates(verify: StackVerify | undefined): void {
  const check = verify?.per_artifact;
  if (!check) return;
  for (const template of [...(check.args ?? []), ...(check.working_dir ? [check.working_dir] : [])]) {
    for (const match of template.matchAll(/\{([^{}]+)\}/g)) {
      if (!VERIFY_PLACEHOLDERS.has(match[1])) throw new Error(`Unsupported verify placeholder: {${match[1]}}`);
    }
  }
}

/** A pack without a `verify:` block is valid; it simply declares no check. */
export function resolvePerArtifactVerify(pack: LoadedStackPack): PerArtifactVerify | undefined {
  const check = pack.manifest.verify?.per_artifact;
  if (!check) return undefined;
  if (!check.id || !check.cmd) {
    throw new Error(`[guildctl] Stack pack "${pack.manifest.id}" declares verify.per_artifact without an id and cmd`);
  }
  return check;
}

export interface StackManifest {
  id: string;
  display_name: string;
  detect: { markers: string[] };
  source_globs: string[];
  manifest_globs: string[];
  dependency_parsers: Array<{ match: string; pattern: string; flags?: string }>;
  test_framework: string;
  classification_spec?: string;
  project_types: Record<string, ProjectTypeDescription>;
  audit: { rules_file: string; external_probes: ExternalProbe[] };
  /** Optional; absent means artifacts record unverified/no-stack-check. */
  verify?: StackVerify;
  instructions: { classify: string; mappings: string; tests: string };
  scaffold: ScaffoldDescription;
}

export interface LoadedStackPack {
  dir: string;
  manifest: StackManifest;
  rules: StackAuditRule[];
}

const ALLOWED_PLACEHOLDERS = new Set<InterpolationKey>(["symbol", "line", "text", "version", "target"]);

export function interpolate(template: string, values: Partial<Record<InterpolationKey, string | number | null>>): string {
  return template.replace(/\{([^{}]+)\}/g, (_whole, key: string) => {
    if (!ALLOWED_PLACEHOLDERS.has(key as InterpolationKey)) throw new Error(`Unsupported stack-pack placeholder: {${key}}`);
    return String(values[key as InterpolationKey] ?? "");
  });
}

function validateTemplates(value: unknown): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\{([^{}]+)\}/g)) {
      if (!ALLOWED_PLACEHOLDERS.has(match[1] as InterpolationKey)) throw new Error(`Unsupported stack-pack placeholder: {${match[1]}}`);
    }
    return;
  }
  if (Array.isArray(value)) value.forEach(validateTemplates);
  else if (value && typeof value === "object") Object.values(value).forEach(validateTemplates);
}

function packRoots(workspaceRoot: string): string[] {
  return [...new Set([
    path.join(workspaceRoot, "stacks"),
    path.join(workspaceRoot, "package", "stacks"),
    path.resolve(__dirname, "..", "..", "stacks"),
  ])];
}

export function listStackPacks(workspaceRoot: string): LoadedStackPack[] {
  const root = packRoots(workspaceRoot).find(fs.existsSync);
  if (!root) throw new Error(`[guildctl] Stack packs not found under ${workspaceRoot}`);
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "stack.yaml")))
    .map((entry) => loadStackPack(entry.name, workspaceRoot));
}

export function loadStackPack(id: string, workspaceRoot: string): LoadedStackPack {
  const dir = packRoots(workspaceRoot).map((root) => path.join(root, id)).find((candidate) => fs.existsSync(path.join(candidate, "stack.yaml")));
  if (!dir) throw new Error(`[guildctl] Unknown stack pack "${id}"`);
  const manifest = parse(fs.readFileSync(path.join(dir, "stack.yaml"), "utf8")) as StackManifest;
  const rules = parse(fs.readFileSync(path.join(dir, manifest.audit.rules_file), "utf8")) as StackAuditRule[];
  // The `verify:` block carries its own closed placeholder vocabulary, so it is
  // validated separately from the audit/scaffold interpolation vocabulary.
  const { verify, ...interpolated } = manifest;
  validateTemplates(interpolated);
  validateTemplates(rules);
  validateVerifyTemplates(verify);
  return { dir, manifest, rules };
}

export function loadActiveStack(config: GuildConfig | ResolvedGuildConfig, workspaceRoot: string): LoadedStackPack {
  return loadStackPack(config.stack, workspaceRoot);
}

export function readStackInstruction(pack: LoadedStackPack, kind: keyof StackManifest["instructions"]): string {
  return fs.readFileSync(path.join(pack.dir, pack.manifest.instructions[kind]), "utf8").trim();
}

function globRegex(glob: string): RegExp {
  let result = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*" && glob[index + 1] === "*") {
      if (glob[index + 2] === "/") { result += "(?:.*/)?"; index += 2; }
      else { result += ".*"; index += 1; }
    } else if (char === "*") result += "[^/]*";
    else result += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${result}$`);
}

export function matchesAnyGlob(relativePath: string, globs: string[]): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  return globs.some((glob) => globRegex(glob).test(normalized));
}

export function findMatchingFiles(dir: string, globs: string[]): string[] {
  const results: string[] = [];
  const visit = (current: string): void => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && matchesAnyGlob(path.relative(dir, full), globs)) results.push(full);
    }
  };
  visit(dir);
  return results;
}

// TASK-03: count files in dir that match a stack pack's source globs.
export function countFilesForStack(dir: string, pack: LoadedStackPack): number {
  return findMatchingFiles(dir, pack.manifest.source_globs).length;
}

// TASK-03: language census — count ALL source-like files under dir by extension
// (case-insensitive), ignoring node_modules/.git. Returns ext (lower-case, with
// leading dot) -> count, plus the total.
export function censusSourceFiles(dir: string): { counts: Map<string, number>; total: number } {
  const counts = new Map<string, number>();
  let total = 0;
  const visit = (current: string): void => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { visit(full); continue; }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!ext) continue;
      counts.set(ext, (counts.get(ext) ?? 0) + 1);
      total += 1;
    }
  };
  visit(dir);
  return { counts, total };
}

export function detectStack(workspaceRoot: string): string {
  const legacyRoot = path.join(workspaceRoot, "legacy");
  const matches = listStackPacks(workspaceRoot).filter((pack) => findMatchingFiles(legacyRoot, pack.manifest.detect.markers).length > 0);
  if (matches.length === 1) return matches[0]!.manifest.id;
  if (matches.length === 0) throw new Error("[guildctl] No stack pack matched legacy/. Pass --stack <id>.");
  throw new Error(`[guildctl] Multiple stack packs matched legacy/: ${matches.map((pack) => pack.manifest.id).join(", ")}. Pass --stack <id>.`);
}

export function collectProbeTargets(root: string, probe: ExternalProbe): string[] {
  const explicit = probe.targets.map((target) => path.join(root, target)).filter(fs.existsSync);
  const discovered = probe.target_suffixes ? findMatchingFiles(root, probe.target_suffixes) : [];
  return [...new Set([...explicit, ...discovered])];
}

export function runExternalProbes(root: string, probes: ExternalProbe[]): Array<{ name: string; available: boolean; inspected_inputs: number; note: string }> {
  return probes.map((probe) => {
    const available = spawnSync(probe.cmd, probe.availability_args, { stdio: "ignore" }).status === 0;
    const targets = collectProbeTargets(root, probe);
    if (available) for (const target of targets) spawnSync(probe.cmd, probe.args.map((arg) => interpolate(arg, { target })), { stdio: "ignore" });
    return { name: probe.name, available, inspected_inputs: targets.length, note: targets.length ? probe.available_note : probe.fallback_note };
  });
}
