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
  validateTemplates(manifest);
  validateTemplates(rules);
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
