#!/usr/bin/env node
// goose harness adapter. Contract (same as opencode.mjs / codex.mjs):
//   1. Accept --agent, --model, --yolo/--read-only, and -p/--prompt.
//   2. Prepend the body of .github/agents/<agent>.agent.md (or
//      package/agents/<agent>.agent.md) to the prompt.
//   3. Attach the claim handoff block from GUILDCTL_* env vars.
//   4. Run `goose run --no-session --output-format stream-json --stats`
//      non-interactively with GOOSE_MODE set from --yolo/--read-only.
//   5. Render readable output to stdout (text + tool calls), capture token
//      usage from the stream-json "complete" event, write it to
//      GUILD_OPENCODE_USAGE_FILE, and return the child's exit code.
//
// Goose is a native Rust binary (~113MB RSS vs opencode's ~478MB) with
// built-in shell and file tools. No Node AI SDK runtime, no plugin system,
// no temp config files. Provider is configured via
// ~/.config/goose/custom_providers/<name>.json (declarative OpenAI-compatible).
//
// Cross-platform: on Windows the goose binary may be `goose.exe` on PATH or
// installed via the download_cli.sh script to %USERPROFILE%\.local\bin.
// The GOOSE_CLI_PATH env var overrides the lookup (mirrors CODEX_CLI_PATH /
// OPENCODE_CLI_PATH from the other adapters).

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ─── Arg parsing ──────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = { agent: "", model: "", prompt: "", yolo: false, readOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--agent") out.agent = argv[++i] ?? "";
    else if (arg === "--model") out.model = argv[++i] ?? "";
    else if (arg === "--yolo") out.yolo = true;
    else if (arg === "--read-only") out.readOnly = true;
    else if (arg === "-p" || arg === "--prompt") out.prompt = argv[++i] ?? "";
  }
  return out;
}

// ─── Persona loading ──────────────────────────────────────────────────

/**
 * Load the agent persona markdown body from either:
 *   .github/agents/<agent>.agent.md   (repo-local maintainer agents)
 *   package/agents/<agent>.agent.md   (shipped kit agents)
 * Strips YAML frontmatter, returns the body text.
 */
export function loadPersona(agentName, cwd = process.cwd()) {
  if (!agentName) return "";
  const candidates = [
    path.resolve(cwd, ".github", "agents", `${agentName}.agent.md`),
    path.resolve(cwd, "package", "agents", `${agentName}.agent.md`),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    let text = readFileSync(file, "utf8");
    const frontmatter = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    if (frontmatter) text = text.slice(frontmatter[0].length);
    return text.trim();
  }
  return "";
}

// ─── Claim handoff ────────────────────────────────────────────────────

export function buildClaimHandoff(env = process.env) {
  const artifactId = env.GUILDCTL_ARTIFACT_ID;
  const claimId = env.GUILDCTL_CLAIM_ID;
  const claimToken = env.GUILDCTL_CLAIM_TOKEN;
  if (!artifactId || !claimId || !claimToken) return "";
  const payload = {
    artifact_id: artifactId,
    claim_id: claimId,
    claim_token: claimToken,
    run_id: env.GUILDCTL_RUN_ID ?? null,
    owner: env.GUILDCTL_AGENT_NAME ?? null,
  };
  return [
    "## Runner claim handoff (authoritative)",
    "The runner has already claimed this artifact for this session. Do not run the `claim` command and do not require these values to exist inside Bash environment variables. Use the literal values below for every registry command, including heartbeat and status advancement.",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");
}

// ─── Goose binary resolution ──────────────────────────────────────────

/**
 * Resolve the goose binary path. Priority:
 *   1. GOOSE_CLI_PATH env var (explicit override, mirrors other adapters)
 *   2. `goose` on PATH (or `goose.exe` on Windows)
 * Returns { command, args-prefix } — the caller prepends args-prefix to the
 * goose arguments. On Windows, if goose is a .cmd shim, spawn needs shell:true.
 */
export function resolveGooseCommand(env = process.env) {
  if (env.GOOSE_CLI_PATH) return { command: env.GOOSE_CLI_PATH, shell: false };

  const isWin = process.platform === "win32";
  return { command: isWin ? "goose.exe" : "goose", shell: isWin };
}

// ─── Token usage ──────────────────────────────────────────────────────

export function createTokenTotals() {
  return { input: 0, output: 0, total: 0, fresh: 0, events: 0 };
}

/**
 * Parse a stream-json line and extract token usage + readable text.
 * Returns { usage?: object, text?: string, toolLine?: string }.
 *
 * Stream-json event shapes (verified against goose v1.43.0):
 *   {"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}
 *   {"type":"message","message":{"role":"assistant","content":[{"type":"toolRequest","toolCall":{"value":{"name":"shell","arguments":{...}}}}]}}
 *   {"type":"message","message":{"role":"user","content":[{"type":"toolResponse","toolResult":{"status":"success","value":{"structuredContent":{"stdout":"...","exit_code":0}}}}]}}
 *   {"type":"complete","total_tokens":N,"input_tokens":N,"output_tokens":N}
 */
export function parseStreamEvent(line) {
  let event;
  try { event = JSON.parse(line); } catch { return { text: line + "\n" }; }

  // Token usage comes from the "complete" event at the end.
  if (event.type === "complete") {
    const input = safeInt(event.input_tokens);
    const output = safeInt(event.output_tokens);
    const total = safeInt(event.total_tokens);
    const fresh = input + output;
    return {
      usage: { input, output, total, fresh, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }

  if (event.type !== "message" || !event.message) return {};

  const msg = event.message;
  const parts = msg.content;
  if (!Array.isArray(parts)) return {};

  const result = {};

  for (const part of parts) {
    // Assistant text — pass raw, no added newlines.
    // Goose streams text token-by-token; concatenating raw chunks produces
    // the same output as --output-format text.
    if (part.type === "text" && part.text) {
      result.text = (result.text || "") + part.text;
    }

    // Tool call (assistant side)
    if (part.type === "toolRequest" && part.toolCall) {
      const tc = part.toolCall;
      const name = tc.value?.name ?? tc.name ?? "tool";
      const args = tc.value?.arguments ?? tc.arguments ?? {};
      const argStr = typeof args === "object" ? JSON.stringify(args) : String(args);
      const preview = argStr.length > 120 ? argStr.slice(0, 117) + "..." : argStr;
      result.toolLine = (result.toolLine || "") + `⚙ ${name}(${preview})\n`;
    }

    // Tool response (user side, goose puts tool results in role:user messages)
    if (part.type === "toolResponse" && part.toolResult) {
      const tr = part.toolResult;
      const status = tr.status ?? "unknown";
      const sc = tr.value?.structuredContent;
      if (sc) {
        const stdout = sc.stdout ? String(sc.stdout).trim() : "";
        const stderr = sc.stderr ? String(sc.stderr).trim() : "";
        const exit = sc.exit_code ?? "";
        const parts = [];
        if (stdout) parts.push(stdout);
        if (stderr) parts.push(`[stderr] ${stderr}`);
        if (exit !== "" && exit !== 0) parts.push(`[exit ${exit}]`);
        if (parts.length) {
          const block = parts.join("\n");
          const trimmed = block.length > 500 ? block.slice(0, 497) + "..." : block;
          result.toolLine = (result.toolLine || "") + `  → ${trimmed}\n`;
        }
      }
    }
  }

  return result;
}

function safeInt(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

export function serializeTokenTotals(totals) {
  return {
    input: totals.input,
    output: totals.output,
    reasoning: totals.reasoning ?? 0,
    cacheRead: totals.cacheRead ?? 0,
    cacheWrite: totals.cacheWrite ?? 0,
    fresh: totals.fresh,
    total: totals.total,
    events: totals.events,
  };
}

// ─── Stream processing ────────────────────────────────────────────────

/**
 * Attach to goose stdout (stream-json) and:
 *   - Write readable text + tool call summaries to process.stdout
 *   - Accumulate token usage from the "complete" event
 *
 * Goose streams text in small chunks (sometimes one token per message event).
 * We buffer consecutive text chunks and flush on non-text events or end-of-stream
 * so the log output stays readable.
 */
function attachStreamJsonStdout(child, totals) {
  let buffer = "";
  let textBuffer = "";

  function flushText() {
    if (textBuffer) {
      process.stdout.write(textBuffer);
      textBuffer = "";
    }
  }

  function processLine(line) {
    if (!line.trim()) return;
    const parsed = parseStreamEvent(line);
    if (parsed.usage) {
      totals.input = parsed.usage.input;
      totals.output = parsed.usage.output;
      totals.total = parsed.usage.total;
      totals.fresh = parsed.usage.fresh;
      totals.reasoning = parsed.usage.reasoning;
      totals.cacheRead = parsed.usage.cacheRead;
      totals.cacheWrite = parsed.usage.cacheWrite;
      totals.events += 1;
    }
    if (parsed.text) {
      textBuffer += parsed.text;
    }
    if (parsed.toolLine) {
      flushText();
      process.stdout.write(parsed.toolLine);
    }
  }

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) processLine(line);
  });
  child.stdout.on("end", () => {
    if (buffer.trim()) processLine(buffer);
    flushText();
  });
}

// ─── Invocation builder ───────────────────────────────────────────────

export function buildGooseInvocation(argv, options = {}) {
  const parsed = parseArgs(argv);
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const persona = loadPersona(parsed.agent, cwd);
  const claimHandoff = buildClaimHandoff(env);
  const fullPrompt = [persona, claimHandoff, parsed.prompt].filter(Boolean).join("\n\n---\n\n");

  // GOOSE_MODE controls tool permissions:
  //   --yolo      → auto (approve all tool calls)
  //   --read-only → chat (no tools at all — safest option available in goose)
  //   (neither)   → auto (same default as opencode adapter)
  const gooseMode = parsed.readOnly ? "chat" : "auto";

  const args = [
    "run",
    "--no-session",
    "--quiet",
    "--output-format", "stream-json",
    "--stats",
  ];

  // Provider/model: goose reads GOOSE_PROVIDER and GOOSE_MODEL from env,
  // or --provider/--model flags. We pass them as flags so the runner's
  // AGENT_PROVIDER_BASE_URL / AGENT_PROVIDER_API_KEY_ENV env vars don't
  // conflict (goose doesn't use those — it uses its own config system).
  //
  // The runner sets AGENT_PROVIDER_BASE_URL and AGENT_PROVIDER_API_KEY_ENV
  // for the opencode adapter. Goose ignores them. Provider config is handled
  // by the declarative provider JSON in ~/.config/goose/custom_providers/.
  //
  // If the model looks like it has a provider prefix (e.g. "custom_guild/fiq/glm-5.2"),
  // goose wants --provider <prefix> --model <rest>. Otherwise just --model.
  if (parsed.model) {
    if (parsed.model.includes("/")) {
      // Heuristic: if the model string has a slash and the first segment
      // matches a known provider pattern, split it. Otherwise pass as-is.
      // Goose's --provider expects the provider ID (e.g. "custom_guild"),
      // and --model expects the model name within that provider.
      //
      // However, for OpenAI-compatible providers the model name often
      // contains slashes (e.g. "rootsys/fiq/glm-5.2"). In that case the
      // entire string is the model name and the provider is set via
      // GOOSE_PROVIDER env var or --provider flag separately.
      //
      // We pass the full model string to --model. The provider must be
      // set via GOOSE_PROVIDER env var or --provider flag by the caller.
      args.push("--model", parsed.model);
    } else {
      args.push("--model", parsed.model);
    }
  }

  // If GOOSE_PROVIDER is set in env, pass it as a flag for clarity.
  if (env.GOOSE_PROVIDER) {
    args.push("--provider", env.GOOSE_PROVIDER);
  }

  // Pass the full prompt as --text
  args.push("-t", fullPrompt);

  const { command, shell } = resolveGooseCommand(env);

  return {
    command,
    args,
    parsed,
    fullPrompt,
    env: {
      ...env,
      GOOSE_MODE: gooseMode,
    },
    shell,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────

export function main(argv = process.argv.slice(2)) {
  const invocation = buildGooseInvocation(argv);
  const totals = createTokenTotals();

  const child = spawn(invocation.command, invocation.args, {
    stdio: ["ignore", "pipe", "inherit"],
    env: invocation.env,
    shell: invocation.shell,
  });

  attachStreamJsonStdout(child, totals);

  child.on("error", (error) => {
    process.stderr.write(`[goose-harness] failed to start goose: ${error.message}\n`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    // Write token usage to the file the runner expects.
    const usageFile = process.env.GUILD_OPENCODE_USAGE_FILE;
    if (usageFile) {
      try {
        writeFileSync(usageFile, JSON.stringify(serializeTokenTotals(totals), null, 2));
      } catch (error) {
        process.stderr.write(
          `[goose-harness] failed to write usage metrics: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

// ─── Direct-run guard ─────────────────────────────────────────────────

// Run main() when invoked directly. Compare real paths so symlinked temp dirs
// (macOS /var → /private/var, Windows junctions) don't make this guard false.
function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isDirectRun()) main();
