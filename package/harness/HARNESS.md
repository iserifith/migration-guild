# Harness Adapters

Migration Guild's runner (`guildctl`) spawns agents through a **harness adapter** — a thin shim that translates the runner's CLI contract into a specific agent CLI's invocation format. The runner handles logging, claim management, warden snapshots, and liveliness timers. The harness just needs to run the agent and produce stdout + an exit code.

## Contract

Every harness adapter is a Node `.mjs` script that accepts these arguments:

```
node package/harness/<name>.mjs --agent <agent-name> --model <model> [--yolo|--read-only] -p "<prompt>"
```

| Flag | Purpose |
|---|---|
| `--agent` | Agent persona name. Adapter loads `.github/agents/<name>.agent.md` or `package/agents/<name>.agent.md`, strips frontmatter, prepends body to prompt. |
| `--model` | Model identifier passed to the agent CLI. |
| `--yolo` | Auto-approve all tool calls (write mode). |
| `--read-only` | Deny write operations (read-only mode). |
| `-p` / `--prompt` | The task prompt from the runner. |

### Environment variables

The runner sets these before spawning the adapter:

| Env var | Purpose |
|---|---|
| `AGENT_PROVIDER_BASE_URL` | OpenAI-compatible base URL (opencode adapter) |
| `AGENT_PROVIDER_API_KEY_ENV` | Name of the env var holding the API key (opencode adapter) |
| `GUILDCTL_AGENT_NAME` | Claim owner identifier |
| `GUILDCTL_AGENT_KIND` | Agent kind (e.g. `remediation-agent`) |
| `GUILDCTL_RUN_ID` | Run ID for registry correlation |
| `GUILDCTL_ARTIFACT_ID` | Pre-claimed artifact ID |
| `GUILDCTL_CLAIM_ID` | Pre-claimed claim ID |
| `GUILDCTL_CLAIM_TOKEN` | Pre-claimed claim token |
| `GUILD_OPENCODE_USAGE_FILE` | Path to write token usage JSON (all adapters) |

### Token usage file

After the agent exits, the adapter writes a JSON file to `GUILD_OPENCODE_USAGE_FILE` with this shape:

```json
{
  "input": 20018,
  "output": 69,
  "reasoning": 0,
  "cacheRead": 0,
  "cacheWrite": 0,
  "fresh": 20087,
  "total": 20087,
  "events": 1
}
```

The runner reads this and records it against the run.

## Available harnesses

### `goose` (recommended for memory-constrained environments)

[Goose](https://github.com/aaif-goose/goose) is a native Rust AI agent CLI by Block/AAIF. It has built-in shell and file tools, supports OpenAI-compatible providers via declarative JSON config, and runs non-interactively with `goose run --no-session`.

**Memory:** ~113MB RSS per agent (vs opencode's ~478MB — 4.2× lighter).

**Best for:** Remediation, review, audit, context, and planner agents — anything that runs shell commands and reads/writes files.

**Limitation:** No read-only-with-tools mode. `--read-only` sets `GOOSE_MODE=chat` which disables all tools entirely. If you need agents that can read files but not write, use `--yolo` and rely on the persona instructions, or use opencode which has granular `--read-only`.

#### Setup

1. **Install goose:**

   Linux/macOS:
   ```bash
   curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash
   ```

   Windows (PowerShell):
   ```powershell
   # Download the Windows zip from https://github.com/aaif-goose/goose/releases
   # Extract goose.exe to a directory on your PATH (e.g., %USERPROFILE%\.local\bin)
   # Or use winget if available:
   winget install goose
   ```

   Verify:
   ```bash
   goose --version
   ```

2. **Create the provider JSON:**

   Linux/macOS — `~/.config/goose/custom_providers/guild.json`:
   ```json
   {
     "name": "custom_guild",
     "engine": "openai",
     "display_name": "Migration Guild",
     "description": "Guild provider via OpenAI-compatible endpoint",
     "api_key_env": "YOUR_API_KEY_ENV_VAR",
     "base_url": "https://your-provider.com/v1",
     "models": [
       { "name": "your-model-name", "context_limit": 131072 }
     ],
     "supports_streaming": true
   }
   ```

   Windows (PowerShell) — `%USERPROFILE%\.config\goose\custom_providers\guild.json`:
   ```powershell
   New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.config\goose\custom_providers"
   @'
   {
     "name": "custom_guild",
     "engine": "openai",
     "display_name": "Migration Guild",
     "description": "Guild provider via OpenAI-compatible endpoint",
     "api_key_env": "YOUR_API_KEY_ENV_VAR",
     "base_url": "https://your-provider.com/v1",
     "models": [
       { "name": "your-model-name", "context_limit": 131072 }
     ],
     "supports_streaming": true
   }
   '@ | Set-Content "$env:USERPROFILE\.config\goose\custom_providers\guild.json"
   ```

   The `api_key_env` field names the environment variable that holds your API key. Goose reads it at runtime — the key itself is never in the JSON.

3. **Set environment variables:**

   Linux/macOS:
   ```bash
   export GOOSE_PROVIDER=custom_guild
   export YOUR_API_KEY_ENV_VAR=your-key-here
   ```

   Windows (PowerShell):
   ```powershell
   $env:GOOSE_PROVIDER = "custom_guild"
   $env:YOUR_API_KEY_ENV_VAR = "your-key-here"
   # Or set permanently:
   [Environment]::SetEnvironmentVariable("GOOSE_PROVIDER", "custom_guild", "User")
   [Environment]::SetEnvironmentVariable("YOUR_API_KEY_ENV_VAR", "your-key-here", "User")
   ```

4. **Set harness in guild config:**

   In `.guild/config.yaml`:
   ```yaml
   harness: goose
   ```

   Or via env var:
   ```bash
   export GUILDCTL_HARNESS=goose
   ```

5. **Override goose binary path (optional):**

   If goose isn't on PATH, set `GOOSE_CLI_PATH`:
   ```bash
   export GOOSE_CLI_PATH=/path/to/goose
   ```
   ```powershell
   $env:GOOSE_CLI_PATH = "C:\path\to\goose.exe"
   ```

#### How it works

The adapter (`package/harness/goose.mjs`) does:

1. Loads the agent persona markdown.
2. Builds the claim handoff block from `GUILDCTL_*` env vars.
3. Concatenates persona + claim handoff + prompt.
4. Sets `GOOSE_MODE` based on `--yolo` (auto) or `--read-only` (chat).
5. Spawns `goose run --no-session --quiet --output-format stream-json --stats --model <model> -t "<full prompt>"`.
6. Parses stream-json events: renders text and tool-call summaries to stdout, captures token usage from the `complete` event.
7. Writes token usage JSON to `GUILD_OPENCODE_USAGE_FILE`.
8. Propagates the child exit code.

#### GOOSE_MODE reference

| Mode | Behavior | When to use |
|---|---|---|
| `auto` | Auto-approve all tool calls | `--yolo` flag (default) |
| `chat` | No tools — text only | `--read-only` flag |
| `smart_approve` | Ask for sensitive calls only | Interactive only (not for guild) |
| `approve` | Ask before every tool call | Interactive only (not for guild) |

### `opencode` (default, full-featured)

[OpenCode](https://opencode.ai) is a Node-based agent CLI with plugin support, granular tool permissions, and `@ai-sdk/openai-compatible` provider integration. It's the default harness.

**Memory:** ~478MB RSS per agent (Node + AI SDK runtime).

**Best for:** Codegen, test-writer, and migration agents that need richer tooling, session state, or granular read-only permissions.

**Provider config:** The adapter writes a temporary `opencode.json` config to a temp directory, exposing only the configured provider. Set via `AGENT_PROVIDER_BASE_URL` and `AGENT_PROVIDER_API_KEY_ENV` env vars.

**Read-only mode:** `--read-only` sets `permission: { "*": "allow", edit: "deny" }` — allows reads and shell commands but denies file writes. This is more granular than goose.

### `codex`

[OpenAI Codex CLI](https://github.com/openai/codex) adapter. Simplest adapter — just spawns codex with `--sandbox workspace-write` (or `read-only`) and `--ask-for-approval never`.

**Best for:** Environments where codex is already installed and you want OpenAI's native tooling.

### Custom harness (`AGENT_CMD`)

Set `AGENT_CMD=/path/to/your/agent` to use any CLI that accepts the harness contract (same `--agent`, `--model`, `--yolo`, `-p` flags). The custom command is responsible for persona loading and provider configuration.

## Selecting a harness

| Criteria | Recommended harness |
|---|---|
| Memory-constrained VPS, many concurrent agents | `goose` |
| Need granular read-only (read but don't write) | `opencode` |
| Rich tooling, plugins, session state | `opencode` |
| OpenAI-native environment | `codex` |
| Remediation, review, audit agents (shell + file only) | `goose` |
| Codegen, test-writer, migration agents | `opencode` |

You can mix harnesses per workspace. Set `harness: goose` in `.guild/config.yaml` for the default, then override per-run with `AGENT_CMD` if a specific agent needs opencode.

## Troubleshooting

### Goose not found

```
active harness: goose (goose is missing or unreachable)
```

Fix: Install goose, or set `GOOSE_CLI_PATH` to the binary path.

### Authentication error

```
Authentication error: Authentication failed for .../chat/completions. Status: 401 Unauthorized.
```

The API key env var named in your provider JSON is missing or inactive. Check:
1. The `api_key_env` field in `~/.config/goose/custom_providers/guild.json` matches a real env var.
2. That env var is set and contains a valid key.

### Goose spawns but no output

Ensure `GOOSE_PROVIDER` is set to the provider name (e.g., `custom_guild`) and the model name matches what's in the provider JSON's `models` array.

### Windows: goose.exe not on PATH

```powershell
# Check if goose is on PATH
Get-Command goose -ErrorAction SilentlyContinue

# If not, add it
$env:PATH += ";$env:USERPROFILE\.local\bin"
# Or set GOOSE_CLI_PATH directly
$env:GOOSE_CLI_PATH = "$env:USERPROFILE\.local\bin\goose.exe"
```
