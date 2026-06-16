import type Database from "better-sqlite3";
import {
  approveArtifactWithEvidence,
  rejectArtifactWithEvidence,
} from "../../registry/commands/evidence";

export interface ArbitrateCliOptions {
  artifact: string;
  approve?: boolean;
  reject?: boolean;
  arbiter: string;
  reason: string;
  evidence?: string[];
  json?: boolean;
}

function normalizeEvidenceIds(value: string[] | undefined): string[] | undefined {
  if (!value || value.length === 0) return undefined;
  return value.flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);
}

export async function runArbitrate(db: Database.Database, opts: ArbitrateCliOptions): Promise<void> {
  if (opts.approve === opts.reject) {
    throw new Error("Choose exactly one of --approve or --reject");
  }
  const evidenceIds = normalizeEvidenceIds(opts.evidence);
  const decision = opts.approve
    ? approveArtifactWithEvidence(db, {
        artifactId: opts.artifact,
        arbiter: opts.arbiter,
        reason: opts.reason,
        evidenceIds,
      })
    : rejectArtifactWithEvidence(db, {
        artifactId: opts.artifact,
        arbiter: opts.arbiter,
        reason: opts.reason,
        evidenceIds,
      });

  if (opts.json) {
    process.stdout.write(JSON.stringify(decision, null, 2) + "\n");
    return;
  }
  const target = decision.decision === "approved" ? "reviewed" : "needs-rework";
  process.stdout.write(
    `✓ Artifact ${decision.decision}: ${opts.artifact}\n  decision=${decision.decision_id} target_status=${target}\n`,
  );
}
