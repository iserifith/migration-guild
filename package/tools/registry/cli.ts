#!/usr/bin/env node
import { Command } from "commander";
import { getDb } from "./db/connection";
import { applySchema } from "./db/schema";
import { RegistryError } from "./types";
import type { Agent, ArtifactTier, EventType, Kind, MappingStrategy, Relation, Role, Status } from "./types";
import {
  addTag,
  registerArtifact,
  releaseTask,
  removeTag,
  setArtifactStatus,
  setArtifactWave,
  updateArtifact,
} from "./commands/artifacts";
import { claimNextTask } from "./commands/claim";
import {
  linkArtifacts,
  listDependencies,
  listDependents,
} from "./commands/dependencies";
import { appendEvent } from "./commands/events";
import { startServer } from "./commands/serve";
import { startRun, finishRun, listRuns } from "./commands/runs";
import {
  confirmMapping,
  createMapping,
  getMappingsSummary,
  listMappings,
} from "./commands/mappings";

import { getContextPath, writeContext } from "./commands/context";
import { appendChangelog, getChangelogPath } from "./commands/changelog";
import { addCompleted, setFocus, setNext } from "./commands/operator";
import {
  getArtifactById,
  getArtifactByPath,
  getEventsQuery,
  listArtifacts,
  listReadyToMigrate,
  showBlockers,
  showCompleted,
  showFileStatus,
  showInProgress,
  showIssues,
  showNext,
  showStatus,
  showTask,
  wavePlan,
} from "./commands/queries";

function out(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function run(fn: () => unknown): void {
  try {
    const result = fn();
    if (result !== undefined) out(result);
    else out({ ok: true });
  } catch (e) {
    if (e instanceof RegistryError) {
      out({ ok: false, error: e.message });
      process.exit(e.code);
    }
    out({ ok: false, error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  }
}

const program = new Command();
program
  .name("registry")
  .description("Migration artifact registry CLI")
  .version("0.1.0");
program.option(
  "--db <path>",
  "Path to registry.db (overrides REGISTRY_DB env)",
);

const db = () => getDb(program.opts()["db"] as string | undefined);

// ─── Utility ─────────────────────────────────────────────────────────────────

program
  .command("init")
  .description("Create registry.db and apply schema")
  .action(() =>
    run(() => {
      applySchema(db());
    }),
  );

program
  .command("migrate")
  .description("Apply pending schema migrations")
  .action(() =>
    run(() => {
      applySchema(db());
    }),
  );

program
  .command("export")
  .description("Dump artifact and all linked data as JSON")
  .requiredOption("--id <id>")
  .action((opts) =>
    run(() => ({
      artifact: getArtifactById(db(), opts.id),
      dependencies: listDependencies(db(), opts.id),
      dependents: listDependents(db(), opts.id),
      events: getEventsQuery(db(), opts.id),
    })),
  );

// ─── Artifacts ───────────────────────────────────────────────────────────────

program
  .command("register-artifact")
  .description("Register a new artifact")
  .requiredOption("--id <id>")
  .requiredOption("--kind <kind>")
  .requiredOption("--path <path>")
  .option("--module <module>")
  .option("--role <role>")
  .option("--framework <framework>")
  .option("--tier <tier>", "first-class or second-class (auto-derived from kind if omitted)")
  .action((opts) =>
    run(() => {
      registerArtifact(db(), {
        id: opts.id,
        kind: opts.kind as Kind,
        path: opts.path,
        module: opts.module,
        role: opts.role as Role | undefined,
        framework: opts.framework,
        tier: opts.tier as ArtifactTier | undefined,
      });
    }),
  );

program
  .command("set-artifact-status")
  .description("Update artifact status")
  .requiredOption("--id <id>")
  .requiredOption("--status <status>")
  .option("--agent <agent>", "Agent or operator recording the status change")
  .option("--model <model>", "Model used when recording the status change")
  .option("--reason <reason>", "Reason for the status change")
  .action((opts) =>
    run(() => {
      setArtifactStatus(db(), opts.id, opts.status as Status, {
        agent: opts.agent,
        model: opts.model,
        reason: opts.reason,
      });
    }),
  );

program
  .command("update-artifact")
  .description("Update artifact classification fields")
  .requiredOption("--id <id>")
  .option("--module <module>")
  .option("--role <role>")
  .option("--framework <framework>")
  .option("--tier <tier>", "first-class or second-class")
  .action((opts) =>
    run(() => updateArtifact(db(), {
      id: opts.id,
      module: opts.module,
      role: opts.role as Role | undefined,
      framework: opts.framework,
      tier: opts.tier as ArtifactTier | undefined,
    })),
  );

program
  .command("add-tag")
  .description("Add a tag to an artifact")
  .requiredOption("--id <id>")
  .requiredOption("--tag <tag>")
  .action((opts) =>
    run(() => {
      addTag(db(), opts.id, opts.tag);
    }),
  );

program
  .command("remove-tag")
  .description("Remove a tag from an artifact")
  .requiredOption("--id <id>")
  .requiredOption("--tag <tag>")
  .action((opts) =>
    run(() => {
      removeTag(db(), opts.id, opts.tag);
    }),
  );

// ─── Dependencies ────────────────────────────────────────────────────────────

program
  .command("link")
  .description("Link two artifacts with a relation")
  .requiredOption("--from <id>")
  .requiredOption("--to <id>")
  .requiredOption("--relation <relation>")
  .action((opts) =>
    run(() => {
      linkArtifacts(db(), opts.from, opts.to, opts.relation as Relation);
    }),
  );

program
  .command("list-dependencies")
  .description("List what an artifact depends on")
  .requiredOption("--id <id>")
  .action((opts) => run(() => listDependencies(db(), opts.id)));

program
  .command("list-dependents")
  .description("List artifacts that depend on this artifact")
  .requiredOption("--id <id>")
  .action((opts) => run(() => listDependents(db(), opts.id)));

// ─── Events ──────────────────────────────────────────────────────────────────

program
  .command("append-event")
  .description("Append an event to the event log")
  .requiredOption("--id <id>")
  .requiredOption("--type <type>")
  .requiredOption("--agent <agent>")
  .option("--model <model>", "Model that ran this agent")
  .requiredOption("--summary <summary>")
  .option("--data <json>")
  .action((opts) =>
    run(() => {
      appendEvent(db(), {
        id: opts.id,
        type: opts.type as EventType,
        agent: opts.agent,
        model: opts.model,
        summary: opts.summary,
        data: opts.data,
      });
    }),
  );

// ─── Context ─────────────────────────────────────────────────────────────────

program
  .command("write-context")
  .description("Write agent context file for an artifact")
  .requiredOption("--id <id>")
  .requiredOption("--agent <agent>")
  .requiredOption("--file <path>")
  .action((opts) =>
    run(() => {
      writeContext(db(), opts.id, opts.agent as Agent, opts.file);
    }),
  );

program
  .command("get-context-path")
  .description("Get the path to an agent context file")
  .requiredOption("--id <id>")
  .requiredOption("--agent <agent>")
  .action((opts) =>
    run(() => getContextPath(db(), opts.id, opts.agent as Agent)),
  );

// ─── Changelog ───────────────────────────────────────────────────────────────

program
  .command("append-changelog")
  .description("Prepend a changelog entry for an artifact")
  .requiredOption("--id <id>")
  .requiredOption("--agent <agent>")
  .requiredOption("--type <event-type>")
  .requiredOption("--entry <markdown-text>")
  .action((opts) =>
    run(() => {
      appendChangelog(db(), {
        id: opts.id,
        agent: opts.agent as Agent,
        type: opts.type as EventType,
        entry: opts.entry,
      });
    }),
  );

program
  .command("get-changelog-path")
  .description("Get the path to an artifact changelog")
  .requiredOption("--id <id>")
  .action((opts) => run(() => getChangelogPath(db(), opts.id)));

// ─── Operator State ──────────────────────────────────────────────────────────

program
  .command("set-focus")
  .description("Set the current migration focus")
  .requiredOption("--legacy-file <path>")
  .requiredOption("--phase <phase>")
  .requiredOption("--target-path <path>")
  .requiredOption("--status <status>")
  .requiredOption("--summary <summary>")
  .action((opts) =>
    run(() => {
      setFocus(db(), {
        legacyFile: opts.legacyFile,
        phase: opts.phase,
        targetPath: opts.targetPath,
        status: opts.status,
        summary: opts.summary,
      });
    }),
  );

program
  .command("set-next")
  .description("Set the next recommended action")
  .requiredOption("--summary <summary>")
  .requiredOption("--reason <reason>")
  .requiredOption("--command <command>")
  .action((opts) =>
    run(() => {
      setNext(db(), {
        summary: opts.summary,
        reason: opts.reason,
        recommendedCommand: opts.command,
      });
    }),
  );

program
  .command("add-completed")
  .description("Record a completed milestone")
  .requiredOption("--id <DONE-ID>")
  .requiredOption("--type <type>")
  .requiredOption("--summary <summary>")
  .option("--artifact-ids <ids>", "Comma-separated artifact IDs")
  .action((opts) =>
    run(() => {
      addCompleted(db(), {
        id: opts.id,
        type: opts.type,
        summary: opts.summary,
        artifactIds: opts.artifactIds
          ? (opts.artifactIds as string).split(",")
          : [],
      });
    }),
  );

// ─── Read / Dashboard ────────────────────────────────────────────────────────

program
  .command("get-artifact")
  .description("Get artifact by ID or path")
  .option("--id <id>")
  .option("--path <path>")
  .action((opts) =>
    run(() => {
      if (opts.id) return getArtifactById(db(), opts.id);
      if (opts.path) return getArtifactByPath(db(), opts.path);
      throw new RegistryError(1, "Provide --id or --path");
    }),
  );

program
  .command("list-artifacts")
  .description("List artifacts with optional filters")
  .option("--kind <kind>")
  .option("--status <status>")
  .option("--tag <tag>")
  .option("--module <module>")
  .option("--tier <tier>", "Filter by tier: first-class or second-class")
  .action((opts) => run(() => listArtifacts(db(), {
    kind: opts.kind as Kind | undefined,
    status: opts.status as Status | undefined,
    tag: opts.tag,
    module: opts.module,
    tier: opts.tier as ArtifactTier | undefined,
  })));

program
  .command("get-events")
  .description("Get events for an artifact")
  .requiredOption("--id <id>")
  .option("--type <type>")
  .option("--limit <n>", "Max events to return", parseInt)
  .action((opts) =>
    run(() =>
      getEventsQuery(
        db(),
        opts.id,
        opts.type as EventType | undefined,
        opts.limit,
      ),
    ),
  );

program
  .command("show-status")
  .description("Show operator dashboard")
  .action(() => run(() => showStatus(db())));

program
  .command("show-task")
  .description("Show current task and recent events")
  .action(() => run(() => showTask(db())));

program
  .command("show-next")
  .description("Show next recommended action")
  .action(() => run(() => showNext(db())));

program
  .command("show-issues")
  .description("Show issues")
  .option("--open-only", "Only show unresolved issues")
  .action((opts) =>
    run(() => showIssues(db(), opts.openOnly as boolean | undefined)),
  );

program
  .command("show-completed")
  .description("Show completed milestones")
  .action(() => run(() => showCompleted(db())));

program
  .command("show-blockers")
  .description("Show blockers")
  .option("--open-only", "Only show active blockers")
  .action((opts) =>
    run(() => showBlockers(db(), opts.openOnly as boolean | undefined)),
  );

program
  .command("show-file-status")
  .description("Show status for a specific file path")
  .requiredOption("--path <path>")
  .action((opts) => run(() => showFileStatus(db(), opts.path)));

// ─── Claim ───────────────────────────────────────────────────────────────────

program
  .command("claim")
  .description(
    "Atomically claim the next available planned artifact for migration. " +
    "Skips artifacts whose dependencies are not yet migrated. " +
    "Returns the claimed artifact as JSON, or exits with code 2 if nothing is available."
  )
  .requiredOption("--agent <agent>", "Name of the agent claiming the task")
  .option("--wave <n>", "Only claim from this wave number", parseInt)
  .option("--from-status <status>", "Claim artifacts with this status (default: planned)", "planned")
  .option("--model <model>", "Model running this agent (logged to events)")
  .action((opts) => run(() => claimNextTask(db(), opts.agent, opts.wave, opts.fromStatus, opts.model)));

// ─── Wave Planning ───────────────────────────────────────────────────────────

program
  .command("set-wave")
  .description("Assign a wave number to an artifact (set during planning)")
  .requiredOption("--id <id>")
  .requiredOption("--wave <n>", "Wave number (1 = first to migrate)", parseInt)
  .action((opts) => run(() => setArtifactWave(db(), opts.id, opts.wave)));

program
  .command("wave-plan")
  .description("Show wave summary: total files and status breakdown per wave")
  .action(() => run(() => wavePlan(db())));

program
  .command("list-ready")
  .description("List all planned artifacts whose dependencies are satisfied (ready to claim)")
  .option("--wave <n>", "Filter to a specific wave", parseInt)
  .action((opts) => run(() => listReadyToMigrate(db(), opts.wave)));

program
  .command("serve")
  .description("Start the registry inspector UI (http://localhost:3322)")
  .option("--port <n>", "Port to listen on", parseInt)
  .action((opts) => startServer(db(), opts.port ?? 3322));

// ─── Runs ─────────────────────────────────────────────────────────────────────

program
  .command("start-run")
  .description("Record the start of an agent run (called by run-agent.sh)")
  .requiredOption("--agent <agent>", "Agent name")
  .option("--model <model>", "Model used")
  .option("--prompt <prompt>", "Prompt sent to the agent")
  .option("--log-file <path>", "Path to the tee log file")
  .action((opts) => run(() => startRun(db(), {
    agent: opts.agent,
    model: opts.model,
    prompt: opts.prompt,
    logFile: opts.logFile,
  })));

program
  .command("finish-run")
  .description("Record the end of an agent run (called by run-agent.sh)")
  .requiredOption("--run-id <id>", "Run ID returned by start-run")
  .requiredOption("--exit-code <n>", "Exit code of the copilot process", parseInt)
  .action((opts) => run(() => finishRun(db(), {
    runId: opts.runId,
    exitCode: opts.exitCode,
  })));

program
  .command("list-runs")
  .description("List recent agent runs")
  .option("--agent <agent>", "Filter by agent name")
  .option("--limit <n>", "Max results (default 20)", parseInt)
  .action((opts) => run(() => listRuns(db(), opts.agent, opts.limit ?? 20)));

program
  .command("release")
  .description(
    "Release a stuck in-progress artifact back to its pre-claim status. " +
    "Use when an agent crashed or looped without completing its task."
  )
  .requiredOption("--id <id>", "Artifact ID to release")
  .requiredOption("--agent <agent>", "Agent or operator performing the release")
  .option("--reason <reason>", "Optional reason for releasing")
  .action((opts) =>
    run(() => releaseTask(db(), opts.id, opts.agent, opts.reason)),
  );

program
  .command("show-in-progress")
  .description("List all currently claimed (in-progress) artifacts with ownership and age")
  .action(() => run(() => showInProgress(db())));

// ─── Stack Mappings ──────────────────────────────────────────────────────────

program
  .command("create-mapping")
  .description("Record a legacy→target framework mapping (created by stack-advisor)")
  .requiredOption("--legacy <framework>", "Legacy framework name")
  .requiredOption("--target <framework>", "Target framework name")
  .option("--strategy <strategy>", "direct | adapter | rewrite")
  .option("--notes <text>", "Optional notes")
  .action((opts) =>
    run(() =>
      createMapping(db(), {
        legacy_framework: opts.legacy,
        target_framework: opts.target,
        strategy: opts.strategy as MappingStrategy | undefined,
        notes: opts.notes,
      }),
    ),
  );

program
  .command("confirm-mapping")
  .description("Human confirms a framework mapping before planning begins")
  .requiredOption("--id <id>", "Mapping ID")
  .requiredOption("--confirmed-by <name>", "Operator or agent confirming")
  .option("--notes <text>", "Optional override notes")
  .action((opts) =>
    run(() => confirmMapping(db(), opts.id, opts.confirmedBy, opts.notes)),
  );

program
  .command("list-mappings")
  .description("List all stack mappings")
  .option("--confirmed-only", "Only show confirmed mappings")
  .action((opts) => run(() => listMappings(db(), opts.confirmedOnly as boolean | undefined)));

program
  .command("show-mapping-summary")
  .description("Show stack mapping confirmation status (used before planning)")
  .action(() => run(() => getMappingsSummary(db())));

program.parse();
