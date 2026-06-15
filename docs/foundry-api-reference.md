# Microsoft AI Foundry — Reference for Migration Guild

Local reference extracted from official Microsoft documentation.
Sources: learn.microsoft.com/azure/ai-foundry, last fetched 2026-04-01.

---

## Endpoint overview

Your Foundry resource exposes two distinct endpoints with different API shapes:

| Endpoint | URL format | Used for |
|---|---|---|
| **Azure OpenAI v1** | `https://<resource>.openai.azure.com/openai/v1` | Chat completions, embeddings, batch, files |
| **Foundry project** | `https://<resource>.services.ai.azure.com/api/projects/<project>` | Agents, threads, runs, evaluations |

Your values:
```
FOUNDRY_OPENAI_ENDPOINT=https://Migration Guild.openai.azure.com/openai/v1
FOUNDRY_PROJECT_ENDPOINT=https://Migration Guild.services.ai.azure.com/api/projects/Migration Guild
```

These are **different API surfaces** — do not mix them up. The OpenAI endpoint follows
the standard OpenAI API format (model in request body). The project endpoint follows the
Azure AI Agents / Foundry SDK shape (REST paths under the project URL).

---

## Authentication

Both endpoints accept:
- **API key**: `api-key: <key>` request header
- **Entra ID token**: `Authorization: Bearer <token>` (recommended for production)

For API key auth used in Migration Guild, pass `api-key` header on every request.

---

## 1. Azure OpenAI v1 — Chat Completions

```
POST {openaiEndpoint}/chat/completions
```

No `api-version` query param required (v1 is implied). Model specified in the request body
— **no deployment name in the URL path** (unlike the older `/openai/deployments/{model}/...` format).

### Request body

```json
{
  "model": "gpt-4o",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user",   "content": "Explain Spring Boot @RestController." }
  ],
  "temperature": 0.2,
  "max_tokens": 1000
}
```

### Response

```json
{
  "id": "chatcmpl-...",
  "model": "gpt-4o",
  "choices": [{
    "message": { "role": "assistant", "content": "..." },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 42,
    "completion_tokens": 120,
    "total_tokens": 162
  }
}
```

---

## 2. Azure OpenAI v1 — Embeddings

```
POST {openaiEndpoint}/embeddings
```

### Request body

```json
{
  "model": "text-embedding-3-large",
  "input": "public class UserService { ... }"
}
```

Input can be a string or array of strings. Max input length ~8191 tokens.

### Response

```json
{
  "model": "text-embedding-3-large",
  "data": [{ "index": 0, "embedding": [0.012, -0.034, ...] }],
  "usage": { "prompt_tokens": 18, "total_tokens": 18 }
}
```

---

## 3. Azure OpenAI v1 — Batch

Async batch processing for large workloads. Two-step: upload JSONL file, then submit job.

### Step 1 — Upload file

```
POST {openaiEndpoint}/files
Content-Type: multipart/form-data

purpose=batch
file=<JSONL content>
```

Each line of the JSONL must be:
```json
{
  "custom_id": "artifact:module:ClassName",
  "method": "POST",
  "url": "/v1/chat/completions",
  "body": {
    "model": "gpt-4o",
    "messages": [{ "role": "user", "content": "..." }],
    "max_tokens": 500
  }
}
```

Note: `url` field uses `/v1/chat/completions` or `/v1/embeddings` (NOT `/openai/v1/...`).

Response: `{ "id": "file-abc123", ... }`

### Step 2 — Submit batch job

```
POST {openaiEndpoint}/batches
```

```json
{
  "input_file_id": "file-abc123",
  "endpoint": "/v1/chat/completions",
  "completion_window": "24h"
}
```

Response: `{ "id": "batch-xyz", "status": "validating", ... }`

### Poll batch status

```
GET {openaiEndpoint}/batches/{batch_id}
```

Status values: `validating` → `in_progress` → `finalizing` → `completed` | `failed` | `cancelled`

When `completed`, response contains `output_file_id`.

### Download results

```
GET {openaiEndpoint}/files/{output_file_id}/content
```

Returns JSONL. Each line:
```json
{
  "custom_id": "artifact:module:ClassName",
  "response": {
    "status_code": 200,
    "body": {
      "choices": [{ "message": { "content": "..." } }],
      "usage": { "prompt_tokens": 20, "completion_tokens": 80 }
    }
  }
}
```

### Cancel batch

```
POST {openaiEndpoint}/batches/{batch_id}/cancel
```

---

## 4. Foundry Agents — REST API

Base URL: `{projectEndpoint}` = `https://Migration Guild.services.ai.azure.com/api/projects/Migration Guild`

All requests append `?api-version=2025-01-01-preview`.

### Create an agent (assistant)

```
POST {projectEndpoint}/assistants?api-version=2025-01-01-preview
```

```json
{
  "model": "gpt-4o",
  "name": "migration-agent",
  "instructions": "You are a Java migration engineer...",
  "tools": []
}
```

Response: `{ "id": "asst_abc123", "name": "migration-agent", ... }`

Store the `id` — reuse it for all runs. Don't create a new agent per artifact.

### Create a thread

```
POST {projectEndpoint}/threads?api-version=2025-01-01-preview
Content-Type: application/json

{}
```

Response: `{ "id": "thread_xyz", "created_at": 1234567890 }`

One thread per artifact, shared across migration + review phases.

### Add a message to a thread

```
POST {projectEndpoint}/threads/{thread_id}/messages?api-version=2025-01-01-preview
```

```json
{
  "role": "user",
  "content": "Here is the legacy Java file. Analyze and migrate it:\n\n<file content>"
}
```

### Create a run (start processing)

```
POST {projectEndpoint}/threads/{thread_id}/runs?api-version=2025-01-01-preview
```

```json
{
  "assistant_id": "asst_abc123",
  "instructions": "Optional per-run override instructions"
}
```

Response: `{ "id": "run_def456", "status": "queued" }`

### Poll run status

```
GET {projectEndpoint}/threads/{thread_id}/runs/{run_id}?api-version=2025-01-01-preview
```

Poll every 2s until terminal status:

| Status | Meaning |
|---|---|
| `queued` | Waiting to start |
| `in_progress` | Running |
| `requires_action` | Tool call needed (function calling) |
| `completed` | ✅ Done |
| `failed` | ❌ Error — check `last_error` |
| `cancelled` | Cancelled |
| `expired` | Timed out |

### List messages (get response)

```
GET {projectEndpoint}/threads/{thread_id}/messages?api-version=2025-01-01-preview
```

Returns `{ "data": [ { "role": "assistant", "content": [{ "type": "text", "text": { "value": "..." } }] }, ... ] }`

Most recent message is the agent's last response. Filter by `role: "assistant"`.

### Built-in tools available

| Tool | Use in Migration Guild |
|---|---|
| `code_interpreter` | Run `javac`/`mvn test` to verify compiled code |
| `file_search` | Search legacy codebase files attached to thread |
| `function` | Custom function calling |
| `bing_grounding` | Web search for framework docs |

Add tools to agent at creation time:
```json
{ "tools": [{ "type": "code_interpreter" }] }
```

---

## 5. Evaluations

Foundry evaluations run via the portal or SDK (Python). No REST API for submitting
evaluations programmatically in the current preview — use the portal or Python SDK.

**Portal flow:**
1. Go to Foundry portal → Evaluation → Create
2. Choose target: Agent, Model, or Dataset
3. Upload test dataset (CSV or JSONL)
4. Select evaluators:
   - **Quality**: coherence, groundedness, fluency, relevance (AI-assisted, needs GPT judge)
   - **Safety**: violence, hate, self-harm content filters (no judge model needed)
   - **Agent**: task completion, tool call accuracy, intent resolution
5. Submit — results appear in the Evaluation tab

**For Migration Guild's code-level evaluations**, we implement our own evaluators directly
(`no-legacy-imports`, `signature-preservation`, `test-coverage`, `correctness`)
using the Foundry chat API for the LLM-based `correctness` evaluator.

---

## 6. Tracing (OpenTelemetry / Azure Monitor)

Foundry integrates with Azure Monitor via Application Insights.

### Setup
1. In Foundry portal → Tracing → connect an Application Insights resource
2. Get the App Insights connection string from the portal

### In code (Python SDK pattern)
```python
from azure.monitor.opentelemetry import configure_azure_monitor
configure_azure_monitor(connection_string="InstrumentationKey=...")
```

### For Migration Guild (TypeScript)
Tracing is done locally via the `traces` SQLite table. Every call through
`FoundryClient` fires a `TraceHook`, writing span_name, model, tokens, latency,
and cost_usd to the local DB. Remote export to Azure Monitor is future work.

Environment variable to enable content recording:
```
AZURE_TRACING_GEN_AI_CONTENT_RECORDING_ENABLED=true
```

---

## 7. Token costs (approximate, USD per 1K tokens)

| Model | Input | Output |
|---|---|---|
| gpt-4o | $0.005 | $0.015 |
| gpt-4o-mini | $0.00015 | $0.0006 |
| gpt-35-turbo | $0.0005 | $0.0015 |
| text-embedding-3-large | $0.00013 | — |

These are list prices. Your enterprise agreement may differ.

---

## 8. API version reference

| Surface | Version to use |
|---|---|
| Azure OpenAI v1 (chat, embed, batch) | No version needed — v1 is implied; optionally `?api-version=preview` for preview features |
| Foundry Agents (threads, runs) | `?api-version=2025-01-01-preview` |
| Foundry classic agents (deprecated) | `?api-version=2024-05-01-preview` — avoid for new work |

---

## 9. SDK choice guide (for reference)

| You want | Use |
|---|---|
| Chat completions, embeddings, batch | OpenAI SDK or direct REST to `openai.azure.com/openai/v1` |
| Agents with persistent threads | Foundry SDK (`azure-ai-projects`) or REST to `services.ai.azure.com/api/projects/...` |
| Evaluations in code | Python `azure-ai-evaluation` package |
| Tracing to Azure Monitor | `azure-monitor-opentelemetry` + `AIProjectClient.telemetry` |

Migration Guild uses direct REST (no SDK) to keep the Node.js dependency footprint minimal.

---

## Sources

- https://learn.microsoft.com/en-us/azure/ai-foundry/how-to/develop/sdk-overview
- https://learn.microsoft.com/en-us/azure/ai-foundry/openai/latest
- https://learn.microsoft.com/en-us/azure/ai-foundry/openai/reference-preview-latest
- https://learn.microsoft.com/en-us/azure/ai-services/openai/reference
- https://learn.microsoft.com/en-us/azure/ai-foundry/agents/quickstart
- https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/tools/overview
- https://learn.microsoft.com/en-us/azure/ai-foundry/how-to/evaluate-generative-ai-app
- https://learn.microsoft.com/en-us/azure/ai-foundry/how-to/develop/trace-agents-sdk
