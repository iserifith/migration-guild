import type Database from "better-sqlite3";
import { FIRST_CLASS_KINDS, idToSlug, RegistryError, TAG_VOCABULARY, validateId } from "../types";
import type { Artifact, ArtifactTier, Kind, Role, Status } from "../types";

export interface RegisterArtifactOptions {
  id: string;
  kind: Kind;
  path: string;
  module?: string;
  role?: Role;
  framework?: string;
  tier?: ArtifactTier;
}

export interface UpdateArtifactOptions {
  id: string;
  module?: string;
  role?: Role;
  framework?: string;
  tier?: ArtifactTier;
}

export interface SetArtifactStatusOptions {
  agent?: string;
  model?: string;
  reason?: string;
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
  const tier: ArtifactTier =
    opts.tier ?? (FIRST_CLASS_KINDS.includes(opts.kind) ? "first-class" : "second-class");

  db.prepare(
    `
    INSERT INTO artifacts (id, slug, kind, tier, path, module, role, framework, status, data_path)
    VALUES (@id, @slug, @kind, @tier, @path, @module, @role, @framework, 'pending', @data_path)
  `,
  ).run({
    id: opts.id,
    slug,
    kind: opts.kind,
    tier,
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
  opts: SetArtifactStatusOptions = {},
): void {
  validateId(id);
  const tx = db.transaction(() => {
    const artifact = db
      .prepare("SELECT status FROM artifacts WHERE id = ?")
      .get(id) as { status: Status } | undefined;
    if (!artifact) {
      throw new RegistryError(2, `Artifact not found: "${id}"`);
    }

    db.prepare(
      `UPDATE artifacts SET status = @status, updated_at = datetime('now') WHERE id = @id`,
    ).run({ id, status });

    const shouldRecordEvent = opts.agent || opts.reason || opts.model;
    if (!shouldRecordEvent) return;

    const summary = opts.reason
      ? `Status changed ${artifact.status} -> ${status}: ${opts.reason}`
      : `Status changed ${artifact.status} -> ${status}`;
    const eventData = JSON.stringify({
      previous_status: artifact.status,
      new_status: status,
      reason: opts.reason ?? null,
    });

    db.prepare(`
      INSERT INTO events (event_id, artifact_id, type, agent, model, summary, event_data)
      VALUES (lower(hex(randomblob(8))), @artifact_id, 'status-changed', @agent, @model, @summary, @event_data)
    `).run({
      artifact_id: id,
      agent: opts.agent ?? "operator",
      model: opts.model ?? null,
      summary,
      event_data: eventData,
    });
  });

  tx();
}

export function updateArtifact(
  db: Database.Database,
  opts: UpdateArtifactOptions,
): Artifact {
  validateId(opts.id);

  const updates: string[] = [];
  const params: Record<string, string> = { id: opts.id };

  if (opts.module !== undefined) {
    updates.push("module = @module");
    params["module"] = opts.module;
  }
  if (opts.role !== undefined) {
    updates.push("role = @role");
    params["role"] = opts.role;
  }
  if (opts.framework !== undefined) {
    updates.push("framework = @framework");
    params["framework"] = opts.framework;
  }
  if (opts.tier !== undefined) {
    updates.push("tier = @tier");
    params["tier"] = opts.tier;
  }

  if (updates.length === 0) {
    throw new RegistryError(
      1,
      'No artifact fields provided. Use at least one of "--module", "--role", "--framework", or "--tier".',
    );
  }

  updates.push("updated_at = datetime('now')");

  const result = db
    .prepare(`UPDATE artifacts SET ${updates.join(", ")} WHERE id = @id`)
    .run(params);
  if (result.changes === 0) {
    throw new RegistryError(2, `Artifact not found: "${opts.id}"`);
  }

  return db.prepare("SELECT * FROM artifacts WHERE id = ?").get(opts.id) as Artifact;
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
