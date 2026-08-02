import { DEFAULT_GUILD_CONFIG, type GuildConfig } from "./config";
import {
  checkHarness,
  resolveAgentLaunch,
  toResolvedRuntimeReport,
  type ConfigDivergence,
  type HarnessResolution,
  type ResolvedRuntimeConfig,
  type ResolvedRuntimeReport,
} from "./harness";

/**
 * Preflight (FR-011–FR-019): prove the runtime a phase run would actually take.
 *
 * Two stages share one wall-clock budget and stop at the first failure:
 *
 *   1. `resolution` — harness, provider base URL, model, and credential
 *      variable through `resolveAgentLaunch()`, the same function the runner
 *      calls, plus adapter reachability when the selected harness ships one.
 *   2. the live stage — exactly one minimal completion issued directly against
 *      the resolved provider base URL/model, asserting a non-empty completion.
 *
 * The live stage deliberately talks to the resolved provider rather than
 * starting the adapter: proving an adapter starts is not proof that a model
 * answers (FR-012). An empty completion is never a pass, and no second
 * completion is ever billed to test adapter fidelity.
 */

export type PreflightVerdict = "pass" | "fail" | "unvalidated";
export type PreflightStageId = "resolution" | "authorization" | "model-availability" | "response";
export type PreflightStageStatus = "pass" | "fail" | "unvalidated";

export interface PreflightStage {
  id: PreflightStageId;
  status: PreflightStageStatus;
  providerReason?: string;
}

export interface PreflightResult {
  verdict: PreflightVerdict;
  /** The stage that failed, named per FR-016. */
  failedStage?: PreflightStageId;
  /** Secret-free projection; absent only when resolution itself threw. */
  resolved?: ResolvedRuntimeReport;
  divergences: ConfigDivergence[];
  stages: PreflightStage[];
  elapsedMs: number;
  /** The effective shared budget for this invocation, in seconds. */
  budgetSeconds: number;
  reason?: string;
}

/** Injectable `fetch`, so provider mapping is hermetic in tests. */
export type FetchLike = (input: unknown, init?: unknown) => Promise<Response>;

export interface PreflightOptions {
  config: GuildConfig;
  root: string;
  env?: NodeJS.ProcessEnv;
  /** Skip the live stage and label it `unvalidated` — never `pass` (FR-018). */
  offline?: boolean;
  /** Per-invocation override of `config.preflight.budget_seconds`. */
  budgetSeconds?: number;
  fetchImpl?: FetchLike;
  /** Adapter reachability probe; defaults to the harness `--version` check. */
  checkAdapter?: (harness: HarnessResolution) => { ok: boolean; message: string };
  now?: () => number;
}

export const DEFAULT_PREFLIGHT_BUDGET_SECONDS = DEFAULT_GUILD_CONFIG.preflight.budget_seconds;

/** Effective shared budget: CLI override → `preflight.budget_seconds` → 30s. */
export function preflightBudgetSeconds(config: Pick<GuildConfig, "preflight">, override?: number): number {
  if (override != null && Number.isFinite(override) && override > 0) return override;
  const configured = config.preflight?.budget_seconds;
  if (configured != null && Number.isFinite(configured) && configured > 0) return configured;
  return DEFAULT_PREFLIGHT_BUDGET_SECONDS;
}

const QUOTA_PATTERN = /quota|billing|insufficient[\s_-]*(balance|credit|funds)|out of credit|payment required/i;
const MODEL_PATTERN = /model[\s_-]*not[\s_-]*found|unknown model|no such model|does not exist|unsupported model|invalid model/i;

/** FR-019: a credential value must never survive into a reported reason. */
function redactCredential(text: string, credentialValue: string | undefined): string {
  if (!credentialValue) return text;
  return text.split(credentialValue).join("<redacted>");
}

function truncate(text: string, limit = 300): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

/** The provider-reported reason, when the provider offered one (FR-016). */
function providerReason(bodyText: string): string | undefined {
  const trimmed = bodyText.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, any>;
    const message = parsed?.error?.message ?? parsed?.error ?? parsed?.message;
    if (typeof message === "string" && message.trim()) return truncate(message);
  } catch {
    // Not JSON — the raw body is the only reason available.
  }
  return truncate(trimmed);
}

function failureStageFor(status: number, bodyText: string): PreflightStageId {
  if (status === 401 || status === 403 || status === 429) return "authorization";
  if (status === 404) return "model-availability";
  if (MODEL_PATTERN.test(bodyText)) return "model-availability";
  if (QUOTA_PATTERN.test(bodyText)) return "authorization";
  return "response";
}

function completionText(parsed: unknown): string {
  const choice = (parsed as any)?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text ?? "";
  return typeof content === "string" ? content : "";
}

interface LiveOutcome {
  kind: "response" | "error" | "budget";
  response?: Response;
  error?: unknown;
}

function budgetRace(remainingMs: number): Promise<LiveOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "budget" }), Math.max(remainingMs, 0));
    // Never hold the process open on the budget timer alone.
    timer.unref?.();
  });
}

export async function runPreflight(opts: PreflightOptions): Promise<PreflightResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const budgetSeconds = preflightBudgetSeconds(opts.config, opts.budgetSeconds);
  const budgetMs = budgetSeconds * 1000;
  const stages: PreflightStage[] = [];

  const finish = (
    verdict: PreflightVerdict,
    extras: { failedStage?: PreflightStageId; resolved?: ResolvedRuntimeReport; divergences?: ConfigDivergence[]; reason?: string },
  ): PreflightResult => ({
    verdict,
    failedStage: extras.failedStage,
    resolved: extras.resolved,
    divergences: extras.divergences ?? [],
    stages,
    elapsedMs: now() - startedAt,
    budgetSeconds,
    reason: extras.reason,
  });

  // ── Stage 1: resolution ────────────────────────────────────────────────────
  let resolution: ResolvedRuntimeConfig;
  try {
    resolution = resolveAgentLaunch({ config: opts.config, root: opts.root, env });
  } catch (error) {
    stages.push({ id: "resolution", status: "fail" });
    return finish("fail", { failedStage: "resolution", reason: error instanceof Error ? error.message : String(error) });
  }

  const resolved = toResolvedRuntimeReport(resolution);
  const divergences = resolution.divergences;
  const credentialValue = resolution.credentialEnv ? env[resolution.credentialEnv] : undefined;

  const resolutionFailure = ((): string | undefined => {
    if (!resolution.model) return "no model resolved; set model.model in Guild configuration";
    if (!resolution.providerBaseUrl) return "no provider base URL resolved; set model.base_url in Guild configuration";
    if (resolution.credentialEnv && !credentialValue) {
      return `${resolution.credentialEnv} is not set; the resolved path has no credential to authenticate with`;
    }
    // FR-011: adapter reachability, but only for a harness that ships an
    // adapter. A custom AGENT_CMD program is the operator's own; the live
    // provider request is what proves the resolved path works.
    if (resolution.harness.source === "config") {
      const probe = (opts.checkAdapter ?? checkHarness)(resolution.harness);
      if (!probe.ok) return probe.message;
    }
    return undefined;
  })();

  if (resolutionFailure) {
    stages.push({ id: "resolution", status: "fail" });
    return finish("fail", {
      failedStage: "resolution",
      resolved,
      divergences,
      reason: redactCredential(resolutionFailure, credentialValue),
    });
  }
  stages.push({ id: "resolution", status: "pass" });

  // ── Offline: label the live stage, never pass it (FR-018) ──────────────────
  if (opts.offline) {
    stages.push({ id: "response", status: "unvalidated" });
    return finish("unvalidated", {
      resolved,
      divergences,
      reason: "offline mode: no live provider request was issued, so the resolved path is unvalidated",
    });
  }

  // ── Stage 2: one live request through the resolved provider route ──────────
  const elapsedMs = now() - startedAt;
  if (elapsedMs >= budgetMs) {
    stages.push({ id: "response", status: "fail" });
    return finish("fail", {
      failedStage: "response",
      resolved,
      divergences,
      reason: `the ${budgetSeconds}s preflight budget elapsed during resolution`,
    });
  }

  const fetchImpl = opts.fetchImpl ?? ((input: unknown, init?: unknown) => (globalThis.fetch as any)(input, init));
  const url = `${resolution.providerBaseUrl.replace(/\/$/, "")}/chat/completions`;
  const request = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(credentialValue ? { authorization: `Bearer ${credentialValue}` } : {}),
    },
    body: JSON.stringify({
      model: resolution.model,
      messages: [{ role: "user", content: "preflight" }],
      max_tokens: 16,
      temperature: 0,
    }),
  };

  const outcome: LiveOutcome = await Promise.race([
    fetchImpl(url, request).then(
      (response: Response): LiveOutcome => ({ kind: "response", response }),
      (error: unknown): LiveOutcome => ({ kind: "error", error }),
    ),
    budgetRace(budgetMs - elapsedMs),
  ]);

  const liveFailure = (stage: PreflightStageId, reason: string): PreflightResult => {
    stages.push({ id: stage, status: "fail", providerReason: reason });
    return finish("fail", { failedStage: stage, resolved, divergences, reason });
  };

  if (outcome.kind === "budget") {
    return liveFailure("response", `the live provider request exceeded the ${budgetSeconds}s preflight budget`);
  }
  if (outcome.kind === "error") {
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    return liveFailure("response", redactCredential(`provider request failed: ${truncate(message)}`, credentialValue));
  }

  const response = outcome.response!;
  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return liveFailure("response", redactCredential(`provider response could not be read: ${truncate(message)}`, credentialValue));
  }

  if (!response.ok) {
    const stage = failureStageFor(response.status, bodyText);
    const reported = providerReason(bodyText);
    const reason = `provider returned HTTP ${response.status}${reported ? `: ${reported}` : ""}`;
    return liveFailure(stage, redactCredential(reason, credentialValue));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return liveFailure("response", "provider returned a malformed response body");
  }

  if (!completionText(parsed).trim()) {
    // FR-012: a reachable provider that answers with nothing is not a pass, and
    // preflight does not retry to find a better answer.
    return liveFailure("response", "provider returned an empty completion");
  }

  stages.push({ id: "response", status: "pass" });
  return finish("pass", { resolved, divergences });
}

// ─── Reporting (FR-013, FR-014, FR-019) ──────────────────────────────────────

const VERDICT_HEADING: Record<PreflightVerdict, string> = {
  pass: "✓ preflight PASSED",
  fail: "✗ preflight FAILED",
  unvalidated: "⚠ preflight UNVALIDATED (offline: the live provider check was skipped)",
};

/**
 * The human-readable block. `resolved` is printed on every verdict; the
 * credential setting name is printed, its value never is.
 */
export function renderPreflightReport(result: PreflightResult): string {
  const lines = [VERDICT_HEADING[result.verdict]];
  if (result.failedStage) lines.push(`  stage:      ${result.failedStage}`);
  if (result.resolved) {
    const { harness, providerBaseUrl, model, credentialEnv } = result.resolved;
    lines.push(`  harness:    ${harness.name} (${harness.source === "environment" ? "AGENT_CMD override" : harness.command})`);
    lines.push(`  provider:   ${providerBaseUrl || "(unset)"}`);
    lines.push(`  model:      ${model || "(unset)"}`);
    lines.push(`  credential: ${credentialEnv || "(none required)"}`);
  }
  if (result.reason) lines.push(`  reason:     ${result.reason}`);
  lines.push(`  elapsed:    ${(result.elapsedMs / 1000).toFixed(1)}s (budget ${result.budgetSeconds}s)`);
  if (result.divergences.length > 0) {
    lines.push("  divergences:");
    for (const divergence of result.divergences) {
      lines.push(`    ${divergence.setting}: declared ${divergence.declaredValue || "(unset)"} → resolved ${divergence.resolvedValue || "(unset)"}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The JSON projection of `specs/001-truthful-run-state/contracts/guildctl-cli.md` §A. */
export function preflightJson(result: PreflightResult): Record<string, unknown> {
  return {
    verdict: result.verdict,
    ...(result.failedStage ? { failed_stage: result.failedStage } : {}),
    resolved: result.resolved
      ? {
        harness: result.resolved.harness.name,
        harness_command: result.resolved.harness.command,
        provider: result.resolved.providerBaseUrl,
        model: result.resolved.model,
        credential_env: result.resolved.credentialEnv,
      }
      : null,
    divergences: result.divergences.map((divergence) => ({
      setting: divergence.setting,
      declared: divergence.declaredValue,
      resolved: divergence.resolvedValue,
    })),
    stages: result.stages.map((stage) => ({
      id: stage.id,
      status: stage.status,
      ...(stage.providerReason ? { provider_reason: stage.providerReason } : {}),
    })),
    elapsed_ms: result.elapsedMs,
    budget_seconds: result.budgetSeconds,
    ...(result.reason ? { reason: result.reason } : {}),
  };
}
