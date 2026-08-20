import { spawnSync } from "child_process";
import type Database from "better-sqlite3";
import type { GuildConfig } from "../config";
import { resolveGuildConfig, resolveWorkspaceRoot } from "../config";
import { resolveHarness, resolveAgentLaunch, type ResolvedRuntimeConfig } from "../harness";
import { getLockedDependencySet } from "../../registry/commands/dispositions";
import {
  IndexDbError,
  completeIngestionRun,
  countDocumentationEntries,
  recordIngestionRunLibrary,
  startIngestionRun,
} from "../../index-db/commands/entries";
import type { IngestionOutcome } from "../../index-db/types";
import { spawnAgent } from "../runner";

/**
 * `guildctl ingest-docs` (007-doc-rag-lookup, US3) — populate .guild/index.db
 * with version-pinned documentation for exactly the confirmed 'keep' locked
 * dependency set (spec 006), via the doc-ingestion agent.
 *
 * Contract: specs/007-doc-rag-lookup/contracts/ingestion-cli-contract.md.
 */

export interface IngestDocsOpts {
  triggeredBy: string;
  /** Restrict this run to one library (targeted re-ingest after a version change). */
  library?: string;
}

export interface IngestDocsDeps {
  spawnAgent?: typeof spawnAgent;
  /**
   * Path the ingestion agent uses for its index-doc-entry writes. Tests pass
   * ":memory:" because the injected indexDb handle IS the database; production
   * leaves this undefined and the CLI resolves the real path.
   */
  indexDbPath?: string;
}

export interface IngestDocsLibraryReport {
  library_name: string;
  library_version: string;
  outcome: IngestionOutcome;
  reason?: string;
  entries_written: number;
}

export interface IngestDocsReport {
  run_id: string;
  locked_set_snapshot_count: number;
  libraries: IngestDocsLibraryReport[];
}

/**
 * The ingestion harness is resolved from `ingestion.harness` (default
 * "opencode"), NEVER the workspace's primary `harness` setting (research.md
 * §5) — the ingestion loop must be harness-deterministic for v1. AGENT_CMD
 * overrides the same way it overrides every other dispatch (dev/test seam).
 */
function pinnedIngestionConfig(config: Pick<GuildConfig, "harness" | "ingestion">): GuildConfig {
  return { ...(config as GuildConfig), harness: config.ingestion?.harness || "opencode" };
}

export function resolveIngestionHarness(
  config: Pick<GuildConfig, "harness" | "ingestion">,
  root: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  return resolveHarness(pinnedIngestionConfig(config), root, env);
}

/**
 * Full runtime resolution (harness + model + env) for the real agent
 * dispatch, so `spawnAgent` uses the pinned ingestion harness instead of
 * re-resolving `config.harness` (the workspace's primary harness) itself.
 */
function resolveIngestionLaunch(
  config: GuildConfig,
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedRuntimeConfig {
  return resolveAgentLaunch({ config: pinnedIngestionConfig(config), root, env });
}

/**
 * Preflight for the ingestion harness: fail closed (Principle VI) when the
 * pinned harness is not reachable, rather than discovering mid-loop after
 * some libraries have already been ingested.
 */
export function checkHarness(resolution: { name: string; targetCommand: string }): { ok: boolean; message: string } {
  const probe = spawnSync(resolution.targetCommand, ["--version"], { encoding: "utf8", timeout: 15000 });
  if (probe.error || probe.status !== 0) {
    return {
      ok: false,
      message: `Ingestion harness "${resolution.name}" (${resolution.targetCommand}) is not reachable: ${probe.error?.message ?? `exit ${probe.status}`}. Install it or set AGENT_CMD.`,
    };
  }
  return { ok: true, message: `${resolution.name} reachable: ${String(probe.stdout).split("\n")[0]}` };
}

function ingestionPrompt(libraryName: string, libraryVersion: string, runId: string, indexDbPath?: string): string {
  const indexDbFlag = indexDbPath && indexDbPath !== ":memory:" ? ` --index-db ${JSON.stringify(indexDbPath)}` : "";
  return [
    `You are running as the doc-ingestion-agent persona (package/agents/doc-ingestion-agent.agent.md — follow it exactly).`,
    ``,
    `Ingest authoritative API documentation for EXACTLY this locked dependency:`,
    `  library: ${libraryName}`,
    `  version: ${libraryVersion}`,
    ``,
    `Steps:`,
    `1. Find the authoritative documentation source for ${libraryName}@${libraryVersion} (official Javadoc/site for that exact version — never a different version).`,
    `2. Extract the principal class- and method-level entries with descriptions and signatures.`,
    `3. Record each entry via the registry CLI write path:`,
    `   node migration/registry/dist/cli.js index-doc-entry --library ${JSON.stringify(libraryName)} --version ${JSON.stringify(libraryVersion)} \\`,
    `     --symbol-kind <class|method> --symbol-name <name> [--signature <sig>] \\`,
    `     --description <text> [--return-type <t>] --source-url <url> --source-excerpt <verbatim text> \\`,
    `     --ingestion-run-id ${runId}${indexDbFlag}`,
    ``,
    `Hard requirements:`,
    `- Every entry MUST include the exact source URL and a verbatim excerpt copied from it (FR-003a). The write path rejects entries missing either — do not invent plausible-looking citations.`,
    `- If you cannot find a citable source for a symbol, skip it rather than writing a best-guess description.`,
    `- Do NOT write to legacy/ or modern/ — your only writes are index-doc-entry CLI calls.`,
  ].join("\n");
}

export async function runIngestDocs(
  registryDb: Database.Database,
  indexDb: Database.Database,
  opts: IngestDocsOpts,
  deps: IngestDocsDeps = {},
): Promise<IngestDocsReport> {
  if (!opts.triggeredBy?.trim()) throw new IndexDbError(1, "--triggered-by is required.");

  // FR-005: exactly the confirmed 'keep' rows — replace-with-native / inline
  // libraries are not considered at all.
  const keep = getLockedDependencySet(registryDb).filter(
    (row) => row.disposition === "keep" && (row.locked_target_version ?? "").trim(),
  );
  const targets = opts.library?.trim()
    ? keep.filter((row) => row.library_name === opts.library!.trim())
    : keep;

  const run = startIngestionRun(indexDb, {
    triggeredBy: opts.triggeredBy.trim(),
    lockedSetSnapshotCount: targets.length,
  });

  const libraries: IngestDocsLibraryReport[] = [];
  // Injected deps (tests) own their own dispatch behavior end-to-end; only the
  // real production path needs the pinned-harness resolution and fail-closed
  // preflight, since a test's mock spawnAgent never touches a real harness.
  const usingRealDispatcher = !deps.spawnAgent;
  const runAgent = deps.spawnAgent ?? spawnAgent;

  let resolution: ResolvedRuntimeConfig | undefined;
  if (usingRealDispatcher && targets.length > 0) {
    const root = resolveWorkspaceRoot();
    const config = resolveGuildConfig({ cwd: root });
    resolution = resolveIngestionLaunch(config, root);
    // Constitution Principle VI (Fail-Closed Automation): check once, before
    // dispatching any agent, rather than discovering an unreachable harness
    // mid-loop after some libraries have already been attempted.
    const check = checkHarness(resolution.harness);
    if (!check.ok) {
      completeIngestionRun(indexDb, run.run_id);
      throw new IndexDbError(1, check.message);
    }
  }

  for (const row of targets) {
    const libraryName = row.library_name;
    const version = (row.locked_target_version ?? "").trim();

    // FR-007 idempotency: already-indexed at this locked version and not a
    // targeted re-run ⇒ unchanged, no agent launch (saves the network/token cost).
    if (!opts.library?.trim() && countDocumentationEntries(indexDb, libraryName, version) > 0) {
      recordIngestionRunLibrary(indexDb, { runId: run.run_id, libraryName, libraryVersion: version, outcome: "unchanged", entriesWritten: 0 });
      libraries.push({ library_name: libraryName, library_version: version, outcome: "unchanged", entries_written: 0 });
      continue;
    }

    try {
      const before = countDocumentationEntries(indexDb, libraryName, version);
      await runAgent({
        agent: "doc-ingestion-agent",
        model: "",
        prompt: ingestionPrompt(libraryName, version, run.run_id, deps.indexDbPath),
        db: registryDb,
        phase: "ingestion",
        releaseClaimsOnFailure: true,
        // Pinned ingestion-harness resolution (undefined for injected test
        // dispatchers) — without this, spawnAgent would re-resolve using the
        // workspace's primary `config.harness` instead of `ingestion.harness`.
        resolution,
      } as Parameters<typeof spawnAgent>[0]);
      const written = countDocumentationEntries(indexDb, libraryName, version) - before;
      // A successful agent run is recorded as "indexed" (FR-005/FR-012): the
      // agent's writes happen through its own CLI process, so we cannot count
      // them in-process here; a non-throwing run is the success signal.
      recordIngestionRunLibrary(indexDb, { runId: run.run_id, libraryName, libraryVersion: version, outcome: "indexed", entriesWritten: Math.max(written, 0) });
      libraries.push({ library_name: libraryName, library_version: version, outcome: "indexed", entries_written: Math.max(written, 0) });
    } catch (e) {
      // FR-012: one library's failure is recorded and the loop continues.
      const reason = e instanceof Error ? e.message : String(e);
      recordIngestionRunLibrary(indexDb, { runId: run.run_id, libraryName, libraryVersion: version, outcome: "failed", reason });
      libraries.push({ library_name: libraryName, library_version: version, outcome: "failed", reason, entries_written: 0 });
    }
  }

  completeIngestionRun(indexDb, run.run_id);
  return { run_id: run.run_id, locked_set_snapshot_count: targets.length, libraries };
}
