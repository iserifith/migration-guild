import { ResolvedGuildConfig } from "./config";

export interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAICompletionRequest {
  messages: OpenAIMessage[];
  tools?: unknown[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

export interface OpenAICompletionResponse {
  content: string;
  raw: unknown;
  model: string;
}

export class OpenAIConfigError extends Error {}
export class OpenAIHttpError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: string) {
    super(message);
  }
}

export class OpenAICompatibleClient {
  constructor(private readonly cfg: ResolvedGuildConfig) {}

  async complete(request: OpenAICompletionRequest): Promise<OpenAICompletionResponse> {
    const modelCfg = this.cfg.model;
    const baseUrl = (modelCfg.base_url ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const apiKeyEnv = modelCfg.api_key_env;
    const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
    if (apiKeyEnv && !apiKey) throw new OpenAIConfigError(`Missing API key env var ${apiKeyEnv} for OpenAI-compatible runtime`);
    const model = request.model ?? modelCfg.model;
    if (!model) throw new OpenAIConfigError("No OpenAI-compatible model configured");

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
    if (!response.ok) throw new OpenAIHttpError(`OpenAI-compatible runtime returned HTTP ${response.status}`, response.status, text);
    let raw: any;
    try { raw = JSON.parse(text); } catch { raw = { text }; }
    const content = raw?.choices?.[0]?.message?.content ?? raw?.choices?.[0]?.text ?? "";
    return { content, raw, model };
  }
}
