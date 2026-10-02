import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { resolveGuildConfig, resolveProviderRoute, resolveTerminationGraceMs, resolveVerificationBudgetMs, resolveWorkspaceRoot } from "../config";
import { resolveAgentLaunch, type HarnessResolution } from "../harness";
import { AutonomousLimitError, formatLimitTerminationNote, limitPhaseForAutoWorker, resolveEffectiveLimit, type EffectiveLimit } from "../limits";
import { resolveAgentSpawn, runManagedProcess } from "../process-exec";
import { runAuto, type AutoResult, type AutoReviewDecision, type AutoReviewInput, type AutoWorkerInput } from "../supervisor/loop";
import { loadActiveStack, resolvePerArtifactVerify } from "../stack";
import { runArtifactVerification, type ArtifactVerificationOutcome } from "../verify";

/**
 * T047: the autonomous worker/reviewer limits, resolved through the same
 * `resolveEffectiveLimit()` the manual runner uses so the knob a rejection
 * names is always the one that actually governed. Enforcement itself (detached
 * process-group spawning, activity tracking, timers, whole-tree termination,
 * single settlement) lives in the shared lifecycle (`process-exec.ts`).
 */
function resolveSpawnLimits(
  limitPhase: string,
  cfg: ReturnType<typeof resolveGuildConfig>,
): { ceiling: EffectiveLimit; inactivity: EffectiveLimit; graceMs: number } {
  return {
    ceiling: resolveEffectiveLimit(limitPhase, "ceiling", cfg, process.env),
    inactivity: resolveEffectiveLimit(limitPhase, "inactivity", cfg, process.env),
    graceMs: resolveTerminationGraceMs(cfg, process.env),
  };
}

function limitTerminationMessage(label: string, limit: EffectiveLimit): string {
  return `${label} killed: limit fired; ${formatLimitTerminationNote(limit)}`;
}

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
  /** T047/T048: this failure was a descriptor-derived limit termination. */
  limitFired?: boolean;
  /** T058: the process-cleanup outcome, when limitFired. */
  cleanupOutcome?: "clean" | "survivors" | "not-applicable";
  survivorPids?: number[];
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

async function spawnHarnessInvocation(
  workspaceRoot: string,
  harness: HarnessResolution,
  agent: string,
  model: string,
  prompt: string,
  env: NodeJS.ProcessEnv,
  cfg: ReturnType<typeof resolveGuildConfig>,
): Promise<ReviewInvocationResult> {
  const args = ["--agent", agent, "--model", model, "--read-only", "-p", prompt];
  // Issue #296: the reviewer launches through the same platform command
  // selection and the same managed lifecycle as the producing worker and the
  // manual runner — process-group leader, limits, operator-signal forwarding,
  // and confirmed whole-tree termination (the autonomous spawn used to lack
  // Windows .sh handling and signal forwarding).
  const spawnPlan = resolveAgentSpawn(harness.command, args);
  const limits = resolveSpawnLimits("review", cfg);
  let output = "";
  let stderr = "";
  const managed = runManagedProcess({
    command: spawnPlan.command,
    args: spawnPlan.args,
    shell: spawnPlan.shell,
    cwd: workspaceRoot,
    env,
    ceiling: limits.ceiling,
    inactivity: limits.inactivity,
    terminationGraceMs: limits.graceMs,
    forwardOperatorSignals: true,
    onOutput: (chunk, stream) => {
      const text = chunk.toString();
      if (stream === "stdout") {
        output += text;
        process.stdout.write(text);
      } else {
        stderr += text;
        process.stderr.write(text);
      }
    },
  });

  const outcome = await managed.settled;
  if (outcome.firingLimit) {
    return {
      ok: false,
      output,
      error: limitTerminationMessage("review-agent", outcome.firingLimit),
      limitFired: true,
      cleanupOutcome: outcome.cleanupResult.cleanupOutcome,
      survivorPids: outcome.cleanupResult.survivorPids,
    };
  }
  if (outcome.spawnError) {
    return { ok: false, output, error: outcome.spawnError };
  }
  if (outcome.exitCode === 0) return { ok: true, output };
  return { ok: false, output, error: stderr.trim() || `reviewer exited with code ${outcome.exitCode ?? 1}` };
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
    let lastWasLimit = false;
    let lastCleanupOutcome: "clean" | "survivors" | "not-applicable" = "not-applicable";
    let lastSurvivorPids: number[] = [];
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
      const invocation = await spawnHarnessInvocation(workspaceRoot, launch.harness, "review-agent", model, prompt, env, cfg);
      if (!invocation.ok) {
        lastError = invocation.error ?? "reviewer invocation failed";
        lastWasLimit = Boolean(invocation.limitFired);
        lastCleanupOutcome = invocation.cleanupOutcome ?? "not-applicable";
        lastSurvivorPids = invocation.survivorPids ?? [];
        continue;
      }
      try {
        const verdict = parseReviewMarker(invocation.output);
        return { ...verdict, reviewerAgent: "review-agent", reviewerModel: model };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        lastWasLimit = false;
        continue;
      }
    }
    if (attempted.size === 0) {
      throw new Error("review route has no model distinct from the producing attempt");
    }
    const message = `independent review failed closed: ${lastError || "review chain exhausted"}`;
    // T047/T048: only a descriptor-derived limit termination routes through
    // the non-throwing review-error close-out; every other reviewer failure
    // still fails closed by propagating out of runAuto.
    throw lastWasLimit ? new AutonomousLimitError(message, lastCleanupOutcome, lastSurvivorPids) : new Error(message);
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
  return async ({ phase, claim, runId, reviewReason }) => {
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
    // Issue #296: the producing worker launches through the same platform
    // command selection and managed lifecycle as the reviewer and the manual
    // runner (Windows .sh via Bash included).
    const spawnPlan = resolveAgentSpawn(harness.command, args);
    const limits = resolveSpawnLimits(limitPhaseForAutoWorker(phase), cfg);
    let harnessOutput = "";
    const managed = runManagedProcess({
      command: spawnPlan.command,
      args: spawnPlan.args,
      shell: spawnPlan.shell,
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
      // R8/FR-035: process-group leader so a limit termination reaches the
      // whole tree this worker started. Piped (not "inherit") so ceiling/
      // inactivity enforcement can observe activity; both streams are still
      // forwarded live to the operator's terminal.
      forwardOperatorSignals: true,
      onOutput: (chunk, stream) => {
        const text = chunk.toString();
        harnessOutput += text;
        // US5 (#121): also buffer the harness CLI's raw stdout+stderr so a
        // non-zero exit can surface its words verbatim — no provider/harness
        // branching (constitution VII: the stderr passes through untouched).
        // Capped at 512.
        (stream === "stdout" ? process.stdout : process.stderr).write(text);
      },
    });

    const producerAgent = phase === "repair" ? "remediation-agent" : "code-writer-agent";
    const outcome = await managed.settled;
    if (outcome.firingLimit) {
      throw new AutonomousLimitError(
        limitTerminationMessage(`${producerAgent} (${phase})`, outcome.firingLimit),
        outcome.cleanupResult.cleanupOutcome,
        outcome.cleanupResult.survivorPids,
      );
    }
    if (outcome.spawnError) {
      throw new Error(`${phase} worker failed to start: ${outcome.spawnError}`);
    }
    if (outcome.exitCode !== 0) {
      const code = outcome.exitCode ?? 1;
      const tail = harnessOutput.slice(0, 512);
      throw new Error(
        `${phase} worker (harness ${harness.name}) exited with code ${code}` +
        (tail ? `:\n${tail}` : ""),
      );
    }
  };
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
  const explicitCommands = commands(opts);
  // US2 (#154) / T012: when the operator passes no --command, the verify step
  // resolves from the active stack pack's `verify.per_artifact` check (e.g.
  // javac-scope-compile for java-spring) — never a hardcoded `npm test`. The
  // check is resolved once per auto invocation and handed to the supervisor as
  // an injected verifier; the loop itself stays unchanged.
  const verifyOverride = explicitCommands.length > 0 ? undefined : (() => {
    let check;
    try {
      check = resolvePerArtifactVerify(loadActiveStack(cfg, workspaceRoot));
    } catch {
      // No pack, unknown pack, or a malformed verify block: a missing check is
      // not a failed verification — runArtifactVerification maps it to an
      // *unverified* outcome rather than blocking.
      check = undefined;
    }
    // A verified outcome must be able to back an arbitration approval the same
    // way `--command` verification does. The loop signs approval evidence
    // with its own run-bound operator credential, so the evidence recorded
    // here (recordEvidence: true) must be signed with that exact credential —
    // the supervisor loop passes it in via ctx (see AutoOptions.verify).
    return async (ctx: { runId: string; operatorToken: string }) => {
      const outcome: ArtifactVerificationOutcome = await runArtifactVerification(db, {
        artifactId: opts.artifact,
        workspaceRoot,
        check,
        budgetMs: resolveVerificationBudgetMs(cfg, process.env, check?.budget_seconds),
        runId: ctx.runId,
        operatorToken: ctx.operatorToken,
        config: cfg,
        recordEvidence: true,
        // Issue #293: the supervisor's claim-close verification already
        // executed the default stack check once for this run — reuse that
        // structured outcome here (for verification state, close-out
        // reporting, and this signed evidence) instead of executing the same
        // check a second time with a separate budget. An explicit --command is
        // a genuinely different check and keeps its own execution.
        reuseClaimCloseOutcome: true,
      });
      return { pass: outcome.state === "verified", evidence: outcome.evidence };
    };
  })();
  const result = await runAuto(db, {
    artifactId: opts.artifact,
    workspaceRoot,
    commands: explicitCommands.length > 0 ? explicitCommands : [],
    maxAttempts: opts.maxAttempts,
    resume: opts.resume,
    producerModel: lastProducerModel,
    verify: verifyOverride,
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
