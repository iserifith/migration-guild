import type Database from "better-sqlite3";
import { addAcceptanceEvidence, listAcceptanceEvidence } from "../../registry/commands/evidence";
import { appendEvent } from "../../registry/commands/events";
import type { EvidenceType } from "../../registry/types";

const VALID_EVIDENCE_TYPES = new Set<EvidenceType>([
  "test-command",
  "build-command",
  "static-check",
  "review-verdict",
  "benchmark-result",
]);

export interface EvidenceAddCliOptions {
  artifact: string;
  type: string;
  producedBy: string;
  command?: string;
  exitCode?: string | number;
  pass?: boolean;
  fail?: boolean;
  summary: string;
  runId?: string;
  outputPath?: string;
  outputExcerpt?: string;
  json?: boolean;
}

export interface EvidenceListCliOptions {
  artifact: string;
  json?: boolean;
}

function parseEvidenceType(value: string): EvidenceType {
  if (!VALID_EVIDENCE_TYPES.has(value as EvidenceType)) {
    throw new Error(`Invalid evidence type: ${value}`);
  }
  return value as EvidenceType;
}

function parseExitCode(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid exit code: ${String(value)}`);
  }
  return parsed;
}

function inferPass(opts: EvidenceAddCliOptions, exitCode: number | null): 0 | 1 {
  if (opts.pass && opts.fail) {
    throw new Error("Use only one of --pass or --fail");
  }
  if (opts.pass) return 1;
  if (opts.fail) return 0;
  if (exitCode !== null) return exitCode === 0 ? 1 : 0;
  return 1;
}

export async function runEvidenceAdd(db: Database.Database, opts: EvidenceAddCliOptions): Promise<void> {
  const exitCode = parseExitCode(opts.exitCode);
  const evidence = addAcceptanceEvidence(db, {
    artifactId: opts.artifact,
    evidenceType: parseEvidenceType(opts.type),
    producedBy: opts.producedBy,
    command: opts.command ?? null,
    exitCode,
    pass: inferPass(opts, exitCode),
    summary: opts.summary,
    runId: opts.runId ?? null,
    outputPath: opts.outputPath ?? null,
    outputExcerpt: opts.outputExcerpt ?? null,
  });

  appendEvent(db, {
    id: opts.artifact,
    type: "evidence-submitted",
    agent: opts.producedBy,
    summary: `Evidence submitted: ${evidence.evidence_type} ${evidence.pass ? "PASS" : "FAIL"}`,
    data: JSON.stringify({
      role: "critic",
      evidence_id: evidence.evidence_id,
      evidence_type: evidence.evidence_type,
      command: evidence.command,
      exit_code: evidence.exit_code,
      pass: evidence.pass,
    }),
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");
    return;
  }
  process.stdout.write(
    `✓ Evidence recorded: ${evidence.evidence_id} ${evidence.evidence_type} ${evidence.pass ? "PASS" : "FAIL"}\n`,
  );
}

export function runEvidenceList(db: Database.Database, opts: EvidenceListCliOptions): void {
  const rows = listAcceptanceEvidence(db, opts.artifact);
  if (opts.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return;
  }
  if (rows.length === 0) {
    process.stdout.write(`No evidence recorded for ${opts.artifact}\n`);
    return;
  }
  for (const row of rows) {
    const command = row.command ? ` command=${row.command}` : "";
    const exitCode = row.exit_code === null ? "" : ` exit=${row.exit_code}`;
    process.stdout.write(
      `${row.evidence_id} ${row.evidence_type} ${row.pass ? "PASS" : "FAIL"} by ${row.produced_by}${exitCode}${command}\n  ${row.summary}\n`,
    );
  }
}
