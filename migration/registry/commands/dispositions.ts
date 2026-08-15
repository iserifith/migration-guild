import { createHash } from "crypto";
import type Database from "better-sqlite3";
import type {
  DependencyDisposition,
  DependencyDispositionChangeKind,
  DependencyDispositionKind,
  DependencyDispositionStatus,
} from "../types";
import { RegistryError } from "../types";

/**
 * Planner-emitted dependency disposition records (specs/006-dependency-disposition).
 *
 * Shape follows approveDependencyStrategy (modernization.ts): RegistryError on
 * validation failure, db.transaction(...) wrapping the history-snapshot-then-
 * write. Per contracts/registry-schema.md's "Decision-evidence trail", the
 * history row written in the same transaction is the SOLE audit record — no
 * `events` row is emitted (events.artifact_id is NOT NULL and dispositions are
 * workspace-wide per-library; a declared-but-unused library has no artifact).
 */

const DISPOSITION_KINDS = new Set<DependencyDispositionKind>(["keep", "replace-with-native", "inline"]);

export interface UpsertProposedDispositionOptions {
  libraryName: string;
  currentVersion?: string | null;
  disposition: DependencyDispositionKind;
  nativeReplacement?: string | null;
  inlineNote?: string | null;
  lockedTargetVersion?: string | null;
  rationale: string;
  usageJson?: string | null;
  proposedBy: string;
}

export interface ListDispositionsOptions {
  status?: DependencyDispositionStatus;
  pendingOnly?: boolean;
}

function dispositionId(libraryName: string): string {
  return `dep-${createHash("sha1").update(libraryName).digest("hex").slice(0, 12)}`;
}

function historyId(dispositionRowId: string): string {
  const digest = createHash("sha1")
    .update(`${dispositionRowId}|${Date.now()}|${Math.random()}`)
    .digest("hex")
    .slice(0, 16);
  return `deph-${digest}`;
}

function validateProposal(opts: UpsertProposedDispositionOptions): void {
  if (!opts.libraryName.trim()) throw new RegistryError(1, "--library is required.");
  if (!DISPOSITION_KINDS.has(opts.disposition)) {
    throw new RegistryError(1, `Unknown disposition: "${opts.disposition}". Valid values: keep, replace-with-native, inline`);
  }
  if (!opts.rationale.trim()) throw new RegistryError(1, "--rationale is required.");
  if (!opts.proposedBy.trim()) throw new RegistryError(1, "--proposed-by is required.");
  if (opts.disposition === "replace-with-native" && !(opts.nativeReplacement ?? "").trim()) {
    throw new RegistryError(1, 'Disposition "replace-with-native" requires --native-replacement.');
  }
  if (opts.disposition === "inline" && !(opts.inlineNote ?? "").trim()) {
    throw new RegistryError(1, 'Disposition "inline" requires --inline-note.');
  }
}

function getRow(db: Database.Database, libraryName: string): DependencyDisposition | undefined {
  return db.prepare("SELECT * FROM dependency_dispositions WHERE library_name = ?").get(libraryName) as
    | DependencyDisposition
    | undefined;
}

function snapshotHistory(
  db: Database.Database,
  snapshot: DependencyDisposition | null,
  row: { disposition_id: string; library_name: string },
  changeKind: DependencyDispositionChangeKind,
  actor: string,
): void {
  db.prepare(`
    INSERT INTO dependency_disposition_history (
      history_id, disposition_id, library_name, snapshot_json, change_kind, change_actor, superseded_at
    )
    VALUES (@history_id, @disposition_id, @library_name, @snapshot_json, @change_kind, @change_actor, datetime('now'))
  `).run({
    history_id: historyId(row.disposition_id),
    disposition_id: row.disposition_id,
    library_name: row.library_name,
    // A null prior (INSERT) snapshots as null — the change_kind='propose'
    // row documents that no prior state existed.
    snapshot_json: JSON.stringify(snapshot),
    change_kind: changeKind,
    change_actor: actor,
  });
}

/**
 * Idempotent per research.md §8 — safe for the collector to re-run. Never
 * modifies confirmed primary columns: a changed proposal against an already-
 * confirmed row writes the pending_* group only (history 're-propose').
 */
export function upsertProposedDisposition(
  db: Database.Database,
  opts: UpsertProposedDispositionOptions,
): DependencyDisposition {
  validateProposal(opts);

  const id = dispositionId(opts.libraryName.trim());
  const existing = getRow(db, opts.libraryName.trim());

  const proposal = {
    current_version: opts.currentVersion?.trim() || null,
    disposition: opts.disposition,
    native_replacement: opts.nativeReplacement?.trim() || null,
    inline_note: opts.inlineNote?.trim() || null,
    locked_target_version: opts.lockedTargetVersion?.trim() || null,
    rationale: opts.rationale.trim(),
    usage_json: opts.usageJson ?? null,
  };

  const tx = db.transaction(() => {
    if (!existing) {
      db.prepare(`
        INSERT INTO dependency_dispositions (
          disposition_id, library_name, current_version, disposition, status,
          native_replacement, inline_note, locked_target_version, rationale,
          usage_json, proposed_by, created_at, updated_at
        )
        VALUES (
          @disposition_id, @library_name, @current_version, @disposition, 'proposed',
          @native_replacement, @inline_note, @locked_target_version, @rationale,
          @usage_json, @proposed_by, datetime('now'), datetime('now')
        )
      `).run({
        disposition_id: id,
        library_name: opts.libraryName.trim(),
        ...proposal,
        proposed_by: opts.proposedBy.trim(),
      });
      snapshotHistory(db, null, { disposition_id: id, library_name: opts.libraryName.trim() }, "propose", opts.proposedBy.trim());
      return;
    }

    if (existing.status === "proposed") {
      snapshotHistory(db, existing, existing, "refine", opts.proposedBy.trim());
      db.prepare(`
        UPDATE dependency_dispositions SET
          current_version = @current_version,
          disposition = @disposition,
          native_replacement = @native_replacement,
          inline_note = @inline_note,
          locked_target_version = @locked_target_version,
          rationale = @rationale,
          usage_json = @usage_json,
          proposed_by = @proposed_by,
          updated_at = datetime('now')
        WHERE disposition_id = @disposition_id
      `).run({
        ...proposal,
        proposed_by: opts.proposedBy.trim(),
        disposition_id: existing.disposition_id,
      });
      return;
    }

    // Confirmed row: a changed proposal writes ONLY the pending_* group
    // (FR-011); an identical proposal is a no-op (idempotent re-run).
    const identical =
      existing.disposition === proposal.disposition &&
      (existing.native_replacement ?? null) === proposal.native_replacement &&
      (existing.inline_note ?? null) === proposal.inline_note &&
      (existing.locked_target_version ?? null) === proposal.locked_target_version;
    if (identical) return;

    snapshotHistory(db, existing, existing, "re-propose", opts.proposedBy.trim());
    db.prepare(`
      UPDATE dependency_dispositions SET
        pending_disposition = @pending_disposition,
        pending_native_replacement = @pending_native_replacement,
        pending_inline_note = @pending_inline_note,
        pending_locked_target_version = @pending_locked_target_version,
        pending_rationale = @pending_rationale,
        pending_proposed_by = @pending_proposed_by,
        pending_at = datetime('now'),
        updated_at = datetime('now')
      WHERE disposition_id = @disposition_id
    `).run({
      pending_disposition: proposal.disposition,
      pending_native_replacement: proposal.native_replacement,
      pending_inline_note: proposal.inline_note,
      pending_locked_target_version: proposal.locked_target_version,
      pending_rationale: proposal.rationale,
      pending_proposed_by: opts.proposedBy.trim(),
      disposition_id: existing.disposition_id,
    });
  });
  tx();

  return getRow(db, opts.libraryName.trim())!;
}

export function listDispositions(
  db: Database.Database,
  opts: ListDispositionsOptions = {},
): DependencyDisposition[] {
  const conditions: string[] = [];
  const params: Record<string, string> = {};
  if (opts.status) {
    conditions.push("status = @status");
    params["status"] = opts.status;
  }
  if (opts.pendingOnly) {
    conditions.push("pending_disposition IS NOT NULL");
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return db.prepare(`
    SELECT * FROM dependency_dispositions
    ${where}
    ORDER BY library_name ASC
  `).all(params) as DependencyDisposition[];
}
