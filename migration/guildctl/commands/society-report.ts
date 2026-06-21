import type Database from "better-sqlite3";

const DIALOGUE_TYPES = [
  "proposal-submitted",
  "evidence-submitted",
  "critique-issued",
  "arbitration-approved",
  "arbitration-rejected",
  "conflict-opened",
  "conflict-resolved",
  "benchmark-recorded",
] as const;

export interface SocietyReport {
  roles: Record<string, number>;
  task_division: {
    by_status: Record<string, number>;
    by_wave: Record<string, number>;
    by_tier: Record<string, number>;
    active_claims: number;
  };
  dialogue: Record<string, number>;
  conflict_resolution: {
    claim_releases: number;
    claim_expirations: number;
    reaped_runs: number;
    arbitration_approved: number;
    arbitration_rejected: number;
  };
  evidence: {
    total: number;
    passed: number;
    failed: number;
    pass_rate: number;
    artifacts_awaiting_evidence: number;
    artifacts_awaiting_arbitration: number;
  };
  efficiency: {
    elapsed_runtime_ms: number | null;
    failed_runs: number;
    reworked_artifacts: number;
  };
}

function rowsToMap(rows: Array<{ key: string | number | null; n: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[String(row.key ?? "unassigned")] = row.n;
  return out;
}
function count(db: Database.Database, sql: string, params: unknown[] = []): number {
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}
function querySocietyReport(db: Database.Database): SocietyReport {
  const roles = rowsToMap(db.prepare("SELECT agent AS key, COUNT(*) AS n FROM runs GROUP BY agent ORDER BY agent").all() as Array<{ key: string; n: number }>);
  const byStatus = rowsToMap(db.prepare("SELECT status AS key, COUNT(*) AS n FROM artifacts GROUP BY status ORDER BY status").all() as Array<{ key: string; n: number }>);
  const byWave = rowsToMap(db.prepare("SELECT wave AS key, COUNT(*) AS n FROM artifacts GROUP BY wave ORDER BY wave").all() as Array<{ key: number | null; n: number }>);
  const byTier = rowsToMap(db.prepare("SELECT tier AS key, COUNT(*) AS n FROM artifacts GROUP BY tier ORDER BY tier").all() as Array<{ key: string; n: number }>);
  const dialogue: Record<string, number> = {};
  for (const type of DIALOGUE_TYPES) dialogue[type] = count(db, "SELECT COUNT(*) AS n FROM events WHERE type = ?", [type]);
  const evidenceTotal = count(db, "SELECT COUNT(*) AS n FROM acceptance_evidence");
  const evidencePassed = count(db, "SELECT COUNT(*) AS n FROM acceptance_evidence WHERE pass = 1");
  const evidenceFailed = count(db, "SELECT COUNT(*) AS n FROM acceptance_evidence WHERE pass = 0");
  const awaitingEvidence = count(db, `SELECT COUNT(*) AS n FROM artifacts a WHERE a.status = 'migrated' AND NOT EXISTS (SELECT 1 FROM acceptance_evidence e WHERE e.artifact_id = a.id)`);
  const awaitingArbitration = count(db, `SELECT COUNT(*) AS n FROM artifacts a WHERE a.status = 'migrated' AND EXISTS (SELECT 1 FROM acceptance_evidence e WHERE e.artifact_id = a.id AND e.pass = 1 AND e.evidence_type IN ('test-command','build-command','static-check')) AND NOT EXISTS (SELECT 1 FROM arbitration_decisions d WHERE d.artifact_id = a.id AND d.decision = 'approved')`);
  const runtime = db.prepare("SELECT MIN(started_at) AS first, MAX(COALESCE(finished_at, started_at)) AS last FROM runs").get() as { first: string | null; last: string | null };
  let elapsed: number | null = null;
  if (runtime.first && runtime.last) elapsed = Math.max(0, new Date(runtime.last).getTime() - new Date(runtime.first).getTime());
  return {
    roles,
    task_division: { by_status: byStatus, by_wave: byWave, by_tier: byTier, active_claims: count(db, "SELECT COUNT(*) AS n FROM artifact_claims WHERE state = 'active'") },
    dialogue,
    conflict_resolution: {
      claim_releases: count(db, "SELECT COUNT(*) AS n FROM events WHERE type = 'claim-released'"),
      claim_expirations: count(db, "SELECT COUNT(*) AS n FROM events WHERE type = 'claim-expired'"),
      reaped_runs: count(db, "SELECT COUNT(*) AS n FROM events WHERE type = 'run-reaped'"),
      arbitration_approved: count(db, "SELECT COUNT(*) AS n FROM arbitration_decisions WHERE decision = 'approved'"),
      arbitration_rejected: count(db, "SELECT COUNT(*) AS n FROM arbitration_decisions WHERE decision = 'rejected'"),
    },
    evidence: { total: evidenceTotal, passed: evidencePassed, failed: evidenceFailed, pass_rate: evidenceTotal === 0 ? 0 : evidencePassed / evidenceTotal, artifacts_awaiting_evidence: awaitingEvidence, artifacts_awaiting_arbitration: awaitingArbitration },
    efficiency: { elapsed_runtime_ms: elapsed, failed_runs: count(db, "SELECT COUNT(*) AS n FROM runs WHERE status = 'failed' OR exit_code IS NOT NULL AND exit_code != 0"), reworked_artifacts: count(db, "SELECT COUNT(*) AS n FROM artifacts WHERE status = 'needs-rework'") },
  };
}

export function runSocietyReport(db: Database.Database, opts: { json?: boolean } = {}): void {
  const report = querySocietyReport(db);
  if (opts.json) { process.stdout.write(JSON.stringify(report, null, 2) + "\n"); return; }
  process.stdout.write("Agent Society Report\n");
  process.stdout.write("\nRoles observed\n");
  for (const [role,n] of Object.entries(report.roles)) process.stdout.write(`- ${role}: ${n}\n`);
  if (Object.keys(report.roles).length === 0) process.stdout.write("- none yet\n");
  process.stdout.write("\nTask division\n");
  process.stdout.write(`- by status: ${JSON.stringify(report.task_division.by_status)}\n- by wave: ${JSON.stringify(report.task_division.by_wave)}\n- by tier: ${JSON.stringify(report.task_division.by_tier)}\n- active claims: ${report.task_division.active_claims}\n`);
  process.stdout.write("\nDialogue\n");
  for (const type of DIALOGUE_TYPES) process.stdout.write(`- ${type}: ${report.dialogue[type]}\n`);
  process.stdout.write("\nConflict resolution\n");
  process.stdout.write(`- claim releases: ${report.conflict_resolution.claim_releases}\n- claim expirations: ${report.conflict_resolution.claim_expirations}\n- reaped runs: ${report.conflict_resolution.reaped_runs}\n- arbitration approved: ${report.conflict_resolution.arbitration_approved}\n- arbitration rejected: ${report.conflict_resolution.arbitration_rejected}\n`);
  process.stdout.write("\nEvidence\n");
  process.stdout.write(`- total: ${report.evidence.total}\n- passed: ${report.evidence.passed}\n- failed: ${report.evidence.failed}\n- pass rate: ${(report.evidence.pass_rate*100).toFixed(1)}%\n- awaiting evidence: ${report.evidence.artifacts_awaiting_evidence}\n- awaiting arbitration: ${report.evidence.artifacts_awaiting_arbitration}\n`);
  process.stdout.write("\nEfficiency hooks\n");
  process.stdout.write(`- elapsed runtime ms: ${report.efficiency.elapsed_runtime_ms ?? "n/a"}\n- failed runs: ${report.efficiency.failed_runs}\n- reworked artifacts: ${report.efficiency.reworked_artifacts}\n`);
}
