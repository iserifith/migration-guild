import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import type { ProviderClient } from "../provider-client";
import type { EvalConfig } from "../config";
import { getArtifactById } from "../../registry/commands/queries";
import { appendChangelog } from "../../registry/commands/changelog";
import { addAcceptanceEvidence, approveArtifactWithEvidence, rejectArtifactWithEvidence } from "../../registry/commands/evidence";
import { runAllEvaluators, type EvaluatorInput, type EvaluatorResult } from "./evaluators";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EvalArtifactOptions {
  autoAdvance?: boolean;
}

export interface EvalArtifactResult {
  artifactId: string;
  pass: boolean;
  score: number | null;
  results: EvaluatorResult[];
}

// ─── Path resolution ──────────────────────────────────────────────────────────

/**
 * Rebase a legacy source path under modern/src/main/java/.
 * Handles paths that already contain the src/main/java/ segment.
 */
function resolveModernSourcePath(legacyPath: string): string {
  const marker = "src/main/java/";
  const idx = legacyPath.indexOf(marker);
  if (idx !== -1) {
    return path.join("modern", legacyPath.slice(idx));
  }
  return path.join("modern", "src", "main", "java", path.basename(legacyPath));
}

/**
 * Derive the expected test file path under modern/src/test/java/.
 * Appends "Test" before the .java extension (e.g. Foo.java → FooTest.java).
 */
function resolveTestSourcePath(legacyPath: string): string | undefined {
  const marker = "src/main/java/";
  const idx = legacyPath.indexOf(marker);
  if (idx === -1) return undefined;
  const rel = legacyPath.slice(idx + marker.length);
  const testRel = rel.replace(/\.java$/, "Test.java");
  return path.join("modern", "src", "test", "java", testRel);
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

function ensureTag(db: Database.Database, artifactId: string, tag: string): void {
  const exists = db
    .prepare("SELECT 1 FROM artifact_tags WHERE artifact_id = ? AND tag = ?")
    .get(artifactId, tag);
  if (!exists) {
    db.prepare("INSERT INTO artifact_tags (artifact_id, tag) VALUES (?, ?)").run(
      artifactId,
      tag,
    );
  }
}

function insertEvent(
  db: Database.Database,
  artifactId: string,
  type: string,
  summary: string,
  eventData?: string,
): void {
  db.prepare(
    `INSERT INTO events (artifact_id, type, agent, model, summary, event_data)
     VALUES (@artifact_id, @type, @agent, @model, @summary, @event_data)`,
  ).run({
    artifact_id: artifactId,
    type,
    agent: "eval-runner",
    model: null,
    summary,
    event_data: eventData ?? null,
  });
}

// ─── Main function ────────────────────────────────────────────────────────────

/**
 * Evaluate a registered artifact against all enabled evaluators, persist results
 * to the evaluations table, tag the artifact, and optionally auto-advance its status.
 */
export async function evaluateArtifact(
  db: Database.Database,
  client: ProviderClient,
  artifactId: string,
  cfg: EvalConfig,
  opts: EvalArtifactOptions = {},
): Promise<EvalArtifactResult> {
  const artifact = getArtifactById(db, artifactId);

  const legacySourcePath = artifact.path;
  const modernSourcePath = resolveModernSourcePath(legacySourcePath);
  const testSourcePath = resolveTestSourcePath(legacySourcePath);

  const input: EvaluatorInput = {
    artifactId,
    legacySourcePath,
    modernSourcePath,
    testSourcePath,
  };

  const results = await runAllEvaluators(input, client, cfg);

  // Persist individual evaluator rows
  const insertEval = db.prepare(
    `INSERT INTO evaluations (artifact_id, evaluator, score, pass, feedback, model)
     VALUES (@artifact_id, @evaluator, @score, @pass, @feedback, @model)`,
  );
  for (const r of results) {
    insertEval.run({
      artifact_id: artifactId,
      evaluator: r.evaluator,
      score: r.score ?? null,
      pass: r.pass ? 1 : 0,
      feedback: r.feedback,
      model: r.model,
    });
  }

  // Aggregate score: mean of non-null scores
  const scored = results.filter((r) => r.score !== null);
  const aggregateScore =
    scored.length > 0
      ? scored.reduce((sum, r) => sum + (r.score as number), 0) / scored.length
      : null;

  const allPass = results.every((r) => r.pass);
  const anyPass = results.some((r) => r.pass);
  const overallPass =
    allPass && (aggregateScore === null || aggregateScore >= cfg.passThreshold);

  // Tag the artifact
  const evalTag = overallPass
    ? "eval-passed"
    : !anyPass
      ? "eval-failed"
      : "eval-partial";
  ensureTag(db, artifactId, evalTag);

  // Summarise results in a single string
  const summary = results
    .map(
      (r) =>
        `${r.evaluator}: ${r.pass ? "PASS" : "FAIL"} (score=${r.score ?? "n/a"})`,
    )
    .join(", ");

  // Record evaluation event
  insertEvent(
    db,
    artifactId,
    "evaluated",
    `Evaluation complete. Overall: ${overallPass ? "PASS" : "FAIL"}. ${summary}`,
    JSON.stringify({ pass: overallPass, score: aggregateScore, results }),
  );

  const evidence = addAcceptanceEvidence(db, {
    artifactId,
    producedBy: "eval-runner",
    evidenceType: overallPass ? "static-check" : "review-verdict",
    command: "guildctl evaluate-artifact",
    exitCode: overallPass ? 0 : 1,
    pass: overallPass ? 1 : 0,
    summary: `Evaluation ${overallPass ? "passed" : "failed"}. ${summary}`,
    outputExcerpt: summary,
  });

  insertEvent(
    db,
    artifactId,
    "evidence-submitted",
    `Evaluation evidence submitted: ${overallPass ? "PASS" : "FAIL"}. ${summary}`,
    JSON.stringify({ role: "critic", evidence_id: evidence.evidence_id, pass: evidence.pass, evidence_type: evidence.evidence_type }),
  );

  // Auto-advance only through arbitration. The evaluator produces evidence;
  // guildctl-arbiter decides from that evidence so Builder/Critic cannot self-approve.
  const autoAdvance = opts.autoAdvance ?? cfg.autoAdvance;
  if (autoAdvance) {
    if (overallPass) {
      approveArtifactWithEvidence(db, {
        artifactId,
        arbiter: "guildctl-arbiter",
        reason: `Evaluation passed (score=${aggregateScore ?? "n/a"}).`,
        evidenceIds: [evidence.evidence_id],
      });
    } else {
      rejectArtifactWithEvidence(db, {
        artifactId,
        arbiter: "guildctl-arbiter",
        reason: `Evaluation failed. ${summary}`,
        evidenceIds: [evidence.evidence_id],
      });

      insertEvent(
        db,
        artifactId,
        "auto-rework",
        `Auto-set to needs-rework after evaluation failed. ${summary}`,
      );

      const feedbackSummary = results
        .filter((r) => !r.pass)
        .map((r) => `**${r.evaluator}**: ${r.feedback}`)
        .join("\n\n");

      appendChangelog(db, {
        id: artifactId,
        agent: "orchestrator",
        type: "auto-rework",
        entry: `### Evaluation failed\n\n${feedbackSummary}`,
      });
    }
  }

  return { artifactId, pass: overallPass, score: aggregateScore, results };
}
