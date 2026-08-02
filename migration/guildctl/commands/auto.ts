import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { resolveGuildConfig, resolveProviderRoute, resolveWorkspaceRoot } from "../config";
import { resolveAgentLaunch, type HarnessResolution } from "../harness";
import { runAuto, type AutoResult, type AutoReviewDecision, type AutoReviewInput, type AutoWorkerInput } from "../supervisor/loop";

export interface AutoCliOptions {
  artifact: string;
  command?: string[];
  maxAttempts?: number;
  resume?: boolean;
  json?: boolean;
  registryDbPath?: string;
  setExitCode?: boolean;
  quiet?: boolean;
}

export const REVIEW_MARKER = "MIGRATION_GUILD_REVIEW:";

interface ReviewInvocationResult {
  ok: boolean;
  output: string;
  error?: string;
}

interface RegistryCliCommand {
  command: string;
  argv: string[];
}

function commands(opts: AutoCliOptions): string[] {
  return (opts.command ?? []).flatMap((item) => item.split(";;")).map((item) => item.trim()).filter(Boolean);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function registryCliPath(): string {
  const built = path.resolve(__dirname, "..", "..", "registry", "cli.js");
  const source = path.resolve(__dirname, "..", "..", "registry", "cli.ts");
  return fs.existsSync(built) ? built : source;
}

function tsxLoaderPath(): string {
  const loader = path.resolve(__dirname, "..", "..", "node_modules", "tsx", "dist", "loader.mjs");
  if (!fs.existsSync(loader)) {
    throw new Error(`source-mode registry handoff requires tsx loader at ${loader}`);
  }
  return loader;
}

function registryCliCommand(registryDbPath: string): RegistryCliCommand {
  const cliPath = registryCliPath();
  const executableArgv = cliPath.endsWith(".ts")
    ? ["node", "--import", tsxLoaderPath(), cliPath]
    : ["node", cliPath];
  const argv = [...executableArgv, "--db", path.resolve(registryDbPath)];
  return { argv, command: argv.map(shellQuote).join(" ") };
}

function workerPrompt(input: AutoWorkerInput, registryCli: RegistryCliCommand): string {
  const producerAgent = input.phase === "repair" ? "remediation-agent" : "code-writer-agent";
  const lines = [
    `Autonomous migration phase: ${input.phase}`,
    `Artifact: ${input.claim.id}`,
    `Legacy source path: ${input.claim.path}`,
    `Allowed output paths: ${input.claim.expected_output_paths ?? "[]"}`,
    "This artifact is already claimed. Do not create another claim.",
  ];
  if (input.phase === "repair" && input.reviewReason?.trim()) {
    lines.push(`Independent reviewer rejection reason: ${input.reviewReason}`);
    lines.push("Repair the migrated output to address that reviewer finding, then rerun will verify and re-review.");
  }
  lines.push(
    "Edit only the claimed output paths, then finalize the active claim with this exact command:",
    `${registryCli.command} set-artifact-status --id "$GUILDCTL_ARTIFACT_ID" --status migrated --agent ${producerAgent} --claim-id "$GUILDCTL_CLAIM_ID" --claim-token "$GUILDCTL_CLAIM_TOKEN"`,
  );
  return lines.join("\n");
}

function reviewPrompt(input: AutoReviewInput): string {
  const evidence = input.evidence.map((item) => ({
    evidence_id: item.evidence_id,
    evidence_type: item.evidence_type,
    pass: item.pass,
    command: item.command,
    exit_code: item.exit_code,
    summary: item.summary,
    output_path: item.output_path,
    log_sha256: item.log_sha256,
  }));
  return [
    "Autonomous migration review phase.",
    `Artifact: ${input.artifactId}`,
    `Producer agent: ${input.producerAgent}`,
    `Producer model: ${input.producerModel ?? "unknown"}`,
    "Review the migrated output and verifier evidence. Do not use claim, operator, or verifier tokens.",
    "Do not invoke registry, guildctl, or any status/arbitration command. Do not mutate the workspace or registry database.",
    "Do not record the verdict yourself; return the machine verdict marker only. The supervisor owns arbitration persistence.",
    `Evidence: ${JSON.stringify(evidence)}`,
    `Return exactly one machine verdict line: ${REVIEW_MARKER}{"approved":true|false,"reason":"short reason"}`,
  ].join("\n");
}

function scrubbedReviewEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (/CLAIM_TOKEN|CLAIM_ID|OPERATOR_TOKEN|VERIFIER_TOKEN|RUN_OPERATOR/i.test(key)) {
      delete env[key];
    }
  }
  return env;
}

function spawnHarnessInvocation(
  workspaceRoot: string,
  harness: HarnessResolution,
  agent: string,
  model: string,
  prompt: string,
  env: NodeJS.ProcessEnv,
): Promise<ReviewInvocationResult> {
  return new Promise((resolve) => {
    const args = ["--agent", agent, "--model", model, "--read-only", "-p", prompt];
    const isNodeScript = /\.(mjs|cjs|js)$/i.test(harness.command);
    const command = isNodeScript ? process.execPath : harness.command;
    const commandArgs = isNodeScript ? [harness.command, ...args] : args;
    const child = spawn(command, commandArgs, {
      cwd: workspaceRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: !isNodeScript && process.platform === "win32",
    });
    let output = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", (error) => {
      resolve({ ok: false, output, error: error.message });
    });
    child.on("exit", (code) => {
      if (code === 0) resolve({ ok: true, output });
      else resolve({ ok: false, output, error: stderr.trim() || `reviewer exited with code ${code ?? 1}` });
    });
  });
}

export function parseReviewMarker(output: string): Pick<AutoReviewDecision, "approved" | "reason"> {
  const markerLines = output.split(/\r?\n/).filter((line) => line.startsWith(REVIEW_MARKER));
  if (markerLines.length !== 1) {
    throw new Error(`reviewer output must contain exactly one ${REVIEW_MARKER} marker`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(markerLines[0].slice(REVIEW_MARKER.length));
  } catch {
    throw new Error("reviewer marker JSON is malformed");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("reviewer marker must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.approved !== "boolean" || typeof obj.reason !== "string" || !obj.reason.trim()) {
    throw new Error("reviewer marker must include approved boolean and non-empty reason");
  }
  return { approved: obj.approved, reason: obj.reason };
}

export function harnessReviewer(
  workspaceRoot: string,
  cfg: ReturnType<typeof resolveGuildConfig>,
  producerModelRef: () => string | undefined,
): (input: AutoReviewInput) => Promise<AutoReviewDecision> {
  return async (input) => {
    const producerModel = input.producerModel ?? producerModelRef();
    const prompt = reviewPrompt({ ...input, producerModel });
    // Claim, operator, and verifier credentials are scrubbed *before* the
    // resolver builds the launch environment, so the reviewer can never inherit
    // authority over the artifact it is reviewing.
    const reviewEnv = scrubbedReviewEnv(process.env);
    const routeLength = resolveProviderRoute(cfg, "review").length;
    const attempted = new Set<string>();
    let lastError = "";
    for (let attempt = 0; attempt < routeLength; attempt++) {
      // FR-011: the reviewer launches through the same resolver as the runner
      // and the scripted worker, on the review route.
      const launch = resolveAgentLaunch({
        config: cfg,
        root: workspaceRoot,
        env: reviewEnv,
        route: "review",
        attempt,
      });
      const model = launch.model;
      if (!model || model === producerModel || attempted.has(model)) continue;
      attempted.add(model);
      const env = {
        ...launch.agentEnv,
        GUILDCTL_AUTO_PHASE: "review",
        GUILDCTL_RUN_ID: input.runId,
        GUILDCTL_ARTIFACT_ID: input.artifactId,
        GUILDCTL_AGENT_MODEL: model,
      };
      const invocation = await spawnHarnessInvocation(workspaceRoot, launch.harness, "review-agent", model, prompt, env);
      if (!invocation.ok) {
        lastError = invocation.error ?? "reviewer invocation failed";
        continue;
      }
      try {
        const verdict = parseReviewMarker(invocation.output);
        return { ...verdict, reviewerAgent: "review-agent", reviewerModel: model };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        continue;
      }
    }
    if (attempted.size === 0) {
      throw new Error("review route has no model distinct from the producing attempt");
    }
    throw new Error(`independent review failed closed: ${lastError || "review chain exhausted"}`);
  };
}

function scriptedWorker(
  workspaceRoot: string,
  cfg: ReturnType<typeof resolveGuildConfig>,
  setProducerModel: (model: string) => void,
  registryDbPath: string,
): (input: AutoWorkerInput) => Promise<void> {
  let invocation = 0;
  const exactRegistryDbPath = path.resolve(registryDbPath);
  const registryCli = registryCliCommand(exactRegistryDbPath);
  return ({ phase, claim, runId, reviewReason }) => new Promise((resolve, reject) => {
    // FR-011: the producing worker resolves its harness, model, provider, and
    // environment through the shared resolver on the default route; this
    // attempt's index walks that route.
    const launch = resolveAgentLaunch({
      config: cfg,
      root: workspaceRoot,
      route: "default",
      attempt: invocation,
    });
    const harness: HarnessResolution = launch.harness;
    const model = launch.model;
    setProducerModel(model);
    invocation += 1;
    const isNodeScript = /\.(mjs|cjs|js)$/i.test(harness.command);
    const args = harness.source === "environment"
      ? []
      : [
        "--agent",
        phase === "repair" ? "remediation-agent" : "code-writer-agent",
        "--model",
        model,
        "--yolo",
        "-p",
        workerPrompt({
          phase,
          claim,
          runId,
          producerAgent: phase === "repair" ? "remediation-agent" : "code-writer-agent",
          producerModel: model,
          reviewReason,
        }, registryCli),
      ];
    const child = spawn(isNodeScript ? process.execPath : harness.command, isNodeScript ? [harness.command, ...args] : args, {
      cwd: workspaceRoot,
      env: {
        ...launch.agentEnv,
        GUILDCTL_AUTO_PHASE: phase,
        GUILDCTL_RUN_ID: runId,
        GUILDCTL_ARTIFACT_ID: claim.id,
        GUILDCTL_CLAIM_ID: claim.claim_id,
        GUILDCTL_CLAIM_TOKEN: claim.claim_token,
        GUILDCTL_EXPECTED_OUTPUT_PATHS: claim.expected_output_paths ?? "[]",
        GUILDCTL_AGENT_KIND: phase === "repair" ? "remediation-agent" : "code-writer-agent",
        GUILDCTL_AGENT_NAME: `guildctl-auto:${claim.id}`,
        ...(reviewReason ? { GUILDCTL_REVIEW_REASON: reviewReason } : {}),
        GUILDCTL_REGISTRY_CLI: registryCli.command,
        GUILDCTL_REGISTRY_CLI_ARGV: JSON.stringify(registryCli.argv),
        GUILDCTL_REGISTRY_DB: exactRegistryDbPath,
        REGISTRY_DB: exactRegistryDbPath,
        GUILDCTL_AGENT_MODEL: model,
        PYTHONDONTWRITEBYTECODE: process.env.PYTHONDONTWRITEBYTECODE ?? "1",
        PYTEST_ADDOPTS: process.env.PYTEST_ADDOPTS ?? "-p no:cacheprovider",
      },
      stdio: "inherit",
      shell: !isNodeScript && process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${phase} worker exited with code ${code ?? 1}`));
    });
  });
}

export async function runAutoCommand(db: Database.Database, opts: AutoCliOptions): Promise<AutoResult> {
  const workspaceRoot = resolveWorkspaceRoot();
  const cfg = resolveGuildConfig({ cwd: workspaceRoot });
  let lastProducerModel: string | undefined;
  // No credential gate here: the autonomous queue holds one shared preflight
  // verdict (T035), so a second credential-only path would both re-check less
  // than preflight does and let a per-artifact answer drift from the queue's.
  if (!opts.registryDbPath || !path.isAbsolute(opts.registryDbPath)) {
    throw new Error("guildctl auto requires the resolved absolute registry DB path for exact worker handoff");
  }
  const result = await runAuto(db, {
    artifactId: opts.artifact,
    workspaceRoot,
    commands: commands(opts).length > 0 ? commands(opts) : ["npm test"],
    maxAttempts: opts.maxAttempts,
    resume: opts.resume,
    producerModel: lastProducerModel,
    worker: scriptedWorker(workspaceRoot, cfg, (model) => { lastProducerModel = model; }, opts.registryDbPath),
    review: harnessReviewer(workspaceRoot, cfg, () => lastProducerModel),
  });
  if (result.status === "blocked" && opts.setExitCode !== false) process.exitCode = 1;
  if (opts.quiet) return result;
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result;
  }
  process.stdout.write(`auto ${result.status} artifact=${opts.artifact} attempts=${result.attempts} run=${result.runId}\n`);
  return result;
}
