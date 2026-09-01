import type Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { resolveWorkspaceRoot } from "../../guildctl/config";
import { idToSlug, RegistryError, validateId } from "../types";
import type { Agent, ContextResponse } from "../types";

function extractSummary(content: string): string {
  const match = content.match(
    /^##\s+Summary\s*\r?\n([\s\S]*?)(?=\r?\n##\s|\s*$)/m,
  );
  if (!match) {
    throw new RegistryError(
      1,
      'Context file must contain a "## Summary" section',
    );
  }
  return match[1].trim();
}

// ─── Rejection envelope (#216) ────────────────────────────────────────────
//
// A reserved agent_context key that carries a human rejection's reason
// forward to the next remediation attempt. The write side lives here
// (called from recordApprovalDecision, migration/registry/commands/approval.ts)
// and the read side is a thin wrapper over getContext below. Both sides share
// this one constant so the reserved key can never drift between them.

export const REJECTION_ENVELOPE_AGENT: Agent = "rejection-envelope";

/**
 * Write a human rejection's reason into the reserved rejection-envelope slot
 * for one artifact (data-model.md, contracts/registry-commands.md). Synthesizes
 * a minimal `## Summary` file at the canonical context path and upserts the
 * corresponding agent_context row — the same upsert shape writeContext uses,
 * scoped to (artifactId, REJECTION_ENVELOPE_AGENT) so it can never collide
 * with any other agent's row for the same artifact (FR-002/FR-003). A second
 * call for the same artifact upserts (overwrites) this same row, which is what
 * makes "most recent rejection reason wins" automatic (FR-004).
 *
 * Not part of the module's public CLI-facing surface (no new CLI subcommand);
 * used only by recordApprovalDecision, which wraps this call in a fail-open
 * try/catch (FR-008) — this function itself may throw on filesystem/db errors.
 */
export function writeRejectionEnvelope(
  db: Database.Database,
  artifactId: string,
  reason: string,
): void {
  const slug = idToSlug(artifactId);
  const destDir = path.join("migration", "artifacts", slug, "context");
  fs.mkdirSync(destDir, { recursive: true });

  const destFile = path.join(destDir, `${REJECTION_ENVELOPE_AGENT}.md`);
  const content = `## Summary\n\n${reason}\n`;
  fs.writeFileSync(destFile, content, "utf-8");

  db.prepare(
    `
    INSERT INTO agent_context (artifact_id, agent, file_path, summary, updated_at)
    VALUES (@artifact_id, @agent, @file_path, @summary, datetime('now'))
    ON CONFLICT (artifact_id, agent) DO UPDATE SET
      file_path  = excluded.file_path,
      summary    = excluded.summary,
      updated_at = excluded.updated_at
  `,
  ).run({
    artifact_id: artifactId,
    agent: REJECTION_ENVELOPE_AGENT,
    file_path: destFile,
    summary: extractSummary(content),
  });
}

/**
 * Read back the most recent rejection reason recorded for an artifact, or
 * null when none was ever recorded (FR-005/FR-007). Pure read, no side
 * effects, safe for any artifact including one never rejected.
 */
export function getRejectionEnvelope(
  db: Database.Database,
  artifactId: string,
): { reason: string } | null {
  const response = getContext(db, artifactId, REJECTION_ENVELOPE_AGENT);
  if (response.form === "none") {
    return null;
  }
  const reason =
    response.form === "file"
      ? extractSummary(response.content ?? "")
      : (response.content ?? "");
  return { reason };
}

export function writeContext(
  db: Database.Database,
  id: string,
  agent: Agent,
  filePath: string,
): void {
  validateId(id);

  if (!db.prepare("SELECT id FROM artifacts WHERE id = ?").get(id)) {
    throw new RegistryError(2, `Artifact not found: "${id}"`);
  }
  if (!fs.existsSync(filePath)) {
    throw new RegistryError(2, `Context file not found: "${filePath}"`);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const summary = extractSummary(content);
  const slug = idToSlug(id);
  const destDir = path.join("migration", "artifacts", slug, "context");
  fs.mkdirSync(destDir, { recursive: true });

  const destFile = path.join(destDir, `${agent}.md`);
  fs.copyFileSync(filePath, destFile);

  db.prepare(
    `
    INSERT INTO agent_context (artifact_id, agent, file_path, summary, updated_at)
    VALUES (@artifact_id, @agent, @file_path, @summary, datetime('now'))
    ON CONFLICT (artifact_id, agent) DO UPDATE SET
      file_path  = excluded.file_path,
      summary    = excluded.summary,
      updated_at = excluded.updated_at
  `,
  ).run({ artifact_id: id, agent, file_path: destFile, summary });
}

// ─── Portable, always-usable context retrieval (FR-040–FR-044, research R12) ─
//
// A deterministic five-step resolver, no filesystem search at any step:
// 1. normalize the stored file_path's separators for this host;
// 2. if relative, resolve against the workspace root;
// 3. if that misses, try the canonical layout
//    migration/artifacts/<slug>/context/<agent>.md, rebuilt via idToSlug;
// 4. if no file resolves, fall back to the stored summary;
// 5. if the summary is absent or whitespace-only, return form: "none" with a
//    documented fallback. The agent_context table itself is unchanged.

const NO_CONTEXT_FALLBACK =
  "No analysis context was recorded for this artifact and agent. Read the legacy source directly.";
const NO_LOCATABLE_FALLBACK =
  "Neither the recorded context file nor a stored summary could be located. Read the legacy source directly; no analysis context was recorded.";

function normalizeStoredPath(raw: string): string {
  // Accept both `\` and `/` in the stored value; emit the host's separator.
  return raw.split(/[\\/]+/).filter(Boolean).join(path.sep);
}

function resolveAgainstWorkspace(raw: string, workspaceRoot: string): string {
  const normalized = normalizeStoredPath(raw);
  return path.isAbsolute(normalized) ? normalized : path.resolve(workspaceRoot, normalized);
}

function readNonEmpty(filePath: string): string | undefined {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return undefined;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

export interface GetContextOptions {
  workspaceRoot?: string;
}

export function getContext(
  db: Database.Database,
  id: string,
  agent: Agent,
  opts: GetContextOptions = {},
): ContextResponse {
  validateId(id);
  if (!db.prepare("SELECT id FROM artifacts WHERE id = ?").get(id)) {
    throw new RegistryError(2, `Artifact not found: "${id}"`);
  }
  const workspaceRoot = opts.workspaceRoot ?? resolveWorkspaceRoot();
  const row = db
    .prepare("SELECT file_path, summary FROM agent_context WHERE artifact_id = ? AND agent = ?")
    .get(id, agent) as { file_path: string; summary: string | null } | undefined;

  if (!row) {
    return { form: "none", reason: "no-context-record", fallback: NO_CONTEXT_FALLBACK };
  }

  // Step 1-2: the stored path, normalized and resolved against the workspace.
  const storedResolved = resolveAgainstWorkspace(row.file_path, workspaceRoot);
  const storedContent = readNonEmpty(storedResolved);
  if (storedContent !== undefined) {
    return { form: "file", path: storedResolved, content: storedContent };
  }

  // Step 3: the canonical layout, rebuilt from the artifact id — this is what
  // makes a record written on another host resolve here when the tree is
  // present, without any search.
  const canonical = path.join(workspaceRoot, "migration", "artifacts", idToSlug(id), "context", `${agent}.md`);
  const canonicalContent = readNonEmpty(canonical);
  if (canonicalContent !== undefined) {
    return { form: "file", path: canonical, content: canonicalContent };
  }

  // Step 4-5: fall back to the stored summary; whitespace-only counts as absent.
  const summary = row.summary?.trim();
  if (summary) {
    return { form: "summary", content: summary };
  }
  return { form: "none", reason: "no-locatable-file-or-summary", fallback: NO_LOCATABLE_FALLBACK };
}

export function getContextPath(
  db: Database.Database,
  id: string,
  agent: Agent,
  opts: GetContextOptions = {},
): string {
  const response = getContext(db, id, agent, opts);
  if (response.form === "file" && response.path) {
    return response.path;
  }
  throw new RegistryError(
    2,
    `No locatable context file for artifact "${id}", agent "${agent}"; use get-context instead — it also returns the stored summary when no file resolves`,
  );
}
