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

export interface ConfirmDispositionOptions {
  libraryName: string;
  confirmedBy: string;
  // Override args (US2 scenario 2): any present ⇒ change_kind='override'.
  disposition?: DependencyDispositionKind;
  nativeReplacement?: string | null;
  inlineNote?: string | null;
  lockedTargetVersion?: string | null;
  rationale?: string;
  /**
   * GUILDCTL_AUTO_CONFIRM_DISPOSITIONS=1 path records change_kind='auto-confirm'
   * instead of 'confirm' (contract: 'auto-confirm' when invoked from the
   * auto-confirm path with confirmedBy='benchmark-runner').
   */
  autoConfirm?: boolean;
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

/**
 * Confirm (optionally overriding) a library's disposition (US2, FR-005/FR-008).
 *
 * Semantics per contracts/registry-schema.md:
 *  - Any override arg present ⇒ the override values REPLACE the proposal
 *    fields (primary columns) before confirming; history change_kind='override'.
 *  - No override args + pending_* group set ⇒ the pending group folds into the
 *    primary columns and is NULLed; change_kind='confirm'.
 *  - confirmed_by + confirmed_at are set in the SAME statement as the status
 *    flip — never a bare flip.
 *  - keep + confirm requires locked_target_version non-empty (FR-008).
 *  - History snapshot of the prior row state is written before every mutation,
 *    in the same transaction. No events rows (dispositions are workspace-wide;
 *    dependency_disposition_history is the sole evidence trail).
 */
export function confirmDisposition(
  db: Database.Database,
  opts: ConfirmDispositionOptions,
): DependencyDisposition {
  const libraryName = opts.libraryName.trim();
  if (!libraryName) throw new RegistryError(1, "--library is required.");
  if (!opts.confirmedBy.trim()) throw new RegistryError(1, "--confirmed-by is required.");

  const existing = getRow(db, libraryName);
  if (!existing) {
    throw new RegistryError(2, `No disposition proposal exists for library "${libraryName}".`);
  }

  const hasOverride =
    opts.disposition !== undefined ||
    opts.nativeReplacement != null ||
    opts.inlineNote != null ||
    opts.lockedTargetVersion != null ||
    opts.rationale !== undefined;

  // Resolve the final effective values.
  let effective: {
    disposition: DependencyDispositionKind;
    native_replacement: string | null;
    inline_note: string | null;
    locked_target_version: string | null;
    rationale: string;
    proposed_by: string;
  };
  if (hasOverride) {
    const disposition = opts.disposition ?? existing.disposition;
    const rationale = (opts.rationale ?? existing.rationale).trim();
    if (opts.disposition !== undefined && !DISPOSITION_KINDS.has(opts.disposition)) {
      throw new RegistryError(1, `Unknown disposition: "${opts.disposition}". Valid values: keep, replace-with-native, inline`);
    }
    if (!rationale) throw new RegistryError(1, "Override rationale must be non-empty.");
    effective = {
      disposition,
      // Nulling semantics: target fields not relevant to the (possibly new)
      // kind are cleared unless explicitly overridden — an override REPLACES
      // the proposal, it doesn't merge with a stale pairing. A field that is
      // explicitly passed (even as "") is honored as-is, including clearing
      // it to null — only an *omitted* (undefined) field falls back.
      native_replacement: opts.nativeReplacement !== undefined
        ? (opts.nativeReplacement?.trim() || null)
        : (opts.disposition === undefined || opts.disposition === "replace-with-native"
          ? existing.native_replacement
          : null),
      inline_note: opts.inlineNote !== undefined
        ? (opts.inlineNote?.trim() || null)
        : (opts.disposition === undefined || opts.disposition === "inline"
          ? existing.inline_note
          : null),
      locked_target_version: opts.lockedTargetVersion !== undefined
        ? (opts.lockedTargetVersion?.trim() || null)
        : (opts.disposition === undefined || opts.disposition === "keep"
          ? existing.locked_target_version
          : null),
      rationale,
      proposed_by: existing.proposed_by,
    };
  } else if (existing.pending_disposition != null) {
    effective = {
      disposition: existing.pending_disposition,
      native_replacement: existing.pending_native_replacement,
      inline_note: existing.pending_inline_note,
      locked_target_version: existing.pending_locked_target_version,
      rationale: existing.pending_rationale ?? existing.rationale,
      proposed_by: existing.pending_proposed_by ?? existing.proposed_by,
    };
  } else {
    effective = {
      disposition: existing.disposition,
      native_replacement: existing.native_replacement,
      inline_note: existing.inline_note,
      locked_target_version: existing.locked_target_version,
      rationale: existing.rationale,
      proposed_by: existing.proposed_by,
    };
  }

  // Validation on the final effective values (target pairing + FR-008).
  if (effective.disposition === "keep" && !(effective.locked_target_version ?? "").trim()) {
    throw new RegistryError(1, `Confirming disposition "keep" for "${libraryName}" requires a locked_target_version (FR-008).`);
  }
  if (effective.disposition === "replace-with-native" && !(effective.native_replacement ?? "").trim()) {
    throw new RegistryError(1, 'Disposition "replace-with-native" requires a native replacement target.');
  }
  if (effective.disposition === "inline" && !(effective.inline_note ?? "").trim()) {
    throw new RegistryError(1, 'Disposition "inline" requires an inline note.');
  }

  const changeKind: DependencyDispositionChangeKind = hasOverride
    ? "override"
    : opts.autoConfirm
      ? "auto-confirm"
      : "confirm";

  const tx = db.transaction(() => {
    snapshotHistory(db, existing, existing, changeKind, opts.confirmedBy.trim());
    db.prepare(`
      UPDATE dependency_dispositions SET
        disposition = @disposition,
        status = 'confirmed',
        native_replacement = @native_replacement,
        inline_note = @inline_note,
        locked_target_version = @locked_target_version,
        rationale = @rationale,
        proposed_by = @proposed_by,
        confirmed_by = @confirmed_by,
        confirmed_at = datetime('now'),
        pending_disposition = NULL,
        pending_native_replacement = NULL,
        pending_inline_note = NULL,
        pending_locked_target_version = NULL,
        pending_rationale = NULL,
        pending_proposed_by = NULL,
        pending_at = NULL,
        updated_at = datetime('now')
      WHERE disposition_id = @disposition_id
    `).run({
      ...effective,
      confirmed_by: opts.confirmedBy.trim(),
      disposition_id: existing.disposition_id,
    });
  });
  tx();

  return getRow(db, libraryName)!;
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

// ─── US3: locked dependency set + migration-agent context (FR-009/FR-010) ───

/**
 * data-model.md Entity 3 — a derived, deterministic projection over confirmed
 * rows (never a table, so it can never drift from the disposition rows).
 * Kind-paired target fields are null for kinds that do not use them.
 */
export interface LockedDependencySetEntry {
  library_name: string;
  disposition: DependencyDispositionKind;
  locked_target_version: string | null;
  native_replacement: string | null;
  inline_note: string | null;
  confirmed_by: string;
  confirmed_at: string;
}

/**
 * FR-009: the confirmed disposition set as a complete, deterministic locked
 * dependency set — confirmed rows only, ORDER BY library_name ASC. Rows with
 * pending_disposition non-NULL contribute their CURRENT (primary) confirmed
 * decision, which remains in effect per FR-011 until re-confirmed. Repeated
 * calls with no intervening writes are byte-for-byte identical (single
 * indexed scan, fixed column list, fixed key order in the row objects).
 */
export function getLockedDependencySet(db: Database.Database): LockedDependencySetEntry[] {
  return db.prepare(`
    SELECT
      library_name,
      disposition,
      locked_target_version,
      native_replacement,
      inline_note,
      confirmed_by,
      confirmed_at
    FROM dependency_dispositions
    WHERE status = 'confirmed'
    ORDER BY library_name ASC
  `).all() as LockedDependencySetEntry[];
}

function usingArtifactsOf(row: DependencyDisposition): string[] {
  if (!row.usage_json) return [];
  try {
    const parsed = JSON.parse(row.usage_json) as { using_artifacts?: unknown };
    if (!Array.isArray(parsed.using_artifacts)) return [];
    return parsed.using_artifacts.filter((a): a is string => typeof a === "string");
  } catch {
    // Malformed usage_json (hand-seeded row, truncated collector write): the
    // dependency_findings fallback below still applies — never throw here.
    return [];
  }
}

/**
 * FR-010: prompt-ready guidance for the code-writer pool, listing confirmed
 * non-keep dispositions on libraries used by the artifact. A library is "used
 * by the artifact" when the artifact id appears in usage_json.using_artifacts
 * OR (fallback) a dependency_findings row pairs the artifact with the
 * library's dependency_name. NULL when the artifact only uses keep libraries
 * (or no dispositions match) — callers append nothing.
 */
export function dispositionContextForArtifact(
  db: Database.Database,
  artifactId: string,
): string | null {
  const confirmed = db.prepare(`
    SELECT * FROM dependency_dispositions
    WHERE status = 'confirmed' AND disposition != 'keep'
    ORDER BY library_name ASC
  `).all() as DependencyDisposition[];
  if (confirmed.length === 0) return null;

  const findingsForArtifact = new Set(
    (db.prepare(
      "SELECT DISTINCT dependency_name FROM dependency_findings WHERE artifact_id = ?",
    ).all(artifactId) as Array<{ dependency_name: string }>).map((r) => r.dependency_name),
  );

  const matched = confirmed.filter((row) =>
    usingArtifactsOf(row).includes(artifactId) || findingsForArtifact.has(row.library_name),
  );
  if (matched.length === 0) return null;

  const lines = matched.map((row) => {
    if (row.disposition === "replace-with-native") {
      return `  - ${row.library_name} → replace-with-native: do not re-declare ${row.library_name}; use ${row.native_replacement} instead.`;
    }
    return `  - ${row.library_name} → inline: do not re-declare ${row.library_name}; inline the used surface instead (${row.inline_note}).`;
  });
  return [
    "Dependency dispositions for libraries used by this artifact — do not re-declare pruned dependencies:",
    ...lines,
  ].join("\n");
}
