import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import { printPhaseHeader } from "../dashboard";
import { resolveGuildConfig } from "../config";
import { loadActiveStack, type LoadedStackPack } from "../stack";

export type BootstrapProjectType = "web" | "service" | "library";
interface BootstrapArtifactSignal { path: string; module: string | null; role: string | null; framework: string | null }
export interface BootstrapResult {
  projectType: BootstrapProjectType;
  template: string;
  moduleRoot: string;
  basePackage: string;
  appName: string;
  created: string[];
  skipped: string[];
}

function activePack(workspaceRoot: string): LoadedStackPack {
  return loadActiveStack(resolveGuildConfig({ cwd: workspaceRoot }), workspaceRoot);
}

function listFirstClassArtifacts(db: Database.Database): BootstrapArtifactSignal[] {
  return db.prepare(`SELECT path, module, role, framework FROM artifacts WHERE tier = 'first-class' ORDER BY path`).all() as BootstrapArtifactSignal[];
}

export function detectBootstrapProjectType(artifacts: BootstrapArtifactSignal[], pack = activePack(process.cwd())): BootstrapProjectType {
  const descriptions = pack.manifest.project_types;
  for (const [name, description] of Object.entries(descriptions)) {
    if (!description.any) continue;
    const matched = artifacts.some((artifact) => {
      const role = (artifact.role ?? "").toLowerCase();
      const framework = (artifact.framework ?? "").toLowerCase();
      const filePath = artifact.path.toLowerCase();
      return description.any?.roles?.includes(role)
        || description.any?.frameworks?.some((signal) => framework.includes(signal))
        || description.any?.paths?.some((signal) => filePath.includes(signal));
    });
    if (matched) return name as BootstrapProjectType;
  }
  for (const [name, description] of Object.entries(descriptions)) {
    if (description.all_roles && artifacts.length > 0 && artifacts.every((artifact) => !artifact.role || description.all_roles!.includes(artifact.role.toLowerCase()))) {
      return name as BootstrapProjectType;
    }
  }
  return pack.manifest.scaffold.default_project_type as BootstrapProjectType;
}

function commonPrefix(modules: string[][]): string[] {
  if (modules.length === 0) return [];
  const prefix = [...modules[0]!];
  for (const parts of modules.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < parts.length && prefix[index] === parts[index]) index += 1;
    prefix.splice(index);
    if (prefix.length === 0) break;
  }
  return prefix;
}

function sanitizePackage(input: string, fallback: string): string {
  const cleaned = input.split(".").map((part) => part.toLowerCase().replace(/[^a-z0-9_]/g, "")).filter(Boolean);
  return cleaned.length > 0 ? cleaned.join(".") : fallback;
}

export function deriveBootstrapBasePackage(artifacts: BootstrapArtifactSignal[], fallback = activePack(process.cwd()).manifest.scaffold.default_package): string {
  const moduleParts = artifacts.map((artifact) => artifact.module).filter((module): module is string => Boolean(module)).map((module) => module.split(".").filter(Boolean));
  const prefix = commonPrefix(moduleParts);
  const candidate = prefix.length > 0 ? prefix.join(".") : artifacts.find((artifact) => artifact.module)?.module ?? fallback;
  return sanitizePackage(candidate, fallback);
}

function deriveAppName(basePackage: string, fallback: string): string {
  const lastSegment = basePackage.split(".").filter(Boolean).at(-1) ?? fallback;
  return lastSegment.replace(/[^a-z0-9-]/gi, "-").toLowerCase() || fallback;
}

function className(appName: string, marker: string): string {
  return `${appName.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("")}${marker}`;
}

function maybeWriteFile(filePath: string, content: string, workspaceRoot: string, created: string[], skipped: string[]): void {
  if (fs.existsSync(filePath)) { skipped.push(path.relative(workspaceRoot, filePath) || filePath); return; }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  created.push(path.relative(workspaceRoot, filePath) || filePath);
}

function render(template: string, replacements: Array<[string, string]>): string {
  return replacements.reduce((content, [marker, value]) => content.replaceAll(marker, value), template);
}

function hasSource(dirPath: string, extension: string): boolean {
  if (!fs.existsSync(dirPath)) return false;
  return fs.readdirSync(dirPath, { withFileTypes: true }).some((entry) => {
    const fullPath = path.join(dirPath, entry.name);
    return entry.isDirectory() ? hasSource(fullPath, extension) : entry.isFile() && entry.name.endsWith(extension);
  });
}

export function isBootstrapComplete(workspaceRoot: string, projectType: BootstrapProjectType): boolean {
  const pack = activePack(workspaceRoot);
  const scaffold = pack.manifest.scaffold;
  const modernRoot = path.join(workspaceRoot, "modern");
  if (!fs.existsSync(path.join(modernRoot, scaffold.build_file)) || !fs.existsSync(path.join(modernRoot, scaffold.settings_file))) return false;
  if (!fs.existsSync(path.join(modernRoot, scaffold.main_source_dir)) || !fs.existsSync(path.join(modernRoot, scaffold.test_source_dir))) return false;
  if (projectType === scaffold.library_project_type) return true;
  return fs.existsSync(path.join(modernRoot, scaffold.resources_dir, scaffold.resources_file))
    && hasSource(path.join(modernRoot, scaffold.main_source_dir), scaffold.source_extension);
}

export function needsBootstrap(db: Database.Database, workspaceRoot = process.cwd()): boolean {
  const pack = activePack(workspaceRoot);
  return !isBootstrapComplete(workspaceRoot, detectBootstrapProjectType(listFirstClassArtifacts(db), pack));
}

export function bootstrapTargetModule(workspaceRoot: string, artifacts: BootstrapArtifactSignal[]): BootstrapResult {
  const pack = activePack(workspaceRoot);
  const scaffold = pack.manifest.scaffold;
  const projectType = detectBootstrapProjectType(artifacts, pack);
  const description = pack.manifest.project_types[projectType];
  if (!description) throw new Error(`[guildctl] Project type not described by stack pack: ${projectType}`);
  const basePackage = deriveBootstrapBasePackage(artifacts, scaffold.default_package);
  const appName = deriveAppName(basePackage, scaffold.default_app_name);
  const generatedClass = className(appName, scaffold.app_class_marker);
  const modernRoot = path.join(workspaceRoot, "modern");
  const packagePath = basePackage.replaceAll(".", path.sep);
  const created: string[] = [];
  const skipped: string[] = [];
  const template = path.basename(description.template);
  const mainRoot = path.join(modernRoot, scaffold.main_source_dir, packagePath);
  fs.mkdirSync(mainRoot, { recursive: true });
  fs.mkdirSync(path.join(modernRoot, scaffold.test_source_dir, packagePath), { recursive: true });
  if (projectType !== scaffold.library_project_type) fs.mkdirSync(path.join(modernRoot, scaffold.resources_dir), { recursive: true });

  const buildTemplate = fs.readFileSync(path.join(pack.dir, description.template), "utf8");
  maybeWriteFile(path.join(modernRoot, scaffold.build_file), render(buildTemplate, [[scaffold.group_marker, basePackage]]), workspaceRoot, created, skipped);
  const settingsTemplate = fs.readFileSync(path.join(pack.dir, scaffold.settings_template), "utf8");
  maybeWriteFile(path.join(modernRoot, scaffold.settings_file), render(settingsTemplate, [[scaffold.app_name_marker, appName]]), workspaceRoot, created, skipped);
  if (projectType !== scaffold.library_project_type) {
    const resourcesTemplate = fs.readFileSync(path.join(pack.dir, scaffold.resources_template), "utf8");
    maybeWriteFile(path.join(modernRoot, scaffold.resources_dir, scaffold.resources_file), render(resourcesTemplate, [[scaffold.app_name_marker, appName]]), workspaceRoot, created, skipped);
    const applicationTemplate = fs.readFileSync(path.join(pack.dir, scaffold.application_template), "utf8");
    const rendered = render(applicationTemplate, [[scaffold.package_marker, basePackage], [scaffold.app_class_marker, generatedClass]]);
    maybeWriteFile(path.join(mainRoot, `${generatedClass}${scaffold.source_extension}`), rendered, workspaceRoot, created, skipped);
  }
  return { projectType, template, moduleRoot: modernRoot, basePackage, appName, created, skipped };
}

export async function runBootstrap(db: Database.Database, workspaceRoot = process.cwd()): Promise<BootstrapResult> {
  printPhaseHeader("Phase 3 · Bootstrap");
  const pack = activePack(workspaceRoot);
  const artifacts = listFirstClassArtifacts(db);
  const projectType = detectBootstrapProjectType(artifacts, pack);
  const basePackage = deriveBootstrapBasePackage(artifacts, pack.manifest.scaffold.default_package);
  if (!needsBootstrap(db, workspaceRoot)) {
    const result: BootstrapResult = { projectType, template: path.basename(pack.manifest.project_types[projectType]!.template), moduleRoot: path.join(workspaceRoot, "modern"), basePackage, appName: deriveAppName(basePackage, pack.manifest.scaffold.default_app_name), created: [], skipped: ["modern/ (already scaffolded)"] };
    console.log("  Target module already looks bootstrapped — skipping.\n");
    return result;
  }
  const result = bootstrapTargetModule(workspaceRoot, artifacts);
  console.log(`  Project type: ${result.projectType}\n  Base package: ${result.basePackage}\n  App name:     ${result.appName}\n`);
  if (result.created.length) { console.log("  Created:"); result.created.forEach((file) => console.log(`    + ${file}`)); console.log(); }
  if (result.skipped.length) { console.log("  Skipped:"); result.skipped.forEach((file) => console.log(`    - ${file}`)); console.log(); }
  console.log("  ✓ Bootstrap complete\n");
  return result;
}
