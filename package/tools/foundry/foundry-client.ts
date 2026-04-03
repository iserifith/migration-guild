import type { FoundryConfig } from "./config";

// ─── Request / response shapes ────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompleteRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  max_completion_tokens?: number;
}

export interface ChatCompleteResponse {
  id: string;
  model: string;
  choices: Array<{ message: ChatMessage; finish_reason: string }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface EmbedRequest {
  input: string | string[];
  model?: string;
}

export interface EmbedResponse {
  model: string;
  data: Array<{ index: number; embedding: number[] }>;
  usage: { prompt_tokens: number; total_tokens: number };
}

export interface BatchRequest {
  input_file_id: string;
  endpoint: "/chat/completions" | "/embeddings";
  completion_window: "24h";
  metadata?: Record<string, string>;
}

export interface BatchJobResponse {
  id: string;
  status: "validating" | "in_progress" | "finalizing" | "completed" | "failed" | "cancelled";
  output_file_id?: string;
  error_file_id?: string;
  created_at: number;
  completed_at?: number;
}

export interface FoundryClientOptions {
  /** Number of retry attempts on transient errors (default: 3) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 1000) */
  retryDelayMs?: number;
  /** Request timeout in ms (default: 60000) */
  timeoutMs?: number;
}

// ─── Trace hook ───────────────────────────────────────────────────────────────

export interface TraceEvent {
  spanName: string;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number;
  error?: string;
}

export type TraceHook = (event: TraceEvent) => void;

// ─── Client ───────────────────────────────────────────────────────────────────

export class FoundryClient {
  private readonly openaiEndpoint: string;
  private readonly embedEndpoint: string;
  private readonly defaultChatModel: string;
  private readonly defaultEmbeddingModel: string;
  private readonly apiKey: string;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;
  private traceHook?: TraceHook;

  constructor(cfg: FoundryConfig, opts: FoundryClientOptions = {}) {
    this.openaiEndpoint = cfg.openaiEndpoint.replace(/\/$/, "");
    // Embeddings may use a separate cognitiveservices.azure.com endpoint
    this.embedEndpoint = (cfg.embedEndpoint ?? cfg.openaiEndpoint).replace(/\/$/, "");
    this.apiKey = cfg.apiKey;
    this.defaultChatModel = cfg.chatModel;
    this.defaultEmbeddingModel = cfg.embeddingModel;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 1000;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  /** Register a hook that is called after every API call with trace data. */
  onTrace(hook: TraceHook): void {
    this.traceHook = hook;
  }

  // ─── Chat completions ──────────────────────────────────────────────────────
  // v1 endpoint: model in body, no deployment in URL path, no api-version needed

  async chatComplete(req: ChatCompleteRequest): Promise<ChatCompleteResponse> {
    const model = req.model ?? this.defaultChatModel;
    const url = `${this.openaiEndpoint}/chat/completions`;
    const start = Date.now();

    const body: Record<string, unknown> = {
      model,
      messages: req.messages,
      temperature: req.temperature ?? 0.2,
    };
    if (req.max_completion_tokens !== undefined) body["max_completion_tokens"] = req.max_completion_tokens;

    const response = await this.fetchWithRetry<ChatCompleteResponse>(url, {
      method: "POST",
      body: JSON.stringify(body),
    });

    this.emitTrace({
      spanName: "chat-complete",
      model,
      tokensIn: response.usage.prompt_tokens,
      tokensOut: response.usage.completion_tokens,
      latencyMs: Date.now() - start,
    });

    return response;
  }

  /** Convenience: single user prompt → assistant text response. */
  async complete(prompt: string, systemPrompt?: string, model?: string): Promise<string> {
    const messages: ChatMessage[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: prompt });
    const res = await this.chatComplete({ messages, model });
    return res.choices[0]?.message.content ?? "";
  }

  // ─── Embeddings ────────────────────────────────────────────────────────────

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    const model = req.model ?? this.defaultEmbeddingModel;
    const url = `${this.embedEndpoint}/embeddings`;
    const start = Date.now();

    const response = await this.fetchWithRetry<EmbedResponse>(url, {
      method: "POST",
      body: JSON.stringify({ model, input: req.input }),
    });

    this.emitTrace({
      spanName: "embed",
      model,
      tokensIn: response.usage.prompt_tokens,
      tokensOut: null,
      latencyMs: Date.now() - start,
    });

    return response;
  }

  /** Embed a single string and return the float vector. */
  async embedOne(text: string): Promise<number[]> {
    const res = await this.embed({ input: text });
    const first = res.data[0];
    if (!first) throw new Error("[FoundryClient] Empty embedding response");
    return first.embedding;
  }

  // ─── Batch jobs ────────────────────────────────────────────────────────────

  async submitBatchJob(req: BatchRequest): Promise<BatchJobResponse> {
    const url = `${this.openaiEndpoint}/batches`;
    return this.fetchWithRetry<BatchJobResponse>(url, {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  async pollBatchJob(foundryJobId: string): Promise<BatchJobResponse> {
    const url = `${this.openaiEndpoint}/batches/${foundryJobId}`;
    return this.fetchWithRetry<BatchJobResponse>(url, { method: "GET" });
  }

  async cancelBatchJob(foundryJobId: string): Promise<BatchJobResponse> {
    const url = `${this.openaiEndpoint}/batches/${foundryJobId}/cancel`;
    return this.fetchWithRetry<BatchJobResponse>(url, { method: "POST", body: "{}" });
  }

  // ─── File uploads (for batch input) ───────────────────────────────────────

  async uploadFile(content: string, filename: string): Promise<{ id: string }> {
    const url = `${this.openaiEndpoint}/files`;
    const form = new FormData();
    form.append("purpose", "batch");
    form.append("file", new Blob([content], { type: "application/jsonl" }), filename);

    const res = await fetch(url, {
      method: "POST",
      headers: { "api-key": this.apiKey },
      body: form,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`[FoundryClient] File upload failed ${res.status}: ${text}`);
    }

    return res.json() as Promise<{ id: string }>;
  }

  async downloadFile(fileId: string): Promise<string> {
    const url = `${this.openaiEndpoint}/files/${fileId}/content`;
    const res = await fetch(url, {
      headers: { "api-key": this.apiKey },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`[FoundryClient] File download failed ${res.status}: ${text}`);
    }
    return res.text();
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private async fetchWithRetry<T>(
    url: string,
    init: RequestInit,
    attempt = 0
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: controller.signal,
      });

      if (res.status === 429 || res.status >= 500) {
        if (attempt < this.maxRetries) {
          const delay = this.retryDelayMs * Math.pow(2, attempt);
          await sleep(delay);
          return this.fetchWithRetry<T>(url, init, attempt + 1);
        }
      }

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`[FoundryClient] HTTP ${res.status} ${res.statusText}: ${body}`);
      }

      return res.json() as Promise<T>;
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(`[FoundryClient] Request timed out after ${this.timeoutMs}ms: ${url}`);
      }
      if (attempt < this.maxRetries && isTransient(err)) {
        const delay = this.retryDelayMs * Math.pow(2, attempt);
        await sleep(delay);
        return this.fetchWithRetry<T>(url, init, attempt + 1);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private emitTrace(event: TraceEvent): void {
    this.traceHook?.(event);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransient(err: unknown): boolean {
  if (err instanceof TypeError && (err.message.includes("fetch") || err.message.includes("network"))) {
    return true;
  }
  return false;
}

/** Cosine similarity between two float vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("Vector length mismatch");
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
