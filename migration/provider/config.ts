import * as fs from "fs";
import * as path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export type LLMProvider = "agent" | "provider";
export type ProviderType = "openai" | "azure" | "anthropic";
export type PhaseKey = "inventory" | "planning" | "analysis" | "test-writing" | "code-writing" | "review" | "eval";
const VALID_PHASE_KEYS: PhaseKey[] = ["inventory", "planning", "analysis", "test-writing", "code-writing", "review", "eval"];
const VALID_PHASE_KEY_SET = new Set<string>(VALID_PHASE_KEYS);

export interface ProviderConfig {
  /**
   * Azure OpenAI endpoint for chat completions and batch.
   * Format: https://<resource>.openai.azure.com/openai/v1
   */
  openaiEndpoint: string;
  /**
   * Azure Cognitive Services endpoint for embeddings.
   * Falls back to openaiEndpoint if not set.
   * Format: https://<resource>.cognitiveservices.azure.com/openai/v1
   */
  embedEndpoint?: string;
  /**
   * OpenAI-compatible provider project endpoint for Agents, Threads, and Evals.
   * Format: https://<resource>.services.ai.azure.com/api/projects/<project>
   */
  projectEndpoint: string;
  /** API key — prefer ${PROVIDER_API_KEY} env interpolation */
  apiKey: string;
  /** Model name for chat/completions calls */
  chatModel: string;
  /** Model name for text-embedding calls */
  embeddingModel: string;
  /** Enable async batch inference (default: true) */
  batchEnabled: boolean;
  /**
   * AGENT_PROVIDER_TYPE value passed to agent CLI when using Provider as
   * the model backend. Use "openai" for /v1-style endpoints (default), "azure"
   * for deployment-based endpoints, or "anthropic".
   */
  providerType: ProviderType;
  /**
   * Per-model max_completion_tokens overrides. Reasoning models (e.g.
   * gpt-oss-120b) need higher limits to accommodate their think-before-answer
   * steps. Falls back to DEFAULT_MODEL_TOKENS if model not listed.
   *
   * Example:
   *   { "gpt-oss-120b": 8000, "gpt-5.4-mini": 2000, "gpt-5.4-nano": 500 }
   */
  modelTokenLimits?: Record<string, number>;
  /** Per-phase model overrides. Falls back to built-in defaults if not set. */
  phaseModels?: Partial<Record<PhaseKey, string>>;
  /** Per-phase provider overrides. Falls back to PHASE_PROVIDER_DEFAULTS if not set. */
  phaseProviders?: Partial<Record<PhaseKey, LLMProvider>>;
}

export interface EvalConfig {
  /**
   * Automatically advance artifact to 'completed' when all evaluators pass
   * and score >= passThreshold. If false, evaluation results are recorded
   * but status is not changed automatically.
   */
  autoAdvance: boolean;
  /** Minimum aggregate score to auto-advance (0.0–1.0, default: 0.85) */
  passThreshold: number;
  /** Evaluators to run. Omit to run all. */
  evaluators: Array<
    | "no-legacy-imports"
    | "signature-preservation"
    | "test-coverage"
    | "correctness"
  >;
}

export interface TracingConfig {
  /** Emit traces to OpenAI-compatible provider trace store (default: true when provider configured) */
  enabled: boolean;
  /** Only write traces to local registry traces table; do not send to Provider */
  localOnly: boolean;
}

export interface GuildctlConfig {
  /** Which provider handles LLM completions in the Provider MCP server */
  llmProvider: LLMProvider;
  provider?: ProviderConfig;
  eval?: Partial<EvalConfig>;
  tracing?: Partial<TracingConfig>;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_EVAL: EvalConfig = {
  autoAdvance: true,
  passThreshold: 0.85,
  evaluators: [
    "no-legacy-imports",
    "signature-preservation",
    "test-coverage",
    "correctness",
  ],
};

const DEFAULT_TRACING: TracingConfig = {
  enabled: true,
  localOnly: false,
};

/** Fallback token limit when a model is not in modelTokenLimits. */
export const DEFAULT_MODEL_TOKENS = 2000;

/**
 * Built-in token limits. Reasoning models (gpt-oss-*) need extra headroom
 * for their internal think steps before emitting content.
 */
export const BUILTIN_MODEL_TOKENS: Record<string, number> = {
  "gpt-oss-120b":       8000,
  "gpt-oss-20b":        4000,
  "gpt-5.4-mini":       2000,
  "gpt-5.4-nano":        500,
  "gpt-5-mini":         2000,
};

function validatePhaseOverrideMap<T>(
  section: "phaseModels" | "phaseProviders",
  overrides: unknown,
): Partial<Record<PhaseKey, T>> | undefined {
  if (overrides == null) return undefined;
  if (typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error(
      `[guildctl] provider.${section} must be an object keyed by phase name (${VALID_PHASE_KEYS.join(", ")}).`,
    );
  }

  const invalidKeys = Object.keys(overrides as Record<string, unknown>)
    .filter((key) => !VALID_PHASE_KEY_SET.has(key));
  if (invalidKeys.length > 0) {
    throw new Error(
      `[guildctl] provider.${section} contains unsupported phase key(s): ${invalidKeys.map((key) => `"${key}"`).join(", ")}. ` +
        `Use only: ${VALID_PHASE_KEYS.join(", ")}.`,
    );
  }

  return overrides as Partial<Record<PhaseKey, T>>;
}

const PHASE_MODEL_DEFAULTS: Record<PhaseKey, string> = {
  inventory:      "gpt-5.4-mini",
  planning:       "claude-sonnet-4.6",
  analysis:       "gpt-5-mini",
  "test-writing": "gpt-5.4-mini",
  "code-writing": "gpt-oss-120b",
  review:         "claude-sonnet-4.6",
  eval:           "gpt-5.4-mini",
};

export const PHASE_PROVIDER_DEFAULTS: Record<PhaseKey, LLMProvider> = {
  "inventory":    "provider",
  "planning":     "agent",
  "analysis":     "provider",
  "test-writing": "provider",
  "code-writing": "provider",
  "review":       "agent",
  "eval":         "provider",
};

/**
 * Resolve the model for a given migration phase. Consulting order:
 * 1. cfg.phaseModels[phase] if set
 * 2. Built-in phase defaults
 * 3. cfg.chatModel ?? "gpt-5.4-mini"
 */
export function resolvePhaseModel(
  phase: PhaseKey,
  cfg?: ProviderConfig
): string {
  return cfg?.phaseModels?.[phase]
    ?? PHASE_MODEL_DEFAULTS[phase]
    ?? cfg?.chatModel
    ?? "gpt-5.4-mini";
}

/**
 * Resolve the LLM provider for a given migration phase. Consulting order:
 * 1. cfg.phaseProviders[phase] if set
 * 2. PHASE_PROVIDER_DEFAULTS[phase]
 */
export function resolvePhaseProvider(phase: PhaseKey, cfg?: ProviderConfig): LLMProvider {
  return cfg?.phaseProviders?.[phase] ?? PHASE_PROVIDER_DEFAULTS[phase];
}

/**
 * Resolve max_completion_tokens for a given model name, consulting the
 * per-workspace override map first, then built-ins, then the global default.
 */
export function resolveTokenLimit(model: string, cfg?: ProviderConfig): number {
  return cfg?.modelTokenLimits?.[model]
    ?? BUILTIN_MODEL_TOKENS[model]
    ?? DEFAULT_MODEL_TOKENS;
}

const DEFAULT_CONFIG: GuildctlConfig = {
  llmProvider: "agent",
};

export function getConfigPath(workspaceRoot?: string): string {
  const root = workspaceRoot ?? process.cwd();
  return path.join(root, "guildctl.config.json");
}

// ─── Env interpolation ────────────────────────────────────────────────────────

/** Replace ${VAR_NAME} placeholders with environment variable values. */
function interpolateEnv(value: string, warnOnMissing = true): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    const v = process.env[name];
    if (v === undefined && warnOnMissing) {
      process.stderr.write(
        `[guildctl] Warning: environment variable ${name} is not set\n`
      );
    }
    return v ?? "";
  });
}

function interpolateProvider(cfg: ProviderConfig, warnOnMissingEnv = true): ProviderConfig {
  return {
    ...cfg,
    openaiEndpoint: interpolateEnv(cfg.openaiEndpoint, warnOnMissingEnv),
    embedEndpoint: cfg.embedEndpoint ? interpolateEnv(cfg.embedEndpoint, warnOnMissingEnv) : undefined,
    projectEndpoint: interpolateEnv(cfg.projectEndpoint, warnOnMissingEnv),
    apiKey: interpolateEnv(cfg.apiKey, warnOnMissingEnv),
    phaseModels: cfg.phaseModels,
    phaseProviders: cfg.phaseProviders,
  };
}

// ─── Reader ───────────────────────────────────────────────────────────────────

/**
 * Load and parse guildctl.config.json from the given workspace root (default: cwd).
 * Returns DEFAULT_CONFIG if no file is found — all Provider features will be
 * disabled and the system falls back to agent CLI.
 */
export function loadConfig(workspaceRoot?: string): GuildctlConfig {
  const configPath = getConfigPath(workspaceRoot);

  if (!fs.existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `[guildctl] Failed to parse guildctl.config.json: ${(err as Error).message}`
    );
  }

  const partial = raw as Partial<GuildctlConfig>;

  const config: GuildctlConfig = {
    llmProvider: partial.llmProvider ?? DEFAULT_CONFIG.llmProvider,
  };

  if (partial.provider) {
    const f = partial.provider;
    const phaseModels = validatePhaseOverrideMap<string>("phaseModels", f.phaseModels);
    const phaseProviders = validatePhaseOverrideMap<LLMProvider>("phaseProviders", f.phaseProviders);
    const shouldWarnOnMissingEnv =
      partial.llmProvider === "provider"
      || Object.values(phaseProviders ?? {}).includes("provider");
    config.provider = interpolateProvider({
      openaiEndpoint: f.openaiEndpoint ?? "",
      embedEndpoint: f.embedEndpoint,
      projectEndpoint: f.projectEndpoint ?? "",
      apiKey: f.apiKey ?? "",
      chatModel: f.chatModel ?? "gpt-5.4-nano",
      embeddingModel: f.embeddingModel ?? "text-embedding-ada-002",
      batchEnabled: f.batchEnabled ?? true,
      providerType: f.providerType ?? "openai",
      modelTokenLimits: f.modelTokenLimits,
      phaseModels,
      phaseProviders,
    }, shouldWarnOnMissingEnv);
  }

  if (partial.eval) {
    config.eval = { ...DEFAULT_EVAL, ...partial.eval };
  }

  if (partial.tracing) {
    config.tracing = { ...DEFAULT_TRACING, ...partial.tracing };
  }

  return config;
}

/**
 * Resolve the effective EvalConfig, merging user config with defaults.
 */
export function getEvalConfig(cfg: GuildctlConfig): EvalConfig {
  return { ...DEFAULT_EVAL, ...(cfg.eval ?? {}) };
}

/**
 * Resolve the effective TracingConfig, merging user config with defaults.
 */
export function getTracingConfig(cfg: GuildctlConfig): TracingConfig {
  return { ...DEFAULT_TRACING, ...(cfg.tracing ?? {}) };
}

/**
 * Assert that the Provider section is configured. Throws with a helpful message
 * if the caller needs Provider but it is not set up.
 */
export function requireProviderConfig(cfg: GuildctlConfig): ProviderConfig {
  if (!cfg.provider) {
    throw new Error(
      "[guildctl] Provider is not configured. Add a \"provider\" section to guildctl.config.json " +
        "with endpoint, apiKey, chatModel, and embeddingModel."
    );
  }
  if (!cfg.provider.openaiEndpoint || !cfg.provider.projectEndpoint || !cfg.provider.apiKey) {
    throw new Error(
      "[guildctl] Provider openaiEndpoint, projectEndpoint, or apiKey is missing. " +
        "Set PROVIDER_OPENAI_ENDPOINT, PROVIDER_PROJECT_ENDPOINT, and PROVIDER_API_KEY, or update guildctl.config.json."
    );
  }
  return cfg.provider;
}

export function requirePhaseProviderConfig(
  phase: PhaseKey,
  cfg: GuildctlConfig,
  opts: { batch?: boolean } = {},
): ProviderConfig {
  if (!cfg.provider) {
    throw new Error(
      `[guildctl] Phase "${phase}" is configured to use ${opts.batch ? "Provider batch" : "Provider"}, ` +
        "but no Provider config is present. Add a \"provider\" section to guildctl.config.json " +
        "with endpoint, apiKey, chatModel, and embeddingModel."
    );
  }

  const missing: string[] = [];
  if (!cfg.provider.openaiEndpoint) missing.push("PROVIDER_OPENAI_ENDPOINT");
  if (!cfg.provider.projectEndpoint) missing.push("PROVIDER_PROJECT_ENDPOINT");
  if (!cfg.provider.apiKey) missing.push("PROVIDER_API_KEY");

  if (missing.length > 0) {
    const missingList = missing.join(", ");
    throw new Error(
      `[guildctl] Phase "${phase}" is configured to use ${opts.batch ? "Provider batch" : "Provider"}, ` +
        `but ${missingList} ${missing.length === 1 ? "is" : "are"} not set. ` +
        `Set ${missingList} or update guildctl.config.json before rerunning.`
    );
  }

  return cfg.provider;
}
