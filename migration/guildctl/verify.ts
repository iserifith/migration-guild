import { exec, spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { deriveExpectedOutputPaths } from "../registry/commands/claim";
import { addVerifierRuntimeEvidence } from "../registry/commands/evidence";
import { getVerification, setVerification } from "../registry/commands/verification";
import { withVerifySlot } from "../registry/commands/verifySlot";
import type {
  AcceptanceEvidence,
  Artifact,
  VerificationReason,
  VerificationRecord,
  VerificationState,
} from "../registry/types";
import { isPathInside, resolveVerificationBudgetMs, type GuildConfig } from "./config";
import { expandVerifyArgs, expandVerifyWorkingDir, loadActiveStack, resolvePerArtifactVerify, type PerArtifactVerify } from "./stack";
import { isSensitiveEnvName, terminateProcessGroup } from "./util";

// FR-023: one definition of "secret" governs evidence logs, preflight output,
// and the environment divergence report. Re-exported here because this module
// is where callers have always found it.
export { isSensitiveEnvName };

const execAsync = promisify(exec);

export interface VerifyOptions {
  artifactId: string;
  workspaceRoot: string;
  commands: string[];
  outputDir: string;
  runId?: string | null;
  operatorToken?: string | null;
  /** Resolved Guild config; supplies the verify-concurrency slot bound (US5 / #151). */
  config?: Pick<GuildConfig, "verification">;
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
      // US5 (#151) / T023: hold one bounded verify slot across the spawned
      // command so no more than `verification.max_concurrent` verify
      // subprocesses are live at once; released in a `finally` inside
      // withVerifySlot on settle.
      const result = await withVerifySlot(
        db,
        { runId: opts.runId ?? null, artifactId: opts.artifactId, config: opts.config },
        () => execAsync(command, {
          cwd: opts.workspaceRoot,
          env: scrubVerificationEnv(process.env),
          maxBuffer: 10 * 1024 * 1024,
        }),
      );
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

// ─── Bounded per-artifact verification (FR-003–FR-006) ───────────────────────
//
// The unit a check may cover is the claimed artifact's own outputs plus one hop
// of declared dependencies — never the transitive closure, never the whole
// modernized tree. Every path comes from registry rows; core performs no
// filesystem globbing and reads nothing outside the workspace. No outcome of
// this check blocks the artifact from advancing.

/** Statuses at which a dependency's own output can be meaningfully compiled. */
const MIGRATED_OR_LATER = new Set(["migrated", "reviewed", "completed", "skipped"]);

export interface VerificationScope {
  artifactId: string;
  artifactPath: string;
  module: string;
  /** The active claim's recorded expected_output_paths. */
  ownOutputPaths: string[];
  /** Output paths of one-hop declared dependencies. */
  dependencyPaths: string[];
  workspaceRoot: string;
  /** One-hop dependencies that have not reached a migrated-or-later status. */
  unmigratedDependencies: string[];
  /** Set when a recorded path resolves outside the workspace root (FR-005). */
  containmentError?: string;
}

export interface BuildVerificationScopeOptions {
  artifactId: string;
  workspaceRoot: string;
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Build the Verification Scope from registry rows only. No filesystem discovery
 * of any kind happens here — that is the enforcement point for FR-005.
 */
export function buildVerificationScope(
  db: Database.Database,
  opts: BuildVerificationScopeOptions,
): VerificationScope {
  const artifact = db
    .prepare("SELECT id, path, module FROM artifacts WHERE id = ?")
    .get(opts.artifactId) as { id: string; path: string; module: string | null } | undefined;
  if (!artifact) {
    throw new Error(`Artifact not found: "${opts.artifactId}"`);
  }

  const claim = db.prepare(
    "SELECT expected_output_paths FROM artifact_claims WHERE artifact_id = ? ORDER BY rowid DESC LIMIT 1",
  ).get(opts.artifactId) as { expected_output_paths: string | null } | undefined;
  const ownOutputPaths = parseJsonArray(claim?.expected_output_paths);

  // One hop only: declared source dependencies plus graph dependencies. The
  // transitive closure is deliberately never consulted (research R3).
  const oneHop = db.prepare(`
    SELECT DISTINCT d.dependency_id AS id
    FROM (
      SELECT dependency_id FROM source_dependencies WHERE dependent_id = @id
      UNION
      SELECT depends_on_id   FROM dependencies       WHERE artifact_id  = @id
    ) d
  `).all({ id: opts.artifactId }) as Array<{ id: string }>;

  const dependencyPaths: string[] = [];
  const unmigratedDependencies: string[] = [];
  for (const dep of oneHop) {
    const depRow = db.prepare("SELECT id, path, status FROM artifacts WHERE id = ?").get(dep.id) as
      | { id: string; path: string; status: string }
      | undefined;
    if (!depRow) continue;
    const row = depRow;
    if (!MIGRATED_OR_LATER.has(row.status)) {
      unmigratedDependencies.push(row.id);
      continue;
    }
    const depClaim = db.prepare(
      "SELECT expected_output_paths FROM artifact_claims WHERE artifact_id = ? ORDER BY rowid DESC LIMIT 1",
    ).get(row.id) as { expected_output_paths: string | null } | undefined;
    // Prefer the dependency's recorded claim; a dependency migrated without a
    // surviving claim row still has registry-derivable outputs. Both sources are
    // registry rows — neither consults the filesystem.
    const recorded = parseJsonArray(depClaim?.expected_output_paths);
    const depPaths = recorded.length > 0
      ? recorded
      : deriveExpectedOutputPaths({ id: row.id, path: depRow.path } as Artifact, db);
    for (const candidate of depPaths) {
      if (!dependencyPaths.includes(candidate)) dependencyPaths.push(candidate);
    }
  }

  const scope: VerificationScope = {
    artifactId: artifact.id,
    artifactPath: artifact.path,
    module: artifact.module ?? "",
    ownOutputPaths,
    dependencyPaths,
    workspaceRoot: opts.workspaceRoot,
    unmigratedDependencies,
  };

  // Containment (FR-005): assert every path inside the workspace root before a
  // command is ever built. A path resolving outside aborts the check.
  for (const candidate of [...ownOutputPaths, ...dependencyPaths]) {
    const resolved = path.resolve(opts.workspaceRoot, candidate);
    if (!isPathInside(resolved, opts.workspaceRoot)) {
      scope.containmentError = `path escapes the workspace root: ${candidate}`;
      break;
    }
  }

  return scope;
}

export interface ArtifactVerificationOptions {
  artifactId: string;
  workspaceRoot: string;
  /** The stack pack's declared check; `undefined` means no `verify:` block. */
  check?: PerArtifactVerify;
  /** Effective budget override in ms; otherwise derived from the check/config. */
  budgetMs?: number;
  runId?: string | null;
  operatorToken?: string | null;
  claimId?: string | null;
  claimToken?: string | null;
  /** FR-007: the agent stated it could not verify its own output. */
  agentReportedUnverifiable?: boolean;
  /** When false the record is computed but not written (used by callers that persist separately). */
  persist?: boolean;
  /**
   * Resolved Guild config; supplies `verification.max_concurrent` /
   * `budget_seconds` for the bounded verify-concurrency slot (US5 / #151).
   * Optional so existing callers that never spawn a check are unaffected.
   */
  config?: Pick<GuildConfig, "verification">;
}

export interface ArtifactVerificationOutcome {
  state: VerificationState;
  reason: VerificationReason | null;
  method: string;
  detail: string | null;
  scope: string[];
  budgetMs: number;
  durationMs: number | null;
  /** False when the check was skipped (no pack check, unavailable, incomplete tree). */
  ranCheck: boolean;
}

const DEFAULT_VERIFICATION_BUDGET_MS = 120_000;

function probeAvailability(check: PerArtifactVerify, cwd: string): boolean {
  if (!check.availability_args || check.availability_args.length === 0) return true;
  try {
    const result = spawnSync(check.cmd, check.availability_args, {
      cwd,
      env: scrubVerificationEnv(process.env),
      stdio: "ignore",
      shell: false,
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

interface CheckExecution {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
  spawnError?: string;
}

async function executeCheck(
  check: PerArtifactVerify,
  argv: string[],
  cwd: string,
  budgetMs: number,
): Promise<CheckExecution> {
  const started = Date.now();
  return await new Promise<CheckExecution>((resolve) => {
    let settled = false;
    let timedOut = false;
    let output = "";

    let child;
    try {
      child = spawn(check.cmd, argv, {
        cwd,
        env: scrubVerificationEnv(process.env),
        stdio: ["ignore", "pipe", "pipe"],
        // No shell: a placeholder value can never alter the command.
        shell: false,
        // Own process group, so the budget can terminate the whole tree the
        // check started rather than only its direct child.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolve({
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - started,
        output: "",
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const settle = (exitCode: number | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(budgetHandle);
      resolve({ exitCode, timedOut, durationMs: Date.now() - started, output, spawnError });
    };

    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });

    const budgetHandle = setTimeout(() => {
      timedOut = true;
      // FR-004: on elapse the check's process group is terminated using the
      // same mechanism as agent termination, and the record is budget-exhausted.
      void terminateProcessGroup(child.pid, { graceMs: 1000 }).then(() => settle(null));
    }, budgetMs);
    budgetHandle.unref?.();

    child.on("error", (error) => settle(null, error.message));
    child.on("exit", (code) => settle(code));
  });
}

/**
 * Run the stack pack's bounded per-artifact check and record the outcome.
 *
 * Outcome mapping follows contracts/stack-pack-verify.md. No outcome blocks the
 * artifact from advancing: the check informs the record, it does not gate the
 * status transition.
 */
export async function runArtifactVerification(
  db: Database.Database,
  opts: ArtifactVerificationOptions,
): Promise<ArtifactVerificationOutcome> {
  const budgetMs = opts.budgetMs
    ?? (opts.check?.budget_seconds != null ? opts.check.budget_seconds * 1000 : DEFAULT_VERIFICATION_BUDGET_MS);
  const method = opts.check?.id ?? "none";

  const finish = (
    state: VerificationState,
    reason: VerificationReason | null,
    extra: { detail?: string | null; scope?: string[]; durationMs?: number | null; ranCheck?: boolean } = {},
  ): ArtifactVerificationOutcome => {
    const outcome: ArtifactVerificationOutcome = {
      state,
      reason,
      method,
      detail: extra.detail ?? null,
      scope: extra.scope ?? [],
      budgetMs,
      durationMs: extra.durationMs ?? null,
      ranCheck: extra.ranCheck ?? false,
    };
    if (opts.persist !== false) {
      setVerification(db, {
        artifactId: opts.artifactId,
        state: outcome.state,
        method: outcome.method,
        reason: outcome.reason ?? undefined,
        detail: outcome.detail,
        scope: outcome.scope.length > 0 ? outcome.scope : undefined,
        budgetMs: outcome.budgetMs,
        durationMs: outcome.durationMs,
        runId: opts.runId,
        operatorToken: opts.operatorToken,
        claimId: opts.claimId,
        claimToken: opts.claimToken,
      });
    }
    return outcome;
  };

  // FR-007: an agent that says it could not verify its own output must not read
  // as a verified completion.
  if (opts.agentReportedUnverifiable) {
    return finish("unverified", "agent-reported-unverifiable");
  }

  const scope = buildVerificationScope(db, {
    artifactId: opts.artifactId,
    workspaceRoot: opts.workspaceRoot,
  });

  if (scope.containmentError) {
    return finish("verification-failed", "check-error", { detail: scope.containmentError });
  }
  if (!opts.check) {
    return finish("unverified", "no-stack-check", {
      detail: "the active stack pack declares no verify: block",
    });
  }
  // FR-006: an incomplete tree is not a failed verification, and it must not
  // stop the artifact from advancing.
  if (scope.unmigratedDependencies.length > 0) {
    return finish("unverified", "tree-incomplete", {
      detail: `one-hop dependencies not yet migrated: ${scope.unmigratedDependencies.join(", ")}`,
    });
  }

  const values = {
    artifact_path: scope.artifactPath,
    output_paths: scope.ownOutputPaths,
    dependency_paths: scope.dependencyPaths,
    module: scope.module,
    workspace_root: path.resolve(opts.workspaceRoot),
  };

  let argv: string[];
  let workingDir: string;
  try {
    argv = expandVerifyArgs(opts.check.args ?? [], values);
    const relative = expandVerifyWorkingDir(opts.check.working_dir, values);
    workingDir = relative ? path.resolve(opts.workspaceRoot, relative) : path.resolve(opts.workspaceRoot);
  } catch (error) {
    return finish("verification-failed", "check-error", {
      detail: redactSecrets(error instanceof Error ? error.message : String(error)),
    });
  }
  if (!isPathInside(workingDir, opts.workspaceRoot)) {
    return finish("verification-failed", "check-error", {
      detail: `working_dir escapes the workspace root: ${opts.check.working_dir}`,
    });
  }

  // A missing toolchain is not a failed verification.
  if (!probeAvailability(opts.check, path.resolve(opts.workspaceRoot))) {
    return finish("unverified", "no-stack-check", {
      detail: opts.check.unavailable_note?.trim() ?? `${opts.check.cmd} is unavailable`,
    });
  }

  fs.mkdirSync(workingDir, { recursive: true });
  // US5 (#151) / T023: hold one bounded verify slot for the lifetime of the
  // spawned check, so no more than `verification.max_concurrent` verify
  // subprocesses are live at once. The slot is released in a `finally` inside
  // withVerifySlot even when the check times out, errors, or the budget kills
  // its process group. Skipping the no-check / unavailable-tool / incomplete-
  // tree paths above is intentional — those never spawn a subprocess, so they
  // must not consume a slot.
  const execution = await withVerifySlot(
    db,
    { runId: opts.runId ?? null, artifactId: opts.artifactId, config: opts.config },
    () => executeCheck(opts.check!, argv, workingDir, budgetMs),
  );
  const coveredScope = [...scope.ownOutputPaths, ...scope.dependencyPaths];

  if (execution.timedOut) {
    return finish("unverified", "budget-exhausted", {
      detail: `check exceeded its ${budgetMs}ms budget and its process group was terminated`,
      durationMs: execution.durationMs,
      ranCheck: true,
    });
  }
  if (execution.spawnError) {
    return finish("verification-failed", "check-error", {
      detail: redactSecrets(execution.spawnError),
      durationMs: execution.durationMs,
      ranCheck: true,
    });
  }

  const passCodes = opts.check.pass_exit_codes ?? [0];
  if (execution.exitCode != null && passCodes.includes(execution.exitCode)) {
    return finish("verified", null, {
      scope: coveredScope,
      durationMs: execution.durationMs,
      ranCheck: true,
    });
  }

  return finish("verification-failed", "check-failed", {
    detail: redactSecrets(`exit ${execution.exitCode}: ${excerpt(execution.output)}`),
    scope: coveredScope,
    durationMs: execution.durationMs,
    ranCheck: true,
  });
}

/**
 * The verification line of an attempt close-out summary (contract §E).
 *
 * Verification is stated separately from migration status and never restates
 * it: an artifact can be `migrated` and `unverified` at the same time, and the
 * summary must be able to say so.
 */
export function formatVerificationCloseOut(record: VerificationRecord): string {
  const detail = record.reason
    ? `${record.reason}; method: ${record.method}`
    : `method: ${record.method}`;
  return `${record.state} (${detail})`;
}

/**
 * Run verification at claim close and persist the record (T027, FR-006, FR-007).
 *
 * Shared by the manual runner and the autonomous supervisor so both close paths
 * behave identically. Three properties are load-bearing:
 *
 *  - **Nothing here can block the artifact.** Every failure mode is caught and
 *    turned into a recorded verification fact; this function never throws.
 *  - **An agent's own self-report of unverifiability wins.** If the agent
 *    already recorded `agent-reported-unverifiable`, no later check may
 *    overwrite it with `verified` — otherwise the run would read as a verified
 *    completion when the agent said it could not verify its own output.
 *  - **A missing or broken stack pack is not a failed verification.** It maps to
 *    unverified / no-stack-check.
 */
export async function verifyAtClaimClose(
  db: Database.Database,
  opts: {
    artifactId: string;
    workspaceRoot: string;
    config: GuildConfig;
    runId?: string | null;
    operatorToken?: string | null;
    claimId?: string | null;
    claimToken?: string | null;
  },
): Promise<VerificationRecord | null> {
  try {
    const existing = getVerification(db, opts.artifactId);
    if (existing.reason === "agent-reported-unverifiable") {
      // FR-007: preserve the agent's own statement that it could not verify.
      return existing;
    }

    let check: PerArtifactVerify | undefined;
    try {
      check = resolvePerArtifactVerify(loadActiveStack(opts.config, opts.workspaceRoot));
    } catch {
      // No pack, unknown pack, or a malformed verify block: a missing check is
      // not a failed verification.
      check = undefined;
    }

    await runArtifactVerification(db, {
      artifactId: opts.artifactId,
      workspaceRoot: opts.workspaceRoot,
      check,
      budgetMs: resolveVerificationBudgetMs(opts.config, process.env, check?.budget_seconds),
      runId: opts.runId,
      operatorToken: opts.operatorToken,
      claimId: opts.claimId,
      claimToken: opts.claimToken,
      config: opts.config,
    });
    return getVerification(db, opts.artifactId);
  } catch {
    // Verification is a record, never a gate. If even recording it fails, the
    // artifact still advances and the close-out simply has nothing to add.
    return null;
  }
}
