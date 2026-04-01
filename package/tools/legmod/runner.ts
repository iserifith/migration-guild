import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import { startRun, finishRun } from "../registry/commands/runs";

export interface SpawnCopilotOpts {
  agent: string;
  model: string;
  prompt: string;
  db: Database.Database;
  logDir?: string;
}

const COPILOT_CMD = process.env["COPILOT_CMD"] ?? "copilot";

export function spawnCopilot(opts: SpawnCopilotOpts): Promise<number> {
  const { agent, model, prompt, db } = opts;

  const logFile = opts.logDir
    ? path.join(opts.logDir, `${agent}-${Date.now()}.log`)
    : undefined;

  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  }

  const run = startRun(db, { agent, model, prompt, logFile });
  const args = ["--agent", agent, "--model", model, "--yolo", "-p", prompt];
  const proc = spawn(COPILOT_CMD, args, {
    stdio: logFile ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (logFile && proc.stdout && proc.stderr) {
    const stream = fs.createWriteStream(logFile, { flags: "a" });
    proc.stdout.pipe(stream);
    proc.stderr.pipe(stream);
  }

  return new Promise((resolve) => {
    proc.on("exit", (code) => {
      finishRun(db, { runId: run.run_id, exitCode: code ?? 1 });
      resolve(code ?? 1);
    });
    proc.on("error", (err) => {
      process.stderr.write(`[legmod] Failed to start copilot: ${err.message}\n`);
      finishRun(db, { runId: run.run_id, exitCode: 1 });
      resolve(1);
    });
  });
}
