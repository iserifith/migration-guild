import { exec } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { addVerifierRuntimeEvidence } from "../registry/commands/evidence";
import type { AcceptanceEvidence } from "../registry/types";

const execAsync = promisify(exec);

export interface VerifyOptions {
  artifactId: string;
  workspaceRoot: string;
  commands: string[];
  outputDir: string;
  runId?: string | null;
  operatorToken?: string | null;
}

export interface VerifyResult {
  artifactId: string;
  pass: boolean;
  evidence: AcceptanceEvidence[];
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function excerpt(text: string): string {
  const clean = text.replace(/\r/g, "");
  return clean.length > 4000 ? clean.slice(clean.length - 4000) : clean;
}

export interface RuntimeEvidenceAuthenticityInput {
  artifactId: string;
  runId: string | null | undefined;
  command: string;
  exitCode: number;
  pass: 0 | 1;
  logSha256: string;
}

export function runtimeEvidenceCanonical(input: RuntimeEvidenceAuthenticityInput): string {
  return JSON.stringify({
    artifact_id: input.artifactId,
    run_id: input.runId ?? null,
    command: input.command,
    exit_code: input.exitCode,
    pass: input.pass,
    log_sha256: input.logSha256,
  });
}

export function signRuntimeEvidence(
  input: RuntimeEvidenceAuthenticityInput,
  operatorToken: string,
): string {
  return `hmac-sha256:${createHmac("sha256", operatorToken).update(runtimeEvidenceCanonical(input), "utf8").digest("hex")}`;
}

function isSensitiveEnvName(name: string): boolean {
  return /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|BEARER)/i.test(name);
}

export function scrubVerificationEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
    "CI",
  ]);
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value == null) continue;
    if (keep.has(key) || key.startsWith("npm_config_") || key.startsWith("npm_package_")) {
      if (!isSensitiveEnvName(key)) out[key] = value;
    }
  }
  return out;
}

function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([key, value]) => value && value.length >= 4 && isSensitiveEnvName(key))
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
}

export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let redacted = text;
  for (const value of secretValues(env)) {
    redacted = redacted.split(value).join("<redacted>");
  }
  return redacted;
}

export async function runVerify(
  db: Database.Database,
  opts: VerifyOptions,
): Promise<VerifyResult> {
  if (opts.commands.length === 0) {
    throw new Error("Verification requires at least one configured command");
  }
  if (!opts.runId || !opts.operatorToken) {
    throw new Error("Verification requires a run-bound operator credential");
  }
  fs.mkdirSync(opts.outputDir, { recursive: true });
  const evidence: AcceptanceEvidence[] = [];
  let allPassed = true;

  for (const command of opts.commands) {
    const recordedCommand = redactSecrets(command);
    const started = Date.now();
    let exitCode = 0;
    let stdout = "";
    let stderr = "";
    try {
      const result = await execAsync(command, {
        cwd: opts.workspaceRoot,
        env: scrubVerificationEnv(process.env),
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = redactSecrets(result.stdout);
      stderr = redactSecrets(result.stderr);
    } catch (error) {
      const err = error as Error & { code?: number; stdout?: string; stderr?: string };
      exitCode = typeof err.code === "number" ? err.code : 1;
      stdout = redactSecrets(err.stdout ?? "");
      stderr = redactSecrets(err.stderr ?? err.message);
    }
    const durationMs = Date.now() - started;
    const log = [
      `command: ${recordedCommand}`,
      `exit_code: ${exitCode}`,
      `duration_ms: ${durationMs}`,
      "",
      "stdout:",
      stdout,
      "",
      "stderr:",
      stderr,
    ].join("\n");
    const logSha256 = sha256(log);
    const logPath = path.join(opts.outputDir, `${Date.now()}-${randomUUID().slice(0, 8)}-runtime.log`);
    fs.writeFileSync(logPath, log, "utf8");
    const pass = exitCode === 0;
    const passValue = pass ? 1 : 0;
    allPassed &&= pass;
    const authenticity = signRuntimeEvidence({
      artifactId: opts.artifactId,
      runId: opts.runId,
      command: recordedCommand,
      exitCode,
      pass: passValue,
      logSha256,
    }, opts.operatorToken);
    evidence.push(addVerifierRuntimeEvidence(db, {
      artifactId: opts.artifactId,
      runId: opts.runId ?? null,
      command: recordedCommand,
      exitCode,
      pass: passValue,
      summary: pass ? `Runtime verification passed: ${recordedCommand}` : `Runtime verification failed: ${recordedCommand}`,
      outputPath: logPath,
      outputExcerpt: excerpt(`${stdout}${stderr}`),
      logSha256,
      durationMs,
      authenticity,
    }));
  }

  return { artifactId: opts.artifactId, pass: allPassed, evidence };
}
