import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type JsonMap = Record<string, unknown>;

export interface GuildConfig {
  version: number;
  harness: string;
  workspace: { name: string; root: string };
  model: { model: string; base_url?: string | null; api_key_env?: string | null; context_length?: number };
  agents: Record<string, JsonMap>;
  tools: Record<string, boolean>;
  prompts: { directory: string; active_pack: string };
  evidence: { output_dir: string; include_git_diff: boolean; include_static_scan: boolean; include_dependency_scan: boolean };
  approval: { mode: "manual" | "smart" | "off"; destructive_commands: "manual" | "smart" | "off" };
  migration: { default_mode: string; require_evidence_before_intent: boolean; max_autonomous_steps: number };
  profiles: Record<string, JsonMap>;
}

export interface ResolvedGuildConfig extends GuildConfig {
  guildRoot: string;
  configPath: string;
  selectedProfile: string;
}

export const DEFAULT_GUILD_CONFIG: GuildConfig = {
  version: 1,
  harness: "codex",
  workspace: { name: "migration-guild-workspace", root: "." },
  model: {
    model: "deepseek-v4-pro",
    base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    api_key_env: "DASHSCOPE_API_KEY",
    context_length: 131072,
  },
  agents: {
    default: { model: "deepseek-v4-pro", temperature: 0.2 },
    cheap: { model: "deepseek-v4-flash", temperature: 0.2 },
    reviewer: { model: "glm-5.1", temperature: 0.1 },
  },
  tools: { terminal: true, git: true, filesystem: true, web: false },
  prompts: { directory: ".guild/prompts", active_pack: "default" },
  evidence: { output_dir: ".guild/evidence", include_git_diff: true, include_static_scan: true, include_dependency_scan: true },
  approval: { mode: "manual", destructive_commands: "manual" },
  migration: { default_mode: "init", require_evidence_before_intent: true, max_autonomous_steps: 3 },
  profiles: {
    default: { base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", model: "deepseek-v4-pro", api_key_env: "DASHSCOPE_API_KEY" },
    dashscope: { base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", model: "deepseek-v4-pro", api_key_env: "DASHSCOPE_API_KEY" },
    cheap: { base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", model: "deepseek-v4-flash", api_key_env: "DASHSCOPE_API_KEY" },
    reviewer: { base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", model: "glm-5.1", api_key_env: "DASHSCOPE_API_KEY" },
    qwen: { base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", model: "qwen3.7-max", api_key_env: "DASHSCOPE_API_KEY" },
    local: { base_url: "http://localhost:1234/v1", model: "qwen2.5-coder" },
  },
};

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
  fs.mkdirSync(path.join(guildDir, "prompts", "default"), { recursive: true });
  fs.mkdirSync(path.join(guildDir, "runs"), { recursive: true });
  fs.mkdirSync(path.join(guildDir, "evidence"), { recursive: true });
  writeGuildConfig(cfg, configPath);
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
