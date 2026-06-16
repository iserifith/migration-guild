import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import { printPhaseHeader } from "../dashboard";

export type BootstrapProjectType = "web" | "service" | "library";

interface BootstrapArtifactSignal {
  path: string;
  module: string | null;
  role: string | null;
  framework: string | null;
}

export interface BootstrapResult {
  projectType: BootstrapProjectType;
  template: string;
  moduleRoot: string;
  basePackage: string;
  appName: string;
  created: string[];
  skipped: string[];
}

function getAssetsDir(workspaceRoot: string): string {
  const packagedAssetsDir = path.join(
    workspaceRoot,
    "package",
    "skills",
    "target-module-bootstrap",
    "assets",
  );
  if (fs.existsSync(packagedAssetsDir)) {
    return packagedAssetsDir;
  }

  return path.join(
    workspaceRoot,
    ".github",
    "skills",
    "target-module-bootstrap",
    "assets",
  );
}

function listFirstClassArtifacts(db: Database.Database): BootstrapArtifactSignal[] {
  return db.prepare(`
    SELECT path, module, role, framework
    FROM artifacts
    WHERE tier = 'first-class'
    ORDER BY path
  `).all() as BootstrapArtifactSignal[];
}

export function detectBootstrapProjectType(
  artifacts: BootstrapArtifactSignal[],
): BootstrapProjectType {
  if (artifacts.length === 0) return "service";

  const isWeb = artifacts.some((artifact) => {
    const role = (artifact.role ?? "").toLowerCase();
    const framework = (artifact.framework ?? "").toLowerCase();
    const filePath = artifact.path.toLowerCase();
    return (
      role === "rest-endpoint" ||
      framework.includes("jax-rs") ||
      framework.includes("servlet") ||
      framework.includes("spring-mvc") ||
      framework.includes("spring-web") ||
      filePath.includes("/web/") ||
      filePath.includes("/controller/")
    );
  });
  if (isWeb) return "web";

  const libraryRoles = new Set(["utility", "model", "transformer", "interface", "test"]);
  const allLibraryLike = artifacts.every((artifact) => {
    const role = (artifact.role ?? "").toLowerCase();
    return !role || libraryRoles.has(role);
  });
  return allLibraryLike ? "library" : "service";
}

function commonPrefix(modules: string[][]): string[] {
  if (modules.length === 0) return [];
  const prefix = [...modules[0]!];
  for (const parts of modules.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < parts.length && prefix[i] === parts[i]) i += 1;
    prefix.splice(i);
    if (prefix.length === 0) break;
  }
  return prefix;
}

function sanitizeJavaPackage(input: string): string {
  const cleaned = input
    .split(".")
    .map((part) => part.toLowerCase().replace(/[^a-z0-9_]/g, ""))
    .filter(Boolean);
  return cleaned.length > 0 ? cleaned.join(".") : "com.example.migrated";
}

export function deriveBootstrapBasePackage(
  artifacts: BootstrapArtifactSignal[],
): string {
  const moduleParts = artifacts
    .map((artifact) => artifact.module)
    .filter((module): module is string => Boolean(module))
    .map((module) => module.split(".").filter(Boolean));
  const prefix = commonPrefix(moduleParts);
  if (prefix.length > 0) return sanitizeJavaPackage(prefix.join("."));
  const firstModule = artifacts.find((artifact) => artifact.module)?.module;
  return sanitizeJavaPackage(firstModule ?? "com.example.migrated");
}

function deriveAppName(basePackage: string): string {
  const lastSegment = basePackage.split(".").filter(Boolean).at(-1) ?? "migrated-app";
  return lastSegment.replace(/[^a-z0-9-]/gi, "-").toLowerCase() || "migrated-app";
}

function applyTemplate(template: string, replacements: Record<string, string>): string {
  return Object.entries(replacements).reduce(
    (content, [from, to]) => content.replaceAll(from, to),
    template,
  );
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function maybeWriteFile(
  filePath: string,
  content: string,
  workspaceRoot: string,
  created: string[],
  skipped: string[],
): void {
  if (fs.existsSync(filePath)) {
    skipped.push(path.relative(workspaceRoot, filePath) || filePath);
    return;
  }
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf-8");
  created.push(path.relative(workspaceRoot, filePath) || filePath);
}

function templateNameFor(projectType: BootstrapProjectType): string {
  switch (projectType) {
    case "web":
      return "build.gradle.web.template";
    case "library":
      return "build.gradle.library.template";
    default:
      return "build.gradle.service.template";
  }
}

function hasAnyJavaSource(dirPath: string): boolean {
  if (!fs.existsSync(dirPath)) return false;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory() && hasAnyJavaSource(fullPath)) return true;
    if (entry.isFile() && entry.name.endsWith(".java")) return true;
  }
  return false;
}

export function isBootstrapComplete(
  workspaceRoot: string,
  projectType: BootstrapProjectType,
): boolean {
  const modernRoot = path.join(workspaceRoot, "modern");
  const buildExists =
    fs.existsSync(path.join(modernRoot, "build.gradle")) ||
    fs.existsSync(path.join(modernRoot, "pom.xml"));
  const settingsExists = fs.existsSync(path.join(modernRoot, "settings.gradle"));
  const mainJavaExists = fs.existsSync(path.join(modernRoot, "src", "main", "java"));
  const testJavaExists = fs.existsSync(path.join(modernRoot, "src", "test", "java"));
  if (!buildExists || !settingsExists || !mainJavaExists || !testJavaExists) return false;
  if (projectType === "library") return true;

  const resourcesFile = path.join(modernRoot, "src", "main", "resources", "application.yml");
  return fs.existsSync(resourcesFile) && hasAnyJavaSource(path.join(modernRoot, "src", "main", "java"));
}

export function needsBootstrap(db: Database.Database, workspaceRoot = process.cwd()): boolean {
  const projectType = detectBootstrapProjectType(listFirstClassArtifacts(db));
  return !isBootstrapComplete(workspaceRoot, projectType);
}

export function bootstrapTargetModule(
  workspaceRoot: string,
  artifacts: BootstrapArtifactSignal[],
  assetsDir = getAssetsDir(workspaceRoot),
): BootstrapResult {
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`[guildctl] Bootstrap assets not found: ${assetsDir}`);
  }

  const projectType = detectBootstrapProjectType(artifacts);
  const basePackage = deriveBootstrapBasePackage(artifacts);
  const appName = deriveAppName(basePackage);
  const modernRoot = path.join(workspaceRoot, "modern");
  const packagePath = basePackage.replaceAll(".", path.sep);
  const created: string[] = [];
  const skipped: string[] = [];
  const template = templateNameFor(projectType);

  ensureDir(path.join(modernRoot, "src", "main", "java", packagePath));
  ensureDir(path.join(modernRoot, "src", "test", "java", packagePath));
  if (projectType !== "library") {
    ensureDir(path.join(modernRoot, "src", "main", "resources"));
  }

  const buildTemplate = fs.readFileSync(path.join(assetsDir, template), "utf-8");
  maybeWriteFile(
    path.join(modernRoot, "build.gradle"),
    applyTemplate(buildTemplate, { "group = 'com.example'": `group = '${basePackage}'` }),
    workspaceRoot,
    created,
    skipped,
  );

  maybeWriteFile(
    path.join(modernRoot, "settings.gradle"),
    `rootProject.name = '${appName}'\n`,
    workspaceRoot,
    created,
    skipped,
  );

  if (projectType !== "library") {
    maybeWriteFile(
      path.join(modernRoot, "src", "main", "resources", "application.yml"),
      "spring:\n  application:\n    name: " + appName + "\n",
      workspaceRoot,
      created,
      skipped,
    );
  }

  const appClassName = `${appName
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")}Application`;
  const appFile = path.join(modernRoot, "src", "main", "java", packagePath, `${appClassName}.java`);

  if (projectType !== "library") {
    maybeWriteFile(
      appFile,
      `package ${basePackage};

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class ${appClassName} {

    public static void main(String[] args) {
        SpringApplication.run(${appClassName}.class, args);
    }
}
`,
      workspaceRoot,
      created,
      skipped,
    );
  }

  return {
    projectType,
    template,
    moduleRoot: modernRoot,
    basePackage,
    appName,
    created,
    skipped,
  };
}

export async function runBootstrap(
  db: Database.Database,
  workspaceRoot = process.cwd(),
): Promise<BootstrapResult> {
  printPhaseHeader("Phase 3 · Bootstrap");
  const artifacts = listFirstClassArtifacts(db);
  const projectType = detectBootstrapProjectType(artifacts);

  if (!needsBootstrap(db, workspaceRoot)) {
    const modernRoot = path.join(workspaceRoot, "modern");
    const result: BootstrapResult = {
      projectType,
      template: templateNameFor(projectType),
      moduleRoot: modernRoot,
      basePackage: deriveBootstrapBasePackage(artifacts),
      appName: deriveAppName(deriveBootstrapBasePackage(artifacts)),
      created: [],
      skipped: ["modern/ (already scaffolded)"],
    };
    console.log("  Target module already looks bootstrapped — skipping.\n");
    return result;
  }

  const result = bootstrapTargetModule(workspaceRoot, artifacts);
  console.log(`  Project type: ${result.projectType}`);
  console.log(`  Base package: ${result.basePackage}`);
  console.log(`  App name:     ${result.appName}\n`);

  if (result.created.length > 0) {
    console.log("  Created:");
    for (const file of result.created) console.log(`    + ${file}`);
    console.log();
  }

  if (result.skipped.length > 0) {
    console.log("  Skipped:");
    for (const file of result.skipped) console.log(`    - ${file}`);
    console.log();
  }

  console.log("  ✓ Bootstrap complete\n");
  return result;
}
