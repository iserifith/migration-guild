#!/usr/bin/env node
// Reference Migration Guild harness adapter. Contract:
//   1. Accept --agent, --model, --yolo/--read-only, and -p/--prompt.
//   2. Prepend the body of .github/agents/<agent>.agent.md to the prompt.
//   3. Configure an OpenAI-compatible provider from AGENT_PROVIDER_BASE_URL and
//      the key named by AGENT_PROVIDER_API_KEY_ENV.
//   4. Run non-interactively, inherit stdio, and return the child's exit code.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

export function loadPersona(agentName, cwd = process.cwd()) {
  if (!agentName) return "";
  const file = path.resolve(cwd, ".github", "agents", `${agentName}.agent.md`);
  if (!existsSync(file)) return "";
  let text = readFileSync(file, "utf8");
  const frontmatter = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (frontmatter) text = text.slice(frontmatter[0].length);
  return text.trim();
}

function tomlString(value) {
  return JSON.stringify(value);
}

export function buildCodexInvocation(argv, options = {}) {
  const parsed = parseArgs(argv);
  const env = options.env ?? process.env;
  const persona = loadPersona(parsed.agent, options.cwd);
  const fullPrompt = persona ? `${persona}\n\n---\n\n${parsed.prompt}` : parsed.prompt;
  const baseUrl = env.AGENT_PROVIDER_BASE_URL || "https://api.openai.com/v1";
  const apiKeyEnv = env.AGENT_PROVIDER_API_KEY_ENV || "OPENAI_API_KEY";
  const args = [
    "--sandbox", parsed.readOnly ? "read-only" : "workspace-write",
    "--ask-for-approval", "never",
    "exec",
    "--skip-git-repo-check",
    "-c", "model_provider=migration_guild",
    "-c", `model_providers.migration_guild.name=${tomlString("Migration Guild OpenAI-compatible")}`,
    "-c", `model_providers.migration_guild.base_url=${tomlString(baseUrl)}`,
    "-c", `model_providers.migration_guild.env_key=${tomlString(apiKeyEnv)}`,
  ];
  if (parsed.model) args.push("-c", `model=${tomlString(parsed.model)}`);
  args.push(fullPrompt);
  return { command: env.CODEX_CLI_PATH || "codex", args, parsed, fullPrompt };
}

export function main(argv = process.argv.slice(2)) {
  const invocation = buildCodexInvocation(argv);
  const child = spawn(invocation.command, invocation.args, { stdio: "inherit", env: process.env });
  child.on("error", (error) => {
    process.stderr.write(`[codex-harness] failed to start Codex: ${error.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

// Run main() when invoked directly. Compare real paths so symlinked temp dirs
// (macOS /var → /private/var) don't make this guard silently false.
function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isDirectRun()) main();
