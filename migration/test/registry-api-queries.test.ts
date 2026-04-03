/**
 * registry-api-queries.test.ts
 *
 * Integration tests for the monitoring dashboard query helpers introduced in
 * Wave 0.  Tests run entirely in-memory — no network, no real DB file.
 *
 * Patterns:
 *   - node:test + node:assert/strict  (same as all other tests in this dir)
 *   - better-sqlite3 in-memory database with applySchema()
 *   - appendEvent() for event insertion (validates artifact exists first)
 *   - Direct SQL for operator_state and runs (no typed helper needed there)
 */

import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { appendEvent } from "../registry/commands/events";
import {
  queryStatusSummary,
  queryArtifactsForUI,
  queryEventsForUI,
  queryWavePlanForUI,
  queryStalledSessions,
  queryOpenBlockers,
  queryOpenIssues,
  queryRunHistory,
  queryEvaluationSummary,
  queryCostSummary,
} from "../registry/commands/queries";
import { applySchema } from "../registry/db/schema";

// ─── Shared helpers ──────────────────────────────────────────────────────────

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function registerArt(
  db: Database.Database,
  id: string,
  opts: { wave?: number; status?: Parameters<typeof setArtifactStatus>[2]; module?: string } = {},
): void {
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    path: `legacy/src/${id.replaceAll(":", "/")}.java`,
    tier: "first-class",
    module: opts.module,
  });
  if (opts.wave !== undefined) setArtifactWave(db, id, opts.wave);
  if (opts.status)             setArtifactStatus(db, id, opts.status);
}

function setOperatorState(db: Database.Database, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO operator_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, JSON.stringify(value));
}

// ─── queryStatusSummary ───────────────────────────────────────────────────────

test("queryStatusSummary: counts reflect actual artifact statuses", () => {
  const db = createDb();
  try {
    registerArt(db, "legacy-source:com.acme:Alpha",   { status: "planned"     });
    registerArt(db, "legacy-source:com.acme:Beta",    { status: "in-progress" });
    registerArt(db, "legacy-source:com.acme:Gamma",   { status: "completed"   });
    registerArt(db, "legacy-source:com.acme:Delta",   { status: "skipped"     });

    const result = queryStatusSummary(db);

    assert.equal(result.files.total,       4);
    assert.equal(result.files.in_progress, 1);
    assert.equal(result.files.completed,   2); // completed + skipped
    assert.equal(result.files.by_status["planned"],     1);
    assert.equal(result.files.by_status["in-progress"], 1);
    assert.equal(result.files.by_status["completed"],   1);
    assert.equal(result.files.by_status["skipped"],     1);
  } finally {
    db.close();
  }
});

test("queryStatusSummary: reads operator_state key 'next', not 'next_action'", () => {
  const db = createDb();
  try {
    // Store under the correct key "next" — the old serve.ts queried "next_action"
    // and always got null.  This test pins the correct behaviour.
    setOperatorState(db, "next", { artifact: "legacy-source:com.acme:Foo", reason: "highest priority" });

    const result = queryStatusSummary(db);

    assert.ok(result.next !== null, "next should be non-null when operator_state key 'next' is set");
    assert.deepEqual(result.next, { artifact: "legacy-source:com.acme:Foo", reason: "highest priority" });
  } finally {
    db.close();
  }
});

test("queryStatusSummary: next is null when key 'next' is absent (not 'next_action')", () => {
  const db = createDb();
  try {
    // Insert under the wrong key name that the old code used — must remain null
    setOperatorState(db, "next_action", { artifact: "legacy-source:com.acme:Bar" });

    const result = queryStatusSummary(db);

    assert.equal(result.next, null,
      "next must be null when only 'next_action' exists — correct key is 'next'");
  } finally {
    db.close();
  }
});

test("queryStatusSummary: current_focus is parsed JSON, not a raw string", () => {
  const db = createDb();
  try {
    setOperatorState(db, "current_focus", { legacyFile: "legacy/src/Foo.java" });

    const result = queryStatusSummary(db);

    assert.deepEqual(result.current_focus, { legacyFile: "legacy/src/Foo.java" });
  } finally {
    db.close();
  }
});

test("queryStatusSummary: includes open_blockers and open_issues arrays", () => {
  const db = createDb();
  try {
    const result = queryStatusSummary(db);

    assert.ok(Array.isArray(result.open_blockers), "open_blockers should be an array");
    assert.ok(Array.isArray(result.open_issues),   "open_issues should be an array");
  } finally {
    db.close();
  }
});

// ─── queryArtifactsForUI ─────────────────────────────────────────────────────

test("queryArtifactsForUI: returns all artifacts when no filter is given", () => {
  const db = createDb();
  try {
    registerArt(db, "legacy-source:com.acme:A");
    registerArt(db, "legacy-source:com.acme:B");

    const rows = queryArtifactsForUI(db);
    assert.equal(rows.length, 2);
  } finally {
    db.close();
  }
});

test("queryArtifactsForUI: filters by status", () => {
  const db = createDb();
  try {
    registerArt(db, "legacy-source:com.acme:InProg",  { status: "in-progress" });
    registerArt(db, "legacy-source:com.acme:Planned", { status: "planned"     });

    const rows = queryArtifactsForUI(db, { status: "in-progress" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "in-progress");
  } finally {
    db.close();
  }
});

test("queryArtifactsForUI: filters by module", () => {
  const db = createDb();
  try {
    registerArt(db, "legacy-source:com.acme:Alpha", { module: "payments" });
    registerArt(db, "legacy-source:com.acme:Beta",  { module: "orders"   });

    const rows = queryArtifactsForUI(db, { module: "payments" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].module, "payments");
  } finally {
    db.close();
  }
});

test("queryArtifactsForUI: returns expected DTO fields", () => {
  const db = createDb();
  try {
    registerArt(db, "legacy-source:com.acme:Z", { wave: 2, status: "planned" });

    const [row] = queryArtifactsForUI(db);
    // Spot-check all the fields the UI depends on
    assert.ok("id"         in row);
    assert.ok("slug"       in row);
    assert.ok("kind"       in row);
    assert.ok("tier"       in row);
    assert.ok("path"       in row);
    assert.ok("status"     in row);
    assert.ok("wave"       in row);
    assert.ok("created_at" in row);
    assert.ok("updated_at" in row);
    assert.equal(row.wave,   2);
    assert.equal(row.status, "planned");
  } finally {
    db.close();
  }
});

// ─── queryEventsForUI ────────────────────────────────────────────────────────

test("queryEventsForUI: returns correct column aliases for the UI", () => {
  const db = createDb();
  try {
    const id = "legacy-source:com.acme:EvtTest";
    registerArt(db, id);
    appendEvent(db, {
      id,
      type: "analyzed",
      agent: "analyze-agent",
      model: "gpt-4o",
      summary: "Initial analysis complete",
      data: JSON.stringify({ complexity: "medium" }),
    });

    const rows = queryEventsForUI(db, id);
    assert.equal(rows.length, 1);

    const row = rows[0];
    // UI expects: id (not event_id), event_type (not type), note (not summary), created_at (not ts)
    assert.ok("id"          in row, "should have field 'id' (alias for event_id)");
    assert.ok("event_type"  in row, "should have field 'event_type' (alias for type)");
    assert.ok("note"        in row, "should have field 'note' (alias for summary)");
    assert.ok("created_at"  in row, "should have field 'created_at' (alias for ts)");
    assert.ok(!("event_id" in row), "must NOT expose raw 'event_id' column name");
    assert.ok(!("type"     in row), "must NOT expose raw 'type' column name");
    assert.ok(!("summary"  in row), "must NOT expose raw 'summary' column name");
    assert.ok(!("ts"       in row), "must NOT expose raw 'ts' column name");

    assert.equal(row.event_type, "analyzed");
    assert.equal(row.agent,      "analyze-agent");
    assert.equal(row.model,      "gpt-4o");
    assert.equal(row.note,       "Initial analysis complete");
  } finally {
    db.close();
  }
});

test("queryEventsForUI: parses event_data JSON into an object", () => {
  const db = createDb();
  try {
    const id = "legacy-source:com.acme:EvtJson";
    registerArt(db, id);
    appendEvent(db, {
      id,
      type: "analyzed",
      agent: "analyze-agent",
      summary: "done",
      data: JSON.stringify({ score: 0.9, tags: ["fast"] }),
    });

    const [row] = queryEventsForUI(db, id);
    assert.deepEqual(row.event_data, { score: 0.9, tags: ["fast"] });
  } finally {
    db.close();
  }
});

test("queryEventsForUI: event_data is null when not stored", () => {
  const db = createDb();
  try {
    const id = "legacy-source:com.acme:EvtNull";
    registerArt(db, id);
    appendEvent(db, { id, type: "analyzed", agent: "analyze-agent", summary: "no data" });

    const [row] = queryEventsForUI(db, id);
    assert.equal(row.event_data, null);
  } finally {
    db.close();
  }
});

test("queryEventsForUI: respects limit parameter", () => {
  const db = createDb();
  try {
    const id = "legacy-source:com.acme:EvtLimit";
    registerArt(db, id);
    for (let i = 0; i < 5; i++) {
      appendEvent(db, { id, type: "analyzed", agent: "agent", summary: `event ${i}` });
    }

    const rows = queryEventsForUI(db, id, 3);
    assert.equal(rows.length, 3);
  } finally {
    db.close();
  }
});

test("queryEventsForUI: returns empty array for artifact with no events", () => {
  const db = createDb();
  try {
    registerArt(db, "legacy-source:com.acme:NoEvts");
    const rows = queryEventsForUI(db, "legacy-source:com.acme:NoEvts");
    assert.deepEqual(rows, []);
  } finally {
    db.close();
  }
});

// ─── queryWavePlanForUI ──────────────────────────────────────────────────────

test("queryWavePlanForUI: returns wave breakdown for first-class artifacts only", () => {
  const db = createDb();
  try {
    registerArt(db, "legacy-source:com.acme:W1A", { wave: 1, status: "planned"   });
    registerArt(db, "legacy-source:com.acme:W1B", { wave: 1, status: "migrated"  });
    registerArt(db, "legacy-source:com.acme:W2A", { wave: 2, status: "planned"   });

    const waves = queryWavePlanForUI(db);

    assert.equal(waves.length, 2);

    const w1 = waves.find((w) => w.wave === 1);
    assert.ok(w1);
    assert.equal(w1.total, 2);
    assert.equal(w1.by_status["planned"],  1);
    assert.equal(w1.by_status["migrated"], 1);

    const w2 = waves.find((w) => w.wave === 2);
    assert.ok(w2);
    assert.equal(w2.total, 1);
  } finally {
    db.close();
  }
});

test("queryWavePlanForUI: returns [] when no waves are assigned", () => {
  const db = createDb();
  try {
    registerArt(db, "legacy-source:com.acme:NoWave");
    const waves = queryWavePlanForUI(db);
    assert.deepEqual(waves, []);
  } finally {
    db.close();
  }
});

// ─── queryStalledSessions ─────────────────────────────────────────────────────

test("queryStalledSessions: marks sessions older than threshold as stalled", () => {
  const db = createDb();
  try {
    registerArt(db, "legacy-source:com.acme:Stalled", { status: "in-progress" });

    // Simulate a claim that happened 120 minutes ago
    db.prepare(
      `UPDATE artifacts
       SET claimed_by = 'migration-agent',
           claimed_at = datetime('now', '-120 minutes')
       WHERE id = 'legacy-source:com.acme:Stalled'`,
    ).run();

    const sessions = queryStalledSessions(db, 60);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].stalled, true);
    assert.ok((sessions[0].claimed_minutes_ago ?? 0) >= 120);
  } finally {
    db.close();
  }
});

test("queryStalledSessions: does not mark recent sessions as stalled", () => {
  const db = createDb();
  try {
    registerArt(db, "legacy-source:com.acme:Fresh", { status: "in-progress" });

    db.prepare(
      `UPDATE artifacts
       SET claimed_by = 'migration-agent',
           claimed_at = datetime('now', '-5 minutes')
       WHERE id = 'legacy-source:com.acme:Fresh'`,
    ).run();

    const sessions = queryStalledSessions(db, 60);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].stalled, false);
  } finally {
    db.close();
  }
});

test("queryStalledSessions: only includes in-progress artifacts", () => {
  const db = createDb();
  try {
    registerArt(db, "legacy-source:com.acme:IP",      { status: "in-progress" });
    registerArt(db, "legacy-source:com.acme:Planned", { status: "planned"     });

    const sessions = queryStalledSessions(db);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, "legacy-source:com.acme:IP");
  } finally {
    db.close();
  }
});

// ─── queryOpenBlockers ────────────────────────────────────────────────────────

test("queryOpenBlockers: returns blockers not yet unblocked", () => {
  const db = createDb();
  try {
    const id = "legacy-source:com.acme:BlockedArt";
    registerArt(db, id);
    appendEvent(db, {
      id,
      type: "blocked",
      agent: "migration-agent",
      summary: "Blocked on upstream schema decision",
      data: JSON.stringify({ blocker_id: "BLK-001" }),
    });

    const blockers = queryOpenBlockers(db);
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0].artifact_id, id);
    assert.equal(blockers[0].blocker_id,  "BLK-001");
    assert.equal(blockers[0].summary,     "Blocked on upstream schema decision");
  } finally {
    db.close();
  }
});

test("queryOpenBlockers: does not return a blocker that has been unblocked", () => {
  const db = createDb();
  try {
    const id = "legacy-source:com.acme:UnblockedArt";
    registerArt(db, id);
    appendEvent(db, {
      id,
      type: "blocked",
      agent: "migration-agent",
      summary: "Temporary blocker",
      data: JSON.stringify({ blocker_id: "BLK-002" }),
    });
    appendEvent(db, {
      id,
      type: "unblocked",
      agent: "orchestrator",
      summary: "Resolved",
      data: JSON.stringify({ blocker_id: "BLK-002" }),
    });

    const blockers = queryOpenBlockers(db);
    assert.equal(blockers.length, 0);
  } finally {
    db.close();
  }
});

// ─── queryOpenIssues ─────────────────────────────────────────────────────────

test("queryOpenIssues: returns issues not yet resolved", () => {
  const db = createDb();
  try {
    const id = "legacy-source:com.acme:IssuedArt";
    registerArt(db, id);
    appendEvent(db, {
      id,
      type: "issue-opened",
      agent: "review-agent",
      summary: "Null pointer risk in doFoo()",
      data: JSON.stringify({ issue_id: "ISS-42", severity: "high", category: "correctness" }),
    });

    const issues = queryOpenIssues(db);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].artifact_id, id);
    assert.equal(issues[0].issue_id,    "ISS-42");
    assert.equal(issues[0].severity,    "high");
    assert.equal(issues[0].category,    "correctness");
  } finally {
    db.close();
  }
});

test("queryOpenIssues: does not return a resolved issue", () => {
  const db = createDb();
  try {
    const id = "legacy-source:com.acme:ResolvedIssueArt";
    registerArt(db, id);
    appendEvent(db, {
      id,
      type: "issue-opened",
      agent: "review-agent",
      summary: "Stale cache risk",
      data: JSON.stringify({ issue_id: "ISS-99" }),
    });
    appendEvent(db, {
      id,
      type: "issue-resolved",
      agent: "codegen-agent",
      summary: "Fixed with eviction policy",
      data: JSON.stringify({ issue_id: "ISS-99" }),
    });

    const issues = queryOpenIssues(db);
    assert.equal(issues.length, 0);
  } finally {
    db.close();
  }
});

// ─── queryRunHistory ─────────────────────────────────────────────────────────

test("queryRunHistory: returns runs ordered by started_at DESC", () => {
  const db = createDb();
  try {
    db.prepare(
      `INSERT INTO runs (run_id, agent, model, status, started_at, exit_code)
       VALUES ('r1', 'migration-agent', 'gpt-4o', 'completed', datetime('now', '-10 minutes'), 0),
              ('r2', 'review-agent',    'gpt-4o', 'failed',    datetime('now', '-5 minutes'),  1)`,
    ).run();

    const runs = queryRunHistory(db);
    assert.equal(runs.length, 2);
    // Most recent first
    assert.equal(runs[0].run_id, "r2");
    assert.equal(runs[1].run_id, "r1");
  } finally {
    db.close();
  }
});

test("queryRunHistory: filters by agent", () => {
  const db = createDb();
  try {
    db.prepare(
      `INSERT INTO runs (run_id, agent, status)
       VALUES ('r1', 'migration-agent', 'completed'),
              ('r2', 'review-agent',    'completed')`,
    ).run();

    const runs = queryRunHistory(db, { agent: "review-agent" });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].agent, "review-agent");
  } finally {
    db.close();
  }
});

test("queryRunHistory: filters by status", () => {
  const db = createDb();
  try {
    db.prepare(
      `INSERT INTO runs (run_id, agent, status)
       VALUES ('r1', 'migration-agent', 'completed'),
              ('r2', 'migration-agent', 'failed')`,
    ).run();

    const runs = queryRunHistory(db, { status: "failed" });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].run_id, "r2");
  } finally {
    db.close();
  }
});

// ─── queryEvaluationSummary ───────────────────────────────────────────────────

test("queryEvaluationSummary: aggregates pass/fail counts by evaluator", () => {
  const db = createDb();
  try {
    const id = "legacy-source:com.acme:EvalArt";
    registerArt(db, id);

    db.prepare(
      `INSERT INTO evaluations (eval_id, artifact_id, evaluator, score, pass)
       VALUES ('e1', ?, 'no-legacy-imports',    1.0, 1),
              ('e2', ?, 'no-legacy-imports',    0.0, 0),
              ('e3', ?, 'signature-preservation', 0.9, 1)`,
    ).run(id, id, id);

    const summary = queryEvaluationSummary(db);

    const nli = summary.find((s) => s.evaluator === "no-legacy-imports");
    assert.ok(nli);
    assert.equal(nli.total,  2);
    assert.equal(nli.passed, 1);
    assert.equal(nli.failed, 1);

    const sp = summary.find((s) => s.evaluator === "signature-preservation");
    assert.ok(sp);
    assert.equal(sp.total,  1);
    assert.equal(sp.passed, 1);
    assert.equal(sp.failed, 0);
  } finally {
    db.close();
  }
});

test("queryEvaluationSummary: scopes to a single artifact when id is provided", () => {
  const db = createDb();
  try {
    const id1 = "legacy-source:com.acme:EvalA";
    const id2 = "legacy-source:com.acme:EvalB";
    registerArt(db, id1);
    registerArt(db, id2);

    db.prepare(
      `INSERT INTO evaluations (eval_id, artifact_id, evaluator, pass)
       VALUES ('e1', ?, 'no-legacy-imports', 1),
              ('e2', ?, 'no-legacy-imports', 0)`,
    ).run(id1, id2);

    const summary = queryEvaluationSummary(db, id1);
    assert.equal(summary.length, 1);
    assert.equal(summary[0].total,  1);
    assert.equal(summary[0].passed, 1);
  } finally {
    db.close();
  }
});

// ─── queryCostSummary ─────────────────────────────────────────────────────────

test("queryCostSummary: returns zeros when no traces exist", () => {
  const db = createDb();
  try {
    const cost = queryCostSummary(db);
    assert.equal(cost.total_tokens_in,  0);
    assert.equal(cost.total_tokens_out, 0);
    assert.equal(cost.total_cost_usd,   0);
    assert.equal(cost.total_calls,      0);
    assert.deepEqual(cost.by_model,     []);
  } finally {
    db.close();
  }
});

test("queryCostSummary: aggregates totals and groups by model", () => {
  const db = createDb();
  try {
    db.prepare(
      `INSERT INTO traces (trace_id, span_name, model, tokens_in, tokens_out, cost_usd)
       VALUES ('t1', 'migration', 'gpt-4o',  1000, 500,  0.02),
              ('t2', 'migration', 'gpt-4o',  2000, 800,  0.04),
              ('t3', 'review',    'gpt-4o-mini', 500, 200, 0.001)`,
    ).run();

    const cost = queryCostSummary(db);

    assert.equal(cost.total_calls,      3);
    assert.equal(cost.total_tokens_in,  3500);
    assert.equal(cost.total_tokens_out, 1500);
    assert.ok(Math.abs(cost.total_cost_usd - 0.061) < 0.001);

    const gpt4 = cost.by_model.find((m) => m.model === "gpt-4o");
    assert.ok(gpt4);
    assert.equal(gpt4.calls,      2);
    assert.equal(gpt4.tokens_in,  3000);
    assert.equal(gpt4.tokens_out, 1300);

    const mini = cost.by_model.find((m) => m.model === "gpt-4o-mini");
    assert.ok(mini);
    assert.equal(mini.calls, 1);
  } finally {
    db.close();
  }
});
