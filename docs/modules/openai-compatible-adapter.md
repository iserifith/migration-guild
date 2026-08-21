# OpenAI-Compatible Client Adapter

**File:** `migration/guildctl/openai-compatible.ts`

The OpenAI-compatible client adapter is a lightweight, dependency-free implementation that provides a standard HTTP interface to any Large Language Model (LLM) provider supporting the OpenAI Chat Completions API format (such as OpenAI, Anthropic via standard adapters, LocalAI, vLLM, or OpenRouter).

Rather than pulling in heavy vendor-specific SDKs, the `OpenAICompatibleClient` relies strictly on native Node `fetch`, making it an easily auditable and stable layer through which all agent spawns flow.

## Architecture and Configuration

The client operates primarily on a `ResolvedGuildConfig` object, relying on the `model` configuration block to dynamically resolve target URLs, credentials, and default models at runtime.

### Instantiation and Config Resolution

When the `OpenAICompatibleClient` is instantiated, it takes a single dependency:

```typescript
export class OpenAICompatibleClient {
  constructor(private readonly cfg: ResolvedGuildConfig) {}
  // ...
}
```
*(Source: `migration/guildctl/openai-compatible.ts:30`)*

The `complete()` function (`migration/guildctl/openai-compatible.ts:32`) resolves its execution parameters directly from this config:

1. **`base_url`**: The endpoint for the completions API. If omitted, it falls back to the default OpenAI endpoint (`https://api.openai.com/v1`). It also gracefully handles trailing slashes by stripping them before appending `/chat/completions`.
2. **`api_key_env`**: Instead of storing the API key directly in the configuration, the system dictates *which environment variable* holds the key. For example, `api_key_env: "OPENROUTER_API_KEY"` instructs the client to read `process.env["OPENROUTER_API_KEY"]`. If this environment variable is declared but not populated, the client halts execution before attempting an HTTP request.
3. **`model`**: The target model string (e.g., `gpt-4o`, `claude-3-opus`). While this can be specified at the global configuration level (`cfg.model.model`), it can also be explicitly overridden per-request.

### The Request Contract

The client enforces a clean, constrained request interface (`OpenAICompletionRequest`) rather than accepting arbitrary, unvalidated payloads.

```typescript
export interface OpenAICompletionRequest {
  messages: OpenAIMessage[];
  tools?: unknown[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
}
```
*(Source: `migration/guildctl/openai-compatible.ts:8`)*

The actual HTTP payload is constructed selectively from this request. It guarantees that `model`, `messages`, and `temperature` are included, and conditionally attaches `tools` or `max_tokens` only if they are explicitly provided in the request object (`migration/guildctl/openai-compatible.ts:41-46`).

### The Response Contract

The client normalizes responses from various providers into a strict `OpenAICompletionResponse` interface:

```typescript
export interface OpenAICompletionResponse {
  content: string;
  raw: unknown;
  model: string;
}
```
*(Source: `migration/guildctl/openai-compatible.ts:17`)*

Normalization happens at the end of `complete()`. Since different providers (or different generations of an API) might nest the response text differently, the client makes a best-effort extraction:

```typescript
const content = raw?.choices?.[0]?.message?.content ?? raw?.choices?.[0]?.text ?? "";
```
*(Source: `migration/guildctl/openai-compatible.ts:60`)*

This ensures that the upstream agent logic always receives a standardized `content` string, while the `raw` property preserves the complete unmodified response for debugging or advanced use cases.

## Error Taxonomy and Diagnostics

Because this client is the nexus of all agent interactions, failure modes must be unambiguous. The module defines two specific error classes:

1. **`OpenAIConfigError`** (`migration/guildctl/openai-compatible.ts:23`)
   Thrown *before* any network activity occurs if the configuration is invalid.
   - Triggered if an `api_key_env` is specified but the environment variable is missing (`migration/guildctl/openai-compatible.ts:37`).
   - Triggered if neither the request nor the `ResolvedGuildConfig` provides a valid model identifier (`migration/guildctl/openai-compatible.ts:39`).

2. **`OpenAIHttpError`** (`migration/guildctl/openai-compatible.ts:24`)
   Thrown when the provider returns a non-OK HTTP status code. Crucially, this error captures both the HTTP status and the raw response body, preventing cryptic "fetch failed" errors and instead bubbling up the exact provider complaint (e.g., rate limits, invalid tool schemas).
   - Triggered if `!response.ok` (`migration/guildctl/openai-compatible.ts:57`).

## Execution Flow Walkthrough

1. An agent runner initiates a completion via `client.complete(request)`.
2. The client resolves `baseUrl`, `apiKeyEnv`, and `model` from `this.cfg.model`.
3. Pre-flight validations occur: `OpenAIConfigError` is thrown if the API key or model is missing.
4. The JSON payload is constructed.
5. The `fetch` call is made to `${baseUrl}/chat/completions` with the `authorization` header conditionally injected if an API key was resolved.
6. The response text is retrieved. If the HTTP status is not 2xx, an `OpenAIHttpError` is thrown containing the text body.
7. The text is parsed as JSON (with a resilient fallback to wrapping plain text if parsing fails, `migration/guildctl/openai-compatible.ts:59`).
8. The final `OpenAICompletionResponse` is returned, extracting the `content` string and forwarding the `raw` object.
