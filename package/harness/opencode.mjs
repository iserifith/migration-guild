#!/usr/bin/env node
// opencode harness adapter. Contract (same as the other adapters):
//   1. Accept --agent, --model, --yolo, and -p/--prompt.
//   2. Prepend the body of .github/agents/<agent>.agent.md to the prompt.
//   3. Configure an OpenAI-compatible provider from AGENT_PROVIDER_BASE_URL and
//      the key named by AGENT_PROVIDER_API_KEY_ENV (chat/completions wire API).
//   4. Run non-interactively with tools auto-approved, preserve readable output,
//      capture token usage from opencode JSON events, and return the child's exit code.
//
// Unlike codex (which now only speaks the OpenAI "responses" API), opencode
// drives OpenAI-compatible chat/completions endpoints (e.g. DashScope) via
// @ai-sdk/openai-compatible, so it works with non-OpenAI providers.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER_ID = "guild";

export function parseArgs(argv) {
  const out = { agent: "", model: "", prompt: "", yolo: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--agent") out.agent = argv[++i] ?? "";
    else if (arg === "--model") out.model = argv[++i] ?? "";
    else if (arg === "--yolo") out.yolo = true;
    else if (arg === "-p" || arg === "--prompt") out.prompt = argv[++i] ?? "";
  }
  return out;
}

export function loadPersona(agentName, cwd = process.cwd()) {
  if (!agentName) return "";
  const file = path.resolve(cwd, ".github", "agents", `${agentName}.agent.md`);
  if (!existsSync(file)) return "";
  let text = readFileSync(file, "utf8");
  const frontmatter = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (frontmatter) text = text.slice(frontmatter[0].length);
  return text.trim();
}

// Write a temporary opencode config exposing the configured provider as an
// OpenAI-compatible endpoint. OPENCODE_CONFIG is additive, so this layers a
// "guild" provider on top of any existing user config.
export function writeProviderConfig(model, env = process.env) {
  const baseURL = env.AGENT_PROVIDER_BASE_URL || "https://api.openai.com/v1";
  const apiKeyEnv = env.AGENT_PROVIDER_API_KEY_ENV || "OPENAI_API_KEY";
  const models = {};
  if (model) models[model] = { name: model };
  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Migration Guild provider",
        options: { baseURL, apiKey: `{env:${apiKeyEnv}}` },
        models,
      },
    },
  };
  const dir = mkdtempSync(path.join(os.tmpdir(), "guild-opencode-"));
  const file = path.join(dir, "opencode.json");
  writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

function safeInt(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

export function createTokenTotals() {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, fresh: 0, events: 0, sessions: new Set() };
}

function extractUsageFromPart(part) {
  if (!part || typeof part !== "object" || part.type !== "step-finish") return null;
  const tokens = part.tokens && typeof part.tokens === "object" ? part.tokens : undefined;
  const cache = tokens?.cache && typeof tokens.cache === "object" ? tokens.cache : undefined;
  const usage = part.usage && typeof part.usage === "object" ? part.usage : undefined;
  const input = safeInt(tokens?.input ?? usage?.nonCachedInputTokens ?? usage?.inputTokens ?? usage?.promptTokens);
  const output = safeInt(tokens?.output ?? usage?.visibleOutputTokens ?? usage?.outputTokens ?? usage?.completionTokens);
  const reasoning = safeInt(tokens?.reasoning ?? usage?.reasoningTokens);
  const cacheRead = safeInt(cache?.read ?? usage?.cacheReadInputTokens ?? usage?.cachedInputTokens);
  const cacheWrite = safeInt(cache?.write ?? usage?.cacheWriteInputTokens);
  const fresh = input + output + reasoning;
  const fallbackTotal = fresh + cacheRead + cacheWrite;
  const total = safeInt(tokens?.total ?? usage?.totalTokens ?? usage?.total_tokens) || fallbackTotal;
  if (fallbackTotal === 0 && total === 0) return null;
  return { input, output, reasoning, cacheRead, cacheWrite, fresh, total };
}

export function consumeOpenCodeJsonEvent(line, totals = createTokenTotals()) {
  let event;
  try { event = JSON.parse(line); } catch { return false; }
  const part = event?.part ?? event?.properties?.part;
  const usage = extractUsageFromPart(part);
  if (!usage) return false;
  totals.input += usage.input;
  totals.output += usage.output;
  totals.reasoning += usage.reasoning;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.fresh += usage.fresh;
  totals.total += usage.total;
  totals.events += 1;
  const sessionID = event.sessionID ?? part?.sessionID ?? event.properties?.sessionID;
  if (sessionID) totals.sessions.add(String(sessionID));
  return true;
}

export function serializeTokenTotals(totals) {
  return { input: totals.input, output: totals.output, reasoning: totals.reasoning, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite, fresh: totals.fresh, total: totals.total, events: totals.events, sessions: [...totals.sessions].sort() };
}

export function renderReadableEvent(line) {
  let event;
  try { event = JSON.parse(line); } catch { return `${line}\n`; }
  const part = event?.part ?? event?.properties?.part;
  if (event.type === "text" && part?.type === "text") {
    const value = String(part.text ?? "");
    return value.endsWith("\n") ? value : `${value}\n`;
  }
  if (event.type === "reasoning" && part?.type === "reasoning") {
    const value = String(part.text ?? "").trim();
    return value ? `Thinking: ${value}\n` : "";
  }
  if (event.type === "tool_use" && part?.type === "tool") {
    const status = part.state?.status ? ` ${part.state.status}` : "";
    const error = part.state?.error ? `: ${part.state.error}` : "";
    return `⚙ ${part.tool ?? "tool"}${status}${error}\n`;
  }
  if (event.type === "error") {
    const message = event.error?.message ?? event.error?.data?.message ?? event.error?.name ?? JSON.stringify(event.error ?? event);
    return `[opencode] error: ${message}\n`;
  }
  return "";
}

function attachJsonStdout(child, totals) {
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      consumeOpenCodeJsonEvent(line, totals);
      process.stdout.write(renderReadableEvent(line));
    }
  });
  child.stdout.on("end", () => {
    if (!buffer) return;
    consumeOpenCodeJsonEvent(buffer, totals);
    process.stdout.write(renderReadableEvent(buffer));
  });
}

export function buildOpencodeInvocation(argv, options = {}) {
  const parsed = parseArgs(argv);
  const env = options.env ?? process.env;
  const persona = loadPersona(parsed.agent, options.cwd);
  const fullPrompt = persona ? `${persona}\n\n---\n\n${parsed.prompt}` : parsed.prompt;
  const configPath = writeProviderConfig(parsed.model, env);
  const args = ["run", "--dangerously-skip-permissions", "--format", "json"];
  if (parsed.model) args.push("-m", `${PROVIDER_ID}/${parsed.model}`);
  args.push(fullPrompt);
  return {
    command: env.OPENCODE_CLI_PATH || "opencode",
    args,
    parsed,
    fullPrompt,
    env: { ...env, OPENCODE_CONFIG: configPath },
  };
}

export function main(argv = process.argv.slice(2)) {
  const invocation = buildOpencodeInvocation(argv);
  const totals = createTokenTotals();
  const child = spawn(invocation.command, invocation.args, { stdio: ["ignore", "pipe", "inherit"], env: invocation.env });
  attachJsonStdout(child, totals);
  child.on("error", (error) => {
    process.stderr.write(`[opencode-harness] failed to start opencode: ${error.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    const usageFile = process.env.GUILD_OPENCODE_USAGE_FILE;
    if (usageFile) {
      try { writeFileSync(usageFile, JSON.stringify(serializeTokenTotals(totals), null, 2)); }
      catch (error) { process.stderr.write(`[opencode-harness] failed to write usage metrics: ${error instanceof Error ? error.message : String(error)}\n`); }
    }
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

// Run main() when invoked directly. Compare real paths so symlinked temp dirs
// (macOS /var → /private/var) don't make this guard silently false — that would
// load the module without running anything (a 0-output, exit-0 no-op).
function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isDirectRun()) main();
