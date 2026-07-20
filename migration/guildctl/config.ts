import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type JsonMap = Record<string, unknown>;

export interface GuildConfig {
  version: number;
  stack: string;
  harness: string;
  workspace: { name: string; root: string };
  database: { path: string };
  model: { model: string; base_url?: string | null; api_key_env?: string | null; context_length?: number };
  provider: { routes: Record<string, string[] | string> };
  agents: Record<string, JsonMap>;
  tools: Record<string, boolean>;
  prompts: { directory: string; active_pack: string };
  evidence: { output_dir: string; include_git_diff: boolean; include_static_scan: boolean; include_dependency_scan: boolean };
  approval: { mode: "manual" | "smart" | "off"; destructive_commands: "manual" | "smart" | "off" };
  migration: { default_mode: string; require_evidence_before_intent: boolean; max_autonomous_steps: number };
  inventory: { classificationBatchSize: number; maxBatchRetries: number };
  // TASK-07: agent liveliness limits (seconds). inactivity = kill on silence;
  // ceiling = backstop wall-clock kill so a chatty-but-stuck agent can't run forever.
  agent_limits: { inactivity_timeout_seconds: number; ceiling_seconds: number };
  profiles: Record<string, JsonMap>;
}

export interface ResolvedGuildConfig extends GuildConfig {
  guildRoot: string;
  configPath: string;
  selectedProfile: string;
}

export const DEFAULT_GUILD_CONFIG: GuildConfig = {
  version: 1,
  stack: "java-spring",
  harness: "opencode",
  workspace: { name: "migration-guild-workspace", root: "." },
  database: { path: ".guild/registry.db" },
  model: {
    model: "fiq/kimi-k2.7-code",
    base_url: "https://rootsys.cloud/v1",
    api_key_env: "ROOTSYS_API_KEY",
    context_length: 131072,
  },
  provider: {
    routes: {
      default: ["fiq/kimi-k2.7-code", "fiq/deepseek-v4-pro"],
      census: ["fiq/minimax", "fiq/deepseek-v4-flash"],
      review: ["fiq/glm-5.2", "fiq/deepseek-v4-pro"],
    },
  },
  agents: {
    default: { model: "fiq/kimi-k2.7-code", temperature: 0.2 },
    cheap: { model: "fiq/minimax", temperature: 0.2 },
    reviewer: { model: "fiq/glm-5.2", temperature: 0.1 },
  },
  tools: { terminal: true, git: true, filesystem: true, web: false },
  prompts: { directory: ".guild/prompts", active_pack: "default" },
  evidence: { output_dir: ".guild/evidence", include_git_diff: true, include_static_scan: true, include_dependency_scan: true },
  approval: { mode: "manual", destructive_commands: "manual" },
  migration: { default_mode: "init", require_evidence_before_intent: true, max_autonomous_steps: 3 },
  inventory: { classificationBatchSize: 100, maxBatchRetries: 2 },
  agent_limits: { inactivity_timeout_seconds: 120, ceiling_seconds: 1800 },
  profiles: {
    default: { base_url: "https://rootsys.cloud/v1", model: "fiq/kimi-k2.7-code", api_key_env: "ROOTSYS_API_KEY" },
    dashscope: { base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", model: "deepseek-v4-pro", api_key_env: "DASHSCOPE_API_KEY" },
    cheap: { base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", model: "deepseek-v4-flash", api_key_env: "DASHSCOPE_API_KEY" },
    reviewer: { base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", model: "glm-5.1", api_key_env: "DASHSCOPE_API_KEY" },
    qwen: { base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", model: "qwen3.7-max", api_key_env: "DASHSCOPE_API_KEY" },
    local: { base_url: "http://localhost:1234/v1", model: "qwen2.5-coder" },
  },
};

export function resolveProviderRoute(config: GuildConfig, route: string): string[] {
  const routes = config.provider?.routes ?? {};
  const value = routes[route] ?? routes["default"] ?? config.model.model;
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

export function preflightProviderCredential(
  config: GuildConfig,
  env: Record<string, string | undefined> = process.env,
): { ok: true; envVar: string } {
  const envVar = config.model.api_key_env;
  if (!envVar) return { ok: true, envVar: "" };
  if (!env[envVar]) {
    throw new Error(`${envVar} is missing; export it in the trusted launcher environment before a live run`);
  }
  return { ok: true, envVar };
}

export function redactConfigForDisplay(
  config: GuildConfig,
  env: Record<string, string | undefined> = process.env,
): JsonMap {
  const redacted = clone(config as unknown as JsonMap);
  const envVar = config.model.api_key_env;
  if (envVar && env[envVar]) {
    redacted["credential"] = { env: envVar, value: "<redacted>" };
  }
  return redacted;
}

export function findGuildRoot(startDir = process.cwd()): string | undefined {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, ".guild"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function ensureGuildRoot(startDir = process.cwd()): string {
  return findGuildRoot(startDir) ?? path.resolve(startDir);
}

// Single source of truth for "which directory is the migration workspace".
// Precedence (first match wins): explicit --workspace flag, GUILD_WORKSPACE env,
// a .guild/ found by walking up from cwd, then the CLI install location (the
// shipped-kit default, preserved for backward compatibility).
export function resolveWorkspaceRoot(opts: { workspace?: string } = {}): string {
  if (opts.workspace) return path.resolve(opts.workspace);
  const env = process.env.GUILD_WORKSPACE;
  if (env) return path.resolve(env);
  const detected = findGuildRoot(process.cwd());
  if (detected) return detected;
  return path.resolve(__dirname, "..", "..", "..");
}

export function guildConfigPath(root = ensureGuildRoot()): string {
  return path.join(root, ".guild", "config.yaml");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function isObject(value: unknown): value is JsonMap {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function deepMerge<T extends JsonMap>(base: T, override: JsonMap | undefined): T {
  const out: JsonMap = clone(base);
  if (!override) return out as T;
  for (const [key, value] of Object.entries(override)) {
    if (isObject(value) && isObject(out[key])) out[key] = deepMerge(out[key] as JsonMap, value);
    else out[key] = value;
  }
  return out as T;
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (value === "null" || value === "~") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

export function parseSimpleYaml(content: string): JsonMap {
  const root: JsonMap = {};
  const stack: Array<{ indent: number; obj: JsonMap }> = [{ indent: -1, obj: root }];
  for (const rawLine of content.split(/\r?\n/)) {
    const noComment = rawLine.replace(/\s+#.*$/, "");
    if (!noComment.trim()) continue;
    const indent = noComment.match(/^\s*/)?.[0].length ?? 0;
    const line = noComment.trim();
    const match = line.match(/^([^:]+):(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    const rest = match[2].trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (rest === "") {
      const child: JsonMap = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
    } else {
      parent[key] = parseScalar(rest);
    }
  }
  return root;
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") {
    if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
    return JSON.stringify(value);
  }
  return String(value);
}

export function stringifySimpleYaml(value: JsonMap, indent = 0): string {
  const pad = " ".repeat(indent);
  return Object.entries(value)
    .map(([key, child]) => {
      if (isObject(child)) return `${pad}${key}:\n${stringifySimpleYaml(child, indent + 2)}`;
      return `${pad}${key}: ${formatScalar(child)}`;
    })
    .join("\n") + (indent === 0 ? "\n" : "");
}

export function readGuildConfig(configPath = guildConfigPath()): JsonMap {
  if (!fs.existsSync(configPath)) return {};
  const text = fs.readFileSync(configPath, "utf8");
  if (text.trim().startsWith("{")) return JSON.parse(text);
  return parseSimpleYaml(text);
}

export function writeGuildConfig(config: JsonMap, configPath = guildConfigPath()): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, stringifySimpleYaml(config), "utf8");
}


export interface RegistryDbPathOptions {
  explicitPath?: string;
  workspaceRoot?: string;
  env?: Record<string, string | undefined>;
  config?: JsonMap;
}

function resolvePathAgainstWorkspace(candidate: string, workspaceRoot: string): string {
  return path.isAbsolute(candidate) ? candidate : path.resolve(workspaceRoot, candidate);
}

export function resolveRegistryDbPath(options: RegistryDbPathOptions = {}): string {
  const env = options.env ?? process.env;
  if (options.explicitPath) return path.resolve(options.explicitPath);
  if (env["REGISTRY_DB"]) return path.resolve(String(env["REGISTRY_DB"]));

  const workspaceRoot = path.resolve(options.workspaceRoot ?? resolveWorkspaceRoot());
  const config = options.config ?? readGuildConfig(guildConfigPath(workspaceRoot));
  const database = isObject(config["database"]) ? config["database"] as JsonMap : undefined;
  const configured = typeof database?.["path"] === "string" ? String(database["path"]) : undefined;
  return resolvePathAgainstWorkspace(configured || ".guild/registry.db", workspaceRoot);
}

export function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}


export function findToolkitRoot(startDir = __dirname): string {
  const candidates = [
    path.resolve(startDir, "..", ".."),
    path.resolve(startDir, "..", "..", ".."),
    path.resolve(process.cwd(), ".."),
  ];
  for (const candidate of candidates) {
    if (["migration", "package", "stacks"].every((name) => fs.existsSync(path.join(candidate, name)))) return candidate;
  }
  return path.resolve(startDir, "..", "..");
}

export function registryPathWarning(dbPath: string, workspaceRoot: string, toolkitRoot = findToolkitRoot()): string | undefined {
  const resolved = path.resolve(dbPath);
  const workspace = path.resolve(workspaceRoot);
  const toolkit = path.resolve(toolkitRoot);
  if (isPathInside(resolved, workspace)) return undefined;
  const toolkitNote = isPathInside(resolved, toolkit) ? " (inside toolkit checkout)" : "";
  return `WARNING: registry database resolves outside workspace${toolkitNote}: ${resolved} (workspace: ${workspace})`;
}

function ensureLinkOrJunction(linkPath: string, targetPath: string): void {
  if (!fs.existsSync(targetPath)) throw new Error(`Cannot scaffold workspace link ${linkPath}: missing toolkit target ${targetPath}`);
  if (fs.existsSync(linkPath)) {
    const stat = fs.lstatSync(linkPath);
    if (fs.realpathSync(linkPath) !== fs.realpathSync(targetPath)) {
      // Existing tests and hand-built workspaces may materialize these directories
      // instead of linking them. Keep that idempotent path working; clean init still
      // creates links below.
      if (stat.isDirectory() && !stat.isSymbolicLink()) return;
      throw new Error(`Cannot scaffold workspace link ${linkPath}: already exists and points to ${fs.realpathSync(linkPath)}, expected ${fs.realpathSync(targetPath)}`);
    }
    return;
  }
  try {
    fs.symlinkSync(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
  } catch (err) {
    throw new Error(`Cannot scaffold workspace link ${linkPath} -> ${targetPath}: ${(err as Error).message}`);
  }
  if (fs.realpathSync(linkPath) !== fs.realpathSync(targetPath)) throw new Error(`Workspace link ${linkPath} did not resolve to ${targetPath}`);
}

export function scaffoldWorkspaceLinks(root: string, toolkitRoot = findToolkitRoot()): void {
  for (const name of ["migration", "package", "stacks"]) {
    ensureLinkOrJunction(path.join(root, name), path.join(toolkitRoot, name));
  }
}

export function resolveGuildConfig(options: { cwd?: string; profile?: string; overrides?: JsonMap } = {}): ResolvedGuildConfig {
  const guildRoot = ensureGuildRoot(options.cwd);
  const configPath = guildConfigPath(guildRoot);
  const fileConfig = readGuildConfig(configPath);
  let merged = deepMerge(DEFAULT_GUILD_CONFIG as unknown as JsonMap, fileConfig) as unknown as GuildConfig;
  const selectedProfile = options.profile ?? "default";
  const profile = merged.profiles?.[selectedProfile];
  if (selectedProfile !== "default" && !profile) {
    throw new Error(`Unknown Guild profile "${selectedProfile}". Available profiles: ${Object.keys(merged.profiles ?? {}).join(", ") || "none"}`);
  }
  if (isObject(profile)) {
    merged = deepMerge(merged as unknown as JsonMap, { model: profile }) as unknown as GuildConfig;
  }
  if (options.overrides) merged = deepMerge(merged as unknown as JsonMap, options.overrides) as unknown as GuildConfig;
  return { ...merged, guildRoot, configPath, selectedProfile };
}

export function setDottedPath(target: JsonMap, dottedPath: string, value: unknown): JsonMap {
  const parts = dottedPath.split(".").filter(Boolean);
  if (!parts.length) throw new Error("Config key cannot be empty");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!isObject(cursor[part])) cursor[part] = {};
    cursor = cursor[part] as JsonMap;
  }
  cursor[parts[parts.length - 1]] = typeof value === "string" ? parseScalar(value) : value;
  return target;
}

export function sanitizedConfigSnapshot(config: ResolvedGuildConfig | GuildConfig): JsonMap {
  const snap = clone(config as unknown as JsonMap);
  delete snap["guildRoot"];
  delete snap["configPath"];
  function scrub(obj: JsonMap): void {
    for (const [key, value] of Object.entries(obj)) {
      if (/api[_-]?key/i.test(key) && key !== "api_key_env") obj[key] = "<redacted>";
      else if (isObject(value)) scrub(value);
    }
  }
  scrub(snap);
  return snap;
}

export function scaffoldGuildConfig(root = process.cwd(), force = false): string {
  const guildDir = path.join(root, ".guild");
  const configPath = path.join(guildDir, "config.yaml");
  if (fs.existsSync(configPath) && !force) return configPath;
  const cfg = clone(DEFAULT_GUILD_CONFIG as unknown as JsonMap);
  (cfg.workspace as JsonMap).name = path.basename(root) || os.hostname();
  if (!isObject(cfg["database"])) cfg["database"] = {};
  (cfg["database"] as JsonMap)["path"] = ".guild/registry.db";
  fs.mkdirSync(path.join(guildDir, "prompts", "default"), { recursive: true });
  fs.mkdirSync(path.join(guildDir, "runs"), { recursive: true });
  fs.mkdirSync(path.join(guildDir, "evidence"), { recursive: true });
  writeGuildConfig(cfg, configPath);
  scaffoldWorkspaceLinks(root);
  const envExample = path.join(guildDir, ".env.example");
  if (!fs.existsSync(envExample) || force) fs.writeFileSync(envExample, "OPENROUTER_API_KEY=\nOPENAI_API_KEY=\nANTHROPIC_API_KEY=\n", "utf8");
  return configPath;
}


export type PhaseKey = "inventory" | "planning" | "analysis" | "test-writing" | "code-writing" | "review" | string;

export function loadConfig(): ResolvedGuildConfig {
  return resolveGuildConfig();
}

export function getConfigPath(): string {
  return guildConfigPath();
}

export function resolvePhaseModel(phase: PhaseKey, config: ResolvedGuildConfig | GuildConfig = loadConfig()): string {
  const agents = config.agents ?? {};
  const modelConfig = config.model;
  const byPhase: Record<string, string> = {
    inventory: "cheap",
    planning: "default",
    analysis: "cheap",
    "test-writing": "default",
    "code-writing": "default",
    review: "reviewer",
  };
  const agentKey = byPhase[String(phase)] ?? "default";
  const agent = agents[agentKey];
  const agentModel = agent && typeof agent["model"] === "string" ? String(agent["model"]) : undefined;
  return agentModel ?? modelConfig.model;
}
