import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { GuildConfig } from "./config";

export interface HarnessResolution {
  name: string;
  command: string;
  targetCommand: string;
  source: "environment" | "config";
}

function bundledFile(root: string, relativePath: string): string {
  const installed = path.join(root, relativePath);
  if (fs.existsSync(installed)) return installed;
  return path.join(root, "package", relativePath);
}

export function resolveHarness(config: GuildConfig, root: string, env: NodeJS.ProcessEnv = process.env): HarnessResolution {
  if (env.AGENT_CMD) {
    return { name: "custom", command: env.AGENT_CMD, targetCommand: env.AGENT_CMD, source: "environment" };
  }

  const name = config.harness || "opencode";
  if (name === "opencode") {
    return { name, command: bundledFile(root, path.join("harness", "opencode.mjs")), targetCommand: "opencode", source: "config" };
  }
  if (name === "goose") {
    return { name, command: bundledFile(root, path.join("harness", "goose.mjs")), targetCommand: "goose", source: "config" };
  }
  if (name === "codex") {
    return { name, command: bundledFile(root, path.join("harness", "codex.mjs")), targetCommand: "codex", source: "config" };
  }
  if (name === "copilot") {
    return { name, command: bundledFile(root, "agent-shim.mjs"), targetCommand: "copilot", source: "config" };
  }
  throw new Error(`Unknown harness "${name}". Supported bundled harnesses: goose, opencode, codex, copilot. Use AGENT_CMD for a custom harness.`);
}

export function checkHarness(resolution: HarnessResolution): { ok: boolean; message: string } {
  if (resolution.source === "config" && !fs.existsSync(resolution.command)) {
    return { ok: false, message: `active harness: ${resolution.name} (missing adapter: ${resolution.command})` };
  }
  const command = resolution.name === "custom" ? resolution.command : resolution.targetCommand;
  const nodeShim = /\.(mjs|cjs|js)$/i.test(command);
  const result = spawnSync(nodeShim ? process.execPath : command, nodeShim ? [command, "--version"] : ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32" && !nodeShim,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, message: `active harness: ${resolution.name} (${command} is missing or unreachable)` };
  }
  return { ok: true, message: `active harness: ${resolution.name} (${resolution.source === "environment" ? "AGENT_CMD override" : resolution.command})` };
}
