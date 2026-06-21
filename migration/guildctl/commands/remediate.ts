import * as path from "path";
import type Database from "better-sqlite3";
import { spawnAgent, summarizeRunFailures } from "../runner";
import { startPolling } from "../poller";
import { printPhaseHeader, printEvent } from "../dashboard";
import { getLogDir } from "../util";
import { loadConfig, resolvePhaseModel } from "../../provider/config";
import { getStatusCounts } from "../monitoring";

const REMEDIATION_TIMEOUT_MINUTES = Math.max(5, parseInt(process.env["GUILDCTL_REMEDIATION_TIMEOUT_MINS"] ?? "15", 10));

const SUMMARY_STATUSES = [
  "planned",
  "analyzed",
  "in-progress",
  "tests-written",
  "migrated",
  "reviewed",
  "needs-rework",
  "blocked",
  "completed",
  "skipped",
] as const;

export interface RemediateOpts {
  id?: string;
  timeoutMins?: number;
  model?: string;
  prompt?: string;
}

interface RemediateDeps {
  spawnAgent?: typeof spawnAgent;
  startPolling?: typeof startPolling;
  getLogDir?: typeof getLogDir;
}

function makeRemediationPrompt(id?: string, overridePrompt?: string): string {
  if (overridePrompt && overridePrompt.trim().length > 0) return overridePrompt.trim();

  if (id) {
    return [
      `Remediate artifact ${id}.`,
      "Follow remediation-agent instructions exactly.",
      "Diagnose from registry signals and apply exactly one safe registry-only recovery action.",
      "Do not edit files under legacy/ or modern/ during remediation.",
    ].join(" ");
  }

  return [
    "Run one remediation loop for the highest-priority exception.",
    "Follow remediation-agent instructions exactly.",
    "Inspect failed runs, stalled claims, blocked artifacts, and needs-rework artifacts.",
    "Apply exactly one safe registry-only recovery action and stop.",
    "Do not edit files under legacy/ or modern/ during remediation.",
  ].join(" ");
}

function printRemediationSummary(before: Record<string, number>, after: Record<string, number>): void {
  console.log("\n  Remediation summary");

  let hasDelta = false;
  for (const status of SUMMARY_STATUSES) {
    const prev = before[status] ?? 0;
    const next = after[status] ?? 0;
    const delta = next - prev;
    if (delta === 0) continue;
    hasDelta = true;
    const sign = delta > 0 ? "+" : "";
    console.log(`    ${status.padEnd(13)} ${prev} -> ${next} (${sign}${delta})`);
  }

  if (!hasDelta) {
    console.log("    No first-class status changes detected.");
  }
}

export async function runRemediate(
  db: Database.Database,
  opts: RemediateOpts = {},
  deps: RemediateDeps = {},
): Promise<void> {
  const cfg = loadConfig();
  const model = opts.model ?? resolvePhaseModel("review", cfg.provider);
  const timeoutMins = Math.max(1, opts.timeoutMins ?? REMEDIATION_TIMEOUT_MINUTES);
  const prompt = makeRemediationPrompt(opts.id, opts.prompt);
  const runAgent = deps.spawnAgent ?? spawnAgent;
  const poll = deps.startPolling ?? startPolling;
  const logDir = (deps.getLogDir ?? getLogDir)();

  printPhaseHeader("Phase X · Remediation");
  console.log(`  Agent: remediation-agent   Model: ${model}   Timeout: ${timeoutMins}m\n`);
  if (opts.id) {
    console.log(`  Scope: artifact ${opts.id}\n`);
  }

  const before = getStatusCounts(db);
  const stopPolling = poll(db, (events) => {
    for (const e of events) printEvent(e);
  });

  try {
    const result = await runAgent({
      agent: "remediation-agent",
      model,
      prompt,
      db,
      logDir,
      phase: "review",
      timeoutMs: timeoutMins * 60_000,
      releaseClaimsOnFailure: true,
    });

    const after = getStatusCounts(db);
    printRemediationSummary(before, after);

    if (result.logFile) {
      const relative = path.relative(process.cwd(), result.logFile) || result.logFile;
      console.log(`  Log: ${relative}`);
    }

    const failure = summarizeRunFailures([result]);
    if (failure) {
      throw new Error(`Remediation failed: ${failure}`);
    }

    console.log("\n  ✓ Remediation run complete\n");
  } finally {
    stopPolling();
  }
}
