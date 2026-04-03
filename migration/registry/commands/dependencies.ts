import type Database from "better-sqlite3";
import { RegistryError, validateId } from "../types";
import type { Dependency, Relation } from "../types";

export function linkArtifacts(
  db: Database.Database,
  fromId: string,
  toId: string,
  relation: Relation,
): void {
  validateId(fromId);
  validateId(toId);

  if (!db.prepare("SELECT id FROM artifacts WHERE id = ?").get(fromId)) {
    throw new RegistryError(2, `Artifact not found: "${fromId}"`);
  }
  if (!db.prepare("SELECT id FROM artifacts WHERE id = ?").get(toId)) {
    throw new RegistryError(2, `Artifact not found: "${toId}"`);
  }

  const existing = db
    .prepare(
      "SELECT 1 FROM dependencies WHERE artifact_id = ? AND depends_on_id = ? AND relation = ?",
    )
    .get(fromId, toId, relation);
  if (existing) return; // idempotent

  db.prepare(
    "INSERT INTO dependencies (artifact_id, depends_on_id, relation) VALUES (?, ?, ?)",
  ).run(fromId, toId, relation);
}

export function listDependencies(
  db: Database.Database,
  id: string,
): Dependency[] {
  validateId(id);
  if (!db.prepare("SELECT id FROM artifacts WHERE id = ?").get(id)) {
    throw new RegistryError(2, `Artifact not found: "${id}"`);
  }
  return db
    .prepare("SELECT * FROM dependencies WHERE artifact_id = ?")
    .all(id) as Dependency[];
}

export function listDependents(
  db: Database.Database,
  id: string,
): Dependency[] {
  validateId(id);
  if (!db.prepare("SELECT id FROM artifacts WHERE id = ?").get(id)) {
    throw new RegistryError(2, `Artifact not found: "${id}"`);
  }
  return db
    .prepare("SELECT * FROM dependencies WHERE depends_on_id = ?")
    .all(id) as Dependency[];
}
