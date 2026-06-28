#!/usr/bin/env node
// opencode harness adapter. Contract (same as the other adapters):
//   1. Accept --agent, --model, --yolo, and -p/--prompt.
//   2. Prepend the body of .github/agents/<agent>.agent.md to the prompt.
//   3. Configure an OpenAI-compatible provider from AGENT_PROVIDER_BASE_URL and
//      the key named by AGENT_PROVIDER_API_KEY_ENV (chat/completions wire API).
//   4. Run non-interactively with tools auto-approved, inherit stdio, and return
//      the child's exit code.
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

export function buildOpencodeInvocation(argv, options = {}) {
  const parsed = parseArgs(argv);
  const env = options.env ?? process.env;
  const persona = loadPersona(parsed.agent, options.cwd);
  const fullPrompt = persona ? `${persona}\n\n---\n\n${parsed.prompt}` : parsed.prompt;
  const configPath = writeProviderConfig(parsed.model, env);
  const args = ["run", "--dangerously-skip-permissions"];
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
  const child = spawn(invocation.command, invocation.args, { stdio: "inherit", env: invocation.env });
  child.on("error", (error) => {
    process.stderr.write(`[opencode-harness] failed to start opencode: ${error.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
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
