import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type Database from "better-sqlite3";
import Sqlite from "better-sqlite3";
import { compareBenchmarkRuns, deriveBenchmarkMetrics, listBenchmarkRuns, recordBenchmarkRun } from "../../registry/commands/benchmark";
import { spawnAgent } from "../runner";
import { getLogDir } from "../util";
import { loadConfig, resolvePhaseModel } from "../config";
import type { BenchmarkMode, BenchmarkRun, BenchmarkVerdict } from "../../registry/types";

export interface BenchmarkRecordOptions {
  mode: BenchmarkMode;
  fixture: string;
  elapsedMs: number;
  totalRuns: number;
  failedRuns: number;
  artifactsPlanned: number;
  artifactsCompleted: number;
  evidencePassRate: number;
  reworkCount: number;
  verdict: BenchmarkVerdict;
  totalCostUsd?: number;
  notes?: string;
  json?: boolean;
}
export interface BenchmarkReportOptions { json?: boolean; mode?: BenchmarkMode; fixture?: string; }
export interface BenchmarkCompareOptions { baseline: string; guild: string; json?: boolean; }
export interface BenchmarkRunOptions { fixture: string; mode?: "guild" | "baseline" | "both"; }

export function runBenchmarkRecord(db: Database.Database, opts: BenchmarkRecordOptions): void {
  const row = recordBenchmarkRun(db, opts);
  if (opts.json) { process.stdout.write(JSON.stringify(row, null, 2) + "\n"); return; }
  process.stdout.write(`✓ Benchmark recorded: ${row.benchmark_id} ${row.mode} ${row.fixture} ${row.verdict}\n`);
}
export function runBenchmarkReport(db: Database.Database, opts: BenchmarkReportOptions = {}): void {
  const rows = listBenchmarkRuns(db, { mode: opts.mode, fixture: opts.fixture });
  if (opts.json) { process.stdout.write(JSON.stringify(rows, null, 2) + "\n"); return; }
  if (rows.length === 0) { process.stdout.write("No benchmark runs recorded.\n"); return; }
  for (const r of rows) {
    const complete = r.artifacts_planned === 0 ? 0 : r.artifacts_completed / r.artifacts_planned;
    process.stdout.write(`${r.benchmark_id} ${r.mode} fixture=${r.fixture} verdict=${r.verdict} elapsed_ms=${r.elapsed_ms} failed_runs=${r.failed_runs} completion=${(complete*100).toFixed(1)}% evidence_pass=${(r.evidence_pass_rate*100).toFixed(1)}% rework=${r.rework_count}\n`);
  }
}
export function runBenchmarkCompare(db: Database.Database, opts: BenchmarkCompareOptions): void {
  const comparison = compareBenchmarkRuns(db, opts.baseline, opts.guild);
  if (opts.json) { process.stdout.write(JSON.stringify(comparison, null, 2) + "\n"); return; }
  process.stdout.write(`Benchmark compare: baseline=${comparison.baseline.benchmark_id} guild=${comparison.guild.benchmark_id}\n`);
  process.stdout.write(`- elapsed_ms delta: ${comparison.deltas.elapsed_ms}\n`);
  process.stdout.write(`- failed_runs delta: ${comparison.deltas.failed_runs}\n`);
  process.stdout.write(`- completion_rate delta: ${(comparison.deltas.completion_rate*100).toFixed(1)}%\n`);
  process.stdout.write(`- evidence_pass_rate delta: ${(comparison.deltas.evidence_pass_rate*100).toFixed(1)}%\n`);
  process.stdout.write(`- rework_count delta: ${comparison.deltas.rework_count}\n`);
  process.stdout.write(`- total_cost_usd delta: ${comparison.deltas.total_cost_usd ?? "n/a"}\n`);
}

function copyWorkspace(kitRoot: string, fixture: string, mode: string): string {
  const fixturePath = path.join(kitRoot, "package", "mock", fixture);
  if (!fs.existsSync(fixturePath)) throw new Error(`Unknown benchmark fixture: ${fixture}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `guild-benchmark-${mode}-`));
  fs.cpSync(fixturePath, path.join(root, "legacy"), { recursive: true });
  fs.mkdirSync(path.join(root, "modern"), { recursive: true });
  fs.cpSync(path.join(kitRoot, "package", "tools"), path.join(root, "migration"), { recursive: true });
  fs.cpSync(path.join(kitRoot, "package", "harness"), path.join(root, "harness"), { recursive: true });
  fs.cpSync(path.join(kitRoot, "stacks"), path.join(root, "stacks"), { recursive: true });
  fs.cpSync(path.join(kitRoot, "package", "agents"), path.join(root, ".github", "agents"), { recursive: true });
  fs.cpSync(path.join(kitRoot, "package", "skills"), path.join(root, ".github", "skills"), { recursive: true });
  fs.cpSync(path.join(kitRoot, "package", "agent-instructions.md"), path.join(root, ".github", "agent-instructions.md"));
  for (const name of ["guildctl.config.json", ".env.example", "agent-shim.mjs"] as const) {
    const source = path.join(kitRoot, "package", name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(root, name));
  }
  const modules = path.join(kitRoot, "migration", "node_modules");
  if (!fs.existsSync(modules)) throw new Error("migration/node_modules is required; run npm install in migration first");
  fs.symlinkSync(modules, path.join(root, "migration", "node_modules"), "junction");
  return root;
}

function executeCli(workspace: string, args: string[]): void {
  // Run the workspace's own tsx (node_modules is symlinked in) and pin the
  // workspace root explicitly — the source layout's __dirname fallback would
  // otherwise overshoot when running cli.ts (not the built dist/).
  const tsxBin = path.join(workspace, "migration", "node_modules", ".bin", "tsx");
  const result = spawnSync(tsxBin, ["migration/guildctl/cli.ts", ...args], {
    cwd: workspace,
    stdio: "inherit",
    env: {
      ...process.env,
      GUILD_WORKSPACE: workspace,
      REGISTRY_DB: path.join(workspace, "migration", "registry.db"),
      GUILDCTL_AUTO_CONFIRM_MAPPINGS: "1",
    },
  });
  if (result.status !== 0) throw new Error(`Benchmark phase failed: guildctl ${args.join(" ")}`);
}

function executeMode(kitRoot: string, fixture: string, mode: "guild" | "baseline"): { workspace: string; startedAt: string; finishedAt: string; elapsedMs: number } {
  const workspace = copyWorkspace(kitRoot, fixture, mode);
  const startedAt = new Date().toISOString();
  const start = process.hrtime.bigint();
  if (mode === "baseline") {
    executeCli(workspace, ["benchmark", "baseline-worker"]);
  } else {
    for (const args of [["inventory"], ["plan"], ["bootstrap"], ["migrate", "--parallel", "1"], ["benchmark", "guild-review-worker"]]) {
      executeCli(workspace, args);
    }
    const modeDb = new Sqlite(path.join(workspace, "migration", "registry.db"));
    try {
      let remaining = (modeDb.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE status = 'needs-rework'").get() as { n: number }).n;
      while (remaining > 0) {
        executeCli(workspace, ["benchmark", "guild-rework-worker"]);
        executeCli(workspace, ["benchmark", "guild-review-worker"]);
        const next = (modeDb.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE status = 'needs-rework'").get() as { n: number }).n;
        if (next >= remaining) break;
        remaining = next;
      }
    } finally { modeDb.close(); }
  }
  return { workspace, startedAt, finishedAt: new Date().toISOString(), elapsedMs: Number((process.hrtime.bigint() - start) / 1_000_000n) };
}

export async function runBenchmarkBaselineWorker(db: Database.Database): Promise<void> {
  const cfg = loadConfig();
  const result = await spawnAgent({
    agent: "migration-agent",
    model: resolvePhaseModel("code-writing", cfg),
    db,
    logDir: getLogDir(),
    phase: "code-writing",
    prompt: [
      "Run a one-pass single-agent migration of every Java file under legacy/ into modern/.",
      "Register every source as a legacy-source artifact if it is absent, then migrate it and self-mark it reviewed.",
      "Do not create acceptance evidence or arbitration decisions; this is the intentionally ungoverned baseline.",
    ].join(" "),
  });
  if (result.exitCode !== 0) throw new Error(`Baseline agent failed with exit code ${result.exitCode}`);
}

async function runWorker(db: Database.Database, agent: string, phase: "code-writing" | "review", prompt: string): Promise<void> {
  const result = await spawnAgent({
    agent,
    model: resolvePhaseModel(phase, loadConfig()),
    db,
    logDir: getLogDir(),
    phase,
    prompt,
  });
  if (result.exitCode !== 0) throw new Error(`${agent} failed with exit code ${result.exitCode}`);
}

export async function runBenchmarkGuildReviewWorker(db: Database.Database): Promise<void> {
  await runWorker(db, "review-agent", "review", [
    "Act only as the Critic for every migrated artifact.",
    "Run executable tests or builds and record the actual command, exit code, pass result, and output with guildctl evidence add.",
    "Do not change artifact status and do not arbitrate; the independent Arbiter runs next.",
  ].join(" "));
  await runWorker(db, "audit-agent", "review", [
    "Act only as the independent Arbiter for every migrated artifact.",
    "Inspect Critic evidence and invoke guildctl arbitrate --approve or --reject for each artifact.",
    "Never set reviewed directly: approval must go through the existing evidence gate and rejection must move the artifact to needs-rework.",
  ].join(" "));
}

export async function runBenchmarkGuildReworkWorker(db: Database.Database): Promise<void> {
  await runWorker(db, "migration-agent", "code-writing", [
    "Rework every artifact currently marked needs-rework from the recorded Critic evidence and arbitration reason.",
    "Modify modern/ as needed, rerun relevant checks, and return each corrected proposal to migrated for a new independent review.",
    "Do not create acceptance evidence, arbitrate, or mark any artifact reviewed.",
  ].join(" "));
}

export async function runBenchmarkRun(db: Database.Database, opts: BenchmarkRunOptions): Promise<void> {
  const requested = opts.mode ?? "both";
  if (!(["guild", "baseline", "both"] as string[]).includes(requested)) throw new Error("Benchmark mode must be guild, baseline, or both");
  const kitRoot = path.resolve(__dirname, "..", "..", "..");
  const modes: Array<"baseline" | "guild"> = requested === "both" ? ["baseline", "guild"] : [requested];
  const recorded: Partial<Record<"baseline" | "guild", BenchmarkRun>> = {};
  for (const mode of modes) {
    process.stdout.write(`Running ${mode} benchmark in a fresh temporary workspace...\n`);
    const execution = executeMode(kitRoot, opts.fixture, mode);
    const modeDb = new Sqlite(path.join(execution.workspace, "migration", "registry.db"), { readonly: true });
    try {
      const registryMode: BenchmarkMode = mode === "baseline" ? "single-agent" : "guild";
      const metrics = deriveBenchmarkMetrics(modeDb, registryMode);
      recorded[mode] = recordBenchmarkRun(db, {
        mode: registryMode, fixture: opts.fixture, startedAt: execution.startedAt, finishedAt: execution.finishedAt,
        elapsedMs: execution.elapsedMs, ...metrics, notes: `workspace=${execution.workspace}`,
      });
    } finally { modeDb.close(); }
  }
  if (recorded.baseline && recorded.guild) {
    runBenchmarkCompare(db, { baseline: recorded.baseline.benchmark_id, guild: recorded.guild.benchmark_id });
  } else {
    const row = recorded.baseline ?? recorded.guild!;
    process.stdout.write(`Benchmark recorded: ${row.benchmark_id} (${row.mode}, ${row.verdict})\n`);
  }
}
