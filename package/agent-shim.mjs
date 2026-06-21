#!/usr/bin/env node
// Migration Guild agent shim — adapts guildctl's agent interface to the
// GitHub Copilot CLI driven against an OpenAI-compatible endpoint (DashScope).
//
// guildctl invokes:  <AGENT_CMD> --agent <name> --model <model> --yolo -p <prompt>
// We translate that to a non-interactive Copilot run with BYOK env vars and
// inject the matching .github/agents/<name>.agent.md persona into the prompt.
//
// Point guildctl at this file via:  AGENT_CMD=/abs/path/to/agent-shim.mjs
// (runner.ts runs *.mjs through node directly — no shell, no arg mangling.)
//
// Env (set in the workspace .env):
//   DASHSCOPE_API_KEY        required — provider key
//   AGENT_PROVIDER_BASE_URL  optional — defaults to DashScope intl compatible-mode
//   COPILOT_CLI_ENTRY        optional — path to Copilot's index.js (auto-detected on win32)

import { spawn } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

function parseArgs(argv) {
  const out = { agent: "", model: "", prompt: "", yolo: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent") out.agent = argv[++i] ?? "";
    else if (a === "--model") out.model = argv[++i] ?? "";
    else if (a === "--yolo") out.yolo = true;
    else if (a === "-p" || a === "--prompt") out.prompt = argv[++i] ?? "";
  }
  return out;
}

/** Strip YAML frontmatter, returning the persona body. */
function loadPersona(agentName) {
  if (!agentName) return "";
  const file = path.resolve(".github", "agents", `${agentName}.agent.md`);
  if (!existsSync(file)) return "";
  let text = readFileSync(file, "utf8");
  const fm = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (fm) text = text.slice(fm[0].length);
  return text.trim();
}

/** Locate the Copilot CLI entry (index.js). */
function resolveCopilotEntry() {
  if (process.env.COPILOT_CLI_ENTRY && existsSync(process.env.COPILOT_CLI_ENTRY)) {
    return process.env.COPILOT_CLI_ENTRY;
  }
  // Standalone installer layout: %LOCALAPPDATA%/copilot/pkg/<platform>/<version>/index.js
  const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "copilot", "pkg");
  const plat = `${process.platform}-${process.arch}`;
  const dir = path.join(base, plat);
  if (existsSync(dir)) {
    const versions = readdirSync(dir).filter((v) => existsSync(path.join(dir, v, "index.js")));
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (versions[0]) return path.join(dir, versions[0], "index.js");
  }
  return null;
}

function main() {
  const { agent, model, prompt } = parseArgs(process.argv.slice(2));

  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    process.stderr.write("[agent-shim] DASHSCOPE_API_KEY is not set\n");
    process.exit(1);
  }
  const entry = resolveCopilotEntry();
  if (!entry) {
    process.stderr.write("[agent-shim] Could not locate the Copilot CLI. Set COPILOT_CLI_ENTRY to its index.js.\n");
    process.exit(1);
  }

  const persona = loadPersona(agent);
  const fullPrompt = persona ? `${persona}\n\n---\n\n${prompt}` : prompt;

  const copilotArgs = [
    entry,
    "-p", fullPrompt,
    "--allow-all",        // --yolo equivalent: tools + paths + urls, no prompts
    "--no-color",
  ];
  if (model) copilotArgs.push("--model", model);

  if (process.env.AGENT_SHIM_DRYRUN === "1") {
    process.stdout.write(JSON.stringify({ agent, model, entry, personaChars: persona.length, promptChars: fullPrompt.length }, null, 2) + "\n");
    process.exit(0);
  }

  const child = spawn(process.execPath, copilotArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      COPILOT_PROVIDER_BASE_URL: process.env.AGENT_PROVIDER_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      COPILOT_PROVIDER_API_KEY: apiKey,
      COPILOT_MODEL: model || process.env.COPILOT_MODEL || "deepseek-v4-pro",
      COPILOT_ALLOW_ALL: "1",
    },
  });
  child.on("error", (e) => { process.stderr.write(`[agent-shim] failed to start Copilot: ${e.message}\n`); process.exit(1); });
  child.on("exit", (code) => process.exit(code ?? 1));
}

main();
