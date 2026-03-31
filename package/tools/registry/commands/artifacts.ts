import type Database from "better-sqlite3";
import { idToSlug, RegistryError, TAG_VOCABULARY, validateId } from "../types";
import type { Artifact, Kind, Role, Status } from "../types";

export interface RegisterArtifactOptions {
  id: string;
  kind: Kind;
  path: string;
  module?: string;
  role?: Role;
  framework?: string;
}

export function registerArtifact(
  db: Database.Database,
  opts: RegisterArtifactOptions,
): void {
  validateId(opts.id);
  const existing = db
    .prepare("SELECT id FROM artifacts WHERE id = ?")
    .get(opts.id);
  if (existing)
    throw new RegistryError(3, `Artifact already registered: "${opts.id}"`);

  const slug = idToSlug(opts.id);
  db.prepare(
    `
    INSERT INTO artifacts (id, slug, kind, path, module, role, framework, status, data_path)
    VALUES (@id, @slug, @kind, @path, @module, @role, @framework, 'pending', @data_path)
  `,
  ).run({
    id: opts.id,
    slug,
    kind: opts.kind,
    path: opts.path,
    module: opts.module ?? null,
    role: opts.role ?? null,
    framework: opts.framework ?? null,
    data_path: `migration/artifacts/${slug}/`,
  });
}

export function setArtifactStatus(
  db: Database.Database,
  id: string,
  status: Status,
): void {
  validateId(id);
  const result = db
    .prepare(
      `UPDATE artifacts SET status = @status, updated_at = datetime('now') WHERE id = @id`,
    )
    .run({ id, status });
  if (result.changes === 0)
    throw new RegistryError(2, `Artifact not found: "${id}"`);
}

export function releaseTask(
  db: Database.Database,
  id: string,
  agent: string,
  reason?: string,
): Artifact {
  validateId(id);

  const release = db.transaction((): Artifact => {
    const artifact = db
      .prepare("SELECT * FROM artifacts WHERE id = ?")
      .get(id) as Artifact | undefined;
    if (!artifact) throw new RegistryError(2, `Artifact not found: "${id}"`);
    if (artifact.status !== "in-progress") {
      throw new RegistryError(
        1,
        `Cannot release "${id}": status is "${artifact.status}", expected "in-progress".`,
      );
    }

    const returnTo = artifact.claimed_from ?? "planned";
    const summary = reason
      ? `Released by ${agent}: ${reason}`
      : `Released by ${agent}, returned to ${returnTo}`;

    db.prepare(`
      UPDATE artifacts
      SET status = ?,
          claimed_by = NULL,
          claimed_at = NULL,
          claimed_from = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(returnTo, id);

    db.prepare(`
      INSERT INTO events (event_id, artifact_id, type, agent, summary)
      VALUES (lower(hex(randomblob(8))), ?, 'status-changed', ?, ?)
    `).run(id, agent, summary);

    return db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as Artifact;
  });

  return release();
}

export function setArtifactWave(
  db: Database.Database,
  id: string,
  wave: number,
): void {
  validateId(id);
  const result = db
    .prepare(
      `UPDATE artifacts SET wave = @wave, updated_at = datetime('now') WHERE id = @id`,
    )
    .run({ id, wave });
  if (result.changes === 0)
    throw new RegistryError(2, `Artifact not found: "${id}"`);
}

export function addTag(db: Database.Database, id: string, tag: string): void {
  validateId(id);
  if (!(TAG_VOCABULARY as readonly string[]).includes(tag)) {
    throw new RegistryError(
      1,
      `Unknown tag: "${tag}". Valid tags: ${TAG_VOCABULARY.join(", ")}`,
    );
  }
  const artifact = db.prepare("SELECT id FROM artifacts WHERE id = ?").get(id);
  if (!artifact) throw new RegistryError(2, `Artifact not found: "${id}"`);

  const existing = db
    .prepare("SELECT 1 FROM artifact_tags WHERE artifact_id = ? AND tag = ?")
    .get(id, tag);
  if (existing) return; // idempotent

  db.prepare("INSERT INTO artifact_tags (artifact_id, tag) VALUES (?, ?)").run(
    id,
    tag,
  );
}

export function removeTag(
  db: Database.Database,
  id: string,
  tag: string,
): void {
  validateId(id);
  const artifact = db.prepare("SELECT id FROM artifacts WHERE id = ?").get(id);
  if (!artifact) throw new RegistryError(2, `Artifact not found: "${id}"`);
  db.prepare("DELETE FROM artifact_tags WHERE artifact_id = ? AND tag = ?").run(
    id,
    tag,
  );
}
