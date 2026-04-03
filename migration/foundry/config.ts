import * as fs from "fs";
import * as path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export type LLMProvider = "copilot" | "foundry";
export type ProviderType = "openai" | "azure" | "anthropic";
export type PhaseKey = "inventory" | "planning" | "test-writing" | "code-writing" | "review" | "eval";

export interface FoundryConfig {
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
   * Azure AI Foundry project endpoint for Agents, Threads, and Evals.
   * Format: https://<resource>.services.ai.azure.com/api/projects/<project>
   */
  projectEndpoint: string;
  /** API key — prefer ${FOUNDRY_API_KEY} env interpolation */
  apiKey: string;
  /** Model name for chat/completions calls */
  chatModel: string;
  /** Model name for text-embedding calls */
  embeddingModel: string;
  /** Enable async batch inference (default: true) */
  batchEnabled: boolean;
  /**
   * COPILOT_PROVIDER_TYPE value passed to Copilot CLI when using Foundry as
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
  /** Emit traces to Azure AI Foundry trace store (default: true when foundry configured) */
  enabled: boolean;
  /** Only write traces to local registry traces table; do not send to Foundry */
  localOnly: boolean;
}

export interface LegmodConfig {
  /** Which provider handles LLM completions in the Foundry MCP server */
  llmProvider: LLMProvider;
  foundry?: FoundryConfig;
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

const PHASE_MODEL_DEFAULTS: Record<PhaseKey, string> = {
  inventory:      "gpt-5.4-mini",
  planning:       "claude-sonnet-4.6",
  "test-writing": "gpt-5.4-mini",
  "code-writing": "gpt-oss-120b",
  review:         "claude-sonnet-4.6",
  eval:           "gpt-5.4-mini",
};

export const PHASE_PROVIDER_DEFAULTS: Record<PhaseKey, LLMProvider> = {
  "inventory":    "foundry",
  "planning":     "copilot",
  "test-writing": "foundry",
  "code-writing": "foundry",
  "review":       "copilot",
  "eval":         "foundry",
};

/**
 * Resolve the model for a given migration phase. Consulting order:
 * 1. cfg.phaseModels[phase] if set
 * 2. Built-in phase defaults
 * 3. cfg.chatModel ?? "gpt-5.4-mini"
 */
export function resolvePhaseModel(
  phase: PhaseKey,
  cfg?: FoundryConfig
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
export function resolvePhaseProvider(phase: PhaseKey, cfg?: FoundryConfig): LLMProvider {
  return cfg?.phaseProviders?.[phase] ?? PHASE_PROVIDER_DEFAULTS[phase];
}

/**
 * Resolve max_completion_tokens for a given model name, consulting the
 * per-workspace override map first, then built-ins, then the global default.
 */
export function resolveTokenLimit(model: string, cfg?: FoundryConfig): number {
  return cfg?.modelTokenLimits?.[model]
    ?? BUILTIN_MODEL_TOKENS[model]
    ?? DEFAULT_MODEL_TOKENS;
}

const DEFAULT_CONFIG: LegmodConfig = {
  llmProvider: "copilot",
};

// ─── Env interpolation ────────────────────────────────────────────────────────

/** Replace ${VAR_NAME} placeholders with environment variable values. */
function interpolateEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    const v = process.env[name];
    if (v === undefined) {
      process.stderr.write(
        `[legmod] Warning: environment variable ${name} is not set\n`
      );
    }
    return v ?? "";
  });
}

function interpolateFoundry(cfg: FoundryConfig): FoundryConfig {
  return {
    ...cfg,
    openaiEndpoint: interpolateEnv(cfg.openaiEndpoint),
    embedEndpoint: cfg.embedEndpoint ? interpolateEnv(cfg.embedEndpoint) : undefined,
    projectEndpoint: interpolateEnv(cfg.projectEndpoint),
    apiKey: interpolateEnv(cfg.apiKey),
    phaseModels: cfg.phaseModels,
    phaseProviders: cfg.phaseProviders,
  };
}

// ─── Reader ───────────────────────────────────────────────────────────────────

/**
 * Load and parse legmod.config.json from the given workspace root (default: cwd).
 * Returns DEFAULT_CONFIG if no file is found — all Foundry features will be
 * disabled and the system falls back to Copilot CLI.
 */
export function loadConfig(workspaceRoot?: string): LegmodConfig {
  const root = workspaceRoot ?? process.cwd();
  const configPath = path.join(root, "legmod.config.json");

  if (!fs.existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `[legmod] Failed to parse legmod.config.json: ${(err as Error).message}`
    );
  }

  const partial = raw as Partial<LegmodConfig>;

  const config: LegmodConfig = {
    llmProvider: partial.llmProvider ?? DEFAULT_CONFIG.llmProvider,
  };

  if (partial.foundry) {
    const f = partial.foundry;
    config.foundry = interpolateFoundry({
      openaiEndpoint: f.openaiEndpoint ?? "",
      embedEndpoint: f.embedEndpoint,
      projectEndpoint: f.projectEndpoint ?? "",
      apiKey: f.apiKey ?? "",
      chatModel: f.chatModel ?? "gpt-5.4-nano",
      embeddingModel: f.embeddingModel ?? "text-embedding-ada-002",
      batchEnabled: f.batchEnabled ?? true,
      providerType: f.providerType ?? "openai",
      modelTokenLimits: f.modelTokenLimits,
      phaseModels: f.phaseModels,
      phaseProviders: f.phaseProviders,
    });
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
export function getEvalConfig(cfg: LegmodConfig): EvalConfig {
  return { ...DEFAULT_EVAL, ...(cfg.eval ?? {}) };
}

/**
 * Resolve the effective TracingConfig, merging user config with defaults.
 */
export function getTracingConfig(cfg: LegmodConfig): TracingConfig {
  return { ...DEFAULT_TRACING, ...(cfg.tracing ?? {}) };
}

/**
 * Assert that the Foundry section is configured. Throws with a helpful message
 * if the caller needs Foundry but it is not set up.
 */
export function requireFoundryConfig(cfg: LegmodConfig): FoundryConfig {
  if (!cfg.foundry) {
    throw new Error(
      "[legmod] Foundry is not configured. Add a \"foundry\" section to legmod.config.json " +
        "with endpoint, apiKey, chatModel, and embeddingModel."
    );
  }
  if (!cfg.foundry.openaiEndpoint || !cfg.foundry.projectEndpoint || !cfg.foundry.apiKey) {
    throw new Error(
      "[legmod] Foundry openaiEndpoint, projectEndpoint, or apiKey is missing. " +
        "Set FOUNDRY_OPENAI_ENDPOINT, FOUNDRY_PROJECT_ENDPOINT, and FOUNDRY_API_KEY, or update legmod.config.json."
    );
  }
  return cfg.foundry;
}
