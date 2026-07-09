import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";

export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
  status: CheckStatus;
  message: string;
}

// TASK-08: pipeline-state checks for `doctor`. These read the registry +
// filesystem only (no LLM calls) and use COUNT queries so they stay fast on
// 3,000-artifact registries. Phase-aware: each check only fires when its phase
// has plausibly run. Checks that depend on tables/columns introduced by later
// packets (TASK-05 claims, TASK-04 modern outputs) degrade gracefully.

interface PipelineCheckContext {
  db: Database.Database;
  workspaceRoot: string;
  danglingClaimThresholdMs?: number;
}

function count(db: Database.Database, sql: string, params: unknown[] = []): number {
  return (db.prepare(sql).get(...params) as { c: number } | undefined)?.c ?? 0;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name) as
    | { name: string }
    | undefined;
  return !!row;
}

function operatorStateJson(db: Database.Database, key: string): Record<string, unknown> | undefined {
  if (!tableExists(db, "operator_state")) return undefined;
  try {
    const rec = db.prepare("SELECT value FROM operator_state WHERE key = ?").get(key) as { value: string } | undefined;
    if (!rec) return undefined;
    const parsed = JSON.parse(rec.value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function runPipelineStateChecks(ctx: PipelineCheckContext): CheckResult[] {
  const { db, workspaceRoot } = ctx;
  const checks: CheckResult[] = [];

  // ── 8. SQLite integrity (run first — everything else assumes a healthy db) ──
  try {
    const res = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
    if (res && res.integrity_check === "ok") {
      checks.push({ status: "pass", message: "SQLite integrity_check: ok" });
    } else {
      checks.push({ status: "fail", message: `SQLite integrity_check: ${res?.integrity_check ?? "unknown"}` });
    }
  } catch (err) {
    checks.push({ status: "fail", message: `SQLite integrity_check error: ${(err as Error).message}` });
  }

  // If there is no artifacts table at all, the registry is uninitialized.
  if (!tableExists(db, "artifacts")) {
    checks.push({ status: "warn", message: "registry not initialized (no artifacts table yet)" });
    return checks;
  }

  const totalArtifacts = count(db, "SELECT COUNT(*) c FROM artifacts");

  // ── 6. Empty-pipeline sanity: registry empty but legacy/ has files ──────────
  const legacyDir = path.join(workspaceRoot, "legacy");
  let legacyFileCount = 0;
  if (fs.existsSync(legacyDir)) {
    const walk = (dir: string): number => {
      let n = 0;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) n += walk(full);
        else n += 1;
      }
      return n;
    };
    legacyFileCount = walk(legacyDir);
  }
  if (totalArtifacts === 0 && legacyFileCount > 0) {
    checks.push({
      status: "fail",
      message: `registry has 0 artifacts but legacy/ contains ${legacyFileCount} source file(s) — inventory never registered them`,
    });
  }

  // Nothing else is meaningful before inventory has run at all.
  if (totalArtifacts === 0) {
    if (legacyFileCount === 0) checks.push({ status: "pass", message: "no artifacts registered yet (fresh workspace)" });
    return checks;
  }

  // ── 7. Unclassified concentration ───────────────────────────────────────────
  const classified = count(db, "SELECT COUNT(*) c FROM artifact_classifications");
  const unclassified = totalArtifacts - classified;
  if (classified > 0 && unclassified / totalArtifacts > 0.5) {
    checks.push({
      status: "warn",
      message: `${unclassified}/${totalArtifacts} artifacts (${Math.round((unclassified / totalArtifacts) * 100)}%) still unclassified`,
    });
  } else if (unclassified > 0) {
    checks.push({
      status: "pass",
      message: `${unclassified}/${totalArtifacts} artifacts unclassified (below 50% concentration threshold)`,
    });
  }
  const fallbackClassified = count(
    db,
    "SELECT COUNT(*) c FROM artifact_classifications WHERE framework IN ('plain-java', 'plain-python')",
  );
  if (fallbackClassified > 0 && fallbackClassified / totalArtifacts > 0.5) {
    checks.push({
      status: "warn",
      message: `${fallbackClassified}/${totalArtifacts} artifacts (${Math.round((fallbackClassified / totalArtifacts) * 100)}%) fallback-classified as plain-*`,
    });
  }

  // ── 1. Post-plan wave integrity ─────────────────────────────────────────────
  const plannerVerification = operatorStateJson(db, "plan_verification_planner");
  const plannerClaimedComplete = plannerVerification?.["invariantPassed"] === true;
  const withWave = count(db, "SELECT COUNT(*) c FROM artifacts WHERE wave IS NOT NULL");
  const nullWave = totalArtifacts - withWave;
  if (withWave > 0 || plannerClaimedComplete) {
    if (nullWave > 0) {
      checks.push({
        status: "fail",
        message: `plan left ${nullWave}/${totalArtifacts} artifacts with wave = NULL (plan invariant was not satisfied)`,
      });
    } else {
      checks.push({ status: "pass", message: `all ${totalArtifacts} artifacts assigned to a wave` });
    }
  } else if (withWave === 0) {
    checks.push({ status: "warn", message: "plan has not completed — 0 artifacts have a wave assigned" });
  }

  // ── 2. Stack mappings ───────────────────────────────────────────────────────
  const mappings = count(db, "SELECT COUNT(*) c FROM stack_mappings");
  if (mappings === 0) {
    // Escalate to fail if TASK-01 recorded a completed planner phase.
    const plannerOk = plannerClaimedComplete;
    checks.push({
      status: plannerOk ? "fail" : "warn",
      message: plannerOk
        ? "planner phase verified complete but stack_mappings is empty"
        : "no stack_mappings recorded yet (plan not run or mappings pending)",
    });
  } else {
    checks.push({ status: "pass", message: `${mappings} framework mapping(s) recorded` });
  }

  // ── 3. Evidence format ──────────────────────────────────────────────────────
  let malformed: string[] = [];
  try {
    const rows = db
      .prepare("SELECT artifact_id, evidence_json FROM artifact_classifications WHERE evidence_json IS NOT NULL")
      .all() as Array<{ artifact_id: string; evidence_json: string }>;
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.evidence_json);
        if (!Array.isArray(parsed)) malformed.push(r.artifact_id);
      } catch {
        malformed.push(r.artifact_id);
      }
      if (malformed.length >= 5) break;
    }
  } catch {
    /* table may be empty / absent */
  }
  if (malformed.length > 0) {
    checks.push({
      status: "fail",
      message: `malformed evidence_json in ${malformed.length}+ classification(s): ${malformed.slice(0, 5).join(", ")}`,
    });
  } else {
    checks.push({ status: "pass", message: "evidence_json well-formed across sampled classifications" });
  }

  // ── 4. Dangling claims ──────────────────────────────────────────────────────
  if (tableExists(db, "artifact_claims")) {
    const thresholdMs = ctx.danglingClaimThresholdMs ?? 60 * 60 * 1000;
    const now = Date.now();
    try {
      const rows = db
        .prepare("SELECT claim_id, owner_id, heartbeat_at, claimed_at FROM artifact_claims WHERE state = 'active'")
        .all() as Array<{ claim_id: string; owner_id: string | null; heartbeat_at: string | null; claimed_at: string | null }>;
      const stale = rows.filter((r) => {
        const raw = r.heartbeat_at ?? r.claimed_at;
        if (!raw) return false;
        const t = Date.parse(raw);
        return Number.isFinite(t) && now - t > thresholdMs;
      });
      if (stale.length > 0) {
        const listed = stale
          .slice(0, 5)
          .map((r) => {
            const raw = r.heartbeat_at ?? r.claimed_at!;
            return `${r.claim_id}${r.owner_id ? ` (${r.owner_id})` : ""} +${Math.round((now - Date.parse(raw)) / 60000)}m`;
          })
          .join(", ");
        checks.push({ status: "warn", message: `${stale.length} dangling active claim(s) older than 1h: ${listed}` });
      } else {
        checks.push({ status: "pass", message: `${rows.length} active claim(s), none stale` });
      }
    } catch {
      checks.push({ status: "warn", message: "artifact_claims table present but claim freshness could not be checked" });
    }
  } else {
    checks.push({ status: "pass", message: "artifact_claims table not present — skipped" });
  }

  // ── 5. Registry/filesystem agreement (TASK-04 records expected outputs) ─────
  // Until TASK-04/05 land, the best we can do is: any artifact marked `migrated`
  // while `modern/` is empty/missing is suspect. TODO(TASK-04): compare against
  // recorded expected output paths instead of assuming a populated modern/ dir.
  const modernDir = path.join(workspaceRoot, "modern");
  const migrated = count(db, "SELECT COUNT(*) c FROM artifacts WHERE status = 'migrated'");
  if (migrated > 0) {
    const modernPopulated = fs.existsSync(modernDir) && fs.readdirSync(modernDir).length > 0;
    if (!modernPopulated) {
      checks.push({
        status: "fail",
        message: `${migrated} artifact(s) marked migrated but modern/ is empty or missing (output not produced)`,
      });
    } else {
      checks.push({ status: "pass", message: `${migrated} artifact(s) marked migrated; modern/ present` });
    }
  } else {
    checks.push({ status: "pass", message: "no migrated artifacts to verify yet" });
  }

  return checks;
}
