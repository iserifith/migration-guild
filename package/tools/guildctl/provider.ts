import { ResolvedGuildConfig } from "./config";

export interface GuildMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  messages: GuildMessage[];
  tools?: unknown[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

export interface CompletionResponse {
  content: string;
  raw: unknown;
  model: string;
  provider: string;
}

export interface ModelProvider {
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

export class ProviderConfigError extends Error {}
export class ProviderHttpError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: string) { super(message); }
}

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(private readonly cfg: ResolvedGuildConfig) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const modelCfg = this.cfg.model;
    const baseUrl = (modelCfg.base_url ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const apiKeyEnv = modelCfg.api_key_env;
    const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
    if (apiKeyEnv && !apiKey) throw new ProviderConfigError(`Missing API key env var ${apiKeyEnv} for provider ${modelCfg.provider}`);
    const model = request.model ?? modelCfg.model;
    if (!model) throw new ProviderConfigError(`No model configured for provider ${modelCfg.provider}`);

    const payload: Record<string, unknown> = {
      model,
      messages: request.messages,
      temperature: request.temperature,
    };
    if (request.tools) payload.tools = request.tools;
    if (request.max_tokens) payload.max_tokens = request.max_tokens;

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) throw new ProviderHttpError(`Provider ${modelCfg.provider} returned HTTP ${response.status}`, response.status, text);
    let raw: any;
    try { raw = JSON.parse(text); } catch { raw = { text }; }
    const content = raw?.choices?.[0]?.message?.content ?? raw?.choices?.[0]?.text ?? "";
    return { content, raw, model, provider: modelCfg.provider };
  }
}

export function createModelProvider(cfg: ResolvedGuildConfig): ModelProvider {
  const provider = cfg.model.provider;
  if (["openai-compatible", "openrouter", "openai"].includes(provider)) return new OpenAICompatibleProvider(cfg);
  throw new ProviderConfigError(`Unsupported provider "${provider}". Configure provider: openai-compatible, openrouter, or openai.`);
}
